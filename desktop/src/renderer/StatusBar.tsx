/**
 * 状态栏：分段居中（对照 dsh 底栏）——模型 · 回合状态 · token · 会话 id。
 *
 * @module desktop/renderer/StatusBar
 */
import type { JSX } from 'react'
import type { StatusView } from '@dsc/runtime/contract.js'

const TURN_TEXT: Record<StatusView['turnState'], string> = {
  idle: '空闲',
  thinking: '思考中',
  working: '执行中',
  'awaiting-approval': '等待审批',
}

export function StatusBar({ status }: { status: StatusView }): JSX.Element {
  const segments: { text: string; className?: string }[] = [
    { text: `模型 ${status.model}` },
    { text: TURN_TEXT[status.turnState], className: `state-${status.turnState}` },
  ]
  if (status.usage !== null) {
    segments.push({
      text: `tok ${formatCount(status.usage.inputTokens)} → ${formatCount(status.usage.outputTokens)}`,
    })
  }
  if (status.sessionId !== null) {
    segments.push({ text: `会话 ${status.sessionId.slice(0, 8)}` })
  }

  return (
    <div className="statusbar">
      <div className="segments">
        {segments.map((segment, index) => (
          <span key={index} className={`segment ${segment.className ?? ''}`}>
            {segment.text}
          </span>
        ))}
      </div>
    </div>
  )
}

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}
