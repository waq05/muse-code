import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RemoteClient } from '../lib/client.js'
import { formatWhen, pathTail, sessionTitle } from '../lib/format.js'
import { normalizeArchivedPage, normalizeSessions } from '../lib/protocol.js'
import type { ArchivedPage, RemoteSnapshot, SessionSummary } from '../lib/types.js'

/**
 * 会话列表：按工作目录分组，当前会话所在的那一组排最前、组内当前会话排第一。
 *
 * 界面上必须说清的一件事：这里点一下换会话，**桌面端正在看的会话也跟着变**——
 * 遥控不是另开一条平行会话，而是接到同一个宿主上。这句话就写在列表顶部。
 *
 * 归档区是只读的：宿主开放的 invoke 清单里有 listArchivedSessions / archiveSessions，
 * 但没有恢复与永久删除，所以这里只列出来，并如实说明去哪儿做后续动作。
 */
export interface SessionsPageProps {
  client: RemoteClient
  snapshot: RemoteSnapshot | null
  /** WS 每次成功打开自增：变了就重新拉一次列表。 */
  epoch: number
  connected: boolean
  onPick: () => void
  /** 清掉本机凭据（= 这台设备退出登录）。 */
  onSignOut?: () => void
  deviceName?: string
}

interface Group {
  cwd: string
  sessions: SessionSummary[]
  isCurrent: boolean
}

