/**
 * 审批卡：挂起的工具审批。
 *
 * 四个决定照后端授权的三档语义（`ApprovalAnswer`）：这次允许 / 本会话允许 /
 * 永久允许（往 `~/.dsc/policy.rules` 写一条前缀规则）/ 拒绝。
 * 卡片上必须写清「为什么要问」和「永久允许会记住什么」，否则用户是在盲点头。
 *
 * @module desktop/renderer/ApprovalCard
 */
import { useEffect, type JSX } from 'react'
import type { ApprovalAnswer, ApprovalRequestView } from '@dsc/runtime/contract.js'

/** 风险档位对应的中文与配色档位。 */
const RISK: Record<ApprovalRequestView['risk'], { label: string; tone: string }> = {
  low: { label: '低风险', tone: 'low' },
  medium: { label: '中风险', tone: 'medium' },
  high: { label: '高风险', tone: 'high' },
  critical: { label: '极高风险', tone: 'high' },
}

export function ApprovalCard(props: {
  request: ApprovalRequestView
  onAnswer(answer: ApprovalAnswer): void
}): JSX.Element {
  const { request } = props
  const scopes: Array<'once' | 'session' | 'always'> = request.scopes.length > 0 ? request.scopes : ['once']
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if (key === 'y' && scopes.includes('once')) props.onAnswer('allow-once')
      else if (key === 's' && scopes.includes('session')) props.onAnswer('allow-session')
      else if (key === 'a' && scopes.includes('always')) props.onAnswer('allow-always')
      else if (key === 'n' || key === 'Escape') props.onAnswer('reject')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props, scopes])

  const risk = RISK[request.risk]
  const keys: Array<{ scope: 'once' | 'session' | 'always'; answer: ApprovalAnswer; label: string; key: string; title: string }> = [
    { scope: 'once', answer: 'allow-once', label: '这次允许', key: 'y', title: '只放过这一次，下次同类操作还会问' },
    { scope: 'session', answer: 'allow-session', label: '本会话允许', key: 's', title: '这个会话里同类操作不再问；换会话就失效' },
    {
      scope: 'always',
      answer: 'allow-always',
      label: '永久允许',
      key: 'a',
      title: request.suggestedRule === null ? '这类动作不给持久化' : `往规则文件写一条：${request.suggestedRule.join(' ')}… 以后照它自动放行`,
    },
  ]

  return (
    <div className={`approval risk-${risk.tone}`}>
      <div className="approval-head">
        <span className="tool-name">{request.toolName}</span>
        <span className={`risk-badge tone-${risk.tone}`}>{risk.label}</span>
        <span className="approval-mode">
          权限 {request.policy === 'readonly' ? '仅查看' : request.policy === 'auto-edit' ? '工作区自动' : request.policy === 'full-access' ? '完全访问' : 'AI 审查'} · 模式{' '}
          {request.mode === 'plan' ? '计划' : request.mode === 'explore' ? '探索' : request.mode === 'quiet' ? '免打扰' : '执行'}
        </span>
      </div>
      <div className="approval-args">{request.argsSummary}</div>
      <div className="approval-reason">{request.reason}</div>
      {request.hardline ? (
        <div className="approval-hardline">这一步被安全策略判为不可放行，只能拒绝。</div>
      ) : (
        <div className="approval-actions">
          {keys
            .filter((entry) => scopes.includes(entry.scope))
            .map((entry) => (
              <button key={entry.scope} className="btn" title={entry.title} onClick={() => props.onAnswer(entry.answer)}>
                {entry.label}
                <kbd>{entry.key}</kbd>
              </button>
            ))}
          <button className="btn danger" title="不执行这一步，并把拒绝原因回给模型" onClick={() => props.onAnswer('reject')}>
            拒绝
            <kbd>n</kbd>
          </button>
          <span className="hint">5 分钟没人答按拒绝处理</span>
        </div>
      )}
    </div>
  )
}
