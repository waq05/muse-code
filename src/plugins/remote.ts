/**
 * remote 插件：把这一条会话开给局域网里的手机浏览器（「远程操控」的宿主半边）。
 *
 * 三件事：**谁伺服**、**谁能进来**、**进来之后能干什么**。
 *
 * 1. 谁伺服：同一台机器上可能有不止一个 Muse Code 进程（桌面端一个、终端一个），
 *    而一个端口只能被一个进程听，所以先抢 `~/.dsc/remote/.owner.json` 主控位（pid + 启动
 *    指纹，写法与调度锁同款）。抢不到的进程**完全休眠**：不监听、不起服务，每 30 秒回头
 *    看一眼主控位空出来没有。
 *
 * 2. 谁能进来：配对码（8 位、1 小时、错 5 次锁 1 小时）换设备 token，token 换一次性 WS
 *    票据，票据换连接。明文码与 token 都不落盘（只落 sha256），码也绝不进 transcript——
 *    会话 jsonl 是会被翻出来的。所有路由都查 Host 头（必须是 IP 字面量或 localhost 且端口
 *    对得上），挡 DNS rebinding：恶意网页把自己的域名解析到 127.0.0.1 也照打不进来。
 *
 * 3. 能干什么：只开一份白名单（见 REMOTE_METHODS），凭据类与宿主生命周期相关的操作
 *    （saveProvider / setProviderKey / setSettingValue / runSettingAction / dock / exit……）
 *    一律不开放。派发与 host-stdio 同一套反射惯例，走 ctx.ui（DscRuntime）。
 *
 * 静态资源目录是 `lib/remote/assets`（批 B 的 vite 产物落点，见 remote-web/vite.config.ts）；
 * 目录不存在（还没构建界面）时 `/` 返回一张「资产未构建」的占位页。
 *
 * @module dsc/plugins/remote
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, extname, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { Plugin } from '@deepseek-ai/cordis'
import { WebSocket, WebSocketServer } from 'ws'
import { errText } from '../adapter/transcript.js'
import { INVOKABLE_METHODS } from '../core/host-methods.js'
import { REMOTE_PORT_MAX, REMOTE_PORT_MIN, type RemotePrefs } from '../core/prefs.js'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import { RemoteOwnerLock } from '../core/remote/owner.js'
import { RemotePairing } from '../core/remote/pairing.js'
import { TicketStore, TICKET_TTL_MS } from '../core/remote/tickets.js'
import { DSC_VERSION } from '../core/version.js'
import type { RuntimeSnapshot, SettingsField } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'remote'

/** WS 协议版本：批 B 的界面按它认版本，破坏性变更时递增。 */
export const REMOTE_PROTOCOL_VERSION = 1

/** 快照推送节流间隔的缺省值（与 host-stdio 同一个口径）。 */
const DEFAULT_SNAPSHOT_THROTTLE_MS = 80

/** 请求体上限：配对与取票据都只有几十个字节，64KB 已经宽得离谱了。 */
const MAX_BODY_BYTES = 64 * 1024

/** 休眠时回头看一眼主控位的间隔。 */
const OWNER_RETRY_MS = 30_000

/**
 * 远程开放的 `DscRuntime` 方法：只是共享白名单（core/host-methods.ts）里的一个子集。
 *
 * 没开的那几类，以及为什么：
 *   - saveProvider / removeProvider / setProviderKey / setDefaultModel / getModelConfig：
 *     凭据与端点写入不开放给浏览器（token 泄了就是泄了，别再让它能改端点）；
 *   - setSettingValue / runSettingAction：能改设置就等于能改权限模式与沙箱档位，
 *     浏览端要改设置请到电脑上改；
 *   - installMarketSkill / setSkillEnabled / setMarketSources / readSkill：往本机装东西的动作；
 *   - dock / runCommand / goalAction / forkSession / purgeSessions / restoreSessions：
 *     宿主生命周期与不可逆的会话操作；
 *   - setPluginEnabled / setPolicy / setUiPrefs / setModel / runCommand 之外的管理动作同理。
 */
