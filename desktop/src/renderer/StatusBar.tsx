/**
 * 底部状态栏：对照 dsh 的三段式——轮次/步数与输出速度 · 累计用量 · 上下文占用。
 * 三段都能悬浮（或键盘聚焦）弹出详情卡：容器长相、圆角、遮罩阴影、出现动画
 * 共用 `.ctx-card` 那一套，只有卡片内容各写各的。
 *
 * 数据来源分三层，拿不到的那一段就整段不画，卡里拿不到的项就整行省略，不编数：
 *   1. 轮次与步数：直接在快照条目上数（user 条目 = 一轮，tool 条目 = 一步）；
 *   2. 输出速度、首字延迟与两项耗时：壳进程读宿主的 `~/.dsc/usage/usage.jsonl`
 *      （只读）后按会话 id 汇总——速度是**整会话累计**的纯解码吞吐，口径见
 *      core/throughput.ts（宿主快照里只有累计 token、没有任何时间戳，量不出这个数）；
 *      会话时钟仍旧在界面侧观察（会话开始/最近活动是快照变化的时刻，不是会话文件的时间）；
 *   3. 累计用量与上下文占用：同一份日志汇总里取，经 `dsc.sessionUsage(sessionId)` 拿到。
 *
 * 第二段卡的缓存三行来自用量日志的 ch/cm 两栏（core/llm.ts 0.6.46 起解析服务端回的
 * 缓存命中字段并落库）：只有真上报过的请求进分母，老行不进——宁缺不假。
 *
 * @module desktop/renderer/StatusBar
 */
import { useEffect, useState, type JSX } from 'react'
import type { StatusView, TokenUsageView, TranscriptEntry } from '@dsc/runtime/contract.js'
import { dsc, type SessionUsageView } from './bridge.js'
import { IconActivity, IconDatabase } from './icons.js'
import {
  averageTtftMs,
  estimateTextTokens,
  formatCacheHitPercent,
  formatExactTokens,
  formatTokens,
  formatTokensPerSecond,
  tokensPerSecond,
} from './token-estimate.js'
import { formatTraceDuration } from './trace-format.js'

const TURN_TEXT: Record<StatusView['turnState'], string> = {
  idle: '空闲',
  thinking: '思考中',
  working: '执行中',
  'awaiting-approval': '等待审批',
}

