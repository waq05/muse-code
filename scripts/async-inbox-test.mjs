/**
 * 异步输入收件箱直测（0.6.47 对齐 dsh 的 next-step inbox）。
 *
 * 事故形状：回合跑动中到达的 user 输入（轮中途插话、后台作业完成通知）原先直接
 * appendUser——若此刻还有没落结果的 tool 调用（最典型：调用正等审批），消息就插在
 * tool_calls 和它的结果中间，DeepSeek 网关按「结果必须紧跟 tool_calls」判 400，
 * 这条会话之后每轮请求都被拒（卡死）。修法：followup 跑动中改入箱（state 条目
 * 持久化），步骤边界/回合收尾才落库；加载时清遗债；请求侧邻接重排兜底存量。
 *
 * 断言六层：
 *   1. 工具执行期间 followup（等价作业完成通知）→ 落库位置在 tool 结果之后，不在中间；
 *   2. 入箱期间不发 user 事件（只有一条 inbox 事件）、快照队列能读到它；出账才发一次；
 *   3. 模型收尾流式期间到达的插话：回合结束后补一轮，模型看得到，输入不丢；
 *   4. 入箱后没出账就重开日志：遗债在加载时自动落库（dsh 收件箱的持久性）；
 *   5. 存量夹层日志：sanitize 邻接重排后 assistant(tool_calls) 紧跟的必是 tool 结果；
 *   6. 队列条的三动作：编辑/删除改的是收件箱、插话提到队首并打断当前回合（0.6.67）。
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/async-inbox-test.mjs
 *
 * @module dsc/scripts/async-inbox-test
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-async-inbox-home-'))
process.env.HOME = home
process.env.USERPROFILE = home

const { Session } = await import('../lib/core/session.js')
const { MiniAgent } = await import('../lib/core/loop.js')
const { sanitizeToolOrphansWithReport } = await import('../lib/core/llm.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rolesOf = (session) => session.messages.map((m) => m.role).join(',')
const textOf = (m) =>
  typeof m.content === 'string'
    ? m.content
    : Array.isArray(m.content)
      ? m.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
      : ''
const textsOf = (session, role) => session.messages.filter((m) => m.role === role).map(textOf)

// ── 1+2：工具执行期间的 followup = 作业完成通知的等价时机 ──────────────────────
{
  const work = mkdtempSync(join(tmpdir(), 'dsc-async-inbox-work1-'))
  const session = Session.create(work, join(work, 's1.jsonl'))
  const events = []
  let modelCalls = 0
  /** 工具执行期间看到的现场：入箱了但还没画气泡。 */
  let duringTool = null
  const agent = new MiniAgent(
    {
      route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
      systemPrompt: () => '',
      tools: () => [
        {
          name: 'slow_thing',
          description: '',
          parameters: { type: 'object', properties: {} },
          risk: 'read',
          run: async () => {
            // 工具还在跑（等价于调用在等审批）：此刻作业完成通知到达
            agent.followup('后台作业 job-1 成功完成。')
            duringTool = {
              userEvents: events.filter((e) => e.type === 'user').length,
              inboxEvents: events.filter((e) => e.type === 'inbox').length,
              inbox: session.asyncInbox().map((item) => item.text),
            }
            return 'ok'
          },
        },
      ],
      guards: { gate: async () => ({ action: 'pass' }), observe: (_name, text) => text },
      emit: (event) => events.push(event),
      stream: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return { text: '', reasoning: '', toolCalls: [{ id: 't1', name: 'slow_thing', arguments: '{}' }], usage: null, finishReason: 'tool_calls' }
        }
        return { text: 'done', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
      },
    },
    session,
  )
  agent.followup('开跑')
  while (agent.isRunning) await sleep(20)
  check('通知落在 tool 结果之后（不在 call 与结果中间）', rolesOf(session) === 'user,assistant,tool,user,assistant', rolesOf(session))
  check('通知文本就位', textsOf(session, 'user')[1] === '后台作业 job-1 成功完成。')
  check('出账后收件箱清空', (session.state('async-inbox')?.items ?? []).length === 0)
  check('入箱期间不画气泡（user 事件只发了「开跑」那条）', duringTool?.userEvents === 1, JSON.stringify(duringTool))
  check('入箱期间快照队列读得到这条', duringTool?.inbox.join('|') === '后台作业 job-1 成功完成。', JSON.stringify(duringTool?.inbox))
  check('入箱发了 inbox 事件（快照据此重画队列条）', duringTool?.inboxEvents === 1, JSON.stringify(duringTool))
  const userEvents = events.filter((e) => e.type === 'user')
  check('user 事件每条消息只发一次（都在出账时发）', userEvents.length === 2, JSON.stringify(userEvents.map((e) => e.text)))
  check('步骤边界出账的插话带 steering 标记', userEvents[1]?.steering === true)
}

