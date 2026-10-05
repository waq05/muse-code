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
 * @module dsc/core/usage-log
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageDayView, UsageModelView, UsageStatsView } from '../contract.js'
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
}

function usageFile(): string {
  return dscPath('usage', 'usage.jsonl')
}

/** 追加一条用量记录。写失败绝不打断对话轮次——统计少一条无所谓。 */
export function appendUsageRecord(record: Omit<UsageRecord, 't'>): void {
  try {
    mkdirSync(dscPath('usage'), { recursive: true })
    appendFileSync(usageFile(), `${JSON.stringify({ t: Date.now(), ...record })}\n`, 'utf8')
  } catch {
    // 磁盘满 / 目录被占用：放弃这一条，下轮再试
  }
}

/** 读全部记录。坏行跳过；文件不存在 = 还没有任何记录。 */
export function readUsageRecords(): UsageRecord[] {
  const file = usageFile()
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
