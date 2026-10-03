/**
 * 顶层界面：窗口控件条 + 顶栏（标题/对话轨迹 tab）+ 居中消息流 + 输入区 + 状态栏。
 * 布局对照 dsh 桌面端；空会话显示欢迎态；命令派发复用 dsc 的 runCommand。
 *
 * @module desktop/renderer/App
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ModelChoiceView, PluginInfoView, RuntimeSnapshot, TeammateView, TranscriptEntry, UiPrefsView } from '@dsc/runtime/contract.js'
import { applyAppearance, loadCachedAppearance, normalizeUiPrefs, saveCachedAppearance } from './appearance.js'
import { toastErr, toastOk } from './components/toast.js'
import { playCompletionSound } from './completion-sound.js'
import { completionNotifyBody, isBackgrounded, normalizeSoundVariant, turnCompleted } from './turn-notify.js'
import { dsc, createRuntimeProxy, type RuntimeProxy } from './bridge.js'
import { ApprovalCard } from './ApprovalCard.js'
import { AskCard, GoalBar, PlanReview, TaskDock } from './TaskDock.js'
import { ChatView } from './ChatView.js'
import { Composer } from './Composer.js'
import { collectWorkspaceFiles } from './mention-complete.js'
import { Dock } from './Dock.js'
import {
  closeTab as dockCloseTab,
  defaultSurface,
  type DockActions,
  type DockSurface,
  type DockSurfaces,
  type DockTabKind,
  focusPane as dockFocusPane,
  focusTab as dockFocusTab,
  loadSurfaces,
  openPreview as dockOpenPreview,
  openTab as dockOpenTab,
  placeTab as dockPlaceTab,
  saveSurfaces,
  setExpanded as dockSetExpanded,
  setFraction as dockSetFraction,
  splitPane as dockSplitPane,
  toggleMode as dockToggleMode,
  unsplitPane as dockUnsplitPane,
} from './dock-model.js'
import { PluginsView } from './PluginsView.js'
import { SessionPicker } from './SessionPicker.js'
import { isSessionMarker } from './session-marker.js'
import { SettingsModal } from './SettingsModal.js'
import { Sidebar } from './Sidebar.js'
import { SkillsView } from './SkillsView.js'
import { StatusBar } from './StatusBar.js'
import { SubagentMenu, TeamPanel, matesOf } from './TeamPanel.js'
import { TeammatePeek } from './TeammatePeek.js'
import { ThreadResizer } from './ThreadResizer.js'
import { TraceView } from './TraceView.js'
import { DiffPane } from './DiffPane.js'
import type { ChangedFileView } from '@dsc/runtime/contract.js'
import {
  PANEL_KEYS,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  STORED_MAX,
  THREAD_MIN,
  readStoredFlag,
  readStoredPx,
  setRootVar,
  writeStoredFlag,
  writeStoredPx,
} from './panels.js'
import { IconChevronDown, IconCode, IconCopy, IconFolderOpen, IconSidebar, IconTerminal } from './icons.js'

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null)
  const [cwd, setCwd] = useState('')
  const [hostDown, setHostDown] = useState<{ code: number | null } | null>(null)
  const [picker, setPicker] = useState(false)
  const [models, setModels] = useState<ModelChoiceView[]>([])
  const [plugins, setPlugins] = useState<PluginInfoView[]>([])
  const [tab, setTab] = useState<'chat' | 'trace'>('chat')
  const [view, setView] = useState<'chat' | 'plugins' | 'skills'>('chat')
  // 设置面板：open 控制遮罩，section 是打开时定位的分区（技能页右上也用它）
  const [settings, setSettings] = useState<{ open: boolean; section: string }>({ open: false, section: 'general' })
  // 正在只读查看的队友（标题旁下拉或团队面板点开）；它不是当前会话，切不走也改不了
  const [peek, setPeek] = useState<TeammateView | null>(null)
  const [peekEntries, setPeekEntries] = useState<TranscriptEntry[]>([])
  // 轮尾「文件已更改」卡的审查面板：files 是那一轮的改动清单，index 是当前看的文件
  const [review, setReview] = useState<{ files: ChangedFileView[]; index: number } | null>(null)
  // 换会话就收起审查面板：它是「那一轮那一刀」的快照，跟着旧会话挂着只会误导
  useEffect(() => {
    setReview(null)
  }, [snapshot?.status.sessionId])
  // 队友名册（智能体团队）：标题旁的「N 个子智能体」下拉与「智能体团队」面板共用这一份。
  // 清单是跨会话的，头部那颗要按会话 id 自己筛（见下面的 sessionMates）。
  const [mates, setMates] = useState<TeammateView[]>([])
  const [subOpen, setSubOpen] = useState(false)
  const [teamOpen, setTeamOpen] = useState(false)
  // dock（右侧栏）布局真源：每个会话各一份（页签组/开合/全屏都随会话走，对照 dsh）。
  // dockOpen/dockTab 不再单独存——它们是当前会话 surface 上的 expanded / 页签激活态。
  const [surfaces, setSurfaces] = useState<DockSurfaces>(loadSurfaces)
  // 顶栏「多种方式打开工作区」的下拉菜单（对照 dsh 的文件夹+下拉分组钮）
  const [wsMenu, setWsMenu] = useState(false)
  // dock 宽度（拖拽调宽，持久化到 localStorage）
  const [dockWidth, setDockWidth] = useState(() => {
    const saved = Number(localStorage.getItem('dsc.dockWidth'))
    return Number.isFinite(saved) && saved >= 300 && saved <= 820 ? saved : 420
  })
  const proxy: RuntimeProxy = useMemo(createRuntimeProxy, [])
  // T14 @ 文件提及的数据源：dock fs-list 的工作区遍历（60 秒缓存，失败给空清单）。
  // Promise 本体进缓存——同一次 @ 触发里Composer 的 effect 重跑也不会重复遍历。
  const workspaceFiles = useRef<{ cwd: string; at: number; files: Promise<string[]> } | null>(null)
  const listWorkspaceFiles = useCallback((): Promise<string[]> => {
    const cached = workspaceFiles.current
    if (cached !== null && cached.cwd === cwd && Date.now() - cached.at < 60_000) return cached.files
    const files = collectWorkspaceFiles((dir) =>
      proxy.dock('fs-list', { dir }) as Promise<{ entries: { name: string; dir: boolean }[] }>,
    ).catch(() => [] as string[])
    workspaceFiles.current = { cwd, at: Date.now(), files }
    return files
  }, [cwd, proxy])
  // 面板尺寸三项：侧栏宽度、侧栏收成图标窄栏没有、中间正文列宽。都能拖，值存 localStorage。
  // null = 没拖过，样式表里 `:root` 那份默认值（237px / 76ch）照常生效。
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() =>
    readStoredPx(PANEL_KEYS.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX),
  )
  const [rail, setRail] = useState(() => readStoredFlag(PANEL_KEYS.sidebarRail))
  const [threadWidth, setThreadWidth] = useState<number | null>(() =>
    readStoredPx(PANEL_KEYS.threadWidth, THREAD_MIN, STORED_MAX),
  )
  // 正文那一层（含输入区）：拖拽条定位在它里面，夹宽度也要量它的实际宽。
  const zoneRef = useRef<HTMLDivElement | null>(null)
  // 侧栏界面偏好（排序方式、工作区顺序与别名、外观四项 + 过程折叠程度），存在宿主的 ~/.dsc/settings.json
  // 首帧的外观四项用 localStorage 镜像打底：等宿主返回真实设置的这段时间里，
  // 若按写死的深色上色，每次冷启动都会先闪一下深色，连窗口控件条都会被推成深色。
  const [uiPrefs, setUiPrefs] = useState<UiPrefsView>(() => ({
    sessionSort: 'manual',
    sessionGroup: 'workspace',
    archivedFilter: 'hide',
    workspaceOrder: [],
    workspaceAliases: {},
    ...loadCachedAppearance(),
    // 过程折叠程度与两个「默认态」开关都不进外观镜像（它们不落到 DOM 属性上，只由 ChatView 消费）：
    // 首帧先按标准档 + 都折叠画，宿主回读到了再换成真值。
    processFold: 'standard',
    reasoningDefaultOpen: false,
    toolDefaultOpen: false,
    // 分组展开态与会话手动顺序：首帧空表，宿主回读到了再换成真值。
    sessionExpansion: {},
    sessionOrder: {},
    // 任务完成提醒三项：出厂都开、1 号音色，宿主回读到了再换成真值。
    turnCompleteSound: true,
    turnCompleteSoundVariant: 1,
    turnCompleteNotify: true,
  }))
  // 最近用过的工作目录：切过去但还没发过消息的工作区也要能在侧栏看到
  const [recentCwds, setRecentCwds] = useState<string[]>([])

  useEffect(() => {
    const offSnapshot = dsc.onSnapshot(setSnapshot)
    const offExit = dsc.onHostExit((info) => setHostDown(info))
    const offLog = dsc.onHostLog((message) => console.info('[dsc-host]', message))
    // 宿主命令 handler 请求打开会话选择面板（如 /resume）
    const offUi = dsc.onUi((action) => {
      if (action === 'open-picker') openPicker()
    })
    void dsc.getCwd().then(setCwd)
    void dsc.recentCwds().then(setRecentCwds)
    // 宿主存档里的字号可能是旧版的三档字符串（'sm' / 'md' / 'lg'），读回来先归一成倍率，
    // 这样滑杆、百分比、落盘的值始终是同一个数字；按钮缩放一并归一。
    void proxy.getUiPrefs().then((prefs) => setUiPrefs(normalizeUiPrefs(prefs)))
    void proxy.refreshSessions()
    void proxy.listModels().then(setModels)
    return () => {
      offSnapshot()
      offUi()
      offExit()
      offLog()
    }
  }, [proxy])

  // 外观四项落到 <html> 的 data 属性和 --dsc-font-scale / --dsc-btn-scale 上，样式表据此换色。
  // 同时写一份 localStorage 镜像，下次冷启动的首帧就能按老设置上色，不闪默认深色。
  useEffect(() => {
    const appearance = {
      themeMode: uiPrefs.themeMode,
      fontSize: uiPrefs.fontSize,
      density: uiPrefs.density,
      buttonScale: uiPrefs.buttonScale,
    }
    applyAppearance(appearance)
    saveCachedAppearance(appearance)
  }, [uiPrefs.themeMode, uiPrefs.fontSize, uiPrefs.density, uiPrefs.buttonScale])

  // 拖出来的宽度写成根元素上的 CSS 变量：样式表里读这个变量的几处（侧栏宽、正文列宽、
  // 正文两侧拖拽条的位置）一起跟着动，复位就是把行内值撤掉，让 `:root` 默认值回来。
  useEffect(
    () => setRootVar('--dsc-sidebar-w', sidebarWidth === null ? null : `${sidebarWidth}px`),
    [sidebarWidth],
  )
  useEffect(
    () => setRootVar('--dsc-thread-max', threadWidth === null ? null : `${threadWidth}px`),
    [threadWidth],
  )

  // 快捷键处理器只挂一次，所以它从一个即时更新的 ref 里读当前状态，而不是从闭包里
  // 读旧的 state：连着按两下 Ctrl+B 也不会第二下把第一下的结果覆盖回去。
  const railRef = useRef(rail)
  const toggleRail = useCallback((): void => {
    const next = !railRef.current
    railRef.current = next
    setRail(next)
    writeStoredFlag(PANEL_KEYS.sidebarRail, next)
  }, [])

  // 当前会话 id 与它的右侧栏布局：没有存档就给默认的「开始」布局
  const sessionId = snapshot?.status.sessionId ?? ''
  const surface = surfaces[sessionId] ?? defaultSurface()
  // 派发一个布局变更：以当前会话的 surface 为基，算完顺手落盘（布局很小，写 localStorage 便宜）
  const mutateSurface = useCallback(
    (fn: (s: DockSurface) => DockSurface): void => {
      setSurfaces((current) => {
        const base = current[sessionId] ?? defaultSurface()
        const next = { ...current, [sessionId]: fn(base) }
        saveSurfaces(next)
        return next
      })
    },
    [sessionId],
  )
  const dockActions = useMemo<DockActions>(
    () => ({
      openTab: (kind, options) => mutateSurface((s) => dockOpenTab(s, kind, options)),
      openPreview: (path, line) => mutateSurface((s) => dockSetExpanded(dockOpenPreview(s, path, line), true)),
      closeTab: (tabId) => mutateSurface((s) => dockCloseTab(s, tabId)),
      focusTab: (tabId) => mutateSurface((s) => dockFocusTab(s, tabId)),
      focusPane: (paneId) => mutateSurface((s) => dockFocusPane(s, paneId)),
      splitPane: (paneId) => mutateSurface((s) => dockSplitPane(s, paneId)),
      unsplit: () => mutateSurface((s) => dockUnsplitPane(s)),
      placeTab: (tabId, paneId) => mutateSurface((s) => dockPlaceTab(s, tabId, paneId)),
      setExpanded: (expanded) => mutateSurface((s) => dockSetExpanded(s, expanded)),
      toggleMode: () => mutateSurface((s) => dockToggleMode(s)),
      setFraction: (fraction) => mutateSurface((s) => dockSetFraction(s, fraction)),
    }),
    [mutateSurface],
  )

  // Ctrl+B（macOS 上是 Cmd+B）收起/展开侧栏。主进程只建了托盘菜单，没占任何快捷键，
  // 输入框里 Ctrl+B 也没有默认行为，这个键是空的。
  // Ctrl+P / Ctrl+` / Ctrl+T（对照 dsh 的开始页卡片角标）在右侧栏打开 文件 / 终端 /
  // 浏览器 页——浏览器没有打印与「新建标签页」的默认行为可抢，这三个键也是空的。
  // 开页 + 展开：开始页还挂着时就地替换（dsh 的入口路径），开过的单例页聚焦现成的。
  // 快捷键/自检钩子可能抢在快照（会话 id）到达之前——那时先把意图排进 ref，会话一到就补开。
  const pendingDock = useRef<DockTabKind | null>(null)
  const openDock = useCallback(
    (kind: DockTabKind): void => {
      if (sessionId === '') {
        pendingDock.current = kind
        return
      }
      mutateSurface((s) => dockSetExpanded(dockOpenTab(s, kind, { replaceGuide: true }), true))
    },
    [mutateSurface, sessionId],
  )
  useEffect(() => {
    const pending = pendingDock.current
    if (sessionId === '' || pending === null) return
    pendingDock.current = null
    openDock(pending)
  }, [sessionId, openDock])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key === 'b') {
        event.preventDefault()
        toggleRail()
      } else if (key === 'p') {
        event.preventDefault()
        openDock('files')
      } else if (key === '`' || event.code === 'Backquote') {
        event.preventDefault()
        openDock('terminal')
      } else if (key === 't') {
        event.preventDefault()
        openDock('browser')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleRail, openDock])

  /** 侧栏拖宽落盘（null = 双击复位成样式表默认宽）。 */
  const resizeSidebar = (px: number | null): void => {
    setSidebarWidth(px)
    writeStoredPx(PANEL_KEYS.sidebarWidth, px)
  }

  /** 正文列拖宽落盘。 */
  const resizeThread = (px: number): void => {
    setThreadWidth(px)
    writeStoredPx(PANEL_KEYS.threadWidth, px)
  }

  /** 正文列双击复位：删掉存档，回到 76ch。 */
  const resetThread = (): void => {
    setThreadWidth(null)
    writeStoredPx(PANEL_KEYS.threadWidth, null)
  }

  // 一次性反馈统一走右下角 Toast（components/toast.ts），这里不再有输入区上方的提示条。

  // demo 模式（?demo=1，自动化验证用）：切到可用端点并自动发起一轮真实对话
  const demo = new URLSearchParams(location.search).has('demo')
  useEffect(() => {
    if (!demo) return
    const timers = [
      setTimeout(() => void proxy.setModel('deepseek/deepseek-flash'), 1200),
      setTimeout(() => proxy.submit('你好！请用两句话介绍你自己，并用行内代码格式列出一个工具名'), 1800),
    ]
    return () => timers.forEach(clearTimeout)
  }, [demo, proxy])

  // 自检钩子（截图/自动化用）：?view=skills 直接切页，?settings=models 直接开面板到某分区，
  // ?reveal=1 让只在 hover 时出现的行内按钮常驻，好拍清 hover 态
  const shotParams = useMemo(() => new URLSearchParams(location.search), [])
  useEffect(() => {
    const page = shotParams.get('view')
    if (page === 'plugins' || page === 'skills') setView(page)
    const section = shotParams.get('settings')
    if (section !== null && section !== '') setSettings({ open: true, section })
    // ?pair=1 直接开设置到「远程控制」并自动点一次「连接手机」——「手机连接」弹窗
    // （二维码 + 配对码）只有这条钩子能自动拉起来，其余入口都要人点两下
    if (shotParams.has('pair')) setSettings({ open: true, section: 'remote' })
    // ?team=1 直接开「智能体团队」面板、?subagents=1 直接展开会话标题旁的下拉（截图钩子；
    // 侧栏那档队友清单撤掉后，原来 ?teammates=1 的位置由 ?team=1 接上）
    if (shotParams.has('team')) setTeamOpen(true)
    if (shotParams.has('subagents')) setSubOpen(true)
    // ?dock=1 展开右侧栏（停在「开始」页）——多页签面板的截图钩子；分栏/多开用
    // SHOT_EVAL 点真实按钮（.dock-add / .dock-chip 右键）驱动
    if (shotParams.has('dock')) openDock('guide')
    if (shotParams.has('reveal')) document.body.classList.add('shot-reveal')
    // ?dropline=1 给第二个工作区块画上真实的落点线，好拍清拖动指示长什么样
    const dropLine = shotParams.has('dropline')
    if (dropLine) {
      const timer = setTimeout(() => {
        document.querySelector('.group:nth-child(2)')?.classList.add('drop-below')
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [shotParams])

  // ?peek=1 自动打开队友清单里的第一个（自检截图用；队友名册在磁盘上，不依赖模型）
  useEffect(() => {
    if (!shotParams.has('peek')) return
    let alive = true
    void proxy
      .listTeammates()
      .then((mates) => {
        if (alive && mates.length > 0) setPeek(mates[0]!)
      })
      .catch(() => {
        /* 没开智能体团队时这个调用会失败，自检环境里不必管 */
      })
    return () => {
      alive = false
    }
  }, [shotParams, proxy])

  const openPicker = (): void => {
    setPicker(true)
    void proxy.refreshSessions()
  }

  // 队友的运行记录是活的：这条视图开着时每两秒重读一次那个文件（只读，不动它）
  useEffect(() => {
    if (peek === null) return
    const file = peek.file
    let alive = true
    const pull = (): void => {
      proxy
        .peekTranscript(file)
        .then((entries) => {
          if (alive) setPeekEntries(entries)
        })
        .catch(() => {})
    }
    setPeekEntries([])
    pull()
    const timer = setInterval(pull, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [peek, proxy])

  // ---- 队友名册（智能体团队）：标题旁下拉 + 团队面板 + 只读运行记录共用 ----

  /** 重读名册。智能体团队插件没开时宿主会拒这个调用——那时就是没有队友，清空即可。 */
  const refreshMates = useCallback((): void => {
    void proxy.listTeammates().then(setMates, () => setMates([]))
  }, [proxy])

  // 换会话要重读：标题旁那颗数字只看本会话派出的队友，换了会话就是另一批。
  // （挂载时也走这里，冷启动的头部数字因此不用等用户打开面板。）
  const liveSessionId = snapshot === null ? null : snapshot.status.sessionId
  useEffect(() => {
    refreshMates()
  }, [refreshMates, liveSessionId])

  // 一轮收工顺手重读一次：队友是模型在跑的那一轮里派出去的，收工时名单最有可能是新的。
  // 只在「跑动 → idle」这一步读，轮中每次状态跳动不重复拉。
  const lastTurnState = useRef<RuntimeSnapshot['status']['turnState'] | null>(null)
  useEffect(() => {
    const state = snapshot === null ? null : snapshot.status.turnState
    if (lastTurnState.current !== null && lastTurnState.current !== 'idle' && state === 'idle') {
      refreshMates()
    }
    lastTurnState.current = state
  }, [snapshot, refreshMates])

  // 任务完成提醒：同一会话内「跑动 → idle」跳变时，按设置播一声提示音、并在窗口
  // 离开前台（最小化 / 缩托盘 / 失焦）时弹一条系统通知。判定与文案抽在 turn-notify.ts。
  // 前台不弹通知——那时用户正看着，提示音已经足够；两个开关互不依赖。
  const lastTurnForNotify = useRef<{ id: string; state: string } | null>(null)
  useEffect(() => {
    if (snapshot === null) return
    // sessionId 可能是 null（新会话还没落盘）——归一成空串，与顶栏标题的 ?? '#' 口径一致
    const curr = { id: snapshot.status.sessionId ?? '', state: snapshot.status.turnState }
    const prev = lastTurnForNotify.current
    lastTurnForNotify.current = curr
    if (!turnCompleted(prev, curr)) return
    if (uiPrefs.turnCompleteSound) {
      playCompletionSound(normalizeSoundVariant(uiPrefs.turnCompleteSoundVariant))
    }
    if (uiPrefs.turnCompleteNotify && isBackgrounded()) {
      // 通知标题用会话标题（照顶栏的解析口径），正文取最后一条回复的摘要
      const session = snapshot.sessions.find((s) => s.id.endsWith(`${curr.id ?? '#'}.jsonl`))
      const title = session?.title?.trim() || 'Muse Code'
      void dsc
        .notify({ title: `${title} · 任务完成`, body: completionNotifyBody(snapshot.entries) })
        .catch(() => {})
    }
  }, [snapshot, uiPrefs.turnCompleteSound, uiPrefs.turnCompleteSoundVariant, uiPrefs.turnCompleteNotify])

  // 两个面板开着的时候每 3 秒拉一次（照项目里「看的这档是活的就轮询」的惯例）：
  // 队友在后台干活，状态、轮数、耗时一直在动。
  useEffect(() => {
    if (!subOpen && !teamOpen) return
    refreshMates()
    const timer = setInterval(refreshMates, 3000)
    return () => clearInterval(timer)
  }, [subOpen, teamOpen, refreshMates])

  // Esc 关掉这两层浮层。确认框（「停掉队友？」）在捕获阶段就把 Esc 拦走了，
  // 所以关确认框那一下不会连带把面板一起关掉。
  useEffect(() => {
    if (!subOpen && !teamOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setSubOpen(false)
      setTeamOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [subOpen, teamOpen])

  // ---- 插件页动作 ----
  const refreshPlugins = (): void => {
    // 拉失败给一句提示，别让插件页静默空白（对齐 SkillsView 的 setError 范式）
    void proxy
      .listPlugins()
      .then(setPlugins)
      .catch((error: unknown) => toastErr(`插件清单读取失败：${error instanceof Error ? error.message : String(error)}`))
  }
  useEffect(() => {
    if (view === 'plugins') refreshPlugins()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])
  const togglePlugin = (file: string, next: boolean): void => {
    setPlugins((current) => current.map((p) => (p.file === file ? { ...p, enabled: next } : p)))
    proxy.setPluginEnabled(file, next)
    toastOk(`已${next ? '启用' : '停用'}插件 ${file}，即时生效`)
    // 热挂载的结果（成功/回滚）随 system 条目与下一次清单刷新回来
    setTimeout(refreshPlugins, 600)
  }
  const installPlugin = (): void => {
    void dsc.installPlugin().then((installed) => {
      if (installed.length === 0) return
      toastOk(`已安装 ${installed.join('、')}，即时生效`)
      setTimeout(refreshPlugins, 600)
    })
  }
  const restartHost = (): void => {
    void dsc.restartHost().then(() => {
      toastOk('宿主已重启')
      refreshPlugins()
    })
  }

  // ---- 侧栏动作：切工作区、存界面偏好 ----
  const switchCwd = (dir: string): void => {
    void dsc.switchCwd(dir).then((outcome) => {
      if (!outcome.ok) {
        toastErr(`切换失败：${outcome.error}`)
        return
      }
      setCwd(outcome.cwd)
      setRecentCwds((current) => [outcome.cwd, ...current.filter((entry) => entry !== outcome.cwd)].slice(0, 12))
      setView('chat')
      // 宿主刚换过进程，会话清单要从新宿主重新读一遍
      void proxy.refreshSessions()
      toastOk(`已切到 ${outcome.cwd}`)
    })
  }

  /** 写侧栏偏好（排序方式、工作区顺序、显示名别名、外观四项与过程折叠程度），成功后把新值读回来。 */
  const saveUiPrefs = (patch: Partial<UiPrefsView>): void => {
    void proxy.setUiPrefs(patch).then((result) => {
      if (!result.ok) {
        toastErr(`保存失败：${result.error}`)
        return
      }
      if (result.notice !== undefined) {
        toastOk(result.notice)
      }
      // 回读的值可能被宿主改写（读到旧档就是三档字符串、越界会被夹取），跟首帧一样归一。
      void proxy.getUiPrefs().then((prefs) => setUiPrefs(normalizeUiPrefs(prefs)))
    })
  }

  /** 切当前会话的模式（输入框那颗旋钮）；成功/失败都给一句回执。 */
  const handlePresetChange = (name: string): void => {
    void proxy.usePreset(name).then((result) => {
      if (!result.ok) {
        toastErr(`切换模式失败：${result.error}`)
        return
      }
      if (result.notice !== undefined) toastOk(result.notice)
    })
  }

  const handleSubmit = (text: string, images?: string[]): void => {
    setTab('chat')
    if (text.startsWith('/') && images === undefined) {
      // / 命令统一派发到宿主命令注册表（内置 + 外部插件命令）；
      // 命令的反馈经 transcript 条目、openPicker 经 dsc:ui 事件回到本组件。
      // 带贴图时不走命令：命令没有图可带，用户贴了图就是在发内容。
      void proxy.runCommand(text)
      return
    }
    // 新会话在首条消息落盘之前不留文件，侧栏看不见它：submit 的宿主处理器里同步
    // appendUser，RPC 回来时文件已存在，这时刷一次列表才有效（分叉路径同款坑，见 ChatView）
    proxy
      .submit(text, images)
      .then(() => proxy.refreshSessions())
      .catch(() => {})
  }

  if (hostDown !== null) {
    return (
      <div className="loading" style={{ flexDirection: 'column', gap: 14 }}>
        <div>Muse Code 宿主已退出，退出码 {String(hostDown.code)}</div>
        <button
          className="btn-primary"
          onClick={() => {
            void dsc.restartHost().then(() => setHostDown(null))
          }}
        >
          重新启动宿主
        </button>
      </div>
    )
  }

  if (snapshot === null) {
    return <div className="loading">正在启动 Muse Code 宿主…</div>
  }

  // 顶栏标题：活动会话的标题（首条用户消息），否则最近一条用户消息，否则「新会话」
  const active = snapshot.sessions.find((s) => s.id.endsWith(`${snapshot.status.sessionId ?? '#'}.jsonl`))
  const lastUser = [...snapshot.entries].reverse().find((entry) => entry.kind === 'user')
  const conversationTitle =
    active?.title ??
    (lastUser !== undefined && lastUser.kind === 'user' ? lastUser.text.slice(0, 40) : '新会话')
  // 标题旁那颗数字看的是**本会话**派出的队友：名册是跨会话的，这里自己筛一遍。
  const sessionMates = matesOf(mates, snapshot.status.sessionId)
  // 空态 = 没有任何用户/回复/工具条目（宿主预写的 system 提示行随欢迎态一起显示）
  const empty =
    !snapshot.entries.some((entry) => entry.kind !== 'system') && snapshot.status.turnState === 'idle'
  // 状态栏第三段（上下文占用）要知道当前模型的窗口：在 listModels 里按模型名认领，
  // 认不到（清单还没回来 / 模型被换掉）就是 null，那一段整个不画，不猜一个数出来。
  const contextWindow = models.find((choice) => choice.model === snapshot.status.model)?.contextWindow ?? null
  // /resume 选择器只列还在活动区的会话：归档会话的恢复入口在设置 → 归档，
  // 侧栏那份列表才是按「筛选会话」把两区混在一起看的地方。
  const resumable = snapshot.sessions.filter((session) => session.archivedAt === undefined)

  const pickSession = (id: string): void => {
    void openSession(id)
  }

  /**
   * 切到某个会话（路径）或开一个新会话（不传参数）。返回 Promise 是给「编辑重发」用的：
   * 它必须等宿主真的把当前会话换过去，才能把改好的正文作为新会话的第一条消息发出去。
   */
  const openSession = async (id?: string): Promise<void> => {
    setPicker(false)
    setTab('chat')
    setView('chat')
    // 换自己的会话就退出队友视图，别让标题还写着别人的名字
    setPeek(null)
    await proxy.openSession(id)
  }

  /**
   * 从「N 个子智能体」下拉或「智能体团队」面板点开一个队友的运行记录（只读）。
   *
   * 两层浮层都收掉：面板是盖住整窗的浮层，不收掉的话运行记录打开在它下面，用户看不见。
   * 看完记录点 Peek 头部的关闭就回到自己的会话，两颗入口随手就能再点开。
   */
  const openMate = (mate: TeammateView): void => {
    setView('chat')
    setTab('chat')
    setSubOpen(false)
    setTeamOpen(false)
    setPeek(mate)
  }

  /** 顶栏下拉：用系统能力打开当前工作区；失败原因走 Toast。 */
  const openWorkspace = (kind: 'terminal' | 'explorer' | 'vscode'): void => {
    setWsMenu(false)
    void dsc.openWorkspace(kind).then((outcome) => {
      if (!outcome.ok) toastErr(outcome.error ?? '打开失败')
    })
  }

  const copyWorkspacePath = (): void => {
    setWsMenu(false)
    void navigator.clipboard
      .writeText(cwd)
      .then(() => toastOk('已复制工作区路径'), () => toastErr('复制失败，请手动选中'))
  }

  return (
    <div className="app">
      <Sidebar
        sessions={snapshot.sessions}
        activeSessionId={snapshot.status.sessionId}
        cwd={cwd}
        usage={snapshot.status.usage}
        sessionStates={snapshot.sessionStates}
        view={view}
        onView={setView}
        onOpenSettings={(section) => setSettings({ open: true, section })}
        onNew={() => {
          setView('chat')
          setPeek(null)
          void proxy.openSession(undefined)
        }}
        onPick={pickSession}
        onChooseDir={() => {
          void dsc.chooseDirectory().then((next) => {
            if (next !== null) setCwd(next)
          })
        }}
        recentCwds={recentCwds}
        uiPrefs={uiPrefs}
        proxy={proxy}
        onSwitchCwd={switchCwd}
        onUiPrefs={saveUiPrefs}
        rail={rail}
        sidebarWidth={sidebarWidth}
        onToggleRail={toggleRail}
        onSidebarResize={resizeSidebar}
      />

      <div className="main">
        {/* 窗口控件条（最小化/最大化/关闭）独占的一档：顶栏在其下方一档，
            对照 dsh —— 原生控件一行，会话标题/页签一行，消息区再往下分开。 */}
        <div className="caption-bar" />
        {view === 'plugins' ? (
          <>
            <PluginsView
              plugins={plugins}
              proxy={proxy}
              onToggle={togglePlugin}
              onRefresh={refreshPlugins}
              onInstall={installPlugin}
              onRestartHost={restartHost}
            />
            <StatusBar status={snapshot.status} entries={snapshot.entries} contextWindow={contextWindow} />
          </>
        ) : view === 'skills' ? (
          <>
            <SkillsView proxy={proxy} />
            <StatusBar status={snapshot.status} entries={snapshot.entries} contextWindow={contextWindow} />
          </>
        ) : (
          <>
            <div className="topbar">
              <div className="topbar-title-row">
                <span className="title" data-tip={peek === null ? conversationTitle : `队友 ${peek.name} 的运行记录，只读`}>
                  {peek === null ? conversationTitle : `队友 ${peek.name}`}
                </span>
                {/* 本会话派出的子智能体（对齐 dsh 的「55 个子智能体」下拉）：一个都没有时
                    整颗不渲染，标题右边不留空壳。 */}
                {sessionMates.length > 0 && (
                  <SubagentMenu
                    mates={sessionMates}
                    currentSessionId={snapshot.status.sessionId}
                    open={subOpen}
                    onToggle={() => setSubOpen((current) => !current)}
                    proxy={proxy}
                    peekFile={peek?.file ?? null}
                    onPeek={openMate}
                    onChanged={refreshMates}
                  />
                )}
                {/* 本会话的队伍（对照 dsh 团队挂在 lead 会话之下）：与上一颗的分工写在面板顶部 */}
                <button
                  className="team-btn"
                  data-tip="智能体团队：本会话派出的队伍，可停止 / 发话 / 看运行记录"
                  onClick={() => setTeamOpen(true)}
                >
                  智能体团队
                </button>
                <div className="drag-fill" />
                {/* 多种方式打开当前工作区（对照 dsh 的「文件夹+下拉」分组钮）：
                    主钮直接开文件资源管理器，下拉里还有终端 / VS Code / 复制路径。 */}
                <div className="ws-open">
                  <button className="ws-open-main" data-tip="在文件资源管理器中打开工作区" onClick={() => openWorkspace('explorer')}>
                    <IconFolderOpen size={15} />
                  </button>
                  <button className="ws-open-caret" data-tip="更多打开方式" onClick={() => setWsMenu((current) => !current)}>
                    <IconChevronDown size={13} />
                  </button>
                  {wsMenu && (
                    <>
                      <div className="menu-backdrop" onClick={() => setWsMenu(false)} />
                      <div className="row-menu ws-open-menu" role="menu">
                        <button className="menu-item" onClick={() => openWorkspace('terminal')}>
                          <IconTerminal size={14} /> 在终端中打开
                        </button>
                        <button className="menu-item" onClick={() => openWorkspace('explorer')}>
                          <IconFolderOpen size={14} /> 在文件资源管理器中打开
                        </button>
                        <button className="menu-item" onClick={() => openWorkspace('vscode')}>
                          <IconCode size={14} /> 在 VS Code 中打开
                        </button>
                        <div className="menu-sep" />
                        <button className="menu-item" onClick={copyWorkspacePath}>
                          <IconCopy size={14} /> 复制工作区路径
                        </button>
                      </div>
                    </>
                  )}
                </div>
                {/* 侧栏开关（对照 dsh 的 ExpandButton）：只在收起时渲染。展开后右上角
                    由 dock 页签条尾的收起钮接管同一个角落——两颗钮不同时在场，视觉上
                    「开关永远在原位」，面板打开也不会把顶栏这颗挤得左移。 */}
                {!surface.expanded && (
                  <button
                    className="icon-btn dock-toggle"
                    data-tip="工作区面板：开始、终端、浏览器、文件、Git"
                    onClick={() => dockActions.setExpanded(true)}
                  >
                    <IconSidebar size={15} />
                  </button>
                )}
              </div>
              {peek === null && (
                <nav className="tabs">
                  <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
                    对话
                  </button>
                  <button className={tab === 'trace' ? 'on' : ''} onClick={() => setTab('trace')}>
                    轨迹
                  </button>
                </nav>
              )}
            </div>

            <div className="thread-zone" ref={zoneRef} data-review={review !== null || undefined}>
              {/* 空会话：引导文案 + 输入框作为一个组垂直居中（对照 dsh 的 EmptyHero）；
              条件与下面 Welcome 分支完全一致，轨迹页 / 队友记录不进居中容器。 */}
              <div
                className={
                  peek === null && tab !== 'trace' && empty ? 'thread-main thread-main-empty' : 'thread-main'
                }
              >
              {peek !== null ? (
                <TeammatePeek teammate={peek} entries={peekEntries} onClose={() => setPeek(null)} />
              ) : tab === 'trace' ? (
                <TraceView entries={snapshot.entries as TranscriptEntry[]} status={snapshot.status} />
              ) : empty ? (
                <Welcome systemEntries={snapshot.entries.filter((entry) => entry.kind === 'system')} />
              ) : (
                <ChatView
                  entries={snapshot.entries as TranscriptEntry[]}
                  turnState={snapshot.status.turnState}
                  sessionId={snapshot.status.sessionId}
                  sessionPath={active?.id ?? null}
                  proxy={proxy}
                  onOpenSession={openSession}
                  // 轮尾「文件已更改」卡：审查开右侧 diff 面板，打开进文件预览页签
                  onReviewChanges={(files, index) => setReview({ files, index })}
                  onOpenFile={(path, line) => dockActions.openPreview(path, line)}
                  cwd={cwd}
                  // 过程折叠程度（设置 → 通用 → 过程折叠程度）：四档能力表在 appearance.ts，
                  // 渲染层只读能力。另两项是「单条思考 / 工具卡」的默认态（设置 → 通用）。
                  processFold={uiPrefs.processFold}
                  reasoningDefaultOpen={uiPrefs.reasoningDefaultOpen}
                  toolDefaultOpen={uiPrefs.toolDefaultOpen}
                />
              )}

              <div className="composer-zone">
                {snapshot.surfaces.pendingApproval !== null && (
                  <ApprovalCard
                    request={snapshot.surfaces.pendingApproval}
                    onAnswer={(answer) => proxy.answerApproval(answer)}
                    cwd={cwd}
                  />
                )}
                {snapshot.surfaces.pendingPlan !== null && (
                  <PlanReview
                    key={snapshot.surfaces.pendingPlan.file}
                    plan={snapshot.surfaces.pendingPlan}
                    onAnswer={(decision, feedback) => void proxy.answerPlan(decision, feedback)}
                  />
                )}
                {snapshot.surfaces.pendingQuestion !== null && (
                  <AskCard
                    question={snapshot.surfaces.pendingQuestion}
                    onAnswer={(answer) => void proxy.answerQuestion(answer)}
                  />
                )}
                {snapshot.surfaces.goal !== null && (
                  <GoalBar goal={snapshot.surfaces.goal} onAction={(action) => void proxy.goalAction(action)} />
                )}
                <TaskDock todos={snapshot.surfaces.todos} onClear={() => void proxy.clearTodos()} />
                {picker ? (
                  <SessionPicker
                    sessions={resumable}
                    loading={snapshot.sessionsLoading}
                    onPick={pickSession}
                    onClose={() => setPicker(false)}
                  />
                ) : null}
                {peek === null ? (
                  <Composer
                    disabled={snapshot.surfaces.pendingApproval !== null}
                    models={models}
                    model={snapshot.status.model}
                    effort={snapshot.status.effort}
                    policy={snapshot.surfaces.policy}
                    preset={snapshot.surfaces.preset}
                    working={snapshot.status.turnState !== 'idle'}
                    cwd={cwd}
                    listFiles={listWorkspaceFiles}
                    onSubmit={handleSubmit}
                    onInterrupt={() => proxy.interrupt()}
                    onModelChange={(value) => void proxy.setModel(value)}
                    onEffortChange={(value) => void proxy.setEffort(value)}
                    onPolicyChange={(value) => proxy.setPolicy(value)}
                    onPresetChange={(value) => handlePresetChange(value)}
                  />
                ) : (
                  <div className="peek-lock">
                    你在看队友 {peek.name} 的运行记录，这里是只读的：写不了字，也改不了它的上下文。
                    要跟它说话，用会话标题旁那两颗入口里的「发话」（走宿主转交给它）；
                    模型之间派活仍走
                    <code>subagent</code> 工具。
                  </div>
                )}
              </div>
              </div>

              {/* 正文两侧的拖拽条只在真正在读对话时出现：欢迎页、轨迹页、看队友记录都没有
                  一列正文可以对齐；审查面板打开时右缘被面板占着，拖拽条一并让位。 */}
              {tab === 'chat' && peek === null && !empty && review === null ? (
                <ThreadResizer
                  zoneRef={zoneRef}
                  width={threadWidth}
                  onCommit={resizeThread}
                  onReset={resetThread}
                />
              ) : null}

              {/* 轮尾「文件已更改」卡的审查面板：并排在正文右侧（对照 dsh 的右栏审查）。
                  关闭即整体收起；下次点「审查」会带上那一轮的文件清单重新打开。 */}
              {review !== null && (
                <DiffPane
                  files={review.files}
                  index={review.index}
                  cwd={cwd}
                  onSelect={(index) => setReview((current) => (current === null ? current : { ...current, index }))}
                  onOpen={(path) => dockActions.openPreview(path)}
                  onOpenSystem={(path) => {
                    void dsc.openPath(path).then((error) => {
                      if (error !== '') toastErr(`系统打开失败：${error}`)
                    })
                  }}
                  onClose={() => setReview(null)}
                />
              )}
            </div>

            <StatusBar status={snapshot.status} entries={snapshot.entries} contextWindow={contextWindow} />
          </>
        )}
      </div>

      {/* dock 常驻挂载：收起 = 整块滑出右缘（终端进程与输出都活着），布局随会话走 */}
      {sessionId !== '' && (
        <Dock
          surface={surface}
          actions={dockActions}
          cwd={cwd}
          proxy={proxy}
          width={dockWidth}
          onResize={(width) => {
            setDockWidth(width)
            try {
              localStorage.setItem('dsc.dockWidth', String(width))
            } catch {
              // 存不下（隐私模式/配额满）只影响下次启动的默认宽，不该打断拖拽
            }
          }}
        />
      )}

      {/* 团队面板与设置面板同档浮层（都用 .settings-mask + .settings）——本会话的队伍，
          其它会话的队友在面板底部只读折叠。点一行看运行记录时它自己收起来（见 openMate）。 */}
      {teamOpen && (
        <TeamPanel
          mates={mates}
          currentSessionId={snapshot.status.sessionId}
          proxy={proxy}
          peekFile={peek?.file ?? null}
          onClose={() => setTeamOpen(false)}
          onPeek={openMate}
          onChanged={refreshMates}
        />
      )}

      <SettingsModal
        open={settings.open}
        proxy={proxy}
        initial={settings.section}
        autoAction={shotParams.has('pair') ? 'regenerate-code' : undefined}
        uiPrefs={uiPrefs}
        onUiPrefs={saveUiPrefs}
        onClose={() => setSettings((current) => ({ ...current, open: false }))}
      />
    </div>
  )
}

/** 空会话欢迎态：居中引导文案 + 宿主预写的 system 提示行。入口卡在右侧栏的「开始」页里（对照 dsh），这里不放。 */
function Welcome(props: { systemEntries: { id: number; text: string }[] }): JSX.Element {
  // 开场那条「会话 x · 模型 y」不画：它已经在状态栏第一段的悬浮提示里（见 session-marker.ts）。
  const notes = props.systemEntries.filter((entry) => !isSessionMarker(entry.text))
  return (
    <div className="welcome">
      <h1>有什么可以帮忙的？</h1>
      <p>
        输入 <code>/</code> 查看可用指令 · 消息会携带当前工作目录上下文
      </p>
      {notes.map((entry) => (
        <div key={entry.id} className="welcome-note">
          {entry.text}
        </div>
      ))}
    </div>
  )
}
