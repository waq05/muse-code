/**
 * 侧栏：品牌区、新会话、工作区分组的会话列表、底部工作目录与用量。
 *
 * 工作区交互对齐 dsh 桌面端（ui-workspace 包）：
 *   - 点工作区行 = 只切换它自己的展开/收起，别的组不跟着动；切换工作区靠
 *     点它的会话（跨区打开）或行尾「新建会话」（宿主重启换 cwd）；
 *   - 展开状态按工作区持久化在 `uiPrefs.sessionExpansion`，当前工作区（树模式
 *     连同祖先）自动展开并落盘，重开应用原样恢复；
 *   - 「手动排序」档：工作区行拖动排序（顺序写 workspaceOrder），会话行在
 *     置顶块内互拖（顺序写 sessionOrder）；
 *   - 每组默认显示 5 条会话，展开剩余按 +5 增量走到底，再点「收起」折回；
 *   - 会话行：单击打开、双击标题改名，行尾时间戳与操作钮在 hover 时互换，
 *     置顶标记贴行尾（dsh 同位）。
 * 快捷键刻意绑在行元素上而不是全局，避免和输入框抢键（Ctrl+Alt+R 改名、
 * Ctrl+Alt+F 分叉、Ctrl+Shift+A 归档）。
 *
 * 这一档只放自己的会话：队友名册（原来「会话 | 队友」双 tab 的右边那半）连同运行记录
 * 一起搬到了会话标题旁的「智能体团队」，这里不再认识队友这件事。
 *
 * @module desktop/renderer/Sidebar
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type JSX, type KeyboardEvent } from 'react'
import type { SessionRunState, SessionSummary, SettingsMutation, TokenUsageView, UiPrefsView } from '@dsc/runtime/contract.js'
import iconUrl from '../../build/icon.png'
import { confirmAction } from './components/confirm.js'
import { toastErr, toastOk } from './components/toast.js'
import { dsc, type RuntimeProxy } from './bridge.js'
import { SIDEBAR_MAX, SIDEBAR_MIN, readRootPx, setRootVar, useWidthDrag } from './panels.js'
import { moveToEnd, moveWithin } from './workspace-order.js'
import { buildWorkGroups, displayName, lastSegment, orderedSessions, relative, type WorkGroup } from './sidebar-groups.js'
import { formatTokens } from './token-estimate.js'
import {
  IconArchive,
  IconArchiveOff,
  IconBolt,
  IconCalendar,
  IconCheck,
  IconClock,
  IconClose,
  IconCoins,
  IconCopy,
  IconEdit,
  IconFlatList,
  IconFolder,
  IconFolderOpen,
  IconGear,
  IconMore,
  IconNewChat,
  IconPin,
  IconPlus,
  IconPuzzle,
  IconQueue,
  IconRefresh,
  IconSearch,
  IconSidebar,
  IconSort,
  IconSwap,
  IconTriangleRightFill,
  IconTree,
} from './icons.js'

/** 左栏页面（技能/插件各占一页，其余时间显示对话）。 */
export type SidebarView = 'chat' | 'plugins' | 'skills'

/** 归档确认框里那句后果说明：写清去向与「消息不删」，免得用户把归档当成删除。 */
const ARCHIVE_DETAIL_ONE = '会话会离开侧栏，移进「设置 → 归档」的归档区；消息一个字不删，想回来去归档里点「恢复」。'
const ARCHIVE_DETAIL_MANY = '这些会话会离开侧栏，移进「设置 → 归档」的归档区；消息一个字不删，想回来去归档里点「恢复」。'

