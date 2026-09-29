/**
 * 输入框上方的四块常驻面：任务清单条、目标条、计划评审卡、模型提问卡。
 *
 * 都不弹新窗口、不用 Toast：进度要一直看得见，用户随时能回头核对
 * （照 DSH 的 plan/todo 投影 + Hermes 的 todo_state 随会话返回的思路）。
 *
 * @module desktop/renderer/TaskDock
 */
import { useState, type JSX } from 'react'
import type { AskUserView, GoalView, PlanDecision, PlanView, TodoView } from '@dsc/runtime/contract.js'

/** 清单状态标记（与 core/todo.ts 的 STATUS_MARKS 对齐）。 */
const MARK: Record<string, string> = { pending: '○', in_progress: '◐', completed: '●', cancelled: '✕' }

/** 任务清单条：折叠时只显示进度与在做的这一步，展开看全表。 */
export function TaskDock(props: { todos: TodoView; onClear(): void }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const { items, done, total, active } = props.todos
  if (total === 0) return null
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return (
    <div className={`task-dock${open ? ' open' : ''}`}>
      <button className="task-dock-head" onClick={() => setOpen(!open)} title={open ? '收起任务清单' : '展开看全部任务'}>
        <span className="task-count">
          任务 {done}/{total}
        </span>
        <span className="task-progress">
          <span className="task-progress-fill" style={{ width: `${String(percent)}%` }} />
        </span>
        {!open && <span className="task-active">{active ?? '没有在做的步骤'}</span>}
        <span className="task-caret">{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <>
          <ul className="task-list">
            {items.map((item) => (
              <li key={item.id} className={`task-item status-${item.status}${item.parent !== undefined ? ' child' : ''}`}>
                <span className="task-mark">{MARK[item.status] ?? '○'}</span>
                <span className="task-text">{item.content}</span>
              </li>
            ))}
          </ul>
          <button className="task-clear" onClick={props.onClear} title="清空任务清单">
            清空清单
          </button>
        </>
      ) : null}
    </div>
  )
}

/** 目标条：跨轮自动续跑的可见刹车。 */
export function GoalBar(props: { goal: GoalView; onAction(action: 'pause' | 'resume' | 'clear' | 'extend'): void }): JSX.Element | null {
  const { goal } = props
  const phase =
    goal.phase === 'active' ? (goal.armed ? '自动续跑中' : '已建立（未上膛）') : goal.phase === 'paused' ? '已暂停' : goal.phase === 'blocked' ? '已阻塞' : '已完成'
  return (
    <div className={`goal-bar phase-${goal.phase}`}>
      <span className="goal-label">目标</span>
      <span className="goal-text" title={goal.blockedReason ?? goal.objective}>
        {goal.objective}
      </span>
      <span className="goal-state">
        {phase} · {goal.rounds}/{goal.maxRounds} 轮
      </span>
      {goal.phase === 'active' ? (
        <button className="goal-btn" onClick={() => props.onAction('pause')} title="暂停自动续跑（不会打断当前这一轮）">
          暂停
        </button>
      ) : goal.phase !== 'complete' ? (
        <button className="goal-btn" onClick={() => props.onAction('resume')} title="继续自动续跑">
          继续
        </button>
      ) : null}
      {goal.phase === 'blocked' && goal.blockedReason?.startsWith('轮次已达上限') === true ? (
        <button className="goal-btn" onClick={() => props.onAction('extend')} title="再加 8 轮">
          放宽轮次
        </button>
      ) : null}
      <button className="goal-btn ghost" onClick={() => props.onAction('clear')} title="清空目标">
        ✕
      </button>
    </div>
  )
}

/** 计划评审卡：计划正文就地可读，批准 / 拒绝决定切不切回执行档。 */
export function PlanReview(props: { plan: PlanView; onAnswer(decision: PlanDecision): void }): JSX.Element {
  const pending = props.plan.decision === 'pending'
  return (
    <div className={`plan-card${pending ? ' pending' : ' settled'}`}>
      <div className="plan-head">
        <span className="plan-title">{props.plan.title}</span>
        <span className="plan-verdict">
          {pending ? '等你批' : props.plan.decision === 'approved' ? '已批准' : '未批准'}
        </span>
      </div>
      <pre className="plan-body">{props.plan.text}</pre>
      <div className="plan-foot">
        <span className="plan-file" title={props.plan.file}>
          {props.plan.file}
        </span>
        {pending ? (
          <>
            <button className="btn-primary plan-btn" onClick={() => props.onAnswer('approved')} title="批准并切回执行模式开始实现">
              批准开工
            </button>
            <button className="btn plan-btn" onClick={() => props.onAnswer('rejected')} title="留在计划模式，让模型按你的反馈改方案">
              还要改
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}

/** 模型提问卡：选项点一下就答完，也可以直接写自由文本。 */
export function AskCard(props: { question: AskUserView; onAnswer(answer: string): void }): JSX.Element {
  const [picked, setPicked] = useState<string[]>([])
  const [free, setFree] = useState('')
  const toggle = (label: string): void => {
    if (!props.question.multiSelect) {
      props.onAnswer(label)
      return
    }
    setPicked((current) => (current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label]))
  }
  const answer = free.trim() !== '' ? free.trim() : picked.join('、')
  return (
    <div className="ask-card">
      {props.question.header !== undefined && props.question.header !== '' ? <div className="ask-header">{props.question.header}</div> : null}
      <div className="ask-question">{props.question.question}</div>
      {props.question.options.length > 0 ? (
        <div className="ask-options">
          {props.question.options.map((option) => (
            <button
              key={option.label}
              className={`ask-option${picked.includes(option.label) ? ' picked' : ''}`}
              onClick={() => toggle(option.label)}
              title={option.description ?? ''}
            >
              <span className="ask-option-label">{option.label}</span>
              {option.description !== undefined ? <span className="ask-option-desc">{option.description}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="ask-free">
        <input
          className="ask-input"
          placeholder={props.question.multiSelect ? '可以多选，或在这里直接写答案' : '也可以直接写答案'}
          value={free}
          onChange={(event) => setFree(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && answer !== '') props.onAnswer(answer)
          }}
        />
        {props.question.multiSelect ? (
          <button className="btn" disabled={answer === ''} onClick={() => props.onAnswer(answer)}>
            提交
          </button>
        ) : null}
      </div>
    </div>
  )
}
