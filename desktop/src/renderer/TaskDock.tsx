/**
 * 输入框上方的四块常驻面：任务清单条、目标条、计划评审卡、模型提问卡。
 *
 * 都不弹新窗口、不用 Toast：进度要一直看得见，用户随时能回头核对
 * （照 DSH 的 plan/todo 投影 + Hermes 的 todo_state 随会话返回的思路）。
 *
 * @module desktop/renderer/TaskDock
 */
import { useMemo, useState, type JSX, type KeyboardEvent } from 'react'
import type { AskOptionView, AskUserView, GoalView, PlanDecision, PlanView, TodoView } from '@dsc/runtime/contract.js'

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

/** 提问卡里的一题：契约现在是单题视图，一次挂一批时每题仍是这几个字段。 */
interface AskItem {
  /** 这题在本次提问里的稳定标识：换一批问题就换一串 key（草稿与聚焦位置都按它存）。 */
  key: string
  header?: string
  question: string
  options: AskOptionView[]
  multiSelect: boolean
  /** 「其他」自由输入是否允许。 */
  freeText: boolean
}

/** 一题的作答草稿（对照 dsh draft-store.ts:9-16 的 QuestionDraftAnswer）。 */
interface AskDraft {
  picked: string[]
  free: string
  skipped: boolean
}

const EMPTY_DRAFT: AskDraft = { picked: [], free: '', skipped: false }

/**
 * 把一批里的一条原始数据收成一题；`question` 不是非空字符串就丢掉
 * ——宿主喂进来的脏数据不该把整张卡打空。
 * @param raw - 视图里的一条问题（形状与契约的 AskUserView 同源）。
 * @param key - 这题在本次提问里的稳定标识。
 */
function toAskItem(raw: unknown, key: string): AskItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const doc = raw as Record<string, unknown>
  const question = typeof doc.question === 'string' ? doc.question.trim() : ''
  if (question === '') return null
  const options: AskOptionView[] = []
  if (Array.isArray(doc.options)) {
    for (const option of doc.options) {
      if (typeof option !== 'object' || option === null) continue
      const entry = option as Record<string, unknown>
      const label = typeof entry.label === 'string' ? entry.label : ''
      if (label === '') continue
      options.push({ label, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) })
    }
  }
  const header = typeof doc.header === 'string' ? doc.header.trim() : ''
  return {
    key,
    ...(header === '' ? {} : { header }),
    question,
    options,
    multiSelect: doc.multiSelect === true,
    freeText: doc.allowFreeText !== false,
  }
}

/**
 * 把宿主给的视图归一成题目清单。
 *
 * 宿主现在一次只挂一题（`src/plugins/ask.ts` 的 run() 对 questions 数组逐题 await，
 * 每条 `pendingQuestion` 就是一个问题），所以走的是最后那条单题分支；契约日后升级成
 * 一次挂一批（视图自己带 `questions` 数组）时，多题分支自动接住，下面的列表 UI 一行都不用改。
 * @param view - 宿主挂出的提问视图。
 */
function askItems(view: AskUserView): AskItem[] {
  const many = (view as AskUserView & { questions?: unknown }).questions
  const items = (Array.isArray(many) ? many : [])
    .map((raw, index) => toAskItem(raw, `${view.id}#${String(index)}`))
    .filter((item): item is AskItem => item !== null)
  if (items.length > 0) return items
  const single = toAskItem(view, `${view.id}#0`)
  return single === null ? [] : [single]
}

/**
 * 一题交回宿主的答案文本：跳过写一句实话（与 ask.ts:67 中断那种说法同一个口径），
 * 写了自由文本就优先用它（对照 dsh QuestionComposer.tsx:211-221 的取值规则）。
 * @param draft - 这题的草稿。
 */
function answerOf(draft: AskDraft): string {
  if (draft.skipped) return '（用户跳过了这一题）'
  const free = draft.free.trim()
  return free === '' ? draft.picked.join('、') : free
}