export const REMOTE_METHODS = [
  'submit',
  'interrupt',
  'openSession',
  'compact',
  'setModel',
  'setEffort',
  'refreshSessions',
  'listModels',
  'listSkills',
  'listPlugins',
  'getUiPrefs',
  'getSettingsSections',
  'getSectionValues',
  'usageStats',
  'listArchivedSessions',
  'archiveSessions',
  'renameSession',
  'setSessionPinned',
  'answerApproval',
  'answerPlan',
  'answerQuestion',
  'setMode',
  'clearTodos',
  'peekTranscript',
  'listUserMessages',
] as const satisfies readonly (typeof INVOKABLE_METHODS)[number][]

/** 远程白名单里有没有协议根本不认识的方法：有就报下面那个元组类型，编不过。 */
type NotInvokableRemotely = Exclude<(typeof REMOTE_METHODS)[number], (typeof INVOKABLE_METHODS)[number]>
const REMOTE_COVERAGE: NotInvokableRemotely extends never
  ? true
  : ['远程白名单里有协议不认识的方法：', NotInvokableRemotely] = true
void REMOTE_COVERAGE

/** 查表用的集合。 */
const REMOTE_SET: ReadonlySet<string> = new Set<string>(REMOTE_METHODS)

/**
 * 取快照推送节流间隔：夹在 16 毫秒到 1 秒之间（与 host-stdio 同一条理由：再小是白烧 CPU，
 * 再大是点完按钮半天没反应）。
 */
function readThrottle(passed: unknown): number {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const num = Number(raw.snapshotThrottleMs)
  if (!Number.isFinite(num)) return DEFAULT_SNAPSHOT_THROTTLE_MS
  return Math.min(Math.max(Math.round(num), 16), 1_000)
}

/**
 * 静态资源目录：编译产物是 `lib/plugins/remote.js`，界面产物在 `lib/remote/assets`
 * （由 remote-web 的 vite 配置直接写进去）。
 */
export function remoteAssetsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'remote', 'assets')
}

/**
 * 取静态资源目录：默认就是 {@link remoteAssetsDir}，
 * 插件配置里的 `assetsDir` 可以指到别处（自检脚本用它验「目录不存在」的兜底页）。
 */
