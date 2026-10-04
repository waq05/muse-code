/**
 * 顶层界面：快照订阅（useSyncExternalStore）+ 键盘路由 + 鼠标层 + 恒定帧布局。
 *
 * 布局（0.6.56）：根盒高度恒为「终端行数 − 1」并 overflow hidden——ink 的帧写带尾随
 * 换行，帧高一旦随内容变化终端就会滚动（「↑↓ 跳回底部」的根源）；固定帧之后任何
 * 状态下重绘都从屏顶原位擦写、零滚动。聊天区是 flexGrow 的滚动视口：底对齐、老的
 * 条目从顶上裁掉（只丢历史不丢最新），滚轮 / PgUp·PgDn 以条为单位回看，滚动时在
 * 输入框上方挂一条可点击的「回到底部」提示；选择器与模型浮层独占整屏、列表行与
 * 屏幕行一一对应，点击即命中。
 *
 * 键盘优先级：Ctrl+C（打断/退出）→ 审批卡（四档）→ 提问卡（模态作答）→ 计划反馈
 * 输入 → 计划评审卡（批准/拒绝/带反馈）→ 回看浮层（Ctrl+O）→ 会话选择器（含筛选
 * 输入与 Ctrl 组合动作）→ 模型浮层 → Esc 打断 → PgUp/PgDn 滚动 → Ctrl+O/Ctrl+T →
 * 其余交给 Composer（↑↓ 在输入框里仍是历史回忆，对齐 dsh-TUI）。
 *
 * 鼠标（0.6.56）：进程存活期间开启 SGR 跟踪（DECSET 1000+1006），卸载时关闭。
 * ink 的按键解析不认识 SGR 序列，剥掉 ESC 头后以 `'[<b;x;yM|m'` 原样进 useInput——
 * 在最顶层拦截：滚轮按状态路由（浮层/聊天/两个选择器）；左键点击派发给命中区注册表
 * （卡片页脚按钮、提问选项、回底提示条——组件用 yoga 绝对行自报几何，见 click.ts），
 * 列表则用构造行号直接映射。跟踪开着时终端原生选区要走 Shift+拖拽，全终端 TUI 通例。
 *
 * @module dsc-tui/app/App
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { DOMElement } from 'ink'
import type { JSX } from 'react'
import type {
  ArchivedSessionView,
  DscRuntime,
  SessionSummary,
} from '../contract.js'
import { runCommand } from '../plugins/commands.js'
import { absoluteTop, measuredHeight, useClickRegion, type ClickEntry, type RegisterClick } from './click.js'
import { ApprovalCard, type ApprovalAction } from './ApprovalCard.js'
import { AskCard, SKIPPED_ANSWER } from './AskCard.js'
import { ChatView } from './ChatView.js'
import { Composer, type DirLister } from './Composer.js'
import { ModelPicker } from './ModelPicker.js'
import { PlanReviewCard, type PlanAction } from './PlanReviewCard.js'
import { SessionPicker } from './SessionPicker.js'
import { StatusBar } from './StatusBar.js'
import { TaskStrips } from './TaskStrips.js'
import { TranscriptOverlay } from './TranscriptOverlay.js'
import { extractImages } from './attach.js'
import { BORDER, GAP, PAD, STATUS_COLOR, TEXT } from './theme.js'

/** 双击 Ctrl+C 的判定窗口。 */
const EXIT_WINDOW_MS = 2000
/** 聊天视口一次渲染的条目窗口（帧内放不下会被裁掉，窗口只约束 reconcile 量）。 */
const CHAT_WINDOW = 80
/** 回看浮层的条目窗口（全量 transcript，窗口随滚动偏移滑动）。 */
const OVERLAY_WINDOW = 200
/** 选择器框的固定行数：上下边框 2 + 标题 1 + 筛选行 1 + 提示行 1（改名行与提示行 1:1 互换）。 */
const PICKER_CHROME = 5

