/**
 * 顶层界面：快照订阅（useSyncExternalStore）+ 键盘路由。
 *
 * 键盘优先级：Ctrl+C（打断/退出）→ 审批卡（四档）→ 提问卡（模态作答）→ 计划反馈
 * 输入 → 计划评审卡（批准/拒绝/带反馈）→ 会话选择器 → ctrl+t（思考展开）→ 其余交给
 * Composer。卡片（审批/提问/计划卡）打开时 Composer 置 disabled；唯一的例外是计划
 * 「带反馈退回」——Composer 临时切成反馈输入框，Enter 提交、Esc 取消。
 *
 * @module dsc-tui/app/App
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from 'ink'
import type { JSX } from 'react'
import type { DscRuntime } from '../contract.js'
import { runCommand } from '../plugins/commands.js'
import { ApprovalCard } from './ApprovalCard.js'
import { AskCard, SKIPPED_ANSWER } from './AskCard.js'
import { ChatView } from './ChatView.js'
import { Composer } from './Composer.js'
import { PlanReviewCard } from './PlanReviewCard.js'
import { SessionPicker } from './SessionPicker.js'
import { StatusBar } from './StatusBar.js'
import { BORDER, GAP, PAD, STATUS_COLOR, TEXT } from './theme.js'

/** 双击 Ctrl+C 的判定窗口。 */
const EXIT_WINDOW_MS = 2000