// ── 3：模型收尾流式期间到达的插话 → 收尾出账 + 补一轮 ─────────────────────────
{
  const work = mkdtempSync(join(tmpdir(), 'dsc-async-inbox-work2-'))
  const session = Session.create(work, join(work, 's2.jsonl'))
  const events = []
  let modelCalls = 0
  const agent = new MiniAgent(
    {
      route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
      systemPrompt: () => '',
      tools: () => [],
      guards: { gate: async () => ({ action: 'pass' }), observe: (_name, text) => text },
      emit: (event) => events.push(event),
      stream: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          // 最后一轮流式期间用户插话：本轮已经来不及带上了
          setTimeout(() => agent.followup('等等，还有一件事'), 0)
          await sleep(10)
          return { text: '第一轮答案', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
        }
        return { text: '补轮答复', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
      },
    },
    session,
  )
  agent.followup('问点什么')
  while (agent.isRunning) await sleep(20)
  await sleep(50)
  check('插话不丢：收尾出账后补了一轮', modelCalls === 2, `modelCalls=${String(modelCalls)}`)
  check('插话落在第一轮答案之后', textsOf(session, 'user')[1] === '等等，还有一件事' && textsOf(session, 'assistant')[1] === '补轮答复', rolesOf(session))
  const tail = events.filter((e) => e.type === 'user')[1]
  check('收尾出账的那条不算轮中途插话（不带 steering）', tail?.steering === undefined, JSON.stringify(tail))
}

// ── 4：入箱后没出账就重开日志 → 加载时清遗债 ─────────────────────────────────
{
  const work = mkdtempSync(join(tmpdir(), 'dsc-async-inbox-work3-'))
  const file = join(work, 's3.jsonl')
  const session = Session.create(work, file)
  session.appendUser('第一条')
  session.enqueueAsync('欠的输入')
  session.enqueueAsync('带图的欠债', ['data:image/png;base64,AAA'])
  session.close() // 写走的是缓冲流，重开前先收流
  await sleep(100) // 冲刷是异步的，立刻重开读不到刚写的内容
  const reopened = Session.load(file, true)
  check('遗债在加载时落库', textsOf(reopened, 'user').join('|') === '第一条|欠的输入|带图的欠债', rolesOf(reopened))
  check('遗债落库后收件箱清空', (reopened.state('async-inbox')?.items ?? []).length === 0)
}