/** 「已离开最新」提示条：整行可点，点了回到底部。 */
function TailIndicator({
  hidden,
  onJump,
  registerClick,
}: {
  hidden: number
  onJump: () => void
  registerClick: RegisterClick | undefined
}): JSX.Element {
  const ref = useRef<DOMElement | null>(null)
  useClickRegion(ref, registerClick, (col, row, top, height) => {
    if (row < top || row >= top + height) return false
    onJump()
    return true
  })
  return (
    <Box ref={ref} borderStyle="single" borderColor={BORDER.frame} paddingX={PAD.inline} marginTop={GAP.tight}>
      <Text {...TEXT.label} color={STATUS_COLOR.pending} wrap="truncate-end">
        ⇡ 已回看历史，下方有 {hidden} 条新内容 · 点击本行或 PgDn 回到底部
      </Text>
    </Box>
  )
}

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
  /** 聊天滚动锚点：窗口末端的条目下标；null = 跟随最新（直播态）。 */
  const [chatAnchor, setChatAnchor] = useState<number | null>(null)
  /** Composer 补全面板开合（Esc 打断与「关面板」的分流依据）。 */
  const [panelOpen, setPanelOpen] = useState(false)
  // ---- 会话选择器：页 / 筛选 / 改名 / 删除确认 ----
  const [pickerPage, setPickerPage] = useState<'active' | 'archived'>('active')
  const [archivedList, setArchivedList] = useState<ArchivedSessionView[]>([])
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerBuffer, setPickerBuffer] = useState<string | null>(null)
  const [pickerArmed, setPickerArmed] = useState(false)
  /** 模型选择浮层（/model 无参数打开；输入即筛选）。 */
  const [modelPicker, setModelPicker] = useState(false)
  const [modelIndex, setModelIndex] = useState(0)
  const [modelQuery, setModelQuery] = useState('')
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
  /** 卡片/提示条的点击命中注册表（组件登记判定函数，几何在点击时现量，见 click.ts）。 */
  const clickRegions = useRef(new Set<ClickEntry>())
  const registerClick = useCallback<RegisterClick>((region) => {
    clickRegions.current.add(region)
    return () => {
      clickRegions.current.delete(region)
    }
  }, [])

  const askQuestions = question?.questions ?? (question !== null ? [question] : [])
  const currentQuestion = askQuestions[askIndex]

  /** 模型浮层的筛选结果（value/description 子串匹配）。 */
  const modelList = useMemo(() => {
    const q = modelQuery.trim().toLowerCase()
    if (q === '') return models
    return models.filter(
      (choice) =>
        choice.value.toLowerCase().includes(q) || choice.description.toLowerCase().includes(q),
    )
  }, [models, modelQuery])

  /** 回合跑动 → 空闲时响一声 BEL：长任务跑完人不在终端前也能听见。 */
  const previousTurn = useRef(snapshot.status.turnState)
  useEffect(() => {
    const current = snapshot.status.turnState
    const wasActive = previousTurn.current !== 'idle'
    previousTurn.current = current
    if (wasActive && current === 'idle') {
      try {
        stdout?.write('\x07')
      } catch {
        // 管道里写不进去就算了，提示音是锦上添花
      }
    }
  }, [snapshot.status.turnState, stdout])

  // 鼠标跟踪全时开启（SGR 点击/滚轮；不启用 1002/1003——拖拽选区留给终端原生行为）。
  useEffect(() => {
    stdout?.write('\x1b[?1000;1006h')
    return () => {
      try {
        stdout?.write('\x1b[?1000;1006l')
      } catch {
        // 卸载收尾时写不进就放弃，别让退出路径再抛错
      }
    }
  }, [stdout])

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

  // ---- 恒定帧与各视口的窗口切片 ----
  const termRows = stdout?.rows ?? 24
  /** 帧内容行数：终端行数 − 1（ink 帧自带尾随换行，末行留给光标落点）。 */
  const frameRows = Math.max(1, termRows - 1)
  /** 状态栏行数：描边 2 + 两行内容；有后台会话时第三行状态点。 */
  const statusbarLines = 4 + (Object.keys(snapshot.sessionStates).length > 0 ? 1 : 0)
  /** 选择器列表窗口：框内除固定框架外全部让给列表（点击行号映射按它 1:1 对齐）。 */
  const pickerListRows = Math.min(
    Math.max(pickerList.length, 0),
    Math.max(1, frameRows - statusbarLines - PICKER_CHROME),
  )
  /** 窗口起点：选中项尽量居中（fzf 式），两端夹住；列表放得下时等于 0。 */
  const pickerStart = Math.min(
    Math.max(0, pickerIndex - Math.floor((pickerListRows - 1) / 2)),
    Math.max(0, pickerList.length - pickerListRows),
  )
  const visibleSessions = pickerList.slice(pickerStart, pickerStart + pickerListRows)

  /** 聊天窗口：末端锚在 chatAnchor（null = 跟最新），窗口向历史方向展开。 */
  const chatEnd = Math.min(chatAnchor ?? snapshot.entries.length, snapshot.entries.length)
  const chatWindow = snapshot.entries.slice(Math.max(0, chatEnd - CHAT_WINDOW), chatEnd)

  /** 回看浮层的窗口（offset 是从尾部往回的条数）。 */
  const overlayTotal = snapshot.entries.length
  const overlayEnd = Math.max(1, overlayTotal - Math.min(scrollOffset, Math.max(0, overlayTotal - 1)))
  const overlayStart = Math.max(0, overlayEnd - OVERLAY_WINDOW)
  const overlayWindow = snapshot.entries.slice(overlayStart, overlayEnd)

  /** 聊天回看滚动：delta 负数往历史翻，翻到最底（end=len）就回到直播态。 */
  const scrollChat = (delta: number): void => {
    setChatAnchor((current) => {
      const length = snapshot.entries.length
      const end = Math.min(current ?? length, length)
      const next = end + delta
      return next >= length ? null : Math.max(0, next)
    })
  }

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

  /** 打开当前选中会话（Enter 与「点击已选中行」共用）：归档页先恢复回活动区再打开。 */
  const openSelectedSession = (): void => {
    const selected = pickerList[pickerIndex]
    if (selected === undefined) return
    setPicker(false)
    setChatAnchor(null)
    if (pickerPage === 'archived') {
      pickerAction(() => runtime.restoreSessions([selected.id]))
      void runtime.openSession(selected.id)
    } else {
      void runtime.openSession(selected.id)
    }
  }

  /** 应用当前选中的模型（Enter 与「点击已选中项」共用）。 */
  const applyModel = (): void => {
    const choice = modelList[modelIndex]
    if (choice === undefined) return
    setModelPicker(false)
    void runtime.setModel(choice.value)
  }

  // ---- 卡片鼠标动作（与按键一一等价；键盘路由仍是唯一真源，这里只是映射）----
  const handleApprovalAction = (action: ApprovalAction): void => {
    if (approval === null) return
    if (action === 'allow-once') runtime.answerApproval('allow-once')
    else if (action === 'allow-session') {
      if (approval.scopes.includes('session')) runtime.answerApproval('allow-session')
    } else if (action === 'allow-always') {
      if (approval.scopes.includes('always')) runtime.answerApproval('allow-always')
    } else if (action === 'reject') runtime.answerApproval('reject')
    else if (action === 'toggle-diff') setApprovalExpanded((current) => !current)
  }

  const handlePlanAction = (action: PlanAction | 'toggle'): void => {
    if (action === 'approve') runtime.answerPlan('approved')
    else if (action === 'reject') runtime.answerPlan('rejected')
    else if (action === 'feedback') setPlanFeedback(true)
    else if (action === 'toggle') setPlanExpanded((current) => !current)
  }

  const handleAskOption = (option: number): void => {
    if (question === null || currentQuestion === undefined) return
    if (currentQuestion.multiSelect) {
      setAskChecked((current) =>
        current.includes(option)
          ? current.filter((position) => position !== option)
          : [...current, option],
      )
      return
    }
    const chosen = currentQuestion.options[option]
    if (chosen === undefined) return
    runtime.answerQuestion(chosen.label)
    advanceAsk()
  }

  useInput((input, key) => {
    // SGR 鼠标事件最顶层拦截：滚轮按状态路由，左键点击派发给命中区。
    const mouse = /^\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input)
    if (mouse !== null) {
      const [, button, colText, rowText, phase] = mouse
      const col = Number(colText)
      const row = Number(rowText)
      if (button === '64' || button === '65') {
        // 滚轮：64 上 / 65 下，一步一条（浮层/聊天同款颗粒度）。
        const step = button === '64' ? -1 : 1
        if (picker) {
          setPickerIndex((current) => Math.max(0, Math.min(current + step, pickerList.length - 1)))
        } else if (modelPicker) {
          setModelIndex((current) => Math.max(0, Math.min(current + step, modelList.length - 1)))
        } else if (transcriptOpen) {
          const maxOffset = Math.max(0, snapshot.entries.length - 1)
          setScrollOffset((current) => Math.max(0, Math.min(current - step, maxOffset)))
        } else {
          scrollChat(step)
        }
        return
      }
      if (button !== '0' || phase !== 'M') return // 只认左键按下；释放与右/中键忽略
      if (picker) {
        if (pickerBuffer !== null) return // 改名输入态不响应鼠标
        // 列表行从「顶边框+标题+筛选行」之后起排（改名行再往下顺延一行）。
        const listTop = 3 + (pickerBuffer !== null ? 1 : 0)
        const row0 = row - 1 - listTop
        if (row0 < 0 || row0 >= pickerListRows) return
        const hit = pickerStart + row0
        if (hit === pickerIndex) openSelectedSession()
        else setPickerIndex(hit)
        return
      }
      if (modelPicker) {
        const row0 = row - 1 - 3
        if (row0 < 0 || row0 >= modelList.length) return
        if (row0 === modelIndex) applyModel()
        else setModelIndex(row0)
        return
      }
      // 卡片页脚按钮 / 提问选项 / 回底提示条：点击时现量几何（避免节流渲染导致的
      // 滞后），再询问判定函数；谁命中谁消费。
      for (const entry of clickRegions.current) {
        const top = absoluteTop(entry.node.current)
        const height = measuredHeight(entry.node.current)
        if (top === null || height === null) continue
        if (entry.hit(col - 1, row - 1, top, height)) return
      }
      return
    }
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
      const maxOffset = Math.max(0, snapshot.entries.length - 1)
      if (key.escape || input === 'q' || (key.ctrl && input === 'o')) setTranscriptOpen(false)
      else if (key.upArrow || input === 'k')
        setScrollOffset((current) => Math.min(maxOffset, current + 1))
      else if (key.downArrow || input === 'j')
        setScrollOffset((current) => Math.max(0, current - 1))
      else if (key.pageUp) setScrollOffset((current) => Math.min(maxOffset, current + 10))
      else if (key.pageDown) setScrollOffset((current) => Math.max(0, current - 10))
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
        openSelectedSession()
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
    if (modelPicker) {
      if (key.escape) setModelPicker(false)
      else if (key.return) {
        applyModel()
      } else if (key.upArrow) setModelIndex((current) => Math.max(0, current - 1))
      else if (key.downArrow)
        setModelIndex((current) => Math.min(modelList.length - 1, current + 1))
      else if (key.backspace || key.delete) {
        setModelQuery((current) => current.slice(0, -1))
        setModelIndex(0)
      } else if (!key.ctrl && !key.meta) {
        const printable = input.replace(/[\r\n\t]+/g, '')
        if (printable !== '') {
          setModelQuery((current) => current + printable)
          setModelIndex(0)
        }
      }
      return
    }
    // 空闲无浮层：Esc 打断当前回合（对齐 codex / dsh）。补全面板开着时 Esc 只关面板。
    if (key.escape && !panelOpen && snapshot.status.turnState !== 'idle') {
      runtime.interrupt()
      return
    }
    // 聊天回看（对齐 codex 的 PgUp/PgDn；滚轮同义，↑↓ 留给输入框历史）。
    if (key.pageUp) {
      scrollChat(-10)
      return
    }
    if (key.pageDown) {
      scrollChat(10)
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
    setChatAnchor(null)
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
        openModels: () => {
          setModelPicker(true)
          setModelIndex(0)
          setModelQuery('')
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
    modelPicker ||
    (plan !== null && !planFeedback)

  return (
    <Box height={frameRows} width="100%" flexDirection="column" overflow="hidden">
      {picker ? (
        <SessionPicker
          sessions={visibleSessions}
          total={pickerList.length}
          start={pickerStart}
          index={pickerIndex}
          page={pickerPage}
          query={pickerQuery}
          buffer={pickerBuffer}
          armed={pickerArmed}
          loading={snapshot.sessionsLoading}
          sessionStates={snapshot.sessionStates}
        />
      ) : transcriptOpen ? (
        <TranscriptOverlay entries={overlayWindow} start={overlayStart} total={overlayTotal} />
      ) : modelPicker ? (
        <ModelPicker models={modelList} index={modelIndex} query={modelQuery} />
      ) : (
        <>
          <Box flexDirection="column" flexGrow={1} overflowY="hidden" justifyContent="flex-end">
            <ChatView
              entries={chatWindow}
              turnState={snapshot.status.turnState}
              expandThinking={expandThinking}
              empty={snapshot.entries.length === 0}
            />
          </Box>
          <Box flexShrink={0} flexDirection="column">
            <TaskStrips goal={snapshot.surfaces.goal} todos={snapshot.surfaces.todos} />
            {approval !== null ? (
              <ApprovalCard
                request={approval}
                expanded={approvalExpanded}
                onAction={handleApprovalAction}
                registerClick={registerClick}
              />
            ) : null}
            {approval === null && question !== null ? (
              <AskCard
                ask={question}
                index={askIndex}
                checked={askChecked}
                highlight={askHighlight}
                text={askText}
                onOptionClick={handleAskOption}
                registerClick={registerClick}
              />
            ) : null}
            {approval === null && question === null && plan !== null ? (
              <PlanReviewCard
                plan={plan}
                expanded={planExpanded}
                feedbacking={planFeedback}
                onAction={handlePlanAction}
                registerClick={registerClick}
              />
            ) : null}
            {notice !== null ? (
              <Box borderStyle="single" borderColor={BORDER.frame} paddingX={PAD.inline} marginTop={GAP.tight}>
                <Text {...TEXT.label} color={STATUS_COLOR.waiting}>
                  {notice}
                </Text>
              </Box>
            ) : null}
            {chatAnchor !== null ? (
              <TailIndicator
                hidden={snapshot.entries.length - chatEnd}
                onJump={() => setChatAnchor(null)}
                registerClick={registerClick}
              />
            ) : null}
            <Composer
              disabled={modal}
              models={models}
              placeholder={planFeedback ? '反馈原话（Enter 退回计划，Esc 取消）' : undefined}
              completionsEnabled={!planFeedback}
              lister={dockLister}
              onPanelOpenChange={setPanelOpen}
              onSubmit={handleSubmit}
            />
          </Box>
        </>
      )}
      <Box flexShrink={0}>
        <StatusBar
          status={snapshot.status}
          surfaces={snapshot.surfaces}
          sessionStates={snapshot.sessionStates}
        />
      </Box>
    </Box>
  )
}
