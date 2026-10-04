/**
 * 终端半块真彩图片渲染（0.6.57）：图片 → 终端字符画的预览后端。
 *
 * dsh-TUI 走 sixel/kitty 协议探测（fork ink 带图形管线）；这两个协议 Windows
 * Terminal 尚未稳定放开，这里退到所有现代终端都支持的兜底：`▀` 上半块字符 +
 * 24bit 前景/背景双色（`38;2`/`48;2` SGR），一格画两个像素，配 1:2 字符格宽高比
 * 近似方形。缩放与解码交给 PowerShell 的 System.Drawing（PNG/JPEG/GIF/BMP 全认，
 * 免去在 Node 里引原生图像依赖）：脚本缩放到目标格数后吐 BGRA 原始字节。
 *
 * @module dsc-tui/app/image-blocks
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ImageSource {
  /** 本地文件路径（附件芯片走这条）。 */
  path?: string
  /** data URL（会话条目里的历史图片走这条，先落临时文件再解码）。 */
  dataUrl?: string
}

/** 预览脚本的临时落点（每个进程一份，懒创建）。 */
let scriptDir: string | null = null

const PS_SCRIPT = `param([string]$Path, [int]$MaxCols, [int]$MaxRows)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null
$src = New-Object System.Drawing.Bitmap($Path)
$scale = [Math]::Min($MaxCols / [double]$src.Width, ($MaxRows * 2) / [double]$src.Height)
if ($scale -gt 1.0) { $scale = 1.0 }
$w = [Math]::Max(1, [int][Math]::Round($src.Width * $scale))
$h = [Math]::Max(2, [int][Math]::Round($src.Height * $scale))
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, $w, $h)
$g.Dispose()
$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$bits = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($w * $h * 4)
[System.Runtime.InteropServices.Marshal]::Copy($bits.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($bits)
$bmp.Dispose()
$src.Dispose()
[Console]::Out.Write("OK " + $w + " " + $h + [char]10)
[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
`

const ensureScript = (): string => {
  if (scriptDir === null) scriptDir = mkdtempSync(join(tmpdir(), 'muse-preview-'))
  const file = join(scriptDir, 'render.ps1')
  writeFileSync(file, PS_SCRIPT, 'utf8')
  return file
}

/** data URL 的 base64 部分落成临时文件（System.Drawing 只认文件；脚本目录已就绪）。 */
const materialize = (source: ImageSource): string | null => {
  if (source.path !== undefined) return source.path
  if (source.dataUrl === undefined || scriptDir === null) return null
  const comma = source.dataUrl.indexOf(',')
  if (comma < 0) return null
  const file = join(scriptDir, `${randomUUID().slice(0, 8)}.img`)
  writeFileSync(file, Buffer.from(source.dataUrl.slice(comma + 1), 'base64'))
  return file
}

/** 混黑：半透明像素叠到深底上（终端没有 alpha）。 */
const blend = (value: number, alpha: number): number => Math.round((value * alpha) / 255)

/**
 * 渲染一张图为半块字符画（行不含尾随换行）。失败抛错，由调用方折成提示文案。
 * @param maxCols 最大列数（不含边距，调用方按终端宽度自行预留）
 * @param maxRows 最大格数
 */
export async function renderImageBlock(
  source: ImageSource,
  maxCols: number,
  maxRows: number,
): Promise<string> {
  if (scriptDir === null) scriptDir = mkdtempSync(join(tmpdir(), 'muse-preview-'))
  const image = materialize(source)
  if (image === null) throw new Error('没有可渲染的图片数据')
  const script = ensureScript()
  return await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-Path', image, '-MaxCols', String(Math.max(1, maxCols)), '-MaxRows', String(Math.max(1, maxRows))],
      { timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout) => {
        if (error !== null) {
          reject(error instanceof Error ? error : new Error(String(error)))
          return
        }
        const buffer = stdout as Buffer
        const headerEnd = buffer.indexOf(0x0a)
        const header = headerEnd >= 0 ? buffer.subarray(0, headerEnd).toString('utf8') : ''
        const match = /^OK (\d+) (\d+)$/.exec(header.trim())
        if (!match) {
          reject(new Error('预览脚本没有返回有效数据'))
          return
        }
        const width = Number(match[1])
        const height = Number(match[2])
        const pixels = buffer.subarray(headerEnd + 1)
        if (pixels.length < width * height * 4) {
          reject(new Error('预览数据不完整'))
          return
        }
        const lines: string[] = []
        for (let y = 0; y < height; y += 2) {
          let line = ''
          for (let x = 0; x < width; x += 1) {
            const top = (y * width + x) * 4
            // BGRA：低字节起 B,G,R,A
            const tr = blend(pixels[top + 2] ?? 0, pixels[top + 3] ?? 255)
            const tg = blend(pixels[top + 1] ?? 0, pixels[top + 3] ?? 255)
            const tb = blend(pixels[top] ?? 0, pixels[top + 3] ?? 255)
            const bottomY = y + 1
            let br = 0
            let bg = 0
            let bb = 0
            if (bottomY < height) {
              const bottom = (bottomY * width + x) * 4
              br = blend(pixels[bottom + 2] ?? 0, pixels[bottom + 3] ?? 255)
              bg = blend(pixels[bottom + 1] ?? 0, pixels[bottom + 3] ?? 255)
              bb = blend(pixels[bottom] ?? 0, pixels[bottom + 3] ?? 255)
            }
            line += `\x1b[38;2;${tr};${tg};${tb};48;2;${br};${bg};${bb}m▀`
          }
          line += '\x1b[0m'
          lines.push(line)
        }
        resolve(lines.join('\n'))
      },
    )
  })
}
