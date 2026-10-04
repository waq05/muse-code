/**
 * 轨迹页数据缺口测试：工具调用的起止时刻 + 压缩落点标记。
 *
 * 覆盖两块新数据：
 * 1. 工具耗时：`tool/call` 时盖 `call.startedAt`，`tool/result` 时算 `call.durationMs`；
 *    条目上的 `ts` 语义不动（仍是「最后一次写入时刻」，轮次计时靠它）。
 *    done / failed / rejected 都要有耗时——断也断在这段时间里。
 * 2. 压缩落点：实时路径是 compact 插件经 `dsc/notice(text, 'compaction')` 写下的
 *    system 条目；重放路径的摘要在内存里就是一条 `role: 'user'` 的消息，靠正文的
 *    SUMMARY_BANNER 前缀认出来（会话日志不存 system 行，老会话只剩这条摘要可认）。
 *    两种落点都挂 `compaction: { count }`，kind 都不变。
 *
 * 再守两条既有行为不被破坏：老会话重放不冒出这些新字段；transcript 插件的
 * `replayIsRedundant` 判定不受新字段影响（否则重复打开同一条会话会整表重建、重发 id）。
 *
 * 为什么要先 build 再跑：仓库没有测试框架（见 scripts/transcript-usage-test.mjs 的说明），
 * transcript 是 TS 且内部按 NodeNext 规则写 `.js` 说明符，node 自带的 TS 剥离解析不了
 * `.js` → `.ts`，只能跑编译产物 lib/。
 *
 * 运行：pnpm build && node scripts/trace-data-test.mjs
 *
 * @module dsc/scripts/trace-data-test
 */
import { Transcript } from '../lib/adapter/transcript.js'
import { SUMMARY_BANNER } from '../lib/core/compact-anchors.js'
import { transcriptPlugin } from '../lib/plugins/transcript.js'

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** 条目表里某一类条目的最后一条。 */
const lastOf = (transcript, kind) => [...transcript.entries].reverse().find((entry) => entry.kind === kind)

/**
 * 复刻 src/plugins/transcript.ts 里那条监听（`dsc/notice` → system 条目）：
 * 第二个参数是通知类别，`'compaction'` 表示这条通知就是压缩落点。
 */
const notice = (transcript, text, kind) => transcript.system(text, kind === 'compaction')

/** 摘要消息的正文（照 core/compact.ts 拼：横幅 + 摘要正文）。 */
const summaryText = `${SUMMARY_BANNER}\n## 用户要什么\n把轨迹页的数据补齐\n## 下一步做什么\n改 adapter`

console.log('轨迹页数据测试：工具耗时 + 压缩落点')

// ── 1. 工具耗时（实时路径）：发起时只有 startedAt，结果回来才算得出 durationMs ──
const live = new Transcript()
live.reduce({ type: 'user', text: '读文件' }, 900)
live.reduce({ type: 'turn/start' }, 900)
live.reduce({ type: 'tool/call', callId: 'c1', name: 'read', args: '{"file":"a.ts"}' }, 1000)

const running = lastOf(live, 'tool')
check(
  '发起时盖了 startedAt（= 当时的 ts），还没有 durationMs',
  running?.call.startedAt === 1000 && !Object.hasOwn(running.call, 'durationMs'),
  JSON.stringify(running),
)
check('running 阶段条目 ts 就是发起时刻', running?.ts === 1000, JSON.stringify(running))
check(
  '起止时刻挂在工具卡上，不在条目顶层',
  !Object.hasOwn(running, 'startedAt') && !Object.hasOwn(running, 'durationMs'),
  JSON.stringify(running),
)

live.reduce({ type: 'tool/result', callId: 'c1', text: '文件内容' }, 1250)
const done = lastOf(live, 'tool')
check(
  '结果回来后 startedAt 保持 1000、durationMs = 250',
  done?.call.startedAt === 1000 && done?.call.durationMs === 250,
  JSON.stringify(done),
)
check('条目 ts 刷新成结果时刻（stamp 语义没动，轮次计时仍准）', done?.ts === 1250, JSON.stringify(done))
check('status = done', done?.call.status === 'done', JSON.stringify(done))

// ── 2. failed / rejected 同样有耗时：跑挂了、被拒了也占用了这段时间 ──
const broken = new Transcript()
broken.reduce({ type: 'tool/call', callId: 'f1', name: 'bash', args: '{}' }, 2000)
broken.reduce({ type: 'tool/result', callId: 'f1', text: 'ENOENT: 文件没找到', error: 'tool-error' }, 2500)
const failed = lastOf(broken, 'tool')
check(
  'failed 路径也有 startedAt / durationMs',
  failed?.call.status === 'failed' && failed?.call.startedAt === 2000 && failed?.call.durationMs === 500,
  JSON.stringify(failed),
)