export function StatusBar(props: {
  status: StatusView
  /** 消息流条目（数轮次、步数，以及给上下文卡估算对话消息那一段）。 */
  entries: readonly TranscriptEntry[]
  /** 当前模型的上下文窗口；匹配不到时 null，第三段整个不画。 */
  contextWindow: number | null
}): JSX.Element {
  const { status } = props
  const turns = props.entries.filter((entry) => entry.kind === 'user').length
  const steps = props.entries.filter((entry) => entry.kind === 'tool').length

  // 累计用量优先读用量日志（含切到本进程之前的历史请求）；日志里还没有这个会话时，
  // 退回快照里的会话累计（只算本进程开着的这段时间）。两个都是真值，只是口径不同。
  const snapshotTotal = status.usage === null ? 0 : status.usage.inputTokens + status.usage.outputTokens
  // 日志读下来那一刻重读一次：快照的累计用量一变，就说明有一次请求定稿了，
  // 它刚落进日志——速度与首字延迟因此在一轮中途也能跟着更新
  const logged = useSessionUsage(status.sessionId, status.turnState, snapshotTotal)
  // 输出速度 = 本会话已定稿请求的输出 token ÷ 纯解码时间（口径见 core/throughput.ts，与 dsh 同）：
  // 日志里还没有这条会话、或老行没记解码期，就整段省略（不拿快照增量估一个数顶上去）
  const speed = logged === null ? null : tokensPerSecond(logged)
  const clock = useSessionClock(
    status.sessionId,
    activityKey(props.entries, status),
    sessionHasContent(props.entries, status),
  )

  const total = logged === null ? snapshotTotal : logged.inputTokens + logged.outputTokens

  // 上下文占用 = 最后一次请求的输入 token（每次请求重发完整上下文，服务端真值）
  const context =
    logged === null || props.contextWindow === null || props.contextWindow <= 0
      ? null
      : { used: logged.lastInputTokens, window: props.contextWindow }

  return (
    <div className="statusbar">
      <div className="segments">
        {/* 第一段：轮次/步数/速度，悬浮出进度卡。会话 id 与当前模型收在这一段的
            悬浮提示里：宿主开场会往消息流写一条「会话 x · 模型 y」的灰字，
            那条已经从消息流里去掉（见 session-marker.ts），信息不丢——鼠标挪到
            这一段上就能看到（卡片里另给会话开始与最近活动）。 */}
        <span className="segment seg-turn seg-hover">
          <button
            type="button"
            className="ctx-trigger"
            title={`当前状态：${TURN_TEXT[status.turnState]}${
              status.sessionId === null ? '' : ` · 会话 ${status.sessionId.slice(0, 8)}`
            } · 模型 ${status.model}；点开看轮次、步骤、速度与时间`}
          >
            <span className={`seg-icon state-${status.turnState}`}>
              <IconActivity size={12} />
            </span>
            {turns} 轮 {steps} 步
            {/* 速度是整会话累计量出来的：日志里还没样本（这一步还没定稿）就整段省略 */}
            {speed !== null && (
              <span className="seg-dim"> · {formatTokensPerSecond(speed)} tok/s</span>
            )}
          </button>
          <TurnCard turns={turns} steps={steps} speed={speed} logged={logged} clock={clock} />
        </span>

        {total > 0 && (
          <span className="segment seg-tokens seg-hover">
            <button type="button" className="ctx-trigger" title="这个会话的累计 token；点开看请求数与输入/输出明细">
              <span className="seg-icon">
                <IconDatabase size={12} />
              </span>
              {formatTokens(total)} tok
            </button>
            <TokenCard total={total} logged={logged} snapshot={status.usage} />
          </span>
        )}

        {context !== null && (
          <ContextSegment
            used={context.used}
            total={context.window}
            messageTokens={estimateEntriesTokens(props.entries)}
          />
        )}
      </div>
    </div>
  )
}

/** 悬浮卡里的一行「标签 …… 值」：标签靠左、值右对齐成一列（对照 dsh 的底部信息卡）。 */
function CardRow(props: { label: string; value: string }): JSX.Element {
  return (
    <div className="ctx-row">
      <span className="ctx-label">{props.label}</span>
      <span className="ctx-value">{props.value}</span>
    </div>
  )
}

/**
 * 第一段的详情卡：轮次、步数、输出速度、首字延迟、两项耗时与会话时间。
 *
 * 速度、首字延迟、LLM 耗时、工具耗时来自 `dsc.sessionUsage`（宿主用量日志的真值，
 * 整个会话累计，随每次请求落盘）；日志里还没这几项时整行省略。
 * 时间来自 {@link useSessionClock}（界面侧观察值），拿不到也整行省略。
 */
