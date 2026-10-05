/**
 * 0.6.57 特性电池：欢迎页 / 思考分行 / 状态栏两行压缩 / IME 光标停靠序列 /
 * 双击 Esc 撤回上一轮（fork + 原话回输入框）/ 附件芯片（Ctrl+V 贴图、点击预览、
 * ✕ 摘下、提交合流）/ 会话内图片行点击预览 / 子代理浮层（/agents → 转录）。
 *
 * 剪贴板与图片渲染都走 App 的注入口（clipboardReader / imageRenderer），不真调
 * PowerShell；附件用的图片是真实写的 1×1 PNG（submit 断言要读成 data URL）。
 *
 * 运行：pnpm build && node scripts/tui-features-test.mjs
 *
 * @module dsc/scripts/tui-features-test
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'

process.env.DSC_HOME = mkdtempSync(join(tmpdir(), 'dsc-features-test-'))
const { App } = await import('../lib/app/App.js')
const { commandsPlugin } = await import('../lib/plugins/commands.js')

commandsPlugin.apply({
  provide: () => {},
  on: () => () => {},
  emit: () => {},
  get: () => undefined,
  session: { current: () => ({ meta: { cwd: '/w', id: 'test' }, filePath: '/w/test.jsonl' }) },
  llm: {},
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 真实可解码的 1×1 PNG（附件提交要真读文件）。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const pngPath = join(process.env.DSC_HOME, 'pic.png')
writeFileSync(pngPath, PNG_1PX)

const entries = [
  { id: 1, kind: 'user', text: '你好', images: ['data:image/png;base64,AAAA'] },
  { id: 2, kind: 'thinking', text: '用户问「你好」。这是纯问答，直接回答即可，不用工具。' },
  { id: 3, kind: 'text', text: '兄弟你好' },
]

const makeSnapshot = (overrides = {}) => {
  const base = {
    entries,
    sessions: [],
    sessionsLoading: false,
    sessionStates: {},
    status: {
      turnState: 'idle',
      model: 'test-model',
      effort: 'medium',
      usage: null,
      contextWindow: 1_000_000,
      sessionId: '/w/s.jsonl',
      cwd: '/w',
    },
    surfaces: {
      pendingApproval: null,
      pendingQuestion: null,
      pendingPlan: null,
      goal: null,
      todos: { total: 0, done: 0, active: null },
      mode: { options: [{ id: 'build', label: '执行' }], current: 'build' },
      policy: { options: [{ id: 'default', label: '标准' }], current: 'default' },
    },
  }
  return {
    ...base,
    ...overrides,
    surfaces: { ...base.surfaces, ...(overrides.surfaces ?? {}) },
  }
}

const listeners = new Set()
let snapshot = makeSnapshot()
const submits = []
const forkCalls = []
const openedSessions = []
const peeks = []

const runtime = {
  subscribe(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  getSnapshot() {
    return snapshot
  },
  setSnapshot(next) {
    snapshot = next
    for (const listener of [...listeners]) listener()
  },
  listModels: () => [],
  dock: () => Promise.resolve({ entries: [] }),
  submit(text, images) {
    submits.push({ text, images })
  },
  openSession(path) {
    openedSessions.push(path)
  },
  refreshSessions: () => Promise.resolve(),
  listArchivedSessions: () => Promise.resolve({ items: [] }),
  renameSession: () => Promise.resolve({ ok: true }),
  setSessionPinned: () => Promise.resolve({ ok: true }),
  archiveSessions: () => Promise.resolve({ ok: true }),
  restoreSessions: () => Promise.resolve({ ok: true }),
  purgeSessions: () => Promise.resolve({ ok: true }),
  forkSession(path, index) {
    forkCalls.push([path, index])
    return Promise.resolve({ ok: true, path: '/w/fork.jsonl' })
  },
  listUserMessages: () => Promise.resolve(['撤回的原话']),
  listTeammates: () => [
    {
      name: 'writer-1',
      role: 'writer',
      state: 'working',
      task: '写正文',
      file: '/w/agent-writer.jsonl',
      parent: 'lead',
      depth: 1,
      rounds: 3,
      startedAt: 1,
    },
  ],
  peekTranscript(file) {
    peeks.push(file)
    return Promise.resolve([{ id: 1, kind: 'system', text: `代理日志：${file}` }])
  },
  setModel: () => {},
  interrupt: () => {},
  exit: () => {},
  answerApproval: () => {},
  answerQuestion: () => {},
  answerPlan: () => {},
}

/** 注入口：剪贴板总是有图 / 渲染器回一个可断言的字符串。 */
const clipboardReader = async () => ({ kind: 'image', path: pngPath })
const imageRenderer = async () => 'BLOCK-CHARS'

