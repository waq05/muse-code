/**
 * 遥控端与宿主之间的那一条 WebSocket：取票据 → 连接 → 收快照 → 调方法 → 断了自动重连。
 *
 * 为什么不用 React 状态直接管连接：连接的生命周期比组件长（切页面、锁屏、软键盘弹起
 * 都不该断），所以状态放在这个与 React 无关的类里，界面用 useSyncExternalStore 订阅。
 *
 * 协议（批 A 的宿主插件）：
 *   上行  {type:'invoke', id, method, args?}
 *   下行  {type:'hello', ...} / {type:'snapshot', seq, cwd, sessionId, ...}
 *         {type:'result', id, ok|error} / {type:'ui', method:'open-picker'} / {type:'turn', ...}
 *
 * 断线重连策略：重新 POST /api/ticket 换一张新票据 → 新 WS → 首发快照重建整个视图。
 * 不做增量补发——快照是全量的，重建比对齐便宜。
 */

import { ApiError, baseUrl, fetchTicket, wsUrl } from './api.js'
import { allEntries, normalizeSnapshot, normalizeSessions } from './protocol.js'
import type { RemoteSnapshot, SessionSummary } from './types.js'
import { asSingleValue, encodeArgs } from './wire.js'

/** 连接状态。idle = 还没启动；reconnecting = 断了，正在退避等待。 */
export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface ClientState {
  conn: ConnState
  /** 连续失败次数（成功打开一次即清零），用来显示「第 N 次重连」与算退避。 */
  attempt: number
  /** 下一次自动重连的时刻（epoch ms）；null = 没有排期。 */
  retryAt: number | null
  /** 每次 WS 成功打开自增：界面拿它当「重新拉一次会话列表」的信号。 */
  epoch: number
  snapshot: RemoteSnapshot | null
  /** hello 消息原文（宿主版本、工作目录之类，界面只用来兜底显示）。 */
  server: Record<string, unknown> | null
  /** 最近一次失败的原因（人话），连接正常时为 null。 */
  lastError: string | null
  /** 当前这一轮在跑（决定「排队中」提示与「打断」按钮）。 */
  busy: boolean
  /** 打断已发出、还没看到轮次结束或快照变化。 */
  stopping: boolean
  /** 宿主要求界面打开某个选择器（`{type:'ui', method:'open-picker'}`）。 */
  uiRequest: { method: string; at: number } | null
  /** token 被吊销或过期（HTTP 401/403）：App 据此清凭据、退回登录页。 */
  unauthorized: boolean
}

/** 退避：1s 起，每次翻倍，30s 封顶（另加 ±20% 抖动，避免多设备同时重连撞在一起）。 */
const BACKOFF_START_MS = 1000
const BACKOFF_MAX_MS = 30_000
/** 单次 invoke 的等待上限：超过就当这次调用失败（宿主侧没有响应）。 */
const INVOKE_TIMEOUT_MS = 60_000
/** 「这一轮在跑」的乐观判定上限：没有 status.turnState 时，超过这个时间就不再算在跑。 */
const BUSY_HINT_TTL_MS = 180_000
/** 打断后等宿主确认的上限；超时就先把按钮恢复，避免一直卡在「正在停止…」。 */
const STOPPING_TTL_MS = 30_000

/**
 * 读取类方法：这类调用没有副作用，参数编码猜错时可以安全地换一种再试一次。
 * 其余方法（submit / 审批 / 归档……）绝不重试，避免发两遍。
 */
const READ_ONLY_METHODS = new Set([
  'refreshSessions',
  'listModels',
  'listSkills',
  'listPlugins',
  'getUiPrefs',
  'getSettingsSections',
  'getSectionValues',
  'usageStats',
  'listArchivedSessions',
  'peekTranscript',
  'listUserMessages',
])

/** 参数编码猜错的错误文案特征（宿主报「参数不对」时换一种编码重试）。 */
const ARG_SHAPE_ERROR = /(args|参数|实参|形参|argument|not iterable|is not a function|spread)/i

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: number
}

function backoffDelay(attempt: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, attempt - 1))
  const jitter = base * 0.2 * (Math.random() * 2 - 1)
  return Math.max(250, Math.round(base + jitter))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export interface RemoteClientOptions {
  /** 已配对的设备 token。 */
  token: string
  /** 授权失效时回调（App 用它清凭据）；不传则只置 state.unauthorized。 */
  onUnauthorized?: () => void
}

