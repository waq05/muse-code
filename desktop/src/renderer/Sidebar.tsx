/**
 * 侧栏：品牌区、新会话、工作区分组会话列表（活动组展开、其余折叠）、
 * 底部工作目录与用量。布局对照 dsh 桌面端左栏。
 *
 * @module desktop/renderer/Sidebar
 */
import { useMemo, useState, type JSX } from 'react'
import type { SessionSummary, TokenUsageView } from '@dsc/runtime/contract.js'
import iconUrl from '../../build/icon.png'
import { IconCoins, IconFolder, IconFolderOpen, IconPlus, IconPuzzle, IconSwap } from './icons.js'

/** 活动工作区默认展开的会话条数（其余收进「展开剩余」）。 */
const PREVIEW_COUNT = 5

export function Sidebar(props: {
  sessions: SessionSummary[]
  activeSessionId: string | null
  cwd: string
  usage: TokenUsageView | null
  view: 'chat' | 'plugins'
  onView(view: 'chat' | 'plugins'): void
  onNew(): void
  onPick(id: string): void
  onChooseDir(): void
}): JSX.Element {
  const [manualOpen, setManualOpen] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)

  const groups = useMemo(() => {
    const map = new Map<string, SessionSummary[]>()
    for (const session of [...props.sessions].sort((a, b) => b.createdAt - a.createdAt)) {
      const key = session.cwd || '(未指定)'
      const list = map.get(key) ?? []
      list.push(session)
      map.set(key, list)
    }
    // 活动工作区排最前
    return [...map.entries()].sort((a, b) => (a[0] === props.cwd ? -1 : b[0] === props.cwd ? 1 : 0))
  }, [props.sessions, props.cwd])

  const isActiveGroup = (cwd: string): boolean => cwd === props.cwd
  const isExpanded = (cwd: string): boolean => manualOpen.has(cwd) || (isActiveGroup(cwd) && !manualOpen.has(`!${cwd}`))

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

  const totalTokens =
    props.usage !== null ? props.usage.inputTokens + props.usage.outputTokens : 0

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
          className={`nav-item${props.view === 'plugins' ? ' on' : ''}`}
          onClick={() => props.onView(props.view === 'plugins' ? 'chat' : 'plugins')}
        >
          <IconPuzzle size={15} /> 插件
        </button>
      </nav>

      <div className="sidebar-scroll">
        <div className="section-head">
          <span>工作区</span>
          <button className="icon-btn" title="切换工作目录" onClick={props.onChooseDir}>
            <IconSwap size={14} />
          </button>
        </div>

        {props.sessions.length === 0 && (
          <div className="sidebar-empty">
            还没有历史会话。
            <br />
            发送第一条消息开始。
          </div>
        )}

        {groups.map(([cwd, sessions]) => {
          const expanded = isExpanded(cwd)
          const active = isActiveGroup(cwd)
          const visible = expanded && !showAll ? sessions.slice(0, PREVIEW_COUNT) : expanded ? sessions : []
          const rest = sessions.length - visible.length
          return (
            <div key={cwd} className="group">
              <button
                className={`group-row${active ? ' active' : ''}`}
                title={cwd}
                onClick={() => toggle(cwd)}
              >
                <span className="folder-icon">{expanded ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}</span>
                <span className="dir">{lastSegment(cwd)}</span>
                <span className="count">{sessions.length}</span>
              </button>
              {visible.map((session) => (
                <button
                  key={session.id}
                  className={`sess-item${session.id.endsWith(`${props.activeSessionId ?? '#'}.jsonl`) ? ' active' : ''}`}
                  onClick={() => props.onPick(session.id)}
                  title={session.title ?? session.id}
                >
                  <span className="title">{session.title ?? '新会话'}</span>
                  <span className="when">{relative(session.createdAt)}</span>
                </button>
              ))}
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
      </div>

      <div className="sidebar-footer">
        <div className="row" title={`${props.cwd}（点击切换工作目录）`} onClick={props.onChooseDir}>
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
