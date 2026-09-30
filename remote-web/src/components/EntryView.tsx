import { memo, useState, type ReactNode } from 'react'
import { formatClock } from '../lib/format.js'
import type { PlanView, TranscriptEntry } from '../lib/types.js'
import { ToolCard } from './ToolCard.js'

/**
 * 一条对话条目的渲染分派：按 kind 各走一个小组件。
 *
 * 为什么按 kind 分而不是一个大 switch 里堆 JSX：直播尾里同一 id 的 text/thinking 条目
 * 会不停被替换成新对象，拆成组件 + memo 之后只有它自己重渲染，历史条目一个都不动。
 */
export interface EntryViewProps {
  entry: TranscriptEntry
}

function EntryViewInner({ entry }: EntryViewProps): ReactNode {
  switch (entry.kind) {
    case 'user':
      return <UserEntry entry={entry} />
    case 'text':
      return <AgentTextEntry entry={entry} />
    case 'thinking':
      return <ThinkingEntry text={entry.text} />
    case 'tool':
      return <ToolEntry entry={entry} />
    case 'plan':
      return <PlanEntry plan={entry.plan} />
    case 'system':
      return <SystemEntry text={entry.text} compaction={entry.compaction?.count} />
  }
}

function UserEntry({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }): ReactNode {
  const clock = formatClock(entry.ts)
  return (
    <div className="row row-user">
      <div className="bubble bubble-user">
        {entry.compaction !== undefined ? (
          <div className="bubble-mark">压缩摘要 · 第 {entry.compaction.count} 次</div>
        ) : null}
        <div className="bubble-text">{entry.text}</div>
        {entry.images !== undefined && entry.images.length > 0 ? (
          <div className="bubble-images">
            {entry.images.map((src, index) => (
              <img key={`${entry.id}-img-${index}`} src={src} alt="用户附带的图片" />
            ))}
          </div>
        ) : null}
        {clock !== '' ? <div className="bubble-meta">{clock}</div> : null}
      </div>
      <Avatar label="我" tone="user" />
    </div>
  )
}

function AgentTextEntry({ entry }: { entry: Extract<TranscriptEntry, { kind: 'text' }> }): ReactNode {
  return (
    <div className="row row-agent">
      <Avatar label="M" tone="agent" />
      <div className="agent-text">{entry.text}</div>
    </div>
  )
}

function ThinkingEntry({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const preview = text.trim().split('\n', 1)[0] ?? ''
  return (
    <div className="row row-agent">
      <span className="row-gutter" aria-hidden="true" />
      <div className="thinking">
        <button type="button" className="thinking-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <span className="thinking-caret">{open ? '▾' : '▸'}</span>
          <span className="thinking-label">思考 · {text.length} 字</span>
          {!open && preview !== '' ? <span className="thinking-preview">{preview}</span> : null}
        </button>
        {open ? <div className="thinking-body">{text}</div> : null}
      </div>
    </div>
  )
}

function ToolEntry({ entry }: { entry: Extract<TranscriptEntry, { kind: 'tool' }> }): ReactNode {
  return (
    <div className="row row-agent">
      <span className="row-gutter" aria-hidden="true" />
      <ToolCard call={entry.call} />
    </div>
  )
}

function PlanEntry({ plan }: { plan: PlanView }): ReactNode {
  const [open, setOpen] = useState(false)
  const decisionLabel =
    plan.decision === 'approved' ? '已批准' : plan.decision === 'rejected' ? '已拒绝' : '待批'
  return (
    <div className="row row-agent">
      <span className="row-gutter" aria-hidden="true" />
      <div className={`planentry decision-${plan.decision}`}>
        <button type="button" className="planentry-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <span className="thinking-caret">{open ? '▾' : '▸'}</span>
          <span className="planentry-title">{plan.title === '' ? '计划' : plan.title}</span>
          <span className="planentry-decision">{decisionLabel}</span>
        </button>
        {open ? <pre className="planentry-body">{plan.text}</pre> : null}
      </div>
    </div>
  )
}

function SystemEntry({ text, compaction }: { text: string; compaction?: number }): ReactNode {
  return (
    <div className="row row-system">
      <span className="system-text">
        {compaction !== undefined ? `压缩历史 · 第 ${compaction} 次 · ` : ''}
        {text}
      </span>
    </div>
  )
}

function Avatar({ label, tone }: { label: string; tone: 'user' | 'agent' }): ReactNode {
  return (
    <span className={`avatar avatar-${tone}`} aria-hidden="true">
      {label}
    </span>
  )
}

export const EntryView = memo(EntryViewInner)
