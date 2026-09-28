/**
 * 桌面操作实现（Windows）：截屏、点鼠标、敲键盘、列窗口，全部通过一次
 * PowerShell 子进程 + user32 P/Invoke + System.Drawing 完成，零 npm 依赖。
 *
 * 坐标系说明（重要）：一律用**虚拟屏幕物理像素**。每次截屏前进程内先
 * `SetProcessDPIAware()`，于是截屏像素与屏幕像素一比一对齐；截图被缩放过时，
 * 调用方传进来的仍是图上的像素，本模块自己按缩放系数换算回去。
 *
 * 两个自研坑（dsh 把桌面操作外包给 Rust driver，所以它没有这两个坑）：
 * - `Graphics.CopyFromScreen` 在 DPI 缩放下会拍到缩放过的图，所以必须先声明 DPI 感知；
 * - 文本输入走剪贴板粘贴，绕开 SendKeys 对中文和 `{}` 之类的限制，代价是覆盖剪贴板，
 *   因此这里会先把原来的**文本**剪贴板存回去（图片/文件类剪贴板内容保不住）。
 *
 * @module dsc/core/desktop-control
 */
import { spawn } from 'node:child_process'

/** 桌面动作。 */
export const DESKTOP_ACTIONS = [
  'screenshot',
  'click',
  'type',
  'key',
  'scroll',
  'cursor',
  'window_list',
] as const

export type DesktopAction = (typeof DESKTOP_ACTIONS)[number]

/** 桌面参数（x/y 为截图像素坐标；缩放由本模块换算）。 */
export interface DesktopArgs {
  x?: number
  y?: number
  button?: string
  double?: boolean
  text?: string
  key?: string
  amount?: number
}

/** 一次动作的结果：文本，或文本 + 图像（data URL）。 */
export interface DesktopResult {
  text: string
  images?: string[]
  /** 这次截屏相对屏幕的缩放系数（1 = 一比一）；点坐标要按它换算。 */
  scale?: number
}

const DPI_A =
  "using System.Runtime.InteropServices; public class DscDpi { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }"

const MOUSE_TYPE = `using System; using System.Runtime.InteropServices; public class DscMouse {
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p); public struct POINT { public int X; public int Y; } }`

/** 前台窗口归属查询（应用白名单用它判断「你现在要点的那个窗口允不允许」）。 */
const FOREGROUND_TYPE = `using System; using System.Diagnostics; using System.Runtime.InteropServices; public class DscFg {
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
public static string Describe() { IntPtr h = GetForegroundWindow(); uint pid = 0; GetWindowThreadProcessId(h, out pid); string proc = "?"; try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { } var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return proc + "|" + sb.ToString(); } }`

/** 鼠标键 → 按下/抬起事件位。 */
const BUTTON_EVENT: Record<string, readonly [number, number]> = {
  left: [2, 4],
  right: [8, 16],
  middle: [32, 64],
}

/** SendKeys 键名白名单（不认识的键名一律拒绝，避免把任意文本当语法喂进去）。 */
const KEY_MAP: Record<string, string> = {
  enter: '{ENTER}',
  tab: '{TAB}',
  esc: '{ESC}',
  escape: '{ESC}',
  space: ' ',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  insert: '{INSERT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  f1: '{F1}',
  f2: '{F2}',
  f3: '{F3}',
  f4: '{F4}',
  f5: '{F5}',
  f6: '{F6}',
  f7: '{F7}',
  f8: '{F8}',
  f9: '{F9}',
  f10: '{F10}',
  f11: '{F11}',
  f12: '{F12}',
}

/**
 * 明确禁止的按键组合。SendKeys 本来就发不出 Win 键，这里再挡一层
 * 那些「一发出去就把人锁在门外」的组合。
 */
const BANNED_KEYS = ['win', 'cmd', 'super', 'meta']

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** PowerShell 单引号字符串转义。 */
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * 跑一段 PowerShell 并取 stdout。
 * @param signal - 外部取消时立刻杀掉子进程（用户中断这一轮，不该留一个正在点鼠标的进程）。
 */
