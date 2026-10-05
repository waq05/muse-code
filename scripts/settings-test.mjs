/**
 * TUI 设置页（/settings）的确定性测试：mock runtime 提供分区注册表的四个方法，
 * 走真命令链（输入 /settings 回车）驱动 App 渲染浮层，逐键断言帧内容与调用记录。
 *
 * 覆盖：整屏渲染（卡片顶边/字段值区右对齐）· select 循环即存 · switch 翻转即存 ·
 * text 编辑（进入/输入/提交/Esc 取消）· number 校验（非法留编辑态弹红）·
 * info.copyable 复制 · button 执行动作 · custom 分区指引行跳转（关页开模型浮层）·
 * Esc 关页 · 鼠标点行激活 · 滚轮移动焦点 · 思考块默认展开分区。
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

/** mock 分区表：一个全字段类型的声明式分区 + custom 分区 + tui 分区。 */
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

// 1. 打开：走真命令链 /settings → openSettings
let frame = await press('/settings')
frame = await press(KEY.enter)
check('整屏浮层出现', frame.includes('设置（4 个分区）'), JSON.stringify(frame.slice(-400)))
check('卡片顶边带标题与副标题', frame.includes('╭─ 通用 · 测试分区') && frame.includes('╭─ 模型 · 端点与 key'))
check('首个聚焦行是 select 且值右对齐', lineOf(frame, '权限模式', true)?.includes('‹ 甲 ›') === true, JSON.stringify(lineOf(frame, '权限模式', true)))
check('switch 未开显示 [  ]', lineOf(frame, '开关项')?.includes('[  ]') === true)
check('text 值与（未设置）占位', frame.includes('初始') && lineOf(frame, '空文本项')?.includes('（未设置）') === true)
check('custom 分区显示指引行与说明', frame.includes('打开模型选择器') && frame.includes('端点与 API key 在桌面端设置'))
check('底部提示条带聚焦 help 与按键', frame.includes('选一个') && frame.includes('Enter 切换/编辑 · Esc 关闭'))

// 2. → 循环 select：改值即存
frame = await press(KEY.right)
check('→ 循环 select 调 setSettingValue', saveCalls.at(-1)?.join('|') === 'general|policy|b', JSON.stringify(saveCalls.at(-1)))
check('select 循环后值区更新', lineOf(frame, '权限模式')?.includes('‹ 乙 ›') === true)
check('保存回执进 notice 行', frame.includes('✓ 已保存测试'))
frame = await press(KEY.left)
check('← 循环回第一个选项', saveCalls.at(-1)?.join('|') === 'general|policy|a')

// 3. switch 翻转即存（↓ 到开关项；状态依赖的按键必须分次 press——同 chunk
// 到达的多个键共享旧闭包，这是测试注入口的物理约束，不是实现的锅）
await press(KEY.down)
frame = await press(KEY.enter)
check('Enter 翻转 switch 存 true', saveCalls.at(-1)?.join('|') === 'general|toggle|true', JSON.stringify(saveCalls.at(-1)))
check('switch 翻转后显示 [✓]', lineOf(frame, '开关项')?.includes('[✓]') === true)
frame = await press(KEY.enter)
check('再按 Enter 翻回 false', saveCalls.at(-1)?.join('|') === 'general|toggle|false')

// 4. text 编辑：进入 → 输入 → 提交
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

// 5. Esc 取消编辑（↓ 到数字项再进编辑态）
await press(KEY.down)
frame = await press(KEY.enter)
check('数字项 Enter 进编辑态', lineOf(frame, '数字项')?.includes('5▌') === true, JSON.stringify(frame.slice(-700)))
frame = await press(KEY.esc)
check('Esc 取消编辑不写入', !saveCalls.some((call) => call[1] === 'count'), JSON.stringify(saveCalls))

// 6. number 校验：非法留编辑态弹红
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

// 7. 空文本项：空草稿直接提交空串
await press(KEY.down)
await press(KEY.enter)
frame = await press(KEY.enter)
check('空文本直接提交空串', saveCalls.at(-1)?.join('|') === 'general|empty|', JSON.stringify(saveCalls.at(-1)))

// 8. info.copyable 复制（焦点跳过普通 info，直接到 copyable）
await press(KEY.down)
frame = await press(KEY.enter)
check('copyable info 复制回执', frame.includes('已复制') || frame.includes('复制失败'), JSON.stringify(frame.slice(-900)))

// 9. button 执行动作
await press(KEY.down)
frame = await press(KEY.enter)
check('button 调 runSettingAction', actionCalls.at(-1)?.join('|') === 'general|check-update', JSON.stringify(actionCalls))
check('动作回执进 notice 行', frame.includes('✓ 已是最新版'))

// 10. ↓ 焦点跳过普通 info 落到指引行；Enter 跳转模型浮层
frame = await press(KEY.down)
check('custom 指引行可聚焦', lineOf(frame, '打开模型选择器', true) !== undefined)
frame = await press(KEY.enter)
check('指引行 Enter 关设置页开模型浮层', frame.includes('模型选择（') && !frame.includes('设置（4 个分区）'), JSON.stringify(frame.slice(-300)))

