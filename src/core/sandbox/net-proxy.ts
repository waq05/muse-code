/**
 * 出网白名单代理：windows-token 后端的网络出口。
 *
 * 为什么是「代理 + 域名白名单」而不是直接放网络：
 * 沙箱子进程的网络被 WFP/防火墙挡到只剩回环（见 setup 脚本），它唯一能碰到的
 * 外部服务就是本进程里这个代理。代理按域名清单放行 CONNECT 与绝对形式 HTTP，
 * 其余一律 403——于是**任何**出网流量都必须经过这份清单，不管子进程认不认
 * HTTP_PROXY 环境变量（不认的直连会被 WFP 拦死，两道锁是互补的，不是重复的）。
 *
 * 刻意不做 TLS 解密（codex 的 network-proxy 做了 MITM）：解密需要给沙箱账号装根证书、
 * 且会撞证书固定。对「管控」这个目的，CONNECT 头里的域名就是子进程想去的地方——
 * 代理只把流量中继给它声明的主机，中间人解密带来的只是「看得见」，不是「管得住」。
 * 管控强度不因省掉 MITM 而下降：没进清单的域名一个字节都出不去。
 *
 * 纯 node:http/net/dns，无新依赖；DNS 由代理代查（子进程的 53 端口出不去）。
 *
 * @module dsc/core/sandbox/net-proxy
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as tcpConnect } from 'node:net'
import type {Duplex} from 'node:stream'
import { allowlistMatches } from './policy.js'

/** 代理运行状态与最近若干条放行/阻断记录（`/sandbox` 诊断用）。 */
export interface ProxyLogEntry {
  at: number
  host: string
  port: string
  allowed: boolean
  why: string
}

export interface NetProxy {
  /** 实际监听端口（探测可用端口后确定）。 */
  readonly port: number
  /** 给子进程环境用的代理地址：`http://127.0.0.1:<port>`。 */
  readonly url: string
  /** 最近一次请求起的日志（新的在后，环形，最多 keep 条）。 */
  log(): readonly ProxyLogEntry[]
  /** 停掉监听并断开全部在途连接。 */
  close(): void
}

export interface NetProxyOptions {
  /** 现取的网络总开关（关 = 全部阻断）。 */
  online: () => boolean
  /** 现取的域名白名单（每次请求现读，改设置立刻生效）。 */
  allowlist: () => readonly string[]
  /** 指定端口（默认 0 = 由系统挑一个空闲口）。 */
  port?: number
  /** 日志条数上限（默认 50）。 */
  keep?: number
}

/** 回环地址族：代理只听这些，不给外面开面。 */
const LOOPBACK_HOST = '127.0.0.1'

/** CONNECT / 绝对形式 HTTP 请求里的 `host:port`。 */
function parseAuthority(authority: string): { host: string; port: string } | null {
  const index = authority.lastIndexOf(':')
  if (index <= 0) return null
  const host = authority.slice(0, index).trim().toLowerCase().replace(/^\[|\]$/g, '')
  const port = authority.slice(index + 1).trim()
  if (host === '' || !/^\d{1,5}$/.test(port)) return null
  const numeric = Number(port)
  if (numeric < 1 || numeric > 65535) return null
  return { host, port }
}

/** 绝对形式 HTTP 请求行里的 URL → `host:port`；不是绝对形式给 null。 */
function parseAbsoluteUrl(raw: string): { host: string; port: string } | null {
  const match = /^https?:\/\/([^/?#]+)/i.exec(raw)
  if (match === null) return parseAuthority('') // 非 URL：不是代理形态
  return parseAuthority(match[1]!)
}

export function createNetProxy(options: NetProxyOptions): Promise<NetProxy> {
  const keep = options.keep ?? 50
  const logBuffer: ProxyLogEntry[] = []
  const sockets = new Set<Duplex>()

  const record = (entry: ProxyLogEntry): void => {
    logBuffer.push(entry)
    if (logBuffer.length > keep) logBuffer.shift()
  }

  /** 这一次请求放不放行：总开关 + 白名单，一条不满足就给拒因。 */
  const verdict = (host: string): { allowed: true } | { allowed: false; why: string } => {
    if (!options.online()) return { allowed: false, why: '网络开关是关的（沙箱档位）' }
    const list = options.allowlist()
    if (allowlistMatches(host, list)) return { allowed: true }
    return {
      allowed: false,
      why: list.length === 0 ? '白名单是空的（开了网也没放任何域名）' : `不在出网白名单里（清单 ${String(list.length)} 项）`,
    }
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // 绝对形式（代理语义）按 URL 判；相对形式按 Host 头判（host*port 缺口视为 80）。
    const parsed = req.url !== undefined && /^https?:\/\//i.test(req.url)
      ? parseAbsoluteUrl(req.url)
      : parseAuthority(req.headers.host ?? '')
    if (parsed === null) {
      res.writeHead(400).end('dsc 沙箱代理：认不出目标主机')
      return
    }
    const one = verdict(parsed.host)
    record({ at: Date.now(), host: parsed.host, port: parsed.port, allowed: one.allowed, why: one.allowed ? '在白名单里' : one.why })
    if (!one.allowed) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`dsc 沙箱代理：${parsed.host} 被阻断 —— ${one.why}。要放行请在「设置 → 沙箱」把它加进出网白名单。`)
      return
    }
    // 放行：按原样转发（去代理语义的 URL 前缀），流式直通不缓存
    const upstream = httpRequest({
      host: parsed.host,
      port: Number(parsed.port),
      path: req.url ?? '/',
      method: req.method,
      headers: { ...req.headers, host: `${parsed.host}:${parsed.port}`, proxy_connection: undefined, 'proxy-authorization': undefined },
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end(`dsc 沙箱代理：连不上 ${parsed.host}:${parsed.port}`)
      else res.destroy()
    })
    req.pipe(upstream)
    upstream.pipe(res)
  })

  // CONNECT：只认目标主机并做双向裸中继（TLS 原样透传，不落盘不看内容）
  server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const parsed = parseAuthority(req.url ?? '')
    if (parsed === null) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const one = verdict(parsed.host)
    record({ at: Date.now(), host: parsed.host, port: parsed.port, allowed: one.allowed, why: one.allowed ? '在白名单里' : one.why })
    if (!one.allowed) {
      const body = `dsc 沙箱代理：${parsed.host} 被阻断 —— ${one.why}。要放行请在「设置 → 沙箱」把它加进出网白名单。`
      socket.write(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      socket.destroy()
      return
    }
    const upstream = tcpConnect(Number(parsed.port), parsed.host, () => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.destroy()
    })
    sockets.add(upstream)
    sockets.add(socket)
    upstream.on('close', () => sockets.delete(upstream))
    socket.on('close', () => sockets.delete(socket))
  })

  return new Promise<NetProxy>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolvePromise({
        port,
        url: `http://${LOOPBACK_HOST}:${String(port)}`,
        log: () => [...logBuffer],
        close: () => {
          for (const socket of sockets) socket.destroy()
          sockets.clear()
          server.close()
        },
      })
    })
  })
}

/** 给子进程环境注入的代理变量（大小写都给：不同工具认不同的键）。 */
export function proxyEnvVars(url: string): Record<string, string> {
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    ALL_PROXY: url,
    all_proxy: url,
    NO_PROXY: '',
    no_proxy: '',
  }
}
