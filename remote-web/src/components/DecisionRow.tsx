import type { ReactNode } from 'react'
import type { ApprovalAnswer } from '../lib/types.js'

/**
 * 四个决定的按钮行：审批卡 / 计划卡 / 提问卡共用。
 *
 * `allow` 决定露出哪几个（审批卡按宿主给的 scopes 收窄，危险动作会把「永久」摘掉）；
 * 拒绝永远在，否则用户没有退路。`labels` 让计划卡换成更贴切的措辞。
 */
export interface DecisionRowProps {
  allow: readonly ApprovalAnswer[]
  labels?: Partial<Record<ApprovalAnswer, string>>
  disabled?: boolean
  onDecide: (decision: ApprovalAnswer) => void
}

const DEFAULT_LABELS: Record<ApprovalAnswer, string> = {
  'allow-once': '同意一次',
  'allow-session': '本会话',
  'allow-always': '永久',
  reject: '拒绝',
}

const ORDER: readonly ApprovalAnswer[] = ['allow-once', 'allow-session', 'allow-always', 'reject']

export function DecisionRow({ allow, labels, disabled = false, onDecide }: DecisionRowProps): ReactNode {
  return (
    <div className="decisions">
      {ORDER.filter((decision) => decision === 'reject' || allow.includes(decision)).map((decision) => (
        <button
          key={decision}
          type="button"
          className={`decision decision-${decision}`}
          disabled={disabled}
          onClick={() => onDecide(decision)}
        >
          {labels?.[decision] ?? DEFAULT_LABELS[decision]}
        </button>
      ))}
    </div>
  )
}
