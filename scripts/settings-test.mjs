/**
 * TUI 设置页（/settings）的确定性测试：mock runtime 提供分区注册表的四个方法，
 * 走真命令链（输入 /settings 回车）驱动 App 渲染浮层，逐键断言帧内容与调用记录。
 *
 * 覆盖：两级导航（0.6.64：根页分区行 → 分区页字段 → 组子页，Esc 逐级退栈）·
 * 字段渲染（卡片顶边/字段值区右对齐）· select 循环即存 · switch 翻转即存 ·
 * text 编辑（进入/输入/提交/Esc 取消）· number 校验（非法留编辑态弹红）·
 * info.copyable 复制 · button 执行动作 · custom 分区指引行跳转（关页开模型浮层）·
 * Esc 关页 · 鼠标点行激活（分区/组/字段三级）· 滚轮移动焦点 · 思考块默认展开分区。
 *
 * 运行：node scripts/settings-test.mjs（先 pnpm build）
 *
 * @module dsc/scripts/settings-test
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'

process.env.DSC_HOME = mkdtempSync(join(tmpdir(), 'dsc-settings-test-'))
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

/** mock 分区表：一个全字段类型的声明式分区 + custom 分区 + 两个带组的分区。 */
const SECTIONS = [
  {
    id: 'general',
    title: '通用',
    subtitle: '测试分区',
    order: 0,
    builtin: true,
    custom: false,
    fields: [
      { type: 'select', key: 'policy', label: '权限模式', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }], help: '选一个' },
      { type: 'switch', key: 'toggle', label: '开关项', help: '切一下' },
      { type: 'text', key: 'name', label: '文本项', help: '填点字' },
      { type: 'number', key: 'count', label: '数字项', min: 1, max: 10, help: '1 到 10' },
      { type: 'text', key: 'empty', label: '空文本项', help: '没值' },
      { type: 'info', label: '只读项', text: 'C:\\some\\path', mono: true, copyable: true, help: '回车复制' },
      { type: 'info', label: '说明项', text: '不能聚焦的信息' },
      { type: 'button', label: '执行动作', action: 'check-update', help: '按了就知道' },
    ],
  },
  { id: 'models', title: '模型', subtitle: '端点与 key', order: 10, builtin: true, custom: true, fields: [] },
  {
    id: 'browser',
    title: '浏览器自动化',
    subtitle: '测试分组',
    order: 34,
    builtin: false,
    custom: false,
    groups: [
      { id: 'startup', title: '启动与实例', description: '从哪启动' },
      { id: 'safety', title: '安全策略', description: '放行口径' },
    ],
    fields: [
      { type: 'switch', key: 'headless', label: '无窗口运行', group: 'startup', help: '不开窗' },
      { type: 'text', key: 'profileDir', label: 'profile 目录', group: 'startup', help: '实例目录' },
      { type: 'select', key: 'dialogPolicy', label: '对话框策略', group: 'safety', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }], help: '弹窗怎么办' },
      { type: 'button', label: '关闭浏览器', action: 'close-browser', group: 'safety', help: '杀进程' },
    ],
  },
  {
    id: 'tui',
    title: '终端界面',
    subtitle: 'TUI 偏好',
    order: 35,
    builtin: true,
    custom: false,
    groups: [{ id: 'status-bar', title: '状态栏', description: '选底栏显示哪些信息' }],
    fields: [
      { type: 'switch', key: 'reasoningDefaultOpen', label: '思考块默认展开', help: '新会话默认摊开' },
      { type: 'switch', key: 'statusBar.model', label: '显示模型', group: 'status-bar' },
      { type: 'switch', key: 'statusBar.cost', label: '显示会话费用', group: 'status-bar' },
    ],
  },
]

