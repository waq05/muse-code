/**
 * dsc 外部插件：Browser Control——让模型驱动一台受控浏览器（CDP 协议）。
 *
 * 首次使用时自动查找 Chrome/Edge 并以独立用户目录（不干扰日常浏览器）+
 * --remote-debugging-port 启动，然后经 Chrome DevTools Protocol 控制：
 *   browser_navigate     打开 URL（等待加载完成，返回截图）
 *   browser_screenshot   视口截图（返回图像；坐标 = 截图像素坐标）
 *   browser_click        点击（坐标 = 截图像素坐标）
 *   browser_type         在当前焦点元素输入文本
 *   browser_key          发送按键（Enter / Tab / ArrowDown ...）
 *   browser_evaluate     在页面执行 JS 并返回结果
 *   browser_close        关闭受控浏览器
 *
 * 实现：零 npm 依赖——Node 内置 fetch + WebSocket + child_process。
 * 浏览器路径为下方字面量常量（不读环境变量、不拼接）。
 *
 * 安装：复制到 ~/.dsc/plugins/。apiVersion 1。
 */
export const name = 'Browser Control'
export const description = '受控浏览器：导航/截图/点击/输入/JS 执行（Chrome DevTools 协议）'
export const apiVersion = 1
export const inject = ['tools']

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEBUG_PORT = 9223
/** 固定的浏览器安装路径（字面量，不读环境变量、不拼接）。 */
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EDGE_EXE = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
const EDGE_EXE_X86 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

/** 会话单例：浏览器进程 + CDP WebSocket + 消息 id。 */
let browserProc = null
let ws = null
let nextId = 1
const pending = new Map()

function sendHttp(path) {
  return fetch(`http://127.0.0.1:${DEBUG_PORT}${path}`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json())
}

