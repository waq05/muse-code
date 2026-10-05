/**
 * 整屏视口 + 全局鼠标的确定性测试：用自定义 stdin/stdout 驱动 ink 渲染整只 App
 * （mock runtime + 最小假命令 ctx），逐事件断言输出帧。
 *
 * 覆盖：恒定帧（帧内容行数恒等于终端行数 − 1，任何状态——修「↑↓ 跳回底部」的根）/
 * 聊天视口底对齐裁剪（最新可见、最老被裁）/ 滚轮与 PgUp·PgDn 回看 + 回底提示条点击 /
 * 会话选择器（窗口指示、点击选中、再点打开、改名态免疫）/ 审批卡页脚按钮点击 /
 * 提问卡选项点击 / 鼠标跟踪（DECSET 1000+1006）全时开启。
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

const ENTRY_COUNT = 120
const entries = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
  id: i,
  kind: 'system',
  text: `条目-${i}`,
}))

const makeSnapshot = (overrides = {}) => {
  const base = {
    entries,
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
  }
  return {
    ...base,
    ...overrides,
    surfaces: { ...base.surfaces, ...(overrides.surfaces ?? {}) },
  }
}

const listeners = new Set()
let snapshot = makeSnapshot()
const openedSessions = []
const approvalAnswers = []
const questionAnswers = []

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
  answerApproval(answer) {
    approvalAnswers.push(answer)
  },
  answerQuestion(answer) {
    questionAnswers.push(answer)
  },
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
/** 帧内容行数（ink 帧自带尾随换行，剥掉再拆）。 */
const contentLines = (frame) => frame.replace(/\n$/, '').split('\n')
/** 帧里包含某段文本的第一行的 0 基行号（找不到返回 -1）。 */
const lineOf = (frame, needle) => contentLines(frame).findIndex((line) => line.includes(needle))
const selectedLine = (frame) =>
  contentLines(frame).find((line) => line.includes('❯') && line.includes('sess-'))

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('整屏视口 + 全局鼠标测试')

// 0. 恒定帧 + 聊天视口裁剪 + 全时鼠标跟踪
await sleep(150)
let frame = lastFrame()
check('初始帧内容行数 = 39（终端行数 − 1，恒定帧）', contentLines(frame).length === 39, String(contentLines(frame).length))
check('最新条目可见（底对齐）', frame.includes('条目-119'))
check('最老条目被顶上裁掉', !frame.includes('条目-0'))
check('鼠标跟踪全时开启', output.includes('\x1b[?1000;1006h'))

// 1. 滚轮回看：上 ×3 → 锚在 117，提示条出现，帧仍恒定
await press('\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<64;10;5M')
frame = lastFrame()
check('滚轮上×3 停在条目-117', frame.includes('条目-116') && !frame.includes('条目-119'), JSON.stringify(frame.includes('条目-116')))
check('回底提示条出现（pill 样式）', frame.includes('回到底部') && frame.includes('Enter/End'))
check('滚轮回看帧仍 39 行', contentLines(frame).length === 39, String(contentLines(frame).length))

// 2. 点击提示条回到底部
const indicatorRow = lineOf(frame, '回到底部') + 1
await press(`\x1b[<0;10;${indicatorRow}M`)
frame = lastFrame()
check('点击提示条回到底部（条目-119 回来）', !frame.includes('回到底部') && frame.includes('条目-119'))

// 3. PgUp/PgDn 回看
await press('\x1b[5~')
check('PgUp 回看 10 条出现提示条', lastFrame().includes('回到底部') && lastFrame().includes('Enter/End'))
await press('\x1b[6~')
check('PgDn 回到底部提示条消失', !lastFrame().includes('回到底部') && lastFrame().includes('条目-119'))

