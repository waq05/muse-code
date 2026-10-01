/**
 * 轨迹页共用的一套口径：时刻、工具耗时、token 数，以及「一条步骤在时间轴上占哪一段」。
 *
 * 为什么单独成文件：时间概览条（TraceTimeline）、检查器（TraceInspector）与轮次表
 * （TraceView）都要读同一份投影。各写一份迟早会漂——尤其是「拿不到耗时就不画宽度」
 * 这条诚实规矩，三处必须给同一个答案。
 *
 * 数据缺口（这一块最容易出错的地方，全部按「缺就给 null、界面不画」处理）：
 * - 条目的 `ts` 是「这条条目最后一次写入的时刻」（工具卡拿到结果那一刻会被刷成结果时刻），
 *   工具的**发起**时刻在 `call.startedAt` 上，两者不是一回事，别拿 `ts` 当开始时间；
 * - `durationMs` 只在 done / failed / rejected 且两头时间戳都在时才有；`running` 与
 *   老会话（2026-09 之前的日志）一律没有，此时时间条**只画起点刻度、不画宽度**；
 * - 老会话连 `ts` 都没有，整条时间轴就画不出来，界面显示「未记录」而不是编一个数。
 *
 * @module desktop/renderer/trace-format
 */
import type { TranscriptEntry } from '@dsc/runtime/contract.js'
import { entryTs } from './turn-timing.js'

/**
 * 一条步骤的种类：轨迹页只认这七种（正文 text 不进轨迹，压缩落点另有区段行）。
 *
 * 后三种是轮级的：`turn-end` 只在中断 / 失败时落（正常结束不落条目，见 adapter 的
 * turn/end 分支）、`turn-max-tokens` 是这次输出撞上了长度上限、`model-retry` 是模型重试
 * （它同时是二级分组的边界，但整轮折叠仍包含它）。
 */
export type TraceStepKind =
  | 'tool' | 'thinking' | 'system' | 'plan' | 'turn-end' | 'turn-max-tokens' | 'model-retry'

/** 轨迹页会渲染的条目（去掉 user / text：前者是轮头，后者留在对话页）。 */
export type TraceStepEntry = Extract<TranscriptEntry, { kind: TraceStepKind }>

/** 轮次记录表里的一轮：一条用户消息及其后续执行步骤。 */
export interface TraceRound {
  /** 轮次序号（0 基，界面显示时 +1）。 */
  index: number
  /** 这一轮的起头用户消息；开场步骤（第一条用户消息之前）没有，是 null。 */
  user: Extract<TranscriptEntry, { kind: 'user' }> | null
  steps: TraceStepEntry[]
}

/**
 * 记录表里的一个区段：要么是一轮，要么是「已压缩历史」那条分隔行（对照 dsh 的 Between turns）。
 * 压缩落点不属于任何一轮，所以它在顺序里是独立的第三态，而不是挂在某一轮内部。
 */
export type TraceSegment =
  | { type: 'round'; round: TraceRound }
  | { type: 'compaction'; count: number; entry: TranscriptEntry }

/** 时间条上的一条标记：工具是有起点有终点的条，其余只画起点刻度。 */
export interface TraceMark {
  /** 条目 id（选择区间命中判定与 key 都用它）。 */
  id: number
  kind: TraceStepKind
  /** 显示名：工具用工具名，其余用固定词。 */
  name: string
  /** 活动起点（epoch ms）。 */
  start: number
  /** 活动终点；只有拿得到 `durationMs` 的工具才有，其余一律 null——宽度不许虚构。 */
  end: number | null
  /** 工具耗时（毫秒）；拿不到就是 null。 */
  durationMs: number | null
  /** 条目 ts（HH:mm 显示用），没有就是 null。 */
  ts: number | null
  /** 这条属于第几轮（0 基）。 */
  round: number
}

/** 轮次边界刻度：每轮的起头用户消息在时间轴上的位置。 */
export interface TraceBoundary {
  round: number
  ts: number
}

