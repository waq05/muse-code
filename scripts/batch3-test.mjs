/**
 * 批三（0.6.60）新增逻辑的确定性测试：费用计价、请求分段估算、转录层新事件折叠。
 * 全部走 lib 的纯函数与 Transcript 折叠器，不起终端。
 *
 * 运行：node scripts/batch3-test.mjs
 *
 * @module dsc/scripts/batch3-test
 */
import assert from 'node:assert/strict'
import {
  addUsageToBuckets,
  emptyCostBuckets,
  estimateSessionCostCny,
  isPeakHour,
  priceForModel,
} from '../lib/core/pricing.js'
import { estimateRequestSegments, estimateTextTokens } from '../lib/core/token-estimate.js'
import { Transcript } from '../lib/adapter/transcript.js'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name} — ${error.message}`)
  }
}

// ── 计价（core/pricing）────────────────────────────────────────────────────

check('isPeakHour：周三上午 10 点（北京）= 高峰', () => {
  // 2026-10-07 是周三；UTC 02:00 = 北京 10:00
  assert.equal(isPeakHour(new Date('2026-10-07T02:00:00Z')), true)
})

check('isPeakHour：周日凌晨不算高峰（周末全天谷）', () => {
  // 2026-10-11 是周日；UTC 02:00 = 北京 10:00（工作日该是峰，但周日不是）
  assert.equal(isPeakHour(new Date('2026-10-11T02:00:00Z')), false)
})

check('isPeakHour：工作日午休 12-14 与晚间是谷', () => {
  assert.equal(isPeakHour(new Date('2026-10-07T04:00:00Z')), false) // 北京 12:00
  assert.equal(isPeakHour(new Date('2026-10-07T12:00:00Z')), false) // 北京 20:00
})

check('priceForModel：前缀最长匹配', () => {
  assert.equal(priceForModel('deepseek-v4-flash').output[1], 8.0)
  assert.equal(priceForModel('deepseek-v4-flash-vision-exp').output[1], 8.0)
  assert.equal(priceForModel('gpt-x'), undefined)
})

check('addUsageToBuckets：命中/未命中拆分（input 含命中）', () => {
  const buckets = emptyCostBuckets()
  addUsageToBuckets(buckets, { inputTokens: 1000, outputTokens: 100, cacheHitTokens: 800, cacheMissTokens: 200 }, true)
  assert.equal(buckets.peak.hit, 800)
  assert.equal(buckets.peak.miss, 200)
  assert.equal(buckets.peak.output, 100)
})

check('addUsageToBuckets：只有命中明细时未命中自己减', () => {
  const buckets = emptyCostBuckets()
  addUsageToBuckets(buckets, { inputTokens: 1000, outputTokens: 0, cacheHitTokens: 800 }, false)
  assert.equal(buckets.idle.hit, 800)
  assert.equal(buckets.idle.miss, 200)
})

check('addUsageToBuckets：无明细全按未命中计（保守上限）', () => {
  const buckets = emptyCostBuckets()
  addUsageToBuckets(buckets, { inputTokens: 500, outputTokens: 50 }, true)
  assert.equal(buckets.peak.miss, 500)
  assert.equal(buckets.peak.hit, 0)
})

check('estimateSessionCostCny：峰谷分桶各按各价', () => {
  const buckets = emptyCostBuckets()
  // 谷桶：未命中 1M × ¥1 + 命中 1M × ¥0.02 + 输出 1M × ¥4 = 5.02
  addUsageToBuckets(buckets, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheHitTokens: 1_000_000, cacheMissTokens: 0 }, false)
  buckets.idle.miss = 1_000_000
  // 峰桶：未命中 1M × ¥2 + 输出 1M × ¥8 = 10
  addUsageToBuckets(buckets, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheHitTokens: 0, cacheMissTokens: 1_000_000 }, true)
  const estimate = estimateSessionCostCny([{ model: 'deepseek-v4-flash', buckets }])
  assert.ok(estimate !== undefined)
  assert.ok(Math.abs(estimate.idle - 5.02) < 1e-9, `idle=${estimate.idle}`)
  assert.ok(Math.abs(estimate.peak - 10) < 1e-9, `peak=${estimate.peak}`)
  assert.ok(Math.abs(estimate.total - 15.02) < 1e-9)
})

check('estimateSessionCostCny：模型不在价目表 → undefined（不给错误数字）', () => {
  const buckets = emptyCostBuckets()
  addUsageToBuckets(buckets, { inputTokens: 1000, outputTokens: 100 }, true)
  assert.equal(estimateSessionCostCny([{ model: 'gpt-x', buckets }]), undefined)
  assert.equal(estimateSessionCostCny([]), undefined)
})

// ── 请求分段估算（core/token-estimate）───────────────────────────────────

check('estimateTextTokens：CJK 与 ASCII 分开计', () => {
  assert.equal(estimateTextTokens('abcd'), 4 * 0.33)
  assert.equal(estimateTextTokens('中文'), 2 * 0.65)
})

check('estimateRequestSegments：五段各归各位', () => {
  const segments = estimateRequestSegments([
    { role: 'system', content: 'system prompt here' },
    { role: 'user', content: '你好帮我看下' },
    { role: 'assistant', content: '好的正在看', reasoning_content: '让我想想', tool_calls: [{ function: { name: 'read', arguments: '{"path":"a.ts"}' } }] },
    { role: 'tool', content: 'file contents', tool_call_id: 'x' },
  ])
  assert.ok(segments.system > 0)
  assert.ok(segments.prompt > 0)
  assert.ok(segments.assistant > 0)
  assert.ok(segments.thinking > 0)
  assert.ok(segments.tools > 0)
  // 工具调用参数归 assistant 段（dsh 同口径），不进 tools
  const noToolCalls = estimateRequestSegments([{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read', arguments: 'abcdefgh' } }] }])
  assert.ok(noToolCalls.assistant > 0)
  assert.equal(noToolCalls.tools, 0)
})

check('estimateRequestSegments：空请求全零', () => {
  assert.deepEqual(estimateRequestSegments([]), { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 })
})

// ── 转录折叠（adapter/transcript）────────────────────────────────────────

check('context 事件更新分段；usage 事件更新权威占用读数', () => {
  const transcript = new Transcript()
  transcript.reduce({ type: 'context', segments: { system: 10, prompt: 20, assistant: 30, thinking: 40, tools: 50 } })
  assert.deepEqual(transcript.contextSegments, { system: 10, prompt: 20, assistant: 30, thinking: 40, tools: 50 })
  transcript.reduce({ type: 'usage', inputTokens: 123, outputTokens: 45, model: 'deepseek-v4-flash' })
  assert.equal(transcript.contextUsed, 123)
})

check('usage 分桶按 model 归账；无 model 的旧事件进空名桶（不计价）', () => {
  const transcript = new Transcript()
  transcript.reduce({ type: 'usage', inputTokens: 10, outputTokens: 1, model: 'deepseek-v4-flash' })
  transcript.reduce({ type: 'usage', inputTokens: 10, outputTokens: 1 })
  assert.equal(transcript.costBuckets.size, 2)
  assert.ok(transcript.costBuckets.has('deepseek-v4-flash'))
  assert.ok(transcript.costBuckets.has(''))
})

check('思考条目带时长（delta 起点到 message 定稿）', () => {
  const transcript = new Transcript()
  const start = Date.now()
  transcript.reduce({ type: 'delta', kind: 'reasoning', text: '思考中' }, start)
  transcript.reduce({ type: 'message', text: '答案', reasoning: '思考中' }, start + 2500)
  const thinking = transcript.entries.filter((entry) => entry.kind === 'thinking')
  assert.equal(thinking.length, 1)
  assert.ok(thinking[0].durationMs >= 2500, `durationMs=${thinking[0].durationMs}`)
})

check('重放历史不造思考时长（durationMs 缺省，界面降级）', () => {
  const transcript = new Transcript()
  transcript.replayHistory([
    { role: 'user', content: 'hi', ts: 1 },
    { role: 'assistant', content: '答', reasoning_content: '想', ts: 2 },
  ])
  const thinking = transcript.entries.filter((entry) => entry.kind === 'thinking')
  assert.equal(thinking.length, 1)
  assert.equal(thinking[0].durationMs, undefined)
})

check('subagent 事件同名原位更新（id 稳定、不叠卡）', () => {
  const transcript = new Transcript()
  transcript.reduce({ type: 'subagent', row: { name: 'writer-1', role: 'writer', task: '写文档', state: 'working', rounds: 1, toolCalls: 2 } })
  transcript.reduce({ type: 'subagent', row: { name: 'writer-1', role: 'writer', task: '写文档', state: 'working', rounds: 2, toolCalls: 3, tokens: 500 } })
  transcript.reduce({ type: 'subagent', row: { name: 'writer-2', role: 'writer', task: '另一件', state: 'working', rounds: 0, toolCalls: 0 } })
  const cards = transcript.entries.filter((entry) => entry.kind === 'subagent')
  assert.equal(cards.length, 2)
  const first = cards.find((entry) => entry.sub.name === 'writer-1')
  assert.equal(first.id, 1) // 首次落卡发的 id
  assert.equal(first.sub.rounds, 2)
  assert.equal(first.sub.tokens, 500)
})

console.log(`\n${passed} PASS / ${failed} FAIL`)
process.exit(failed > 0 ? 1 : 0)
