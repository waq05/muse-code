import { useEffect, useState, type ReactNode } from 'react'
import type { RemoteClient } from '../lib/client.js'
import {
  createPushSubscription,
  dropPushSubscription,
  pushBlockReason,
  readPushEnvironment,
} from '../lib/push.js'
import { clearPushEndpoint, loadPushEndpoint, savePushEndpoint } from '../lib/storage.js'

/**
 * 推送开关：放在会话页底部的设备区（那里已经是「这台设备」的设置入口）。
 *
 * 三条规矩：
 *   1. 宿主的推送开关关着时 hello 的 pushPublicKey 是 null —— 按钮整个不显示（不给假按钮）；
 *   2. 手机浏览器有一堆「开关开不了」的原因（http 不是安全上下文、iOS 没加到主屏幕、
 *      权限被拒、浏览器太老），点之前先把原因说清楚，别让用户对着一个没反应的按钮点；
 *   3. 已订阅的状态记在本地（endpoint），按钮显示成「关闭推送」，点了会请宿主忘掉这个端点。
 */
export interface PushToggleProps {
  client: RemoteClient
  /** hello 里的推送公钥；null = 宿主没开推送（按钮隐藏）。 */
  publicKey: string | null
}

export function PushToggle({ client, publicKey }: PushToggleProps): ReactNode {
  const [subscribed, setSubscribed] = useState(() => loadPushEndpoint() !== null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 环境判定是纯函数，每次渲染算一次就够（它读的是全局，不随时间变）。
  const blocked = pushBlockReason(readPushEnvironment())

  // 本地记的端点没了（换了台宿主 / 清了站点数据）时按钮要跟着回「开启」。
  useEffect(() => {
    if (loadPushEndpoint() === null && subscribed) setSubscribed(false)
  }, [subscribed])

  if (publicKey === null) return null

  async function enable(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    setNote('正在向浏览器申请通知权限…')
    try {
      const environment = readPushEnvironment()
      const reason = pushBlockReason(environment)
      if (reason !== null) throw new Error(reason)
      const subscription = await createPushSubscription(publicKey as string, environment)
      setNote('正在登记到电脑端…')
      await client.pushSubscribe(subscription)
      const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint : ''
      if (endpoint !== '') savePushEndpoint(endpoint)
      setSubscribed(true)
      setNote('已开启：电脑端的消息会推到这台设备')
    } catch (cause) {
      setNote(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function disable(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    let endpoint = loadPushEndpoint()
    let failure: string | null = null
    try {
      const environment = readPushEnvironment()
      // 环境不允许碰 SW（http / 老浏览器）时跳过浏览器这一侧，直接请宿主忘掉端点。
      if (pushBlockReason(environment) === null) {
        const dropped = await dropPushSubscription(environment)
        if (endpoint === null && dropped !== null) endpoint = dropped.endpoint ?? null
      }
      if (endpoint !== null) await client.pushUnsubscribe(endpoint)
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause)
    } finally {
      // 不管宿主那边成没成，本机这一侧都要退干净：否则浏览器里那份订阅还占着，
      // 下次点「开启推送」会被 pushManager 直接复用，看着像没生效。
      clearPushEndpoint()
      setSubscribed(false)
      setBusy(false)
      if (failure !== null) setError(failure)
      else setNote('已关闭推送')
    }
  }

  return (
    <div className="pushrow">
      <div className="pushrow-line">
        <span className="pushrow-label">推送通知</span>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void (subscribed ? disable() : enable())}
        >
          {busy ? '处理中…' : subscribed ? '关闭推送' : '开启推送'}
        </button>
      </div>
      {blocked !== null ? <p className="pushrow-hint">{blocked}</p> : null}
      {note !== null ? <p className="pushrow-note">{note}</p> : null}
      {error !== null ? <p className="pushrow-error">{error}</p> : null}
    </div>
  )
}
