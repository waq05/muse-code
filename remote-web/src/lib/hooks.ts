/**
 * 三个小钩子：订阅客户端状态、按秒走的时间、以及「调一次宿主方法」的统一入口。
 * 单独放一个文件是为了让组件里不出现重复的样板（订阅写法错一处就会漏更新）。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientState, RemoteClient } from './client.js'

/** 订阅 RemoteClient 的状态（useSyncExternalStore 语义：快照引用稳定）。 */
export function useClientState(client: RemoteClient): ClientState {
  const subscribe = useCallback((onChange: () => void) => client.subscribe(onChange), [client])
  const getSnapshot = useCallback(() => client.getState(), [client])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 每 intervalMs 返回一次当前时刻：用来做「Xs 后重试」这类倒计时显示。 */
export function useTicker(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

export interface ActionState {
  /** 跑一次异步动作；并发多次时 pending 按计数算。错误只记最近一条。 */
  run: (task: () => Promise<unknown>) => void
  pending: boolean
  error: string | null
  clearError: () => void
}

/** 调宿主方法的统一入口：自动管 pending 与错误文案。 */
export function useAction(): ActionState {
  const [pendingCount, setPendingCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback((task: () => Promise<unknown>) => {
    setPendingCount((count) => count + 1)
    setError(null)
    void task()
      .catch((cause: unknown) => {
        if (!alive.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!alive.current) return
        setPendingCount((count) => Math.max(0, count - 1))
      })
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return { run, pending: pendingCount > 0, error, clearError }
}
