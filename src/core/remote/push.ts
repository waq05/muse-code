/**
 * 浏览器推送（Web Push）：手机上那个 PWA 关掉之后，宿主靠这条把「等你审批」「一轮跑完」
 * 推到手机的通知栏。
 *
 * 三份东西：
 *
 *   push-keys.json  VAPID 密钥对（**首次用到时才生成**，tmp+rename 原子落盘）。
 *                   公钥交给浏览器订阅，私钥只在本机；换了密钥旧订阅全部作废。
 *   push-subs.json  订阅清单 `[{endpoint, keys:{p256dh,auth}, deviceId, createdAt}]`，
 *                   按 endpoint 去重（同一个浏览器重复订阅只留最新那份）。
 *   发送            web-push 的 sendNotification。404 / 410 表示这个订阅已经废了
 *                   （用户清了站点数据、卸了 PWA），当场从库里删掉；其余失败只记账，
 *                   由调用方写一条 notice，这里绝不抛。
 *
 * 总开关在偏好里（`remote.push`，默认关）：关着时公钥报 null、订阅端点回 403、
 * 一条推送都不发。所以密钥不会因为「装了插件」就被生成出来。
 *
 * @module dsc/core/remote/push
 */
import { existsSync, readFileSync } from 'node:fs'
import webpush from 'web-push'
import { readJsonFile, remoteFiles, writeJsonFile, type RemoteFiles } from './store.js'

/** VAPID 的 subject：推送服务只要求它是一个 mailto 或 https 地址，不校验可达性。 */
export const PUSH_SUBJECT = 'mailto:muse-code@localhost'

/** 一次推送的超时（推送服务不响应时别把这一轮卡住）。 */
export const PUSH_SEND_TIMEOUT_MS = 5_000

/** VAPID 密钥对。 */
export interface PushKeys {
  publicKey: string
  privateKey: string
}

/** 一条浏览器订阅（浏览器 `PushSubscription.toJSON()` 的形状 + 我们自己的归属信息）。 */
export interface PushSubscriptionRecord {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /** 订阅时用的那台设备（deviceId，见 pairing.ts）。 */
  deviceId: string
  createdAt: number
}

/** 真正把一条推送发出去的那一步（自检脚本注入假的，不真打推送服务）。 */
export type PushSender = (subscription: PushSubscriptionRecord, payload: string) => Promise<void>

/** 一次群发的结果。 */
export interface PushSendResult {
  /** 库里当时有几条订阅。 */
  attempted: number
  sent: number
  /** 404/410 当场清掉的条数。 */
  dropped: number
  /** 其它失败的一句话（最多留前几条）。 */
  errors: string[]
}

export type PushSubscribeOutcome = { ok: true; added: boolean; total: number } | { ok: false; error: string }

