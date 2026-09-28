/**
 * 侧栏：品牌区、新会话、工作区分组的会话列表、底部工作目录与用量。
 *
 * 工作区交互对照 dsh 桌面端左栏：
 *   - 点工作区名 = 切到那个工作目录（宿主随之重启）；点左侧箭头 = 展开/折叠；
 *   - 行可拖动排序（顺序写 `~/.dsc/settings.json`），排过一次后不再自动把活动组置顶；
 *   - hover 出现操作按钮：工作区行是 `···` 菜单 + 归档全部；会话行是 `···` 菜单 + 归档 + 置顶；
 *   - 会话行拿到焦点后可用 Ctrl+Alt+R 改名、Ctrl+Alt+F 分叉、Ctrl+Shift+A 归档。
 * 快捷键刻意绑在行元素上而不是全局，避免和输入框抢键。
 *
 * @module desktop/renderer/Sidebar
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type JSX, type KeyboardEvent } from 'react'
import type { SessionSummary, SettingsMutation, TeammateView, TokenUsageView, UiPrefsView } from '@dsc/runtime/contract.js'
import iconUrl from '../../build/icon.png'
import { dsc, type RuntimeProxy } from './bridge.js'
import { moveToEnd, moveWithin } from './workspace-order.js'
import {
  IconArchive,
  IconBolt,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCoins,
  IconFolder,
  IconFolderOpen,
  IconGear,
  IconGrip,
  IconMore,
  IconPin,
  IconPlus,
  IconPuzzle,
  IconSearch,
  IconSort,
} from './icons.js'

/** 左栏页面（技能/插件各占一页，其余时间显示对话）。 */
export type SidebarView = 'chat' | 'plugins' | 'skills'

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
  /** 操作结果提示（顶到 App 的 notice 条）。 */
  onNotice(text: string): void
  /** 点开一个队友的运行记录（只读查看）。 */
  onPeekTeammate(teammate: TeammateView): void
  /** 当前正看着哪个队友的运行记录（高亮那一行）。 */
  peekFile: string | null
}): JSX.Element {
  /** 活动工作区默认展开的会话条数（其余收进「展开剩余」）。 */
  const PREVIEW_COUNT = 5
  const [manualOpen, setManualOpen] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  /** 打开着 `···` 菜单的行（工作区行是 `w:<cwd>`，会话行是 `s:<路径>`）。 */
  const [menu, setMenu] = useState<string | null>(null)
  /** 正在改名的行。 */
  const [editing, setEditing] = useState<{ key: string; kind: 'workspace' | 'session'; value: string } | null>(null)
  /** 分叉位置选择器：会话路径 + 可选的用户消息清单。 */
  const [fork, setFork] = useState<{ path: string; points: string[] } | null>(null)
  const [dragCwd, setDragCwd] = useState<string | null>(null)
  /** 拖动时的落点：插到这一组工作区之前（after=false）还是之后（after=true）。 */
  const [dropAt, setDropAt] = useState<{ cwd: string; after: boolean } | null>(null)
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

  /** 跑一个会话库操作：把结果讲给用户，成功后刷新列表。 */
  const run = async (task: Promise<SettingsMutation>, then?: () => void): Promise<void> => {
    try {
      const result = await task
      props.onNotice(result.ok ? (result.notice ?? '已完成') : `没做成：${result.error}`)
      if (result.ok) {
        await props.proxy.refreshSessions()
        then?.()
      }
    } catch (error) {
      props.onNotice(`没做成：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const sortedSessions = (list: SessionSummary[]): SessionSummary[] =>
    [...list].sort((a, b) => {
      if ((a.pinnedAt ?? 0) !== (b.pinnedAt ?? 0)) return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
      return props.uiPrefs.sessionSort === 'recent' ? b.updatedAt - a.updatedAt : b.createdAt - a.createdAt
    })

  const groups = useMemo(() => {
    const map = new Map<string, SessionSummary[]>()
    // 只有「切过去还没发消息」的工作区没有会话，也要留在列表里
    for (const dir of props.recentCwds) map.set(dir, [])
    for (const session of props.sessions) {
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
    return visible
      .map(([cwd, list]) => [cwd, sortedSessions(list)] as [string, SessionSummary[]])
      .sort((a, b) => {
        // 手动排过序就完全按手动顺序（活动组不再抢位）；否则活动组置顶
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
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessions, props.recentCwds, props.cwd, order, aliases, trimmed, props.uiPrefs.sessionSort])

  const isActiveGroup = (cwd: string): boolean => cwd === props.cwd
  const isExpanded = (cwd: string): boolean =>
    trimmed !== '' || manualOpen.has(cwd) || (isActiveGroup(cwd) && !manualOpen.has(`!${cwd}`))

  const toggle = (cwd: string): void => {
    setManualOpen((current) => {
      const next = new Set(current)
      if (isExpanded(cwd)) {
        next.add(isActiveGroup(cwd) ? `!${cwd}` : cwd)
        next.delete(cwd)
      } else {
        next.delete(`!${cwd}`)
        next.add(cwd)
      }
      return next
    })
  }

  const activateGroup = (cwd: string): void => {
    if (justDragged.current === true) return
    if (isActiveGroup(cwd)) toggle(cwd)
    else props.onSwitchCwd(cwd)
  }

  /** 把 source 挪到 target 之前或之后，其余保持当前视觉顺序，然后存起来。 */
  const reorder = (source: string, target: string, after: boolean): void => {
    const current = groups.map(([cwd]) => cwd)
    const next = moveWithin(current, source, target, after)
    if (next.join('\n') === current.join('\n')) return
    props.onUiPrefs({ workspaceOrder: next })
  }

  /** 拖到列表末尾的落点。 */
  const dropAtEnd = (source: string): void => {
    const current = groups.map(([cwd]) => cwd)
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
      props.onNotice('这个会话里可选的分叉位置少于两条用户消息')
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
      props.onNotice(`分叉失败：${result.error}`)
      return
    }
    await props.proxy.refreshSessions()
    props.onNotice(`已分叉出新会话（到第 ${index + 1} 条消息为止）`)
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
      if (problem !== '') props.onNotice(`打开失败：${problem}`)
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
      void run(props.proxy.archiveSessions([key.slice(2)]))
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <img src={iconUrl} alt="dsc" draggable={false} />
        <span className="brand">dsc</span>
        <span className="badge">DESKTOP</span>
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
        <button className="nav-item" title="设置（模型、权限、技能源）" onClick={() => props.onOpenSettings('general')}>
          <IconGear size={15} /> 设置
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
              title="子智能体团队派出去的队友；点开只读查看它在干什么"
              onClick={() => setTab('teammates')}
            >
              队友{teammates.length > 0 ? ` ${teammates.length}` : ''}
            </button>
          </span>
          {tab === 'sessions' && (
            <span className="head-actions">
              <button
                className={`icon-btn${searching ? ' on' : ''}`}
                title="搜索会话"
                onClick={() => {
                  setSearching((current) => !current)
                  setQuery('')
                }}
              >
                <IconSearch size={14} />
              </button>
              <button
                className="icon-btn"
                title={
                  props.uiPrefs.sessionSort === 'recent'
                    ? '当前按最近使用排序，点击改为按创建时间'
                    : '当前按创建时间排序，点击改为按最近使用'
                }
                onClick={() => props.onUiPrefs({ sessionSort: props.uiPrefs.sessionSort === 'recent' ? 'created' : 'recent' })}
              >
                <IconSort size={14} />
              </button>
              <button className="icon-btn" title="浏览其他目录" onClick={props.onChooseDir}>
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
            <button className="icon-btn" title="清除搜索" onClick={() => setSearching(false)}>
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

        {tab === 'sessions' && (props.sessions.length > 0 || props.recentCwds.length > 0) && groups.length === 0 && (
          <div className="sidebar-empty">没有匹配「{query.trim()}」的会话。</div>
        )}

        {tab === 'teammates' && teammates.length === 0 && (
          <div className="sidebar-empty">
            没有在队的队友。
            <br />
            在「插件」页打开「子智能体团队」，让模型把活拆给队友，这里就会出现它们。
          </div>
        )}

        {tab === 'teammates' &&
          teammates.map((mate) => (
            <div
              key={mate.file}
              className={`tm-row${props.peekFile === mate.file ? ' on' : ''}`}
              role="button"
              tabIndex={0}
              title={`任务：${mate.task}`}
              onClick={() => props.onPeekTeammate(mate)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') props.onPeekTeammate(mate)
              }}
            >
              <span className={`tm-dot ${mate.state}`} />
              <span className="tm-name">{mate.name}</span>
              <span className="tm-role">{mate.role}</span>
              <span className="tm-state">
                {mate.state === 'working' ? `在干 · ${mate.rounds} 轮` : mate.state === 'idle' ? '完工' : mate.state === 'stopped' ? '打断' : '失败'}
              </span>
              <span className="tm-time">{relative(mate.finishedAt ?? mate.startedAt)}</span>
            </div>
          ))}

        {tab === 'sessions' && groups.map(([cwd, sessions]) => {
          const key = `w:${cwd}`
          const expanded = isExpanded(cwd)
          const active = isActiveGroup(cwd)
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
            <div key={cwd} className={`group${drop}`}>
              <div
                className={`group-row${active ? ' active' : ''}${dragCwd === cwd ? ' dragging' : ''}`}
                role="button"
                tabIndex={0}
                title={`${cwd}（点击切换工作区，拖动可以排顺序）`}
                draggable={editing === null}
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
                  title={expanded ? '折叠这个工作区' : '展开这个工作区'}
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
                <span className="count">{sessions.length}</span>
                <span className="row-actions">
                  {sessions.length > 0 && (
                    <button
                      className="icon-btn"
                      title="归档这个工作区的全部会话"
                      onClick={(event) => {
                        event.stopPropagation()
                        void run(props.proxy.archiveSessions(sessions.map((session) => session.id)))
                      }}
                    >
                      <IconArchive size={13} />
                    </button>
                  )}
                  <button
                    className={`icon-btn${menu === key ? ' on' : ''}`}
                    title="更多操作"
                    onClick={(event) => {
                      event.stopPropagation()
                      setMenu(menu === key ? null : key)
                    }}
                  >
                    <IconMore size={14} />
                  </button>
                  <span className="grip" title="拖动排序">
                    <IconGrip size={13} />
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
                        重命名显示名
                      </button>
                      {aliases[cwd] !== undefined && (
                        <button className="menu-item" onClick={() => clearAlias(cwd)}>
                          恢复真实目录名
                        </button>
                      )}
                      {sessions.length > 0 && (
                        <>
                          <div className="menu-sep" />
                          <button
                            className="menu-item danger"
                            onClick={() => {
                              setMenu(null)
                              void run(props.proxy.archiveSessions(sessions.map((session) => session.id)))
                            }}
                          >
                            <IconArchive size={14} /> 归档这 {sessions.length} 个会话
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
              {visible.map((session) => {
                const sKey = `s:${session.id}`
                return (
                  <div
                    key={session.id}
                    className={`sess-item${session.id.endsWith(`${props.activeSessionId ?? '#'}.jsonl`) ? ' active' : ''}`}
                    role="button"
                    tabIndex={0}
                    title={`${session.title ?? '新会话'}（Ctrl+Alt+R 改名 · Ctrl+Alt+F 分叉 · Ctrl+Shift+A 归档）`}
                    onClick={() => props.onPick(session.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        props.onPick(session.id)
                        return
                      }
                      rowKeys(event, sKey, 'session')
                    }}
                  >
                    {session.pinnedAt !== undefined && (
                      <span className="pin-mark" title="已置顶">
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
                    <span className="when">{relative(props.uiPrefs.sessionSort === 'recent' ? session.updatedAt : session.createdAt)}</span>
                    <span className="row-actions">
                      <button
                        className="icon-btn"
                        title={session.pinnedAt !== undefined ? '取消置顶' : '置顶会话'}
                        onClick={(event) => {
                          event.stopPropagation()
                          void run(props.proxy.setSessionPinned(session.id, session.pinnedAt === undefined))
                        }}
                      >
                        <IconPin size={13} />
                      </button>
                      <button
                        className="icon-btn"
                        title="归档会话"
                        onClick={(event) => {
                          event.stopPropagation()
                          void run(props.proxy.archiveSessions([session.id]))
                        }}
                      >
                        <IconArchive size={13} />
                      </button>
                      <button
                        className={`icon-btn${menu === sKey ? ' on' : ''}`}
                        title="更多操作"
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
                            重命名 <span className="menu-key">Ctrl+Alt+R</span>
                          </button>
                          <button className="menu-item" onClick={() => void openFork(session.id)}>
                            分叉会话 <span className="menu-key">Ctrl+Alt+F</span>
                          </button>
                          <div className="menu-sep" />
                          <button
                            className="menu-item danger"
                            onClick={() => {
                              setMenu(null)
                              void run(props.proxy.archiveSessions([session.id]))
                            }}
                          >
                            <IconArchive size={14} /> 归档会话 <span className="menu-key">Ctrl+Shift+A</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
              {expanded && rest > 0 && (
                <button className="expand-link" onClick={() => setShowAll(true)}>
                  展开剩余 {rest} 个会话
                </button>
              )}
            </div>
          )
        })}
        {showAll && groups.length > 0 && (
          <button className="expand-link" onClick={() => setShowAll(false)}>
            收起完整列表
          </button>
        )}
        {/* 拖动时才对出现：整列表末尾的落点，保证「放到最后一个」永远点得着 */}
        {dragCwd !== null && groups.length > 1 && (
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
        <div className="row" title={`${props.cwd}（点击浏览其他目录）`} onClick={props.onChooseDir}>
          <IconFolder size={14} />
          <span className="dir">{props.cwd}</span>
        </div>
        <div className="row">
          <IconCoins size={14} />
          <span>会话用量</span>
          <span className="num">{formatTokens(totalTokens)} tok</span>
        </div>
      </div>
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