/**
 * 模型提问卡：向导式作答——一卡只露当前这一题，翻页器（‹ n/m ›）切题，全答完一次提交。
 * 「跳过」把这题记成跳过并推进；单选点选后自动推进下一题。交互语义对照 dsh 的 QuestionComposer.tsx。
 */
export function AskCard(props: { question: AskUserView; onAnswer(answer: string): void }): JSX.Element | null {
  const items = useMemo(() => askItems(props.question), [props.question])
  if (items.length === 0) return null
  // key 换一批问题就整块重挂：草稿与聚焦位置跟着归零，上一批的输入框不会把字留在下一批里。
  return <AskComposer key={items.map((item) => item.key).join('|')} items={items} onAnswer={props.onAnswer} />
}

/** 提问卡的作答面：草稿按题存，切题回来还在，提交后连题一起清掉。 */
function AskComposer(props: { items: AskItem[]; onAnswer(answer: string): void }): JSX.Element {
  const { items } = props
  const [drafts, setDrafts] = useState<Record<string, AskDraft>>({})
  const [focus, setFocus] = useState(0)
  const [hint, setHint] = useState('')
  const index = Math.min(focus, items.length - 1)
  const item = items[index]
  const draft = drafts[item.key] ?? EMPTY_DRAFT
  const isLast = index === items.length - 1

  /** 这题有答案（选了选项或写了字）。 */
  const answered = (value: AskDraft): boolean => value.picked.length > 0 || value.free.trim() !== ''
  /** 这题做完了：答了，或者明确跳过（dsh QuestionComposer.tsx:199-202 的 answered / completed 一对）。 */
  const completed = (value: AskDraft): boolean => answered(value) || value.skipped
  const draftOf = (target: AskItem, source: Record<string, AskDraft> = drafts): AskDraft => source[target.key] ?? EMPTY_DRAFT

  /** 改草稿：顺手把焦点挪到 `thenIndex`（dsh:178-185 的 updateDraft）。 */
  const write = (target: AskItem, next: (current: AskDraft) => AskDraft, thenIndex = index): void => {
    setDrafts({ ...drafts, [target.key]: next(draftOf(target)) })
    setFocus(thenIndex)
    setHint('')
  }

  /** 点选项：多选勾/取消，单选换掉已选并清掉自由文本；单选还顺手推进到下一题（dsh:187-197）。 */
  const choose = (label: string): void => {
    write(
      item,
      (current) => {
        if (!item.multiSelect) return { picked: [label], free: '', skipped: false }
        const picked = current.picked.includes(label)
          ? current.picked.filter((entry) => entry !== label)
          : [...current.picked, label]
        return { ...current, picked, skipped: false }
      },
      item.multiSelect || isLast ? index : index + 1,
    )
  }

  /** 写自由文本：单选下写字就顶掉已选（dsh:249-257）。 */
  const writeFree = (value: string): void => {
    write(item, (current) => ({ picked: item.multiSelect ? current.picked : [], free: value, skipped: false }))
  }

  /**
   * 统一提交：先把缺的题补齐（缺哪题就把焦点跳过去），再按题目顺序逐题回传宿主的 onAnswer。
   *
   * 为什么是逐题回传：宿主的 `AskService.answerQuestion(answer: string)` 一次只解决当前这一题
   * （src/services/types.ts:254-261），契约一次收一个字符串，这里不动它。模型那一侧看到的仍是
   * 同一个 ask_user 调用拿回全部答案——所以「一次交回」落在渲染层，而不是逐题各交一次。
   * @param values - 要提交的整份草稿（跳过与自由文本都在里面）。
   */
  const submitAll = (values: Record<string, AskDraft>): void => {
    const missing = items.findIndex((target) => !completed(draftOf(target, values)))
    if (missing >= 0) {
      setFocus(missing)
      setHint('还有题目没答')
      return
    }
    for (const target of items) props.onAnswer(answerOf(draftOf(target, values)))
    // 提交即清草稿：这一批若还有下一次渲染，输入框里不许留着刚才那句（原来那个残留 bug）。
    setDrafts({})
    setHint('')
  }

  /** 主按钮：前面还有题就走下一题，最后一题才提交（dsh:233-244 的 continueFlow）。 */
  const continueFlow = (): void => {
    if (isLast) {
      submitAll(drafts)
      return
    }
    setFocus(index + 1)
    setHint('')
  }

  /** 跳过这题：记一笔空答案往前走，最后一题跳过就直接提交（dsh:265-275）。 */
  const skipCurrent = (): void => {
    const updated = { ...drafts, [item.key]: { picked: [], free: '', skipped: true } }
    if (isLast) {
      submitAll(updated)
      return
    }
    setDrafts(updated)
    setFocus(index + 1)
    setHint('')
  }

  /** 输入框回车＝走主按钮那一步；输入法选字时的回车不算（dsh:37-41 同一条判定，keyCode 229 是老引擎的信号）。 */
  const onFreeKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || Reflect.get(event.nativeEvent, 'keyCode') === 229) return
    event.preventDefault()
    if (answered(draft)) continueFlow()
  }

  return (
    <div className="ask-card" data-ask-count={items.length}>
      {/* 一卡只露当前这一题：其余题目连 DOM 都不进，草稿与已答状态只存在 drafts 里。
          key 跟着题走，换题时整块重挂 —— 题目没选项时输入框才能重新拿到焦点。 */}
      <div className="ask-panel" key={item.key} data-ask-index={index} data-ask-key={item.key}>
        <div className="ask-question">
          {item.header !== undefined ? <span className="ask-header">{item.header}</span> : null}
          <span className="ask-text">{item.question}</span>
        </div>
        {item.options.length > 0 ? (
          <div className="ask-options" role={item.multiSelect ? 'group' : 'radiogroup'}>
            {item.options.map((option) => {
              const picked = draft.picked.includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  className={`ask-option${picked ? ' picked' : ''}`}
                  role={item.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={picked}
                  title={option.description ?? ''}
                  onClick={() => choose(option.label)}
                >
                  <span className="ask-option-label">{option.label}</span>
                  {option.description !== undefined ? <span className="ask-option-desc">{option.description}</span> : null}
                </button>
              )
            })}
          </div>
        ) : null}
        {item.freeText ? (
          <div className="ask-free">
            <input
              className="ask-input"
              data-ask-input={index}
              autoFocus={item.options.length === 0}
              placeholder={item.multiSelect ? '可以多选，或在这里直接写答案' : '也可以直接写答案'}
              value={draft.free}
              onChange={(event) => writeFree(event.target.value)}
              onKeyDown={onFreeKeyDown}
            />
          </div>
        ) : null}
      </div>
      <div className="ask-foot">
        {items.length > 1 ? (
          <div className="ask-pager">
            <button
              type="button"
              className="ask-page"
              data-ask-page="prev"
              disabled={index === 0}
              title="上一题"
              onClick={() => {
                setFocus(index - 1)
                setHint('')
              }}
            >
              ‹
            </button>
            <span className="ask-progress">
              {index + 1}/{items.length}
            </span>
            <button
              type="button"
              className="ask-page"
              data-ask-page="next"
              disabled={isLast}
              title="下一题"
              onClick={() => {
                setFocus(index + 1)
                setHint('')
              }}
            >
              ›
            </button>
          </div>
        ) : null}
        <span className="ask-hint" role="status">
          {hint}
        </span>
        <button type="button" className="btn-ghost ask-skip" onClick={skipCurrent} title="这题不答，问下一题">
          跳过
        </button>
        <button
          type="button"
          className="btn-primary ask-submit"
          data-ask-submit={isLast ? 'submit' : 'next'}
          disabled={!answered(draft)}
          onClick={continueFlow}
        >
          {isLast ? '提交' : '下一题'}
        </button>
      </div>
    </div>
  )
}
