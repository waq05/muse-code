/**
 * 回合基线聚合（Session.recordTurnChange / takeTurnChanges）直测。
 *
 * 覆盖：同文件两刀 → 聚合 diff = 「回合起点 vs 盘上终态」一份准确差异（不是两刀拼盘）；
 * 新建文件 status=added；改了又改回去（终态=基线）不出条目；基线清理与重复记录幂等。
 *
 * 运行：pnpm build && node scripts/turn-changes-test.mjs
 *
 * @module dsc/scripts/turn-changes-test
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../lib/core/session.js'
import { writeTool, editTool } from '../lib/core/tools/fs-tools.js'

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsc-turn-changes-'))
const session = Session.create(dir)
const ctx = { cwd: dir, signal: new AbortController().signal }

try {
  // ── 同文件两刀：write 新建 + edit 再改 → 聚合 = 基线（不存在） vs 终态 ──
  const target = join(dir, 'a.ts')
  const first = await writeTool.run({ path: 'a.ts', content: 'line1\nline2\nline3\n' }, ctx)
  session.appendTool('c1', 'write', first, undefined)
  if (first.changes !== undefined) session.recordTurnChange(first.changes.path, first.changes.baseline ?? '')
  const second = await editTool.run({ path: 'a.ts', old: 'line2', new: 'line-two\nline2.5' }, ctx)
  session.appendTool('c2', 'edit', second, undefined)
  if (second.changes !== undefined) session.recordTurnChange(second.changes.path, second.changes.baseline ?? '')

  const files = await session.takeTurnChanges()
  check('同文件两刀聚合只出一条', files.length === 1, JSON.stringify(files.map((f) => f.path)))
  const file = files[0]
  // 基线 = 文件不存在（空串），终态 = line1/line-two/line2.5/line3：聚合 diff 是整篇新增
  check('聚合 diff 是「起点 vs 终态」：新建文件呈全加', file !== undefined && file.added === 4 && file.removed === 0, file === undefined ? '' : JSON.stringify({ added: file.added, removed: file.removed }))
  check('新建文件 status=added', file?.status === 'added')
  check('产物不带 baseline 内存字段', file !== undefined && !Object.hasOwn(file, 'baseline'))
  check(
    '聚合 hunks 含两刀的内容（line2 换成两行 + line2.5）',
    file !== undefined
      && file.hunks.some((hunk) => hunk.lines.some((line) => line.text === 'line2.5')),
    JSON.stringify(file?.hunks),
  )

  // ── 取完即清：再取一次是空的 ──
  const again = await session.takeTurnChanges()
  check('takeTurnChanges 取完基线即清，再取为空', again.length === 0)

  // ── 改了又改回去：终态 = 基线 → 不出条目 ──
  // 工具改走 a.ts（基线记下「当时的盘上内容」），然后手动把盘上恢复成基线原文：
  const touched = await writeTool.run({ path: 'a.ts', content: 'x\n' }, ctx)
  if (touched.changes !== undefined) session.recordTurnChange(touched.changes.path, touched.changes.baseline ?? '')
  // 基线就是上一段测试的终态：line1/line-two/line2.5/line3
  writeFileSync(target, 'line1\nline-two\nline2.5\nline3\n', 'utf8')
  const none = await session.takeTurnChanges()
  check('改了又改回去（终态=基线）聚合为空', none.length === 0, JSON.stringify(none))

  // ── 重复记录幂等：第二次 recordTurnChange 不覆盖基线 ──
  writeFileSync(target, 'x\n', 'utf8')
  const first_ = await editTool.run({ path: 'a.ts', old: 'x', new: 'xx' }, ctx)
  if (first_.changes !== undefined) session.recordTurnChange(first_.changes.path, first_.changes.baseline ?? '')
  const second_ = await editTool.run({ path: 'a.ts', old: 'xx', new: 'xxx' }, ctx)
  if (second_.changes !== undefined) session.recordTurnChange(second_.changes.path, second_.changes.baseline ?? '')
  const merged = await session.takeTurnChanges()
  check(
    '两刀幂等记基线：聚合 = 最初基线(x) vs 终态(xxx)',
    merged.length === 1 && merged[0].added === 1 && merged[0].removed === 1,
    JSON.stringify(merged.map((f) => ({ added: f.added, removed: f.removed }))),
  )

  // ── close() 清基线 ──
  const w = await writeTool.run({ path: 'a.ts', content: 'z\n' }, ctx)
  if (w.changes !== undefined) session.recordTurnChange(w.changes.path, w.changes.baseline ?? '')
  session.close()
  const afterClose = await session.takeTurnChanges()
  check('close() 清空回合基线', afterClose.length === 0)

  // ── 落盘 jsonl 不带 baseline ──
  const session2 = Session.create(dir)
  const w2 = await writeTool.run({ path: 'b.ts', content: 'hi\n' }, ctx)
  session2.appendTool('c9', 'write', w2, undefined)
  session2.close()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const raw = readFileSync(session2.filePath, 'utf8')
  check('jsonl 的 tool 记录不带 baseline', !raw.includes('baseline'), raw.slice(0, 400))

  // ── MiniAgent 整轮集成：假 stream 吐两个写调用（同文件两刀）→ 收尾聚合 emit ──
  const { MiniAgent } = await import('../lib/core/loop.js')
  const session3 = Session.create(dir)
  const events = []
  let modelCalls = 0
  const agent = new MiniAgent(
    {
      route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
      systemPrompt: () => '',
      tools: () => [writeTool, editTool],
      guards: {
        gate: async () => ({ action: 'pass' }),
        observe: (_name, text) => text,
      },
      emit: (event) => events.push(event),
      stream: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            text: '',
            reasoning: '',
            toolCalls: [
              { id: 't1', name: 'write', arguments: JSON.stringify({ path: 'loop.txt', content: 'one\n' }) },
              { id: 't2', name: 'edit', arguments: JSON.stringify({ path: 'loop.txt', old: 'one', new: 'uno' }) },
            ],
            usage: null,
            finishReason: 'tool_calls',
          }
        }
        return { text: 'done', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
      },
    },
    session3,
  )
  agent.followup('改文件')
  while (agent.isRunning) await new Promise((resolve) => setTimeout(resolve, 20))
  const turnDiffEvents = events.filter((event) => event.type === 'turn/diff')
  check('整轮跑完发一次 turn/diff', turnDiffEvents.length === 1, JSON.stringify(turnDiffEvents))
  const loopFile = turnDiffEvents[0]?.files[0]
  check(
    '聚合事件：loop.txt 两刀合一、全加、status=added、不带 baseline',
    loopFile !== undefined
      && loopFile.path.endsWith('loop.txt')
      && loopFile.added === 1
      && loopFile.removed === 0
      && loopFile.status === 'added'
      && !Object.hasOwn(loopFile, 'baseline'),
    JSON.stringify(turnDiffEvents[0]?.files),
  )
  check(
    'turn/diff 在 turn/end 之后到达（归轮口径依赖它）',
    events.findIndex((event) => event.type === 'turn/end') < events.findIndex((event) => event.type === 'turn/diff'),
    JSON.stringify(events.map((event) => event.type)),
  )
  const aggregateEntry = [...events]
    .reverse()
    .find((event) => event.type === 'tool/changes' && event.change.path.endsWith('loop.txt'))
  check(
    '逐刀 tool/changes 事件照发（过程卡数据），且不带 baseline',
    aggregateEntry !== undefined && !Object.hasOwn(aggregateEntry.change, 'baseline'),
    JSON.stringify(events.filter((event) => event.type === 'tool/changes')),
  )
  session3.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