function readAssetsDir(passed: unknown): string {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const dir = raw.assetsDir
  return typeof dir === 'string' && dir.trim() !== '' ? resolve(dir) : remoteAssetsDir()
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** 资源目录不存在（界面还没构建）时 `/` 返回的占位页。 */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Muse Code 远程控制</title>
  </head>
  <body style="font-family: system-ui, sans-serif; margin: 0; padding: 24px; line-height: 1.7">
    <h1 style="font-size: 20px">远程控制已就绪，但界面资产未构建</h1>
    <p>宿主这一半（HTTP + WebSocket）已经起来了，缺的是手机端的页面文件。</p>
    <p>在仓库的 <code>remote-web/</code> 下执行 <code>pnpm install &amp;&amp; pnpm build</code>，
       产物会落到 <code>lib/remote/assets</code>，刷新本页即可。</p>
    <p style="color: #666">（本机地址 <code id="here"></code>）</p>
    <script>document.getElementById('here').textContent = location.origin</script>
  </body>
</html>
`

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

/** 本机的局域网 IPv4（设置页显示「手机该输哪个地址」；找不到给 null）。 */
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return null
}

// ── 服务端 ────────────────────────────────────────────────────────────────────

/** 一个 WebSocket 会话要的宿主能力（由插件闭包提供，这里不认识 cordis）。 */
interface RemoteServerDeps {
  port: number
  lan: boolean
  throttleMs: number
  /** 静态资源目录（默认 `lib/remote/assets`，配置可改）。 */
  assetsDir: string
  pairing: RemotePairing
  tickets: TicketStore
  /** 派发一个白名单方法（调用方已做过白名单与来源标注）。 */
  invoke(method: string, args: unknown[]): Promise<unknown>
  /** 当前全量快照（批 B 契约的形状：entries 已定稿 + liveEntries 直播尾分开给）。 */
  snapshot(): RemoteSnapshot
  /** 订阅会话流变化（返回退订函数）。 */
  subscribe(listener: () => void): () => void
  /** 往桌面端的对话流写一句话（配对、吊销这类事件）。 */
  notice(text: string): void
}

/** 批 B 契约里的快照：宿主 RuntimeSnapshot 加上会话身份，并把直播尾拆出来。 */
export interface RemoteSnapshot extends RuntimeSnapshot {
  sessionId: string
  cwd: string
  /** 已定稿条目。 */
  entries: RuntimeSnapshot['entries']
  /** 还在长的直播尾（core 里用负 id 标记）。 */
  liveEntries: RuntimeSnapshot['entries']
}

export interface RemoteServerHandle {
  readonly port: number
  readonly lan: boolean
  /** listen 成功与否；失败时 reject（调用方据此回收主控位）。 */
  readonly ready: Promise<void>
  close(): void
  /** 给全部连接推一条消息（例如 dsc/open-picker 转成 {type:'ui'}）。 */
  broadcast(message: Record<string, unknown>): void
  /**
   * 断开连接。
   * @param deviceId - 只断这台设备的；省略 = 全部断开（吊销全部设备时用）
   * @returns 断开了几条
   */
  closeDevices(deviceId?: string): number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 读请求体。
 *
 * 超过上限时不再累积字节、只 reject 一次，让调用方回一个 413：
 * 这里**不能** destroy 请求——那会把连接直接掐掉，413 还没写出去客户端就看到 socket hang up。
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    let size = 0
    let overLimit = false
    req.on('data', (chunk: Buffer) => {
      if (overLimit) return // 已经超了：后面的字节丢掉，等 handler 回 413
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        overLimit = true
        rejectBody(new Error(`请求体超过 ${String(MAX_BODY_BYTES / 1024)}KB`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!overLimit) resolveBody(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (!overLimit) rejectBody(error)
    })
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** 取 `Authorization: Bearer xxx` 里的 token；没有就给 null。 */
function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match === null ? null : (match[1] ?? null)
}

/** 拒绝一次 WS 升级：状态行必须是 ASCII，中文说明放 body 里。 */
function rejectUpgrade(socket: Duplex, status: number, reason: string, error: string): void {
  try {
    const body = JSON.stringify({ ok: false, error })
    socket.write(
      `HTTP/1.1 ${String(status)} ${reason}\r\n` +
        'content-type: application/json; charset=utf-8\r\n' +
        `content-length: ${String(Buffer.byteLength(body))}\r\n` +
        'connection: close\r\n\r\n' +
        body,
    )
  } catch {
    // 对端可能已经走了
  }
  socket.destroy()
}

/**
 * 起一个 HTTP + WebSocket 服务。返回的是句柄而不是 Promise：listen 是异步的，
 * 调用方在 `ready` 上收结果，句柄本身立刻可用（`close` 随时能收）。
 */
export function createRemoteServer(deps: RemoteServerDeps): RemoteServerHandle {
  const assetsDir = deps.assetsDir
  const sockets = new Set<WebSocket>()
  const wss = new WebSocketServer({ noServer: true })
  /** 每条连接的收尾（退订 + 清定时器）。 */
  const cleanups = new Map<WebSocket, () => void>()
  /** 每条连接是哪台设备的（吊销设备时要按这个把人踢下线）。 */
  const sessionDevice = new Map<WebSocket, string>()

  /** 断开连接：只断指定设备，或全断。返回断了几条。 */
  function closeDevices(deviceId?: string): number {
    let count = 0
    for (const ws of [...sockets]) {
      if (deviceId !== undefined && sessionDevice.get(ws) !== deviceId) continue
      count += 1
      cleanups.get(ws)?.()
      try {
        ws.close(1008, '设备已被吊销')
      } catch {
        // 已经断了
      }
    }
    return count
  }

  const serveStatic = (res: ServerResponse, pathname: string): void => {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
    const target = resolve(assetsDir, rel)
    const inside = target === assetsDir || target.startsWith(assetsDir + sep)
    if (inside && existsSync(target) && statSync(target).isFile()) {
      const body = readFileSync(target)
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.length,
        // 界面产物带内容哈希，但 index.html 不带：一律 no-cache，刷新就能拿到新版
        'cache-control': 'no-cache',
      })
      res.end(body)
      return
    }
    if (pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(PLACEHOLDER_HTML),
        'cache-control': 'no-cache',
      })
      res.end(PLACEHOLDER_HTML)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('没有这个文件')
  }

  /** 配对：码换设备 token。 */
  const handlePair = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: string
    try {
      body = await readBody(req)
    } catch (error) {
      // 体没读完就回话：让这一条连接用完就关，别把没读掉的字节留在 keep-alive 上错位
      res.setHeader('connection', 'close')
      sendJson(res, 413, { ok: false, error: errText(error) })
      return
    }
    let parsed: unknown = null
    try {
      parsed = JSON.parse(body === '' ? '{}' : body)
    } catch {
      sendJson(res, 400, { ok: false, error: '请求体不是 JSON' })
      return
    }
    const doc = isRecord(parsed) ? parsed : {}
    const code = typeof doc['code'] === 'string' ? doc['code'] : ''
    const name =
      typeof doc['deviceName'] === 'string' ? doc['deviceName'] : typeof doc['name'] === 'string' ? doc['name'] : ''
    const outcome = deps.pairing.verifyCode(code, name)
    if (!outcome.ok) {
      deps.notice(`远程配对失败：${outcome.error}`)
      sendJson(res, outcome.status, { ok: false, error: outcome.error })
      return
    }
    deps.notice(`远程设备「${outcome.name}」已配对，可以在设置里吊销`)
    sendJson(res, 200, { ok: true, token: outcome.token, deviceId: outcome.deviceId, name: outcome.name })
  }

  /** 取票据：设备 token 换一张 30 秒的一次性 WS 票据。 */
  const handleTicket = (req: IncomingMessage, res: ServerResponse): void => {
    const token = bearerToken(req.headers.authorization)
    const device = token === null ? null : deps.pairing.verifyToken(token)
    if (device === null) {
      sendJson(res, 401, { ok: false, error: '设备凭据无效或已被吊销，请重新配对' })
      return
    }
    sendJson(res, 200, { ok: true, ticket: deps.tickets.issue(device.deviceId), expiresInMs: TICKET_TTL_MS })
  }

  /** 吊销 token（设备管理就走这一条）。 */
  const handleRevoke = (url: URL, req: IncomingMessage, res: ServerResponse): void => {
    const token = url.searchParams.get('token') ?? bearerToken(req.headers.authorization) ?? ''
    if (token === '') {
      sendJson(res, 400, { ok: false, error: '要吊销哪个 token：把 token 放在查询参数或 Authorization 头里' })
      return
    }
    const revoked = deps.pairing.revoke(token)
    // 吊销不只是「下次连不上」：这台设备已经建好的连接当场断掉。
    if (revoked !== null) closeDevices(revoked.deviceId)
    deps.notice(revoked !== null ? `远程设备「${revoked.name}」已吊销` : '吊销请求里的 token 不认识（可能已经吊销过了）')
    sendJson(res, 200, { ok: true, revoked: revoked !== null })
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 所有路由（含静态页面）先过 Host 检查：DNS rebinding 就是从这一条进来的
    if (!hostHeaderAllowed(req.headers.host, deps.port)) {
      sendJson(res, 403, { ok: false, error: 'Host 头不是本机地址，拒绝服务' })
      return
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(deps.port)}`)
    if (req.method === 'POST' && url.pathname === '/api/pair') {
      await handlePair(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/ticket') {
      handleTicket(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/revoke') {
      handleRevoke(url, req, res)
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(res, url.pathname)
      return
    }
    sendJson(res, 404, { ok: false, error: '没有这条路由' })
  }

  const server: Server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      try {
        sendJson(res, 500, { ok: false, error: errText(error) })
      } catch {
        // 响应可能已经发出去了
      }
    })
  })
  // 全生命周期兜底：listen 之后的 socket 级错误不发 'error' 监听器会把进程带崩
  server.on('error', (error) => {
    deps.notice(`远程控制服务出错：${errText(error)}`)
  })

  /** 一条连接的握手与消息循环。 */
  const openSession = (ws: WebSocket, deviceId: string): void => {
    sockets.add(ws)
    sessionDevice.set(ws, deviceId)
    let seq = 0
    let timer: NodeJS.Timeout | null = null
    let pendingSnapshot = false

    const send = (message: Record<string, unknown>): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    }

    // 快照节流：照搬 host-stdio 的写法（80ms 一帧的全量快照，两次变化合一次推送）
    const scheduleSnapshot = (): void => {
      pendingSnapshot = true
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        if (!pendingSnapshot) return
        pendingSnapshot = false
        seq += 1
        send({ type: 'snapshot', seq, ...deps.snapshot() })
      }, deps.throttleMs)
    }

    const unsubscribe = deps.subscribe(scheduleSnapshot)

    const handleMessage = async (data: unknown): Promise<void> => {
      const raw = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      let parsed: unknown = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        send({ type: 'result', id: null, ok: false, error: '上行消息不是 JSON' })
        return
      }
      if (!isRecord(parsed) || parsed['type'] !== 'invoke') return
      const id = parsed['id'] ?? null
      const method = typeof parsed['method'] === 'string' ? parsed['method'] : ''
      // 实参表：正常是数组（批 B 的 encodeArgs）。它还有一份「单个值」的备用编码
      // （wire.ts 的 asSingleValue），这里一并认下——两种编码送进来都能跑通。
      const argsField = parsed['args']
      const args = Array.isArray(argsField) ? (argsField as unknown[]) : argsField === undefined ? [] : [argsField]
      if (!REMOTE_SET.has(method)) {
        send({ type: 'result', id, ok: false, error: `远程不开放这个方法：${method}` })
        return
      }
      try {
        const value = await deps.invoke(method, args)
        send({ type: 'result', id, ok: true, result: value ?? null })
      } catch (error) {
        send({ type: 'result', id, ok: false, error: errText(error) })
      }
    }

    const cleanup = (): void => {
      cleanups.delete(ws)
      sessionDevice.delete(ws)
      sockets.delete(ws)
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    cleanups.set(ws, cleanup)

    ws.on('message', (data) => {
      void handleMessage(data)
    })
    ws.on('close', cleanup)
    ws.on('error', cleanup)

    // 握手：hello 先报身份，紧接着一帧全量快照（首发不节流，界面立刻有内容可画）
    const snapshot = deps.snapshot()
    send({
      type: 'hello',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      app: 'muse-code',
      version: DSC_VERSION,
      port: deps.port,
      lan: deps.lan,
      sessionId: snapshot.sessionId,
      cwd: snapshot.cwd,
      methods: [...REMOTE_METHODS],
    })
    seq += 1
    send({ type: 'snapshot', seq, ...snapshot })
  }

  server.on('upgrade', (req, socket, head) => {
    // 升级请求也要过 Host 检查：DNS rebinding 挡在握手之前
    if (!hostHeaderAllowed(req.headers.host, deps.port)) {
      rejectUpgrade(socket, 403, 'Forbidden', 'Host 头不是本机地址，拒绝升级')
      return
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(deps.port)}`)
    if (url.pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found', 'WS 升级路径只有 /ws')
      return
    }
    // 票据一次性：取走即焚，用过一次或过了 30 秒都算无效；票据里带着是哪台设备换的
    const grant = deps.tickets.redeem(url.searchParams.get('ticket') ?? '')
    if (grant === null) {
      rejectUpgrade(socket, 401, 'Unauthorized', '票据无效或已用过，请重新取一张')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      openSession(ws, grant.deviceId)
    })
  })

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    server.once('error', rejectReady)
    server.listen(deps.port, deps.lan ? '0.0.0.0' : '127.0.0.1', () => {
      resolveReady()
    })
  })

  return {
    port: deps.port,
    lan: deps.lan,
    ready,
    close(): void {
      for (const ws of [...sockets]) {
        cleanups.get(ws)?.()
        try {
          ws.close(1001, '服务已停')
        } catch {
          // 已经断了
        }
      }
      sockets.clear()
      sessionDevice.clear()
      wss.close()
      server.closeAllConnections?.()
      server.close()
    },
    broadcast(message: Record<string, unknown>): void {
      const text = JSON.stringify(message)
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(text)
      }
    },
    closeDevices,
  }
}

// ── 插件 ──────────────────────────────────────────────────────────────────────

export const remotePlugin: Plugin.Object = {
  name: 'remote',
  // 这四个服务是「得先就绪」的意思：ui 是方法派发入口，transcript 供快照与变更订阅，
  // session 给会话 id 与工作目录，settings 用来注册设置分区并监听开关变化。
  inject: ['session', 'transcript', 'agent', 'ui', 'approval', 'settings'],
  apply(ctx, passed) {
    const runtime = ctx.ui
    const throttleMs = readThrottle(passed)
    const pairing = new RemotePairing()
    const owner = new RemoteOwnerLock()
    const tickets = new TicketStore()

    let server: RemoteServerHandle | null = null
    let retryTimer: NodeJS.Timeout | null = null
    let lastProblem: string | null = null
    /** 「退出主控」按过之后不再自动抢回来（重新开关一次「开启远程控制」才解除）。 */
    let yielded = false

    /** 只在问题变了的时候说一次：30 秒一轮的重试不该每轮都往对话流里写一行。 */
    const reportProblem = (text: string): void => {
      if (text === lastProblem) return
      lastProblem = text
      ctx.emit('dsc/notice', text)
    }

    const armRetry = (): void => {
      if (retryTimer !== null) return
      retryTimer = setTimeout(() => {
        retryTimer = null
        applyPrefs()
      }, OWNER_RETRY_MS)
      // 只剩它一个定时器时别挡住进程退出
      retryTimer.unref?.()
    }

    const clearRetry = (): void => {
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = null
    }

    /** 派发：审批答案带来源；其余方法照 host-stdio 的反射惯例展开实参。 */
    const invoke = async (method: string, args: unknown[]): Promise<unknown> => {
      if (method === 'answerApproval') {
        // 手机点的那一下要在审计里认得出（source='web'，见 core/audit.ts）
        return await Reflect.apply(runtime.answerApproval, runtime, [args[0], 'web'])
      }
      const fn = (runtime as unknown as Record<string, unknown>)[method]
      if (typeof fn !== 'function') throw new Error(`运行时没有这个方法：${method}`)
      return await Reflect.apply(fn, runtime, args)
    }

    /** 批 B 契约的快照：会话身份放顶层，直播尾按负 id 拆出来单独给。 */
    const snapshot = (): RemoteSnapshot => {
      const base = runtime.getSnapshot()
      const current = ctx.session.current()
      return {
        ...base,
        sessionId: current.meta.id,
        cwd: current.meta.cwd,
        entries: base.entries.filter((entry) => entry.id > 0),
        liveEntries: base.entries.filter((entry) => entry.id < 0),
      }
    }

    const stopServer = (): void => {
      const instance = server
      server = null
      instance?.close()
    }

    const startServer = (prefs: RemotePrefs): void => {
      if (!owner.tryAcquire(prefs.port)) {
        const info = owner.peek()
        reportProblem(
          `另一个 Muse Code 进程（pid ${String(info?.pid ?? 0)}）拿着远程控制的主控位，本进程先休眠`,
        )
        armRetry()
        return
      }
      const instance = createRemoteServer({
        port: prefs.port,
        lan: prefs.lan,
        throttleMs,
        assetsDir: readAssetsDir(passed),
        pairing,
        tickets,
        invoke,
        snapshot,
        subscribe: (listener) => ctx.transcript.subscribe(listener),
        notice: (text) => ctx.emit('dsc/notice', text),
      })
      server = instance
      instance.ready.then(
        () => {
          lastProblem = null
        },
        (error: unknown) => {
          if (server === instance) server = null
          instance.close()
          owner.release()
          reportProblem(`远程控制起不来（端口 ${String(prefs.port)}）：${errText(error)}；${String(OWNER_RETRY_MS / 1000)} 秒后重试`)
          armRetry()
        },
      )
    }

    /**
     * 按当前偏好把服务调到该有的样子。三条路都会走到这里：插件挂载、偏好写盘（设置页改了
     * 开关/端口/绑定）、30 秒重试到点。它是幂等的：该停的停、该起的起、配置没变就什么都不做。
     */
    function applyPrefs(): void {
      const prefs = ctx.settings.prefs().remote
      if (!prefs.enabled) {
        if (server !== null) {
          stopServer()
          ctx.emit('dsc/notice', '远程控制已关闭：端口不再监听，已连接的设备已断开')
        }
        // 主控位无条件让出：服务没起来但锁已经抢到过（端口被别的程序占着之类），
        // 关开关时也该把这个位子交出去；release 只删自己那份文件，别人的不碰。
        owner.release()
        clearRetry()
        lastProblem = null
        return
      }
      if (server !== null) {
        if (server.port === prefs.port && server.lan === prefs.lan) return
        // 端口或绑定范围改了：停掉旧的，下面按新配置重起（主控位里的端口也跟着刷新）
        stopServer()
      }
      if (yielded) return
      startServer(prefs)
    }

    // ── 设置分区 ──────────────────────────────────────────────────────────────

    const statusText = (): string => {
      const prefs = ctx.settings.prefs().remote
      if (!prefs.enabled) return '已关闭'
      if (server !== null) {
        return `正在伺服：${server.lan ? '0.0.0.0' : '127.0.0.1'}:${String(server.port)}`
      }
      const info = owner.peek()
      if (info !== null && info.pid !== process.pid) {
        return `休眠：另一个 Muse Code 进程（pid ${String(info.pid)}）正伺服`
      }
      return yielded ? '已让出主控位：重新开关一次「开启远程控制」可以拿回来' : '休眠：正在等主控位空出来（每 30 秒重试）'
    }

    const addressText = (): string => {
      const prefs = ctx.settings.prefs().remote
      const port = server?.port ?? prefs.port
      const ip = prefs.lan ? lanAddress() : null
      return `http://${ip ?? '127.0.0.1'}:${String(port)}/`
    }

    const section: SettingsSectionSpec = {
      id: 'remote',
      title: '远程控制',
      subtitle: '把会话开给同一局域网里的手机浏览器',
      order: 40,
      fields(): SettingsField[] {
        const prefs = ctx.settings.prefs().remote
        const devices = pairing.devices()
        return [
          {
            type: 'switch',
            key: 'enabled',
            label: '开启远程控制',
            help: '打开后本机监听一个端口，手机配对后即可接入；关掉立即停止监听并断开已连接的设备',
          },
          {
            type: 'number',
            key: 'port',
            label: '监听端口',
            min: REMOTE_PORT_MIN,
            max: REMOTE_PORT_MAX,
            help: '默认 17321；改端口会重启监听，已经配对的设备不用重新配对',
          },
          {
            type: 'switch',
            key: 'lan',
            label: '允许局域网访问',
            help: '打开后监听 0.0.0.0，同一个 Wi-Fi 下的手机才能连进来；关闭只绑 127.0.0.1，仅本机可用',
          },
          { type: 'info', label: '伺服状态', text: statusText() },
          { type: 'info', label: '访问地址', text: addressText(), mono: true, copyable: true },
          {
            type: 'info',
            label: '已配对设备',
            text: devices.length === 0 ? '还没有设备' : `${String(devices.length)} 台：${devices.map((item) => item.name).join('、')}`,
          },
          {
            type: 'button',
            action: 'regenerate-code',
            label: '生成配对码',
            style: 'primary',
            help: '生成一张 8 位配对码，1 小时内有效；只显示在这里，手机输错 5 次会锁 1 小时',
          },
          { type: 'button', action: 'revoke-all', label: '吊销全部设备', style: 'ghost', help: '所有手机立刻失效，需要重新配对' },
          {
            type: 'button',
            action: 'release-owner',
            label: '退出主控',
            style: 'ghost',
            help: '把伺服位让给别的 Muse Code 进程（本进程不再监听，直到你重新开关一次远程控制）',
          },
        ]
      },
      values() {
        const prefs = ctx.settings.prefs().remote
        return { enabled: prefs.enabled, port: prefs.port, lan: prefs.lan }
      },
      save(key, value) {
        const prefs = ctx.settings.prefs().remote
        if (key === 'enabled') {
          // 重新打开 = 明确要抢回主控位，「退出主控」那道抑制就此解除
          if (value === true) yielded = false
          ctx.settings.setPrefs({ remote: { ...prefs, enabled: value === true } })
          return
        }
        if (key === 'port') {
          const port = Math.round(Number(value))
          if (!Number.isFinite(port) || port < REMOTE_PORT_MIN || port > REMOTE_PORT_MAX) {
            throw new Error(`端口要填 ${String(REMOTE_PORT_MIN)} 到 ${String(REMOTE_PORT_MAX)} 之间的数字`)
          }
          ctx.settings.setPrefs({ remote: { ...prefs, port } })
          return
        }
        if (key === 'lan') {
          ctx.settings.setPrefs({ remote: { ...prefs, lan: value === true } })
          return
        }
        throw new Error(`未知的设置项 ${key}`)
      },
      action(name) {
        if (name === 'regenerate-code') {
          const issued = pairing.issueCode()
          if (issued === null) {
            return '桌面上已经有一张没用过的配对码，先去手机上把它用掉（或者等它 1 小时过期）'
          }
          // 码只从这里出去（设置页那张卡）：绝不写进 transcript，会话 jsonl 是会被翻出来的
          const until = new Date(issued.expiresAt).toLocaleTimeString('zh-CN')
          return `配对码：${issued.code}（${until} 之前有效，输错 5 次锁 1 小时）`
        }
        if (name === 'revoke-all') {
          const count = pairing.revokeAll()
          // 已经在线的手机当场断线，不是等它们下次重连才发现凭据没了
          server?.closeDevices()
          return count === 0 ? '本来就没有已经配对的设备' : `已吊销 ${String(count)} 台设备，手机需要重新配对`
        }
        if (name === 'release-owner') {
          yielded = true
          clearRetry()
          stopServer()
          owner.release()
          return '已让出主控位（本进程不再伺服）；重新开关一次「开启远程控制」可以拿回来'
        }
        throw new Error(`这个分区没有动作 ${name}`)
      },
    }
    const offSection = ctx.settings.registerSection(section)

    // 设置页改开关 / 改端口都走 settings.setPrefs，写盘那一刻就会回调到这里
    const offPrefs = ctx.settings.watchPrefs(() => {
      applyPrefs()
    })

    // 宿主请求打开会话选择面板：转给手机上那张界面（批 B 会切到会话列表页）
    ctx.on('dsc/open-picker', () => {
      server?.broadcast({ type: 'ui', method: 'open-picker' })
    })

    // 进程退出钩子尽力而为：exit 里只能跑同步代码，release 正好是同步的（unlink 一下）
    const onProcessExit = (): void => {
      owner.release()
    }
    process.once('exit', onProcessExit)

    ctx.on('dsc/exit', () => {
      process.removeListener('exit', onProcessExit)
      offSection()
      offPrefs()
      clearRetry()
      stopServer()
      owner.release()
    })

    applyPrefs()
  },
}
