/**
 * 顶层界面：快照订阅（useSyncExternalStore）+ 键盘路由。
 *
 * 键盘优先级：Ctrl+C（打断/退出）→ 审批卡（四档）→ 提问卡（模态作答）→ 计划反馈
 * 输入 → 计划评审卡（批准/拒绝/带反馈）→ 回看浮层（Ctrl+O）→ 会话选择器（含筛选
 * 输入与 Ctrl 组合动作）→ Esc 打断 → Ctrl+O/Ctrl+T → 其余交给 Composer。
 * 卡片（审批/提问/计划卡/选择器/浮层）打开时 Composer 置 disabled；唯一的例外是
 * 计划「带反馈退回」——Composer 临时切成反馈输入框，Enter 提交、Esc 取消。
 *
 * @module dsc-tui/app/App
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { JSX } from 'react'
import type {
  ArchivedSessionView,
  DscRuntime,
  SessionSummary,
} from '../contract.js'
import { runCommand } from '../plugins/commands.js'
import { ApprovalCard } from './ApprovalCard.js'
import { AskCard, SKIPPED_ANSWER } from './AskCard.js'
import { ChatView } from './ChatView.js'
import { Composer, type DirLister } from './Composer.js'
import { PlanReviewCard } from './PlanReviewCard.js'
import { SessionPicker } from './SessionPicker.js'
import { StatusBar } from './StatusBar.js'
import { TaskStrips } from './TaskStrips.js'
import { TranscriptOverlay } from './TranscriptOverlay.js'
import { extractImages } from './attach.js'
import { BORDER, GAP, PAD, STATUS_COLOR, TEXT } from './theme.js'

/** 双击 Ctrl+C 的判定窗口。 */
const EXIT_WINDOW_MS = 2000

