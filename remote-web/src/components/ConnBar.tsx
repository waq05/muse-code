import type { ReactNode } from 'react'
import type { ConnState } from '../lib/client.js'
import { useTicker } from '../lib/hooks.js'

/**
 * 连接细条：只在「没连上」时出现。
 *
 * 文案分清三件事，用户才知道该等还是该点：
 *   - connecting：第一次连（还在取票据/建连接）；
 *   - reconnecting：断了，正在指数退避等待，显示第几次与还有几秒；
 *   - closed：已停止（token 失效那条路由登录页处理，不在这里）。
 */
export interface ConnBarProps {
  conn: ConnState
  attempt: number
  retryAt: number | null
  lastError: string | null
  onRetry: () => void
}

export function ConnBar({ conn, attempt, retryAt, lastError, onRetry }: ConnBarProps): ReactNode {
  const now = useTicker(500)
  if (conn === 'open' || conn === 'idle') return null

  const remaining = retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000))
  const parts: string[] = []
  if (conn === 'connecting') parts.push('正在连接…')
  else if (conn === 'reconnecting') parts.push('连接断开，正在重连…')
  else parts.push('连接已停止')
  if (conn === 'reconnecting' && attempt > 0) {
    parts.push(remaining > 0 ? `第 ${attempt} 次，${remaining} 秒后` : `第 ${attempt} 次`)
  }
  if (lastError !== null && lastError !== '连接断开' && lastError !== '') parts.push(lastError)

  return (
    <div className="connbar" role="status">
      <span className="connbar-dot" aria-hidden="true" />
      <span className="connbar-text">{parts.join(' · ')}</span>
      <button type="button" className="connbar-retry" onClick={onRetry}>
        手动重试
      </button>
    </div>
  )
}
