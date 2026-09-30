import { useState, type ReactNode } from 'react'
import { pathName } from '../lib/format.js'
import type { ApprovalAnswer, ApprovalRequestView, AskUserView, PlanView } from '../lib/types.js'
import { DecisionRow } from './DecisionRow.js'

/**
 * 待办卡：审批 / 计划 / 提问三种走同一个壳（同一位置、同一种结构、同一排决定按钮）。
 *
 * 关键约束：**不做本地隐藏**。点了决定之后只是把按钮置灰并显示「已提交，等待宿主机确认」，
 * 卡片真正消失要等宿主机推来的新快照里 pendingXxx 变成 null——本地提前藏掉会在宿主拒绝
 * 或超时的情况下骗用户「已经过了」。
 */
export interface PendingCardProps {
  approval: ApprovalRequestView | null
  plan: PlanView | null
  question: AskUserView | null
  /** 已经发出回答、等快照：按钮置灰。 */
  decided: boolean
  onAnswerApproval: (answer: ApprovalAnswer) => void
  onAnswerPlan: (answer: ApprovalAnswer) => void
  onAnswerQuestion: (answer: string) => void
}

const RISK_LABEL: Record<ApprovalRequestView['risk'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '严重',
}

const PLAN_LABELS: Partial<Record<ApprovalAnswer, string>> = {
  'allow-once': '批准',
  'allow-session': '本会话都批',
  'allow-always': '永久批准',
  reject: '拒绝',
}

export function PendingCard(props: PendingCardProps): ReactNode {
  const { approval, plan, question, decided } = props
  if (approval !== null) return <ApprovalBody card={approval} decided={decided} onDecide={props.onAnswerApproval} />
  if (plan !== null) return <PlanBody card={plan} decided={decided} onDecide={props.onAnswerPlan} />
  if (question !== null) {
    return <QuestionBody card={question} decided={decided} onDecide={props.onAnswerQuestion} />
  }
  return null
}

function ApprovalBody({
  card,
  decided,
  onDecide,
}: {
  card: ApprovalRequestView
  decided: boolean
  onDecide: (answer: ApprovalAnswer) => void
}): ReactNode {
  const allow: ApprovalAnswer[] = card.hardline
    ? []
    : card.scopes.map((scope): ApprovalAnswer =>
        scope === 'once' ? 'allow-once' : scope === 'session' ? 'allow-session' : 'allow-always',
      )

  return (
    <section className="pendingcard pendingcard-approval" aria-label="待审批">
      <header className="pendingcard-head">
        <span className="pendingcard-kind">需要审批</span>
        <span className={`risk risk-${card.risk}`}>{RISK_LABEL[card.risk]}</span>
      </header>
      <div className="pendingcard-main">
        <span className="pendingcard-tool">{card.toolName === '' ? '等待审批' : card.toolName}</span>
        {card.argsSummary !== '' ? <code className="pendingcard-args">{card.argsSummary}</code> : null}
      </div>
      {card.reason !== '' ? <p className="pendingcard-reason">{card.reason}</p> : null}
      {card.hardline ? <p className="pendingcard-note">这个动作命中硬地板，界面不提供放行，只能拒绝。</p> : null}
      {card.suggestedRule !== null && card.suggestedRule.length > 0 ? (
        <p className="pendingcard-note mono">永久允许会记下：{card.suggestedRule.join(' ')}</p>
      ) : null}
      <DecisionRow allow={allow} disabled={decided} onDecide={onDecide} />
      {decided ? <p className="pendingcard-decided">已提交，等待宿主机确认…</p> : null}
    </section>
  )
}

function PlanBody({
  card,
  decided,
  onDecide,
}: {
  card: PlanView
  decided: boolean
  onDecide: (answer: ApprovalAnswer) => void
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  return (
    <section className="pendingcard pendingcard-plan" aria-label="计划待批">
      <header className="pendingcard-head">
        <span className="pendingcard-kind">计划待批</span>
        {card.file !== '' ? <span className="pendingcard-file">{pathName(card.file)}</span> : null}
      </header>
      <div className="pendingcard-main">
        <span className="pendingcard-tool">{card.title === '' ? '未命名计划' : card.title}</span>
      </div>
      {card.text.trim() !== '' ? (
        <>
          <button type="button" className="pendingcard-toggle" onClick={() => setExpanded((value) => !value)}>
            {expanded ? '收起计划全文 ▴' : '展开计划全文 ▾'}
          </button>
          {expanded ? <pre className="pendingcard-pre">{card.text}</pre> : null}
        </>
      ) : null}
      <DecisionRow allow={['allow-once', 'allow-session', 'allow-always']} labels={PLAN_LABELS} disabled={decided} onDecide={onDecide} />
      {decided ? <p className="pendingcard-decided">已提交，等待宿主机确认…</p> : null}
    </section>
  )
}

function QuestionBody({
  card,
  decided,
  onDecide,
}: {
  card: AskUserView
  decided: boolean
  onDecide: (answer: string) => void
}): ReactNode {
  const [text, setText] = useState('')
  const questions = card.questions ?? []
  const multiple = questions.length > 1

  return (
    <section className="pendingcard pendingcard-question" aria-label="模型提问">
      <header className="pendingcard-head">
        <span className="pendingcard-kind">模型提问</span>
        {card.header !== undefined && card.header !== '' ? (
          <span className="pendingcard-file">{card.header}</span>
        ) : null}
      </header>
      {multiple ? (
        <ol className="pendingcard-questions">
          {questions.map((item, index) => (
            <li key={`${item.question}-${index}`}>
              {item.header !== undefined && item.header !== '' ? <b>{item.header}：</b> : null}
              {item.question}
            </li>
          ))}
        </ol>
      ) : (
        <div className="pendingcard-main">
          <span className="pendingcard-tool">{card.question === '' ? '模型想问你一件事' : card.question}</span>
        </div>
      )}
      {multiple
        ? null
        : card.options.length > 0 && (
            <div className="pendingcard-options">
              {card.options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className="option"
                  disabled={decided}
                  onClick={() => onDecide(option.label)}
                >
                  <span className="option-label">{option.label}</span>
                  {option.description !== undefined && option.description !== '' ? (
                    <span className="option-desc">{option.description}</span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
      {card.allowFreeText && card.options.length === 0 ? (
        <div className="pendingcard-freetext">
          <textarea
            className="pendingcard-input"
            rows={2}
            value={text}
            placeholder="写下你的回答…"
            onChange={(event) => setText(event.target.value)}
          />
          <button
            type="button"
            className="decision decision-allow-once"
            disabled={decided || text.trim() === ''}
            onClick={() => {
              onDecide(text.trim())
              setText('')
            }}
          >
            提交回答
          </button>
        </div>
      ) : null}
      <div className="pendingcard-divider">或按审批口径回答</div>
      <DecisionRow
        allow={['allow-once', 'allow-session', 'allow-always']}
        labels={{ 'allow-once': '同意一次', 'allow-session': '本会话同意', 'allow-always': '永久同意' }}
        disabled={decided}
        onDecide={onDecide}
      />
      {decided ? <p className="pendingcard-decided">已提交，等待宿主机确认…</p> : null}
    </section>
  )
}
