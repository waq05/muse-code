/**
 * 侧栏：品牌区、新会话、工作区分组的会话列表、底部工作目录与用量。
 *
 * 工作区交互对照 dsh 桌面端左栏：
 *   - 点工作区名 = 切到那个工作目录（宿主随之重启）；点左侧箭头 = 展开/折叠；
 *   - 行可拖动排序（顺序写 `~/.dsc/settings.json`），排过一次后不再自动把活动组置顶；
 *   - hover 出现操作按钮，挂成贴在会话数量徽标左侧的浮层（不进文档流，徽标不跳位）：
 *     工作区行是「在此新建会话」+ `···` 菜单，会话行是 `···` 菜单 + 归档 + 置顶；
 *   - 会话行拿到焦点后可用 Ctrl+Alt+R 改名、Ctrl+Alt+F 分叉、Ctrl+Shift+A 归档。
 * 快捷键刻意绑在行元素上而不是全局，避免和输入框抢键。
 *
 * @module desktop/renderer/Sidebar
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type JSX, type KeyboardEvent } from 'react'
import type { SessionSummary, SettingsMutation, TeammateView, TokenUsageView, UiPrefsView } from '@dsc/runtime/contract.js'
import iconUrl from '../../build/icon.png'
import { confirmAction } from './components/confirm.js'
import { toastErr, toastOk } from './components/toast.js'
import { dsc, type RuntimeProxy } from './bridge.js'
import { SIDEBAR_MAX, SIDEBAR_MIN, readRootPx, setRootVar, useWidthDrag } from './panels.js'
import { moveToEnd, moveWithin, nestByPath, type NestedPath } from './workspace-order.js'
import {
  IconArchive,
  IconArchiveOff,
  IconBolt,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconClose,
  IconCoins,
  IconEdit,
  IconFlatList,
  IconFolder,
  IconFolderOpen,
  IconGear,
  IconMore,
  IconPin,
  IconPlus,
  IconPuzzle,
  IconQueue,
  IconRefresh,
  IconSearch,
  IconSidebar,
  IconSort,
  IconSwap,
  IconTree,
} from './icons.js'

/** 左栏页面（技能/插件各占一页，其余时间显示对话）。 */
export type SidebarView = 'chat' | 'plugins' | 'skills'

