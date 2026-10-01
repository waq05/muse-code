/**
 * remote 插件：把这一条会话开给局域网里的手机浏览器（「远程操控」的宿主半边）。
 *
 * 四件事：**谁伺服**、**谁能进来**、**进来之后能干什么**、**不看屏幕也能知道有事发生**。
 *
 * 1. 谁伺服：同一台机器上可能有不止一个 Muse Code 进程（桌面端一个、终端一个），
 *    而一个端口只能被一个进程听，所以先抢 `~/.dsc/remote/.owner.json` 主控位（pid + 启动
 *    指纹，写法与调度锁同款）。抢不到的进程**完全休眠**：不监听、不起服务，每 30 秒回头
 *    看一眼主控位空出来没有。
 *
 * 2. 谁能进来：配对码（8 位、半小时、错 5 次锁 1 小时）换设备 token，token 换一次性 WS
 *    票据，票据换连接。明文码与 token 都不落盘（只落 sha256），码也绝不进 transcript——
 *    会话 jsonl 是会被翻出来的。所有路由都查 Host 头（必须是 IP 字面量或 localhost 且端口
 *    对得上），挡 DNS rebinding：恶意网页把自己的域名解析到 127.0.0.1 也照打不进来。
 *
 * 3. 能干什么：只开一份白名单（见 REMOTE_METHODS），凭据类与宿主生命周期相关的操作
 *    （saveProvider / setProviderKey / setSettingValue / runSettingAction / dock / exit……）
 *    一律不开放。派发与 host-stdio 同一套反射惯例，走 ctx.ui（DscRuntime）。
 *
 * 4. 不看屏幕也能知道：审批卡从无到有、一轮跑完 → Web Push + 通知 Webhook 同时发
 *    （设置里的 `remote.push` 与 `remote.notifyWebhook`）。推送全挂在插件已有的
 *    订阅与事件上，内核一条新事件都不用加。
 *
 * **帧协议 v3**（批 B 的手机界面按这一份认版本）：
 *
 *   - seq 是**宿主级全局单调递增**的（跨连接、跨重连连续），不再每条连接各自从 1 数；
 *   - 快照不再每帧全量：与上一帧相比按条目 `id` 做 diff，只发 `added` / `updated` /
 *     `removedIds`，其余字段打成 `meta` 每帧全量带（规则与锚帧见 core/remote/frames.ts）；
 *   - 最近 120 帧进环形缓冲（**原样存 JSON 字符串**，重发不重算）。客户端在升级 URL 上带
 *     `&lastSeq=N`：N 落在缓冲窗口内就照原样补发 N 之后的所有帧再转实时（补发不节流），
 *     否则 `hello` + 一帧全量；
 *   - 上行（invoke）与静态资源一如既往；上传与推送订阅走 HTTP，不进 invoke 白名单。
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
import { RemoteFrameHub, type BuiltFrame } from '../core/remote/frames.js'
import { isHttpUrl, sendWebhook, webhookHasPlaceholder, type WebhookMessage, type WebhookResult } from '../core/remote/notify.js'
import { RemoteOwnerLock } from '../core/remote/owner.js'
import { RemotePairing } from '../core/remote/pairing.js'
import { RemotePush, type PushSendResult, type PushSubscribeOutcome } from '../core/remote/push.js'
import { TicketStore, TICKET_TTL_MS } from '../core/remote/tickets.js'
import { RemoteUploads, UPLOAD_MAX_BYTES } from '../core/remote/uploads.js'
import { DSC_VERSION } from '../core/version.js'
import type { RuntimeSnapshot, SettingsField, StatusView } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'remote'

/** WS 协议版本：批 B 的界面按它认版本，破坏性变更时递增（v3 = 全局 seq + 增量帧 + 补帧）。 */
export const REMOTE_PROTOCOL_VERSION = 3

/** 快照推送节流间隔的缺省值（与 host-stdio 同一个口径）。 */
const DEFAULT_SNAPSHOT_THROTTLE_MS = 80

/** 常规请求体上限：配对、取票据、推送订阅都只有几十个字节，64KB 已经宽得离谱了。 */
const MAX_BODY_BYTES = 64 * 1024

