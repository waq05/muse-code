/**
 * TUI 底部状态栏（0.6.62 段可配置 + 优先级丢段）的确定性测试：直接渲染 StatusBar
 * 纯组件（props 全部手工给），断言帧内容。
 *
 * 覆盖：默认配置只画出厂开的段（model/cache/cost/policy/ctx/cwd）· 关掉的段
 * 整段缺席 · ` · ` 分隔 · 数据缺席整段缺席（usage=null / cost/cwd undefined）·
 * 子代理芯片渲染（0.6.65 起只吃 subagents——当前会话、还在干活的队友）·
 * 窄终端按优先级整段丢弃（tokens→session→cost→cache→mode→effort→ctx→
 * chips→cwd）且状态点与模型永不丢。
 *
 * 运行：node scripts/statusbar-test.mjs（先 pnpm build）
 *
 * @module dsc/scripts/statusbar-test
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'

process.env.DSC_HOME = mkdtempSync(join(tmpdir(), 'dsc-statusbar-test-'))
const { StatusBar, shortId } = await import('../lib/app/StatusBar.js')
const { DEFAULT_STATUS_BAR_PREFS } = await import('../lib/contract.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** StatusView 手工底座：contextWindow 1M、ctx 1.2%、五段分段、DeepSeek 价目下的费用。 */
const STATUS = {
  turnState: 'idle',
  model: 'deepseek-v3.2',
  effort: 'default',
  usage: { inputTokens: 9500, outputTokens: 1200, cacheHitTokens: 8000, cacheMissTokens: 1500 },
  contextWindow: 1_000_000,
  contextUsed: 12_000,
  contextSegments: { system: 3000, prompt: 2000, assistant: 4000, thinking: 1000, tools: 2000 },
  cost: { total: 0.04, peakNow: true },
  sessionId: '/w/ab12cd34-5678.jsonl',
  cwd: 'D:\\dsc\\src',
}

const SURFACES = {
  pendingApproval: null,
  pendingQuestion: null,
  pendingPlan: null,
  goal: null,
  todos: { total: 0, done: 0, active: null },
  mode: { options: [{ id: 'build', label: '执行' }], current: 'build' },
  policy: { options: [{ id: 'auto-edit', label: '自动编辑' }], current: 'auto-edit' },
}

const stdout = new PassThrough()
stdout.columns = 110
stdout.rows = 10
stdout.isTTY = false
let output = ''
stdout.on('data', (chunk) => {
  output += String(chunk)
})

const clean = (frame) => frame.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')