export function App({ runtime }: { runtime: DscRuntime }): JSX.Element {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
  const approval = snapshot.surfaces.pendingApproval
  const question = snapshot.surfaces.pendingQuestion
  const plan = snapshot.surfaces.pendingPlan
  const [picker, setPicker] = useState(false)
  const [pickerIndex, setPickerIndex] = useState(0)
  const [expandThinking, setExpandThinking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** 审批卡内嵌 diff 的展开态（v 切换；换卡即复位）。 */
  const [approvalExpanded, setApprovalExpanded] = useState(false)
  /** 计划全文的展开态。 */
  const [planExpanded, setPlanExpanded] = useState(false)
  /** 计划卡的「带反馈退回」输入模式：Composer 临时改成反馈输入框。 */
  const [planFeedback, setPlanFeedback] = useState(false)
  /** 提问卡的作答进度（一批多题逐题作答；换卡即复位）。 */
  const [askIndex, setAskIndex] = useState(0)
  const [askChecked, setAskChecked] = useState<number[]>([])
  const [askHighlight, setAskHighlight] = useState(0)
  const [askText, setAskText] = useState('')
  const lastCtrlC = useRef(0)
  /** 可切换模型列表：进程内静态，取一次即可。 */
  const models = useMemo(() => runtime.listModels(), [runtime])

  const askQuestions = question?.questions ?? (question !== null ? [question] : [])
  const currentQuestion = askQuestions[askIndex]

  // 卡片换人（或消失）时复位对应的本地状态。
  useEffect(() => setApprovalExpanded(false), [approval?.id])
  useEffect(() => {
    setPlanExpanded(false)
    setPlanFeedback(false)
  }, [plan?.file, plan?.title])
  useEffect(() => {
    setAskIndex(0)
    setAskChecked([])
    setAskHighlight(0)
    setAskText('')
  }, [question?.id])

  /** 提问卡推进到下一题（最后一题交出后服务收卡，本地进度直接归零）。 */
  const advanceAsk = (): void => {
    setAskChecked([])
    setAskHighlight(0)
    setAskText('')
    setAskIndex((current) => (current + 1 < askQuestions.length ? current + 1 : 0))
  }

  /** 交出当前题的答案：有自由文本用文本，否则按勾选（多选）或高亮（单选）。 */
  const submitAsk = (raw: string): void => {
    if (question === null || currentQuestion === undefined) return
    let answer = raw.trim()
    if (answer === '') {
      if (currentQuestion.multiSelect) {
        const labels = askChecked
          .map((position) => currentQuestion.options[position]?.label)
          .filter((label): label is string => label !== undefined)
        if (labels.length === 0) return
        answer = labels.join('、')
      } else {
        const option = currentQuestion.options[askHighlight]
        if (option === undefined) return
        answer = option.label
      }
    }
    runtime.answerQuestion(answer)
    advanceAsk()
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      if (now - lastCtrlC.current < EXIT_WINDOW_MS) {
        runtime.exit()
        return
      }
      lastCtrlC.current = now
      if (snapshot.status.turnState !== 'idle') runtime.interrupt()
      else setNotice('再按一次 Ctrl+C 退出')
      return
    }
    if (approval !== null) {
      if (input === 'y' || input === 'Y') runtime.answerApproval('allow-once')
      else if (input === 'a' || input === 'A') {
        if (approval.scopes.includes('session')) runtime.answerApproval('allow-session')
      } else if (input === 'p' || input === 'P') {
        if (approval.scopes.includes('always')) runtime.answerApproval('allow-always')
      } else if (input === 'n' || input === 'N' || key.escape) runtime.answerApproval('reject')
      else if ((input === 'v' || input === 'V') && approval.diff !== undefined)
        setApprovalExpanded((current) => !current)
      return
    }
    if (question !== null) {
      const optionCount = currentQuestion?.options.length ?? 0
      if (key.upArrow) {
        setAskHighlight((current) => Math.max(0, current - 1))
      } else if (key.downArrow) {
        setAskHighlight((current) => Math.min(optionCount - 1, current + 1))
      } else if (key.escape) {
        runtime.answerQuestion(SKIPPED_ANSWER)
        advanceAsk()
      } else if (key.return) {
        submitAsk(askText)
      } else if (key.backspace || key.delete) {
        setAskText((current) => current.slice(0, -1))
      } else if (input === ' ' && optionCount > 0 && currentQuestion !== undefined) {
        // 空格在选择题里是「选定/勾选」；有自由文本需求时打字即可（数字不占用）。
        if (currentQuestion.multiSelect) {
          setAskChecked((current) =>
            current.includes(askHighlight)
              ? current.filter((position) => position !== askHighlight)
              : [...current, askHighlight],
          )
        } else {
          const option = currentQuestion.options[askHighlight]
          if (option !== undefined) {
            runtime.answerQuestion(option.label)
            advanceAsk()
          }
        }
      } else if (!key.ctrl && !key.meta && !key.tab) {
        const printable = input.replace(/[\r\n]+/g, '')
        if (printable !== '') setAskText((current) => current + printable)
      }
      return
    }
    if (planFeedback) {
      // 反馈文本由 Composer 承接（Enter 走 handleSubmit），这里只管 Esc 收摊。
      if (key.escape) setPlanFeedback(false)
      return
    }
    if (plan !== null) {
      if (input === 'y' || input === 'Y') runtime.answerPlan('approved')
      else if (input === 'n' || input === 'N' || key.escape) runtime.answerPlan('rejected')
      else if (input === 'e' || input === 'E') setPlanFeedback(true)
      else if (input === 'v' || input === 'V') setPlanExpanded((current) => !current)
      return
    }
    if (picker) {
      if (key.escape) setPicker(false)
      else if (key.return) {
        const session = snapshot.sessions[pickerIndex]
        setPicker(false)
        if (session !== undefined) void runtime.openSession(session.id)
      } else if (key.upArrow) setPickerIndex((current) => Math.max(0, current - 1))
      else if (key.downArrow)
        setPickerIndex((current) => Math.min(snapshot.sessions.length - 1, current + 1))
      return
    }
    if (key.ctrl && input === 't') {
      setExpandThinking((current) => !current)
      return
    }
  })

  const handleSubmit = (text: string): void => {
    setNotice(null)
    if (planFeedback) {
      setPlanFeedback(false)
      if (text !== '') runtime.answerPlan('rejected', text)
      return
    }
    if (text.startsWith('/')) {
      runCommand(text, runtime, {
        openPicker: () => {
          setPicker(true)
          setPickerIndex(0)
          void runtime.refreshSessions()
        },
        notice: setNotice,
      })
      return
    }
    runtime.submit(text)
  }

  const modal =
    approval !== null || question !== null || picker || (plan !== null && !planFeedback)

  return (
    <Box flexDirection="column" width="100%" gap={GAP.none}>
      <ChatView
        entries={snapshot.entries}
        turnState={snapshot.status.turnState}
        expandThinking={expandThinking}
      />
      {approval !== null ? (
        <ApprovalCard request={approval} expanded={approvalExpanded} />
      ) : null}
      {approval === null && question !== null ? (
        <AskCard
          ask={question}
          index={askIndex}
          checked={askChecked}
          highlight={askHighlight}
          text={askText}
        />
      ) : null}
      {approval === null && question === null && plan !== null ? (
        <PlanReviewCard plan={plan} expanded={planExpanded} feedbacking={planFeedback} />
      ) : null}
      {notice !== null ? (
        <Box borderStyle="single" borderColor={BORDER.frame} paddingX={PAD.inline} marginTop={GAP.tight}>
          <Text {...TEXT.label} color={STATUS_COLOR.waiting}>
            {notice}
          </Text>
        </Box>
      ) : null}
      {picker ? (
        <SessionPicker
          sessions={snapshot.sessions}
          loading={snapshot.sessionsLoading}
          index={pickerIndex}
          onIndex={setPickerIndex}
        />
      ) : (
        <Composer
          disabled={modal}
          models={models}
          placeholder={planFeedback ? '反馈原话（Enter 退回计划，Esc 取消）' : undefined}
          completionsEnabled={!planFeedback}
          onSubmit={handleSubmit}
        />
      )}
      <StatusBar status={snapshot.status} />
    </Box>
  )
}