export function runPowerShell(script: string, timeoutMs = 20000, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`桌面操作超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    const abort = (): void => {
      child.kill()
      reject(new Error('桌面操作被取消'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    const clean = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.on('close', (code) => {
      clean()
      if (code === 0) resolve(out)
      else reject(new Error(err.trim() !== '' ? err.trim() : `powershell 退出码 ${String(code)}`))
    })
    child.on('error', (error) => {
      clean()
      reject(error)
    })
  })
}

/** 把 `ctrl+shift+s` 这类键名翻成 SendKeys 语法。 */
export function toSendKeys(key: string): string {
  const parts = String(key)
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  let modifiers = ''
  const singles: string[] = []
  for (const part of parts) {
    if (part === 'ctrl') modifiers += '^'
    else if (part === 'alt') modifiers += '%'
    else if (part === 'shift') modifiers += '+'
    else if (BANNED_KEYS.includes(part)) {
      throw new Error(`不允许按 Win 键（${part}）：这类按键会把桌面切走，请用 click 点你要的地方`)
    } else if (KEY_MAP[part] !== undefined) singles.push(KEY_MAP[part])
    else if (part.length === 1) singles.push(part)
    else throw new Error(`不认识的按键「${part}」。认得的：${Object.keys(KEY_MAP).join(' / ')}，或单字符`)
  }
  if (singles.length === 0) throw new Error(`按键 ${key} 里没有可执行的键`)
  return modifiers + singles.join('')
}

/** 截屏脚本：DPI 感知 → 抓虚拟屏 → 需要时缩放 → 按质量存 JPEG 或 PNG → base64。 */
function screenshotScript(maxEdge: number, format: 'jpeg' | 'png', quality: number): string {
  const encode =
    format === 'jpeg'
      ? `$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${quality})
$bmp.Save($ms, $codec, $ep)`
      : '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)'
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition '${DPI_A}'
[DscDpi]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$src = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $src.Size)
$max = ${maxEdge}
$w = $src.Width; $h = $src.Height
if ($w -gt $max -or $h -gt $max) {
  if ($w -ge $h) { $nh = [int]([double]$max * $h / $w); $nw = $max } else { $nw = [int]([double]$max * $w / $h); $nh = $max }
  $bmp = New-Object System.Drawing.Bitmap $nw, $nh
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($src, 0, 0, $w, $h)
} else { $bmp = $src; $nw = $w; $nh = $h }
$ms = New-Object System.IO.MemoryStream
${encode}
"$nw,$nh|" + [Convert]::ToBase64String($ms.ToArray())
`
}

/** 屏幕边界 + 前台窗口，一次进程问清楚（越界判断与白名单判断都要用）。 */
async function probeScreen(signal?: AbortSignal): Promise<{ left: number; top: number; width: number; height: number; foreground: string }> {
  const out = await runPowerShell(
    `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition '${DPI_A}'
Add-Type -TypeDefinition '${FOREGROUND_TYPE}'
[DscDpi]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
"$($b.Left),$($b.Top),$($b.Width),$($b.Height)|" + [DscFg]::Describe()
`,
    12000,
    signal,
  )
  // 前台窗口那一段自己可能带竖线（进程|标题），所以只按第一个竖线切
  const parts = out.trim().split('|')
  const geom = parts.shift() ?? ''
  const foreground = parts.join('|')
  const [left, top, width, height] = geom.split(',').map((part) => Number.parseInt(part, 10))
  if ([left, top, width, height].some((value) => !Number.isFinite(value))) {
    throw new Error(`读屏幕边界失败，收到「${out.trim()}」`)
  }
  return { left: left!, top: top!, width: width!, height: height!, foreground }
}

/** 应用白名单：前台窗口的进程名或标题命中白名单才放行。 */
function assertAllowedApp(foreground: string, allowed: readonly string[]): void {
  if (allowed.length === 0) return
  const [processName = '', ...titleParts] = foreground.split('|')
  const title = titleParts.join('|')
  const hit = allowed.some((entry) => {
    const needle = entry.trim().toLowerCase()
    if (needle === '') return false
    return processName.toLowerCase().includes(needle) || title.toLowerCase().includes(needle)
  })
  if (!hit) {
    throw new Error(
      `当前前台窗口是「${title || processName}」，不在你设的应用白名单（${allowed.join('、')}）里，这一步被拦下了`,
    )
  }
}

