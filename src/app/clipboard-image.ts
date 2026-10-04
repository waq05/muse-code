/**
 * 剪贴板图片读取（Windows）：Ctrl+V 贴图的后半段。
 *
 * 终端把「粘贴」限定成文本——Windows Terminal 的粘贴动作对纯图片剪贴板不发任何
 * 字节，所以贴图必须在按键层自己接（\x16 = Ctrl+V）再用 PowerShell 读剪贴板，
 * 与 codex（arboard）/ Claude Code（同路线）同构。优先级：
 *   1. FileDrop（资源管理器复制的文件）→ 首个是图片扩展名就返回那个路径；
 *   2. 位图 → 存成 PNG 临时文件（提交时 attach.ts 再读成 data URL）；
 *   3. 文本 → 原样返回（调用方拼回输入框，兜住「终端没转发粘贴」的场合）。
 *
 * @module dsc-tui/app/clipboard-image
 */
import { execFile } from 'node:child_process'

export type ClipboardResult =
  | { kind: 'image'; path: string }
  | { kind: 'text'; text: string }
  | { kind: 'none' }

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$sep = [char]9
$drop = [Windows.Forms.Clipboard]::GetDataObject().GetData('FileDrop')
if ($drop -ne $null -and $drop.Length -gt 0) {
  Write-Output ("FILE" + $sep + $drop[0])
  exit
}
$img = [Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) {
  $path = Join-Path $env:TEMP ("muse-paste-" + [Guid]::NewGuid().ToString('N').Substring(0,8) + ".png")
  $img.Save($path, [Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("IMAGE" + $sep + $path)
  exit
}
$text = [Windows.Forms.Clipboard]::GetText()
if ($text -ne $null -and $text -ne '') {
  Write-Output ("TEXT" + $sep + $text)
  exit
}
Write-Output "NONE"
`

/** 读一次剪贴板；任何失败都折叠成 none（贴图是锦上添花，不值得让界面报错）。 */
export async function readClipboardImage(): Promise<ClipboardResult> {
  return await new Promise<ClipboardResult>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
      { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          resolve({ kind: 'none' })
          return
        }
        const line = String(stdout).split(/\r?\n/).find((part) => part !== '') ?? ''
        const tab = line.indexOf('\t')
        const tag = tab >= 0 ? line.slice(0, tab) : line
        const payload = tab >= 0 ? line.slice(tab + 1) : ''
        if (tag === 'IMAGE') {
          resolve({ kind: 'image', path: payload })
        } else if (tag === 'FILE') {
          const dot = payload.lastIndexOf('.')
          const ext = dot >= 0 ? payload.slice(dot).toLowerCase() : ''
          resolve(
            IMAGE_EXTENSIONS.has(ext) ? { kind: 'image', path: payload } : { kind: 'text', text: payload },
          )
        } else if (tag === 'TEXT') {
          resolve({ kind: 'text', text: payload })
        } else {
          resolve({ kind: 'none' })
        }
      },
    )
  })
}
