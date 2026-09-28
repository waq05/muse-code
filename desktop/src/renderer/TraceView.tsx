/**
 * 轨迹页：agent 执行过程的时间线（对照 dsh 的「轨迹」标签）。
 * 按用户消息分轮；轮内展示思考全文、工具调用（默认展开参数与结果）、系统事件；
 * 顶部给出轮次/工具/用量统计。正文条目不进轨迹（看内容去「对话」）。
 *
 * @module desktop/renderer/TraceView
 */
import { useEffect, useMemo, useRef, type JSX } from 'react'
import type { StatusView, TranscriptEntry } from '@dsc/runtime/contract.js'
import { ToolCard } from './ToolCard.js'
import { IconCoins } from './icons.js'

/** 轮次：一条用户消息及其后续执行步骤。 */
interface Round {
  user: string | null
  steps: TranscriptEntry[]
}

function buildRounds(entries: TranscriptEntry[]): Round[] {
  const rounds: Round[] = []
  for (const entry of entries) {
    if (entry.kind === 'user') {
      rounds.push({ user: entry.text, steps: [] })
    } else if (entry.kind === 'text') {
      // 正文是对话页的内容，轨迹只关心执行步骤
    } else {
      if (rounds.length === 0) rounds.push({ user: null, steps: [] })
      rounds[rounds.length - 1]?.steps.push(entry)
    }
  }
  return rounds
}

export function TraceView(props: {
  entries: TranscriptEntry[]
  status: StatusView
}): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = scroller.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [props.entries])

  const rounds = useMemo(() => buildRounds(props.entries), [props.entries])
  const toolCount = props.entries.filter((entry) => entry.kind === 'tool').length
  const usage = props.status.usage

  if (rounds.length === 0) {
    return (
      <div className="chat" ref={scroller}>
        <div className="chat-inner trace">
          <div className="trace-empty">本会话还没有执行轨迹。发送消息或使用工具后，这里会显示执行过程。</div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat" ref={scroller}>
      <div className="chat-inner trace">
        <div className="trace-stats">
          <span>{rounds.length} 轮</span>
          <span>{toolCount} 次工具调用</span>
          {usage !== null && (
            <span>
              <IconCoins size={12} /> {formatTokens(usage.inputTokens + usage.outputTokens)} tok
            </span>
          )}
        </div>
        {rounds.map((round, index) => (
          <div key={index} className="trace-round">
            <div className="round-head" data-tip={round.user ?? undefined}>
              <span className="round-no">第 {index + 1} 轮</span>
              {round.user !== null && <span className="round-user">{truncate(round.user, 60)}</span>}
            </div>
            {round.steps.length === 0 ? (
              <div className="round-none">（无工具调用与系统事件）</div>
            ) : (
              <div className="round-steps">
                {round.steps.map((step) => (
                  <div key={step.id} className="step">
                    {step.kind === 'tool' && <ToolCard call={step.call} defaultOpen />}
                    {step.kind === 'thinking' && (
                      <div className="step-thinking">
                        <div className="step-tag">思考</div>
                        {step.text}
                      </div>
                    )}
                    {step.kind === 'system' && <div className="step-system">{step.text}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}
