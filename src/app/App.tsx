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
import { ModelPicker } from './ModelPicker.js'
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

  // ---- 选择器整屏几何（0.6.55）：帧高精确凑满「终端行数 − 1」----
  // 以前列表全量渲染、聊天流也还挂在画面里，帧比终端高——ink 每次重绘都把画面顶回
  // 底部（↑↓ 每敲一键就跳底）。选择器打开时让它独占整屏：ink 的帧带一个尾随换行
  //（光标停帧尾下一行），内容写满终端行数时那个换行每次重绘都滚一行，所以凑的是
  //「行数 − 1」：内容贴屏顶、末行留给光标，重绘永远从顶行擦写，一次滚动都不发生；
  // 屏幕行与帧行一一对应，鼠标点击的行号映射因此是纯构造计算（对齐 codex / dsh-TUI
  // 整屏浮层的做法，但不进 alternate screen、不 fork ink）。所有块行数都是构造的：
  // 行内文本一律截断保证不折行。
  const termRows = stdout?.rows ?? 24
  /** 帧内容可用行数：终端行数 − 1（末行是 ink 帧尾随换行的光标落点）。 */
  const frameRows = Math.max(1, termRows - 1)
  /** 状态栏行数：描边 2 + 两行内容；有后台会话时第三行状态点。 */
  const statusbarLines = 4 + (Object.keys(snapshot.sessionStates).length > 0 ? 1 : 0)
  /** 提示条（单行文本的描边框）行数，选择器打开时才参与凑帧。 */
  const noticeLines = notice !== null ? 3 : 0
  /** 空列表占位行（「没有匹配的会话」）。 */
  const emptyLines = pickerList.length === 0 && !snapshot.sessionsLoading ? 1 : 0
  /** 选择器框固定行数：外边距 1 + 描边 2 + 标题 1 + 筛选行 1 + 提示行 1（改名时提示行换改名行，净 0）。 */
  const pickerFixedLines = 6
  /** 列表窗口行数：除固定框架外全部让给列表；终端矮到连框架都放不下时保底 1 行。 */
  const maxListRows = Math.max(1, frameRows - statusbarLines - noticeLines - emptyLines - pickerFixedLines)
  const listRows = Math.min(pickerList.length, maxListRows)
  /** 窗口起点：选中项尽量居中（fzf 式），两端夹住；列表放得下时等于 0。 */
  const pickerStart = Math.min(
    Math.max(0, pickerIndex - Math.floor((listRows - 1) / 2)),
    Math.max(0, pickerList.length - listRows),
  )
  const visibleSessions = pickerList.slice(pickerStart, pickerStart + listRows)
  /** 列表上方的填充行：短列表时把选择器框压到屏幕底，帧高才恰好凑满。 */
  const pickerFiller = Math.max(
    0,
    frameRows - statusbarLines - noticeLines - (pickerFixedLines + listRows + emptyLines),
  )

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

  // 鼠标跟踪（DECSET 1000+1006，SGR 编码）只跟选择器同开同关：终端这时才上报
  // 点击/滚轮（\x1b[<b;x;yM 按下、…m 释放）。ink 的 keypress 解析器不认识这个
  // 序列，剥掉 ESC 头后原样送进 useInput（input='[<b;x;yM'、无任何键位标志）——
  // 在键盘路由最顶层拦截。跟踪开着时终端原生前缀选区要走 Shift+拖拽，这是
  // 全终端 TUI 的统一取舍；关闭后立即还原，聊天态完全不受影响。
  useEffect(() => {
    if (!picker) return
    stdout?.write('\x1b[?1000;1006h')
    return () => {
      try {
        stdout?.write('\x1b[?1000;1006l')
      } catch {
        // 卸载收尾时写不进就放弃，别让退出路径再抛错
      }
    }
  }, [picker, stdout])

  /** 打开当前选中会话（Enter 与「点击已选中行」共用）：归档页先恢复回活动区再打开。 */
  const openSelectedSession = (): void => {
    const selected = pickerList[pickerIndex]
    if (selected === undefined) return
    setPicker(false)
    if (pickerPage === 'archived') {
      pickerAction(() => runtime.restoreSessions([selected.id]))
      void runtime.openSession(selected.id)
    } else {
      void runtime.openSession(selected.id)
    }
  }

  useInput((input, key) => {
    // SGR 鼠标事件最顶层拦截（选择器开着时终端才上报；ink 传进来的形状是 '[<b;x;yM|m'）。
    const mouse = /^\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input)
    if (mouse !== null) {
      if (!picker || pickerBuffer !== null) return // 改名输入态不响应鼠标
      const [, button, , row, phase] = mouse
      if (button === '64' || button === '65') {
        // 滚轮：与 ↑↓ 同义，窗口由居中规则自动跟随。
        const step = button === '64' ? -1 : 1
        setPickerIndex((current) => Math.max(0, Math.min(current + step, pickerList.length - 1)))
        return
      }
      if (button !== '0' || phase !== 'M') return // 只认左键按下；释放与右/中键忽略
      // 点击行 → 列表下标：帧内容 = 终端行数 − 1 且从屏顶排，从内容底往上数
      //（状态栏 + 底描边 + 提示行）再加窗口内余行；落到框外（标题/筛选/状态栏）无效。
      const listTop = frameRows - statusbarLines - 1 - (pickerBuffer !== null ? 0 : 1) - listRows
      const row0 = Number(row) - 1 - listTop
      if (row0 < 0 || row0 >= listRows) return
      const hit = pickerStart + row0
      if (hit === pickerIndex) openSelectedSession()
      else setPickerIndex(hit)
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
        const choice = modelList[modelIndex]
        if (choice !== undefined) {
          setModelPicker(false)
          void runtime.setModel(choice.value)
        }
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
    <Box flexDirection="column" width="100%" gap={GAP.none}>
      {picker ? (
        // 整屏选择器：遮掉聊天流/任务条/卡片（surface 状态原样保留，关掉即回来），
        // 帧高精确凑满终端行数——重绘零滚动，鼠标命中的几何也靠它成立。
        <>
          {notice !== null ? (
            <Box borderStyle="single" borderColor={BORDER.frame} paddingX={PAD.inline}>
              <Text {...TEXT.label} color={STATUS_COLOR.waiting} wrap="truncate-end">
                {notice}
              </Text>
            </Box>
          ) : null}
          <Box height={pickerFiller} />
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
        </>
      ) : (
        <>
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
          {modelPicker ? (
            <ModelPicker models={modelList} index={modelIndex} query={modelQuery} />
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
        </>
      )}
      <StatusBar
        status={snapshot.status}
        surfaces={snapshot.surfaces}
        sessionStates={snapshot.sessionStates}
      />
    </Box>
  )
}
