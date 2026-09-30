/**
 * 消息流：user 气泡 / thinking 折叠 / text markdown（含底部操作条）/ 工具卡 / system 灰条
 * + 流式直播尾光标 + 自动滚动到底。
 *
 * 消息底部对照 dsh 的构图：左边一排小图标按钮（复制 / 赞 / 踩），右边这条消息的用量。
 * 头像、时间戳这类宿主没给的数据一律不画（transcript 条目不记录时间），
 * 用量也只报估算值并注明口径。
 *
 * @module desktop/renderer/ChatView
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { StatusView, TranscriptEntry } from '@dsc/runtime/contract.js'
import { JumpStrip } from './JumpStrip.js'
import { PlanReview } from './TaskDock.js'
import { ToolCard } from './ToolCard.js'
import { isSessionMarker } from './session-marker.js'
import { toastOk } from './components/toast.js'
import { IconChevronDown, IconCopy, IconThumbDown, IconThumbUp } from './icons.js'
import { estimateTextTokens, formatTokens } from './token-estimate.js'

/** 一条回复的本机评价：只有赞 / 踩两态，再点一次取消。 */
type Feedback = 'up' | 'down'

/** 本机评价的存档键（localStorage）。 */
const FEEDBACK_KEY = 'dsc.messageFeedback'

/**
 * 读本机评价存档。为什么存在浏览器本地而不是发给宿主：宿主协议里没有
 * 「用户对某条回复的评价」这一项，界面能做的只有如实记在自己这台机器上。
 * 存档坏了就当没点过——不能因为一段历史记录把消息流卡住。
 */
function loadFeedback(): Record<string, Feedback> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(FEEDBACK_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, Feedback> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'up' || value === 'down') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 本机评价只说明一次（第一次点的时候），免得每点一次都弹一条提示。 */
let toldFeedbackOnce = false

export function ChatView(props: {
  entries: TranscriptEntry[]
  turnState: StatusView['turnState']
  /** 当前会话 id（评价按「会话:条目」存，换会话不串味）；未知时传 null。 */
  sessionId: string | null
}): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)
  const [feedback, setFeedback] = useState<Record<string, Feedback>>(loadFeedback)

  useEffect(() => {
    const element = scroller.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [props.entries])

  /** 记一条本机评价（同一项再点一次 = 取消）。 */
  const vote = (key: string, next: Feedback): void => {
    const merged = { ...feedback }
    if (merged[key] === next) delete merged[key]
    else merged[key] = next
    setFeedback(merged)
    try {
      localStorage.setItem(FEEDBACK_KEY, JSON.stringify(merged))
    } catch {
      // 存不下（本地存储被禁用/写满）也不影响这次会话里的显示
    }
    if (!toldFeedbackOnce) {
      toldFeedbackOnce = true
      toastOk('已在本机记下你的评价（宿主还没有评价上传通道）')
    }
  }

  const live = props.turnState !== 'idle'

  return (
    <div className="chat-wrap">
      <div className="chat" ref={scroller}>
        <div className="chat-inner">
          {props.entries.map((entry) => {
            // 本机评价的键：按「会话:条目」拼，条目 id 只在一条会话内唯一
            const feedbackKey = `${props.sessionId ?? ''}:${entry.id}`
            const voteState = feedback[feedbackKey]
            switch (entry.kind) {
              case 'user':
                return (
                  <div key={entry.id} className="entry-user">
                    {entry.images !== undefined && entry.images.length > 0 && (
                      <div className="entry-user-images">
                        {entry.images.map((url, index) => (
                          <a key={index} href={url} target="_blank" rel="noreferrer" data-tip="点开看原图">
                            <img src={url} alt={`第 ${String(index + 1)} 张贴图`} />
                          </a>
                        ))}
                      </div>
                    )}
                    {entry.text}
                  </div>
                )
              case 'text':
                if (entry.id < 0) {
                  // 流式直播尾：无操作条
                  return (
                    <div key={entry.id} className="entry-text live">
                      <div className="markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={entry.id} className="entry-text entry-with-meta">
                    <div className="markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
                    </div>
                    <div className="entry-meta">
                      <div className="meta-actions">
                        <button
                          className="meta-btn"
                          title="复制这条回复的原文"
                          onClick={() => void navigator.clipboard.writeText(entry.text)}
                        >
                          <IconCopy size={13} />
                        </button>
                        <button
                          className={`meta-btn${voteState === 'up' ? ' on' : ''}`}
                          title="这条回复不错（只记在本机）"
                          aria-pressed={voteState === 'up'}
                          onClick={() => vote(feedbackKey, 'up')}
                        >
                          <IconThumbUp size={13} />
                        </button>
                        <button
                          className={`meta-btn${voteState === 'down' ? ' on' : ''}`}
                          title="这条回复不好（只记在本机）"
                          aria-pressed={voteState === 'down'}
                          onClick={() => vote(feedbackKey, 'down')}
                        >
                          <IconThumbDown size={13} />
                        </button>
                      </div>
                      {/* 用量：宿主没按条记 token，这里给的是正文估算值，所以带「~」 */}
                      <span
                        className="meta-usage"
                        title="按正文字符估算（中文约 0.65 token/字、其余约 0.33）；宿主没有按条记录用量，这是估算值"
                      >
                        ~{formatTokens(estimateTextTokens(entry.text))} tok
                      </span>
                    </div>
                  </div>
                )
              case 'thinking':
                // 原生 details 折叠；流式直播尾（id<0）自动展开，定稿后收起
                return (
                  <details
                    key={entry.id}
                    className={`thinking${entry.id < 0 ? ' live' : ''}`}
                    open={entry.id < 0}
                  >
                    <summary>
                      <span className="th-label">思考过程{entry.id < 0 ? ' · 生成中' : ''}</span>
                      <IconChevronDown size={13} className="th-chevron" />
                    </summary>
                    <div className="body">{entry.text}</div>
                  </details>
                )
              case 'tool':
                return <ToolCard key={entry.id} call={entry.call} />
              case 'plan':
                // 历史里的计划卡：批没批一眼可见，批按钮只在待批状态出现
                return <PlanReview key={entry.id} plan={entry.plan} onAnswer={() => undefined} />
              case 'system':
                // 开场那条「会话 x · 模型 y」不画：状态栏第一段已经带着同样的信息，
                // 再在流末尾留一行居中灰字纯属重复（见 session-marker.ts）。
                if (isSessionMarker(entry.text)) return null
                return (
                  <div key={entry.id} className="entry-system">
                    {entry.text}
                  </div>
                )
              default:
                return null
            }
          })}
          {live && <div className="entry-system live" style={{ minHeight: 14 }} />}
        </div>
      </div>
      {/* 右缘的回合刻度条（对照 dsh 的快速跳转） */}
      <JumpStrip scrollerRef={scroller} entries={props.entries} />
    </div>
  )
}