/** 拖选出来的时间区间（epoch ms，start <= end）。 */
export interface TraceRange {
  start: number
  end: number
}

export interface TraceModel {
  /** 记录表按顺序渲染的区段（轮次与压缩行交错）。 */
  segments: TraceSegment[]
  rounds: TraceRound[]
  /** 时间条要画的步骤标记（按条目顺序）。 */
  marks: TraceMark[]
  /** 时间条要画的轮次分隔刻度。 */
  boundaries: TraceBoundary[]
  /**
   * 时间轴的起止（epoch ms）：取全部标记与分隔刻度的最早起点、最晚终点。
   * 一条带时间的记录都没有（老会话）时两者都是 null，界面不画时间条。
   */
  spanStart: number | null
  spanEnd: number | null
}

/** 步骤种类的中文名（检查器标题与时间条提示用）。 */
export const KIND_LABEL: Record<TraceStepKind | 'user' | 'changes', string> = {
  tool: '工具调用',
  thinking: '思考',
  system: '系统事件',
  plan: '计划卡',
  'turn-end': '轮结束',
  'turn-max-tokens': '长度上限',
  'model-retry': '模型重试',
  user: '用户消息',
  // 对话页轮尾卡的组成数据，轨迹页不渲染它；标签留给检查器兜底（类型上仍可能碰到）
  changes: '文件已更改',
}

/**
 * 一条步骤的名字：工具用工具名（read / bash 这种，一眼认得出），其余用种类词。
 * 为什么要它：时间条的悬停提示与检查器标题都要一个短名字，各处自己拼会不一致。
 */
export function stepName(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case 'tool':
      return entry.call.name
    case 'thinking':
      return '思考'
    case 'system':
      return '系统事件'
    case 'plan':
      return '计划卡'
    case 'turn-end':
      // 轮尾标记：轨迹页里它就是这一轮的收尾记录，名字直接用「为什么结束」
      return entry.reason === 'aborted' ? '已停止' : '过程失败'
    case 'turn-max-tokens':
      return '达到长度上限'
    case 'model-retry':
      return `模型重试（第 ${String(entry.attempt)} 次）`
    case 'user':
      return '用户消息'
    default:
      return '正文'
  }
}

/**
 * 工具耗时格式化：`4.2s` / `1m03s` / `2h05m`（对照 dsh 的读数口径）。
 *
 * 为什么不足 1 秒也带一位小数：真实的工具调用常是几百毫秒，写成 `0s` 看着像坏了。
 * 拿不到（null / NaN / 负数）返回 null——界面据此不画这一项，绝不显示 0 秒。
 */
