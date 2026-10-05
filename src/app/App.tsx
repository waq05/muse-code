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
 * 输入 → 计划评审卡（批准/拒绝/带反馈）→ 图片预览浮层 → 子代理浮层 → 回看浮层
 * （Ctrl+O）→ 会话选择器 → 模型/模式/技能浮层 → Esc（打断 / 双击撤回上一轮）→ PgUp/PgDn
 * 滚动 → Ctrl+O/Ctrl+T → 其余交给 Composer（↑↓ 在输入框里仍是历史回忆，对齐
 * dsh-TUI）。
 *
 * 鼠标（0.6.56）：进程存活期间开启 SGR 跟踪（DECSET 1000+1006），卸载时关闭。
 * ink 的按键解析不认识 SGR 序列，剥掉 ESC 头后以 `'[<b;x;yM|m'` 原样进 useInput——
 * 在最顶层拦截：滚轮按状态路由（浮层/聊天/两个选择器）；左键点击派发给命中区注册表
 * （卡片页脚按钮、提问选项、回底提示条、附件芯片、后台芯片、图片行——组件用 yoga
 * 绝对行自报几何，见 click.ts），列表则用构造行号直接映射。跟踪开着时终端原生选区
 * 要走 Shift+拖拽，全终端 TUI 通例。
 *
 * 光标停靠（0.6.57）：App 包一层 stdout.write，帧（含 `\x1b[2K`）写完追加一条
 * CUP 把物理光标送回 Composer 声明的 caret（cursor.ts）——Windows Terminal 的
 * IME 拼音预览因此画在输入框里；无声明时隐藏光标。
 *
 * @module dsc-tui/app/App
 */
import { spawn } from 'node:child_process'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { DOMElement } from 'ink'
import type { JSX } from 'react'
import type {
  ArchivedSessionView,
  DscRuntime,
  SessionSummary,
  SettingsField,
  SettingsSectionView,
  SettingsValue,
  SettingsValues,
  StatusBarPrefsView,
  TranscriptEntry,
} from '../contract.js'
import { DEFAULT_STATUS_BAR_PREFS, normalizeStatusBarPrefs } from '../contract.js'
import { runCommand } from '../plugins/commands.js'
import { AgentsOverlay, buildAgentRows } from './AgentsOverlay.js'
import { absoluteTop, measuredHeight, useClickRegion, type ClickEntry, type RegisterClick } from './click.js'
import { ApprovalCard, type ApprovalAction } from './ApprovalCard.js'
import { AskCard, SKIPPED_ANSWER } from './AskCard.js'
import { readClipboardImage, type ClipboardResult } from './clipboard-image.js'
import { ChatView } from './ChatView.js'
import { Composer, type ComposerAttachment, type DirLister } from './Composer.js'
import { renderImageBlock, type ImageSource } from './image-blocks.js'
import { ModelPicker } from './ModelPicker.js'
import { PlanReviewCard, type PlanAction } from './PlanReviewCard.js'
import { PresetPicker } from './PresetPicker.js'
import { PreviewOverlay } from './PreviewOverlay.js'
import { SessionPicker } from './SessionPicker.js'
import { SETTINGS_CHROME, SETTINGS_LIST_TOP, SettingsOverlay } from './SettingsOverlay.js'
import { SkillsPicker } from './SkillsPicker.js'
import {
  buildSettingsRows,
  focusableRows,
  isFocusableRow,
  settingsWindowStart,
  type SettingsGroupRef,
  type SettingsRow,
} from './settings-model.js'
import { shortId, StatusBar } from './StatusBar.js'
import { TaskStrips } from './TaskStrips.js'
import { TranscriptOverlay } from './TranscriptOverlay.js'
import { Welcome } from './Welcome.js'
import { extractImages, readImageAsDataUrl } from './attach.js'
import { BORDER, GAP, PAD, PALETTE, STATUS_COLOR, TEXT } from './theme.js'

/** 双击 Ctrl+C 的判定窗口。 */
const EXIT_WINDOW_MS = 2000
/** 双击 Esc 撤回上一轮的判定窗口（对齐 dsh 的 3 秒）。 */
const REWIND_WINDOW_MS = 3000
/** 聊天视口一次渲染的条目窗口（帧内放不下会被裁掉，窗口只约束 reconcile 量）。 */
const CHAT_WINDOW = 80
/** 回看浮层的条目窗口（全量 transcript，窗口随滚动偏移滑动）。 */
const OVERLAY_WINDOW = 200
/** 欢迎页只挂在短会话顶上（resume 长会话再画只是把历史往下顶，dsh skipIntro 同款）。 */
const WELCOME_MAX_ENTRIES = 30
/** 选择器框的固定行数：上下边框 2 + 标题 1 + 筛选行 1 + 提示行 1（改名行与提示行 1:1 互换）。 */
const PICKER_CHROME = 5

/** 工作区显示名：最后一段路径（dsh 会话总管的 rail 同款；盘根/空目录给兜底文案）。 */
const workspaceLabel = (cwd: string): string => {
  if (cwd === '') return '(无目录)'
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? cwd
  return base === '' ? cwd : base
}

/** 「已离开最新」提示条（0.6.59 对齐 dsh 的 pill）：蓝底深字，整枚可点回底。 */
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
    <Box ref={ref} marginTop={GAP.tight}>
      <Text backgroundColor={PALETTE.pillBg} color={PALETTE.pillText} bold>
        {' ↓ 回到底部（Enter/End）'}
        {hidden > 99 ? ` · ${hidden} 条新` : ''}
        {' '}
      </Text>
    </Box>
  )
}

