/**
 * 底部状态栏：对照 dsh 的三段式——轮次/步数与输出速度 · 累计用量 · 上下文占用。
 *
 * 数据来源分三层，拿不到的那一段就整段不画，不编数：
 *   1. 轮次与步数：直接在快照条目上数（user 条目 = 一轮，tool 条目 = 一步）；
 *   2. 输出速度：宿主只给累计 token、不给计时，所以由这里按「快照到达时刻」
 *      自己量这一轮的增量；
 *   3. 累计用量与上下文占用：壳进程读宿主的 `~/.dsc/usage/usage.jsonl`（只读）
 *      后按会话 id 汇总，经 `dsc.sessionUsage(sessionId)` 拿到。
 *
 * 缓存命中率宿主根本没记（core/llm.ts 只留 prompt_tokens / completion_tokens，
 * 把服务端回的缓存命中字段丢了），所以第二段不显示缓存命中——宁缺不假。
 *
 * @module desktop/renderer/StatusBar
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import type { StatusView, TranscriptEntry } from '@dsc/runtime/contract.js'
import { dsc, type SessionUsageView } from './bridge.js'
import { IconActivity, IconDatabase } from './icons.js'
import { estimateTextTokens, formatTokens } from './token-estimate.js'

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
  const outputTokens = status.usage?.outputTokens ?? 0
  const speed = useOutputSpeed(outputTokens, status.turnState)
  const logged = useSessionUsage(status.sessionId, status.turnState)

  // 累计用量优先读用量日志（含切到本进程之前的历史请求）；日志里还没有这个会话时，
  // 退回快照里的会话累计（只算本进程开着的这段时间）。两个都是真值，只是口径不同。
  const snapshotTotal = status.usage === null ? 0 : status.usage.inputTokens + status.usage.outputTokens
  const total = logged === null ? snapshotTotal : logged.inputTokens + logged.outputTokens

  // 上下文占用 = 最后一次请求的输入 token（每次请求重发完整上下文，服务端真值）
  const context =
    logged === null || props.contextWindow === null || props.contextWindow <= 0
      ? null
      : { used: logged.lastInputTokens, window: props.contextWindow }

  return (
    <div className="statusbar">
      <div className="segments">
        {/* 会话 id 与当前模型收在这一段的悬浮提示里：宿主开场会往消息流写一条
            「会话 x · 模型 y」的灰字，那条已经从消息流里去掉（见 session-marker.ts），
            信息不丢——鼠标挪到这一段上就能看到。提示挂在整段而不是那枚 12px 图标上，
            免得只有戳中图标才出得来。 */}
        <span
          className="segment"
          title={`当前状态：${TURN_TEXT[status.turnState]}${
            status.sessionId === null ? '' : ` · 会话 ${status.sessionId.slice(0, 8)}`
          } · 模型 ${status.model}`}
        >
          <span className={`seg-icon state-${status.turnState}`}>
            <IconActivity size={12} />
          </span>
          {turns} 轮 {steps} 步
          {/* 速度是量出来的：还没量到（这一轮刚开口）就整段省略 */}
          {speed !== null && <span className="seg-dim"> · {String(Math.round(speed))} tok/s</span>}
        </span>

        {total > 0 && (
          <span className="segment">
            <span className="seg-icon">
              <IconDatabase size={12} />
            </span>
            {formatTokens(total)} tok
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

/** 第三段：圆环 + 百分比，悬浮（或键盘聚焦）出上下文详情卡。 */
function ContextSegment(props: { used: number; total: number; messageTokens: number }): JSX.Element {
  const ratio = props.used / props.total
  const percent = Math.round(ratio * 100)
  // 确实超过窗口时不假装还在 100% 以内：数字照实显示，进度条与圆环按 100% 画满
  const shown = Math.min(Math.max(percent, 0), 100)
  return (
    <span className="segment seg-context">
      <button type="button" className="ctx-trigger" aria-label={`上下文已用 ${String(percent)}%`}>
        <ContextRing percent={shown} />
        {percent}%
      </button>
      <ContextCard {...props} percent={percent} shown={shown} />
    </span>
  )
}

/** 上下文悬浮卡：进度条 + 构成分解（对照 dsh 的「上下文已用」卡）。 */
function ContextCard(props: {
  used: number
  total: number
  percent: number
  shown: number
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
      <div className="ctx-note">
        在窗口里占 {props.shown}%
        {split
          ? '；对话消息按正文字符估算（工具结果按 1500 字符截断后计），系统提示词与工具定义由「本次输入 − 消息估算」推得，宿主没有分项上报。'
          : `；宿主未提供上下文构成分解，这里只报总占用。`}
      </div>
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
 * 输出速度（token/秒）：宿主快照里只有累计 token，没有时间戳。
 *
 * 所以由本组件自己量：忙起来记下第一个锚点（当时累计输出 + 到达时刻），之后每张
 * 快照按增量除以真实流逝时间。锚点放 ref 里不触发渲染，只有算出来的速率进 state；
 * 一轮结束只清锚点、留着上一次的速率，免得每轮开头那段空白期把数字闪没。
 *
 * @param outputTokens - 本会话累计输出 token（快照的 status.usage）
 */
function useOutputSpeed(outputTokens: number, turnState: StatusView['turnState']): number | null {
  const anchor = useRef<{ tokens: number; at: number } | null>(null)
  const [speed, setSpeed] = useState<number | null>(null)
  const busy = turnState !== 'idle'
  useEffect(() => {
    if (!busy) {
      anchor.current = null
      return
    }
    const now = Date.now()
    const previous = anchor.current
    if (previous === null) {
      anchor.current = { tokens: outputTokens, at: now }
      return
    }
    const seconds = (now - previous.at) / 1000
    const gained = outputTokens - previous.tokens
    // 半秒以下或这一段没吐字（比如刚发完请求在等服务端首包）就不更新，避免除出天文数字
    if (seconds < 0.5 || gained <= 0) return
    setSpeed(gained / seconds)
  }, [busy, outputTokens])
  return speed
}

/**
 * 会话累计用量：切会话时取一次，之后每轮跑完（忙转闲）再取一次——
 * 这份数字只有这两个时刻会变。
 */
function useSessionUsage(sessionId: string | null, turnState: StatusView['turnState']): SessionUsageView | null {
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
  }, [sessionId, busy])
  return bag !== null && bag.id === sessionId ? bag.view : null
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
