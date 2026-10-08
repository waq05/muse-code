/**
 * 输出速度（tok/s）与首字延迟的口径测试。
 *
 * 事故形状：旧口径是「快照间隔里累计输出 token 的增量 ÷ 真实流逝时间」，分母里混着
 * 首字等待、工具执行与等下一个请求的空转，数字系统性偏低、还随快照节奏抖。0.6.67 起
 * 换成 dsh 的口径：**整个会话累计**的「输出 token ÷ 纯解码时间（第一口输出 → 定稿）」，
 * 且分子分母成对取（只有拿到第一口、又有服务端 output token 的请求才算）。
 *
 * 断言四层：
 *   1. 宿主测量：一步请求的三个墙钟读数（llmMs / ttftMs / decodeMs）与工具耗时；
 *   2. 事件出账：拿不到第一口就只报 llmMs；usage 为 null 时一个 usage 事件都不发；
 *      打断时补的合成工具结果不报耗时；
 *   3. 日志读写与折叠：lm/ft/d 落盘读回、工具行只进工具耗时、老行不进分子分母、
 *      坏行与别的会话都跳过；
 *   4. 口径函数：除法、除零、首字延迟平均、读数格式（10 以上整数、10 以下一位小数）。
 *
 * 全部跑在临时 HOME / DSC_HOME 上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/throughput-test.mjs
 *
 * @module dsc/scripts/throughput-test
 */
import { appendFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-throughput-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')

const { Session } = await import('../lib/core/session.js')
const { MiniAgent } = await import('../lib/core/loop.js')
const { appendToolRecord, appendUsageRecord, foldSessionUsage, readSessionUsage, readUsageRecords, usageLogFile } =
  await import('../lib/core/usage-log.js')
const { averageTtftMs, formatTokensPerSecond, tokensPerSecond } = await import('../lib/core/throughput.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一个跑得起来的 agent 壳：假 stream、真会话（每个用例自己的临时工作目录）。 */
function makeAgent({ tools = [], stream }) {
  const work = mkdtempSync(join(tmpdir(), 'dsc-throughput-work-'))
  const session = Session.create(work, join(work, 's.jsonl'))
  const events = []
  const agent = new MiniAgent(
    {
      route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
      systemPrompt: () => '',
      tools: () => tools,
      guards: { gate: async () => ({ action: 'pass' }), observe: (_name, text) => text },
      emit: (event) => events.push(event),
      stream,
    },
    session,
  )
  return { agent, events, session }
}

const usageEvents = (events) => events.filter((event) => event.type === 'usage')
const toolResults = (events) => events.filter((event) => event.type === 'tool/result')

console.log('输出速度与首字延迟口径测试')

// ── 1：一步请求的三个墙钟读数 ────────────────────────────────────────────────
{
  const { agent, events } = makeAgent({
    stream: async (_api, _request, handlers) => {
      await sleep(40)
      handlers.onDelta('text', '你')
      await sleep(40)
      handlers.onDelta('text', '好')
      return { text: '你好', reasoning: '', toolCalls: [], usage: { inputTokens: 10, outputTokens: 7 }, finishReason: 'stop' }
    },
  })
  agent.followup('说点什么')
  while (agent.isRunning) await sleep(10)
  const usage = usageEvents(events).at(-1)
  check('一步请求报了一条 usage', usage !== undefined && usage.outputTokens === 7, JSON.stringify(usage))
  check('首字延迟量在第一口输出上（≥25ms）', (usage?.ttftMs ?? -1) >= 25, String(usage?.ttftMs))
  check('解码期量在第一口输出到定稿之间（≥25ms）', (usage?.decodeMs ?? -1) >= 25, String(usage?.decodeMs))
  check(
    'LLM 耗时 = 首字延迟 + 解码期（±10ms 的取时刻误差）',
    (usage?.llmMs ?? -1) >= (usage?.ttftMs ?? 0) + (usage?.decodeMs ?? 0) - 10 && (usage?.llmMs ?? 1e9) <= 600,
    JSON.stringify({ llmMs: usage?.llmMs, ttftMs: usage?.ttftMs, decodeMs: usage?.decodeMs }),
  )
}

// ── 2：只出工具调用（不吐正文）时，工具名算第一口输出 ─────────────────────────
{
  let calls = 0
  const { agent, events } = makeAgent({
    stream: async (_api, _request, handlers) => {
      calls += 1
      await sleep(40)
      handlers.onToolPrepare('bash')
      // 只有第一步要工具：第二步不给，回合才会收尾（否则假 stream 会把回合顶成死循环）
      const toolCalls = calls === 1 ? [{ id: 't1', name: 'bash', arguments: '{}' }] : []
      return {
        text: calls === 1 ? '' : '好了',
        reasoning: '',
        toolCalls,
        usage: { inputTokens: 10, outputTokens: 4 },
        finishReason: calls === 1 ? 'tool_calls' : 'stop',
      }
    },
  })
  agent.followup('跑一条命令')
  while (agent.isRunning) await sleep(10)
  await sleep(20)
  const usage = usageEvents(events)[0]
  check('具名工具增量也算首字（ttftMs 有值）', (usage?.ttftMs ?? -1) >= 25, String(usage?.ttftMs))
  check('只出工具调用同样有解码期', (usage?.decodeMs ?? -1) >= 0, String(usage?.decodeMs))
}

// ── 3：始终没吐字 → 只报 llmMs；usage 为 null → 一个 usage 事件都不发 ─────────
{
  const { agent, events } = makeAgent({
    stream: async () => {
      await sleep(30)
      return { text: '', reasoning: '', toolCalls: [], usage: { inputTokens: 5, outputTokens: 0 }, finishReason: 'stop' }
    },
  })
  agent.followup('空跑')
  while (agent.isRunning) await sleep(10)
  const usage = usageEvents(events).at(-1)
  check('没拿到第一口就只报 llmMs', usage !== undefined && (usage.llmMs ?? -1) >= 20, JSON.stringify(usage))
  check('没拿到第一口不报首字延迟与解码期', usage?.ttftMs === undefined && usage?.decodeMs === undefined, JSON.stringify(usage))
}
{
  const { agent, events } = makeAgent({
    stream: async () => {
      await sleep(10)
      return { text: '没带用量', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
    },
  })
  agent.followup('不带用量的端点')
  while (agent.isRunning) await sleep(10)
  check('usage 为 null 时不发 usage 事件', usageEvents(events).length === 0, JSON.stringify(usageEvents(events)))
}

// ── 4：工具耗时（发起 → 结果），打断时补的合成结果不报 ────────────────────────
{
  const slow = {
    name: 'slow',
    description: '',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => {
      await sleep(40)
      return 'ok'
    },
  }
  const { agent, events } = makeAgent({
    tools: [slow],
    stream: async (_api, _request, _handlers) => {
      // 只有第一步要工具，第二步收尾——否则假 stream 每步都回调用，回合不会停
      const first = toolResults(events).length === 0 && events.filter((event) => event.type === 'tool/call').length === 0
      return {
        text: first ? '' : '完成',
        reasoning: '',
        toolCalls: first ? [{ id: 't1', name: 'slow', arguments: '{}' }] : [],
        usage: null,
        finishReason: first ? 'tool_calls' : 'stop',
      }
    },
  })
  agent.followup('跑一下')
  while (agent.isRunning) await sleep(10)
  const results = toolResults(events)
  check('工具结果带耗时（≥25ms）', results.length === 1 && (results[0].ms ?? -1) >= 25, JSON.stringify(results))
}
{
  const slowWrite = {
    name: 'slow_write',
    description: '',
    parameters: { type: 'object', properties: {} },
    risk: 'write',
    run: async () => {
      await sleep(80)
      return 'ok'
    },
  }
  const { agent, events } = makeAgent({
    tools: [slowWrite],
    stream: async () => {
      // 第一条调用在跑的时候用户打断：第二条还没开始，收尾时补一条合成结果
      setTimeout(() => agent.cancel(), 20)
      return {
        text: '',
        reasoning: '',
        toolCalls: [
          { id: 't1', name: 'slow_write', arguments: '{}' },
          { id: 't2', name: 'slow_write', arguments: '{}' },
        ],
        usage: null,
        finishReason: 'tool_calls',
      }
    },
  })
  agent.followup('改两处')
  while (agent.isRunning) await sleep(10)
  const results = toolResults(events)
  const started = results.find((event) => event.callId === 't1')
  const synthesized = results.find((event) => event.callId === 't2')
  check('跑过的那条有耗时', started !== undefined && (started.ms ?? -1) >= 25, JSON.stringify(results))
  check(
    '打断补的合成结果没有耗时（没有起点就不报）',
    synthesized !== undefined && synthesized.ms === undefined && synthesized.text === '用户取消，调用未执行',
    JSON.stringify(synthesized),
  )
}

// ── 5：日志读写与折叠 ────────────────────────────────────────────────────────
{
  appendUsageRecord({ provider: 'p', model: 'm', i: 100, o: 20, ch: 80, cm: 20, sid: 'sess-1', lm: 1100, ft: 300, d: 800 })
  appendUsageRecord({ provider: 'p', model: 'm', i: 50, o: 5, sid: 'sess-1' }) // 0.6.67 之前的老行：不带墙钟
  appendUsageRecord({ provider: 'p', model: 'm', i: 70, o: 9, sid: 'sess-2', lm: 500, ft: 100, d: 400 })
  appendToolRecord({ sid: 'sess-1', n: 'bash', ms: 250 })
  appendToolRecord({ sid: 'sess-2', n: 'bash', ms: 999 })
  appendFileSync(usageLogFile(), '{"t":1,"sid":"sess-1","i"', 'utf8') // 写盘中断的半截行

  const records = readUsageRecords()
  check('请求行读得回（工具行与坏行都不算）', records.length === 3, JSON.stringify(records.map((row) => row.sid)))
  check(
    '墙钟三项原样读回',
    records[0].lm === 1100 && records[0].ft === 300 && records[0].d === 800,
    JSON.stringify(records[0]),
  )
  check('老行没有墙钟三项', records[1].lm === undefined && records[1].ft === undefined && records[1].d === undefined)

  const view = readSessionUsage('sess-1')
  check(
    '按会话折叠：请求数、token 与墙钟',
    view !== null &&
      view.requests === 2 &&
      view.inputTokens === 150 &&
      view.outputTokens === 25 &&
      view.llmMs === 1100 &&
      view.ttftMs === 300 &&
      view.ttftSteps === 1 &&
      view.decodeMs === 800 &&
      view.decodeTokens === 20,
    JSON.stringify(view),
  )
  check('工具行只进工具耗时与次数', view?.toolMs === 250 && view?.toolCalls === 1, JSON.stringify(view))
  check('缓存两栏成对才算数', view?.cacheHitTokens === 80 && view?.cacheMissTokens === 20, JSON.stringify(view))
  check('最后一次请求取时间戳最新的那条', view?.lastInputTokens === 50, JSON.stringify(view?.lastInputTokens))
  check('别的会话各算各的', readSessionUsage('sess-2')?.toolMs === 999)
  check('这个会话一行都没有 → null', readSessionUsage('sess-404') === null)
  check('空会话 id → null', readSessionUsage('') === null && foldSessionUsage('{}', '') === null)
  check('速度口径接上折叠结果（20 token ÷ 0.8s = 25）', view !== null && tokensPerSecond(view) === 25, String(view !== null && tokensPerSecond(view)))
}

// ── 6：口径函数 ──────────────────────────────────────────────────────────────
{
  check('速度 = token ÷ 解码秒', tokensPerSecond({ decodeMs: 3000, decodeTokens: 60 }) === 20)
  check('解码期为 0 不给数（不除零）', tokensPerSecond({ decodeMs: 0, decodeTokens: 60 }) === null)
  check('没有样本也不给数', tokensPerSecond({ decodeMs: 0, decodeTokens: 0 }) === null)
  check('首字延迟取平均', averageTtftMs({ ttftMs: 1600, ttftSteps: 2 }) === 800)
  check('首字样本为 0 → null', averageTtftMs({ ttftMs: 0, ttftSteps: 0 }) === null)
  check('读数 10 以上给整数', formatTokensPerSecond(10.06) === '10' && formatTokensPerSecond(69.4) === '69')
  check('读数 10 以下给一位小数', formatTokensPerSecond(9.94) === '9.9' && formatTokensPerSecond(8.4) === '8.4')
  check('负数与 0 都读作 0', formatTokensPerSecond(-5) === '0' && formatTokensPerSecond(0) === '0')
}

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 项失败`)
process.exit(failures === 0 ? 0 : 1)
