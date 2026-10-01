/**
 * transcript 的「本轮累计 token」记账测试。
 *
 * 口径：从最近一条 user 条目算起，这一轮每一次模型请求的 prompt_tokens +
 * completion_tokens 全部累加，随条目送给界面（界面每轮页脚显示它）。
 *
 * 覆盖：同一轮多次 usage 累加到轮内最后一条 text / message 定稿时就盖上当时的累计 /
 * 新用户消息清零 / 一轮以工具结果收尾时数字落在 tool 卡上 / 老会话（无 usage 事件）
 * 条目不带 usage / clear() 清零。
 *
 * 为什么要先 build 再跑：这个仓库没有测试框架（唯一的 scripts/composer-test.mjs 也是
 * 这个路子），而 transcript 是 TS、内部按 NodeNext 规则写 `.js` 说明符，node 自带的
 * TS 剥离解析不了 `.js` → `.ts`；所以跑编译产物 lib/。
 *
 * 运行：pnpm build && node scripts/transcript-usage-test.mjs
 *
 * @module dsc/scripts/transcript-usage-test
 */
import { Transcript } from '../lib/adapter/transcript.js'

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
/** 条目上挂的本轮用量；没有就是 undefined。 */
const usageOf = (entry) => (entry === undefined ? undefined : entry.usage)

console.log('transcript 本轮累计 token 测试')

// ── 1. 同一轮两次请求、中间夹一次工具调用（事件顺序照 loop.ts：message 先、usage 后） ──
const t = new Transcript()
t.reduce({ type: 'user', text: '跑个测试' })
t.reduce({ type: 'turn/start' })
t.reduce({ type: 'message', text: '先看一眼', reasoning: '' })
t.reduce({ type: 'usage', inputTokens: 100, outputTokens: 10 })
t.reduce({ type: 'tool/call', callId: 'c1', name: 'bash', args: '{}' })
t.reduce({ type: 'tool/result', callId: 'c1', text: 'ok' })
t.reduce({ type: 'message', text: '好了', reasoning: '' })
t.reduce({ type: 'usage', inputTokens: 200, outputTokens: 20 })
t.reduce({ type: 'turn/end', reason: 'completed' })

const textFirst = t.entries.find((entry) => entry.kind === 'text' && entry.text === '先看一眼')
const textLast = lastOf(t, 'text')
check(
  '一轮两次 usage 全累加到轮内最后一条 text',
  usageOf(textLast)?.inputTokens === 300 && usageOf(textLast)?.outputTokens === 30,
  JSON.stringify(textLast),
)
check('轮内最后一条 text 就是整表最后一条', t.entries[t.entries.length - 1] === textLast)
check(
  '第一次请求定稿时还没有 usage 事件，那条 text 就不带 usage',
  textFirst !== undefined && !Object.hasOwn(textFirst, 'usage'),
  JSON.stringify(textFirst),
)
check(
  '会话累计同时照记（本轮 300+30）',
  t.usage.inputTokens === 300 && t.usage.outputTokens === 30,
  JSON.stringify(t.usage),
)

// ── 2. 第二条用户消息到达 → 本轮累计清零，下一轮只带下一轮的数 ──
t.reduce({ type: 'user', text: '再来一轮' })
t.reduce({ type: 'turn/start' })
t.reduce({ type: 'message', text: '这轮更省', reasoning: '' })
t.reduce({ type: 'usage', inputTokens: 7, outputTokens: 3 })
t.reduce({ type: 'turn/end', reason: 'completed' })

const textRound2 = lastOf(t, 'text')
check(
  '新用户消息后累计清零，下一轮条目只带下一轮的数',
  usageOf(textRound2)?.inputTokens === 7 && usageOf(textRound2)?.outputTokens === 3,
  JSON.stringify(textRound2),
)
check(
  '上一轮的条目数字不动（不会被这一轮覆盖）',
  usageOf(textLast)?.inputTokens === 300 && usageOf(textLast)?.outputTokens === 30,
  JSON.stringify(textLast),
)
check(
  '会话累计跨轮继续累加（300+30 再加 7+3）',
  t.usage.inputTokens === 307 && t.usage.outputTokens === 33,
  JSON.stringify(t.usage),
)

// ── 3. message 定稿那一刻就盖当时的累计（界面轮中就能看到涨，不用等轮末） ──
const live = new Transcript()
live.reduce({ type: 'user', text: '就一问' })
live.reduce({ type: 'message', text: '答', reasoning: '' })
check('一次 usage 事件都没来时不带 usage 字段', !Object.hasOwn(live.entries[1], 'usage'), JSON.stringify(live.entries[1]))
live.reduce({ type: 'usage', inputTokens: 9, outputTokens: 1 })
live.reduce({ type: 'message', text: '补充', reasoning: '' })
check(
  '同轮第二次定稿并进上一条 text，并盖上当时已累计的 usage',
  live.entries.length === 2 && usageOf(live.entries[1])?.inputTokens === 9 && usageOf(live.entries[1])?.outputTokens === 1,
  JSON.stringify(live.entries),
)