// 4. 会话选择器：打开 → 窗口指示 → 点击选中 → 再点打开
await press('/resume')
await press('\r')
frame = lastFrame()
check('选择器打开且带全量条数', frame.includes('恢复会话') && frame.includes('（60 条）'))
check('窗口指示显示 1–32（状态栏压缩后列表多两行）', frame.includes('显示 1–32'), JSON.stringify(contentLines(frame).slice(0, 5)))
check('选中第一项 sess-00', (selectedLine(frame) ?? '').includes('sess-00'), JSON.stringify(selectedLine(frame)))
check('选择器帧仍 39 行', contentLines(frame).length === 39, String(contentLines(frame).length))
await press('\x1b[B\x1b[B')
check('↓×2 选中 sess-02', (selectedLine(lastFrame()) ?? '').includes('sess-02'), JSON.stringify(selectedLine(lastFrame())))
await press('\x1b[<64;10;5M')
check('滚轮上选中 sess-01', (selectedLine(lastFrame()) ?? '').includes('sess-01'), JSON.stringify(selectedLine(lastFrame())))
// 列表行从顶边框+标题+筛选行之后起排（行 3，0 基）→ 第 10 项在屏幕第 14 行（1 基）
await press('\x1b[<0;10;14M\x1b[<0;10;14m')
check('点击选中 sess-10（释放被忽略）', (selectedLine(lastFrame()) ?? '').includes('sess-10'), JSON.stringify(selectedLine(lastFrame())))
await press('\x1b[<0;10;14M')
check('再点已选中行打开会话', openedSessions.length === 1 && openedSessions[0].includes('sess-10'), JSON.stringify(openedSessions))
check('选择器已关闭回聊天', lastFrame().includes('条目-119'))

// 5. 改名态不响应鼠标
await press('/resume')
await press('\r')
await press('\x12')
check('改名行出现', lastFrame().includes('改名：标题0'))
check('改名态帧仍 39 行', contentLines(lastFrame()).length === 39, String(contentLines(lastFrame()).length))
await press('\x1b[<0;10;14M')
check('改名态点击被吞（无重绘、不开门）', openedSessions.length === 1 && output.trim() === '', JSON.stringify({ opened: openedSessions.length, out: output.length }))
await press('\x1b')
check('Esc 退出改名', !lastFrame().includes('改名：'))
await press('\x1b')

// 6. 审批卡：页脚按钮点击 = 按键
runtime.setSnapshot(makeSnapshot({
  surfaces: {
    pendingApproval: {
      id: 'a1',
      toolName: 'write_file',
      risk: 'high',
      reason: '要写入工作区文件',
      argsSummary: '写 D:/tmp/a.txt',
      policy: 'default',
      mode: '执行',
      scopes: ['session', 'always'],
      hardline: false,
    },
  },
}))
await sleep(150)
frame = lastFrame()
const approvalRow = lineOf(frame, '允许一次') + 1
check('审批卡出现且页脚可寻址', approvalRow > 0)
await press(`\x1b[<0;5;${approvalRow}M`)
check('点击 [y] 允许一次', approvalAnswers.length === 1 && approvalAnswers[0] === 'allow-once', JSON.stringify(approvalAnswers))
runtime.setSnapshot(makeSnapshot())

// 7. 提问卡：选项行点击 = 空格（单选即答）
runtime.setSnapshot(makeSnapshot({
  surfaces: {
    pendingQuestion: {
      id: 'q1',
      question: '选哪个方案？',
      options: [{ label: '方案甲' }, { label: '方案乙' }],
      multiSelect: false,
    },
  },
}))
await sleep(150)
frame = lastFrame()
const optionRow = lineOf(frame, '方案乙') + 1
check('提问卡出现且选项行可寻址', optionRow > 0)
await press(`\x1b[<0;10;${optionRow}M`)
check('点击方案乙即作答', questionAnswers.length === 1 && questionAnswers[0] === '方案乙', JSON.stringify(questionAnswers))

process.exit(failures === 0 ? 0 : 1)
