/**
 * 工具结果重复应答的三层防护直测（0.6.46 报障：同一 callId 两条 tool 结果 → 网关 400）。
 *
 * 事故形状（本文件逐条复刻）：assistant 发起 ask_user → 会话被重开，加载时的中断修复
 * 先补了一条「[回合被打断]…」合成结果 → 紧接着被打断的那一轮把真实结果也写了进来。
 * 日志里同一 callId 于是有两条 tool 记录，DeepSeek 网关按「tool 消息必须是某个尚未被
 * 应答的前置 tool_calls 的回应」判 400，这条会话之后每次请求都被拒（卡死）。
 *
 * 断言三层（去重都保留首条——首条是合成件时模型会先去核查副作用，比后到的
 * 「用户取消」之类措辞更保守）：
 *   1. Session.load 重放：同 callId 只留首条，且不动日志文件（append-only）；
 *   2. Session.appendTool：已有结果的 callId 不再落库（内存与磁盘都不出第二条）；
 *   3. sanitizeToolOrphans 请求侧去重 + 既有孤儿剔除行为不回归。
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/session-dedupe-test.mjs
 *
 * @module dsc/scripts/session-dedupe-test
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-session-dedupe-home-'))
process.env.HOME = home
process.env.USERPROFILE = home

const { Session } = await import('../lib/core/session.js')
const { sanitizeToolOrphans } = await import('../lib/core/llm.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const work = mkdtempSync(join(tmpdir(), 'dsc-session-dedupe-work-'))
const file = join(work, 'dup.jsonl')
const callA = { id: 'call_a', name: 'ask_user', arguments: '{}' }
const lines = [
  { type: 'meta', id: 'dedupe-test', cwd: work, createdAt: Date.now() },
  { type: 'user', text: '帮我更新dsh源码' },
  { type: 'assistant', text: '', reasoning: '', toolCalls: [callA] },
  { type: 'tool', callId: 'call_a', name: 'ask_user', text: '合成：结果未知' },
  { type: 'tool', callId: 'call_a', name: 'ask_user', text: '真实：这个问题作废' },
  { type: 'user', text: '继续' },
  {
    type: 'assistant',
    text: '',
    reasoning: '',
    toolCalls: [
      { id: 'call_b', name: 'read', arguments: '{}' },
      { id: 'call_c', name: 'read', arguments: '{}' },
    ],
  },
  { type: 'tool', callId: 'call_b', name: 'read', text: 'ok-b' },
  { type: 'tool', callId: 'call_c', name: 'read', text: 'ok-c' },
]
const raw = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
writeFileSync(file, raw, 'utf8')

try {
  // ── 1. 重放去重（Session.load） ──
  const session = Session.load(file, true)
  const answersA = session.messages.filter((message) => message.role === 'tool' && message.tool_call_id === 'call_a')
  check('重放：同一 callId 只剩一条结果', answersA.length === 1, `count=${answersA.length}`)
  check('重放：保留的是首条（合成件）', answersA[0]?.content === '合成：结果未知', JSON.stringify(answersA[0]?.content))
  check(
    '重放：别的 callId 不受影响（不误伤）',
    session.messages.filter((message) => message.tool_call_id === 'call_b').length === 1
      && session.messages.filter((message) => message.tool_call_id === 'call_c').length === 1,
  )
  check('重放：消息条数 = 日志条数 - meta - 重复那条', session.messages.length === lines.length - 2, `count=${session.messages.length}`)
  check('重放：日志文件原样（append-only，修复只进内存）', readFileSync(file, 'utf8') === raw)

  // ── 2. 落库查重（Session.appendTool） ──
  session.appendTool('call_a', 'ask_user', '迟到的真实结果')
  check(
    '落库：已有结果的 callId 第二次被拒（内存）',
    session.messages.filter((message) => message.tool_call_id === 'call_a').length === 1,
  )
  session.appendTool('call_new', 'read', 'ok-new')
  check(
    '落库：新 callId 照常进内存（不误伤）',
    session.messages.filter((message) => message.tool_call_id === 'call_new').length === 1,
  )
  session.close()
  // 写流是异步 flush 的：关流后给一拍再读盘
  await new Promise((resolve) => setTimeout(resolve, 200))
  const onDisk = readFileSync(file, 'utf8')
  check(
    '落库：已有结果的 callId 第二次不上盘（盘上仍是 fixture 那两条，没变三条）',
    onDisk.split('\n').filter((line) => line.includes('"callId":"call_a"')).length === 2
      && !onDisk.includes('迟到的真实结果'),
    JSON.stringify(onDisk.split('\n').filter((line) => line.includes('"callId":"call_a"'))),
  )
  check(
    '落库：新 callId 落盘一条',
    onDisk.split('\n').filter((line) => line.includes('"callId":"call_new"')).length === 1,
    JSON.stringify(onDisk.split('\n').filter((line) => line.includes('"callId":"call_new"'))),
  )

  // ── 3. 请求侧清洗（sanitizeToolOrphans） ──
  const request = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    ...session.messages.filter((message) => message.role !== 'system'),
  ]
  const clean = sanitizeToolOrphans([{ role: 'system', content: 'sys' }, ...session.messages])
  check(
    '请求：同 callId 只放行首条',
    clean.filter((message) => message.tool_call_id === 'call_a').length === 1
      && clean.find((message) => message.tool_call_id === 'call_a')?.content === '合成：结果未知',
  )
  check(
    '请求：每个 tool 消息都能配上前置 tool_calls',
    (() => {
      const called = new Set()
      for (const message of clean) for (const call of message.tool_calls ?? []) called.add(call.id)
      return clean.filter((message) => message.role === 'tool').every((message) => called.has(message.tool_call_id))
    })(),
  )
  check(
    '请求：孤儿结果（没有前置调用）仍被剔除',
    !sanitizeToolOrphans([
      { role: 'user', content: 'x' },
      { role: 'tool', tool_call_id: 'ghost', content: 'orphan' },
    ]).some((message) => message.tool_call_id === 'ghost'),
  )
  check(
    '请求：未应答的 tool_calls 被剔（既有行为不回归）',
    (() => {
      const out = sanitizeToolOrphans([
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 't', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ])
      return out.length === 2 && out[0].tool_calls?.length === 1 && out[0].tool_calls[0].id === 'c1' && out[1].tool_call_id === 'c1'
    })(),
  )
  check(
    '请求：调用全无应答且正文为空 → 整条 assistant 删（既有行为不回归）',
    (() => {
      const out = sanitizeToolOrphans([
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
        { role: 'user', content: 'next' },
      ])
      return out.length === 1 && out[0].role === 'user'
    })(),
  )
  check(
    '请求：不改动传入的原数组',
    request.filter((message) => message.tool_call_id === 'call_a').length === 1
      && sanitizeToolOrphans(request) !== request,
  )
} finally {
  rmSync(work, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