export function SessionsPage({
  client,
  snapshot,
  epoch,
  connected,
  onPick,
  onSignOut,
  deviceName,
}: SessionsPageProps): ReactNode {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [archived, setArchived] = useState<ArchivedPage | null>(null)
  const [archivedError, setArchivedError] = useState<string | null>(null)

  const currentSessionId = snapshot?.sessionId ?? null
  const currentCwd = snapshot?.cwd ?? null

  // 快照只当兜底数据源：放进 ref 而不是依赖里，否则每来一次快照就会重拉一遍列表。
  const snapshotRef = useRef(snapshot)
  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const list = await client.refreshSessions()
      // 宿主也会把结果写进快照；两边都取，返回值为空时用快照兜底（快照可能先到）。
      setSessions(list.length > 0 ? list : normalizeSessions(snapshotRef.current?.sessions ?? []))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSessions((previous) =>
        previous.length > 0 ? previous : normalizeSessions(snapshotRef.current?.sessions ?? []),
      )
    } finally {
      setLoading(false)
    }
  }, [client])

  // 进页面拉一次；每次重连成功（epoch 变化）再拉一次，保证列表不带旧数据。
  useEffect(() => {
    if (!connected) return
    void refresh()
  }, [connected, epoch, refresh])

  async function openArchived(): Promise<void> {
    if (archivedOpen) {
      setArchivedOpen(false)
      return
    }
    setArchivedOpen(true)
    setArchivedError(null)
    try {
      const page = await client.invoke<unknown>('listArchivedSessions', [])
      setArchived(normalizeArchivedPage(page))
    } catch (cause) {
      setArchivedError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function pick(session: SessionSummary): Promise<void> {
    if (opening !== null) return
    setOpening(session.id)
    setError(null)
    try {
      await client.openSession(session.id)
      onPick()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOpening(null)
    }
  }

  const groups = groupSessions(sessions, currentCwd, currentSessionId)

  return (
    <div className="page page-sessions">
      <div className="sessions-head">
        <div className="sessions-cwd" title={currentCwd ?? ''}>
          当前工作目录：<span className="mono">{currentCwd === null ? '未知' : pathTail(currentCwd)}</span>
        </div>
        <p className="sessions-warn">在此处切换会话会改变桌面正在看的会话。</p>
        <div className="sessions-actions">
          <button type="button" className="ghost" onClick={() => void refresh()} disabled={loading || !connected}>
            {loading ? '刷新中…' : '刷新'}
          </button>
          <span className="sessions-count">{sessions.length} 条会话</span>
        </div>
        {error !== null ? <p className="sessions-error">{error}</p> : null}
      </div>

      <div className="sessions-list">
        {groups.length === 0 && !loading ? (
          <div className="stream-empty">这个工作区还没有会话记录。</div>
        ) : null}
        {groups.map((group) => (
          <section key={group.cwd === '' ? '__unknown__' : group.cwd} className="group">
            <header className={`group-head${group.isCurrent ? ' is-current' : ''}`}>
              <span className="group-cwd mono" title={group.cwd}>
                {group.cwd === '' ? '未知目录' : pathTail(group.cwd, 2)}
              </span>
              <span className="group-count">{group.sessions.length}</span>
            </header>
            {group.sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                current={session.id === currentSessionId}
                busy={opening === session.id}
                disabled={opening !== null}
                onPick={() => void pick(session)}
              />
            ))}
          </section>
        ))}

        <section className="group">
          <button type="button" className="group-head group-head-button" onClick={() => void openArchived()}>
            <span className="group-cwd">归档会话</span>
            <span className="group-count">{archivedOpen ? '▾' : '▸'}</span>
          </button>
          {archivedOpen ? (
            <div className="archived">
              {archivedError !== null ? <p className="sessions-error">{archivedError}</p> : null}
              {archived !== null && archived.items.length === 0 && archivedError === null ? (
                <div className="archived-empty">归档区是空的。</div>
              ) : null}
              {archived?.items.map((item) => (
                <div key={item.path} className="archived-row">
                  <span className="archived-title">{item.title ?? pathTail(item.path, 1)}</span>
                  <span className="archived-meta">
                    {pathTail(item.cwd)} · 归档于 {formatWhen(item.archivedAt)}
                  </span>
                </div>
              ))}
              {archived !== null && archived.items.length > 0 ? (
                <p className="archived-note">
                  远程接口只开了「列出归档」，恢复与永久删除请在桌面端做。
                  {archived.trashCount > 0 ? `（回收站里还有 ${archived.trashCount} 个）` : ''}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        <div className="sessions-foot">
          <div className="sessions-foot-line">
            <span className="sessions-device">{deviceName ?? '这台设备'}</span>
            {onSignOut !== undefined ? (
              <button type="button" className="ghost danger" onClick={onSignOut}>
                在本机退出
              </button>
            ) : null}
          </div>
          <p className="sessions-foot-note">
            凭据存在本机浏览器里，退出只是删掉它；要让某个设备彻底失效，请到电脑端设置的「远程操控」里移除该设备。
          </p>
        </div>
      </div>
    </div>
  )
}

function SessionRow({
  session,
  current,
  busy,
  disabled,
  onPick,
}: {
  session: SessionSummary
  current: boolean
  busy: boolean
  disabled: boolean
  onPick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={`session-row${current ? ' is-current' : ''}`}
      onClick={onPick}
      disabled={disabled}
    >
      <span className="session-main">
        <span className="session-title">{sessionTitle(session)}</span>
        <span className="session-meta">
          {busy ? '切换中…' : formatWhen(session.updatedAt)}
          {session.pinnedAt !== undefined ? ' · 置顶' : ''}
        </span>
      </span>
      {current ? <span className="session-badge">当前</span> : null}
    </button>
  )
}

/**
 * 分组排序：
 *   1. 当前会话所在的 cwd 组排第一（用户八成就是找它）；
 *   2. 组内当前会话排第一，其余按「置顶 → 最近写入」；
 *   3. 组之间按组内最新写入时间倒序。
 */
function groupSessions(
  sessions: SessionSummary[],
  currentCwd: string | null,
  currentSessionId: string | null,
): Group[] {
  const map = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    const list = map.get(session.cwd)
    if (list === undefined) map.set(session.cwd, [session])
    else list.push(session)
  }
  const groups: Group[] = []
  for (const [cwd, list] of map) {
    const sorted = [...list].sort((left, right) => {
      if (left.id === currentSessionId) return -1
      if (right.id === currentSessionId) return 1
      const leftPinned = left.pinnedAt ?? 0
      const rightPinned = right.pinnedAt ?? 0
      if (leftPinned !== rightPinned) return rightPinned - leftPinned
      return right.updatedAt - left.updatedAt
    })
    groups.push({ cwd, sessions: sorted, isCurrent: currentCwd !== null && cwd === currentCwd })
  }
  groups.sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1
    return latest(right.sessions) - latest(left.sessions)
  })
  return groups
}

function latest(sessions: SessionSummary[]): number {
  let value = 0
  for (const session of sessions) value = Math.max(value, session.updatedAt)
  return value
}