// 11. Esc 关模型浮层，重开设置页后 Esc 关页
await press(KEY.esc)
await press('/settings')
frame = await press(KEY.enter)
check('重开设置页（值已就地保存）', frame.includes('设置（4 个分区）') && lineOf(frame, '权限模式')?.includes('‹ 甲 ›') === true, JSON.stringify(frame.slice(-600)))
frame = await press(KEY.esc)
check('Esc 关闭设置页', !frame.includes('设置（4 个分区）'))

// 12. 鼠标：点 switch 行（slice 2 → 屏幕行 5）翻转；滚轮移动焦点
await press('/settings')
frame = await press(KEY.enter)
frame = await press('\x1b[<0;10;5M')
check('鼠标点 switch 行翻转', saveCalls.at(-1)?.join('|') === 'general|toggle|true', JSON.stringify(saveCalls.at(-1)))
// 点击只激活不动焦点（焦点仍在 0）：滚轮先下移一档再上移回退，才能看到序号变化
frame = await press('\x1b[<65;10;8M')
check('滚轮下移焦点（2/12）', frame.includes('2/12'), JSON.stringify(lines(frame).find((line) => line.includes('设置（'))))
frame = await press('\x1b[<64;10;8M')
check('滚轮上移焦点（标题序号回退 1/12）', frame.includes('1/12'), JSON.stringify(lines(frame).find((line) => line.includes('设置（'))))
frame = await press('\x1b[<65;10;8M')
frame = await press('\x1b[<65;10;8M')
check('滚轮再下移两步（3/12）', frame.includes('3/12'), JSON.stringify(lines(frame).find((line) => line.includes('设置（'))))

// 13. tui 分区：思考块默认展开开关（焦点从 3/12 一路 ↓ 到第 11 个可聚焦行）
for (let i = 0; i < 8; i += 1) await press(KEY.down)
frame = await press(KEY.enter)
check('tui 分区开关写入 reasoningDefaultOpen', saveCalls.at(-1)?.join('|') === 'tui|reasoningDefaultOpen|true', JSON.stringify(saveCalls.at(-1)))

// 14. tui 状态栏子页：↓ 到组行（12/12），Enter 进子页，翻转 statusBar.cost
frame = await press(KEY.down)
check('tui 组行可聚焦（12/12）', frame.includes('12/12'), JSON.stringify(lines(frame).find((line) => line.includes('设置（'))))
frame = await press(KEY.enter)
check('状态栏子页面包屑', frame.includes('设置 › 终端界面 › 状态栏'), JSON.stringify(frame.slice(-500)))
check('子页卡片标题换组名', frame.includes('╭─ 状态栏 · 终端界面') === true)
check('子页只渲染组内字段（无思考块行）', !frame.includes('思考块默认展开'))
check('Esc 提示换「返回」', frame.includes('Enter 切换/编辑 · Esc 返回'))
frame = await press(KEY.down)
frame = await press(KEY.enter)
check('状态栏开关写入 statusBar.cost=false', saveCalls.at(-1)?.join('|') === 'tui|statusBar.cost|false', JSON.stringify(saveCalls.at(-1)))
frame = await press(KEY.esc)
check('子页 Esc 回根页', frame.includes('设置（4 个分区）') && lineOf(frame, '启动与实例')?.includes('›') === true, JSON.stringify(frame.slice(-400)))

// 15. browser 子页导航：↓ 到 browser 启动组（从 1/12 ↓ 8 步到 9/12）
for (let i = 0; i < 8; i += 1) await press(KEY.down)
frame = await press(KEY.enter)
check('browser 子页：组字段齐全', frame.includes('设置 › 浏览器自动化 › 启动与实例') && lineOf(frame, '无窗口运行') !== undefined && lineOf(frame, 'profile 目录') !== undefined, JSON.stringify(frame.slice(-600)))
check('browser 组内字段照常渲染', lineOf(frame, '无窗口运行')?.includes('[  ]') === true)
frame = await press(KEY.esc)

// 16. 鼠标点组行进子页，再点子页里的 switch 行翻转
// （组行在模型行 17：models 是 custom 分区占两行指引，屏幕行 = 17 + 3 = 20）
frame = await press('\x1b[<0;10;20M')
check('鼠标点组行进子页', frame.includes('设置 › 浏览器自动化 › 启动与实例'), JSON.stringify(frame.slice(-300)))
frame = await press('\x1b[<0;10;4M')
check('鼠标点子页 switch 行翻转', saveCalls.at(-1)?.join('|') === 'browser|headless|true', JSON.stringify(saveCalls.at(-1)))
frame = await press(KEY.esc)
check('鼠标进子页后 Esc 回根页', frame.includes('设置（4 个分区）'))

await press(KEY.esc)
frame = await press(KEY.down)
check('关页后按键不再进设置路由', !frame.includes('设置（4 个分区）'))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
