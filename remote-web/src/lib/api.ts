/**
 * 与宿主 remote 插件的 HTTP 对话（配对 + 取一次性 WS 票据 + 上传 + 推送登记）。
 *
 * 路由（协议 v3）：
 *   POST /api/pair             {code, name, deviceName} → {token, deviceId} | {error}
 *   POST /api/ticket           Authorization: Bearer <token> → {ticket}
 *   POST /api/upload?filename= Authorization: Bearer <token>，体是原始字节
 *                              → {ok:true, path, size, name} | {ok:false, error}
 *   GET  /api/push-key         → {ok, publicKey}
 *   POST /api/push-subscribe   Authorization: Bearer <token>，体 = PushSubscription.toJSON()
 *   POST /api/push-unsubscribe Authorization: Bearer <token>，体 = {endpoint}
 * WS 升级走 GET /ws?ticket=...&lastSeq=...（见 client.ts）。
 */

/** 配对码长度（宿主发的是 8 位；界面按这个长度收口输入）。 */
export const PAIR_CODE_LENGTH = 8

export interface PairResult {
  token: string
  deviceId: string
}

/** 一次带原因的业务失败（错误文案直接来自宿主的 `{error}`）。 */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * 网络基底：默认就是「加载这个页面的那个源」——页面本来就是宿主伺服的，
 * 所以同源即正确。本地 `pnpm dev` 时 vite 把 /api 与 /ws 代理到宿主，
 * 也仍然同源；只有把产物挂到别处（比如自建反代）时才需要 VITE_REMOTE_ORIGIN。
 */
export function baseUrl(): string {
  // import.meta.env 是 Vite 注入的，别的打包/运行环境里可能是 undefined，所以按可选读。
  const env = (import.meta as { env?: Record<string, unknown> }).env
  const configured = env?.['VITE_REMOTE_ORIGIN']
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return window.location.origin
}

/**
 * http(s) 源 → ws(s) 地址。
 *
 * `lastSeq` 是协议 v3 的补帧位点：只在本地确实收到过帧时带上（`>= 0`），
 * 宿主据此先把缺失的帧补发过来，再转实时；不带就是「我没有历史，直接给全量」。
 */
export function wsUrl(base: string, ticket: string, lastSeq?: number): string {
  const url = new URL('/ws', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('ticket', ticket)
  if (lastSeq !== undefined && Number.isInteger(lastSeq) && lastSeq >= 0) {
    url.searchParams.set('lastSeq', String(lastSeq))
  }
  return url.toString()
}

async function errorText(response: Response): Promise<string> {
  return recordError(await jsonRecord(response), response)
}

/** 把响应体读成对象；不是 JSON 或是数组就给空对象（调用方按状态码兜底）。 */
async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
  } catch {
    // 体不是 JSON：退回状态码文案。
  }
  return {}
}

/** 失败文案：优先宿主给的 `error`，没有就用状态码。 */
function recordError(record: Record<string, unknown>, response: Response): string {
  const error = record['error']
  if (typeof error === 'string' && error.trim() !== '') return error
  return `请求失败（HTTP ${response.status}）`
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

export interface PairInput {
  code: string
  deviceName: string
}

/** 用配对码换设备 token。失败一律抛 ApiError，文案给用户看。 */
export async function pair(base: string, input: PairInput): Promise<PairResult> {
  const response = await fetch(new URL('/api/pair', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: input.code.trim().toUpperCase(),
      // 协议给了两个名字字段：`name` 是这次配对请求的名字，`deviceName` 是设备显示名。
      // 界面只问用户要一个名字，所以两个字段同值（宿主用哪个都不缺）。
      name: input.deviceName.trim(),
      deviceName: input.deviceName.trim(),
    }),
  })
  if (!response.ok) throw new ApiError(await errorText(response), response.status)
  const body = (await response.json()) as unknown
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const token = record['token']
  if (typeof token !== 'string' || token === '') {
    throw new ApiError('宿主没有返回 token', response.status)
  }
  const deviceId = record['deviceId']
  return { token, deviceId: typeof deviceId === 'string' ? deviceId : '' }
}