export function App({
  runtime,
  clipboardReader,
  imageRenderer,
}: {
  runtime: DscRuntime
  /** 剪贴板读取（测试注入口；省略用 PowerShell 真实现）。 */
  clipboardReader?: () => Promise<ClipboardResult>
  /** 图片→半块字符画渲染（测试注入口；省略用 PowerShell 真实现）。 */
  imageRenderer?: typeof renderImageBlock
}): JSX.Element {
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
  /** ---- 0.6.57：双击 Esc 撤回 / 剪贴板贴图 / 子代理浮层 / 图片预览 ---- */
  /** 上一次 Esc 的时刻（撤回的 prime 判定；任何非 Esc 按键清零）。 */
  const lastEsc = useRef(0)
  /** Composer 草稿镜像（撤回要判断输入框是否为空；不进状态避免多余重渲染）。 */
  const draftRef = useRef('')
  /** 外部灌入 Composer 的草稿（token 变化即生效）。 */
  const [composerPreset, setComposerPreset] = useState<{ text: string; token: number }>({ text: '', token: 0 })
  /** 剪贴板贴图暂存的附件芯片。 */
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const attachmentSeq = useRef(0)
  /** 子代理浮层：名单 / 某个代理的只读转录（null = 关闭）。 */
  const [agentView, setAgentView] = useState<
    { mode: 'list' } | { mode: 'transcript'; file: string; title: string } | null
  >(null)
  const [agentEntries, setAgentEntries] = useState<TranscriptEntry[] | null>(null)
  const [agentIndex, setAgentIndex] = useState(0)
  /** 图片预览浮层（半块真彩；block 由 effect 现算）。 */
  const [preview, setPreview] = useState<{ title: string; sources: ImageSource[]; index: number } | null>(null)
  const [previewBlock, setPreviewBlock] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  // ---- 会话选择器：页 / 筛选 / 改名 / 删除确认 ----
  const [pickerPage, setPickerPage] = useState<'active' | 'archived'>('active')
  const [archivedList, setArchivedList] = useState<ArchivedSessionView[]>([])
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerBuffer, setPickerBuffer] = useState<string | null>(null)
  const [pickerArmed, setPickerArmed] = useState(false)
  /**
   * 两级导航（0.6.63 对齐 dsh 的会话总管）：已钻取的工作区 cwd；null = 工作区层。
   * 工作区只有一个时派生为「直落会话层」（pickerWorkspace 保持 null，Esc 直接关）。
   */
  const [pickerWorkspace, setPickerWorkspace] = useState<string | null>(null)
  /** 模型选择浮层（/model 无参数打开；输入即筛选）。 */
  const [modelPicker, setModelPicker] = useState(false)
  const [modelIndex, setModelIndex] = useState(0)
  const [modelQuery, setModelQuery] = useState('')
  /** 模式选择浮层（/preset 无参数打开，对齐 dsh 裸命令开 picker）。 */
  const [presetPicker, setPresetPicker] = useState(false)
  const [presetIndex, setPresetIndex] = useState(0)
  const [presetQuery, setPresetQuery] = useState('')
  /** 技能选择浮层（/skills 无参数打开；Enter 回填 /技能名 到输入行）。 */
  const [skillsPicker, setSkillsPicker] = useState(false)
  const [skillsIndex, setSkillsIndex] = useState(0)
  const [skillsQuery, setSkillsQuery] = useState('')
  /** ---- 0.6.61：设置页（/settings）---- 焦点/草稿/回执/滚动全在这组状态里。 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSections, setSettingsSections] = useState<SettingsSectionView[]>([])
  const [settingsValues, setSettingsValues] = useState<Record<string, SettingsValues>>({})
  /** 焦点在 focusables（可聚焦行号表）里的位置。 */
  const [settingsIndex, setSettingsIndex] = useState(0)
  const [settingsEdit, setSettingsEdit] = useState<{ sectionId: string; key: string; draft: string } | null>(null)
  const [settingsNotice, setSettingsNotice] = useState<{ ok: boolean; text: string } | null>(null)
  /** 当前展开的设置子页（null = 根页；dsh 式一层分组，Esc 先退子页再关页）。 */
  const [settingsGroup, setSettingsGroup] = useState<SettingsGroupRef | null>(null)
  /** 当前展开的分区页（0.6.64 两级导航：null = 根页只列分区名；组子页在分区页之下）。 */
  const [settingsSection, setSettingsSection] = useState<string | null>(null)
  /** 状态栏段显隐（0.6.62）：启动读一次 prefs，设置页改动后就地更新。 */
  const [statusBarPrefs, setStatusBarPrefs] = useState<StatusBarPrefsView>(DEFAULT_STATUS_BAR_PREFS)
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

  /** 模式投影（浮层开着才算：listPresets 是同步读盘）。 */
  const presetSurface = useMemo(
    () => (presetPicker ? runtime.listPresets() : null),
    [runtime, presetPicker],
  )
  /** 模式浮层的筛选结果（显示名/名字/说明子串匹配）。 */
  const presetList = useMemo(() => {
    if (presetSurface === null) return []
    const q = presetQuery.trim().toLowerCase()
    if (q === '') return presetSurface.options
    return presetSurface.options.filter(
      (preset) =>
        preset.label.toLowerCase().includes(q) ||
        preset.name.toLowerCase().includes(q) ||
        preset.description.toLowerCase().includes(q),
    )
  }, [presetSurface, presetQuery])

  /** 技能投影（浮层开着才算）。 */
  const skillsSurface = useMemo(
    () => (skillsPicker ? runtime.listSkills() : []),
    [runtime, skillsPicker],
  )
  /** 技能浮层的筛选结果（名字/描述/来源子串匹配）。 */
  const skillsList = useMemo(() => {
    const q = skillsQuery.trim().toLowerCase()
    if (q === '') return skillsSurface
    return skillsSurface.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.source.toLowerCase().includes(q),
    )
  }, [skillsSurface, skillsQuery])

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

  // 设置里的「思考块默认展开」是初值（0.6.61）：启动读一次，Ctrl+T 仍是会话内
  // 的临时开关。旧测试的 runtime mock 没有这个方法——缺了就静默跳过。
  useEffect(() => {
    if (typeof runtime.getUiPrefs !== 'function') return
    const prefs = runtime.getUiPrefs()
    if (prefs.reasoningDefaultOpen === true) setExpandThinking(true)
    // 状态栏段显隐（0.6.62）：缺键归一（老 mock / 老宿主）后装填。
    setStatusBarPrefs(normalizeStatusBarPrefs(prefs.statusBar))
  }, [runtime])

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

  /** Composer 草稿镜像（双击 Esc 撤回判断输入框是否为空）。 */
  const handleDraftChange = useCallback((text: string) => {
    draftRef.current = text
  }, [])

  // 图片预览的字符画现算：preview（含 index）一变就重渲染当前那张。
  useEffect(() => {
    if (preview === null) {
      setPreviewBlock(null)
      setPreviewError(null)
      setPreviewLoading(false)
      return
    }
    const source = preview.sources[preview.index]
    if (source === undefined) return
    let cancelled = false
    setPreviewLoading(true)
    setPreviewError(null)
    const render = imageRenderer ?? renderImageBlock
    render(source, Math.max(10, (stdout?.columns ?? 80) - 4), Math.max(4, (stdout?.rows ?? 24) - 10))
      .then((block) => {
        if (cancelled) return
        setPreviewBlock(block)
        setPreviewLoading(false)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setPreviewBlock(null)
        setPreviewLoading(false)
        setPreviewError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [preview, imageRenderer, stdout])

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
  const pickerSource: SessionSummary[] = useMemo(() => {
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
    return source
  }, [pickerPage, snapshot.sessions, archivedList])

  /** 工作区分桶（当前页数据源按 cwd 归堆）：当前会话所在工作区置顶，其余按最新会话时间降序。 */
  const workspaceEntries = useMemo(() => {
    const buckets = new Map<string, { cwd: string; count: number; latest: number }>()
    for (const session of pickerSource) {
      const bucket = buckets.get(session.cwd)
      if (bucket === undefined) {
        buckets.set(session.cwd, { cwd: session.cwd, count: 1, latest: session.updatedAt })
      } else {
        bucket.count += 1
        bucket.latest = Math.max(bucket.latest, session.updatedAt)
      }
    }
    const currentCwd = snapshot.status.cwd ?? null
    return [...buckets.values()].sort(
      (a, b) => (a.cwd === currentCwd ? 0 : 1) - (b.cwd === currentCwd ? 0 : 1) || b.latest - a.latest,
    )
  }, [pickerSource, snapshot.status.cwd])

  /** 工作区层 = 未钻取且工作区不止一个（单工作区直落会话层，省一次回车）。 */
  const activeWorkspace =
    pickerWorkspace ?? (workspaceEntries.length === 1 ? (workspaceEntries[0]?.cwd ?? null) : null)
  const isWorkspaceLevel = activeWorkspace === null

  /** 工作区层的筛选（名称/路径子串）。 */
  const workspaceList = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase()
    if (q === '') return workspaceEntries
    return workspaceEntries.filter(
      (entry) =>
        workspaceLabel(entry.cwd).toLowerCase().includes(q) || entry.cwd.toLowerCase().includes(q),
    )
  }, [workspaceEntries, pickerQuery])

  /** 会话层 = 已选工作区（或单工作区直落）的会话，再过筛选词。 */
  const pickerList: SessionSummary[] = useMemo(() => {
    const scoped =
      activeWorkspace === null
        ? pickerSource
        : pickerSource.filter((session) => session.cwd === activeWorkspace)
    const q = pickerQuery.trim().toLowerCase()
    if (q === '') return scoped
    return scoped.filter(
      (session) =>
        (session.title ?? '').toLowerCase().includes(q) ||
        session.cwd.toLowerCase().includes(q) ||
        session.id.toLowerCase().includes(q),
    )
  }, [pickerSource, activeWorkspace, pickerQuery])

  // ---- 恒定帧与各视口的窗口切片 ----
  const termRows = stdout?.rows ?? 24
  /** 帧内容行数：终端行数 − 1（ink 帧自带尾随换行，末行留给光标落点）。 */
  const frameRows = Math.max(1, termRows - 1)
  /** 状态栏行数（0.6.57 去掉描边框后固定两行）。 */
  const statusbarLines = 2
  /** 当前层的行数（工作区层 = 工作区数，会话层 = 会话数）；窗口切片与点击映射都按它算。 */
  const pickerRowCount = isWorkspaceLevel ? workspaceList.length : pickerList.length
  /** 选择器列表窗口：框内除固定框架外全部让给列表（点击行号映射按它 1:1 对齐）。 */
  const pickerListRows = Math.min(
    Math.max(pickerRowCount, 0),
    Math.max(1, frameRows - statusbarLines - PICKER_CHROME),
  )
  /** 窗口起点：选中项尽量居中（fzf 式），两端夹住；列表放得下时等于 0。 */
  const pickerStart = Math.min(
    Math.max(0, pickerIndex - Math.floor((pickerListRows - 1) / 2)),
    Math.max(0, pickerRowCount - pickerListRows),
  )
  const visibleSessions = pickerList.slice(pickerStart, pickerStart + pickerListRows)
  const visibleWorkspaces = workspaceList
    .slice(pickerStart, pickerStart + pickerListRows)
    .map((entry) => ({
      cwd: entry.cwd,
      name: workspaceLabel(entry.cwd),
      count: entry.count,
      latest: entry.latest,
      current: entry.cwd !== '' && entry.cwd === snapshot.status.cwd,
    }))

  /** 聊天窗口：末端锚在 chatAnchor（null = 跟最新），窗口向历史方向展开。 */
  const chatEnd = Math.min(chatAnchor ?? snapshot.entries.length, snapshot.entries.length)
  const chatWindow = snapshot.entries.slice(Math.max(0, chatEnd - CHAT_WINDOW), chatEnd)

  // ---- 设置页（/settings）的行模型与窗口切片（几何与 SettingsOverlay 共表）----
  const settingsRows = useMemo(
    () => buildSettingsRows(settingsSections, settingsSection, settingsGroup),
    [settingsSections, settingsSection, settingsGroup],
  )
  const settingsFocusables = useMemo(
    () => focusableRows(settingsRows, settingsSections),
    [settingsRows, settingsSections],
  )
  /** 焦点行 = focusables 里的第 index 个；列表变短时夹住（分区装载前后都安全）。 */
  const settingsFocusRow =
    settingsFocusables[Math.min(settingsIndex, Math.max(0, settingsFocusables.length - 1))] ?? 0
  /** 设置页视口：帧内扣除固定框架（上下边框 2 + 标题 1 + notice 1 + 提示条 1）。 */
  const settingsViewport = Math.max(1, frameRows - statusbarLines - SETTINGS_CHROME)
  const settingsWindow = settingsWindowStart(settingsFocusRow, settingsViewport, settingsRows.length)

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
    // 两页的工作区集合不同：切页回工作区层重新选（dsh 总管同语义）。
    setPickerWorkspace(null)
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

  /** 应用当前选中的模式（Enter 与「点击已选中项」共用）：回执走 notice。 */
  const applyPreset = (): void => {
    const preset = presetList[presetIndex]
    if (preset === undefined) return
    setPresetPicker(false)
    const mutation = runtime.usePreset(preset.name)
    setNotice(mutation.ok ? mutation.notice ?? `已切换到模式「${preset.label}」` : mutation.error)
  }

  /** 应用当前选中的技能（Enter 与「点击已选中项」共用）：把 /技能名 灌回输入行。 */
  const applySkill = (): void => {
    const skill = skillsList[skillsIndex]
    if (skill === undefined) return
    if (!skill.userInvocable) {
      setNotice(`技能 ${skill.name} 没注册成命令（不进模型目录），不能这样调用`)
      return
    }
    setSkillsPicker(false)
    setNotice(null)
    setComposerPreset({ text: `/${skill.name} `, token: Date.now() })
  }

  // ---- 0.6.61：设置页的动作（Enter 与鼠标点击共用的唯一真源）----

  /** 写一个设置项：回执进设置页底部 notice 行；成功后就地刷新值表（改动即保存）。 */
  const applySetting = (sectionId: string, key: string, value: SettingsValue): void => {
    void runtime
      .setSettingValue(sectionId, key, value)
      .then((mutation) => {
        if (!mutation.ok) {
          setSettingsNotice({ ok: false, text: mutation.error })
          return
        }
        setSettingsValues((current) => ({
          ...current,
          [sectionId]: { ...current[sectionId], [key]: value },
        }))
        setSettingsNotice({ ok: true, text: mutation.notice ?? '已保存' })
        // 思考块默认展开除了新会话语义，当前会话也当场跟着切
        if (sectionId === 'tui' && key === 'reasoningDefaultOpen') setExpandThinking(value === true)
        // 状态栏段开关（0.6.62）：就地改 state，关页即见（静默保存，无回执）
        if (sectionId === 'tui' && key.startsWith('statusBar.')) {
          setStatusBarPrefs((current) => ({ ...current, [key.slice('statusBar.'.length)]: value === true }))
        }
      })
      .catch((cause: unknown) =>
        setSettingsNotice({ ok: false, text: cause instanceof Error ? cause.message : String(cause) }),
      )
  }

  /** 执行分区动作（button 字段）：回执可能带结构化载荷（发布页链接等），TUI 只显示文案。 */
  const runSettingsAction = (sectionId: string, action: string): void => {
    void runtime
      .runSettingAction(sectionId, action)
      .then((mutation) => {
        if (!mutation.ok) {
          setSettingsNotice({ ok: false, text: mutation.error })
          return
        }
        const fallback = mutation.data?.kind === 'url' ? mutation.data.url : '已完成'
        setSettingsNotice({ ok: true, text: mutation.notice ?? fallback })
      })
      .catch((cause: unknown) =>
        setSettingsNotice({ ok: false, text: cause instanceof Error ? cause.message : String(cause) }),
      )
  }

  /** info.copyable 行的复制：/copy 同款（win32 clip / darwin pbcopy / linux wl-copy）。 */
  const copyInfoText = (text: string): void => {
    const command =
      process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'clip' : 'wl-copy'
    try {
      const child = spawn(command, [], { stdio: ['pipe', 'ignore', 'ignore'] })
      child.on('error', () => setSettingsNotice({ ok: false, text: `复制失败：找不到 ${command} 命令` }))
      child.stdin?.end(text)
      setSettingsNotice({ ok: true, text: `已复制：${text}` })
    } catch (error) {
      setSettingsNotice({
        ok: false,
        text: `复制失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  /** 行 → 字段解析（结构行或下标越界返回 null）。 */
  const settingsFieldAt = (row: SettingsRow | undefined): { sectionId: string; field: SettingsField } | null => {
    if (row === undefined || row.kind !== 'field') return null
    const section = settingsSections.find((entry) => entry.id === row.sectionId)
    const field = section?.fields[row.fieldIndex]
    return field !== undefined ? { sectionId: row.sectionId, field } : null
  }

  /** 行的主动作（Enter 与「点击该行」共用）：switch/select 改值即存，text/number 进编辑。 */
  const activateSettingsRow = (row: SettingsRow | undefined, direction: 1 | -1): void => {
    if (row?.kind === 'section') {
      // 进分区页（0.6.64 两级导航）：焦点与草稿归零；Esc 由键盘分支逐级退栈
      setSettingsSection(row.sectionId)
      setSettingsIndex(0)
      setSettingsEdit(null)
      return
    }
    if (row?.kind === 'group') {
      // 进组子页（dsh 同款）：焦点与草稿归零；Esc 由键盘分支先退子页再关页
      setSettingsGroup({ sectionId: row.sectionId, groupId: row.groupId })
      setSettingsIndex(0)
      setSettingsEdit(null)
      return
    }
    if (row?.kind === 'hint') {
      if (row.jump === 'model-picker') {
        setSettingsOpen(false)
        setModelPicker(true)
        setModelIndex(0)
        setModelQuery('')
      } else if (row.jump === 'usage') {
        setSettingsOpen(false)
        runCommand('/usage', runtime, {
          openPicker: openSessionPicker,
          openModels: () => {},
          openAgents,
          notice: setNotice,
        })
      }
      return
    }
    const hit = settingsFieldAt(row)
    if (hit === null) return
    const { sectionId, field } = hit
    if (field.type === 'switch') {
      applySetting(sectionId, field.key, settingsValues[sectionId]?.[field.key] === true ? false : true)
      return
    }
    if (field.type === 'select') {
      const options = field.options
      if (options.length === 0) return
      const current = String(settingsValues[sectionId]?.[field.key] ?? '')
      const at = options.findIndex((option) => option.value === current)
      const next = options[(((at + direction) % options.length) + options.length) % options.length] ?? options[0]
      if (next !== undefined) applySetting(sectionId, field.key, next.value)
      return
    }
    if (field.type === 'text' || field.type === 'number') {
      const current = settingsValues[sectionId]?.[field.key]
      setSettingsEdit({ sectionId, key: field.key, draft: current === undefined ? '' : String(current) })
      return
    }
    if (field.type === 'button') {
      runSettingsAction(sectionId, field.action)
      return
    }
    if (field.type === 'info' && field.copyable === true) copyInfoText(field.text)
  }

  /** 编辑态 Enter：number 先校验（非法留编辑态弹红，对齐 dsh），text 直接入库。 */
  const commitSettingsEdit = (): void => {
    if (settingsEdit === null) return
    const hit = settingsFieldAt(settingsRows[settingsFocusRow])
    if (hit === null || !('key' in hit.field) || hit.field.key !== settingsEdit.key) {
      setSettingsEdit(null)
      return
    }
    if (hit.field.type === 'number') {
      const parsed = Number(settingsEdit.draft)
      const invalid =
        settingsEdit.draft.trim() === '' ||
        Number.isNaN(parsed) ||
        (hit.field.min !== undefined && parsed < hit.field.min) ||
        (hit.field.max !== undefined && parsed > hit.field.max)
      if (invalid) {
        const range = `${hit.field.min ?? '-∞'}–${hit.field.max ?? '∞'}`
        setSettingsNotice({ ok: false, text: `无效输入：需要 ${range} 之间的数字` })
        return
      }
      setSettingsEdit(null)
      applySetting(hit.sectionId, hit.field.key, parsed)
      return
    }
    setSettingsEdit(null)
    if (hit.field.type === 'text') applySetting(hit.sectionId, hit.field.key, settingsEdit.draft)
  }

  // ---- 0.6.57：双击 Esc 撤回上一轮 ----
  /**
   * 撤回上一轮（对齐 codex 的 backtrack 语义、dsh 的 fork 实现）：fork 出
   * 「最后一条用户消息之前」的新会话并切换过去，原话放回输入框改完重发；
   * 原会话原样保留（不删任何条目，/resume 里随时找回）。
   */
  const rewindLastTurn = (): void => {
    const path = snapshot.status.sessionId
    if (path === null || path === '') {
      setNotice('还没有对话可撤回')
      return
    }
    void runtime
      .listUserMessages(path)
      .then(async (messages) => {
        const last = messages[messages.length - 1]
        if (last === undefined) return '这个会话还没有用户消息，没得撤'
        const fork = await runtime.forkSession(path, messages.length - 1)
        if (!fork.ok) return fork.error === '' ? '撤回失败' : fork.error
        await runtime.openSession(fork.path)
        setComposerPreset((current) => ({ text: last, token: current.token + 1 }))
        setChatAnchor(null)
        setAttachments([])
        return '已撤回上一轮，原话已放回输入框（原会话保留在 /resume）'
      })
      .then((message) => {
        if (typeof message === 'string') setNotice(message)
      })
      .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)))
  }

  // ---- 0.6.57：剪贴板贴图与附件芯片 ----
  /** Ctrl+V：剪贴板里是图就挂芯片（提交时读成 data URL），是文本就并入草稿。 */
  const handlePaste = (): void => {
    const read = clipboardReader ?? readClipboardImage
    void read()
      .then((result) => {
        if (result.kind === 'image') {
          attachmentSeq.current += 1
          const id = attachmentSeq.current
          setAttachments((current) => [
            ...current,
            {
              id,
              path: result.path,
              name: result.path.split(/[\\/]/).pop() ?? result.path,
            },
          ])
          setNotice(`已附加图片 #${id}（点击芯片预览，Enter 随消息发送）`)
          return
        }
        if (result.kind === 'text' && result.text.trim() !== '') {
          setComposerPreset((current) => ({
            text: draftRef.current + result.text,
            token: current.token + 1,
          }))
          return
        }
        setNotice('剪贴板里没有图片（文字粘贴交给终端，Ctrl+V 只接图）')
      })
      .catch(() => setNotice('剪贴板读取失败'))
  }

  /** 摘下一枚附件芯片。 */
  const removeAttachment = (id: number): void => {
    setAttachments((current) => current.filter((att) => att.id !== id))
  }

  /** 点附件芯片：开这张图的预览。 */
  const previewAttachment = (id: number): void => {
    const att = attachments.find((item) => item.id === id)
    if (att === undefined) return
    setPreview({ title: att.name, sources: [{ path: att.path }], index: 0 })
  }

  /** 点会话流里的图片行：预览历史消息带的图（data URL 现场落临时文件解码）。 */
  const handlePreviewImages = useCallback((images: string[]) => {
    setPreview({
      title: `图片（${images.length} 张）`,
      sources: images.map((dataUrl) => ({ dataUrl })),
      index: 0,
    })
  }, [])

  // ---- 0.6.57：子代理查看 ----
  /** 打开某个代理/后台会话的只读转录（peek 不改文件）。 */
  const openAgentTranscript = useCallback(
    (file: string, title: string) => {
      setAgentView({ mode: 'transcript', file, title })
      setAgentEntries(null)
      setScrollOffset(0)
      void runtime
        .peekTranscript(file)
        .then((entries) => setAgentEntries(entries))
        .catch(() => setAgentEntries([]))
    },
    [runtime],
  )

  /** /agents 打开名单浮层（命令 ui 回调）。 */
  const openAgents = useCallback(() => {
    setAgentView({ mode: 'list' })
    setAgentIndex(0)
  }, [])

  /** 打开设置页（/settings 命令入口）：同步拿分区表，值表逐分区异步装填。 */
  const openSettings = useCallback(() => {
    const sections = runtime.getSettingsSections()
    setSettingsSections(sections)
    setSettingsValues({})
    setSettingsIndex(0)
    setSettingsEdit(null)
    setSettingsNotice(null)
    setSettingsGroup(null)
    setSettingsSection(null)
    setSettingsOpen(true)
    for (const section of sections) {
      void runtime
        .getSectionValues(section.id)
        .then((sectionValues) => {
          setSettingsValues((current) => ({ ...current, [section.id]: sectionValues }))
        })
        .catch(() => {
          // 单个分区取值失败不拖垮整页：空表 = 控件显示占位，保存时由后端报错
          setSettingsValues((current) => ({ ...current, [section.id]: {} }))
        })
    }
  }, [runtime])

  /** 打开会话选择器（/resume 命令、输入框 ⌸ 按钮、点击入口共用一条通道）。 */
  const openSessionPicker = useCallback(() => {
    setPicker(true)
    setPickerIndex(0)
    setPickerQuery('')
    setPickerPage('active')
    setPickerWorkspace(null)
    void runtime.refreshSessions()
  }, [runtime])

  /** 工作区层的 Enter/再点：钻进该工作区的会话列表（清筛选，焦点回顶）。 */
  const enterWorkspace = (index: number): void => {
    const entry = workspaceList[index]
    if (entry === undefined) return
    setPickerWorkspace(entry.cwd)
    setPickerIndex(0)
    setPickerQuery('')
    setPickerArmed(false)
  }

  /** 名单浮层的行（队友在前、后台会话在后；与渲染同一条装配规则）。 */
  const agentRows =
    agentView !== null && agentView.mode === 'list'
      ? buildAgentRows(runtime.listTeammates(), snapshot.sessionStates)
      : []

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
          setPickerIndex((current) => Math.max(0, Math.min(current + step, pickerRowCount - 1)))
        } else if (modelPicker) {
          setModelIndex((current) => Math.max(0, Math.min(current + step, modelList.length - 1)))
        } else if (presetPicker) {
          setPresetIndex((current) => Math.max(0, Math.min(current + step, presetList.length - 1)))
        } else if (skillsPicker) {
          setSkillsIndex((current) => Math.max(0, Math.min(current + step, skillsList.length - 1)))
        } else if (agentView !== null) {
          if (agentView.mode === 'list') {
            setAgentIndex((current) => Math.max(0, Math.min(current + step, agentRows.length - 1)))
          } else {
            const maxOffset = Math.max(0, (agentEntries?.length ?? 0) - 1)
            setScrollOffset((current) => Math.max(0, Math.min(current - step, maxOffset)))
          }
        } else if (transcriptOpen) {
          const maxOffset = Math.max(0, snapshot.entries.length - 1)
          setScrollOffset((current) => Math.max(0, Math.min(current - step, maxOffset)))
        } else if (settingsOpen) {
          // 设置页滚轮 = 移动焦点（dsh 同语义），窗口随焦点跟随
          setSettingsIndex((current) =>
            Math.max(0, Math.min(current + step, Math.max(0, settingsFocusables.length - 1))),
          )
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
        // 两级行结构相同（listTop/切片一致）：工作区层再点 = 钻入，会话层再点 = 打开。
        if (hit !== pickerIndex) {
          setPickerIndex(hit)
          return
        }
        if (isWorkspaceLevel) enterWorkspace(hit)
        else openSelectedSession()
        return
      }
      if (modelPicker) {
        const row0 = row - 1 - 3
        if (row0 < 0 || row0 >= modelList.length) return
        if (row0 === modelIndex) applyModel()
        else setModelIndex(row0)
        return
      }
      if (presetPicker) {
        const row0 = row - 1 - 3
        if (row0 < 0 || row0 >= presetList.length) return
        if (row0 === presetIndex) applyPreset()
        else setPresetIndex(row0)
        return
      }
      if (skillsPicker) {
        const row0 = row - 1 - 3
        if (row0 < 0 || row0 >= skillsList.length) return
        if (row0 === skillsIndex) applySkill()
        else setSkillsIndex(row0)
        return
      }
      if (settingsOpen) {
        if (settingsEdit !== null) return // 草稿由键盘独占（对齐 dsh 的编辑态）
        // 列表行从「外框顶边 + 标题行」之后起排，滚动窗口与组件共用同一份行模型
        const slice = row - 1 - SETTINGS_LIST_TOP
        if (slice < 0 || slice >= settingsViewport) return
        const target = settingsRows[settingsWindow + slice]
        if (target === undefined || (target.kind !== 'field' && target.kind !== 'hint' && target.kind !== 'group' && target.kind !== 'section')) return
        const fields = settingsSections.find((section) => section.id === target.sectionId)?.fields ?? []
        if (!isFocusableRow(target, fields)) return
        activateSettingsRow(target, 1)
        return
      }
      // 卡片页脚按钮 / 提问选项 / 回底提示条 / 附件与后台芯片 / 图片行：点击时现量
      // 几何（避免节流渲染导致的滞后），再询问判定函数；谁命中谁消费。
      for (const entry of clickRegions.current) {
        const top = absoluteTop(entry.node.current)
        const height = measuredHeight(entry.node.current)
        if (top === null || height === null) continue
        if (entry.hit(col - 1, row - 1, top, height)) return
      }
      return
    }
    // 任何非 Esc 按键都取消「再按一次 Esc」的 prime 态（对齐 codex 的 backtrack）。
    if (!key.escape) lastEsc.current = 0
    // Ctrl+V 贴图：终端把粘贴限定成文本，纯图片剪贴板不发任何字节——按键层自己接。
    if (key.ctrl && input === 'v' && !modal) {
      handlePaste()
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
    // 图片预览浮层：Esc / 点击关闭，←→ 在同一批图里切换。
    if (preview !== null) {
      if (key.escape) setPreview(null)
      else if (key.leftArrow)
        setPreview((current) =>
          current === null ? current : { ...current, index: Math.max(0, current.index - 1) },
        )
      else if (key.rightArrow)
        setPreview((current) =>
          current === null
            ? current
            : { ...current, index: Math.min(current.sources.length - 1, current.index + 1) },
        )
      return
    }
    // 子代理浮层：名单（Enter/点击看转录）与转录（回看浮层同款滚动）两种形态。
    if (agentView !== null) {
      if (agentView.mode === 'list') {
        if (key.escape) setAgentView(null)
        else if (key.return) {
          const row = agentRows[agentIndex]
          if (row !== undefined) openAgentTranscript(row.file, row.title)
        } else if (key.upArrow) setAgentIndex((current) => Math.max(0, current - 1))
        else if (key.downArrow)
          setAgentIndex((current) => Math.min(agentRows.length - 1, current + 1))
        return
      }
      const agentTotal = agentEntries?.length ?? 0
      const maxOffset = Math.max(0, agentTotal - 1)
      if (key.escape || input === 'q') setAgentView(null)
      else if (key.upArrow || input === 'k')
        setScrollOffset((current) => Math.min(maxOffset, current + 1))
      else if (key.downArrow || input === 'j')
        setScrollOffset((current) => Math.max(0, current - 1))
      else if (key.pageUp) setScrollOffset((current) => Math.min(maxOffset, current + 10))
      else if (key.pageDown) setScrollOffset((current) => Math.max(0, current - 10))
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
        else if (pickerWorkspace !== null) {
          // 会话层 Esc 先回工作区层（dsh 子页惯例）；单工作区直落时没有上层，直接关。
          setPickerWorkspace(null)
          setPickerIndex(0)
        } else setPicker(false)
        return
      }
      if (key.tab) {
        togglePickerPage()
        return
      }
      if (key.return) {
        if (isWorkspaceLevel) enterWorkspace(pickerIndex)
        else openSelectedSession()
        return
      }
      if (key.upArrow) {
        setPickerIndex((current) => Math.max(0, current - 1))
        return
      }
      if (key.downArrow) {
        setPickerIndex((current) => Math.min(pickerRowCount - 1, current + 1))
        return
      }
      if (key.ctrl) {
        // 动作键全走 Ctrl 组合——普通字符留给筛选输入；工作区层没有会话动作。
        if (isWorkspaceLevel) return
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
    // 模式浮层：与模型浮层同款（输入即筛选、Enter 切换、Esc 关）。
    if (presetPicker) {
      if (key.escape) setPresetPicker(false)
      else if (key.return) applyPreset()
      else if (key.upArrow) setPresetIndex((current) => Math.max(0, current - 1))
      else if (key.downArrow)
        setPresetIndex((current) => Math.min(presetList.length - 1, current + 1))
      else if (key.backspace || key.delete) {
        setPresetQuery((current) => current.slice(0, -1))
        setPresetIndex(0)
      } else if (!key.ctrl && !key.meta) {
        const printable = input.replace(/[\r\n\t]+/g, '')
        if (printable !== '') {
          setPresetQuery((current) => current + printable)
          setPresetIndex(0)
        }
      }
      return
    }
    // 技能浮层：同款；Enter 对不可回填的技能只提示不关页。
    if (skillsPicker) {
      if (key.escape) setSkillsPicker(false)
      else if (key.return) applySkill()
      else if (key.upArrow) setSkillsIndex((current) => Math.max(0, current - 1))
      else if (key.downArrow)
        setSkillsIndex((current) => Math.min(skillsList.length - 1, current + 1))
      else if (key.backspace || key.delete) {
        setSkillsQuery((current) => current.slice(0, -1))
        setSkillsIndex(0)
      } else if (!key.ctrl && !key.meta) {
        const printable = input.replace(/[\r\n\t]+/g, '')
        if (printable !== '') {
          setSkillsQuery((current) => current + printable)
          setSkillsIndex(0)
        }
      }
      return
    }
    // 设置页：编辑态独占键盘（对齐 dsh，草稿之外的一切都不响应）；其余 ↑↓ 焦点、
    // ←→ 循环 select、Enter 主动作（切换/编辑/执行/复制/跳转）、Esc 关页。
    if (settingsOpen) {
      const at = Math.min(settingsIndex, Math.max(0, settingsFocusables.length - 1))
      const focusRow = settingsFocusables[at] ?? 0
      if (settingsEdit !== null) {
        if (key.escape) {
          setSettingsEdit(null)
        } else if (key.return) {
          commitSettingsEdit()
        } else if (key.backspace || key.delete) {
          setSettingsEdit({ ...settingsEdit, draft: settingsEdit.draft.slice(0, -1) })
        } else if (!key.ctrl && !key.meta) {
          const printable = input.replace(/[\r\n\t]+/g, '')
          if (printable !== '') {
            setSettingsEdit({ ...settingsEdit, draft: settingsEdit.draft + printable })
          }
        }
        return
      }
      if (key.escape) {
        // 逐级退栈（dsh 同款：子页里 Esc 是「返回上级」）：组子页 → 分区页 → 根页 → 关页
        if (settingsGroup !== null) {
          setSettingsGroup(null)
          setSettingsIndex(0)
        } else if (settingsSection !== null) {
          setSettingsSection(null)
          setSettingsIndex(0)
        } else {
          setSettingsOpen(false)
        }
        return
      }
      if (key.upArrow) {
        setSettingsIndex(Math.max(0, at - 1))
        return
      }
      if (key.downArrow) {
        setSettingsIndex(Math.min(settingsFocusables.length - 1, at + 1))
        return
      }
      if (key.return || key.rightArrow) activateSettingsRow(settingsRows[focusRow], 1)
      else if (key.leftArrow) activateSettingsRow(settingsRows[focusRow], -1)
      return
    }
    // 回到底部 pill 可见且输入为空时：Enter/End 跳回最新（codex/dsh 同语义；
    // 输入非空时 End 仍归 Composer 的光标移动）。
    if (chatAnchor !== null && !modal && !panelOpen && draftRef.current === '') {
      if (key.end || key.return) {
        setChatAnchor(null)
        return
      }
    }
    // Esc（对齐 codex）：回合跑着 = 打断；空闲且输入框为空 = prime 撤回——双击
    // Esc 把上一轮撤掉、原话放回输入框（dsh 同款 3 秒窗口）。补全面板开着时
    // Esc 只关面板。
    if (key.escape && !panelOpen) {
      if (snapshot.status.turnState !== 'idle') {
        runtime.interrupt()
        return
      }
      if (draftRef.current === '') {
        const now = Date.now()
        if (now - lastEsc.current < REWIND_WINDOW_MS) {
          lastEsc.current = 0
          rewindLastTurn()
        } else {
          lastEsc.current = now
          setNotice('再按一次 Esc：撤回上一轮对话')
        }
      }
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
        openPicker: openSessionPicker,
        openModels: () => {
          setModelPicker(true)
          setModelIndex(0)
          setModelQuery('')
        },
        openPresets: () => {
          setPresetPicker(true)
          setPresetIndex(0)
          setPresetQuery('')
        },
        openSkills: () => {
          setSkillsPicker(true)
          setSkillsIndex(0)
          setSkillsQuery('')
        },
        toggleThinking: (visible) => {
          const next = visible ?? !expandThinking
          setExpandThinking(next)
          setNotice(next ? '思考块已展开（Ctrl+T 随时切换）' : '思考块已折叠（Ctrl+T 随时切换）')
        },
        openAgents,
        openSettings,
        notice: setNotice,
      })
      return
    }
    // 图片合流：附件芯片（剪贴板贴图）先读成 data URL，正文里的图片路径交给
    // extractImages；两类失败一起提示。发完即清空芯片。
    const fromChips: string[] = []
    const failedChips: string[] = []
    for (const att of attachments) {
      try {
        fromChips.push(readImageAsDataUrl(att.path))
      } catch {
        failedChips.push(att.name)
      }
    }
    setAttachments([])
    const attached = extractImages(text)
    const failed = [...failedChips, ...attached.failed]
    if (failed.length > 0) {
      setNotice(`图片读取失败（太大或 IO 错误）：${failed.join('、')}`)
    }
    const images = [...fromChips, ...attached.images]
    runtime.submit(attached.text, images.length > 0 ? images : undefined)
  }

  const modal =
    approval !== null ||
    question !== null ||
    picker ||
    transcriptOpen ||
    modelPicker ||
    presetPicker ||
    skillsPicker ||
    settingsOpen ||
    preview !== null ||
    agentView !== null ||
    (plan !== null && !planFeedback)

  /** 子代理转录的窗口切片（与回看浮层同一套「条」滚动）。 */
  const agentTotal = agentEntries?.length ?? 0
  const agentEnd = Math.max(1, agentTotal - Math.min(scrollOffset, Math.max(0, agentTotal - 1)))
  const agentWindow = (agentEntries ?? []).slice(Math.max(0, agentEnd - OVERLAY_WINDOW), agentEnd)

  return (
    <Box height={frameRows} width="100%" flexDirection="column" overflow="hidden" paddingX={PAD.page}>
      {preview !== null ? (
        <PreviewOverlay
          title={preview.title}
          index={preview.index}
          total={preview.sources.length}
          block={previewBlock}
          loading={previewLoading}
          error={previewError}
          registerClick={registerClick}
          onClose={() => setPreview(null)}
        />
      ) : agentView !== null && agentView.mode === 'list' ? (
        <AgentsOverlay rows={agentRows} index={agentIndex} />
      ) : agentView !== null && agentView.mode === 'transcript' ? (
        <TranscriptOverlay
          entries={agentWindow}
          start={Math.max(0, agentEnd - agentWindow.length)}
          total={agentTotal}
          title={agentView.title}
        />
      ) : picker ? (
        <SessionPicker
          level={isWorkspaceLevel ? 'workspaces' : 'sessions'}
          workspaces={visibleWorkspaces}
          workspaceTitle={pickerWorkspace === null ? null : workspaceLabel(pickerWorkspace)}
          sessions={visibleSessions}
          total={isWorkspaceLevel ? workspaceList.length : pickerList.length}
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
      ) : presetPicker && presetSurface !== null ? (
        <PresetPicker
          presets={presetList}
          current={presetSurface.current}
          defaultName={presetSurface.defaultName}
          index={presetIndex}
          query={presetQuery}
        />
      ) : skillsPicker ? (
        <SkillsPicker skills={skillsList} index={skillsIndex} query={skillsQuery} />
      ) : settingsOpen ? (
        <SettingsOverlay
          sections={settingsSections}
          rows={settingsRows}
          values={settingsValues}
          focusRow={settingsFocusRow}
          windowStart={settingsWindow}
          viewport={settingsViewport}
          editing={settingsEdit}
          notice={settingsNotice}
          section={settingsSection}
          group={settingsGroup}
        />
      ) : (
        <>
          <Box flexDirection="column" flexGrow={1} overflowY="hidden" justifyContent="flex-end">
            <ChatView
              entries={chatWindow}
              turnState={snapshot.status.turnState}
              expandThinking={expandThinking}
              empty={snapshot.entries.length === 0}
              header={
                snapshot.entries.length < WELCOME_MAX_ENTRIES ? (
                  <Welcome
                    model={snapshot.status.model}
                    effort={snapshot.status.effort ?? '-'}
                    cwd={snapshot.status.cwd}
                  />
                ) : undefined
              }
              onPreviewImages={handlePreviewImages}
              onOpenAgent={(file) => openAgentTranscript(file, shortId(file))}
              registerClick={registerClick}
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
              onDraftChange={handleDraftChange}
              preset={composerPreset}
              attachments={attachments}
              onRemoveAttachment={removeAttachment}
              onPreviewAttachment={previewAttachment}
              onOpenSessions={openSessionPicker}
              working={snapshot.status.turnState !== 'idle'}
              registerClick={registerClick}
              onSubmit={handleSubmit}
            />
          </Box>
        </>
      )}
      <Box flexShrink={0}>
        <StatusBar
          status={snapshot.status}
          surfaces={snapshot.surfaces}
          subagents={snapshot.subagents ?? []}
          config={statusBarPrefs}
          onOpenAgent={(sessionPath) => openAgentTranscript(sessionPath, shortId(sessionPath))}
          registerClick={registerClick}
        />
      </Box>
    </Box>
  )
}