const denied = new Transcript()
denied.reduce({ type: 'tool/call', callId: 'r1', name: 'bash', args: '{}' }, 3000)
denied.reduce({ type: 'tool/result', callId: 'r1', text: '用户拒绝了这次调用', error: 'rejected' }, 3100)
const rejected = lastOf(denied, 'tool')
check(
  'rejected 路径也有耗时（400 → 100ms）',
  rejected?.call.status === 'rejected' && rejected?.call.startedAt === 3000 && rejected?.call.durationMs === 100,
  JSON.stringify(rejected),
)

// ── 3. 重放带时间的日志：起止时刻从消息时间复算，不是拿「现在」冒充 ──
const replayNew = new Transcript()
replayNew.replayHistory([
  { role: 'user', content: '读文件', ts: 900 },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c9', type: 'function', function: { name: 'read', arguments: '{}' } }],
    ts: 1100,
  },
  { role: 'tool', tool_call_id: 'c9', content: '文件内容', ts: 1400 },
])
const replayed = lastOf(replayNew, 'tool')
check(
  '重放带 ts 的日志：startedAt = 调用消息的时刻、durationMs = 结果时刻 − 发起时刻',
  replayed?.call.startedAt === 1100 && replayed?.call.durationMs === 300,
  JSON.stringify(replayed),
)
check('重放出来的耗时不会等于「现在」（不拿现场时钟冒充历史）', replayed?.call.durationMs === 300)

// ── 4. 压缩落点（实时）：带 'compaction' 类别的通知落成带标记的 system 条目 ──
const liveCompact = new Transcript()
notice(liveCompact, '会话 aaaaaaaa（模型 test/test）', undefined)
notice(liveCompact, '上下文已压缩（任务清单与目标原样保留）', 'compaction')
notice(liveCompact, '上下文超出模型窗口：已自动压缩历史并重试', 'compaction')
notice(liveCompact, '历史不长，无需压缩', undefined)

check(
  '普通通知不带压缩标记',
  !Object.hasOwn(liveCompact.entries[0], 'compaction') && !Object.hasOwn(liveCompact.entries[3], 'compaction'),
  JSON.stringify(liveCompact.entries),
)
check(
  '压缩通知带 compaction.count = 1（本会话第 1 次压缩），kind 仍是 system、正文原样',
  liveCompact.entries[1]?.kind === 'system' &&
    liveCompact.entries[1]?.compaction?.count === 1 &&
    liveCompact.entries[1]?.text === '上下文已压缩（任务清单与目标原样保留）',
  JSON.stringify(liveCompact.entries[1]),
)
check(
  '第二次压缩 count = 2',
  liveCompact.entries[2]?.compaction?.count === 2,
  JSON.stringify(liveCompact.entries[2]),
)

// ── 5. 压缩落点（重放）：摘要消息靠正文横幅前缀认出来，kind 与正文都不动 ──
const replayCompact = new Transcript()
replayCompact.replayHistory([
  { role: 'user', content: summaryText, ts: 5000 },
  { role: 'assistant', content: '接着干', ts: 5100 },
  { role: 'user', content: '继续', ts: 5200 },
])
check(
  '重放摘要消息被认成压缩落点，count = 1',
  replayCompact.entries[0]?.kind === 'user' && replayCompact.entries[0]?.compaction?.count === 1,
  JSON.stringify(replayCompact.entries[0]),
)
check(
  '摘要正文一字不动（「对话」页的气泡内容不会丢）',
  replayCompact.entries[0]?.text === summaryText,
  JSON.stringify(replayCompact.entries[0]?.text?.slice(0, 40)),
)
check(
  '真用户消息不会被误标成压缩',
  !Object.hasOwn(replayCompact.entries[2], 'compaction'),
  JSON.stringify(replayCompact.entries[2]),
)