let values = {
  general: { policy: 'a', toggle: false, name: '初始', count: 5, empty: '' },
  models: {},
  browser: { headless: false, profileDir: '', dialogPolicy: 'a' },
  tui: { reasoningDefaultOpen: false, 'statusBar.model': true, 'statusBar.cost': true },
}

const saveCalls = []
const actionCalls = []
const listeners = new Set()
const snapshot = {
  entries: [],
  sessions: [],
  sessionsLoading: false,
  sessionStates: {},
  status: { turnState: 'idle', model: 'test-model', effort: 'medium', usage: null, contextWindow: 1_000_000, sessionId: '/w/s.jsonl', cwd: '/w' },
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
  submit() {},
  openSession() {},
  refreshSessions: () => Promise.resolve(),
  listArchivedSessions: () => Promise.resolve({ items: [] }),
  renameSession: () => Promise.resolve({ ok: true }),
  archiveSessions: () => Promise.resolve({ ok: true }),
  restoreSessions: () => Promise.resolve({ ok: true }),
  purgeSessions: () => Promise.resolve({ ok: true }),
  listUserMessages: () => Promise.resolve([]),
  forkSession: () => Promise.resolve({ ok: true, path: '/w/fork.jsonl' }),
  listTeammates: () => [],
  peekTranscript: () => Promise.resolve([]),
  setModel() {},
  interrupt() {},
  exit() {},
  answerApproval() {},
  answerQuestion() {},
  answerPlan() {},
  // ── 设置页四件套 ──
  getSettingsSections: () => SECTIONS,
  getSectionValues: (id) => Promise.resolve(values[id] ?? {}),
  setSettingValue(id, key, value) {
    saveCalls.push([id, key, value])
    values = { ...values, [id]: { ...values[id], [key]: value } }
    return Promise.resolve({ ok: true, notice: '已保存测试' })
  },
  runSettingAction(id, action) {
    actionCalls.push([id, action])
    return Promise.resolve({ ok: true, notice: '已是最新版' })
  },
  getUiPrefs: () => ({ reasoningDefaultOpen: false }),
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

render(
  React.createElement(App, { runtime }),
  { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
)


const KEY = { down: '\u001b[B', up: '\u001b[A', right: '\u001b[C', left: '\u001b[D', esc: '\u001b', enter: '\r', backspace: '\u007f' }

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
const lines = (frame) => frame.replace(/\n$/, '').split('\n')
/** 找到含 needle 的行；focus=true 时只认 ❯ 开头的聚焦行。 */
const lineOf = (frame, needle, focus = false) =>
  lines(frame).find((line) => line.includes(needle) && (!focus || line.includes('❯')))

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('TUI 设置页测试')

// 1. 打开：根页只列分区导航行（0.6.64 两级导航，字段收进分区页）
let frame = await press('/settings')
frame = await press(KEY.enter)
check('整屏浮层出现（根页只列分区）', frame.includes('设置（4 个分区）'), JSON.stringify(frame.slice(-400)))
check('根页每分区一行带 ›', lineOf(frame, '通用', true)?.includes('›') === true && lineOf(frame, '浏览器自动化')?.includes('›') === true && lineOf(frame, '终端界面')?.includes('›') === true, JSON.stringify(lines(frame).slice(0, 9)))
check('分区行带副标题', lineOf(frame, '通用', true)?.includes('测试分区') === true)
check('根页没有平铺字段（外框圆角除外没有卡片顶边）', !frame.includes('权限模式') && !frame.includes('开关项') && !frame.includes('打开模型选择器'), JSON.stringify(frame.slice(-300)))
check('根页首个聚焦 1/4 且 Esc 是关闭', frame.includes('1/4') && frame.includes('Enter 切换/编辑 · Esc 关闭'))

// 2. Enter 进通用分区页：字段才展开
frame = await press(KEY.enter)
check('分区页面包屑', frame.includes('设置 › 通用'), JSON.stringify(frame.slice(-400)))
check('卡片顶边带标题与副标题', frame.includes('╭─ 通用 · 测试分区'))
check('首个聚焦行是 select 且值右对齐', lineOf(frame, '权限模式', true)?.includes('‹ 甲 ›') === true, JSON.stringify(lineOf(frame, '权限模式', true)))
check('switch 未开显示 [  ]', lineOf(frame, '开关项')?.includes('[  ]') === true)
check('text 值与（未设置）占位', frame.includes('初始') && lineOf(frame, '空文本项')?.includes('（未设置）') === true)
check('分区页 Esc 提示换「返回」', frame.includes('Enter 切换/编辑 · Esc 返回'))

// 3. → 循环 select：改值即存
frame = await press(KEY.right)
check('→ 循环 select 调 setSettingValue', saveCalls.at(-1)?.join('|') === 'general|policy|b', JSON.stringify(saveCalls.at(-1)))
check('select 循环后值区更新', lineOf(frame, '权限模式')?.includes('‹ 乙 ›') === true)
check('保存回执进 notice 行', frame.includes('✓ 已保存测试'))
frame = await press(KEY.left)
check('← 循环回第一个选项', saveCalls.at(-1)?.join('|') === 'general|policy|a')

// 4. switch 翻转即存（↓ 到开关项；状态依赖的按键必须分次 press——同 chunk
// 到达的多个键共享旧闭包，这是测试注入口的物理约束，不是实现的锅）
await press(KEY.down)
frame = await press(KEY.enter)
check('Enter 翻转 switch 存 true', saveCalls.at(-1)?.join('|') === 'general|toggle|true', JSON.stringify(saveCalls.at(-1)))
check('switch 翻转后显示 [✓]', lineOf(frame, '开关项')?.includes('[✓]') === true)
frame = await press(KEY.enter)
check('再按 Enter 翻回 false', saveCalls.at(-1)?.join('|') === 'general|toggle|false')

// 5. text 编辑：进入 → 输入 → 提交
await press(KEY.down)
frame = await press(KEY.enter)
check('Enter 进编辑态显示草稿与光标', lineOf(frame, '文本项')?.includes('初始▌') === true, JSON.stringify(lineOf(frame, '文本项')))
await press(KEY.backspace)
await press(KEY.backspace)
frame = await press('新值')
check('编辑态可输入（光标跟随）', lineOf(frame, '文本项')?.includes('新值▌') === true, JSON.stringify(lineOf(frame, '文本项')))
frame = await press(KEY.enter)
check(
  'Enter 提交草稿并退出编辑态（值就地刷新）',
  saveCalls.at(-1)?.join('|') === 'general|name|新值' && lineOf(frame, '文本项')?.includes('新值') === true && !frame.includes('▌'),
  JSON.stringify(saveCalls.at(-1)) + ' / ' + JSON.stringify(lineOf(frame, '文本项')),
)

// 6. Esc 取消编辑（↓ 到数字项再进编辑态）
await press(KEY.down)
frame = await press(KEY.enter)
check('数字项 Enter 进编辑态', lineOf(frame, '数字项')?.includes('5▌') === true, JSON.stringify(frame.slice(-700)))
frame = await press(KEY.esc)
check('Esc 取消编辑不写入', !saveCalls.some((call) => call[1] === 'count'), JSON.stringify(saveCalls))

// 7. number 校验：非法留编辑态弹红
await press(KEY.enter)
await press(KEY.backspace)
await press('99')
frame = await press(KEY.enter)
check('非法数字弹红留编辑态', frame.includes('✕ 无效输入') && lineOf(frame, '数字项')?.includes('99▌') === true, JSON.stringify(lineOf(frame, '数字项')))
await press(KEY.backspace)
await press(KEY.backspace)
await press('9')
frame = await press(KEY.enter)
check('合法数字提交', saveCalls.at(-1)?.join('|') === 'general|count|9', JSON.stringify(saveCalls.at(-1)))

// 8. 空文本项：空草稿直接提交空串
await press(KEY.down)
await press(KEY.enter)
frame = await press(KEY.enter)
check('空文本直接提交空串', saveCalls.at(-1)?.join('|') === 'general|empty|', JSON.stringify(saveCalls.at(-1)))

// 9. info.copyable 复制（焦点跳过普通 info，直接到 copyable）
await press(KEY.down)
frame = await press(KEY.enter)
check('copyable info 复制回执', frame.includes('已复制') || frame.includes('复制失败'), JSON.stringify(frame.slice(-900)))

// 10. button 执行动作
await press(KEY.down)
frame = await press(KEY.enter)
check('button 调 runSettingAction', actionCalls.at(-1)?.join('|') === 'general|check-update', JSON.stringify(actionCalls))
check('动作回执进 notice 行', frame.includes('✓ 已是最新版'))

// 11. Esc 回根页（焦点回第一个分区）
frame = await press(KEY.esc)
check('分区页 Esc 回根页', frame.includes('设置（4 个分区）') && lineOf(frame, '通用', true)?.includes('›') === true, JSON.stringify(frame.slice(-400)))

// 12. 模型分区（custom）：指引行与跳转
await press(KEY.down)
frame = await press(KEY.enter)
check('custom 分区页显示指引行与说明', frame.includes('打开模型选择器') && frame.includes('端点与 API key 在桌面端设置'), JSON.stringify(frame.slice(-500)))
check('指引行可聚焦', lineOf(frame, '打开模型选择器', true) !== undefined)
frame = await press(KEY.enter)
check('指引行 Enter 关设置页开模型浮层', frame.includes('模型选择（') && !frame.includes('设置（4 个分区）'), JSON.stringify(frame.slice(-300)))

// 13. Esc 关模型浮层，重开设置页落回根页，Esc 关页
await press(KEY.esc)
await press('/settings')
frame = await press(KEY.enter)
check('重开设置页落回根页（改动已保存）', frame.includes('设置（4 个分区）'))
frame = await press(KEY.esc)
check('根页 Esc 关闭设置页', !frame.includes('设置（4 个分区）'))

// 14. 鼠标：根页点分区行进入 → 分区页点 switch 行翻转；滚轮移动焦点
await press('/settings')
frame = await press(KEY.enter)
frame = await press('\x1b[<0;10;3M')
check('鼠标点分区行进入分区页', frame.includes('设置 › 通用'), JSON.stringify(frame.slice(-300)))
frame = await press('\x1b[<0;10;5M')
check('鼠标点 switch 行翻转', saveCalls.at(-1)?.join('|') === 'general|toggle|true', JSON.stringify(saveCalls.at(-1)))
frame = await press('\x1b[<65;10;8M')
check('滚轮下移焦点（2/7）', frame.includes('2/7'), JSON.stringify(lines(frame).find((line) => line.includes('设置 ›'))))
frame = await press('\x1b[<64;10;8M')
check('滚轮上移焦点回 1/7', frame.includes('1/7'), JSON.stringify(lines(frame).find((line) => line.includes('设置 ›'))))
frame = await press('\x1b[<65;10;8M')
frame = await press('\x1b[<65;10;8M')
check('滚轮再下移两步（3/7）', frame.includes('3/7'), JSON.stringify(lines(frame).find((line) => line.includes('设置 ›'))))

// 15. Esc 回根页 → ↓×3 到终端界面 → Enter → 翻转思考块默认展开
await press(KEY.esc)
await press(KEY.down)
await press(KEY.down)
await press(KEY.down)
frame = await press(KEY.enter)
check('终端界面分区页字段可见', frame.includes('设置 › 终端界面') && lineOf(frame, '思考块默认展开') !== undefined, JSON.stringify(frame.slice(-500)))
frame = await press(KEY.enter)
check('tui 分区开关写入 reasoningDefaultOpen', saveCalls.at(-1)?.join('|') === 'tui|reasoningDefaultOpen|true', JSON.stringify(saveCalls.at(-1)))

// 16. tui 状态栏组子页：↓ 到组行，Enter 进子页，翻转 statusBar.cost
frame = await press(KEY.down)
check('tui 组行可聚焦（2/2）', frame.includes('2/2'), JSON.stringify(lines(frame).find((line) => line.includes('设置 ›'))))
frame = await press(KEY.enter)
check('状态栏子页面包屑', frame.includes('设置 › 终端界面 › 状态栏'), JSON.stringify(frame.slice(-500)))
check('子页卡片标题换组名', frame.includes('╭─ 状态栏 · 终端界面') === true)
check('子页只渲染组内字段（无思考块行）', !frame.includes('思考块默认展开'))
check('Esc 提示换「返回」', frame.includes('Enter 切换/编辑 · Esc 返回'))
frame = await press(KEY.down)
frame = await press(KEY.enter)
check('状态栏开关写入 statusBar.cost=false', saveCalls.at(-1)?.join('|') === 'tui|statusBar.cost|false', JSON.stringify(saveCalls.at(-1)))
frame = await press(KEY.esc)
check('组子页 Esc 回分区页（不是根页）', frame.includes('设置 › 终端界面') && !frame.includes('› 状态栏'), JSON.stringify(frame.slice(-400)))
frame = await press(KEY.esc)
check('分区页 Esc 回根页', frame.includes('设置（4 个分区）'))

// 17. browser 分区：分区页只列组行 → 启动与实例子页
await press(KEY.down)
await press(KEY.down)
frame = await press(KEY.enter)
check('browser 分区页只列组行', frame.includes('设置 › 浏览器自动化') && lineOf(frame, '启动与实例', true)?.includes('›') === true && lineOf(frame, '安全策略')?.includes('›') === true, JSON.stringify(frame.slice(-500)))
frame = await press(KEY.enter)
check('browser 启动与实例子页字段齐全', frame.includes('设置 › 浏览器自动化 › 启动与实例') && lineOf(frame, '无窗口运行') !== undefined && lineOf(frame, 'profile 目录') !== undefined, JSON.stringify(frame.slice(-600)))
check('browser 组内字段照常渲染', lineOf(frame, '无窗口运行')?.includes('[  ]') === true)
frame = await press(KEY.esc)
check('组子页 Esc 回 browser 分区页', frame.includes('设置 › 浏览器自动化') && !frame.includes('› 启动与实例'))
frame = await press(KEY.esc)

// 18. 鼠标全链路：根页点分区行 → 点组行 → 点子页 switch，Esc 三级退栈
// （根页 slice = 屏幕行 − 3；browser 行在屏幕行 5；分区页组行/子页 switch 都在屏幕行 4）
frame = await press('\x1b[<0;10;5M')
check('鼠标点分区行进入 browser 分区页', frame.includes('设置 › 浏览器自动化'), JSON.stringify(frame.slice(-300)))
frame = await press('\x1b[<0;10;4M')
check('鼠标点组行进子页', frame.includes('设置 › 浏览器自动化 › 启动与实例'), JSON.stringify(frame.slice(-300)))
frame = await press('\x1b[<0;10;4M')
check('鼠标点子页 switch 行翻转', saveCalls.at(-1)?.join('|') === 'browser|headless|true', JSON.stringify(saveCalls.at(-1)))
frame = await press(KEY.esc)
frame = await press(KEY.esc)
check('两级 Esc 后回根页', frame.includes('设置（4 个分区）'))
frame = await press(KEY.esc)
check('根页 Esc 关页', !frame.includes('设置（4 个分区）'))
await press(KEY.down)
frame = await press(KEY.down)
check('关页后按键不再进设置路由', !frame.includes('设置（4 个分区）') && !frame.includes('设置 ›'))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