/**
 * 取一次性票据（30 秒内有效）。
 * 401/403 说明 token 被吊销或过期——调用方要据此把设备清掉、退回登录页。
 */
export async function fetchTicket(base: string, token: string): Promise<string> {
  const response = await fetch(new URL('/api/ticket', base), {
    method: 'POST',
    headers: authHeaders(token),
  })
  if (!response.ok) throw new ApiError(await errorText(response), response.status)
  const body = (await response.json()) as unknown
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const ticket = record['ticket']
  if (typeof ticket !== 'string' || ticket === '') {
    throw new ApiError('宿主没有返回票据', response.status)
  }
  return ticket
}

// ── 附件上传 ───────────────────────────────────────────────────────────────

/** 一次上传的结果；`path` 就是拼进消息文本里的那个路径。 */
export interface UploadResult {
  path: string
  size: number
  name: string
}

/**
 * 上传一段字节：`POST /api/upload?filename=<encodeURIComponent(名字)>`，
 * 头带 Bearer，体就是原始字节（fetch 直接吃 File/Blob，不做 multipart）。
 *
 * 成败以响应体的 `ok` 为准：宿主可能 HTTP 200 却回 `{ok:false, error}`。
 */
export async function uploadFile(
  base: string,
  token: string,
  file: Blob,
  filename: string,
): Promise<UploadResult> {
  const url = new URL('/api/upload', base)
  url.searchParams.set('filename', filename)
  const response = await fetch(url, { method: 'POST', headers: authHeaders(token), body: file })
  const record = await jsonRecord(response)
  const path = record['path']
  if (response.ok && record['ok'] === true && typeof path === 'string' && path !== '') {
    const size = record['size']
    const name = record['name']
    return {
      path,
      size: typeof size === 'number' && Number.isFinite(size) ? size : file.size,
      name: typeof name === 'string' && name !== '' ? name : filename,
    }
  }
  throw new ApiError(recordError(record, response), response.status)
}

// ── Web Push ───────────────────────────────────────────────────────────────

/**
 * 取推送公钥（VAPID public key）。
 *
 * hello 里已经带了一份（`pushPublicKey`），这条是兜底：拿它可以在「hello 漏了/要重新拉一次」
 * 时补上。带 Bearer 是因为宿主可能给这条路由加了鉴权，多带一个头不会有害。
 *
 * 注意宿主的「推送开关关着」不是错误响应，而是 `{ok:true, publicKey:null}`，
 * 这里翻成人话抛出去，别让它变成一个看不懂的解析失败。
 */
export async function fetchPushKey(base: string, token: string): Promise<string> {
  const response = await fetch(new URL('/api/push-key', base), {
    method: 'GET',
    headers: authHeaders(token),
  })
  const record = await jsonRecord(response)
  const publicKey = record['publicKey']
  if (response.ok && typeof publicKey === 'string' && publicKey !== '') return publicKey
  if (response.ok && record['ok'] === true && (publicKey === null || publicKey === undefined)) {
    throw new ApiError('电脑端的推送开关关着（没有公钥）', response.status)
  }
  throw new ApiError(recordError(record, response), response.status)
}

/** 登记订阅：体就是 `PushSubscription.toJSON()`，原样转发。 */
export async function pushSubscribe(base: string, token: string, subscription: unknown): Promise<void> {
  const response = await fetch(new URL('/api/push-subscribe', base), {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(subscription ?? {}),
  })
  const record = await jsonRecord(response)
  if (response.ok && record['ok'] !== false) return
  throw new ApiError(recordError(record, response), response.status)
}

/** 注销订阅：体是 `{endpoint}`。 */
export async function pushUnsubscribe(base: string, token: string, endpoint: string): Promise<void> {
  const response = await fetch(new URL('/api/push-unsubscribe', base), {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  })
  const record = await jsonRecord(response)
  if (response.ok && record['ok'] !== false) return
  throw new ApiError(recordError(record, response), response.status)
}