const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}

const stdout = new PassThrough()
stdout.columns = 110
stdout.rows = 40
stdout.isTTY = false

let output = ''
stdout.on('data', (chunk) => {
  output += String(chunk)
})

render(React.createElement(App, { runtime, clipboardReader, imageRenderer }), {
  stdin,
  stdout,
  exitOnCtrlC: false,
  patchConsole: false,
})

const press = async (keys) => {
  output = ''
  stdin.write(keys)
  await sleep(160)
  return output
}

const lastFrame = () => {
  const idx = output.lastIndexOf('\x1b[2K')
  const tail = idx >= 0 ? output.slice(idx) : output
  return tail.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
}
const contentLines = (frame) => frame.replace(/\n$/, '').split('\n')
const lineOf = (frame, needle) => contentLines(frame).findIndex((line) => line.includes(needle))

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('0.6.57 特性测试')

await sleep(160)
let frame = lastFrame()

// 1. 欢迎页：短会话时挂在流顶
check('欢迎页出现（Muse Code + 版本）', frame.includes('Muse Code') && /v0\.6\./.test(frame), JSON.stringify(contentLines(frame).slice(0, 6)))
check('欢迎页含模型与目录', frame.includes('模型 test-model') && frame.includes('/w'))
check('欢迎页提示双击 Esc 撤回', frame.includes('双击 Esc 撤回上一轮'))

// 2. 思考分行：⚓ 斜体标签行不含内容，内容在下一行（0.6.59 对齐 dsh）
const thinkLine = lineOf(frame, '⚓ 思考')
check('思考标签行存在', thinkLine >= 0)
check('思考标签与内容分行', thinkLine >= 0 && !contentLines(frame)[thinkLine].includes('纯问答') && contentLines(frame)[thinkLine + 1].includes('纯问答'), JSON.stringify(contentLines(frame).slice(thinkLine, thinkLine + 2)))

// 3. 状态栏：第一行 context 进度条 + 第二行左右两组字段，整帧仍 39 行
const allLines = contentLines(frame)
const statusLine = allLines.find((line) => line.includes('空闲'))
check('字段行合并状态与模型（左组）', statusLine !== undefined && statusLine.includes('test-model') && statusLine.includes('标准'), JSON.stringify(statusLine))
const barLine = allLines[allLines.length - 2]
check('context 进度条在倒数第二行（读数 0/1.0M）', barLine.includes('--%') === false && barLine.includes('0/1.0M'), JSON.stringify(barLine))
check('字段行在最后一行（右组 ctx/cwd；会话段 0.6.62 出厂关）', allLines[allLines.length - 1] === statusLine && statusLine.includes('ctx') && statusLine.includes('/w') && !statusLine.includes('会话'))

// 4. 恒定帧仍是 39 行
check('恒定帧仍为 39 行', allLines.length === 39, String(allLines.length))

