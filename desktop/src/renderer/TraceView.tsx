/**
 * 轨迹页：agent 执行过程的时间线（对照 dsh 的「轨迹」标签）。
 *
 * 按用户消息分轮；轮头压成一行（轮次号 + 用户消息 + 本轮步数统计），默认只展开
 * 最新一轮，其余收成一行。轮内每条步骤也只占一行：思考取首句做摘要、工具走
 * ToolCard 的折叠态、系统事件一行灰字——一屏能扫过好几轮，而不是被一段思考铺满。
 * 正文条目不进轨迹（看内容去「对话」）。
 *
 * @module desktop/renderer/TraceView
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { StatusView, TranscriptEntry } from '@dsc/runtime/contract.js'
import { ToolCard } from './ToolCard.js'
import { IconChevronDown, IconChevronRight, IconCoins } from './icons.js'

/** 轮次：一条用户消息及其后续执行步骤。 */
interface Round {
  user: string | null
  steps: TranscriptEntry[]
}

/** 折叠态里的思考摘要长度：一行放不下就省略号，展开才看全文。 */
const THINK_PREVIEW_LIMIT = 90

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

/** 把多行文本压成一行摘要（折叠态显示用）。 */
function summarize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > THINK_PREVIEW_LIMIT ? `${flat.slice(0, THINK_PREVIEW_LIMIT)}…` : flat
}

export function TraceView(props: {
  entries: TranscriptEntry[]
  status: StatusView
}): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)
  /** 展开着的轮次序号；默认只放最新一轮。 */
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())

  useEffect(() => {
    const element = scroller.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [props.entries])

  const rounds = useMemo(() => buildRounds(props.entries), [props.entries])
  const toolCount = props.entries.filter((entry) => entry.kind === 'tool').length
  const usage = props.status.usage

  // 最新一轮默认展开：新的一轮到来时把它打开，旧的保持用户留下的折叠状态。
  useEffect(() => {
    if (rounds.length === 0) return
    setExpanded((current) => {
      const last = rounds.length - 1
      if (current.has(last)) return current
      return new Set(current).add(last)
    })
  }, [rounds.length])

  if (rounds.length === 0) {
    return (
      <div className="chat" ref={scroller}>
        <div className="chat-inner trace">
          <div className="trace-empty">本会话还没有执行轨迹。发送消息或使用工具后，这里会显示执行过程。</div>
        </div>
      </div>
    )
  }

  const allOpen = expanded.size >= rounds.length
  const toggleAll = (): void => {
    setExpanded(allOpen ? new Set() : new Set(rounds.map((_, index) => index)))
  }
  const toggleRound = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
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
          <button className="text-btn trace-toggle-all" onClick={toggleAll}>
            {allOpen ? '全部折叠' : '全部展开'}
          </button>
        </div>
        {rounds.map((round, index) => {
          const open = expanded.has(index)
          const tools = round.steps.filter((step) => step.kind === 'tool').length
          return (
            <div key={index} className={`trace-round${open ? ' open' : ''}`}>
              <button
                className="round-head"
                data-tip={open ? '折叠这一轮' : '展开这一轮的执行步骤'}
                onClick={() => toggleRound(index)}
              >
                <span className="round-caret">
                  {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                </span>
                <span className="round-no">第 {index + 1} 轮</span>
                {round.user !== null && <span className="round-user">{round.user}</span>}
                <span className="round-meta">
                  {round.steps.length === 0 ? '无步骤' : `${round.steps.length} 步 · ${tools} 次工具`}
                </span>
              </button>
              {open &&
                (round.steps.length === 0 ? (
                  <div className="round-none">无工具调用与系统事件</div>
                ) : (
                  <div className="round-steps">
                    {round.steps.map((step) => (
                      <div key={step.id} className="step">
                        {step.kind === 'tool' && <ToolCard call={step.call} />}
                        {step.kind === 'thinking' && (
                          <details className="trace-think">
                            <summary data-tip="展开思考全文">
                              <span className="th-label">思考</span>
                              <span className="th-preview">{summarize(step.text)}</span>
                              <IconChevronDown size={13} className="th-chevron" />
                            </summary>
                            <div className="body">{step.text}</div>
                          </details>
                        )}
                        {step.kind === 'system' && (
                          <div className="trace-sys" data-tip={step.text}>
                            {step.text}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}