// ── 6. 老会话（2026-09 之前的日志：没有时间、没有压缩标记）重放 ──
const legacy = new Transcript()
legacy.replayHistory([
  { role: 'user', content: '老会话' },
  {
    role: 'assistant',
    content: '看下文件',
    tool_calls: [{ id: 'c0', type: 'function', function: { name: 'read', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'c0', content: '文件内容' },
  { role: 'assistant', content: '收尾' },
])
check(
  '老会话重放：条目照旧产出四条',
  legacy.entries.length === 4,
  JSON.stringify(legacy.entries.map((entry) => entry.kind)),
)
check(
  '老会话重放：工具卡不带 startedAt / durationMs（算不出耗时就不编）',
  legacy.entries.every(
    (entry) => entry.kind !== 'tool' || (!Object.hasOwn(entry.call, 'startedAt') && !Object.hasOwn(entry.call, 'durationMs')),
  ),
  JSON.stringify(legacy.entries),
)
check(
  '老会话重放：没有任何条目带压缩标记',
  legacy.entries.every((entry) => !Object.hasOwn(entry, 'compaction')),
  JSON.stringify(legacy.entries),
)

// ── 7. 反证：实时条目与重放条目除了 id/ts/usage 之外，差的正是 startedAt / durationMs ──
// 这就是 plugins/transcript.ts 的 shape() 必须把这两项剔掉的依据：不剔，
// replayIsRedundant 永远判 false，重复打开同一条会话每次都整表重建并重发 id。
const fieldLive = new Transcript()
fieldLive.reduce({ type: 'message', text: '看下文件', reasoning: '' })
fieldLive.reduce({ type: 'tool/call', callId: 'c9', name: 'read', args: '{}' })
fieldLive.reduce({ type: 'tool/result', callId: 'c9', text: '文件内容' })

const fieldProbe = new Transcript()
fieldProbe.replayHistory([
  {
    role: 'assistant',
    content: '看下文件',
    tool_calls: [{ id: 'c9', type: 'function', function: { name: 'read', arguments: '{}' } }],
    ts: 1100,
  },
  { role: 'tool', tool_call_id: 'c9', content: '文件内容', ts: 1400 },
])

/** 照 shape() 剔掉 id / ts / usage，但故意不剔 startedAt / durationMs。 */
const stripApart = (entries) =>
  JSON.stringify(
    entries.map((entry) => {
      const rest = { ...entry }
      delete rest.id
      delete rest.ts
      delete rest.usage
      return rest
    }),
  )

check(
  '两条路径都产出了 startedAt / durationMs',
  typeof fieldLive.entries[1]?.call.startedAt === 'number' &&
    typeof fieldLive.entries[1]?.call.durationMs === 'number' &&
    fieldProbe.entries[1]?.call.startedAt === 1100 &&
    fieldProbe.entries[1]?.call.durationMs === 300,
  JSON.stringify([fieldLive.entries[1]?.call, fieldProbe.entries[1]?.call]),
)
check(
  '不剔这两项时两边形状不同（实时记到达时刻、重放记落盘时刻）',
  stripApart(fieldLive.entries) !== stripApart(fieldProbe.entries),
  JSON.stringify([fieldLive.entries[1]?.call, fieldProbe.entries[1]?.call]),
)

// ── 8. 端到端：假 ctx 跑真插件，验证 replayIsRedundant 不被新字段破坏 ──
// 只实现 transcript 插件真正用到的那几样：on / provide / session / llm / surfaces。
const harness = (() => {
  const session = {
    messages: [
      {
        role: 'assistant',
        content: '看下文件',
        tool_calls: [{ id: 'c9', type: 'function', function: { name: 'read', arguments: '{}' } }],
        ts: 1100,
      },
      { role: 'tool', tool_call_id: 'c9', content: '文件内容', ts: 1400 },
    ],
    toolErrors: new Map(),
    meta: { id: 'aaaaaaaabbbbcccc' },
  }
  const handlers = new Map()
  const provided = new Map()
  const ctx = {
    on: (name, handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    provide: (name, value) => provided.set(name, value),
    // T21 起转录快照会 ctx.get('team')/('agent')（队友名册、常驻 agent 状态）：
    // 本探针不装这两个服务，按「可选服务整个没挂」返回 undefined。
    get: () => undefined,
    session: { current: () => session, sessions: [], loading: false },
    llm: { provider: 'test', model: 'test', effort: 'medium' },
    surfaces: { build: () => ({ pendingApproval: null }) },
  }
  transcriptPlugin.apply(ctx)
  return { session, handlers, service: provided.get('transcript') }
})()

// 先按实时路径喂事件：时间取真实时钟，与日志里的 1100 / 1400 必然不同
harness.service.emit({ type: 'message', text: '看下文件', reasoning: '' })
harness.service.emit({ type: 'tool/call', callId: 'c9', name: 'read', args: '{}' })
harness.service.emit({ type: 'tool/result', callId: 'c9', text: '文件内容' })

const before = harness.service.getSnapshot()
check(
  '实时条目的 startedAt 来自现场时钟（与日志时刻不同，形状本来不一样）',
  before.entries.find((entry) => entry.kind === 'tool')?.call.startedAt !== 1100,
  JSON.stringify(before.entries.map((entry) => (entry.kind === 'tool' ? entry.call : entry.kind))),
)

harness.handlers.get('dsc/session-open')({ filePath: 'D:\\x\\s.jsonl' })
const after = harness.service.getSnapshot()
check(
  '实时条目与重放日志内容一致 → 判为冗余、不重建（快照引用不变）',
  after === before,
  JSON.stringify(after.entries.map((entry) => entry.id)),
)
check(
  '条目 id 没有重新发号（渲染层 key 不会换，折叠态与直播尾不会丢）',
  after.entries.map((entry) => entry.id).join(',') === before.entries.map((entry) => entry.id).join(','),
  JSON.stringify([before.entries.map((entry) => entry.id), after.entries.map((entry) => entry.id)]),
)

// 反向对照：内容真变了就必须重建，否则上一条测的是「恒判冗余」
harness.session.messages.push({ role: 'user', content: '又一句', ts: 2000 })
harness.handlers.get('dsc/session-open')({ filePath: 'D:\\x\\s.jsonl' })
check(
  '内容真变了照样重建（说明上一条不是恒真）',
  harness.service.getSnapshot() !== after,
  JSON.stringify(harness.service.getSnapshot().entries.map((entry) => entry.id)),
)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
