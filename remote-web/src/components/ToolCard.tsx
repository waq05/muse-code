import { useState, type ReactNode } from 'react'
import { formatDuration, summarizeArgs } from '../lib/format.js'
import type { ToolCallView, ToolStatus } from '../lib/types.js'

/**
 * 工具卡：名称 + 状态，点开看参数与结果。
 *
 * 视觉刻意不放大色块：状态只体现在左侧小圆点与状态文字上，卡片主体就是描边 + 等宽字，
 * 这样一屏里十几张工具卡也不会把对话正文淹掉。
 */
export interface ToolCardProps {
  call: ToolCallView
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  // 模型吐了工具名、参数还没到齐（对照 dsh 的 preparing 阶段）
  preparing: '准备中',
  running: '运行中',
  done: '完成',
  failed: '失败',
  rejected: '已拒绝',
}

export function ToolCard({ call }: ToolCardProps): ReactNode {
  const [open, setOpen] = useState(false)
  const summary = summarizeArgs(call.argsText)
  const duration = formatDuration(call.durationMs)
  const detail = call.resultText ?? ''

  return (
    <div className={`toolcard status-${call.status}`}>
      <button
        type="button"
        className="toolcard-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="toolcard-dot" aria-hidden="true" />
        <span className="toolcard-name">{call.name}</span>
        <span className="toolcard-status">{STATUS_LABEL[call.status]}</span>
        {!open && summary !== '' ? <span className="toolcard-summary">{summary}</span> : null}
        {duration !== '' ? <span className="toolcard-duration">{duration}</span> : null}
        <span className="toolcard-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className="toolcard-body">
          <div className="toolcard-section-label">参数</div>
          <pre className="toolcard-pre">{call.argsText.trim() === '' ? '（无参数）' : call.argsText}</pre>
          {detail.trim() !== '' ? (
            <>
              <div className="toolcard-section-label">结果</div>
              <pre className="toolcard-pre">{detail}</pre>
            </>
          ) : (
            <div className="toolcard-empty">
              {call.status === 'running' ? '还没有结果' : '没有结果文本'}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