export function formatTraceDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null
  // 先四舍五入到 0.1 秒再决定用秒还是用分：59.96s 不该印成「60.0s」。
  const tenths = Math.round(ms / 100) / 10
  if (tenths < 60) return `${tenths.toFixed(1)}s`
  const total = Math.round(ms / 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${String(hours)}h${pad(minutes)}m`
  return `${String(minutes)}m${pad(seconds)}s`
}

/** 精确到秒的时刻 `HH:mm:ss`（时间条悬停提示用；行内只给 HH:mm，见 formatClock）。 */
export function formatClockSeconds(ts: number | null): string | null {
  if (ts === null || !Number.isFinite(ts) || ts <= 0) return null
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

/**
 * JSON 原文美化：能 `JSON.parse` 就缩进输出，解析不出来就原样返回。
 * 返回 `formatted` 说明这一次到底美化了没有——界面据此决定「格式化」开关是否可用
 * （半截 JSON 的模型输出很常见，那种情况按原文显示，不给一个点了没反应的开关）。
 */
export function prettyMaybeJson(text: string): { text: string; formatted: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), formatted: true }
  } catch {
    return { text, formatted: false }
  }
}

/** 条目上的用量（只有 text / tool 两种条目有）；没有就是 null。 */
export function entryUsage(
  entry: TranscriptEntry,
): { inputTokens: number; outputTokens: number } | null {
  if (entry.kind === 'text' || entry.kind === 'tool') return entry.usage ?? null
  return null
}

/** 两个时间区间有没有交集（零宽的起点刻度按一个点算）。 */
export function rangeHits(
  mark: Pick<TraceMark, 'start' | 'end'>,
  range: TraceRange,
): boolean {
  const markEnd = mark.end ?? mark.start
  return mark.start <= range.end && markEnd >= range.start
}

/**
 * 把条目表投影成「轮次 + 压缩区段 + 时间标记」。
 *
 * 三条规矩：
 * 1. 带 `compaction` 的条目（实时的 system 通知 / 重放的那条摘要 user 条目）不归任何一轮，
 *    插成独立区段行——渲染层只认这个字段，不做任何文本匹配；
 * 2. 正文 text 条目不进轨迹（看内容去对话页）；
 * 3. 工具的起点取 `call.startedAt`（拿不到才退回条目 `ts`），终点只有 `durationMs` 在时
 *    才算得出来；算不出来就不给终点，时间条据此只画起点刻度。
 */
export function buildTraceModel(entries: readonly TranscriptEntry[]): TraceModel {
  const segments: TraceSegment[] = []
  const rounds: TraceRound[] = []
  const marks: TraceMark[] = []
  const boundaries: TraceBoundary[] = []
  let current: TraceRound | null = null

  const openRound = (user: TraceRound['user']): TraceRound => {
    const round: TraceRound = { index: rounds.length, user, steps: [] }
    rounds.push(round)
    segments.push({ type: 'round', round })
    current = round
    return round
  }

  for (const entry of entries) {
    // 压缩落点优先判：重放路径上它就是那条摘要 user 条目，不判就会当场被读成一轮的开头。
    // 字段只声明在 user / system 两种条目上，所以先按 kind 收窄，再判有没有值。
    const compaction = entry.kind === 'user' || entry.kind === 'system' ? entry.compaction : undefined
    if (compaction !== undefined) {
      segments.push({ type: 'compaction', count: compaction.count, entry })
      // 压缩之后接着来的步骤不属于压缩前那一轮（模型看到的历史已经换了一份），
      // 所以这里断链：后面真有步骤就另起一个无用户的轮。
      current = null
      continue
    }
    if (entry.kind === 'user') {
      const round = openRound(entry)
      const ts = entryTs(entry)
      if (ts !== null) boundaries.push({ round: round.index, ts })
      continue
    }
    if (entry.kind === 'text') continue
    // 文件改动条目同样不进轨迹：它是对话页轮尾卡的组成数据，本身不是一步执行。
    if (entry.kind === 'changes') continue
    const round = current ?? openRound(null)
    round.steps.push(entry)
    const ts = entryTs(entry)
    if (entry.kind === 'tool') {
      const startedAt = entry.call.startedAt
      const durationMs = entry.call.durationMs
      const start = startedAt ?? ts
      if (start === null) continue
      // 终点只在「有发起时刻 + 有耗时」时才算，两者缺一就是 null。
      const end = startedAt !== undefined && durationMs !== undefined ? startedAt + durationMs : null
      marks.push({
        id: entry.id,
        kind: 'tool',
        name: entry.call.name,
        start,
        end,
        durationMs: durationMs ?? null,
        ts,
        round: round.index,
      })
      continue
    }
    if (ts === null) continue
    marks.push({
      id: entry.id,
      kind: entry.kind,
      name: stepName(entry),
      start: ts,
      end: null,
      durationMs: null,
      ts,
      round: round.index,
    })
  }

  let spanStart: number | null = null
  let spanEnd: number | null = null
  const stretch = (ts: number): void => {
    if (spanStart === null || ts < spanStart) spanStart = ts
    if (spanEnd === null || ts > spanEnd) spanEnd = ts
  }
  for (const mark of marks) {
    stretch(mark.start)
    stretch(mark.end ?? mark.start)
  }
  for (const boundary of boundaries) stretch(boundary.ts)

  return { segments, rounds, marks, boundaries, spanStart, spanEnd }
}