// ── 4. 一轮以工具结果收尾、没有最终正文（例如中途中断）：数字落到 tool 卡上 ──
const aborted = new Transcript()
aborted.reduce({ type: 'user', text: '读文件' })
aborted.reduce({ type: 'turn/start' })
aborted.reduce({ type: 'message', text: '', reasoning: '' })
aborted.reduce({ type: 'tool/call', callId: 'c2', name: 'read', args: '{}' })
aborted.reduce({ type: 'usage', inputTokens: 50, outputTokens: 5 })
aborted.reduce({ type: 'tool/result', callId: 'c2', text: '内容' })
aborted.reduce({ type: 'turn/end', reason: 'aborted' })
check(
  '没有最终正文时，本轮数字落在 tool 卡上',
  usageOf(lastOf(aborted, 'tool'))?.inputTokens === 50 && usageOf(lastOf(aborted, 'tool'))?.outputTokens === 5,
  JSON.stringify(aborted.entries),
)

// ── 5. 老会话：重放历史日志（日志里不存每次请求的用量）→ 条目一律不带 usage ──
const old = new Transcript()
old.replayHistory([
  { role: 'user', content: '老会话' },
  {
    role: 'assistant',
    content: '看下文件',
    tool_calls: [{ id: 'c9', type: 'function', function: { name: 'read', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'c9', content: '文件内容' },
  { role: 'assistant', content: '收尾' },
])
check(
  '重放老会话：条目照旧产出（user/text/tool/text 四条）',
  old.entries.length === 4,
  JSON.stringify(old.entries.map((entry) => entry.kind)),
)
check(
  '重放老会话：没有任何条目带 usage 字段',
  old.entries.every((entry) => !Object.hasOwn(entry, 'usage')),
  JSON.stringify(old.entries),
)

// ── 6. clear()（开新会话/恢复会话）必须把本轮累计一起清掉 ──
aborted.clear()
aborted.reduce({ type: 'user', text: '新会话' })
aborted.reduce({ type: 'message', text: 'hi', reasoning: '' })
aborted.reduce({ type: 'turn/end', reason: 'completed' })
check(
  'clear() 后本轮累计清零，新条目不带上一轮的 usage',
  aborted.entries.every((entry) => !Object.hasOwn(entry, 'usage')),
  JSON.stringify(aborted.entries),
)

// ── 7. 文件改动（tool/changes 事件）：实时折叠成条目，重放经 fileChanges 还原 ──
const changes = new Transcript()
const changeSample = {
  path: 'D:\\proj\\a.ts',
  added: 3,
  removed: 1,
  hunks: [
    {
      oldStart: 1,
      oldCount: 4,
      newStart: 1,
      newCount: 6,
      lines: [
        { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
        { kind: 'remove', text: 'b', oldLine: 2, newLine: null },
        { kind: 'add', text: 'c', oldLine: null, newLine: 2 },
      ],
    },
  ],
}
changes.reduce({ type: 'user', text: '改一下' })
changes.reduce({ type: 'tool/call', callId: 'cw', name: 'edit', args: '{}' })
changes.reduce({ type: 'tool/result', callId: 'cw', text: '已编辑' })
changes.reduce({ type: 'tool/changes', callId: 'cw', change: changeSample })
const changesEntry = changes.entries.find((entry) => entry.kind === 'changes')
check('tool/changes 折成 kind:changes 条目', changesEntry !== undefined)
check('条目带上完整的变更事实（路径/增删/hunks）', JSON.stringify(changesEntry?.file) === JSON.stringify(changeSample))

const replay = new Transcript()
replay.replayHistory(
  [
    { role: 'user', content: '改一下' },
    {
      role: 'assistant',
      content: '好的',
      tool_calls: [{ id: 'cw', type: 'function', function: { name: 'edit', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'cw', content: '已编辑' },
    { role: 'assistant', content: '改完了' },
  ],
  new Map(),
  new Map([['cw', changeSample]]),
)
check('重放经 fileChanges 还原出同样的 changes 条目', replay.entries.some((entry) => entry.kind === 'changes'))
const noChanges = new Transcript()
noChanges.replayHistory([{ role: 'user', content: '老会话' }])
check('老会话日志没有变更数据就不出卡条目', !noChanges.entries.some((entry) => entry.kind === 'changes'))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