// 5. IME 光标停靠：帧尾有「回到 caret 列 + 显示光标」序列（cursorTo 是 G 序列）
check(
  '光标停靠序列出现（cursorTo + ?25h）',
  output.includes('\x1b[?25h') && /\x1b\[\d+G/.test(output),
  JSON.stringify(output.slice(-200)),
)

// 6. 会话内图片行点击 → 预览浮层（渲染走注入口）
const imgLine = lineOf(frame, '🖼 1 张图片 · 点击预览')
check('图片行带点击提示', imgLine >= 0)
await press(`\x1b[<0;3;${imgLine + 1}M`)
frame = lastFrame()
check('点击图片行打开预览浮层', frame.includes('BLOCK-CHARS') && frame.includes('图片（1 张）'), JSON.stringify(contentLines(frame).slice(0, 8)))
await press('\x1b')
check('Esc 关闭预览', !lastFrame().includes('BLOCK-CHARS'))

// 7. Ctrl+V 贴图：芯片出现 → 提交合流 data URL → 芯片清空
await press('\x16')
frame = lastFrame()
check('Ctrl+V 挂上附件芯片', frame.includes('[图#1] pic.png') && frame.includes('已附加图片 #1'), JSON.stringify(contentLines(frame).slice(-12)))
await press('hello')
await press('\r')
check('提交把芯片读成 data URL 随消息发送', submits.length === 1 && submits[0].text === 'hello' && Array.isArray(submits[0].images) && submits[0].images[0].startsWith('data:image/png;base64,'), JSON.stringify(submits))
check('提交后芯片清空', !lastFrame().includes('[图#1]'))

// 8. 芯片点击预览 / ✕ 摘下
await press('\x16')
frame = lastFrame()
const chipRow = lineOf(frame, '[图#2] pic.png')
check('第二枚芯片出现', chipRow >= 0)
await press(`\x1b[<0;3;${chipRow + 1}M`)
check('点芯片主体打开预览', lastFrame().includes('BLOCK-CHARS'))
await press('\x1b')
// ✕ 在芯片主体之后两列（页边距 +2 后主体从 col 2 起、宽 14，✕ 区在 16-17 列）
await press(`\x1b[<0;18;${chipRow + 1}M`)
check('点 ✕ 摘下芯片', !lastFrame().includes('[图#2]'), JSON.stringify(contentLines(lastFrame()).slice(-10)))

// 9. 双击 Esc 撤回上一轮
await press('\x1b')
check('第一次 Esc 出现 prime 提示', lastFrame().includes('再按一次 Esc'), JSON.stringify(contentLines(lastFrame()).slice(-6)))
await press('\x1b')
frame = lastFrame()
check('第二次 Esc 触发 fork（最后一条用户消息之前）', forkCalls.length === 1 && forkCalls[0][0] === '/w/s.jsonl' && forkCalls[0][1] === 0, JSON.stringify(forkCalls))
check('撤回后切到分叉会话', openedSessions.includes('/w/fork.jsonl'), JSON.stringify(openedSessions))
check('原话回到输入框', frame.includes('撤回的原话'), JSON.stringify(contentLines(frame).slice(-6)))
check('撤回成功提示（原会话保留）', frame.includes('已撤回上一轮') && frame.includes('/resume'))

// 10. /agents 打开子代理浮层 → Enter 看转录（撤回预填的原话先 Ctrl+U 清掉）
await press('\x15')
await press('/agents')
await press('\r')
frame = lastFrame()
check('子代理浮层列出队友', frame.includes('子代理与后台会话') && frame.includes('writer-1') && frame.includes('写正文'), JSON.stringify(contentLines(frame).slice(0, 8)))
await press('\r')
frame = lastFrame()
check('Enter 进入队友转录（只读 peek）', peeks.includes('/w/agent-writer.jsonl') && frame.includes('writer-1（writer）') && frame.includes('代理日志'), JSON.stringify(contentLines(frame).slice(0, 6)))
await press('\x1b')
check('Esc 关闭子代理转录', !lastFrame().includes('writer-1（writer）'))

// 11. 长会话不再画欢迎页
runtime.setSnapshot(makeSnapshot({ entries: Array.from({ length: 120 }, (_, i) => ({ id: i, kind: 'system', text: `条目-${i}` })) }))
await sleep(160)
check('长会话不画欢迎页', !lastFrame().includes('Muse Code'))
check('长会话最新条目仍底对齐', lastFrame().includes('条目-119'))

process.exit(failures === 0 ? 0 : 1)
