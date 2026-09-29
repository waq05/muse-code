/**
 * 消息流：user 气泡 / thinking 折叠 / text markdown（含复制操作条）/ 工具卡 / system 灰条
 * + 流式直播尾光标 + 自动滚动到底。
 *
 * @module desktop/renderer/ChatView
 */
import { useEffect, useRef, type JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { StatusView, TranscriptEntry } from '@dsc/runtime/contract.js'
import { JumpStrip } from './JumpStrip.js'
import { PlanReview } from './TaskDock.js'
import { ToolCard } from './ToolCard.js'
import { IconChevronDown, IconCopy } from './icons.js'

export function ChatView(props: {
  entries: TranscriptEntry[]
  turnState: StatusView['turnState']
}): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = scroller.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [props.entries])

  const live = props.turnState !== 'idle'

  return (
    <div className="chat-wrap">
      <div className="chat" ref={scroller}>
        <div className="chat-inner">
          {props.entries.map((entry) => {
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
                      <button
                        className="meta-btn"
                        onClick={() => void navigator.clipboard.writeText(entry.text)}
                      >
                        <IconCopy size={13} /> 复制
                      </button>
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
