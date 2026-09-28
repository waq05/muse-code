/**
 * dsc 外部插件：Computer Use——让模型「看到并操作」这台 Windows 桌面。
 *
 * 能力（单工具 computer，action 分发；对齐 Claude/zcode 的 computer-use 形态）：
 *   screenshot   全屏截图（返回图像，模型据此定位坐标；需要支持视觉的模型）
 *   click        移动鼠标并单击/双击/右键（坐标 = 截图像素坐标）
 *   type         输入文本（经剪贴板粘贴；会覆盖当前剪贴板内容）
 *   key          按键/组合键（enter / tab / ctrl+s / alt+f4 ...）
 *   scroll       滚轮滚动（amount 正=上滚，负=下滚）
 *   cursor       查询当前鼠标位置
 *   window_list  列出可见顶层窗口
 *
 * 实现：零 npm 依赖——PowerShell(-NoProfile) + user32 P/Invoke + System.Drawing。
 * 坐标系 = 虚拟屏幕物理像素（进程内 SetProcessDPIAware，与截图 1:1）。
 *
 * 安装：复制到 ~/.dsc/plugins/，宿主热挂载。apiVersion 1。
 */
export const name = 'Computer Use'
export const description = '桌面操控：截图/点击/输入/滚动/按键/窗口列表（Windows）'
export const apiVersion = 1
export const inject = ['tools']

import { spawn } from 'node:child_process'

/** 执行一段 PowerShell，返回 stdout（失败抛错）。 */
function runPs(script, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('PowerShell 执行超时'))
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(err.trim() || `powershell exit ${code}`))
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

const SCREENSHOT_PS = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiA { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[DpiA]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())
`

const MOUSE_TYPE = `using System; using System.Runtime.InteropServices; public class DscMouse {
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p); public struct POINT { public int X; public int Y; } }`

const BUTTON_EVENT = { left: [2, 4], right: [8, 16], middle: [32, 64] }

/** SendKeys 键名 → 语法（白名单；不接受任意文本）。 */
const KEY_MAP = {
  enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', space: ' ',
  backspace: '{BACKSPACE}', delete: '{DELETE}', insert: '{INSERT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
  f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
}

/** 解析 'ctrl+shift+s' 形式的键名 → SendKeys 语法。 */
function toSendKeys(key) {
  const parts = String(key).toLowerCase().split('+').map((part) => part.trim())
  let modifiers = ''
  const singles = []
  for (const part of parts) {
    if (part === 'ctrl') modifiers += '^'
    else if (part === 'alt') modifiers += '%'
    else if (part === 'shift') modifiers += '+'
    else if (part === 'win') throw new Error('SendKeys 不支持 Win 键；请用 click 开始菜单')
    else if (KEY_MAP[part] !== undefined) singles.push(KEY_MAP[part])
    else if (part.length === 1) singles.push(part)
    else throw new Error(`未知按键：${part}`)
  }
  if (singles.length === 0) throw new Error(`按键为空：${key}`)
  return modifiers + singles.join('')
}

function assertInt(value, label) {
  const n = Number(value)
  if (!Number.isInteger(n)) throw new Error(`${label} 必须是整数，收到 ${String(value)}`)
  return n
}

const ACTIONS = ['screenshot', 'click', 'type', 'key', 'scroll', 'cursor', 'window_list']

export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'computer',
    description:
      '操控这台 Windows 电脑：截屏查看（screenshot，返回图像，需视觉模型）、点击（click，坐标为截图像素坐标）、' +
      '输入文本（type，经剪贴板粘贴）、按键（key，如 enter / ctrl+s）、滚动（scroll）、查询鼠标（cursor）、' +
      '列出窗口（window_list）。操作前先 screenshot 确认界面状态。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '要执行的动作' },
        x: { type: 'integer', description: 'click/scroll：横坐标（截图像素坐标）' },
        y: { type: 'integer', description: 'click/scroll：纵坐标' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click：鼠标键，默认 left' },
        double: { type: 'boolean', description: 'click：是否双击' },
        text: { type: 'string', description: 'type：要输入的文本（经剪贴板粘贴）' },
        key: { type: 'string', description: 'key：键名，如 enter / tab / ctrl+c / alt+f4' },
        amount: { type: 'integer', description: 'scroll：滚动档数，正=上滚 负=下滚' },
      },
      required: ['action'],
    },
    risk: 'exec',
    async run(args) {
      const action = String(args.action ?? '')
      switch (action) {
        case 'screenshot': {
          const base64 = (await runPs(SCREENSHOT_PS, 25000)).trim()
          if (base64 === '') throw new Error('截图为空')
          return { text: '当前屏幕截图如下（坐标即本图像素坐标）：', images: [`data:image/png;base64,${base64}`] }
        }
        case 'click': {
          const x = assertInt(args.x, 'x')
          const y = assertInt(args.y, 'y')
          const [down, up] = BUTTON_EVENT[String(args.button ?? 'left')] ?? BUTTON_EVENT.left
          const click = args.double === true ? 2 : 1
          const clickLines = Array.from({ length: click }, () =>
            '[DscMouse]::mouse_event(' + down + ',0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; ' +
            '[DscMouse]::mouse_event(' + up + ',0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60'
          ).join('\n')
          const script = `