/**
 * 把截图像素坐标换算成屏幕物理坐标。
 * @throws 小数坐标，或换算后落在屏幕外（这里不靠 SetCursorPos 静默夹紧，越界就是要告诉模型）。
 */
export function resolveScreenPoint(
  args: DesktopArgs,
  bounds: { left: number; top: number; width: number; height: number },
  scale: number,
): { x: number; y: number } {
  const rawX = args.x
  const rawY = args.y
  if (rawX === undefined || rawY === undefined) throw new Error('这个动作要带 x 与 y（截图上的像素坐标）')
  if (!Number.isInteger(rawX) || !Number.isInteger(rawY)) {
    throw new Error(`x 与 y 必须是整数，收到 (${String(rawX)}, ${String(rawY)})`)
  }
  const x = Math.round(rawX / scale)
  const y = Math.round(rawY / scale)
  if (x < bounds.left || x >= bounds.left + bounds.width || y < bounds.top || y >= bounds.top + bounds.height) {
    throw new Error(
      `坐标 (${x}, ${y}) 在屏幕外（有效范围 ${bounds.left},${bounds.top} 到 ${bounds.left + bounds.width - 1},${bounds.top + bounds.height - 1}）。先 screenshot 看清界面再点`,
    )
  }
  return { x, y }
}

function assertInt(value: unknown, label: string): number {
  const num = Number(value)
  if (!Number.isInteger(num)) throw new Error(`${label} 必须是整数，收到 ${String(value)}`)
  return num
}

/**
 * 执行一个桌面动作。
 * @param scale - 上一次截屏的缩放系数（点/滚动的坐标按它换算回物理像素）。
 * @param allowedApps - 应用白名单（进程名或窗口标题的子串）；空数组 = 不限。
 */
export async function runDesktopAction(
  action: DesktopAction,
  args: DesktopArgs,
  options: { scale: number; allowedApps: readonly string[]; actionDelayMs: number },
  signal?: AbortSignal,
): Promise<DesktopResult> {
  const pause = options.actionDelayMs > 0 ? `Start-Sleep -Milliseconds ${Math.min(options.actionDelayMs, 2000)}` : ''
  switch (action) {
    case 'screenshot': {
      throw new Error('内部错误：screenshot 要走 takeScreenshot()')
    }
    case 'click': {
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      const point = resolveScreenPoint(args, bounds, options.scale)
      const events = BUTTON_EVENT[String(args.button ?? 'left')] ?? BUTTON_EVENT.left
      const clicks = args.double === true ? 2 : 1
      const clickLines = Array.from(
        { length: clicks },
        () =>
          `[DscMouse]::mouse_event(${events[0]},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [DscMouse]::mouse_event(${events[1]},0,0,0,[UIntPtr]::Zero)`,
      ).join(`; ${pause}; `)
      await runPowerShell(
        `
Add-Type -TypeDefinition '${MOUSE_TYPE}'
[DscMouse]::SetCursorPos(${point.x}, ${point.y}) | Out-Null
${pause}
${clickLines}
'Done'
`,
        15000,
        signal,
      )
      return {
        text: `已在屏幕 (${point.x}, ${point.y}) ${args.double === true ? '双击' : '单击'}${String(args.button ?? 'left')}。再截一张确认点中了什么。`,
      }
    }
    case 'type': {
      const text = String(args.text ?? '')
      if (text === '') throw new Error('type 要带 text')
      if (text.length > 4000) throw new Error(`一次最多输 4000 字，这次有 ${text.length} 字，拆开输`)
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      await runPowerShell(
        `
Add-Type -AssemblyName System.Windows.Forms
$old = $null
try { $old = Get-Clipboard -TextFormatType Text } catch { }
Set-Clipboard -Value ${psQuote(text)}
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 80
if ($null -ne $old) { Set-Clipboard -Value $old }
'Done'
`,
        15000,
        signal,
      )
      return { text: `已输入 ${text.length} 个字符（走剪贴板粘贴；原来的文本剪贴板已还原）。` }
    }
    case 'key': {
      const keys = toSendKeys(String(args.key ?? ''))
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      await runPowerShell(
        `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${psQuote(keys)})
'Done'
`,
        15000,
        signal,
      )
      return { text: `已按键 ${String(args.key)}。` }
    }
    case 'scroll': {
      const amount = assertInt(args.amount ?? 3, 'amount')
      if (Math.abs(amount) > 30) throw new Error('一次最多滚 30 档')
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      const move =
        args.x !== undefined && args.y !== undefined
          ? `
[DscMouse]::SetCursorPos(${resolveScreenPoint(args, bounds, options.scale).x}, ${resolveScreenPoint(args, bounds, options.scale).y}) | Out-Null`
          : ''
      const step = amount > 0 ? '4294967176' : '120'
      await runPowerShell(
        `
Add-Type -TypeDefinition '${MOUSE_TYPE}'
${move}
for ($i = 0; $i -lt ${Math.abs(amount)}; $i++) { [DscMouse]::mouse_event(0x0800, 0, 0, ${step}, [UIntPtr]::Zero); ${pause} }
'Done'
`,
        15000,
        signal,
      )
      return { text: `已滚动 ${amount} 档（正数向上，负数向下）。` }
    }
    case 'cursor': {
      const out = await runPowerShell(
        `
Add-Type -TypeDefinition '${MOUSE_TYPE}'
$p = New-Object DscMouse+POINT
[DscMouse]::GetCursorPos([ref]$p) | Out-Null
"$($p.X),$($p.Y)"
`,
        12000,
        signal,
      )
      const [x = '?', y = '?'] = out.trim().split(',')
      return { text: `鼠标当前位置：屏幕 (${x}, ${y})。` }
    }
    case 'window_list': {
      const out = await runPowerShell(
        `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Sort-Object MainWindowTitle -Unique | ForEach-Object { $_.Id.ToString() + '|' + $_.MainWindowTitle }`,
        15000,
        signal,
      )
      const lines = out.trim() === '' ? '（没找到带标题的窗口）' : out.trim()
      return { text: `带标题的窗口（进程|标题）：\n${lines}` }
    }
    default:
      throw new Error(`不认识的 action「${action satisfies never}」。要用的值：${DESKTOP_ACTIONS.join(' / ')}`)
  }
}