export class RemoteClient {
  private readonly base = baseUrl()
  private readonly token: string
  private readonly onUnauthorized: (() => void) | undefined

  private listeners = new Set<() => void>()
  private state: ClientState = {
    conn: 'idle',
    attempt: 0,
    retryAt: null,
    epoch: 0,
    snapshot: null,
    server: null,
    lastError: null,
    busy: false,
    stopping: false,
    uiRequest: null,
    unauthorized: false,
  }

  private socket: WebSocket | null = null
  private reconnectTimer: number | null = null
  private stoppingTimer: number | null = null
  private busyTimer: number | null = null
  private pending = new Map<string, Pending>()
  private nextId = 1
  private lastSeq = -1
  /** 投递 submit 那一刻的快照 seq：用来识别「快照还没更新」的陈旧 idle。 */
  private seqAtSubmit: number | null = null
  private busySince = 0
  private stopped = false

  constructor(options: RemoteClientOptions) {
    this.token = options.token
    this.onUnauthorized = options.onUnauthorized
  }

  // ── 订阅 ─────────────────────────────────────────────────────────────────

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getState = (): ClientState => this.state

  private patch(next: Partial<ClientState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────────

  start(): void {
    // stop() 之后再 start() 也要能连上（React 严格模式下开发时会把 effect 跑两遍）。
    this.stopped = false
    if (this.state.conn === 'open' || this.state.conn === 'connecting') return
    void this.openSocket()
  }

  /** 手动重试：清掉退避，立刻再连一次。 */
  retryNow(): void {
    this.clearReconnectTimer()
    this.closeSocket()
    this.patch({ attempt: 0, retryAt: null })
    void this.openSocket()
  }

  stop(): void {
    this.stopped = true
    this.clearReconnectTimer()
    this.clearStoppingTimer()
    this.clearBusyTimer()
    this.closeSocket()
    this.failAllPending('连接已关闭')
    this.patch({ conn: 'closed', retryAt: null })
  }

  /**
   * 关掉当前 socket 并把 this.socket 置空。
   *
   * 顺序很讲究：**先置空再 close**。close 会同步触发 close 监听器，那里靠
   * `this.socket !== socket` 判断「这次关闭是不是我造成的」，置空之后它就安静退出，
   * 不会又排一次重连；反过来先 close 再置空就会排两次（并且 detach 之后
   * `this.socket` 已是 null，再去调 .close() 会直接抛空指针）。
   */
  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    if (socket !== null) socket.close()
  }

  private async openSocket(): Promise<void> {
    if (this.stopped) return
    if (this.socket !== null) return
    this.patch({ conn: this.state.attempt > 0 ? 'reconnecting' : 'connecting' })
    let ticket: string
    try {
      ticket = await fetchTicket(this.base, this.token)
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.patch({ conn: 'closed', lastError: '登录已失效，请重新配对设备', unauthorized: true })
        this.onUnauthorized?.()
        return
      }
      this.scheduleReconnect(errorMessage(error))
      return
    }
    if (this.stopped) return