let instance = null
/** 渲一帧 StatusBar：columns 决定丢段预算，config 决定段显隐。 */
const renderBar = async ({ columns = 110, config = DEFAULT_STATUS_BAR_PREFS, status = STATUS, subagents = [] }) => {
  if (instance !== null) instance.unmount()
  output = ''
  stdout.columns = columns
  instance = render(
    React.createElement(StatusBar, { status, surfaces: SURFACES, subagents, config }),
    // useStdout 读的就是这份 stdout 的 columns——必须传外面这份（列宽在这儿改）
    { stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(120)
  // 这版 ink 的 render 实例没有 lastFrame——按 settings-test 同款从原始输出取末帧
  const idx = output.lastIndexOf('\x1b[2K')
  return clean(idx >= 0 ? output.slice(idx) : output)
}

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('TUI 状态栏测试')

// 1. 宽终端 + 出厂默认：开的段在，关的段不在
let frame = await renderBar({ columns: 110 })
check('状态点与状态词在', frame.includes('● 空闲'), JSON.stringify(frame.slice(0, 200)))
check('模型段在（出厂开）', frame.includes('deepseek-v3.2'))
check('缓存段在（出厂开）', frame.includes('缓存84%'))
check('费用段在（出厂开）', frame.includes('≈¥0.04 峰'))
check('权限段在（出厂开）', frame.includes('权限 自动编辑'))
check('ctx 段在（出厂开）', frame.includes('ctx 1.2%'))
check('cwd 段在（出厂开）', frame.includes('dsc/src'))
check('effort 段出厂关', !frame.includes('effort'))
check('tok 段出厂关', !frame.includes('tok 9.5k'))
check('模式段出厂关', !frame.includes('模式 执行'))
check('会话段出厂关', !frame.includes('会话 ab12cd34'))
check('段间 · 分隔', frame.includes(' · '))

// 2. 开关全开：四段出厂关的全部出现（全开总宽 ~147，140 列会被优先级正确地丢 tok，给 160）
frame = await renderBar({ columns: 160, config: { ...DEFAULT_STATUS_BAR_PREFS, effort: true, tokens: true, mode: true, session: true } })
check('effort 段打开后出现', frame.includes('effort default'))
check('tok 段打开后出现', frame.includes('tok 9.5k↑ 1.2k↓'))
check('模式段打开后出现', frame.includes('模式 执行'))
check('会话段打开后出现', frame.includes(`会话 ${shortId(STATUS.sessionId)}`))

// 3. 开关关掉：出厂开的段也能关掉
frame = await renderBar({ columns: 110, config: { ...DEFAULT_STATUS_BAR_PREFS, cost: false, cwd: false } })
check('费用段关掉整段缺席', !frame.includes('≈¥'))
check('cwd 段关掉整段缺席', !frame.includes('dsc/src'))
check('其余段不受影响', frame.includes('缓存84%') && frame.includes('ctx 1.2%'))

// 4. 数据缺席整段缺席：无 usage、无 cost、无 cwd
const noData = {
  ...STATUS,
  usage: null,
  cost: undefined,
  cwd: undefined,
}
frame = await renderBar({ columns: 110, status: noData })
check('usage 缺时缓存段缺席', !frame.includes('缓存'))
check('usage 缺时 tok 段缺席（即便开关开着）', !frame.includes('tok'), JSON.stringify(frame.slice(0, 200)))
check('cost 缺时费用段缺席', !frame.includes('≈¥'))
check('cwd 缺时目录段缺席', !frame.includes('dsc'))
check('模型与状态点仍在', frame.includes('● 空闲') && frame.includes('deepseek-v3.2'))

// 5. 子代理芯片（0.6.65 起 subagents 只收当前会话还在干活的队友）：
// 收工/切会话的语义由快照组装保证（transcript.ts），组件层面只认这份列表
frame = await renderBar({ columns: 110, subagents: [{ sessionPath: '/w/7b5cc3a9-1111.jsonl', state: 'working' }] })
check('干活队友芯片渲染（◐ + 短 id）', frame.includes('◐ 7b5cc3a9'))
frame = await renderBar({ columns: 110, subagents: [{ sessionPath: '/w/7b5cc3a9-1111.jsonl', state: 'awaiting-approval' }] })
check('待审批队友芯片渲染（⚠）', frame.includes('⚠ 7b5cc3a9'))
frame = await renderBar({ columns: 110, subagents: [] })
check('没有干活队友就没有芯片（收工/切会话即消失）', !frame.includes('◐') && !frame.includes('7b5cc3a9'), JSON.stringify(frame.slice(0, 200)))

// 6. 窄终端丢段：tokens（优先级 0）先丢，session 次之；状态点与模型永不丢
frame = await renderBar({
  columns: 46,
  config: { ...DEFAULT_STATUS_BAR_PREFS, effort: true, tokens: true, mode: true, session: true },
  subagents: [{ sessionPath: '/w/7b5cc3a9-1111.jsonl', state: 'working' }],
})
check('窄终端 tokens 整段先丢', !frame.includes('tok 9.5k'), JSON.stringify(frame.slice(0, 300)))
check('窄终端 session 段被丢', !frame.includes('会话 ab12cd34'))
check('窄终端费用被丢', !frame.includes('≈¥0.04'))
check('窄终端队友芯片被丢（priority 8，先于 cwd）', !frame.includes('7b5cc3a9'))
check('窄终端状态点永不丢', frame.includes('● 空闲'))
check('窄终端模型永不丢', frame.includes('deepseek-v3.2'))
check('窄终端没有逐段省略号垃圾', !frame.includes('……'))

// 7. 极窄（30 列）：可丢的全丢光，只剩状态点 + 模型（预算 26 ≥ 状态点+分隔+模型）
frame = await renderBar({ columns: 30 })
check('极窄只剩状态点与模型', frame.includes('● 空闲') && frame.includes('deepseek-v3.2'), JSON.stringify(frame.slice(0, 200)))
check('极窄 cwd 也被丢', !frame.includes('dsc/src'))

if (failures === 0) {
  console.log('\n全部通过')
} else {
  console.log(`\n${failures} 项失败`)
}
process.exit(failures === 0 ? 0 : 1)