/** 发送 CDP 命令并等待对应响应。 */
function cdp(method, params = {}) {
  if (ws === null || ws.readyState !== 1) throw new Error('浏览器未连接（先 browser_navigate）')
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP 命令超时：${method}`))
    }, 20000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function ensureBrowser() {
  if (ws !== null && ws.readyState === 1) return
  // 端口上已有受控实例（上次未关）→ 直接连
  try {
    await connectPage()
    return
  } catch {
    // fallthrough：启动新实例
  }
  const profile = mkdtempSync(join(tmpdir(), 'dsc-browser-'))
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1366,850',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]
  // spawn 首参为字面量路径（安全扫描要求；按安装位置分支）
  if (existsSync(EDGE_EXE)) {
    browserProc = spawn('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', args, { stdio: 'ignore' })
  } else if (existsSync(EDGE_EXE_X86)) {
    browserProc = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', args, { stdio: 'ignore' })
  } else if (existsSync(CHROME_EXE)) {
    browserProc = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args, { stdio: 'ignore' })
  } else {
    throw new Error('未找到 Chrome/Edge；请在插件顶部补充本机浏览器路径常量')
  }
  browserProc.on('exit', () => {
    browserProc = null
    ws = null
  })
  // 等调试端口就绪
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      await connectPage()
      return
    } catch {
      // 端口未就绪，继续等
    }
  }
  throw new Error('浏览器调试端口未就绪（30 次重试失败）')
}

async function connectPage() {
  const targets = await sendHttp('/json/list')
  const page = targets.find((t) => t.type === 'page')
  if (page === undefined) throw new Error('没有 page target')
  await attach(page.webSocketDebuggerUrl)
}

function attach(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.onopen = () => {
      ws = socket
      resolve()
    }
    socket.onerror = () => reject(new Error('WebSocket 连接失败'))
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data))
        if (message.id !== undefined && pending.has(message.id)) {
          const entry = pending.get(message.id)
          pending.delete(message.id)
          clearTimeout(entry.timer)
          if (message.error !== undefined) entry.reject(new Error(`CDP ${message.error.message ?? message.error}`))
          else entry.resolve(message.result)
        }
      } catch {
        // 非 JSON 帧，忽略
      }
    }
    socket.onclose = () => {
      if (ws === socket) ws = null
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('CDP 连接已关闭'))
      }
      pending.clear()
    }
  })
}

async function ensureConnected() {
  await ensureBrowser()
  await cdp('Page.enable').catch(() => {})
  await cdp('Runtime.enable').catch(() => {})
}

/** 等待页面 readyState 完成（navigate 后用）。 */
async function waitForLoad(timeoutMs = 12000) {
  const start = Date.now()
  for (;;) {
    const result = await cdp('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
    if (result?.result?.value === 'complete' || result?.result?.value === 'interactive') return
    if (Date.now() - start > timeoutMs) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function screenshot() {
  const result = await cdp('Page.captureScreenshot', { format: 'png' })
  const base64 = result?.data
  if (typeof base64 !== 'string' || base64 === '') throw new Error('截图失败')
  return base64
}

const MOUSE_BUTTON = { left: 'left', right: 'right', middle: 'middle' }

export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'browser',
    description:
      '驱动受控浏览器（首次调用自动启动 Chrome/Edge 独立实例）：' +
      'browser_navigate 打开网址、browser_screenshot 截图（需视觉模型）、' +
      'browser_click 点击（坐标=截图像素坐标）、browser_type 输入文本、browser_key 按键、' +
      'browser_evaluate 执行页面 JS、browser_close 关闭。建议 navigate → screenshot → click/type 循环。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'screenshot', 'click', 'type', 'key', 'evaluate', 'close'],
          description: '要执行的动作',
        },
        url: { type: 'string', description: 'navigate：目标网址（含 https://）' },
        x: { type: 'integer', description: 'click：横坐标（截图像素坐标）' },
        y: { type: 'integer', description: 'click：纵坐标' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click：鼠标键，默认 left' },
        text: { type: 'string', description: 'type：输入文本' },
        key: { type: 'string', description: 'key：键名，如 Enter / Tab / ArrowDown / Control+a' },
        expression: { type: 'string', description: 'evaluate：页面内执行的 JS 表达式' },
      },
      required: ['action'],
    },
    risk: 'exec',
    async run(args) {
      const action = String(args.action ?? '')
      switch (action) {
        case 'navigate': {
          const url = String(args.url ?? '')
          if (url === '') throw new Error('缺少 url')
          await ensureConnected()
          await cdp('Page.navigate', { url })
          await waitForLoad()
          const shot = await screenshot()
          return {
            text: `已打开 ${url}，当前页面截图如下（坐标即本图像素坐标）：`,
            images: [`data:image/png;base64,${shot}`],
          }
        }
        case 'screenshot': {
          await ensureConnected()
          const shot = await screenshot()
          return { text: '当前页面截图如下（坐标即本图像素坐标）：', images: [`data:image/png;base64,${shot}`] }
        }
        case 'click': {
          const x = Number(args.x)
          const y = Number(args.y)
          if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('x/y 必须是整数')
          const button = MOUSE_BUTTON[String(args.button ?? 'left')] ?? 'left'
          await ensureConnected()
          await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button })
          await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
          await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
          await new Promise((resolve) => setTimeout(resolve, 400))
          const shot = await screenshot()
          return { text: `已在 (${x}, ${y}) ${button} 单击，点击后页面截图：`, images: [`data:image/png;base64,${shot}`] }
        }
        case 'type': {
          const text = String(args.text ?? '')
          if (text === '') throw new Error('缺少 text')
          await ensureConnected()
          await cdp('Input.insertText', { text })
          return `已输入 ${text.length} 字符。`
        }
        case 'key': {
          const key = String(args.key ?? '')
          if (key === '') throw new Error('缺少 key')
          await ensureConnected()
          const VK = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 }
          const parts = key.split('+')
          const main = parts[parts.length - 1]
          const modifiers = parts
            .slice(0, -1)
            .map((part) => ({ Control: 2, Alt: 1, Shift: 8, Meta: 4 }[part] ?? 0))
            .reduce((a, b) => a | b, 0)
          const code = VK[main] ?? (main.length === 1 ? main.toUpperCase().charCodeAt(0) : null)
          if (code === null) throw new Error(`未知按键：${key}`)
          await cdp('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: code, key: main, modifiers })
          await cdp('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, key: main, modifiers })
          await new Promise((resolve) => setTimeout(resolve, 300))
          return `已按键 ${key}。`
        }
        case 'evaluate': {
          const expression = String(args.expression ?? '')
          if (expression === '') throw new Error('缺少 expression')
          await ensureConnected()
          const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
          if (result?.exceptionDetails !== undefined) {
            throw new Error(`页面 JS 异常：${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 400)}`)
          }
          return `执行结果：${JSON.stringify(result?.result?.value ?? null).slice(0, 2000)}`
        }
        case 'close': {
          if (browserProc !== null) {
            browserProc.kill()
            browserProc = null
            ws = null
            return '受控浏览器已关闭。'
          }
          return '浏览器未在运行。'
        }
        default:
          throw new Error(`未知 action：${action}`)
      }
    },
  })
  return () => {
    off()
    if (browserProc !== null) {
      browserProc.kill()
      browserProc = null
      ws = null
    }
  }
}
