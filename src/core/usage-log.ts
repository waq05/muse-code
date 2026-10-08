/**
 * 用量日志：每次模型请求追加一条到 `~/.dsc/usage/usage.jsonl`，设置「用量统计」
 * 分区从这里聚合（热力图 / 趋势 / 模型占比 / 连续活跃天数）。
 *
 * 为什么单独一个文件而不是塞进会话 jsonl：会话日志是重放格式，行里没有 usage
 * 也没有模型名，改它就要动重放语义；而用量是跨会话的全局量，天然是自己的流。
 * agent 插件在拿到模型响应的 usage 事件时落一条（见 plugins/agent.ts），
 * 这份日志从功能上线那刻开始积累，更早的会话没有记录。
 *
 * 2026-10-03 起记录前缀缓存明细（`ch`/`cm`）：命中率是「请求前缀有没有被改写」
 * 的直接读数——系统提示词改一个字节、注入并进头部，整段历史都会按全价重读。
 *
 * 0.6.67 起这个文件是两种行的**计量流**：请求行（带 token 与这一步的墙钟读数
 * `lm`/`ft`/`d`，界面据此算输出速度与首字延迟）与工具行（`k: 'tool'`，带调用耗时）。
 * 只认请求行的聚合（本文件的 readUsageRecords、设置页、会话用量卡）不受工具行影响。
 *
 * @module dsc/core/usage-log
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionUsageView, UsageDayView, UsageModelView, UsageStatsView } from '../contract.js'
import { dscPath } from './path-policy.js'

/** usage.jsonl 里的一行。字段名压短：这文件每轮请求都要追加一行。 */
export interface UsageRecord {
  /** 请求完成时刻（毫秒）。 */
  t: number
  provider: string
  model: string
  /** 输入 / 输出 token。 */
  i: number
  o: number
  /** 输入里的前缀缓存命中 / 未命中 tokens（端点上报时才有；老记录没有这两项，按 0 计）。 */
  ch?: number
  cm?: number
  /** 发起请求的会话 uuid（队友的轮次也归到主会话名下时用它区分）。 */
  sid: string
  /**
   * 这一步的三个墙钟读数（毫秒，0.6.67 起；口径见 core/loop.ts 的 stepTiming）：
   * `lm` 发出 → 定稿、`ft` 发出 → 第一口输出、`d` 第一口输出 → 定稿。
   *
   * 后两项成对出现：没拿到第一口就只有 `lm`。界面按「整会话累计 outputs ÷ 累计 d」
   * 算输出速度（core/throughput.ts），所以缺 `d` 的老请求不占分子也不占分母。
   */
  lm?: number
  ft?: number
  d?: number
}

/**
 * 工具调用行：同一个文件的第二种行（`k: 'tool'`，0.6.67 起）。
 *
 * 为什么和请求行同一个文件：两者都是「这个会话花了多少时间/多少 token」的计量，
 * 而且界面读它只需要读一个文件；靠 `k` 与 i/o 的有无区分两种行，
 * 只认请求行的聚合（设置页的用量统计、会话用量）自然跳过工具行。
 */
export interface UsageToolRecord {
  t: number
  sid: string
  k: 'tool'
  /** 工具名。 */
  n: string
  /** 这次调用「发起 → 结果」的墙钟毫秒（含失败、被拒、被打断的调用）。 */
  ms: number
}

/** 用量日志的绝对路径（宿主写、壳进程读，两边都从这里取，绝不各拼一份）。 */
export function usageLogFile(): string {
  return dscPath('usage', 'usage.jsonl')
}

/** 追加一条用量记录。写失败绝不打断对话轮次——统计少一条无所谓。 */
export function appendUsageRecord(record: Omit<UsageRecord, 't'>): void {
  append(record)
}

/** 追加一条工具调用记录（同上：写失败不影响轮次）。 */
export function appendToolRecord(record: Omit<UsageToolRecord, 't' | 'k'>): void {
  append({ k: 'tool', ...record })
}

function append(row: Omit<UsageRecord, 't'> | Omit<UsageToolRecord, 't'>): void {
  try {
    mkdirSync(dscPath('usage'), { recursive: true })
    appendFileSync(usageLogFile(), `${JSON.stringify({ t: Date.now(), ...row })}\n`, 'utf8')
  } catch {
    // 磁盘满 / 目录被占用：放弃这一条，下轮再试
  }
}

/**
 * 读全部**请求**行。坏行跳过；文件不存在 = 还没有任何记录。
 * 工具行（`k: 'tool'`）没有 i/o，下面的校验自然把它们挡在外面——只认 token 记账的
 * 聚合（设置页用量统计、连续活跃天）因此不会被工具行改变口径。
 */
