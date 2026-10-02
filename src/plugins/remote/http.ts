/**
 * 远程控制 HTTP 层的小工具：请求体读取、JSON 应答、Bearer 解析、Host 校验、
 * lastSeq 解析。
 *
 * 为什么要单独一个模块：remote.ts（握手与帧流）和 routes.ts（业务路由）两边都要用，
 * 放任何一边都会造成兄弟模块互相伸手。这里只有函数，没有状态。
 *
 * @module dsc/plugins/remote/http
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'

/** 常规请求体上限：配对、取票据、推送订阅都只有几十个字节，64KB 已经宽得离谱了。 */
export const MAX_BODY_BYTES = 64 * 1024

/** 解析 lastSeq 查询参数：缺省、非数字、负数、0 一律 0（= 要全量）。 */
export function readLastSeq(raw: string | null): number {
  if (raw === null) return 0
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 读请求体的原始字节。
 *
 * 超过上限时不再累积字节、只 reject 一次，让调用方回一个 413：
 * 这里**不能** destroy 请求——那会把连接直接掐掉，413 还没写出去客户端就看到 socket hang up。
 *
 * @param limit - 这一次读最多收多少字节（JSON 路由 64KB，上传路由 20MB）
 */
export function readBodyBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    let size = 0
    let overLimit = false
    req.on('data', (chunk: Buffer) => {
      if (overLimit) return // 已经超了：后面的字节丢掉，等 handler 回 413
      size += chunk.length
      if (size > limit) {
        overLimit = true
        const shown = limit >= 1024 * 1024 ? `${String(Math.round(limit / 1024 / 1024))}MB` : `${String(Math.round(limit / 1024))}KB`
        rejectBody(new Error(`请求体超过 ${shown}`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!overLimit) resolveBody(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (!overLimit) rejectBody(error)
    })
  })
}

/** 读一个 JSON 请求体（按 UTF-8 解码）。 */
export async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBodyBytes(req, MAX_BODY_BYTES)).toString('utf8')
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * 取 `Authorization: Bearer <token>` 里的 token；没有就给 null。
 *
 * 按字符串解析而不是正则捕获：头部整段必须是「Bearer 前缀 + 一段没有空白的 token」，
 * 带 scheme 以外的内容（多个词）一律不认。
 */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null
  const prefix = 'bearer '
  const trimmed = header.trim()
  if (!trimmed.toLowerCase().startsWith(prefix)) return null
  const token = trimmed.slice(prefix.length).trim()
  if (token === '' || /\s/.test(token)) return null
  return token
}

/**
 * Host 头校验（防 DNS rebinding）。
 *
 * 攻击手法：恶意网页把自己的域名解析到 127.0.0.1，浏览器就会照那个域名向本机服务发请求。
 * 只看「来源是回环地址」拦不住（请求确实从本机发出），能看的是 Host 头——那里带着攻击者的
 * 域名。所以规矩两条：hostname 必须是 IP 字面量或 localhost，且端口必须等于我们在听的端口。
 *
 * @param host - 请求里的 Host 头（`127.0.0.1:17321`、`[::1]:17321`、`192.168.1.5:17321`）
 * @param port - 本服务真正在听的端口
 */
export function hostHeaderAllowed(host: string | undefined | null, port: number): boolean {
  if (host === undefined || host === null) return false
  let rest = host.trim().toLowerCase()
  if (rest === '') return false
  let hostname: string
  let portText: string
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    if (end < 0) return false
    hostname = rest.slice(1, end)
    portText = rest.slice(end + 1).replace(/^:/, '')
  } else {
    const index = rest.lastIndexOf(':')
    hostname = index < 0 ? rest : rest.slice(0, index)
    portText = index < 0 ? '' : rest.slice(index + 1)
  }
  if (portText !== String(port)) return false
  if (hostname === 'localhost') return true
  return isIP(hostname) !== 0
}