/**
 * 抓一张全屏图。
 * @returns 图像 data URL + 缩放系数（点坐标要按它换算）。
 */
export async function takeScreenshot(
  options: { maxEdge: number; format: 'jpeg' | 'png'; quality: number },
  signal?: AbortSignal,
): Promise<DesktopResult> {
  const out = await runPowerShell(
    screenshotScript(
      Math.min(Math.max(Math.round(options.maxEdge), 640), 3840),
      options.format === 'png' ? 'png' : 'jpeg',
      Math.min(Math.max(Math.round(options.quality), 30), 100),
    ),
    30000,
    signal,
  ).catch((error: unknown) => {
    throw new Error(`截屏失败：${errText(error)}`)
  })
  const trimmed = out.trim()
  const at = trimmed.indexOf('|')
  if (at < 0) throw new Error(`截屏返回看不懂的格式：${trimmed.slice(0, 60)}`)
  const [sizePart = '', base64 = ''] = [trimmed.slice(0, at), trimmed.slice(at + 1)]
  const [imageWidth, imageHeight] = sizePart.split(',').map((part) => Number.parseInt(part, 10))
  if (base64 === '') throw new Error('截屏是空的')
  const bounds = await probeScreen(signal)
  const scale = bounds.width / (imageWidth || bounds.width)
  const mime = options.format === 'png' ? 'image/png' : 'image/jpeg'
  return {
    text:
      `这是整个桌面的截图，尺寸 ${String(imageWidth)}×${String(imageHeight)}；` +
      `屏幕物理分辨率 ${String(bounds.width)}×${String(bounds.height)}，起点 (${String(bounds.left)}, ${String(bounds.top)})。` +
      `要点的坐标直接用这张图上的像素值，dsc 会换算（当前换算系数 ${scale.toFixed(2)}）。` +
      `鼠标现在指的位置可用 cursor 查。`,
    images: [`data:${mime};base64,${base64}`],
    scale,
  }
}

/** 前台窗口是谁（白名单提示与自查用）。 */
export async function foregroundWindow(signal?: AbortSignal): Promise<string> {
  const bounds = await probeScreen(signal)
  return bounds.foreground
}
