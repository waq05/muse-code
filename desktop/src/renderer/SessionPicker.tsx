/**
 * 会话选择器：/resume 与「会话…」按钮的模态列表（↑↓/Enter/Esc 键盘可用）。
 *
 * @module desktop/renderer/SessionPicker
 */
import { useEffect, useState, type JSX } from 'react'
import type { SessionSummary } from '@dsc/runtime/contract.js'

export function SessionPicker(props: {
  sessions: SessionSummary[]
  loading: boolean
  onPick(id: string): void
  onClose(): void
}): JSX.Element {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex(0)
  }, [props.sessions])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
      else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setIndex((current) => Math.max(0, current - 1))
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setIndex((current) => Math.min(props.sessions.length - 1, current + 1))
      } else if (event.key === 'Enter') {
        const session = props.sessions[index]
        if (session !== undefined) props.onPick(session.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props, index])

  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="picker" onClick={(event) => event.stopPropagation()}>
        <div className="title">选择要恢复的会话（↑↓ 选择 · Enter 恢复 · Esc 取消）</div>
        <div className="list">
          {props.loading && <div className="empty">正在读取会话列表…</div>}
          {!props.loading && props.sessions.length === 0 && (
            <div className="empty">没有历史会话</div>
          )}
          {props.sessions.map((session, position) => (
            <div
              key={session.id}
              className={`row${position === index ? ' active' : ''}`}
              onClick={() => props.onPick(session.id)}
            >
              <span className="id">{session.title ?? session.id.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '')}</span>
              <span className="meta">
                {session.cwd} · {new Date(session.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
        <div className="foot">共 {props.sessions.length} 个会话</div>
      </div>
    </div>
  )
}