function TurnCard(props: {
  turns: number
  steps: number
  speed: number | null
  logged: SessionUsageView | null
  clock: SessionClock | null
}): JSX.Element {
  const startedAt = props.clock?.startedAt ?? null
  const lastActiveAt = props.clock?.lastActiveAt ?? null
  const logged = props.logged
  // 首字延迟报的是平均（累计 ÷ 样本数）：单看累计毫秒没有可比性，请求一多就只见涨
  const ttft = logged === null ? null : averageTtftMs(logged)
  const ttftText = ttft === null ? null : formatTraceDuration(ttft)
  const ttftSteps = logged?.ttftSteps ?? 0
  const toolCalls = logged?.toolCalls ?? 0
  const llmText = logged === null || logged.llmMs <= 0 ? null : formatTraceDuration(logged.llmMs)
  const toolText = logged === null || toolCalls === 0 ? null : formatTraceDuration(logged.toolMs)
  return (
    <div className="ctx-card" role="note">
      <div className="ctx-head">
        <span className="ctx-title">会话进度</span>
        <span className="ctx-numbers">
          {props.turns} 轮 · {props.steps} 步
        </span>
      </div>
      <div className="ctx-rule" />
      <div className="ctx-rows">
        <CardRow label="用户轮数" value={`${props.turns} 轮`} />
        <CardRow label="工具调用" value={`${props.steps} 步`} />
        {/* 速度是纯解码吞吐（首字等待与工具执行都不在分母里），所以不带 ~ */}
        {props.speed !== null && (
          <CardRow label="输出速度" value={`${formatTokensPerSecond(props.speed)} tok/s`} />
        )}
        {ttftText !== null && (
          <CardRow label="首字延迟" value={`${ttftText}（平均 ${String(ttftSteps)} 次）`} />
        )}
        {llmText !== null && <CardRow label="LLM 耗时" value={llmText} />}
        {toolText !== null && (
          <CardRow label="工具耗时" value={`${toolText} · ${String(toolCalls)} 次`} />
        )}
        {startedAt !== null && <CardRow label="会话开始" value={clockText(startedAt)} />}
        {lastActiveAt !== null && (
          <CardRow label="最近活动" value={`${clockText(lastActiveAt)}（${agoText(lastActiveAt)}）`} />
        )}
      </div>
    </div>
  )
}

/**
 * 第二段的详情卡：请求数、前缀缓存命中与两支输入、输出、最近一次请求时间
 * （对照 dsh 的「Token 用量」卡，另留 dsc 自己的请求数与最近请求两行）。
 *
 * 全部字段来自 `dsc.sessionUsage`（宿主用量日志的真值）；日志里还没有这条会话时
 * 只有快照口径的输入/输出两项，请求数与最近请求整行省略。
 * 缓存那三行只在日志真上报过缓存明细时出现（0.6.46 起），否则退回单行「输入 token」。
 */
function TokenCard(props: {
  total: number
  logged: SessionUsageView | null
  snapshot: TokenUsageView | null
}): JSX.Element {
  const logged = props.logged
  const input = logged?.inputTokens ?? props.snapshot?.inputTokens ?? null
  const output = logged?.outputTokens ?? props.snapshot?.outputTokens ?? null
  const requests = logged?.requests ?? null
  const lastAt = logged !== null && logged.lastAt > 0 ? logged.lastAt : null
  // 命中率的分母只算上报过缓存明细的请求（老日志没有 ch/cm）
  const cachePrompt = logged === null ? 0 : logged.cacheHitTokens + logged.cacheMissTokens
  const cacheHit = logged !== null && cachePrompt > 0
    ? formatCacheHitPercent(logged.cacheHitTokens, cachePrompt)
    : null
  return (
    <div className="ctx-card" role="note">
      <div className="ctx-head">
        <span className="ctx-title">会话用量</span>
        <span className="ctx-numbers">{formatExactTokens(props.total)} tok</span>
      </div>
      <div className="ctx-rule" />
      <div className="ctx-rows">
        {requests !== null && <CardRow label="模型请求" value={`${String(requests)} 次`} />}
        {cacheHit !== null && <CardRow label="缓存命中" value={`${cacheHit}%`} />}
        {cacheHit !== null && logged !== null
          && <CardRow label="未缓存输入" value={formatExactTokens(logged.cacheMissTokens)} />}
        {cacheHit !== null && logged !== null
          && <CardRow label="缓存读取" value={formatExactTokens(logged.cacheHitTokens)} />}
        {cacheHit === null && input !== null && <CardRow label="输入 token" value={formatExactTokens(input)} />}
        {output !== null && <CardRow label="输出" value={formatExactTokens(output)} />}
        {lastAt !== null && <CardRow label="最近请求" value={`${clockText(lastAt)}（${agoText(lastAt)}）`} />}
      </div>
    </div>
  )
}