/** 休眠时回头看一眼主控位的间隔。 */
const OWNER_RETRY_MS = 30_000

/** 同类推送的节流窗口：审批卡连着弹、轮结束连着来的时候，手机上别炸一串。 */
const NOTIFY_THROTTLE_MS = 10_000

/** 多短的一轮不值得通报（用过 15 秒以上，或者这一轮出现过审批卡，才发「轮完成」）。 */
const TURN_NOTIFY_MIN_MS = 15_000

/** 解析 lastSeq 查询参数：缺省、非数字、负数、0 一律 0（= 要全量）。 */
function readLastSeq(raw: string | null): number {
  if (raw === null) return 0
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

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
 *
 * 上传（POST /api/upload）与推送订阅（POST /api/push-subscribe）不在这一份里：
 * 它们是 HTTP 路由，不是 RPC 方法。
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
  /** 上传落盘（POST /api/upload）。 */
  uploads: RemoteUploads
  /** 派发一个白名单方法（调用方已做过白名单与来源标注）。 */
  invoke(method: string, args: unknown[]): Promise<unknown>
  /** 当前全量快照（批 B 契约的形状：entries 已定稿 + liveEntries 直播尾分开给）。 */
  snapshot(): RemoteSnapshot
  /** 订阅会话流变化（返回退订函数）。 */
  subscribe(listener: () => void): () => void
  /** 往桌面端的对话流写一句话（配对、吊销、上传这类事件）。 */
  notice(text: string): void
  /** Web Push 总开关（关着时订阅端点回 403、hello 里的公钥报 null）。 */
  pushEnabled(): boolean
  /** VAPID 公钥（Web Push 关着或不可用时 null）。 */
  pushPublicKey(): string | null
  /** 浏览器订阅入库（按 endpoint 去重）。 */
  pushSubscribe(payload: unknown, deviceId: string): PushSubscribeOutcome
  /** 按 endpoint 删订阅。 */
  pushUnsubscribe(endpoint: string): boolean
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
 * 读请求体的原始字节。
 *
 * 超过上限时不再累积字节、只 reject 一次，让调用方回一个 413：
 * 这里**不能** destroy 请求——那会把连接直接掐掉，413 还没写出去客户端就看到 socket hang up。
 *
 * @param limit - 这一次读最多收多少字节（JSON 路由 64KB，上传路由 20MB）
 */
function readBodyBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
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
async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBodyBytes(req, MAX_BODY_BYTES)).toString('utf8')
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
 *
 * 帧流是**宿主级一份**：一个节流定时器 + 一个 {@link RemoteFrameHub}，所有连接收同一串帧。
 */
