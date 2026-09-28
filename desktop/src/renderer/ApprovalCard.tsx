/**
 * 审批卡：挂起的工具审批（允许 / 拒绝按钮 + y/n/Escape 快捷键）。
 *
 * @module desktop/renderer/ApprovalCard
 */
import { useEffect, type JSX } from 'react'
import type { ApprovalAnswer, ApprovalRequestView } from '@dsc/runtime/contract.js'

export function ApprovalCard(props: {
  request: ApprovalRequestView
  onAnswer(answer: ApprovalAnswer): void
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'y' || event.key === 'Y') props.onAnswer('allow-once')
      else if (event.key === 'n' || event.key === 'N' || event.key === 'Escape') {
        props.onAnswer('reject')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <div className="approval">
      <div className="text">
        <span className="tool-name">{props.request.toolName}</span>{' '}
        <span style={{ color: 'var(--text-dim)' }}>{props.request.argsSummary}</span>
      </div>
      <span className="hint">y 允许 / n 拒绝</span>
      <button className="btn" onClick={() => props.onAnswer('allow-once')}>
        允许一次
      </button>
      <button className="btn" onClick={() => props.onAnswer('reject')}>
        拒绝
      </button>
    </div>
  )
}