    let socket: WebSocket
    try {
      socket = new WebSocket(wsUrl(this.base, ticket))
    } catch (error) {
      this.scheduleReconnect(errorMessage(error))
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      this.patch({ conn: 'open', attempt: 0, retryAt: null, lastError: null, epoch: this.state.epoch + 1 })
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(event.data)
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      // 连接断掉时快照还在，界面继续显示旧内容 + 顶部细条提示，不白屏。
      this.failAllPending('连接断开')
      this.scheduleReconnect('连接断开')
    })
    socket.addEventListener('error', () => {
      // error 之后浏览器必定跟一个 close，重连排期交给 close 那一条，避免排两次。
    })
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return
    const attempt = this.state.attempt + 1
    const delay = backoffDelay(attempt)
    this.clearReconnectTimer()
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.openSocket()
    }, delay)
    this.patch({
      conn: 'reconnecting',
      attempt,
      retryAt: Date.now() + delay,
      lastError: reason,
    })
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  // ── 收消息 ───────────────────────────────────────────────────────────────

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const message = parsed as Record<string, unknown>
    const type = typeof message['type'] === 'string' ? (message['type'] as string) : ''

    switch (type) {
      case 'hello':
        this.patch({ server: message })
        return
      case 'snapshot':
        this.handleSnapshot(message)
        return
      case 'result':
        this.handleResult(message)
        return
      case 'ui': {
        const method = typeof message['method'] === 'string' ? (message['method'] as string) : ''
        this.patch({ uiRequest: { method, at: Date.now() } })
        return
      }
      default:
        // 轮次起止这类消息按「出现 end 就算本轮结束」的宽松口径认，认不出就忽略。
        if (type.includes('turn') && /end|done|stop|finish|idle/i.test(type)) {
          this.finishStopping()
          this.setBusy(false)
        }
        return
    }
  }

  private handleSnapshot(message: Record<string, unknown>): void {
    const snapshot = normalizeSnapshot(message)
    if (snapshot === null) return
    // seq 单调：迟到的旧快照直接丢，避免视图被回滚。
    if (typeof message['seq'] === 'number' && snapshot.seq < this.lastSeq) return
    this.lastSeq = snapshot.seq
    this.finishStopping()
    this.patch({ snapshot })
    this.recomputeBusy(snapshot, message)
  }

  private handleResult(message: Record<string, unknown>): void {
    const id = message['id']
    const key = typeof id === 'string' || typeof id === 'number' ? String(id) : null
    if (key === null) return
    const entry = this.pending.get(key)
    if (entry === undefined) return
    this.pending.delete(key)
    window.clearTimeout(entry.timer)

    const error = message['error']
    if (error !== undefined && error !== null) {
      entry.reject(new Error(typeof error === 'string' ? error : JSON.stringify(error)))
      return
    }
    const ok = message['ok']
    const result = message['result']
    if (result !== undefined) entry.resolve(result)
    else if (ok !== undefined) entry.resolve(ok)
    else entry.resolve(null)
  }

  // ── 轮次状态 ─────────────────────────────────────────────────────────────

  /**
   * 判断「这一轮还在跑」：
   *   1. 快照带 status.turnState 时以它为准（唯一权威口径）；
   *   2. 刚投递 submit、宿主还没推新快照时，不能用同一份旧快照的 idle 把它判掉；
   *   3. 完全没有 status 字段时退回「证据法」：投递过 submit（三分钟内）、
   *      最后一条是没答完的用户消息、或最后一张工具卡还在 running。
   */
  private recomputeBusy(snapshot: RemoteSnapshot, raw: Record<string, unknown>): void {
    const statusRaw = raw['status']
    const turnState =
      typeof statusRaw === 'object' && statusRaw !== null
        ? (statusRaw as Record<string, unknown>)['turnState']
        : undefined
    if (typeof turnState === 'string') {
      if (turnState !== 'idle') {
        this.setBusy(true)
        return
      }
      // 陈旧判定的保护：这次快照就是投递 submit 时那一份，idle 不能说明什么。
      if (this.seqAtSubmit !== null && snapshot.seq === this.seqAtSubmit) return
      this.setBusy(false)
      return
    }
    // 没有 status.turnState：只能靠证据推。证据说不忙时，只在「刚投递 submit、
    // 快照还没换过」这一种情况下保留在跑；换了新快照就按证据走，
    // 免得一次乐观判定把界面永久锁在「排队中」。
    const inferred = this.inferBusy(snapshot)
    if (!inferred && this.seqAtSubmit !== null && snapshot.seq === this.seqAtSubmit) return
    this.setBusy(inferred)
  }

  private inferBusy(snapshot: RemoteSnapshot): boolean {
    if (snapshot.surfaces.pendingApproval !== null) return true
    const entries = allEntries(snapshot)
    const last = entries[entries.length - 1]
    if (last === undefined) return false
    if (last.kind === 'tool') return last.call.status === 'running'
    // 用户消息之后什么都没有：要么在跑，要么这一轮被打断了——没有确证就不猜，
    // 只在「刚投递过 submit」的窗口内算在跑（由 busySince 的 TTL 兜住）。
    if (last.kind === 'user') return Date.now() - this.busySince <= BUSY_HINT_TTL_MS
    return false
  }

  private setBusy(busy: boolean): void {
    if (busy === this.state.busy) return
    if (busy) {
      this.busySince = Date.now()
      this.clearBusyTimer()
      this.busyTimer = window.setTimeout(() => {
        // 没有任何权威口径又迟迟没有变化：不再显示「排队中」，避免永久卡住。
        this.busyTimer = null
        if (this.seqAtSubmit === null) this.setBusy(false)
      }, BUSY_HINT_TTL_MS)
    } else {
      this.seqAtSubmit = null
      this.clearBusyTimer()
    }
    this.patch({ busy })
  }

  private clearBusyTimer(): void {
    if (this.busyTimer !== null) {
      window.clearTimeout(this.busyTimer)
      this.busyTimer = null
    }
  }

  /** 快照变化或收到 turn-end：打断的等待结束。 */
  private finishStopping(): void {
    this.clearStoppingTimer()
    if (this.state.stopping) this.patch({ stopping: false })
  }

  private clearStoppingTimer(): void {
    if (this.stoppingTimer !== null) {
      window.clearTimeout(this.stoppingTimer)
      this.stoppingTimer = null
    }
  }

  // ── 发方法 ─────────────────────────────────────────────────────────────

  /**
   * 调用宿主开放的一个方法。
   *
   * 参数编码见 wire.ts（唯一可改的一处）。万一宿主按另一种编码解，读取类方法
   * （READ_ONLY_METHODS，没有副作用）会自动换一种再试一次；有副作用的方法绝不重试，
   * 免得 submit / 审批被发两遍。
   */
  async invoke<T = unknown>(method: string, args: readonly unknown[] = []): Promise<T> {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('连接未就绪，等重连完成再试')
    }
    try {
      return (await this.send(method, encodeArgs(method, args))) as T
    } catch (error) {
      const message = errorMessage(error)
      if (!READ_ONLY_METHODS.has(method) || !ARG_SHAPE_ERROR.test(message)) throw error
      return (await this.send(method, asSingleValue(method, args))) as T
    }
  }

  private send(method: string, fields: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('连接未就绪，等重连完成再试'))
    }
    // id 用数字：宿主既有的 invoke 消息就是 `{type:'invoke'; id: number; ...}`
    // （src/plugins/host-stdio.ts），数字 id 原样回显，兼容面最宽。
    const id = this.nextId
    this.nextId += 1
    const key = String(id)
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(key)
        reject(new Error(`${method} 超时（${Math.round(INVOKE_TIMEOUT_MS / 1000)} 秒没有回应）`))
      }, INVOKE_TIMEOUT_MS)
      this.pending.set(key, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ type: 'invoke', id, method, ...fields }))
      } catch (error) {
        this.pending.delete(key)
        window.clearTimeout(timer)
        reject(new Error(errorMessage(error)))
      }
    })
  }

  private failAllPending(reason: string): void {
    for (const [, entry] of this.pending) {
      window.clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.pending.clear()
  }

  // ── 界面动作（薄封装，语义写在一处） ──────────────────────────────────────

  /** 发消息。core 是排队语义：轮次运行中投递 = 排到当前轮之后。 */
  async submit(text: string, images?: string[]): Promise<void> {
    this.seqAtSubmit = this.state.snapshot?.seq ?? null
    this.setBusy(true)
    try {
      await this.invoke('submit', images !== undefined && images.length > 0 ? [text, images] : [text])
    } catch (error) {
      this.seqAtSubmit = null
      this.setBusy(false)
      throw error
    }
  }

  /** 打断当前轮：成功后按钮进「正在停止…」，直到快照变化或 turn-end。 */
  async interrupt(): Promise<void> {
    await this.invoke('interrupt', [])
    this.patch({ stopping: true })
    this.clearStoppingTimer()
    this.stoppingTimer = window.setTimeout(() => {
      this.stoppingTimer = null
      this.patch({ stopping: false })
    }, STOPPING_TTL_MS)
  }

  /** 拉会话列表；宿主同时会把结果写进快照，所以这里也用返回值兜底。 */
  async refreshSessions(): Promise<SessionSummary[]> {
    const result = await this.invoke<unknown>('refreshSessions', [])
    return normalizeSessions(result)
  }

  /** 切换桌面正在看的会话（会改变桌面端视图，界面里有明确提示）。 */
  async openSession(id?: string): Promise<void> {
    await this.invoke('openSession', id === undefined ? [] : [id])
  }

  /** 清掉宿主要求界面做的动作（例如 open-picker 已经照做）。 */
  acknowledgeUiRequest(): void {
    if (this.state.uiRequest !== null) this.patch({ uiRequest: null })
  }
}