export function Sidebar(props: {
  sessions: SessionSummary[]
  activeSessionId: string | null
  cwd: string
  usage: TokenUsageView | null
  view: SidebarView
  /** 侧栏界面偏好：会话排序方式、工作区手动顺序与显示名别名。 */
  uiPrefs: UiPrefsView
  /** 最近用过的工作目录：切过去但还没发过消息的工作区也要显示出来。 */
  recentCwds: string[]
  proxy: RuntimeProxy
  onView(view: SidebarView): void
  /** 打开设置面板（参数是要定位到的分区 id）。 */
  onOpenSettings(section: string): void
  onNew(): void
  onPick(id: string): void
  onChooseDir(): void
  /** 切到另一个工作目录（宿主重启并换 cwd）。 */
  onSwitchCwd(cwd: string): void
  /** 改界面偏好（会话排序、工作区顺序、显示名别名）：写盘与状态更新都在 App。 */
  onUiPrefs(patch: Partial<UiPrefsView>): void
  /** 侧栏收成 56px 图标窄栏（Ctrl+B，或点窄栏最上面那颗 logo）。 */
  rail: boolean
  /** 拖出来的侧栏宽度（px）。null = 没拖过，用样式表默认的 237px。 */
  sidebarWidth: number | null
  /** 收起 / 展开侧栏。 */
  onToggleRail(): void
  /** 侧栏拖宽落盘（null = 双击复位成默认宽）。 */
  onSidebarResize(width: number | null): void
  /** 跨会话运行状态面（T21）：会话 jsonl 路径 → 运行状态，行首状态点的数据源。 */
  sessionStates: Record<string, SessionRunState>
}): JSX.Element {
  /** 每组默认露出的会话条数（其余收进「展开剩余」，dsh 的 COLLAPSED_SESSION_LIMIT）。 */
  const PREVIEW_COUNT = 5
  /**
   * 展开态的本地即时层：点一下就生效，不等宿主落盘回读（`uiPrefs.sessionExpansion`
   * 是异步回来的真值层，本地没有的键才读它）。dsh 的 groupExpansion 也是这个
   * 「写穿 + 本地读」的形状。
   */
  const [localExpansion, setLocalExpansion] = useState<Record<string, boolean>>({})
  /** 每组露出的会话条数（cwd → 条数；缺省 PREVIEW_COUNT）。不落盘，收组即重置（dsh 同）。 */
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>({})
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  /** 打开着行菜单的行（工作区行是 `w:<cwd>`，会话行是 `s:<路径>`）。会话行由右键唤起，
      带指针坐标（fixed 贴指针，与 dock 页签右键菜单同款）；工作区行由 `···` 唤起，带按钮
      坐标（fixed 贴按钮，底部放不下翻到按钮上方）——就地展开会被滚动区的 overflow 裁掉，
      视图菜单当年就是这个坑（见 viewMenu 的注释）。 */
  const [menu, setMenu] = useState<{
    key: string
    /** 右键唤起：指针坐标。 */
    x?: number
    y?: number
    /** `···` 唤起：菜单左缘横坐标 + 纵向锚（top = 按钮下方，bottom = 按钮上方，二选一）。 */
    left?: number
    top?: number
    bottom?: number
  } | null>(null)
  /**
   * 视图选项菜单（分组 / 排序 / 筛选）的落点。用视口坐标而不是就地绝对定位：
   * 这个菜单挂在滚动区里的头部上，就地定位会被 `overflow-y: auto` 裁掉。
   */
  const [viewMenu, setViewMenu] = useState<{ top: number; right: number } | null>(null)
  /** 正在改名的行。 */
  const [editing, setEditing] = useState<{ key: string; kind: 'workspace' | 'session'; value: string } | null>(null)
  /** 分叉位置选择器：会话路径 + 可选的用户消息清单。 */
  const [fork, setFork] = useState<{ path: string; points: string[] } | null>(null)
  const [dragCwd, setDragCwd] = useState<string | null>(null)
  /** 拖动时的落点：插到这一组工作区之前（after=false）还是之后（after=true）。 */
  const [dropAt, setDropAt] = useState<{ cwd: string; after: boolean } | null>(null)
  /**
   * 会话行拖拽（manual 档）：来源（cwd + 路径 + 是否置顶）与当前落点。
   * 置顶行只能在置顶块内互拖（dsh 的 pinned 块约束），跨组拖动不收。
   */
  const [sessDrag, setSessDrag] = useState<{
    cwd: string
    id: string
    pinned: boolean
    over: { id: string; half: 'before' | 'after' } | null
  } | null>(null)
  /**
   * 待新建会话的目标工作区。切换工作目录要重启宿主（新会话的 cwd 由宿主启动时的
   * 目录决定），而 App 的 onSwitchCwd 不返回 Promise，所以只能先登记目标目录，
   * 等 cwd 真的切过去再开新会话（见下面那个 effect）。
   */
  const [pendingNew, setPendingNew] = useState<string | null>(null)
  /** 刚拖完就不要再触发一次「点击切换工作区」。 */
  const justDragged = useRef(false)

  const aliases = props.uiPrefs.workspaceAliases
  const order = props.uiPrefs.workspaceOrder
  const trimmed = query.trim().toLowerCase()

  /** 跑一个会话库操作：结果用 Toast 回执，成功后刷新列表。 */
  const run = async (task: Promise<SettingsMutation>, then?: () => void): Promise<void> => {
    try {
      const result = await task
      if (result.ok) toastOk(result.notice ?? '已完成')
      else toastErr(`操作失败：${result.error}`)
      if (result.ok) {
        await props.proxy.refreshSessions()
        then?.()
      }
    } catch (error) {
      toastErr(`操作失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 归档先弹确认框把去向说清楚（离开侧栏 → 归档区，找回要去设置），点了确认才动手；
   * 执行结果的回执仍由 run() 统一发。可逆操作，主按钮不走红色危险档。
   */
  const archiveWithConfirm = (paths: string[], title: string, detail: string): void => {
    void confirmAction({ title, detail, confirmLabel: '归档' }).then((yes) => {
      if (yes) void run(props.proxy.archiveSessions(paths))
    })
  }

  const sort = props.uiPrefs.sessionSort
  const group = props.uiPrefs.sessionGroup
  const archived = props.uiPrefs.archivedFilter

  const groups = useMemo(
    () => buildWorkGroups({
      sessions: props.sessions,
      recentCwds: props.recentCwds,
      cwd: props.cwd,
      sort,
      group,
      archived,
      trimmed,
      aliases,
      order,
      sessionOrder: props.uiPrefs.sessionOrder,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.sessions, props.recentCwds, props.cwd, order, aliases, trimmed, sort, group, archived, props.uiPrefs.sessionOrder],
  )

  const isActiveGroup = (cwd: string): boolean => cwd === props.cwd

  // 组行的活动指示跟选中会话走（dsh 的 containsCurrent：组 active = 含当前会话）——
  // 跨工作区点开历史会话时，会话行高亮了，所属工作区的图标也得跟着亮，不然看不出
  // 这条会话挂在哪个组下。没有选中会话（新会话空态）或它被搜索/归档筛出列表时回落
  // 宿主 cwd，保住「你现在跑在哪个工作区」的指示。
  const activeCwd = useMemo(() => {
    if (props.activeSessionId !== null) {
      const suffix = `${props.activeSessionId}.jsonl`
      const owner = groups.find((item) => item.sessions.some((session) => session.id.endsWith(suffix)))
      if (owner !== undefined) return owner.cwd
    }
    return props.cwd
  }, [groups, props.activeSessionId, props.cwd])
  /** 树里带子分组的行（折叠它要连带收起后代，且默认展开）。 */
  const parents = useMemo(() => new Set(groups.filter((item) => item.hasChildren).map((item) => item.cwd)), [groups])

  /**
   * 展开真值（dsh 的 groupExpansion 语义）：本地即时层 → 宿主落盘层 → 默认档
   * （树模式的父分组展开，其余收起）。键缺失才谈默认，所以点过的组记住自己的
   * 选择，别的组不会被牵连；搜索时照旧全部展开。
   */
  const isExpanded = (cwd: string): boolean => {
    if (trimmed !== '') return true
    const explicit = localExpansion[cwd] ?? props.uiPrefs.sessionExpansion[cwd]
    if (explicit !== undefined) return explicit
    return group === 'tree' && parents.has(cwd)
  }

  /** 切换一组的展开态：本地立即生效，同时写进 uiPrefs 落盘；别的组一个不碰。 */
  const toggle = (cwd: string): void => {
    const next = !isExpanded(cwd)
    setLocalExpansion((current) => ({ ...current, [cwd]: next }))
    props.onUiPrefs({ sessionExpansion: { ...props.uiPrefs.sessionExpansion, [cwd]: next } })
    // 收组时把「展开剩余」的进度折回默认档（dsh：收组重置本组限额）
    setSessionLimits((limits) => ({ ...limits, [cwd]: PREVIEW_COUNT }))
  }

  // 当前工作区（树模式连同祖先链）自动展开并落盘——dsh 的 setGroupExpanded(currentGroup, true)：
  // 点开哪个工作区的会话，那个组就保持展开，切走再回来也不会塌。列表加载完（groups
  // 变化）也要补一次：树模式的祖先链要等分组算出来才知道。
  useEffect(() => {
    if (props.cwd === '') return
    const chain = [props.cwd]
    if (group === 'tree') {
      for (const item of groups) {
        if (item.cwd === props.cwd) chain.push(...item.ancestors)
      }
    }
    const patch: Record<string, boolean> = {}
    for (const key of chain) {
      const explicit = localExpansion[key] ?? props.uiPrefs.sessionExpansion[key]
      // dsh 的 Object.hasOwn 守卫：没有记录才补展开；用户显式收起过（记录 false）
      // 的组必须尊重，否则会话列表一刷新 effect 重跑就把收起弹回去了（0.6.22 实测）。
      if (explicit === undefined) patch[key] = true
    }
    if (Object.keys(patch).length === 0) return
    setLocalExpansion((current) => ({ ...current, ...patch }))
    props.onUiPrefs({ sessionExpansion: { ...props.uiPrefs.sessionExpansion, ...patch } })
    // onUiPrefs 是 App 每次渲染新建的箭头函数，只认 cwd/group/groups 这几个真值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.cwd, group, groups])

  /** 祖先里只要有一个被折叠，这一组就不出现在列表里。 */
  const hiddenByAncestor = (item: WorkGroup): boolean => item.ancestors.some((ancestor) => !isExpanded(ancestor))

  /** 单列表：不分工作区，所有会话混成一条按排序方式排好的流。 */
  const flatSessions = orderedSessions(undefined, groups.flatMap((item) => item.sessions), sort, props.uiPrefs.sessionOrder)

  /** 视图选项菜单的三组（对照 dsh 的「分组方式 / 排序方式 / 筛选会话」）。 */
  const viewSections: { label: string; items: { id: string; text: string; icon: JSX.Element; active: boolean }[] }[] = [
    {
      label: '分组方式',
      items: [
        { id: 'workspace', text: '按工作区', icon: <IconFolder size={15} />, active: group === 'workspace' },
        { id: 'tree', text: '按工作区树', icon: <IconTree size={15} />, active: group === 'tree' },
        { id: 'flat', text: '单列表', icon: <IconFlatList size={15} />, active: group === 'flat' },
      ],
    },
    {
      label: '排序方式',
      items: [
        { id: 'manual', text: '手动排序', icon: <IconSwap size={15} />, active: sort === 'manual' },
        { id: 'recent', text: '最近更新', icon: <IconClock size={15} />, active: sort === 'recent' },
        { id: 'created', text: '创建时间', icon: <IconCalendar size={15} />, active: sort === 'created' },
      ],
    },
    {
      label: '筛选会话',
      items: [
        { id: 'hide', text: '隐藏已归档', icon: <IconArchiveOff size={15} />, active: archived === 'hide' },
        { id: 'show', text: '全部对话（显示已归档）', icon: <IconQueue size={15} />, active: archived === 'show' },
        { id: 'only', text: '仅显示已归档', icon: <IconArchive size={15} />, active: archived === 'only' },
      ],
    },
  ]

  /** 菜单里选了一项：按 id 分别落到界面偏好的三个字段上，然后收起菜单。 */
  const pickView = (id: string): void => {
    if (id === 'workspace' || id === 'tree' || id === 'flat') props.onUiPrefs({ sessionGroup: id })
    else if (id === 'manual' || id === 'recent' || id === 'created') props.onUiPrefs({ sessionSort: id })
    else if (id === 'hide' || id === 'show' || id === 'only') props.onUiPrefs({ archivedFilter: id })
    setViewMenu(null)
  }

  /** 点工作区行 = 只切换它自己的展开/收起（dsh 语义，别的组不牵连）；刚拖完不触发。 */
  const clickGroup = (cwd: string): void => {
    if (justDragged.current === true) return
    toggle(cwd)
  }

  /**
   * 在指定工作区里新建会话（文件夹行那颗「+」）。
   *
   * 为什么分两步：新会话的 cwd 是宿主进程启动时的目录（core/session.ts 里
   * `Session.create(cwd)`），要换工作区就得先重启宿主切目录；而 App 的
   * onSwitchCwd 不返回 Promise，所以这里登记目标目录后由下面的 effect 接力，
   * 顺序反了会把会话建在旧目录下。
   */
  const newSessionIn = (cwd: string): void => {
    if (isActiveGroup(cwd)) {
      props.onNew()
      return
    }
    setPendingNew(cwd)
    props.onSwitchCwd(cwd)
  }

  // 目标目录切过来了就开新会话；切不过去（目录被删、宿主起不来）就 8 秒后放弃登记，
  // 免得这个待办一直挂着，用户以后手动点到这个目录时突然冒出一个新会话。
  // 比对大小写不敏感：Windows 路径本身就分不清大小写，会话里存的目录名与
  // 主进程 resolve() 出来的未必逐字相同。
  useEffect(() => {
    if (pendingNew === null) return
    if (props.cwd.toLowerCase() !== pendingNew.toLowerCase()) {
      const timer = setTimeout(() => setPendingNew(null), 8000)
      return () => clearTimeout(timer)
    }
    setPendingNew(null)
    props.onNew()
    // onNew 是 App 每次渲染新建的箭头函数，进依赖会让这个 effect 每渲染跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNew, props.cwd])

  /** 把 source 挪到 target 之前或之后，其余保持当前视觉顺序，然后存起来。 */
  const reorder = (source: string, target: string, after: boolean): void => {
    const current = groups.map((item) => item.cwd)
    const next = moveWithin(current, source, target, after)
    if (next.join('\n') === current.join('\n')) return
    props.onUiPrefs({ workspaceOrder: next })
  }

  /** 拖到列表末尾的落点。 */
  const dropAtEnd = (source: string): void => {
    const current = groups.map((item) => item.cwd)
    const next = moveToEnd(current, source)
    if (next.join('\n') === current.join('\n')) return
    props.onUiPrefs({ workspaceOrder: next })
  }

  /** 一次拖拽收尾：清掉指示线，并短暂压制紧随其后的 click。 */
  const endDrag = (): void => {
    setDragCwd(null)
    setDropAt(null)
    justDragged.current = true
    setTimeout(() => {
      justDragged.current = false
    }, 150)
  }

  /** 会话行拖拽的行内落点（dsh 的 rowHalf：指针在行的上/下半段）。 */
  const sessRowHalf = (event: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  /**
   * 会话行拖拽收尾（dsh 的 sessionDragOrder 语义）：把来源会话插到落点之前/之后，
   * 保存这一组的完整会话顺序。置顶块约束由拖拽侧保证（只允许同块目标），这里再
   * 按块校验一遍插入位，跨块的落点直接丢弃。
   */
  const commitSessDrag = (): void => {
    const current = sessDrag
    setSessDrag(null)
    if (current === null || current.over === null) return
    const { cwd, id: sourceId, pinned, over } = current
    if (over.id === sourceId) return
    const group = groups.find((item) => item.cwd === cwd)
    if (group === undefined) return
    const ordered = orderedSessions(cwd, group.sessions, sort, props.uiPrefs.sessionOrder)
    const full = ordered.map((session) => session.id)
    const section = ordered.filter((session) => (session.pinnedAt !== undefined) === pinned)
    const sourceIndex = section.findIndex((session) => session.id === sourceId)
    if (sourceIndex === -1) return
    const withoutSource = section.filter((session) => session.id !== sourceId)
    const insertAt = withoutSource.findIndex((session) => session.id === over.id) + (over.half === 'after' ? 1 : 0)
    if (insertAt === sourceIndex) return
    const next = full.filter((id) => id !== sourceId)
    const targetIndex = next.indexOf(over.id)
    if (targetIndex === -1) return
    next.splice(targetIndex + (over.half === 'after' ? 1 : 0), 0, sourceId)
    props.onUiPrefs({ sessionOrder: { ...props.uiPrefs.sessionOrder, [cwd]: next } })
  }

  const startRename = (key: string, kind: 'workspace' | 'session', value: string): void => {
    setMenu(null)
    setEditing({ key, kind, value })
  }

  const commitRename = (): void => {
    if (editing === null) return
    const { key, kind, value } = editing
    setEditing(null)
    const name = value.trim()
    if (name === '') return
    if (kind === 'session') {
      void run(props.proxy.renameSession(key.slice(2), name))
      return
    }
    props.onUiPrefs({ workspaceAliases: { ...aliases, [key.slice(2)]: name } })
  }

  const openFork = async (path: string): Promise<void> => {
    setMenu(null)
    const points = await props.proxy.listUserMessages(path)
    if (points.length < 2) {
      toastErr('可分叉的位置不足，至少需要两条用户消息')
      return
    }
    setFork({ path, points })
  }

  const doFork = async (index: number): Promise<void> => {
    if (fork === null) return
    const target = fork.path
    setFork(null)
    const result = await props.proxy.forkSession(target, index)
    if (!result.ok) {
      toastErr(`分叉失败：${result.error}`)
      return
    }
    await props.proxy.refreshSessions()
    toastOk(`已分叉出新会话，包含第 ${index + 1} 条消息之前的内容`)
    props.onPick(result.path)
  }

  const clearAlias = (cwd: string): void => {
    const next = { ...aliases }
    delete next[cwd]
    setMenu(null)
    props.onUiPrefs({ workspaceAliases: next })
  }

  const reveal = (cwd: string): void => {
    setMenu(null)
    void dsc.openPath(cwd).then((problem) => {
      if (problem !== '') toastErr(`打开失败：${problem}`)
    })
  }

  /**
   * 复制一段文本到系统剪贴板。
   *
   * 首选 navigator.clipboard（Electron 里的页面算可信来源，和顶栏「复制工作区路径」
   * 走同一条路）；它不存在时退回 textarea + execCommand，免得这一项点了没反应。
   */
  const copyText = async (text: string, okText: string): Promise<void> => {
    const clipboard = navigator.clipboard as Clipboard | undefined
    try {
      if (clipboard !== undefined) {
        await clipboard.writeText(text)
      } else {
        const box = document.createElement('textarea')
        box.value = text
        box.style.position = 'fixed'
        box.style.opacity = '0'
        document.body.append(box)
        box.select()
        const ok = document.execCommand('copy')
        box.remove()
        if (!ok) throw new Error('execCommand 复制返回 false')
      }
      toastOk(okText)
    } catch {
      toastErr('复制失败，请手动选中')
    }
  }

  /**
   * 复制会话 ID：写进剪贴板的是会话 uuid，不是标题、也不是 jsonl 的完整路径。
   *
   * 注意 SessionSummary.id 存的是 jsonl 的绝对路径（见 contract.ts:305），
   * uuid 只是它的文件名，所以这里先剥一层。
   */
  const copySessionId = (path: string): void => {
    setMenu(null)
    void copyText(uuidOf(path), '已复制会话 ID')
  }

  const totalTokens = props.usage !== null ? props.usage.inputTokens + props.usage.outputTokens : 0

  /** 行级快捷键：只在焦点落在这行本身（不是里面的输入框）时生效。 */
  const rowKeys = (
    event: KeyboardEvent<HTMLDivElement>,
    key: string,
    kind: 'workspace' | 'session',
  ): void => {
    if (event.target !== event.currentTarget) return
    const lower = event.key.toLowerCase()
    if (event.ctrlKey && event.altKey && lower === 'r') {
      event.preventDefault()
      const value = kind === 'session' ? (props.sessions.find((s) => s.id === key.slice(2))?.title ?? '') : displayName(key.slice(2), aliases)
      startRename(key, kind, value)
      return
    }
    if (kind === 'session' && event.ctrlKey && event.altKey && lower === 'f') {
      event.preventDefault()
      void openFork(key.slice(2))
      return
    }
    if (kind === 'session' && event.ctrlKey && event.shiftKey && lower === 'a') {
      event.preventDefault()
      const target = props.sessions.find((session) => session.id === key.slice(2))
      // 归档区里的行不再走归档（会报「不能重复归档」），它要的是行内那颗「恢复」
      if (target?.archivedAt !== undefined) return
      archiveWithConfirm([key.slice(2)], `归档会话「${target?.title ?? '未命名会话'}」？`, ARCHIVE_DETAIL_ONE)
    }
  }

  // 右边界拖拽调宽：拖动中只改 CSS 变量，松手才把宽度交给 App 落盘。
  const resizeDrag = useWidthDrag({
    // 兜底数 237 只在样式表那条 --dsc-sidebar-w 被改坏时才会用到。
    getBase: () => props.sidebarWidth ?? readRootPx('--dsc-sidebar-w', 237),
    sign: 1,
    clamp: (px) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px))),
    onDrag: (px) => setRootVar('--dsc-sidebar-w', `${px}px`),
    onCommit: (px) => props.onSidebarResize(px),
  })

  /**
   * 会话行：分组列表、单列表、归档区共用这一份渲染。
   * 归档行置灰，点开被拦下（要先用行尾的「恢复」把它移回活动区），行操作也跟着换成恢复。
   */
  const renderSession = (session: SessionSummary, groupCwd?: string): JSX.Element => {
    const sKey = `s:${session.id}`
    const isArchived = session.archivedAt !== undefined
    const blocked = (): void => {
      toastErr('这个会话已归档：先点行尾的「恢复」再打开')
    }
    // 会话行拖拽（manual 档）：只在同一组、同一置顶块内互拖；归档行不拖。
    const draggable = sort === 'manual' && !isArchived && editing === null && groupCwd !== undefined
    const dragCompatible =
      sessDrag !== null && groupCwd !== undefined && sessDrag.cwd === groupCwd && sessDrag.pinned === (session.pinnedAt !== undefined)
    const dropMark =
      sessDrag !== null && sessDrag.over !== null && sessDrag.over.id === session.id ? sessDrag.over.half : null
    return (
      <div
        key={session.id}
        className={`sess-item${isArchived ? ' archived' : ''}${session.id.endsWith(`${props.activeSessionId ?? '#'}.jsonl`) ? ' active' : ''}${
          dropMark === 'before' ? ' drop-above' : ''
        }${dropMark === 'after' ? ' drop-below' : ''}`}
        role="button"
        tabIndex={0}
        data-tip={
          isArchived
            ? `${session.title ?? '新会话'}（已归档）；恢复后才能在对话里打开`
            : `${session.title ?? '新会话'}；双击标题改名 · Ctrl+Alt+F 分叉 · Ctrl+Shift+A 归档`
        }
        onClick={() => {
          if (isArchived) blocked()
          else props.onPick(session.id)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (isArchived) blocked()
            else props.onPick(session.id)
            return
          }
          rowKeys(event, sKey, 'session')
        }}
        onContextMenu={(event) => {
          // 右键 = 这一行操作菜单贴着指针展开（dock 页签同款）；归档行也一样，
          // 里面的复制 ID 与恢复都还能用
          event.preventDefault()
          setMenu({ key: sKey, x: event.clientX, y: event.clientY })
        }}
        draggable={draggable}
        onDragStart={(event: DragEvent<HTMLDivElement>) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', session.id)
          setSessDrag({ cwd: groupCwd ?? '', id: session.id, pinned: session.pinnedAt !== undefined, over: null })
        }}
        onDragEnd={() => commitSessDrag()}
        onDragOver={
          dragCompatible
            ? (event: DragEvent<HTMLDivElement>) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                const half = sessRowHalf(event)
                setSessDrag((current) =>
                  current === null || current.over?.id === session.id && current.over.half === half
                    ? current
                    : { ...current, over: { id: session.id, half } },
                )
              }
            : undefined
        }
        onDrop={
          dragCompatible
            ? (event: DragEvent<HTMLDivElement>) => {
                event.preventDefault()
                commitSessDrag()
              }
            : undefined
        }
      >
        {/* T21 行首状态点：working = 正在跑（当前回合或队友活着），awaiting-approval = 挂着等批。
            没有状态点的前置槽让位给图钉（图二样式）：悬浮浮出，已置顶的常显，点一下切换。 */}
        {(() => {
          const runState = props.sessionStates[session.id]
          if (runState !== undefined) {
            return (
              <span className={`row-slot session-dot ${runState}`} data-tip={runState === 'working' ? '这个会话正在跑' : '挂着等你审批'} aria-label={runState === 'working' ? '运行中' : '等待审批'}>
                <span className="dot" />
              </span>
            )
          }
          return (
            <span className="row-slot">
              <button
                className={`lead-pin${session.pinnedAt !== undefined ? ' pinned' : ''}`}
                data-tip={session.pinnedAt !== undefined ? '取消置顶' : '置顶会话'}
                aria-label={session.pinnedAt !== undefined ? '取消置顶' : '置顶会话'}
                onClick={(event) => {
                  event.stopPropagation()
                  void run(props.proxy.setSessionPinned(session.id, session.pinnedAt === undefined))
                }}
              >
                <IconPin size={13} />
              </button>
            </span>
          )
        })()}
        {editing?.key === sKey ? (
          <input
            className="row-rename"
            autoFocus
            value={editing.value}
            onChange={(event) => setEditing({ ...editing, value: event.target.value })}
            onBlur={commitRename}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') setEditing(null)
            }}
          />
        ) : (
          <span
            className="title"
            onDoubleClick={(event) => {
              // 双击标题改名（dsh 行为）；改名输入框里的双击选词不外溢。
              event.stopPropagation()
              if (!isArchived) startRename(sKey, 'session', session.title ?? '')
            }}
          >
            {session.title ?? '新会话'}
          </span>
        )}
        {/* 归档行的时间显示归档时刻：那才是它在这一档里排队的依据。
            行尾时间戳与操作钮占同一格，hover 时互换（dsh 的 time ↔ rowActions）。
            图钉已挪到行首前置槽，「更多操作」由右键代替——行尾只剩归档/恢复一件事。 */}
        <span className="when">
          {relative(sort === 'created' ? session.createdAt : (session.archivedAt ?? session.updatedAt))}
        </span>
        <span className="row-actions" onClick={(event) => event.stopPropagation()}>
          {isArchived ? (
            <button
              className="icon-btn"
              data-tip="恢复这个会话，移回活动区"
              onClick={(event) => {
                void run(props.proxy.restoreSessions([session.id]))
              }}
            >
              <IconRefresh size={14} />
            </button>
          ) : (
            <button
              className="icon-btn"
              data-tip="归档会话"
              onClick={(event) => {
                archiveWithConfirm(
                  [session.id],
                  `归档会话「${session.title ?? '新会话'}」？`,
                  ARCHIVE_DETAIL_ONE,
                )
              }}
            >
              <IconArchive size={14} />
            </button>
          )}
        </span>
        {menu?.key === sKey && menu.x !== undefined && menu.y !== undefined && (
          <>
            <div className="menu-backdrop" onClick={() => setMenu(null)} />
            <div
              className="row-menu sess-ctx-menu"
              style={{
                position: 'fixed',
                left: Math.min(menu.x, window.innerWidth - 220),
                // 菜单实际高约 160px（5 项 + 分隔线）：夹取值贴着它给，不然靠底的
                // 行右键时菜单会跟指针脱开一大截
                top: Math.min(menu.y, window.innerHeight - 240),
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                className="menu-item"
                onClick={() => {
                  setMenu(null)
                  void run(props.proxy.setSessionPinned(session.id, session.pinnedAt === undefined))
                }}
              >
                <IconPin size={15} /> {session.pinnedAt !== undefined ? '取消置顶' : '置顶会话'}
              </button>
              <button
                className="menu-item"
                onClick={() => startRename(sKey, 'session', session.title ?? '')}
              >
                <IconEdit size={15} /> 重命名 <span className="menu-key">Ctrl+Alt+R</span>
              </button>
              <button className="menu-item" onClick={() => void openFork(session.id)}>
                <IconSwap size={15} /> 分叉会话 <span className="menu-key">Ctrl+Alt+F</span>
              </button>
              <button className="menu-item" onClick={() => copySessionId(session.id)}>
                <IconCopy size={15} /> 复制会话 ID
              </button>
              <div className="menu-sep" />
              {isArchived ? (
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenu(null)
                    void run(props.proxy.restoreSessions([session.id]))
                  }}
                >
                  <IconRefresh size={15} /> 恢复会话
                </button>
              ) : (
                <button
                  className="menu-item danger"
                  onClick={() => {
                    setMenu(null)
                    archiveWithConfirm(
                      [session.id],
                      `归档会话「${session.title ?? '新会话'}」？`,
                      ARCHIVE_DETAIL_ONE,
                    )
                  }}
                >
                  <IconArchive size={15} /> 归档会话 <span className="menu-key">Ctrl+Shift+A</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>
    )
  }

  // 收起态：56px 图标窄栏（照 dsh 的窄栏规格——36px 控件、18px 图标）。
  // 最上面那颗就是展开按钮：窄栏里 logo 就代表「点开侧栏」，不再另摆一颗开关。
  if (props.rail) {
    return (
      <aside className="sidebar rail">
        <button className="rail-logo" data-tip="展开侧边栏，快捷键 Ctrl+B" onClick={props.onToggleRail}>
          <img src={iconUrl} alt="Muse Code" draggable={false} />
        </button>
        <button className="rail-btn" data-tip="新会话" onClick={props.onNew}>
          <IconPlus size={18} />
        </button>
        <nav className="rail-nav">
          <button
            className={`rail-btn${props.view === 'skills' ? ' on' : ''}`}
            data-tip="技能"
            onClick={() => props.onView(props.view === 'skills' ? 'chat' : 'skills')}
          >
            <IconBolt size={18} />
          </button>
          <button
            className={`rail-btn${props.view === 'plugins' ? ' on' : ''}`}
            data-tip="插件"
            onClick={() => props.onView(props.view === 'plugins' ? 'chat' : 'plugins')}
          >
            <IconPuzzle size={18} />
          </button>
        </nav>
        <div className="rail-foot">
          <button
            className="rail-btn"
            data-tip={`工作目录 ${props.cwd}，展开侧栏后可选择会话`}
            onClick={props.onToggleRail}
          >
            <IconFolder size={18} />
          </button>
          {/* 设置收进左下角（对照 dsh 的底部锚位），窄栏里排在目录按钮下面。 */}
          <button className="rail-btn" data-tip="设置：模型、权限、技能源" onClick={() => props.onOpenSettings('general')}>
            <IconGear size={18} />
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <img src={iconUrl} alt="Muse Code" draggable={false} />
        <span className="brand">Muse Code</span>
        <button className="icon-btn rail-toggle" data-tip="收起侧边栏，快捷键 Ctrl+B" onClick={props.onToggleRail}>
          <IconSidebar size={15} />
        </button>
      </div>

      <button className="btn-new" onClick={props.onNew}>
        <IconPlus size={15} /> 新会话
      </button>

      <nav className="sidebar-nav">
        <button
          className={`nav-item${props.view === 'skills' ? ' on' : ''}`}
          onClick={() => props.onView(props.view === 'skills' ? 'chat' : 'skills')}
        >
          <IconBolt size={15} /> 技能
        </button>
        <button
          className={`nav-item${props.view === 'plugins' ? ' on' : ''}`}
          onClick={() => props.onView(props.view === 'plugins' ? 'chat' : 'plugins')}
        >
          <IconPuzzle size={15} /> 插件
        </button>
      </nav>

      <div className="sidebar-scroll">
        <div className="section-head">
          <span className="side-title">{group === 'flat' ? '会话' : '工作区'}</span>
          <span className="head-actions">
            <button
              className={`icon-btn${searching ? ' on' : ''}`}
              data-tip="搜索会话"
              onClick={() => {
                setSearching((current) => !current)
                setQuery('')
              }}
            >
              <IconSearch size={15} />
            </button>
            <button
              className={`icon-btn${viewMenu !== null ? ' on' : ''}`}
              data-tip="视图选项：分组方式、排序方式、筛选会话"
              onClick={(event) => {
                if (viewMenu !== null) {
                  setViewMenu(null)
                  return
                }
                // 用视口坐标定位：菜单挂在滚动区里的头部上，就地绝对定位会被裁掉。
                // 右缘贴侧栏右边而不是按钮自己的右缘——按钮左边还排着两颗，跟着它对齐会顶出窗口。
                const rect = event.currentTarget.getBoundingClientRect()
                const rail = event.currentTarget.closest('.sidebar')
                const edge = rail === null ? rect.right : rail.getBoundingClientRect().right - 6
                setViewMenu({ top: rect.bottom + 6, right: window.innerWidth - edge })
              }}
            >
              <IconSort size={15} />
            </button>
            <button className="icon-btn" data-tip="浏览其他目录" onClick={props.onChooseDir}>
              <IconFolderOpen size={15} />
            </button>
          </span>
        </div>

        {searching && (
          <div className="side-search">
            <IconSearch size={14} />
            <input
              autoFocus
              placeholder="按会话名或目录名过滤"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSearching(false)
                  setQuery('')
                }
              }}
            />
            <button className="icon-btn" data-tip="清除搜索" onClick={() => setSearching(false)}>
              <IconClose size={14} />
            </button>
          </div>
        )}

        {props.sessions.length === 0 && props.recentCwds.length === 0 && (
          <div className="sidebar-empty">
            <IconQueue size={24} />
            <div>
              还没有历史会话。
              <br />
              发送第一条消息开始。
            </div>
          </div>
        )}

        {groups.length === 0 && !(props.sessions.length === 0 && props.recentCwds.length === 0) && (
          <div className="sidebar-empty">
            <IconQueue size={24} />
            <div>
              {trimmed !== ''
                ? `没有匹配「${query.trim()}」的会话。`
                : archived === 'only'
                  ? '还没有已归档的会话。'
                  : '活动区没有会话了：归档的那些在「视图选项 → 仅显示已归档」里。'}
            </div>
          </div>
        )}

        {/* 单列表：不分工作区，会话混成一条流（dsh 的 FlatList：不设条数上限） */}
        {group === 'flat' && flatSessions.map((session) => renderSession(session))}

        {group !== 'flat' &&
          groups.filter((item) => !hiddenByAncestor(item)).map(({ cwd, sessions, depth }) => {
          const key = `w:${cwd}`
          const expanded = isExpanded(cwd)
          const active = cwd === activeCwd
          // 拖拽排序只属于「按工作区」这一档：树顺序由目录层级决定，单列表没有工作区行
          const sortable = group === 'workspace'
          // 每组条数预算（dsh 的 sessionLimits）：搜索时全量放开；收组即重置（toggle 里做了）
          const limit = trimmed !== '' ? Number.MAX_SAFE_INTEGER : (sessionLimits[cwd] ?? PREVIEW_COUNT)
          const visible = expanded ? sessions.slice(0, limit) : []
          const rest = sessions.length - visible.length
          // 指示线画在整个工作区块的上沿或下沿，也就是两组之间
          const drop =
            dropAt !== null && dropAt.cwd === cwd && dragCwd !== cwd
              ? dropAt.after
                ? ' drop-below'
                : ' drop-above'
              : ''
          return (
            <div key={cwd} className={`group depth-${Math.min(depth, 4)}${drop}`}>
              <div
                className={`group-row${active ? ' active' : ''}${dragCwd === cwd ? ' dragging' : ''}`}
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                data-tip={`${cwd} · ${sessions.length} 个会话，点击展开/收起${sortable ? '，拖动排序' : ''}`}
                draggable={sortable && editing === null}
                onClick={() => clickGroup(cwd)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    clickGroup(cwd)
                    return
                  }
                  rowKeys(event, key, 'workspace')
                }}
                onDragStart={(event: DragEvent<HTMLDivElement>) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', cwd)
                  setDragCwd(cwd)
                }}
                onDragOver={(event: DragEvent<HTMLDivElement>) => {
                  if (dragCwd === null || dragCwd === cwd) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  // 鼠标停在这一行的上半段就插到它前面，下半段就插到它后面
                  const rect = event.currentTarget.getBoundingClientRect()
                  const after = event.clientY > rect.top + rect.height / 2
                  if (dropAt === null || dropAt.cwd !== cwd || dropAt.after !== after) setDropAt({ cwd, after })
                }}
                onDrop={(event: DragEvent<HTMLDivElement>) => {
                  event.preventDefault()
                  const source = event.dataTransfer.getData('text/plain') || dragCwd
                  const after = dropAt !== null && dropAt.cwd === cwd ? dropAt.after : false
                  if (source !== null && source !== '') reorder(source, cwd, after)
                  endDrag()
                }}
                onDragEnd={endDrag}
              >
                {/* 引导格对齐 dsh：平时是 folder（活动组染强调色），hover 换成实心三角，
                    展开=旋转 90°；整行都是展开/收起的点击区，箭头不再单独占一颗按钮。 */}
                <span className="folder-icon">{expanded ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}</span>
                <span className="folder-chevron">
                  <IconTriangleRightFill size={14} className={expanded ? 'arrow-open' : undefined} />
                </span>
                {editing?.key === key ? (
                  <input
                    className="row-rename"
                    autoFocus
                    value={editing.value}
                    onChange={(event) => setEditing({ ...editing, value: event.target.value })}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename()
                      if (event.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <span className="dir">{displayName(cwd, aliases)}</span>
                )}
                {/* 行尾对齐 dsh：没有常显的会话数量（数量在 data-tip 里），hover 才
                    浮出 16px 裸图标按钮——`···` 菜单 + 「在此新建会话」。 */}
                <span className="row-actions">
                  {/* 只剩归档区这一档时，「全部恢复」是这里唯一的批量动作，保留 */}
                  {archived === 'only' && sessions.length > 0 && (
                    <button
                      className="icon-btn"
                      data-tip="把这个工作区的会话全部恢复"
                      onClick={(event) => {
                        event.stopPropagation()
                        void run(props.proxy.restoreSessions(sessions.map((session) => session.id)))
                      }}
                    >
                      <IconRefresh size={14} />
                    </button>
                  )}
                  <button
                    className={`icon-btn${menu?.key === key ? ' on' : ''}`}
                    data-tip="更多操作"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (menu?.key === key) {
                        setMenu(null)
                        return
                      }
                      // fixed 贴按钮：默认在按钮下方 6px；底部空间放不下（菜单最高约
                      // 5 项 ≈ 180px，留余量判 240）就翻到按钮上方 6px 向上伸展。
                      const rect = event.currentTarget.getBoundingClientRect()
                      const fitsBelow = window.innerHeight - rect.bottom >= 240
                      setMenu({
                        key,
                        left: Math.max(8, rect.right - 200),
                        ...(fitsBelow ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
                      })
                    }}
                  >
                    <IconMore size={15} />
                  </button>
                  <button
                    className="icon-btn"
                    data-tip={`在 ${displayName(cwd, aliases)} 新建会话`}
                    onClick={(event) => {
                      event.stopPropagation()
                      newSessionIn(cwd)
                    }}
                  >
                    <IconNewChat size={15} />
                  </button>
                </span>
                {menu?.key === key && (
                  <>
                    <div className="menu-backdrop" onClick={() => setMenu(null)} />
                    <div
                      className="row-menu"
                      style={{
                        position: 'fixed',
                        left: menu.left ?? 8,
                        ...(menu.bottom !== undefined ? { bottom: menu.bottom } : { top: menu.top ?? 8 }),
                      }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button className="menu-item" onClick={() => reveal(cwd)}>
                        <IconFolderOpen size={15} /> 在资源管理器中打开
                      </button>
                      <button className="menu-item" onClick={() => startRename(key, 'workspace', displayName(cwd, aliases))}>
                        <IconEdit size={15} /> 重命名显示名
                      </button>
                      {aliases[cwd] !== undefined && (
                        <button className="menu-item" onClick={() => clearAlias(cwd)}>
                          <IconClose size={15} /> 恢复真实目录名
                        </button>
                      )}
                      {sessions.length > 0 && (
                        <>
                          <div className="menu-sep" />
                          {archived === 'only' ? (
                            <button
                              className="menu-item"
                              onClick={() => {
                                setMenu(null)
                                void run(props.proxy.restoreSessions(sessions.map((session) => session.id)))
                              }}
                            >
                              <IconRefresh size={15} /> 恢复这 {sessions.length} 个会话
                            </button>
                          ) : (
                            <button
                              className="menu-item danger"
                              onClick={() => {
                                setMenu(null)
                                archiveWithConfirm(
                                  sessions.map((session) => session.id),
                                  `归档这 ${sessions.length} 个会话？`,
                                  ARCHIVE_DETAIL_MANY,
                                )
                              }}
                            >
                              <IconArchive size={15} /> 归档这 {sessions.length} 个会话
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
              {visible.map((session) => renderSession(session, cwd))}
              {expanded && trimmed === '' && sessions.length > PREVIEW_COUNT && (
                <button
                  className="session-overflow"
                  aria-expanded={rest === 0}
                  onClick={() => {
                    setSessionLimits((limits) => ({
                      ...limits,
                      [cwd]: rest === 0
                        ? PREVIEW_COUNT
                        : rest <= PREVIEW_COUNT
                          ? Number.MAX_SAFE_INTEGER
                          : (limits[cwd] ?? PREVIEW_COUNT) + PREVIEW_COUNT,
                    }))
                  }}
                >
                  {rest === 0 ? '收起' : `展开剩余 ${rest} 个会话`}
                </button>
              )}
            </div>
          )
        })}
        {/* 拖动时才对出现：整列表末尾的落点，保证「放到最后一个」永远点得着 */}
        {dragCwd !== null && group === 'workspace' && groups.length > 1 && (
          <div
            className="drop-tail"
            onDragOver={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDropAt(null)
            }}
            onDrop={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault()
              const source = event.dataTransfer.getData('text/plain') || dragCwd
              if (source !== null && source !== '') dropAtEnd(source)
              endDrag()
            }}
          >
            放到最后
          </div>
        )}
      </div>

      {/* 视图选项菜单：按视口坐标定位，所以放在滚动区外面 */}
      {viewMenu !== null && (
        <>
          <div className="menu-backdrop" onClick={() => setViewMenu(null)} />
          <div
            className="row-menu view-menu"
            role="menu"
            style={{ position: 'fixed', top: `${viewMenu.top}px`, right: `${viewMenu.right}px` }}
          >
            {viewSections.map((section, index) => (
              <div key={section.label}>
                {index > 0 && <div className="menu-sep" />}
                <div className="menu-label">{section.label}</div>
                {section.items.map((item) => (
                  <button
                    key={item.id}
                    className={`menu-item${item.active ? ' on' : ''}`}
                    role="menuitemradio"
                    aria-checked={item.active}
                    data-tip={item.text}
                    onClick={() => pickView(item.id)}
                  >
                    {item.icon}
                    <span className="menu-text">{item.text}</span>
                    <span className="menu-check">{item.active ? <IconCheck size={14} /> : null}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      {fork !== null && (
        <>
          <div className="menu-backdrop" onClick={() => setFork(null)} />
          <div className="fork-picker">
            <div className="fork-head">分叉到第几条消息之前？</div>
            <div className="fork-list">
              {fork.points.map((point, index) => (
                <button key={`${index}-${point}`} className="fork-item" onClick={() => void doFork(index)}>
                  <span className="no">{index + 1}</span>
                  <span className="txt">{point}</span>
                </button>
              ))}
            </div>
            <p className="fork-note">新会话包含这个位置之前的全部消息，原会话不变。</p>
          </div>
        </>
      )}

      <div className="sidebar-footer">
        <div className="row" data-tip={`${props.cwd}，点击浏览其他目录`} onClick={props.onChooseDir}>
          <IconFolder size={14} />
          <span className="dir">{props.cwd}</span>
        </div>
        <div className="row">
          <IconCoins size={14} />
          <span>会话用量</span>
          <span className="num">{formatTokens(totalTokens)} tok</span>
        </div>
        {/* 设置锚在左下角（对照 dsh 的底部锚位）：模型、权限、技能源都从这里进。 */}
        <button className="row row-btn" data-tip="设置：模型、权限、技能源" onClick={() => props.onOpenSettings('general')}>
          <IconGear size={14} />
          <span>设置</span>
        </button>
      </div>

      {/* 右边界拖拽条：9px 热区压在侧栏那道 1px 分界线上，双击复位成默认宽。 */}
      <div
        className="sidebar-resizer"
        data-tip="拖拽调整宽度，双击复位"
        onPointerDown={resizeDrag.onPointerDown}
        onPointerMove={resizeDrag.onPointerMove}
        onPointerUp={resizeDrag.onPointerUp}
        onPointerCancel={resizeDrag.onPointerCancel}
        onDoubleClick={() => props.onSidebarResize(null)}
      />
    </aside>
  )
}

/** 会话 uuid：会话文件（`…\.dsc\sessions\<目录>\<uuid>.jsonl`）的文件名去掉扩展名。 */
function uuidOf(path: string): string {
  return lastSegment(path).replace(/\.jsonl$/, '')
}