export function readUsageRecords(): UsageRecord[] {
  const file = usageLogFile()
  if (!existsSync(file)) return []
  const out: UsageRecord[] = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line === '') continue
    try {
      const row = JSON.parse(line) as Partial<UsageRecord>
      if (typeof row.t !== 'number' || typeof row.i !== 'number' || typeof row.o !== 'number') continue
      out.push({
        t: row.t,
        provider: typeof row.provider === 'string' ? row.provider : '',
        model: typeof row.model === 'string' ? row.model : '',
        i: row.i,
        o: row.o,
        ...(typeof row.ch === 'number' ? { ch: row.ch } : {}),
        ...(typeof row.cm === 'number' ? { cm: row.cm } : {}),
        sid: typeof row.sid === 'string' ? row.sid : '',
        ...(typeof row.lm === 'number' && row.lm >= 0 ? { lm: row.lm } : {}),
        ...(typeof row.ft === 'number' && row.ft >= 0 ? { ft: row.ft } : {}),
        ...(typeof row.d === 'number' && row.d >= 0 ? { d: row.d } : {}),
      })
    } catch {
      // 半截行（写盘中断）跳过
    }
  }
  return out
}

/** 本地时区的 YYYY-MM-DD（getMonth/getDate 都按本地算，热力图的「天」跟着系统走）。 */
export function localDateKey(ts: number): string {
  const date = new Date(ts)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/** 热力图最多回看多久：一年多一点，跨年也能和 GitHub 一样看到整条带子。 */
const MAX_SPAN_DAYS = 370

/**
 * 把原始记录聚合成设置页要用的统计视图。
 * days 从首条记录所在日（不足一年时）或 370 天前（更早时）到今天，逐日给全
 * （没记录的日子是零日）——热力图要连续的格子，空档由这里补齐。
 * 前缀缓存明细只统计上报了它的记录（`ch`/`cm` 缺失按 0 计），命中率因此不会被老记录拉偏。
 */
export function aggregateUsage(records: UsageRecord[]): UsageStatsView {
  const days = new Map<string, UsageDayView>()
  const models = new Map<string, UsageModelView>()
  let totalInput = 0
  let totalOutput = 0
  let totalTurns = 0
  let totalCacheHit = 0
  let totalCacheMiss = 0
  let sinceTs: number | null = null

  for (const record of records) {
    const key = localDateKey(record.t)
    let day = days.get(key)
    if (day === undefined) {
      day = { date: key, inputTokens: 0, outputTokens: 0, turns: 0, byModel: {} }
      days.set(key, day)
    }
    const tokens = record.i + record.o
    day.inputTokens += record.i
    day.outputTokens += record.o
    day.turns += 1
    const modelKey = `${record.provider}/${record.model}`
    day.byModel[modelKey] = (day.byModel[modelKey] ?? 0) + tokens
    totalInput += record.i
    totalOutput += record.o
    totalTurns += 1
    totalCacheHit += record.ch ?? 0
    totalCacheMiss += record.cm ?? 0
    if (sinceTs === null || record.t < sinceTs) sinceTs = record.t
    let model = models.get(modelKey)
    if (model === undefined) {
      model = { key: modelKey, inputTokens: 0, outputTokens: 0, turns: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
      models.set(modelKey, model)
    }
    model.inputTokens += record.i
    model.outputTokens += record.o
    model.turns += 1
    model.cacheHitTokens += record.ch ?? 0
    model.cacheMissTokens += record.cm ?? 0
  }

  // 逐日补零：起点 = max(首条记录所在日, 今天-369天)，终点 = 今天
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const filled: UsageDayView[] = []
  if (sinceTs !== null) {
    const first = new Date(sinceTs)
    first.setHours(12, 0, 0, 0)
    const earliest = new Date(today)
    earliest.setDate(earliest.getDate() - (MAX_SPAN_DAYS - 1))
    const cursor = new Date(first < earliest ? earliest : first)
    while (cursor <= today) {
      const key = localDateKey(cursor.getTime())
      filled.push(days.get(key) ?? { date: key, inputTokens: 0, outputTokens: 0, turns: 0, byModel: {} })
      cursor.setDate(cursor.getDate() + 1)
    }
  }

  // 连续活跃天数：从今天（今天没有就从昨天）往前数连续有记录的日子
  const active = new Set(days.keys())
  let currentStreak = 0
  const probe = new Date(today)
  if (!active.has(localDateKey(probe.getTime()))) probe.setDate(probe.getDate() - 1)
  while (active.has(localDateKey(probe.getTime()))) {
    currentStreak += 1
    probe.setDate(probe.getDate() - 1)
  }
  let longestStreak = 0
  let run = 0
  for (const day of filled) {
    if (day.turns > 0) {
      run += 1
      if (run > longestStreak) longestStreak = run
    } else {
      run = 0
    }
  }

  let peakDay: UsageDayView | null = null
  for (const day of days.values()) {
    const tokens = day.inputTokens + day.outputTokens
    const peakTokens = peakDay === null ? -1 : peakDay.inputTokens + peakDay.outputTokens
    if (tokens > peakTokens) peakDay = day
  }

  return {
    sinceTs,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheHitTokens: totalCacheHit,
    totalCacheMissTokens: totalCacheMiss,
    totalTurns,
    activeDays: active.size,
    currentStreakDays: currentStreak,
    longestStreakDays: longestStreak,
    peakDay,
    days: filled,
    models: [...models.values()].sort(
      (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    ),
  }
}

/** 读 + 聚合一步到位（runtime 的 usageStats() 用）。 */
export function buildUsageStats(): UsageStatsView {
  return aggregateUsage(readUsageRecords())
}

/** 日志里一行的原始形状（还没校验过的 JSON）。字段名见 {@link UsageRecord} / {@link UsageToolRecord}。 */
interface RawUsageRow {
  t?: unknown
  sid?: unknown
  i?: unknown
  o?: unknown
  ch?: unknown
  cm?: unknown
  lm?: unknown
  ft?: unknown
  d?: unknown
  k?: unknown
  ms?: unknown
}

/** 非负有限数才算真值（缺项、负数、NaN 一律当没上报）。 */
function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 按会话 id 折叠这份日志（纯函数：喂文本，出视图）——壳进程与测试都用它，口径只此一份。
 *
 * 两种行各算各的：
 * - 请求行（有 i/o）进请求数、输入/输出 token 与缓存明细；墙钟三项按「首字延迟与解码期
 *   成对」的规则累计——只有拿到第一口（`ft`）的请求才能再进 `d` 与那批 token，
 *   0.6.67 之前的老行两个都没有，于是既不进分子也不进分母（宁缺不假）；
 * - 工具行（`k: 'tool'`）只进工具耗时与次数，不碰任何 token 口径。
 *
 * 这个会话一行都没有时返回 null（界面据此整段省略，不显示一个全 0 的账）。
 */
export function foldSessionUsage(text: string, sessionId: string): SessionUsageView | null {
  if (sessionId === '') return null
  const view: SessionUsageView = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    lastInputTokens: 0,
    lastAt: 0,
    llmMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    toolMs: 0,
    toolCalls: 0,
  }
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue
    let row: RawUsageRow
    try {
      row = JSON.parse(line) as RawUsageRow
    } catch {
      continue // 半截行（写盘中断）跳过
    }
    if (row.sid !== sessionId) continue
    // 工具行：只有耗时，没有 token
    if (row.k === 'tool') {
      const ms = readNumber(row.ms)
      if (ms === null) continue
      view.toolMs += ms
      view.toolCalls += 1
      continue
    }
    const input = readNumber(row.i)
    const output = readNumber(row.o)
    if (input === null || output === null) continue
    view.requests += 1
    view.inputTokens += input
    view.outputTokens += output
    // 缓存两栏成对上报才算数（写入端一次写两个键）：缺一个的行不进分母，不然命中率会被算低
    const cacheHit = readNumber(row.ch)
    const cacheMiss = readNumber(row.cm)
    if (cacheHit !== null && cacheMiss !== null) {
      view.cacheHitTokens += cacheHit
      view.cacheMissTokens += cacheMiss
    }
    const llm = readNumber(row.lm)
    if (llm !== null) view.llmMs += llm
    const ttft = readNumber(row.ft)
    if (ttft !== null) {
      view.ttftMs += ttft
      view.ttftSteps += 1
      // 解码期是「第一口输出 → 定稿」，没有第一口就没有解码期；有解码期才带上输出 token
      const decode = readNumber(row.d)
      if (decode !== null) {
        view.decodeMs += decode
        view.decodeTokens += output
      }
    }
    // 「最后一次」按时间戳取，不靠文件顺序：追加写不保证同一毫秒里的先后
    const at = readNumber(row.t) ?? 0
    if (at >= view.lastAt) {
      view.lastAt = at
      view.lastInputTokens = input
    }
  }
  return view.requests === 0 && view.toolCalls === 0 ? null : view
}

/**
 * 读 + 折叠当前会话的用量（壳进程的 `dsc:session-usage` IPC 与测试用）。
 * 文件不存在、读不了、这个会话一行都没有：一律 null——界面据此整段省略。
 */
export function readSessionUsage(sessionId: string): SessionUsageView | null {
  if (sessionId === '') return null
  let text: string
  try {
    text = readFileSync(usageLogFile(), 'utf8')
  } catch {
    // 还没生成 / 正被别的进程占着：这一拍给不出统计
    return null
  }
  return foldSessionUsage(text, sessionId)
}
