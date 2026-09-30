/**
 * 与宿主 remote 插件的 HTTP 对话（配对 + 取一次性 WS 票据）。
 *
 * 只有两条路：
 *   POST /api/pair    {code, name, deviceName} → {token, deviceId} | {error}
 *   POST /api/ticket  Authorization: Bearer <token> → {ticket}
 * WS 升级走 GET /ws?ticket=...（见 client.ts）。
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

/** http(s) 源 → ws(s) 地址。 */
export function wsUrl(base: string, ticket: string): string {
  const url = new URL('/ws', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('ticket', ticket)
  return url.toString()
}

async function errorText(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null) {
      const record = body as Record<string, unknown>
      const error = record['error']
      if (typeof error === 'string' && error.trim() !== '') return error
    }
  } catch {
    // 体不是 JSON：退回状态码文案。
  }
  return `请求失败（HTTP ${response.status}）`
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
    headers: { authorization: `Bearer ${token}` },
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