export function App({ runtime }: { runtime: DscRuntime }): JSX.Element {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
  const approval = snapshot.surfaces.pendingApproval
  const question = snapshot.surfaces.pendingQuestion
  const plan = snapshot.surfaces.pendingPlan
  const { stdout } = useStdout()
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
  /** 回看浮层（Ctrl+O）：offset 是「从尾部往回滚的条数」。 */
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [scrollOffset, setScrollOffset] = useState(0)
  /** Composer 补全面板开合（Esc 打断与「关面板」的分流依据）。 */
  const [panelOpen, setPanelOpen] = useState(false)
  // ---- 会话选择器：页 / 筛选 / 改名 / 删除确认 ----
  const [pickerPage, setPickerPage] = useState<'active' | 'archived'>('active')
  const [archivedList, setArchivedList] = useState<ArchivedSessionView[]>([])
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerBuffer, setPickerBuffer] = useState<string | null>(null)
  const [pickerArmed, setPickerArmed] = useState(false)
  const lastCtrlC = useRef(0)
  /** 可切换模型列表：进程内静态，取一次即可。 */
  const models = useMemo(() => runtime.listModels(), [runtime])
  /** @ 提及补全的文件清单来源（dock 的 fs-list；不可用时补全退化为空）。 */
  const dockLister = useCallback<DirLister>(
    (dir) =>
      runtime.dock('fs-list', { dir: dir === '' ? '.' : dir }) as Promise<{
        entries: { name: string; dir: boolean }[]
      }>,
    [runtime],
  )

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

  // ---- 会话选择器的数据整形：置顶优先、最近更新在前，输入即筛选 ----
  const pickerList: SessionSummary[] = useMemo(() => {
    const source: SessionSummary[] =
      pickerPage === 'active'
        ? [...snapshot.sessions]
        : archivedList.map((item) => ({
            id: item.path,
            cwd: item.cwd,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            ...(item.title !== undefined ? { title: item.title } : {}),
          }))
    source.sort(
      (a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.updatedAt - a.updatedAt,
    )
    const q = pickerQuery.trim().toLowerCase()
    if (q === '') return source
    return source.filter(
      (session) =>
        (session.title ?? '').toLowerCase().includes(q) ||
        session.cwd.toLowerCase().includes(q) ||
        session.id.toLowerCase().includes(q),
    )
  }, [pickerPage, snapshot.sessions, archivedList, pickerQuery])

  /** 归档页的数据加载（Tab 切页时拉一次；动作之后刷新也走这里）。 */
  const reloadArchived = useCallback((): void => {
    void runtime
      .listArchivedSessions()
      .then((page) => setArchivedList(page.items))
      .catch(() => setArchivedList([]))
  }, [runtime])

  const togglePickerPage = (): void => {
    setPickerArmed(false)
    setPickerBuffer(null)
    setPickerIndex(0)
    setPickerQuery('')
    if (pickerPage === 'active') {
      setPickerPage('archived')
      reloadArchived()
    } else {
      setPickerPage('active')
      void runtime.refreshSessions()
    }
  }

  /** 选择器里的会话动作（改名/置顶/归档/恢复/删除/分叉）统一收口：跑完刷新 + 错误上屏。 */
  const pickerAction = (work: () => Promise<{ ok: boolean; error?: string } | void>): void => {
    void work()
      .then((result) => {
        if (result !== undefined && result.ok === false) setNotice(result.error ?? '操作失败')
        if (pickerPage === 'active') void runtime.refreshSessions()
        else reloadArchived()
      })
      .catch((cause: unknown) =>
        setNotice(cause instanceof Error ? cause.message : String(cause)),
      )
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
    if (transcriptOpen) {
      const termRows = stdout?.rows ?? 24
      const visible = Math.max(6, termRows - 8)
      const maxOffset = Math.max(0, snapshot.entries.length - visible)
      if (key.escape || input === 'q' || (key.ctrl && input === 'o')) setTranscriptOpen(false)
      else if (key.upArrow || input === 'k')
        setScrollOffset((current) => Math.max(0, Math.min(current, maxOffset) - 1))
      else if (key.downArrow || input === 'j')
        setScrollOffset((current) => Math.min(maxOffset, Math.min(current, maxOffset) + 1))
      else if (key.pageUp)
        setScrollOffset((current) => Math.max(0, Math.min(current, maxOffset) - visible))
      else if (key.pageDown)
        setScrollOffset((current) => Math.min(maxOffset, Math.min(current, maxOffset) + visible))
      return
    }
    if (picker) {
      const selected = pickerList[pickerIndex]
      // 改名态：输入行归改名缓冲
      if (pickerBuffer !== null) {
        if (key.escape) setPickerBuffer(null)
        else if (key.return) {
          if (selected !== undefined && pickerBuffer.trim() !== '') {
            const title = pickerBuffer.trim()
            pickerAction(() => runtime.renameSession(selected.id, title))
          }
          setPickerBuffer(null)
        } else if (key.backspace || key.delete) setPickerBuffer((current) => (current ?? '').slice(0, -1))
        else if (!key.ctrl && !key.meta) {
          const printable = input.replace(/[\r\n]+/g, '')
          if (printable !== '') setPickerBuffer((current) => (current ?? '') + printable)
        }
        return
      }
      if (key.escape) {
        if (pickerArmed) setPickerArmed(false)
        else setPicker(false)
        return
      }
      if (key.tab) {
        togglePickerPage()
        return
      }
      if (key.return) {
        if (selected !== undefined) {
          setPicker(false)
          if (pickerPage === 'archived') {
            // 归档会话先恢复回活动区再打开
            pickerAction(() => runtime.restoreSessions([selected.id]))
            void runtime.openSession(selected.id)
          } else {
            void runtime.openSession(selected.id)
          }
        }
        return
      }
      if (key.upArrow) {
        setPickerIndex((current) => Math.max(0, current - 1))
        return
      }
      if (key.downArrow) {
        setPickerIndex((current) => Math.min(pickerList.length - 1, current + 1))
        return
      }
      if (key.ctrl) {
        // 动作键全走 Ctrl 组合——普通字符留给筛选输入。
        if (input === 'r' && selected !== undefined) {
          setPickerBuffer(selected.title ?? '')
        } else if (input === 'p' && selected !== undefined) {
          const pinned = selected.pinnedAt !== undefined
          pickerAction(() => runtime.setSessionPinned(selected.id, !pinned))
        } else if (input === 'a' && pickerPage === 'active' && selected !== undefined) {
          pickerAction(() => runtime.archiveSessions([selected.id]))
        } else if (input === 'u' && pickerPage === 'archived' && selected !== undefined) {
          pickerAction(() => runtime.restoreSessions([selected.id]))
        } else if (input === 'x' && selected !== undefined) {
          if (pickerArmed) {
            setPickerArmed(false)
            pickerAction(() => runtime.purgeSessions([selected.id]))
          } else {
            setPickerArmed(true)
          }
        } else if (input === 'f' && selected !== undefined) {
          pickerAction(() =>
            runtime
              .listUserMessages(selected.id)
              .then((messages) => runtime.forkSession(selected.id, messages.length))
              .then((result) => {
                if (result.ok) {
                  setPicker(false)
                  void runtime.openSession(result.path)
                }
                return result.ok ? { ok: true } : { ok: false, error: '分叉失败' }
              }),
          )
        }
        return
      }
      // 普通字符：筛选输入
      if (key.backspace || key.delete) {
        setPickerQuery((current) => current.slice(0, -1))
        setPickerIndex(0)
        return
      }
      if (!key.meta) {
        const printable = input.replace(/[\r\n\t]+/g, '')
        if (printable !== '') {
          setPickerQuery((current) => current + printable)
          setPickerIndex(0)
          setPickerArmed(false)
        }
      }
      return
    }
    // 空闲无浮层：Esc 打断当前回合（对齐 codex / dsh）。补全面板开着时 Esc 只关面板。
    if (key.escape && !panelOpen && snapshot.status.turnState !== 'idle') {
      runtime.interrupt()
      return
    }
    if (key.ctrl && input === 't') {
      setExpandThinking((current) => !current)
      return
    }
    if (key.ctrl && input === 'o') {
      setScrollOffset(0)
      setTranscriptOpen(true)
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
          setPickerQuery('')
          setPickerPage('active')
          void runtime.refreshSessions()
        },
        notice: setNotice,
      })
      return
    }
    const attached = extractImages(text)
    if (attached.failed.length > 0) {
      setNotice(`图片读取失败（太大或 IO 错误）：${attached.failed.join('、')}`)
    }
    runtime.submit(attached.text, attached.images.length > 0 ? attached.images : undefined)
  }

  const modal =
    approval !== null ||
    question !== null ||
    picker ||
    transcriptOpen ||
    (plan !== null && !planFeedback)

  return (
    <Box flexDirection="column" width="100%" gap={GAP.none}>
      {transcriptOpen ? (
        <TranscriptOverlay
          entries={snapshot.entries}
          offset={scrollOffset}
          visible={Math.max(6, (stdout?.rows ?? 24) - 8)}
        />
      ) : (
        <ChatView
          entries={snapshot.entries}
          turnState={snapshot.status.turnState}
          expandThinking={expandThinking}
        />
      )}
      <TaskStrips goal={snapshot.surfaces.goal} todos={snapshot.surfaces.todos} />
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
          sessions={pickerList}
          loading={snapshot.sessionsLoading}
          index={pickerIndex}
          onIndex={setPickerIndex}
          page={pickerPage}
          query={pickerQuery}
          buffer={pickerBuffer}
          armed={pickerArmed}
          sessionStates={snapshot.sessionStates}
        />
      ) : (
        <Composer
          disabled={modal}
          models={models}
          placeholder={planFeedback ? '反馈原话（Enter 退回计划，Esc 取消）' : undefined}
          completionsEnabled={!planFeedback}
          lister={dockLister}
          onPanelOpenChange={setPanelOpen}
          onSubmit={handleSubmit}
        />
      )}
      <StatusBar
        status={snapshot.status}
        surfaces={snapshot.surfaces}
        sessionStates={snapshot.sessionStates}
      />
    </Box>
  )
}
