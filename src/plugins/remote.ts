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
import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { Plugin } from '@deepseek-ai/cordis'
import { WebSocket, WebSocketServer } from 'ws'
import { bootNoticeOnce } from '../core/boot-notices.js'
import { errText } from '../core/err-text.js'
import { REMOTE_PORT_MAX, REMOTE_PORT_MIN, type RemotePrefs } from '../core/prefs.js'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import { RemoteFrameHub, type BuiltFrame } from '../core/remote/frames.js'
import { isHttpUrl, sendWebhook, webhookHasPlaceholder, type WebhookMessage, type WebhookResult } from '../core/remote/notify.js'
import { RemoteOwnerLock } from '../core/remote/owner.js'
import { RemotePairing } from '../core/remote/pairing.js'
import { RemotePush, type PushSendResult } from '../core/remote/push.js'
import { TicketStore } from '../core/remote/tickets.js'
import { RemoteUploads } from '../core/remote/uploads.js'
import { DSC_VERSION } from '../core/version.js'
import type { RuntimeSnapshot, SettingsField, StatusView } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'
import { hostHeaderAllowed, isRecord, readLastSeq, sendJson } from './remote/http.js'
import { createRequestHandler } from './remote/routes.js'
import {
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SET,
  type RemoteServerDeps,
  type RemoteServerHandle,
  type RemoteSnapshot,
} from './remote/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'remote'

/** 快照推送节流间隔的缺省值（与 host-stdio 同一个口径）。 */
const DEFAULT_SNAPSHOT_THROTTLE_MS = 80

/** 休眠时回头看一眼主控位的间隔。 */
const OWNER_RETRY_MS = 30_000

/** 同类推送的节流窗口：审批卡连着弹、轮结束连着来的时候，手机上别炸一串。 */
const NOTIFY_THROTTLE_MS = 10_000
/** T45：同一张卡挂了这么久还没人理，就升级再提醒一声（别让推送石沉大海）。 */
const ESCALATE_WAIT_MS = 120_000
/** T45：升级提醒最多几声（别变成骚扰）。 */
const ESCALATE_MAX = 3

/** 多短的一轮不值得通报（用过 15 秒以上，或者这一轮出现过审批卡，才发「轮完成」）。 */
const TURN_NOTIFY_MIN_MS = 15_000

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

/** 本机的局域网 IPv4（设置页显示「手机该输哪个地址」；找不到给 null）。 */
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return null
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
 * HTTP 业务路由在 `remote/routes.ts`（`createRequestHandler`），这里只剩帧流、
 * WS 会话与生命周期。
 */
export function createRemoteServer(deps: RemoteServerDeps): RemoteServerHandle {
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

  const handleRequest = createRequestHandler({ deps, closeDevices })

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

    /** 上一帧「等人的卡」的键（判「从无到有 / 换了一张」；键 = 卡种:卡标识）。 */
    let prevCardKey: string | null = null
    /** 上一帧的回合状态（判「一轮开始了」）。 */
    let prevTurnState: StatusView['turnState'] = 'idle'
    /** 这一轮什么时候开始的（推送里要报「用时 Xs」，宿主没有 turn-start 事件，插件自己记）。 */
    let turnStartedAt = 0
    /** 这一轮里出现过「等人」的卡没有（短轮也值得通报的第二条条件）。 */
    let turnHadWaitingCard = false
    /** T45：升级提醒的计时器与计数（同一张卡挂久了再喊几声）。 */
    let escalateTimer: NodeJS.Timeout | null = null
    let escalateCount = 0

    /** 当前快照里「等人的卡」（审批 → 计划评审 → 模型提问，同一时刻至多一张在前面挡着）。 */
    function waitingCardOf(current: RuntimeSnapshot): { key: string; title: string; headline: string } | null {
      const approval = current.surfaces.pendingApproval
      if (approval !== null) return { key: `approval:${approval.id}`, title: 'Muse Code 等待审批', headline: approvalHeadline(approval) }
      const plan = current.surfaces.pendingPlan
      if (plan !== null) return { key: `plan:${plan.file}`, title: 'Muse Code 等待计划评审', headline: plan.title }
      const question = current.surfaces.pendingQuestion
      if (question !== null) {
        return { key: `ask:${question.id}`, title: 'Muse Code 在向你提问', headline: question.header ?? question.question }
      }
      return null
    }

    const clearEscalation = (): void => {
      if (escalateTimer !== null) clearTimeout(escalateTimer)
      escalateTimer = null
      escalateCount = 0
    }

    /** T45：升级再提醒——2 分钟第一声，之后每 2 分钟一声，最多 {@link ESCALATE_MAX} 声。 */
    function armEscalation(key: string, headline: string): void {
      clearEscalation()
      escalateTimer = setTimeout(() => {
        escalateCount += 1
        const still = waitingCardOf(runtime.getSnapshot())
        if (still === null || still.key !== key || escalateCount > ESCALATE_MAX) return
        void notify(
          `escalate:${key}`,
          { title: 'Muse Code 还在等人', body: `已等 ${String(Math.round((ESCALATE_WAIT_MS * escalateCount) / 1000))} 秒：${headline}`, url: addressText() },
          false,
        )
        armEscalation(key, headline)
      }, ESCALATE_WAIT_MS)
      escalateTimer.unref()
    }

    /** 会话流一变就看一眼快照：等人的卡从无到有（或换了一张）→ 推送 + 挂升级提醒；回合从 idle 起来 → 记开始时刻。 */
    const watchTransitions = (): void => {
      const current = runtime.getSnapshot()
      const state = current.status.turnState
      if (state !== 'idle' && prevTurnState === 'idle') {
        turnStartedAt = Date.now()
        turnHadWaitingCard = false
      }
      prevTurnState = state
      const card = waitingCardOf(current)
      if (card !== null && card.key !== prevCardKey) {
        turnHadWaitingCard = true
        // T45：节流键带上卡片标识——10 秒内连来两张审批卡时，第二张不再被同一把
        // 「approval」节流吞掉；同一条卡重复的快照刷新仍然只推一声。
        void notify(card.key, { title: card.title, body: card.headline, url: addressText() }, true)
        armEscalation(card.key, card.headline)
      } else if (card === null && prevCardKey !== null) {
        clearEscalation()
      }
      prevCardKey = card?.key ?? null
    }
    const offTransitions = ctx.transcript.subscribe(watchTransitions)

    /** 一轮结束：用过 15 秒以上、或者这一轮出现过等人的卡，才值得推一条。 */
    const onTurnEnd = (): void => {
      const elapsedMs = turnStartedAt === 0 ? 0 : Date.now() - turnStartedAt
      const hadWaitingCard = turnHadWaitingCard
      turnStartedAt = 0
      turnHadWaitingCard = false
      if (elapsedMs < TURN_NOTIFY_MIN_MS && !hadWaitingCard) return
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
        // 启动提示只展示一次（0.6.64）：接管方 pid 没变就不重复说（重试周期里
        // reportProblem 自己的 lastProblem 节流也只覆盖本进程）。
        const standby =
          `远程控制由另一个 Muse Code 进程（pid ${String(info?.pid ?? 0)}）接管，本进程待命`
        if (bootNoticeOnce('remote.standby', standby)) reportProblem(standby)
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
      clearEscalation()
      clearRetry()
      stopServer()
      owner.release()
    })

    applyPrefs()
  },
}