// ── 4.5：turn/end 监听里紧跟的 followup 不丢（关窗回归：事件发出时 running 仍为 true）──
{
  const work = mkdtempSync(join(tmpdir(), 'dsc-async-inbox-work5-'))
  const session = Session.create(work, join(work, 's5.jsonl'))
  let modelCalls = 0
  let agent
  agent = new MiniAgent(
    {
      route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
      systemPrompt: () => '',
      tools: () => [],
      guards: { gate: async () => ({ action: 'pass' }), observe: (_name, text) => text },
      emit: (event) => {
        if (event.type === 'turn/end' && modelCalls === 1) agent.followup('紧跟着的追问')
      },
      stream: async () => {
        modelCalls += 1
        return { text: `答案${String(modelCalls)}`, reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
      },
    },
    session,
  )
  agent.followup('第一问')
  while (agent.isRunning) await sleep(20)
  await sleep(50)
  check('turn/end 后立刻 followup：补轮跑起来', modelCalls === 2, `modelCalls=${String(modelCalls)}`)
  check('追问落在第一答之后且被回复', textsOf(session, 'user')[1] === '紧跟着的追问' && textsOf(session, 'assistant')[1] === '答案2', rolesOf(session))
  check('收件箱无残留', (session.state('async-inbox')?.items ?? []).length === 0)
}

// ── 5：存量夹层日志 → sanitize 邻接重排 ──────────────────────────────────────
{
  const work = mkdtempSync(join(tmpdir(), 'dsc-async-inbox-work4-'))
  const file = join(work, 's4.jsonl')
  const lines = [
    { type: 'meta', id: 'sandwich', cwd: work, createdAt: Date.now() },
    { type: 'user', text: '开跑' },
    { type: 'assistant', text: '', reasoning: '', toolCalls: [{ id: 'call_q', name: 'bash', arguments: '{}' }] },
    // 夹层：user 通知插在 call 与结果中间（0.6.46 真实会话的形状）
    { type: 'user', text: '后台作业 job-2 成功完成。' },
    { type: 'tool', callId: 'call_q', name: 'bash', text: '用户拒绝了这次工具调用。' },
    { type: 'user', text: '怎么了' },
  ]
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const session = Session.load(file, true)
  const { messages, report } = sanitizeToolOrphansWithReport(session.messages)
  const seam = messages.findIndex((m, i) => i < messages.length - 1 && (m.tool_calls?.length ?? 0) > 0 && messages[i + 1]?.role !== 'tool')
  check('重排后 tool_calls 紧跟 tool 结果', seam < 0, `seam=${String(seam)} roles=${messages.map((m) => m.role).join(',')}`)
  check('重排记账 = 1 条', report.reordered === 1, JSON.stringify(report))
  check('重排不丢消息（条数不变）', messages.length === session.messages.length)
  check('重排后顺序 = call,结果,通知,提问', messages.map((m) => m.role).join(',') === 'user,assistant,tool,user,user', messages.map((m) => m.role).join(','))
}

// ── 6：队列条的三动作：编辑 / 删除 / 插话（0.6.67）────────────────────────────
{
  const work = mkdtempSync(join(tmpdir(), 'dsc-async-inbox-work6-'))
  const session = Session.create(work, join(work, 's6.jsonl'))
  const events = []
  let modelCalls = 0
  let agent
  agent = new MiniAgent(
    {
      route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
      systemPrompt: () => '',
      tools: () => [],
      guards: { gate: async () => ({ action: 'pass' }), observe: (_name, text) => text },
      emit: (event) => events.push(event),
      stream: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          // 第一轮流得慢：这中间用户又发了两条，都进收件箱
          setTimeout(() => {
            agent.followup('第二条')
            agent.followup('第三条')
          }, 0)
          await sleep(40)
          return { text: '第一答', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
        }
        return { text: '第二答', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
      },
    },
    session,
  )
  agent.followup('第一条')
  // 等到两条都入箱：此时队列该有 2 条、对话里还看不见它们
  while (session.asyncInbox().length < 2) await sleep(5)
  check('入箱期间队列条读得到两条', session.asyncInbox().map((item) => item.text).join('|') === '第二条|第三条')
  check('入箱期间对话里没有它们', textsOf(session, 'user').join('|') === '第一条', textsOf(session, 'user').join('|'))
  check('编辑改的是收件箱那一条', agent.editQueued(1, '第三条（改过）') === true && session.asyncInbox()[1]?.text === '第三条（改过）')
  check('编辑不接受空白正文', agent.editQueued(1, '   ') === false && session.asyncInbox()[1]?.text === '第三条（改过）')
  check('删除撤掉一条', agent.removeQueued(0) === true && session.asyncInbox().map((item) => item.text).join('|') === '第三条（改过）')
  check('越界的编辑/删除是空操作', agent.editQueued(9, 'x') === false && agent.removeQueued(9) === false)
  check('插话打断当前回合', agent.steerQueued(0) === true)
  while (agent.isRunning) await sleep(20)
  await sleep(50)
  check('被删掉的那条一条都没进对话', textsOf(session, 'user').join('|') === '第一条|第三条（改过）', textsOf(session, 'user').join('|'))
  check('插话之后模型接着答了新一轮', modelCalls === 2 && textsOf(session, 'assistant').join('|') === '第一答|第二答', textsOf(session, 'assistant').join('|'))
  check('插话出账后队列清空', session.asyncInbox().length === 0)
  const steered = events.filter((e) => e.type === 'user').at(-1)
  check('插话那条是收尾出账（属于新一轮，不带 steering）', steered?.text === '第三条（改过）' && steered?.steering === undefined, JSON.stringify(steered))
  check('回合没在跑时插话是空操作', agent.steerQueued() === false)
}

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 项失败`)
process.exit(failures === 0 ? 0 : 1)
