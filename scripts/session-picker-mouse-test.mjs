/**
 * 会话选择器「整屏视口 + 鼠标」的确定性测试：用自定义 stdin/stdout 驱动 ink 渲染
 * 整只 App（mock runtime + 最小假命令 ctx），逐事件断言输出帧。
 *
 * 覆盖：帧行数恒等于终端行数（整屏凑满不变式——修「↑↓ 画面跳回底部」的根）/
 * 视口窗口指示 / 鼠标点击选中、再点已选中行=打开 / 滚轮移动 / 释放与右键被忽略 /
 * 改名输入态不响应鼠标 / 鼠标跟踪（DECSET 1000+1006）跟选择器同开同关。
 *
 * 为什么 DSC_HOME 指到临时目录：Composer 挂载会读写 ~/.dsc 下的历史文件，
 * 测试不该碰真实用户数据。
 *
 * 运行：pnpm build && node scripts/session-picker-mouse-test.mjs
 *
 * @module dsc/scripts/session-picker-mouse-test
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'

process.env.DSC_HOME = mkdtempSync(join(tmpdir(), 'dsc-picker-test-'))
const { App } = await import('../lib/app/App.js')
const { commandsPlugin } = await import('../lib/plugins/commands.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 把 commands 插件挂到最小假 ctx 上，让 '/resume' 真的能派发（serviceRef 只在
// apply 时赋值；handler 里用到的 session/llm 都是命令执行时才取，测试只走 /resume）。
commandsPlugin.apply({
  provide: () => {},
  on: () => () => {},
  emit: () => {},
  get: () => undefined,
  session: { current: () => ({ meta: { cwd: '/w', id: 'test' }, filePath: '/w/test.jsonl' }) },
  llm: {},
})

const SESSION_COUNT = 60
const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => ({
  id: `/tmp/sessions/sess-${String(i).padStart(2, '0')}.jsonl`,
  cwd: '/w',
  createdAt: 1_700_000_000_000 + i * 60_000,
  updatedAt: 1_800_000_000_000 - i * 1_000,
  title: `标题${i}`,
}))

const makeSnapshot = () => ({
  entries: [],
  sessions,
  sessionsLoading: false,
  sessionStates: {},
  status: {
    turnState: 'idle',
    model: 'test-model',
    effort: 'medium',
    usage: null,
    sessionId: null,
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
})

const listeners = new Set()
let snapshot = makeSnapshot()
const openedSessions = []

const runtime = {
  subscribe(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  getSnapshot() {
    return snapshot
  },
  listModels: () => [],
  dock: () => Promise.resolve({ entries: [] }),
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
  forkSession: () => Promise.resolve({ ok: true, path: '/tmp/sessions/fork.jsonl' }),
  listUserMessages: () => Promise.resolve([]),
  setModel: () => {},
  interrupt: () => {},
  exit: () => {},
  answerApproval: () => {},
  answerQuestion: () => {},
  answerPlan: () => {},
}

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

render(React.createElement(App, { runtime }), { stdin, stdout, exitOnCtrlC: false, patchConsole: false })

const press = async (keys) => {
  output = ''
  stdin.write(keys)
  await sleep(150)
  return output
}

/** 最后一帧：standard 渲染每次重绘前必写擦行序列（\x1b[2K），取最后一次擦除之后的裸帧。 */
const lastFrame = () => {
  const idx = output.lastIndexOf('\x1b[2K')
  const tail = idx >= 0 ? output.slice(idx) : output
  return tail.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
}
const selectedLine = (frame) =>
  frame.split('\n').find((line) => line.includes('❯') && line.includes('sess-'))

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('会话选择器整屏视口 + 鼠标测试')

// 0. 初始聊天帧：没有选择器，也没有跟踪转义
await sleep(150)
check('初始为聊天视图', lastFrame().includes('输入消息开始对话'))
check('初始未开鼠标跟踪', !output.includes('\x1b[?1000;1006h'))

// 1. /resume 打开选择器
await press('/resume')
await press('\r')
const opened = lastFrame()
check('选择器打开且带全量条数', opened.includes('恢复会话') && opened.includes('（60 条）'))
check('窗口指示显示 1–29', opened.includes('显示 1–29'), JSON.stringify(opened.split('\n').slice(0, 6)))
check('选中第一项 sess-00', (selectedLine(opened) ?? '').includes('sess-00'), JSON.stringify(selectedLine(opened)))
check('鼠标跟踪已开启', output.includes('\x1b[?1000;1006h'))

// 2. 整屏凑满不变式：帧内容行数恒等于「终端行数 − 1」（ink 帧自带尾随换行，末行
//    留给光标；行内有折行就会破坏鼠标几何）。拆行前先剥掉那个尾随换行。
const contentLines = (frame) => frame.replace(/\n$/, '').split('\n')
check(
  '帧内容行数 = 终端行数 − 1（39）',
  contentLines(opened).length === 39,
  String(contentLines(opened).length),
)

// 3. 键盘 ↓×2
await press('\x1b[B\x1b[B')
check('↓×2 选中 sess-02', (selectedLine(lastFrame()) ?? '').includes('sess-02'), JSON.stringify(selectedLine(lastFrame())))

// 4. 滚轮：上 ×1（回到 01）、下 ×2（到 03）
await press('\x1b[<64;10;5M')
check('滚轮上选中 sess-01', (selectedLine(lastFrame()) ?? '').includes('sess-01'), JSON.stringify(selectedLine(lastFrame())))
await press('\x1b[<65;10;5M\x1b[<65;10;5M')
check('滚轮下×2 选中 sess-03', (selectedLine(lastFrame()) ?? '').includes('sess-03'), JSON.stringify(selectedLine(lastFrame())))

// 5. 点击第 15 行（列表第 10 项）：帧底贴屏幕底，listTop=4，第 10 项在屏幕第 15 行
//    （按下+释放一起发：释放必须被忽略）
await press('\x1b[<0;10;15M\x1b[<0;10;15m')
check('点击选中 sess-10（释放被忽略）', (selectedLine(lastFrame()) ?? '').includes('sess-10'), JSON.stringify(selectedLine(lastFrame())))

// 6. 再点已选中行 = 打开：openSession 收到 sess-10，选择器关闭、跟踪转义关闭
await press('\x1b[<0;10;15M')
check('再点已选中行打开会话', openedSessions.length === 1 && openedSessions[0].includes('sess-10'), JSON.stringify(openedSessions))
check('选择器已关闭回聊天', lastFrame().includes('输入消息开始对话'))
check('鼠标跟踪已关闭', output.includes('\x1b[?1000;1006l'))

// 7. 改名态不响应鼠标：重开 → Ctrl+R → 点击行 15 不开门
await press('/resume')
await press('\r')
await press('\x12')
check('改名行出现', lastFrame().includes('改名：标题0'))
check(
  '改名态帧内容行数仍 = 39（改名行与提示行 1:1）',
  contentLines(lastFrame()).length === 39,
  String(contentLines(lastFrame()).length),
)
await press('\x1b[<0;10;15M')
check(
  '改名态点击被吞（无重绘、不开门）',
  openedSessions.length === 1 && output.trim() === '',
  JSON.stringify({ opened: openedSessions.length, out: output.length }),
)
await press('\x1b')
check('Esc 退出改名', !lastFrame().includes('改名：'))

process.exit(failures === 0 ? 0 : 1)