export interface PushStoreOptions {
  /** 数据目录（默认 `~/.dsc/remote`；自检脚本换成临时目录）。 */
  dir?: string
  now?: () => number
  sender?: PushSender
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从 web-push 抛出来的错误里取 HTTP 状态码；取不到给 0。 */
function statusOf(error: unknown): number {
  if (isRecord(error) && typeof error['statusCode'] === 'number') return error['statusCode']
  return 0
}

/** 默认发送器：就是 web-push 本身。 */
const defaultSender: PushSender = async (subscription, payload) => {
  await webpush.sendNotification(
    { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
    payload,
    { timeout: PUSH_SEND_TIMEOUT_MS },
  )
}

export class RemotePush {
  private readonly files: RemoteFiles
  private readonly now: () => number
  private readonly sender: PushSender
  private keysCache: PushKeys | null = null

  constructor(options: PushStoreOptions = {}) {
    this.files = remoteFiles(options.dir)
    this.now = options.now ?? (() => Date.now())
    this.sender = options.sender ?? defaultSender
  }

  /**
   * 读 VAPID 密钥；没有就生成一份并原子落盘。
   * @returns 密钥对；生成/落盘失败时抛（调用方按「Web Push 不可用」处理）
   */
  keys(): PushKeys {
    if (this.keysCache !== null) return this.keysCache
    const doc = readJsonFile(this.files.pushKeys)
    if (
      doc !== null &&
      typeof doc['publicKey'] === 'string' &&
      typeof doc['privateKey'] === 'string' &&
      doc['publicKey'] !== '' &&
      doc['privateKey'] !== ''
    ) {
      this.keysCache = { publicKey: doc['publicKey'], privateKey: doc['privateKey'] }
      return this.keysCache
    }
    const generated = webpush.generateVAPIDKeys()
    const keys: PushKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey }
    // tmp + rename：写一半崩掉时读到的是「没有密钥」，下次重新生成，不会是半份密钥
    writeJsonFile(this.files.pushKeys, keys)
    this.keysCache = keys
    return keys
  }

  /** 给浏览器的 VAPID 公钥；取不到（web-push 坏了、磁盘写不动）时 null。 */
  publicKey(): string | null {
    try {
      return this.keys().publicKey
    } catch {
      return null
    }
  }

  /** 订阅清单（读不动、内容不是数组一律按空处理）。 */
  subscriptions(): PushSubscriptionRecord[] {
    const file = this.files.pushSubs
    if (!existsSync(file)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    const out: PushSubscriptionRecord[] = []
    for (const item of parsed) {
      if (!isRecord(item)) continue
      const endpoint = item['endpoint']
      const keys = item['keys']
      if (typeof endpoint !== 'string' || endpoint === '' || !isRecord(keys)) continue
      const p256dh = keys['p256dh']
      const auth = keys['auth']
      if (typeof p256dh !== 'string' || p256dh === '' || typeof auth !== 'string' || auth === '') continue
      out.push({
        endpoint,
        keys: { p256dh, auth },
        deviceId: typeof item['deviceId'] === 'string' ? item['deviceId'] : '',
        createdAt: typeof item['createdAt'] === 'number' ? item['createdAt'] : 0,
      })
    }
    return out
  }

  /** 库里现在有几条订阅。 */
  count(): number {
    return this.subscriptions().length
  }

  /**
   * 入库一条浏览器订阅（按 endpoint 去重：同一条更新，不新增）。
   *
   * @param input - 浏览器 `PushSubscription.toJSON()` 的 JSON
   * @param deviceId - 这条订阅属于哪台设备
   */
  add(input: unknown, deviceId: string): PushSubscribeOutcome {
    if (!isRecord(input)) return { ok: false, error: '请求体不是 PushSubscription 对象' }
    const endpoint = input['endpoint']
    const keys = input['keys']
    if (typeof endpoint !== 'string' || endpoint.trim() === '') return { ok: false, error: '订阅里没有 endpoint' }
    // 推送端点必须 https：标准推送服务（FCM / Mozilla autopush）都是 https，明文 http 只会
    // 出现在「把宿主当跳板打内网」的构造请求里（web-push 库会照单全发）。
    if (!/^https:\/\//i.test(endpoint.trim())) return { ok: false, error: 'endpoint 必须 https' }
    if (!isRecord(keys)) return { ok: false, error: '订阅里没有 keys' }
    const p256dh = keys['p256dh']
    const auth = keys['auth']
    if (typeof p256dh !== 'string' || p256dh === '') return { ok: false, error: '订阅里没有 keys.p256dh' }
    if (typeof auth !== 'string' || auth === '') return { ok: false, error: '订阅里没有 keys.auth' }
    const record: PushSubscriptionRecord = {
      endpoint,
      keys: { p256dh, auth },
      deviceId,
      createdAt: this.now(),
    }
    const list = this.subscriptions()
    const index = list.findIndex((item) => item.endpoint === endpoint)
    if (index >= 0) {
      list[index] = record
      writeJsonFile(this.files.pushSubs, list)
      return { ok: true, added: false, total: list.length }
    }
    list.push(record)
    writeJsonFile(this.files.pushSubs, list)
    return { ok: true, added: true, total: list.length }
  }

  /** 按 endpoint 删一条订阅；删掉了返回 true。 */
  remove(endpoint: string): boolean {
    const target = endpoint.trim()
    if (target === '') return false
    const list = this.subscriptions()
    const kept = list.filter((item) => item.endpoint !== target)
    if (kept.length === list.length) return false
    writeJsonFile(this.files.pushSubs, kept)
    return true
  }

  /**
   * 给库里所有订阅发同一条消息。
   *
   * 失败一律只记账：404/410 的订阅当场删掉（它已经永久失效了），其余错误收进 errors
   * 交给调用方写 notice。这个方法自身不抛——推送发不出去不该影响宿主干活。
   */
  async send(message: Record<string, unknown>): Promise<PushSendResult> {
    const result: PushSendResult = { attempted: 0, sent: 0, dropped: 0, errors: [] }
    const list = this.subscriptions()
    if (list.length === 0) return result
    let keys: PushKeys
    try {
      keys = this.keys()
      webpush.setVapidDetails(PUSH_SUBJECT, keys.publicKey, keys.privateKey)
    } catch (error) {
      result.errors.push(`VAPID 密钥不可用：${errorText(error)}`)
      return result
    }
    const payload = JSON.stringify(message)
    const stale: string[] = []
    for (const subscription of list) {
      result.attempted += 1
      try {
        await this.sender(subscription, payload)
        result.sent += 1
      } catch (error) {
        const status = statusOf(error)
        if (status === 404 || status === 410) {
          stale.push(subscription.endpoint)
          result.dropped += 1
          continue
        }
        result.errors.push(status > 0 ? `HTTP ${String(status)}` : errorText(error))
      }
    }
    if (stale.length > 0) {
      const alive = this.subscriptions().filter((item) => !stale.includes(item.endpoint))
      writeJsonFile(this.files.pushSubs, alive)
    }
    return result
  }
}