export function createRemoteServer(deps: RemoteServerDeps): RemoteServerHandle {
  const assetsDir = deps.assetsDir
  const sockets = new Set<WebSocket>()
  const wss = new WebSocketServer({ noServer: true })
  /** 每条连接的收尾（退订 + 清定时器）。 */
  const cleanups = new Map<WebSocket, () => void>()
  /** 每条连接是哪台设备的（吊销设备时要按这个把人踢下线）。 */
  const sessionDevice = new Map<WebSocket, string>()

  /** 全局帧流：seq 跨连接连续，最近 120 帧进环形缓冲。 */
  const hub = new RemoteFrameHub()
  let frameTimer: NodeJS.Timeout | null = null
  let framePending = false
  /**
   * 一条连接都没有的时候发生的会话变化：帧流那时不前进（没人看，白算），
   * 所以下一条连接补完缓冲里的帧之后，必须再补一帧全量把这段时间的变化对上。
   */
  let missedWhileIdle = false

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

  const sendText = (ws: WebSocket, text: string): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(text)
  }

  /** 造下一帧、进环形缓冲、发给所有连接。 */
  const emitFrame = (forceFull: boolean): BuiltFrame => {
    const frame = hub.build(deps.snapshot(), forceFull)
    for (const ws of sockets) sendText(ws, frame.text)
    missedWhileIdle = false
    return frame
  }

  /** 会话流有变化：攒到下一次节流到点，合成一帧。 */
  const scheduleFrame = (): void => {
    if (sockets.size === 0) {
      // 没人连着：不造帧（造了也没人收），但要记住「这段时间变过」
      missedWhileIdle = true
      return
    }
    framePending = true
    if (frameTimer !== null) return
    frameTimer = setTimeout(() => {
      frameTimer = null
      if (!framePending) return
      framePending = false
      if (sockets.size === 0) {
        missedWhileIdle = true
        return
      }
      emitFrame(false)
    }, deps.throttleMs)
  }

  const stopFrames = (): void => {
    if (frameTimer !== null) clearTimeout(frameTimer)
    frameTimer = null
    framePending = false
  }

  /** 宿主级订阅：帧流是共享的，所以只订一次（不是每条连接一份）。 */
  const unsubscribeStream = deps.subscribe(scheduleFrame)

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

  /** 从 Authorization 头认设备；认不出给 null。 */
  const deviceOf = (req: IncomingMessage) => {
    const token = bearerToken(req.headers.authorization)
    return token === null ? null : deps.pairing.verifyToken(token)
  }

  /** 请求体读不动（超限 / 连接断了）时的统一回应：让这一条连接用完就关。 */
  const failBody = (res: ServerResponse, status: number, error: unknown): void => {
    res.setHeader('connection', 'close')
    sendJson(res, status, { ok: false, error: errText(error) })
  }

  /** 读一个 JSON 体；不是 JSON 或读不动时自己回话并返回 null（包一层是为了跟「body 就是 null」区分开）。 */
  const readJsonBody = async (req: IncomingMessage, res: ServerResponse): Promise<{ value: unknown } | null> => {
    let body: string
    try {
      body = await readBody(req)
    } catch (error) {
      failBody(res, 413, error)
      return null
    }
    try {
      return { value: JSON.parse(body === '' ? '{}' : body) }
    } catch {
      sendJson(res, 400, { ok: false, error: '请求体不是 JSON' })
      return null
    }
  }

  /** 配对：码换设备 token。 */
  const handlePair = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const parsed = await readJsonBody(req, res)
    if (parsed === null) return
    const doc = isRecord(parsed.value) ? parsed.value : {}
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
    const device = deviceOf(req)
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

  /**
   * 上传：`POST /api/upload?filename=<urlencoded>`，body 是原始字节。
   *
   * 这条路由**不受 64KB 请求体上限约束**（上限由 uploads.ts 的 20MB 说了算），
   * 但要过和其它路由一样的 Host 检查与设备 token 检查。
   */
  const handleUpload = async (url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const device = deviceOf(req)
    if (device === null) {
      sendJson(res, 401, { ok: false, error: '设备凭据无效或已被吊销，请重新配对' })
      return
    }
    let data: Buffer
    try {
      data = await readBodyBytes(req, UPLOAD_MAX_BYTES)
    } catch (error) {
      failBody(res, 413, error)
      return
    }
    const filename = url.searchParams.get('filename') ?? ''
    if (filename.trim() === '') {
      sendJson(res, 400, { ok: false, error: '要上传的文件得带上 ?filename=…' })
      return
    }
    let outcome
    try {
      outcome = deps.uploads.save(filename, data)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `写盘失败：${errText(error)}` })
      return
    }
    if (!outcome.ok) {
      sendJson(res, 400, { ok: false, error: outcome.error })
      return
    }
    deps.notice(`远程设备「${device.name}」上传了 ${outcome.name}（${String(outcome.size)} 字节）`)
    sendJson(res, 200, outcome)
  }

  /** VAPID 公钥：只要 Host 检查，不要 token（浏览器订阅前得先拿到它）。 */
  const handlePushKey = (res: ServerResponse): void => {
    if (!deps.pushEnabled()) {
      sendJson(res, 200, { ok: true, publicKey: null })
      return
    }
    sendJson(res, 200, { ok: true, publicKey: deps.pushPublicKey() })
  }

  /** 浏览器订阅入库（按 endpoint 去重）。 */
  const handlePushSubscribe = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!deps.pushEnabled()) {
      sendJson(res, 403, { ok: false, error: '浏览器推送没开：先在电脑上「设置 → 远程控制」里打开' })
      return
    }
    const device = deviceOf(req)
    if (device === null) {
      sendJson(res, 401, { ok: false, error: '设备凭据无效或已被吊销，请重新配对' })
      return
    }
    const payload = await readJsonBody(req, res)
    if (payload === null) return
    const outcome = deps.pushSubscribe(payload.value, device.deviceId)
    sendJson(res, outcome.ok ? 200 : 400, outcome)
  }

  /** 退订：body `{endpoint}`。 */
  const handlePushUnsubscribe = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!deps.pushEnabled()) {
      sendJson(res, 403, { ok: false, error: '浏览器推送没开：先在电脑上「设置 → 远程控制」里打开' })
      return
    }
    const device = deviceOf(req)
    if (device === null) {
      sendJson(res, 401, { ok: false, error: '设备凭据无效或已被吊销，请重新配对' })
      return
    }
    const payload = await readJsonBody(req, res)
    if (payload === null) return
    const endpoint = isRecord(payload.value) && typeof payload.value['endpoint'] === 'string' ? payload.value['endpoint'] : ''
    if (endpoint.trim() === '') {
      sendJson(res, 400, { ok: false, error: 'body 里要带 {endpoint}' })
      return
    }
    sendJson(res, 200, { ok: true, removed: deps.pushUnsubscribe(endpoint) })
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 所有路由（含静态页面与上传）先过 Host 检查：DNS rebinding 就是从这一条进来的
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
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      await handleUpload(url, req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/push-key') {
      handlePushKey(res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/push-subscribe') {
      await handlePushSubscribe(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/push-unsubscribe') {
      await handlePushUnsubscribe(req, res)
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
  const openSession = (ws: WebSocket, deviceId: string, lastSeq: number): void => {
    sockets.add(ws)
    sessionDevice.set(ws, deviceId)

    const send = (message: Record<string, unknown>): void => {
      sendText(ws, JSON.stringify(message))
    }

    // 握手：hello 先报身份（协议版本、端口、开放方法、VAPID 公钥），再按 lastSeq 决定补帧还是全量
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
      pushPublicKey: deps.pushPublicKey(),
    })
    const replay = hub.resume(lastSeq)
    if (replay === null) {
      // 接不上（没带 lastSeq、缓冲是空的、或者客户端的号在窗口外）：hello + 一帧全量
      emitFrame(true)
    } else {
      // 补发不节流：缓冲里存的就是原样的 JSON 字符串，直接照发
      for (const text of replay) sendText(ws, text)
      // 断线期间一条连接都没有、那时发生的变化没进帧流：补一帧全量把它对上
      if (missedWhileIdle) emitFrame(true)
    }

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
    }
    cleanups.set(ws, cleanup)

    ws.on('message', (data) => {
      void handleMessage(data)
    })
    ws.on('close', cleanup)
    ws.on('error', cleanup)
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
    const lastSeq = readLastSeq(url.searchParams.get('lastSeq'))
    wss.handleUpgrade(req, socket, head, (ws) => {
      openSession(ws, grant.deviceId, lastSeq)
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
      unsubscribeStream()
      stopFrames()
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
      for (const ws of sockets) sendText(ws, text)
    },
    closeDevices,
  }
}

