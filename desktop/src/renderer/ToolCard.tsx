/**
 * 工具卡：工具名 + 参数（默认折叠）+ 结果摘要 + 状态色（running/done/failed/rejected）。
 *
 * @module desktop/renderer/ToolCard
 */
import { useState, type JSX } from 'react'
import type { ToolCallView } from '@dsc/runtime/contract.js'

const STATUS_TEXT: Record<ToolCallView['status'], string> = {
  running: '执行中…',
  done: '完成',
  failed: '失败',
  rejected: '已拒绝',
}

const ARG_PREVIEW_LIMIT = 120

function prettyArgs(argsText: string): string {
  try {
    return JSON.stringify(JSON.parse(argsText), null, 2)
  } catch {
    return argsText
  }
}

export function ToolCard({ call, defaultOpen = false }: { call: ToolCallView; defaultOpen?: boolean }): JSX.Element {
  const status = call.status
  const [open, setOpen] = useState(defaultOpen || status === 'running')
  const preview = call.argsText.replace(/\s+/g, ' ').slice(0, ARG_PREVIEW_LIMIT)

  return (
    <div className={`entry tool-card status-${status}`}>
      <div
        className="tool-head"
        onClick={() => setOpen((current) => !current)}
        data-tip="点击展开参数与结果"
      >
        <span className="name">{call.name}</span>
        <span className="preview">
          {preview}
          {call.argsText.replace(/\s+/g, ' ').length > ARG_PREVIEW_LIMIT ? '…' : ''}
        </span>
        <span className="status">{STATUS_TEXT[status]}</span>
      </div>
      {open && (
        <div className="tool-body">
          <div className="label">参数</div>
          <div className="args">{prettyArgs(call.argsText)}</div>
          {call.resultText !== undefined && call.resultText !== '' && (
            <>
              <div className="label">结果</div>
              <div className="result">{call.resultText}</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