/** 第三段：圆环 + 百分比，悬浮（或键盘聚焦）出上下文详情卡。 */
function ContextSegment(props: { used: number; total: number; messageTokens: number }): JSX.Element {
  const ratio = props.used / props.total
  const percent = Math.round(ratio * 100)
  // 确实超过窗口时不假装还在 100% 以内：数字照实显示，进度条与圆环按 100% 画满
  const shown = Math.min(Math.max(percent, 0), 100)
  return (
    <span className="segment seg-context seg-hover">
      <button type="button" className="ctx-trigger" aria-label={`上下文已用 ${String(percent)}%`}>
        <ContextRing percent={shown} />
        {percent}%
      </button>
      <ContextCard {...props} percent={percent} />
    </span>
  )
}

/** 上下文悬浮卡：进度条 + 构成分解（对照 dsh 的「上下文已用」卡）。 */
function ContextCard(props: {
  used: number
  total: number
  percent: number
  messageTokens: number
}): JSX.Element {
  // 分解只在两个数都讲得通时才画：消息估算得大于 0，而且不能超过真实输入
  // （超过了说明估算跑偏，这时宁可只画整条进度条，也不摆一行自相矛盾的账）
  const split = props.messageTokens > 0 && props.messageTokens < props.used
  const messages = split ? props.messageTokens : 0
  const base = props.used - messages
  const widthOf = (tokens: number): string =>
    `${(Math.min(tokens, props.total) / props.total * 100).toFixed(2)}%`
  return (
    <div className="ctx-card" role="note">
      <div className="ctx-head">
        <span className="ctx-title">上下文已用 {props.percent}%</span>
        <span className="ctx-numbers">
          ~{formatTokens(props.used)} / {formatTokens(props.total)}
        </span>
      </div>
      <div className="ctx-bar">
        <span className="ctx-bar-fill" style={{ width: widthOf(split ? messages : props.used) }} />
        {split && <span className="ctx-bar-base" style={{ width: widthOf(base) }} />}
      </div>
      {split && (
        <div className="ctx-legend">
          <div className="ctx-legend-row">
            <i className="ctx-dot ctx-dot-messages" />
            <span className="ctx-legend-label">对话消息</span>
            <span className="ctx-legend-value">~{formatTokens(messages)}</span>
          </div>
          <div className="ctx-legend-row">
            <i className="ctx-dot ctx-dot-base" />
            <span className="ctx-legend-label">系统提示词 + 工具定义</span>
            <span className="ctx-legend-value">~{formatTokens(base)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

/** 段3 的圆环图标：按占用百分比填充的一圈（对照 dsh 的圆环进度图标）。 */
function ContextRing({ percent }: { percent: number }): JSX.Element {
  const radius = 5.2
  const circumference = 2 * Math.PI * radius
  const filled = (circumference * percent) / 100
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r={radius} stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.8" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeDasharray={`${filled.toFixed(2)} ${circumference.toFixed(2)}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

/**
 * 会话累计用量与各项耗时：切会话时取一次，之后每轮跑完（忙转闲）与每次请求定稿
 * （快照累计 token 一变）再取一次——日志里会变的就是这些时刻。
 *
 * @param settledTokens - 快照口径的本会话累计 token；它一变就说明有一次请求刚落进日志。
 */
function useSessionUsage(
  sessionId: string | null,
  turnState: StatusView['turnState'],
  settledTokens: number,
): SessionUsageView | null {
  // 连会话 id 一起存：切会话那一刻旧数字必须立刻作废，不能把上一条会话的账挂在新的底下
  const [bag, setBag] = useState<{ id: string; view: SessionUsageView | null } | null>(null)
  const busy = turnState !== 'idle'
  useEffect(() => {
    if (sessionId === null) {
      setBag(null)
      return
    }
    let alive = true
    dsc
      .sessionUsage(sessionId)
      .then((view) => {
        if (alive) setBag({ id: sessionId, view })
      })
      .catch(() => {
        // 用量日志读不了（还没生成 / 被占用）不是错误：这一段自然省略
        if (alive) setBag({ id: sessionId, view: null })
      })
    return () => {
      alive = false
    }
  }, [sessionId, busy, settledTokens])
  return bag !== null && bag.id === sessionId ? bag.view : null
}

/** 界面侧观察到的会话时钟（宿主快照不带时间戳，这两个时刻只能自己记）。 */
interface SessionClock {
  sessionId: string
  /** 本进程内第一次看到这条会话有内容的时刻；一直没内容就是 null。 */
  startedAt: number | null
  /** 最近一次看到快照变化的时刻。 */
  lastActiveAt: number
}

/**
 * 快照变化的指纹：条目数、回合状态、累计 token 三者任一变了就算「有活动」。
 *
 * 为什么不用时间戳：快照里根本没有时间，能被观察到的只有「什么时候变了」。
 */
function activityKey(entries: readonly TranscriptEntry[], status: StatusView): string {
  return [
    entries.length,
    status.turnState,
    status.usage?.inputTokens ?? 0,
    status.usage?.outputTokens ?? 0,
  ].join(':')
}

/**
 * 会话时钟：切会话时重置，之后每有一次快照变化就把「最近活动」推到当下，
 * 并在第一次看到内容时定下「会话开始」。
 *
 * 存 id 一起是必要的：切会话那一刻旧时钟必须立刻作废，不能把上一条会话的
 * 开始时间挂到新会话底下（与 useSessionUsage 同一个理由）。
 */
function useSessionClock(sessionId: string | null, activity: string, content: boolean): SessionClock | null {
  const [clock, setClock] = useState<SessionClock | null>(null)
  useEffect(() => {
    if (sessionId === null) {
      setClock(null)
      return
    }
    const now = Date.now()
    setClock((current) =>
      current === null || current.sessionId !== sessionId
        ? { sessionId, startedAt: content ? now : null, lastActiveAt: now }
        : { ...current, startedAt: current.startedAt ?? (content ? now : null), lastActiveAt: now },
    )
  }, [sessionId, activity, content])
  return clock !== null && clock.sessionId === sessionId ? clock : null
}

/**
 * 这条会话是不是已经有真实内容：system 灰条只是宿主发给界面的通知（新建的
 * 空会话也有），所以它不算内容；累计 token 动了也算有内容。
 */
function sessionHasContent(entries: readonly TranscriptEntry[], status: StatusView): boolean {
  if (status.usage !== null && status.usage.inputTokens + status.usage.outputTokens > 0) return true
  return entries.some((entry) => entry.kind !== 'system')
}

/** 时刻写成 24 小时制的 HH:MM。 */
function clockText(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 相对时间：只到分钟与天，够读就行，不引第三方日期库。 */
function agoText(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  return `${String(Math.floor(hours / 24))} 天前`
}

/**
 * 把快照条目估成一个 token 数（上下文卡里「对话消息」那一行）。
 *
 * 口径与宿主 core/compact.ts 一致；思考过程要算进去——宿主重放 assistant 消息时
 * 会把 reasoning_content 一起回传（见 core/llm.ts），它是真实占用的一部分。
 * 图像按每张 1000 token 估（同 core/compact.ts）。两类条目不算：
 * system 灰条只是宿主发给界面的通知（不进请求体），计划卡是界面结构。
 */
function estimateEntriesTokens(entries: readonly TranscriptEntry[]): number {
  let total = 0
  for (const entry of entries) {
    switch (entry.kind) {
      case 'user':
        total += estimateTextTokens(entry.text) + (entry.images?.length ?? 0) * 1_000
        break
      case 'text':
      case 'thinking':
        total += estimateTextTokens(entry.text)
        break
      case 'tool':
        total += estimateTextTokens(entry.call.argsText + (entry.call.resultText ?? ''))
        break
      default:
        break
    }
  }
  return total
}