/** 侧栏里的一个工作区分组：树的层级来自 {@link NestedPath}，这里再挂上会话。 */
interface WorkGroup extends NestedPath {
  sessions: SessionSummary[]
}

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
  /** 点开一个队友的运行记录（只读查看）。 */
  onPeekTeammate(teammate: TeammateView): void
  /** 当前正看着哪个队友的运行记录（高亮那一行）。 */
  peekFile: string | null
  /** 侧栏收成 56px 图标窄栏（Ctrl+B，或点窄栏最上面那颗 logo）。 */
  rail: boolean
  /** 拖出来的侧栏宽度（px）。null = 没拖过，用样式表默认的 237px。 */
  sidebarWidth: number | null
  /** 收起 / 展开侧栏。 */
  onToggleRail(): void
  /** 侧栏拖宽落盘（null = 双击复位成默认宽）。 */
  onSidebarResize(width: number | null): void
}): JSX.Element {
  /** 活动工作区默认展开的会话条数（其余收进「展开剩余」）。 */
  const PREVIEW_COUNT = 5
  const [manualOpen, setManualOpen] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  /** 打开着 `···` 菜单的行（工作区行是 `w:<cwd>`，会话行是 `s:<路径>`）。 */
  const [menu, setMenu] = useState<string | null>(null)
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
   * 待新建会话的目标工作区。切换工作目录要重启宿主（新会话的 cwd 由宿主启动时的
   * 目录决定），而 App 的 onSwitchCwd 不返回 Promise，所以只能先登记目标目录，
   * 等 cwd 真的切过去再开新会话（见下面那个 effect）。
   */
  const [pendingNew, setPendingNew] = useState<string | null>(null)
  /** 刚拖完就不要再触发一次「点击切换工作区」。 */
  const justDragged = useRef(false)

  /** 这一档看什么：自己的会话，还是队友的运行记录。?teammates=1 直接落到队友档（自检截图用）。 */
  const [tab, setTab] = useState<'sessions' | 'teammates'>(() =>
    new URLSearchParams(location.search).has('teammates') ? 'teammates' : 'sessions',
  )
  const [teammates, setTeammates] = useState<TeammateView[]>([])
  // 队友在后台干活，状态一直在动，所以停在这一档时每两秒拉一次
  // （子智能体团队没开时宿主返回空表，这里就一直显示引导文案）
  useEffect(() => {
    if (tab !== 'teammates') return
    const pull = (): void => {
      void props.proxy.listTeammates().then(setTeammates).catch(() => {})
    }
    pull()
    const timer = setInterval(pull, 2000)
    return () => clearInterval(timer)
  }, [tab, props.proxy])

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

  const sortedSessions = (list: SessionSummary[]): SessionSummary[] =>
    [...list].sort((a, b) => {
      if ((a.pinnedAt ?? 0) !== (b.pinnedAt ?? 0)) return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
      // 「手动排序」只管工作区那一级（会话行拖不了），所以会话行按最近写入排。
      return sort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt
    })

  /** 归档筛选：hide 只看活动区，only 只看归档区，show 两区并成一份列表。 */
  const keepArchived = (session: SessionSummary): boolean =>
    archived === 'hide'
      ? session.archivedAt === undefined
      : archived === 'only'
        ? session.archivedAt !== undefined
        : true

  const groups = useMemo(() => {
    const map = new Map<string, SessionSummary[]>()
    // 只有「切过去还没发消息」的工作区没有会话，也要留在列表里；只看归档时它们没意义
    if (archived !== 'only') for (const dir of props.recentCwds) map.set(dir, [])
    for (const session of props.sessions) {
      if (!keepArchived(session)) continue
      const key = session.cwd || '(未指定)'
      const list = map.get(key) ?? []
      list.push(session)
      map.set(key, list)
    }
    const match = (cwd: string, list: SessionSummary[]): boolean =>
      trimmed === '' ||
      displayName(cwd, aliases).toLowerCase().includes(trimmed) ||
      cwd.toLowerCase().includes(trimmed) ||
      list.some((session) => (session.title ?? '新会话').toLowerCase().includes(trimmed))
    const visible = [...map.entries()].filter(([cwd, list]) => match(cwd, list))
    const rank = (cwd: string): number => order.indexOf(cwd)
    const lastUsed = (list: SessionSummary[]): number => list.reduce((max, s) => Math.max(max, s.updatedAt), 0)
    const lastCreated = (list: SessionSummary[]): number => list.reduce((max, s) => Math.max(max, s.createdAt), 0)
    const sorted = visible
      .map(([cwd, list]) => [cwd, sortedSessions(list)] as [string, SessionSummary[]])
      .sort((a, b) => {
        if (sort === 'manual') {
          // 手动排过序就完全按手动顺序（活动组不再抢位）；没排过则活动组置顶，其余按最近使用
          if (order.length > 0) {
            const ra = rank(a[0])
            const rb = rank(b[0])
            if (ra !== rb) {
              if (ra < 0) return 1
              if (rb < 0) return -1
              return ra - rb
            }
          } else if ((a[0] === props.cwd) !== (b[0] === props.cwd)) {
            return a[0] === props.cwd ? -1 : 1
          }
          return lastUsed(b[1]) - lastUsed(a[1])
        }
        // 最近更新 / 创建时间这两档两级都按时间，不再人为把活动组顶上去
        return sort === 'created' ? lastCreated(b[1]) - lastCreated(a[1]) : lastUsed(b[1]) - lastUsed(a[1])
      })
    if (group !== 'tree') {
      return sorted.map(
        ([cwd, list]): WorkGroup => ({ cwd, sessions: list, depth: 0, parent: null, ancestors: [], hasChildren: false }),
      )
    }
    const lists = new Map(sorted)
    return nestByPath(sorted.map(([cwd]) => cwd)).map(
      (node): WorkGroup => ({ ...node, sessions: lists.get(node.cwd) ?? [] }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessions, props.recentCwds, props.cwd, order, aliases, trimmed, sort, group, archived])

  const isActiveGroup = (cwd: string): boolean => cwd === props.cwd
  /** 树里带子分组的行（折叠它要连带收起后代，且默认展开）。 */
  const parents = useMemo(() => new Set(groups.filter((item) => item.hasChildren).map((item) => item.cwd)), [groups])

  const isExpanded = (cwd: string): boolean => {
    if (trimmed !== '') return true
    // 树里的父分组默认展开：折叠状态归 `!cwd` 管
    if (group === 'tree' && parents.has(cwd)) return !manualOpen.has(`!${cwd}`)
    if (isActiveGroup(cwd)) return !manualOpen.has(`!${cwd}`)
    return manualOpen.has(cwd)
  }

  const toggle = (cwd: string): void => {
    setManualOpen((current) => {
      const next = new Set(current)
      const defaultsOpen = isActiveGroup(cwd) || (group === 'tree' && parents.has(cwd))
      if (isExpanded(cwd)) {
        if (defaultsOpen) next.add(`!${cwd}`)
        next.delete(cwd)
      } else {
        next.delete(`!${cwd}`)
        next.add(cwd)
      }
      return next
    })
  }

  /** 祖先里只要有一个被折叠，这一组就不出现在列表里。 */
  const hiddenByAncestor = (item: WorkGroup): boolean => item.ancestors.some((ancestor) => !isExpanded(ancestor))

  /** 单列表：不分工作区，所有会话混成一条按排序方式排好的流。 */
  const flatSessions = sortedSessions(groups.flatMap((item) => item.sessions))

  /** 视图选项菜单的三组（对照 dsh 的「分组方式 / 排序方式 / 筛选会话」）。 */
  const viewSections: { label: string; items: { id: string; text: string; icon: JSX.Element; active: boolean }[] }[] = [
    {
      label: '分组方式',
      items: [
        { id: 'workspace', text: '按工作区', icon: <IconFolder size={14} />, active: group === 'workspace' },
        { id: 'tree', text: '按工作区树', icon: <IconTree size={14} />, active: group === 'tree' },
        { id: 'flat', text: '单列表', icon: <IconFlatList size={14} />, active: group === 'flat' },
      ],
    },
    {
      label: '排序方式',
      items: [
        { id: 'manual', text: '手动排序', icon: <IconSwap size={14} />, active: sort === 'manual' },
        { id: 'recent', text: '最近更新', icon: <IconClock size={14} />, active: sort === 'recent' },
        { id: 'created', text: '创建时间', icon: <IconCalendar size={14} />, active: sort === 'created' },
      ],
    },
    {
      label: '筛选会话',
      items: [
        { id: 'hide', text: '隐藏已归档', icon: <IconArchiveOff size={14} />, active: archived === 'hide' },
        { id: 'show', text: '全部对话（显示已归档）', icon: <IconQueue size={14} />, active: archived === 'show' },
        { id: 'only', text: '仅显示已归档', icon: <IconArchive size={14} />, active: archived === 'only' },
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

  const activateGroup = (cwd: string): void => {
    if (justDragged.current === true) return
    if (isActiveGroup(cwd)) toggle(cwd)
    else props.onSwitchCwd(cwd)
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
  const renderSession = (session: SessionSummary): JSX.Element => {
    const sKey = `s:${session.id}`
    const isArchived = session.archivedAt !== undefined
    const blocked = (): void => {
      toastErr('这个会话已归档：先点行尾的「恢复」再打开')
    }
    return (
      <div
        key={session.id}
        className={`sess-item${isArchived ? ' archived' : ''}${session.id.endsWith(`${props.activeSessionId ?? '#'}.jsonl`) ? ' active' : ''}`}
        role="button"
        tabIndex={0}
        data-tip={
          isArchived
            ? `${session.title ?? '新会话'}（已归档）；恢复后才能在对话里打开`
            : `${session.title ?? '新会话'}；Ctrl+Alt+R 改名 · Ctrl+Alt+F 分叉 · Ctrl+Shift+A 归档`
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
      >
        {session.pinnedAt !== undefined && (
          <span className="pin-mark" data-tip="已置顶">
            <IconPin size={11} />
          </span>
        )}
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
          <span className="title">{session.title ?? '新会话'}</span>
        )}
        {/* 归档行的时间显示归档时刻：那才是它在这一档里排队的依据。 */}
        <span className="when">
          {relative(sort === 'created' ? session.createdAt : (session.archivedAt ?? session.updatedAt))}
        </span>
        <span className="row-actions">
          <button
            className="icon-btn"
            data-tip={session.pinnedAt !== undefined ? '取消置顶' : '置顶会话'}
            onClick={(event) => {
              event.stopPropagation()
              void run(props.proxy.setSessionPinned(session.id, session.pinnedAt === undefined))
            }}
          >
            <IconPin size={13} />
          </button>
          {isArchived ? (
            <button
              className="icon-btn"
              data-tip="恢复这个会话，移回活动区"
              onClick={(event) => {
                event.stopPropagation()
                void run(props.proxy.restoreSessions([session.id]))
              }}
            >
              <IconRefresh size={13} />
            </button>
          ) : (
            <button
              className="icon-btn"
              data-tip="归档会话"
              onClick={(event) => {
                event.stopPropagation()
                archiveWithConfirm(
                  [session.id],
                  `归档会话「${session.title ?? '新会话'}」？`,
                  ARCHIVE_DETAIL_ONE,
                )
              }}
            >
              <IconArchive size={13} />
            </button>
          )}
          <button
            className={`icon-btn${menu === sKey ? ' on' : ''}`}
            data-tip="更多操作"
            onClick={(event) => {
              event.stopPropagation()
              setMenu(menu === sKey ? null : sKey)
            }}
          >
            <IconMore size={14} />
          </button>
        </span>
        {menu === sKey && (
          <>
            <div className="menu-backdrop" onClick={() => setMenu(null)} />
            <div className="row-menu" onClick={(event) => event.stopPropagation()}>
              <button
                className="menu-item"
                onClick={() => {
                  setMenu(null)
                  void run(props.proxy.setSessionPinned(session.id, session.pinnedAt === undefined))
                }}
              >
                <IconPin size={14} /> {session.pinnedAt !== undefined ? '取消置顶' : '置顶会话'}
              </button>
              <button
                className="menu-item"
                onClick={() => startRename(sKey, 'session', session.title ?? '')}
              >
                <IconEdit size={14} /> 重命名 <span className="menu-key">Ctrl+Alt+R</span>
              </button>
              <button className="menu-item" onClick={() => void openFork(session.id)}>
                <IconSwap size={14} /> 分叉会话 <span className="menu-key">Ctrl+Alt+F</span>
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
                  <IconRefresh size={14} /> 恢复会话
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
                  <IconArchive size={14} /> 归档会话 <span className="menu-key">Ctrl+Shift+A</span>
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
        <span className="badge">DESKTOP</span>
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
          <span className="side-tabs">
            <button className={`side-tab${tab === 'sessions' ? ' on' : ''}`} onClick={() => setTab('sessions')}>
              会话
            </button>
            <button
              className={`side-tab${tab === 'teammates' ? ' on' : ''}`}
              data-tip="子智能体团队的队友，点击查看只读运行记录"
              onClick={() => setTab('teammates')}
            >
              队友{teammates.length > 0 ? ` ${teammates.length}` : ''}
            </button>
          </span>
          {tab === 'sessions' && (
            <span className="head-actions">
              <button
                className={`icon-btn${searching ? ' on' : ''}`}
                data-tip="搜索会话"
                onClick={() => {
                  setSearching((current) => !current)
                  setQuery('')
                }}
              >
                <IconSearch size={14} />
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
                <IconSort size={14} />
              </button>
              <button className="icon-btn" data-tip="浏览其他目录" onClick={props.onChooseDir}>
                <IconFolderOpen size={14} />
              </button>
            </span>
          )}
        </div>

        {tab === 'sessions' && searching && (
          <div className="side-search">
            <IconSearch size={13} />
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
              <IconClose size={13} />
            </button>
          </div>
        )}

        {tab === 'sessions' && props.sessions.length === 0 && props.recentCwds.length === 0 && (
          <div className="sidebar-empty">
            还没有历史会话。
            <br />
            发送第一条消息开始。
          </div>
        )}

        {tab === 'sessions' && groups.length === 0 && !(props.sessions.length === 0 && props.recentCwds.length === 0) && (
          <div className="sidebar-empty">
            {trimmed !== ''
              ? `没有匹配「${query.trim()}」的会话。`
              : archived === 'only'
                ? '还没有已归档的会话。'
                : '活动区没有会话了：归档的那些在「视图选项 → 仅显示已归档」里。'}
          </div>
        )}

        {tab === 'teammates' && teammates.length === 0 && (
          <div className="sidebar-empty">
            当前没有队友。
            <br />
            在「插件」页启用「子智能体团队」后，模型派出的队友会显示在这里。
          </div>
        )}

        {tab === 'teammates' &&
          teammates.map((mate) => (
            <div
              key={mate.file}
              className={`tm-row${props.peekFile === mate.file ? ' on' : ''}`}
              role="button"
              tabIndex={0}
              data-tip={`任务：${mate.task}`}
              onClick={() => props.onPeekTeammate(mate)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') props.onPeekTeammate(mate)
              }}
            >
              <span className={`tm-dot ${mate.state}`} />
              <span className="tm-name">{mate.name}</span>
              <span className="tm-role">{mate.role}</span>
              <span className="tm-state">
                {mate.state === 'working' ? `运行中 · ${mate.rounds} 轮` : mate.state === 'idle' ? '已完成' : mate.state === 'stopped' ? '已停止' : '已失败'}
              </span>
              <span className="tm-time">{relative(mate.finishedAt ?? mate.startedAt)}</span>
            </div>
          ))}

        {/* 单列表：不分工作区，会话混成一条流 */}
        {tab === 'sessions' &&
          group === 'flat' &&
          (showAll ? flatSessions : flatSessions.slice(0, PREVIEW_COUNT)).map((session) => renderSession(session))}
        {tab === 'sessions' && group === 'flat' && !showAll && flatSessions.length > PREVIEW_COUNT && (
          <button className="expand-link" onClick={() => setShowAll(true)}>
            展开剩余 {flatSessions.length - PREVIEW_COUNT} 个会话
          </button>
        )}

        {tab === 'sessions' &&
          group !== 'flat' &&
          groups.filter((item) => !hiddenByAncestor(item)).map(({ cwd, sessions, depth }) => {
          const key = `w:${cwd}`
          const expanded = isExpanded(cwd)
          const active = isActiveGroup(cwd)
          // 拖拽排序只属于「按工作区」这一档：树顺序由目录层级决定，单列表没有工作区行
          const sortable = group === 'workspace'
          const visible = expanded && !showAll ? sessions.slice(0, PREVIEW_COUNT) : expanded ? sessions : []
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
                data-tip={sortable ? `${cwd}，点击切换工作区，拖动排序` : `${cwd}，点击切换工作区`}
                draggable={sortable && editing === null}
                onClick={() => activateGroup(cwd)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    activateGroup(cwd)
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
                <button
                  className="twisty"
                  data-tip={expanded ? '折叠这个工作区' : '展开这个工作区'}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggle(cwd)
                  }}
                >
                  {expanded ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                </button>
                <span className="folder-icon">{expanded ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}</span>
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
                {/* 尾舱对齐 dsh 的行尾交互：平时只显示会话数量，悬停时数量隐藏、
                    按钮组在同一个槽位出现（in-flow，见 styles.css 的 .row-tail），
                    行右缘稳定，没有「数量被挤走」的位移感。 */}
                <span className="row-tail">
                  <span className="count">{sessions.length}</span>
                  <span className="row-actions">
                    {/* 工作区行按用户要求不再摆「归档全部」和拖动把手：批量归档仍在
                        `···` 菜单里（下方 row-menu），排序改成直接拖行本身（行还是
                        draggable）。这里只留「在此新建会话」和菜单。 */}
                    <button
                      className="icon-btn"
                      title={`在 ${displayName(cwd, aliases)} 新建会话`}
                      onClick={(event) => {
                        event.stopPropagation()
                        newSessionIn(cwd)
                      }}
                    >
                      <IconPlus size={13} />
                    </button>
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
                        <IconRefresh size={13} />
                      </button>
                    )}
                    <button
                      className={`icon-btn${menu === key ? ' on' : ''}`}
                      data-tip="更多操作"
                      onClick={(event) => {
                        event.stopPropagation()
                        setMenu(menu === key ? null : key)
                      }}
                    >
                      <IconMore size={14} />
                    </button>
                  </span>
                </span>
                {menu === key && (
                  <>
                    <div className="menu-backdrop" onClick={() => setMenu(null)} />
                    <div className="row-menu" onClick={(event) => event.stopPropagation()}>
                      <button className="menu-item" onClick={() => reveal(cwd)}>
                        <IconFolderOpen size={14} /> 在资源管理器中打开
                      </button>
                      <button className="menu-item" onClick={() => startRename(key, 'workspace', displayName(cwd, aliases))}>
                        <IconEdit size={14} /> 重命名显示名
                      </button>
                      {aliases[cwd] !== undefined && (
                        <button className="menu-item" onClick={() => clearAlias(cwd)}>
                          <IconClose size={14} /> 恢复真实目录名
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
                              <IconRefresh size={14} /> 恢复这 {sessions.length} 个会话
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
                              <IconArchive size={14} /> 归档这 {sessions.length} 个会话
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
              {visible.map((session) => renderSession(session))}
              {expanded && rest > 0 && (
                <button className="expand-link" onClick={() => setShowAll(true)}>
                  展开剩余 {rest} 个会话
                </button>
              )}
            </div>
          )
        })}
        {showAll && (groups.length > 0 || flatSessions.length > 0) && (
          <button className="expand-link" onClick={() => setShowAll(false)}>
            收起完整列表
          </button>
        )}
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
                    <span className="menu-check">{item.active ? <IconCheck size={13} /> : null}</span>
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

/** 工作区显示名：用户起的别名优先，否则末级目录名。 */
function displayName(cwd: string, aliases: Record<string, string>): string {
  return aliases[cwd] ?? lastSegment(cwd)
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function relative(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时`
  return `${Math.floor(hours / 24)}天`
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}