// ── 推送 ──────────────────────────────────────────────────────────────────────

/** 一次推送的两条腿各自的结果（测试按钮要把真实结果说清楚，所以留着细节）。 */
interface NotifyOutcome {
  push: PushSendResult | null
  pushSkipped: string | null
  webhook: WebhookResult | null
  webhookSkipped: string | null
}

/** 审批卡在快照里能给的那点标题信息：参数摘要最好用，退而求其次用工具名。 */
function approvalHeadline(approval: RuntimeSnapshot['surfaces']['pendingApproval']): string {
  if (approval === null) return '打开手机确认'
  const summary = approval.argsSummary.trim()
  if (summary !== '') return summary
  const tool = approval.toolName.trim()
  return tool === '' ? '打开手机确认' : tool
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
    /** 上传落盘与浏览器推送：数据文件都在 `~/.dsc/remote`（自检换 HOME 就整体隔离）。 */
    const uploads = new RemoteUploads()
    const pushStore = new RemotePush()

    let server: RemoteServerHandle | null = null
    let retryTimer: NodeJS.Timeout | null = null
    let lastProblem: string | null = null
    /** 推送密钥取不到时只提醒一次（每次连接都提醒会刷屏）。 */
    let pushProblem: string | null = null
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

    const addressText = (): string => {
      const prefs = ctx.settings.prefs().remote
      const port = server?.port ?? prefs.port
      const ip = prefs.lan ? lanAddress() : null
      return `http://${ip ?? '127.0.0.1'}:${String(port)}/`
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

    /** 把 VAPID 公钥给出去（关着时 null）。取不到只提醒一次，然后一直报 null。 */
    const pushPublicKey = (): string | null => {
      if (!ctx.settings.prefs().remote.push) return null
      const key = pushStore.publicKey()
      if (key === null && pushProblem === null) {
        pushProblem = '浏览器推送的 VAPID 密钥读不出来（也不能生成），推送先按不可用处理'
        ctx.emit('dsc/notice', pushProblem)
      }
      return key
    }

    // ── 推送：Web Push 与通知 Webhook 同一触发点同时发，互不影响 ─────────────

    /** 同类推送 10 秒节流（键是触发类别：approval / turn-end）。 */
    const lastNotifyAt: Record<string, number> = {}

    /**
     * 发一条通知（两条腿：浏览器推送 + Webhook）。
     *
     * 任何一条腿失败都只写一条 notice，绝不抛——推送发不出去不该影响宿主干活；
     * 两条腿互相独立，Web Push 没开不影响 Webhook 照发，反之亦然。
     */
    const notify = async (kind: string, message: WebhookMessage, throttle: boolean): Promise<NotifyOutcome> => {
      const outcome: NotifyOutcome = { push: null, pushSkipped: null, webhook: null, webhookSkipped: null }
      const prefs = ctx.settings.prefs().remote
      if (throttle) {
        const now = Date.now()
        const last = lastNotifyAt[kind] ?? 0
        if (now - last < NOTIFY_THROTTLE_MS) {
          outcome.pushSkipped = '10 秒内已经发过同类推送'
          outcome.webhookSkipped = outcome.pushSkipped
          return outcome
        }
        lastNotifyAt[kind] = now
      }
      if (prefs.push) {
        try {
          const result = await pushStore.send({ title: message.title, body: message.body, url: message.url })
          outcome.push = result
          if (result.attempted > result.sent) {
            const why = result.errors[0] ?? '订阅已失效，已从库里清掉'
            ctx.emit(
              'dsc/notice',
              `浏览器推送：${String(result.sent)}/${String(result.attempted)} 台成功，没发出去的原因：${why}`,
            )
          }
        } catch (error) {
          outcome.pushSkipped = errText(error)
          ctx.emit('dsc/notice', `浏览器推送失败：${outcome.pushSkipped}`)
        }
      } else {
        outcome.pushSkipped = '浏览器推送没开'
      }
      const webhook = prefs.notifyWebhook.trim()
      if (webhook !== '') {
        const result = await sendWebhook(webhook, message)
        outcome.webhook = result
        if (!result.ok) ctx.emit('dsc/notice', `通知 Webhook 没发出去：${result.error}`)
      } else {
        outcome.webhookSkipped = '没配通知 Webhook'
      }
      return outcome
    }

    // ── 推送触发：全在现有订阅与事件里，内核一条新事件都不用加 ───────────────

    /** 上一帧的审批卡 id（判「从无到有」）。 */
    let prevApprovalId: string | null = null
    /** 上一帧的回合状态（判「一轮开始了」）。 */
    let prevTurnState: StatusView['turnState'] = 'idle'
    /** 这一轮什么时候开始的（推送里要报「用时 Xs」，宿主没有 turn-start 事件，插件自己记）。 */
    let turnStartedAt = 0
    /** 这一轮里出现过审批卡没有（短轮也值得通报的第二条条件）。 */
    let turnHadApproval = false

    /** 会话流一变就看一眼快照：审批卡从无到有 → 推送；回合从 idle 起来 → 记开始时刻。 */
    const watchTransitions = (): void => {
      const current = runtime.getSnapshot()
      const state = current.status.turnState
      if (state !== 'idle' && prevTurnState === 'idle') {
        turnStartedAt = Date.now()
        turnHadApproval = false
      }
      prevTurnState = state
      const approval = current.surfaces.pendingApproval
      const approvalId = approval === null ? null : approval.id
      if (approval !== null && approvalId !== null && prevApprovalId === null) {
        turnHadApproval = true
        void notify(
          'approval',
          { title: 'Muse Code 等待审批', body: approvalHeadline(approval), url: addressText() },
          true,
        )
      }
      prevApprovalId = approvalId
    }
    const offTransitions = ctx.transcript.subscribe(watchTransitions)

    /** 一轮结束：用过 15 秒以上、或者这一轮出现过审批卡，才值得推一条。 */
    const onTurnEnd = (): void => {
      const elapsedMs = turnStartedAt === 0 ? 0 : Date.now() - turnStartedAt
      const hadApproval = turnHadApproval
      turnStartedAt = 0
      turnHadApproval = false
      if (elapsedMs < TURN_NOTIFY_MIN_MS && !hadApproval) return
      const seconds = Math.max(0, Math.round(elapsedMs / 1000))
      void notify('turn-end', { title: 'Muse Code 轮完成', body: `用时 ${String(seconds)}s`, url: addressText() }, true)
    }
    ctx.on('dsc/turn-end', onTurnEnd)

    const stopServer = (): void => {
      const instance = server
      server = null
      instance?.close()
    }

    const startServer = (prefs: RemotePrefs): void => {
      if (!owner.tryAcquire(prefs.port)) {
        const info = owner.peek()
        reportProblem(
          `远程控制由另一个 Muse Code 进程（pid ${String(info?.pid ?? 0)}）接管，本进程待命`,
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
        uploads,
        invoke,
        snapshot,
        subscribe: (listener) => ctx.transcript.subscribe(listener),
        notice: (text) => ctx.emit('dsc/notice', text),
        pushEnabled: () => ctx.settings.prefs().remote.push,
        pushPublicKey,
        pushSubscribe: (payload, deviceId) => pushStore.add(payload, deviceId),
        pushUnsubscribe: (endpoint) => pushStore.remove(endpoint),
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
          ctx.emit('dsc/notice', '远程控制已关闭，已连接的设备已断开')
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
        return `运行中 · ${server.lan ? '0.0.0.0' : '127.0.0.1'}:${String(server.port)}`
      }
      const info = owner.peek()
      if (info !== null && info.pid !== process.pid) {
        return `由另一个 Muse Code 进程（pid ${String(info.pid)}）接管`
      }
      return yielded ? '已让出主控位，重新开关「开启远程控制」拿回' : '等待主控位空出（每 30 秒重试）'
    }

    /** 时间戳给设置页看的样子；0（没记过）说「未知」。 */
    const timeText = (at: number): string => (at > 0 ? new Date(at).toLocaleString('zh-CN') : '未知')

    const pushStatusText = (): string => {
      const prefs = ctx.settings.prefs().remote
      if (!prefs.push) return '没开'
      const key = pushPublicKey()
      return key === null ? '开着，但 VAPID 密钥不可用' : `开着，已订阅 ${String(pushStore.count())} 台`
    }

    const webhookStatusText = (): string => {
      const raw = ctx.settings.prefs().remote.notifyWebhook.trim()
      if (raw === '') return '没配'
      return raw.includes('{') && webhookHasPlaceholder(raw) ? `${raw}（GET）` : `${raw}（POST JSON）`
    }

    const section: SettingsSectionSpec = {
      id: 'remote',
      title: '远程控制',
      subtitle: '把会话开给同一局域网里的手机浏览器',
      order: 40,
      fields(): SettingsField[] {
        const prefs = ctx.settings.prefs().remote
        const devices = pairing.devices()
        const rows: SettingsField[] = [
          {
            type: 'switch',
            key: 'enabled',
            label: '开启远程控制',
            help: '打开后监听端口等待手机接入；关闭立即断开所有连接',
          },
          {
            type: 'number',
            key: 'port',
            label: '监听端口',
            min: REMOTE_PORT_MIN,
            max: REMOTE_PORT_MAX,
            help: '改端口会重启监听，已配对的设备不受影响',
          },
          {
            type: 'switch',
            key: 'lan',
            label: '允许局域网访问',
            help: '打开后同一 Wi-Fi 下的手机可以连入；关闭仅本机可用',
          },
          { type: 'info', label: '运行状态', text: statusText() },
          { type: 'info', label: '访问地址', text: addressText(), mono: true, copyable: true },
          {
            type: 'switch',
            key: 'push',
            label: '浏览器推送（Web Push）',
            help: '手机先把本页「添加到主屏幕」，才能收到系统通知；关闭时不订阅、不推送',
          },
          { type: 'info', label: '推送状态', text: pushStatusText() },
          {
            type: 'text',
            key: 'notifyWebhook',
            label: '通知 Webhook',
            placeholder: 'https://api.day.app/你的KEY/{title}/{body}',
            help: '留空 = 关。带 {title}/{body}/{url} 占位符的地址按 GET 发（Bark），不带的按 POST JSON 发（ntfy）',
          },
          { type: 'info', label: 'Webhook 状态', text: webhookStatusText(), mono: true },
          {
            type: 'button',
            action: 'test-push',
            label: '发送测试推送',
            style: 'primary',
            help: '浏览器推送与 Webhook 各发一条，结果以右下角通知弹出',
          },
          {
            type: 'info',
            label: '已配对设备',
            text: devices.length === 0 ? '还没有设备' : `${String(devices.length)} 台：${devices.map((item) => item.name).join('、')}`,
          },
        ]
        // 每台设备两行：一行身份（名字 + 最近活跃 + 创建时间），一行「吊销」按钮。
        // fields() 是每次刷新都重新调的，所以吊销完下一刷就少一台，不用自己再通知界面。
        for (const device of devices) {
          rows.push({
            type: 'info',
            label: device.name,
            text: `最近活跃 ${timeText(device.lastSeenAt)}`,
          })
          rows.push({
            type: 'button',
            action: `revoke-device:${device.deviceId}`,
            label: '吊销',
            style: 'ghost',
            help: `断开「${device.name}」的连接并作废它的凭据，重新配对后才能连回`,
          })
        }
        rows.push(
          {
            type: 'button',
            action: 'regenerate-code',
            label: '连接手机',
            style: 'primary',
            help: '打开连接弹窗，手机扫码或输码即可配对；配对码半小时内有效',
          },
          { type: 'button', action: 'revoke-all', label: '吊销全部设备', style: 'ghost', help: '所有手机立刻失效，需要重新配对' },
          {
            type: 'button',
            action: 'release-owner',
            label: '退出主控',
            style: 'ghost',
            help: '多开时把监听让给别的 Muse Code 进程，重新开关远程控制可拿回来',
          },
        )
        return rows
      },
      values() {
        const prefs = ctx.settings.prefs().remote
        return {
          enabled: prefs.enabled,
          port: prefs.port,
          lan: prefs.lan,
          push: prefs.push,
          notifyWebhook: prefs.notifyWebhook,
        }
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
        if (key === 'push') {
          ctx.settings.setPrefs({ remote: { ...prefs, push: value === true } })
          return
        }
        if (key === 'notifyWebhook') {
          const raw = String(value ?? '').trim()
          if (raw !== '' && !isHttpUrl(raw)) {
            throw new Error('通知 Webhook 要填 http:// 或 https:// 开头的地址；留空 = 关掉')
          }
          ctx.settings.setPrefs({ remote: { ...prefs, notifyWebhook: raw } })
          return
        }
        throw new Error(`未知的设置项 ${key}`)
      },
      async action(name) {
        if (name === 'regenerate-code') {
          // replace：每次点「连接手机」（以及弹窗里的「重新生成」）都换一张新码，旧码当场作废。
          // 为什么要作废而不是复用：明文码不落盘，旧码的明文只在上一张弹窗上，宿主重画不出来；
          // 而这张弹窗本来就该「一直看得见一张有效码」，所以只能换新的（界面上的 help 写明了这点）。
          const issued = pairing.issueCode({ replace: true })
          if (issued === null) {
            // 理论到不了这里（replace 一定发得出来），留着当兜底
            return '配对码签发失败，请稍后重试'
          }
          // 码只从这里出去（桌面的「连接手机」弹窗）：绝不写进 transcript，会话 jsonl 是会被翻出来的。
          // 所以 notice 只说「生成了、半小时内有效」，码本体与可扫地址放 data，由界面画在弹窗里。
          // addressText() 已经给的是带协议的完整地址（末尾一个斜杠），直接接查询串即可。
          return {
            notice: '配对码已生成（半小时内有效）',
            data: {
              kind: 'pair-code',
              code: issued.code,
              url: `${addressText()}?code=${issued.code}`,
              expiresAt: issued.expiresAt,
            },
          }
        }
        if (name === 'revoke-all') {
          const count = pairing.revokeAll()
          // 已经在线的手机当场断线，不是等它们下次重连才发现凭据没了
          server?.closeDevices()
          return count === 0 ? '本来就没有已经配对的设备' : `已吊销 ${String(count)} 台设备，手机需要重新配对`
        }
        if (name.startsWith('revoke-device:')) {
          const deviceId = name.slice('revoke-device:'.length)
          const revoked = pairing.revokeDevice(deviceId)
          if (revoked === null) return '这台设备已经不在了（可能刚被别的地方吊销掉）'
          const closed = server?.closeDevices(deviceId) ?? 0
          return `已吊销「${revoked.name}」${closed > 0 ? `，断开 ${String(closed)} 条连接` : ''}`
        }
        if (name === 'test-push') {
          const prefs = ctx.settings.prefs().remote
          const message: WebhookMessage = {
            title: 'Muse Code 测试推送',
            body: '这条消息来自电脑上「设置 → 远程控制」的测试按钮',
            url: addressText(),
          }
          const lines: string[] = []
          if (prefs.push) {
            try {
              const result = await pushStore.send({ ...message })
              if (result.attempted === 0) lines.push('浏览器推送：库里还没有订阅的设备（手机要先把页面加到主屏幕）')
              else {
                lines.push(
                  `浏览器推送：${String(result.sent)}/${String(result.attempted)} 台成功` +
                    (result.dropped > 0 ? `，${String(result.dropped)} 台订阅已失效（已清理）` : '') +
                    (result.errors.length > 0 ? `，失败原因：${result.errors.join('；')}` : ''),
                )
              }
            } catch (error) {
              lines.push(`浏览器推送：失败（${errText(error)}）`)
            }
          } else {
            lines.push('浏览器推送：没开（开关关着，一条都没发）')
          }
          const webhook = prefs.notifyWebhook.trim()
          if (webhook === '') {
            lines.push('通知 Webhook：没配（留空 = 关）')
          } else {
            const result = await sendWebhook(webhook, message)
            lines.push(
              result.ok
                ? `通知 Webhook：已发送（${result.mode === 'get' ? 'GET' : 'POST JSON'}）`
                : `通知 Webhook：失败（${result.error}）`,
            )
          }
          return lines.join('；')
        }
        if (name === 'release-owner') {
          yielded = true
          clearRetry()
          stopServer()
          owner.release()
          return '已让出主控位；重新开关「开启远程控制」可拿回来'
        }
        throw new Error(`这个分区没有动作 ${name}`)
      },
    }
    // 远程控制是内核级功能：桌面端设置页只列 builtin 分区，这里声明 inSettings
    // 让它进设置页（插件中心那张卡照旧不放它，避免同一处配置两个入口）。
    const offSection = ctx.settings.registerSection(section, { inSettings: true })

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
      offTransitions()
      clearRetry()
      stopServer()
      owner.release()
    })

    applyPrefs()
  },
}