Add-Type -TypeDefinition '${MOUSE_TYPE}'
[DscMouse]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 60
${clickLines}
'Done'
`
          await runPs(script, 10000)
          return `已在 (${x}, ${y}) ${args.double === true ? '双击' : '单击'}${args.button && args.button !== 'left' ? `（${args.button}）` : ''}。建议 screenshot 确认效果。`
        }
        case 'type': {
          const text = String(args.text ?? '')
          if (text === '') throw new Error('text 不能为空')
          // 剪贴板方案：绕开 SendKeys 的特殊字符/中文限制（会覆盖当前剪贴板）
          const escaped = text.replace(/'/g, "''")
          await runPs(`Set-Clipboard -Value '${escaped}'`)
          await runPs(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^v')
`, 10000)
          return `已粘贴文本（${text.length} 字符）。注意：剪贴板已被覆盖。`
        }
        case 'key': {
          const keys = toSendKeys(args.key)
          await runPs(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')
`, 10000)
          return `已按键 ${args.key}。`
        }
        case 'scroll': {
          const x = args.x === undefined ? null : assertInt(args.x, 'x')
          const y = args.y === undefined ? null : assertInt(args.y, 'y')
          const amount = assertInt(args.amount ?? 3, 'amount')
          const delta = amount * -120 // 正=上滚
          const script = `
Add-Type -TypeDefinition '${MOUSE_TYPE}'
${x !== null ? `[DscMouse]::SetCursorPos(${x}, ${y}) | Out-Null\nStart-Sleep -Milliseconds 80` : ''}
for ($i = 0; $i -lt ${Math.abs(amount)}; $i++) { [DscMouse]::mouse_event(0x0800, 0, 0, ${delta > 0 ? '120' : '4294967176'}, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }
'Done'
`
          await runPs(script, 10000)
          return `已滚动 ${amount} 档。`
        }
        case 'cursor': {
          const out = await runPs(`
Add-Type -TypeDefinition '${MOUSE_TYPE}'
$p = New-Object DscMouse+POINT
[DscMouse]::GetCursorPos([ref]$p) | Out-Null
"$($p.X),$($p.Y)"
`, 10000)
          const [x, y] = out.trim().split(',')
          return `鼠标当前位置：(${x}, ${y})`
        }
        case 'window_list': {
          const out = await runPs(
            `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Sort-Object MainWindowTitle -Unique | ForEach-Object { $_.Id.ToString() + '|' + $_.MainWindowTitle }`,
            15000,
          )
          return '可见窗口：\n' + out.trim()
        }
        default:
          throw new Error(`未知 action：${action}（可用：${ACTIONS.join(' / ')}）`)
      }
    },
  })
  return () => off()
}
