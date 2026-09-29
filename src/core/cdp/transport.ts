/**
 * CDP（Chrome DevTools Protocol）消息层：连接、命令应答、事件分发、session 路由。
 *
 * 为什么单独一层：`examples/plugins/browser-control.js` 那种写法只有「id 配对 + pending Map」，
 * 收帧时但凡没有 id 就整条丢掉——对话框（`Page.javascriptDialogOpening`）、
 * 控制台（`Runtime.consoleAPICalled`）、网络（`Network.responseReceived`）、
 * 页面跳转（`Page.frameNavigated`）全都是**没有 id 的事件**，靠那条路一个都拿不到，
 * 于是「页面弹了确认框」这件事模型永远不知道，动作会一直卡到超时。
 * 这里把事件订阅补上，并且显式分成两级：
 *   - 浏览器级连接（`--remote-debugging-port` 直连的那个 WebSocket）：管 Target 域，
 *     事件不带 `sessionId`；
 *   - 页面/框架级 session（`Target.attachToTarget { flatten: true }` 拿到的 sessionId）：
 *     管 Page/Runtime/DOM/Accessibility 域，事件带 `sessionId`。
 * 两者复用同一条 WebSocket，靠 `sessionId` 字段区分——这正是本层必须做的事：
 * 发命令时按 session 打标，收应答时核对 sessionId，收事件时按 sessionId 投递。
 *
 * 不引第三方包：WebSocket 用 Node 内置全局（Node ≥ 22.19 有）。
 *
 * @module dsc/core/cdp/transport
 */

/** CDP 帧的应答部分。 */
interface CdpResponseFrame {
  id?: number
  sessionId?: string
  result?: unknown
  error?: { code?: number; message?: string; data?: string }
}

/** 收到的一条 CDP 事件（没有 id 的帧）。 */
export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  /** undefined = 浏览器级事件；否则是某个页面/框架 session 的事件。 */
  sessionId: string | undefined
}

/** 事件处理器：第二参带 sessionId，方便只关心某一页的调用方自己过滤。 */
export type CdpEventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void

/**
 * 我们用到的那部分 WebSocket 形状。
 * 刻意不写 `declare global` 引用 Node 的 WebSocket 类型：内置 WebSocket 的
 * 环境类型随 Node 小版本变过，这里只声明自己用到的四个回调，运行时缺了就在
 * {@link CdpTransport.open} 里报一句人话。
 */
export interface CdpSocket {
  readyState: number
  send(data: string): void
  close(): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** 一条命令的可选参数。 */
export interface CdpCommandOptions {
  /** 目标 session；不给 = 浏览器级命令（Target 域）。 */
  sessionId?: string
  /** 超时毫秒；<= 0 表示不设超时。 */
  timeoutMs?: number
  /** 取消信号（用户打断时用来立刻结束等待）。 */
  signal?: AbortSignal
}

/** 传输层构造参数。 */
export interface CdpTransportOptions {
  /** 单条命令的默认超时（缺省 20s：导航、录音这类命令本来就慢）。 */
  defaultTimeoutMs?: number
  /** 建连超时（缺省 10s）。 */
  openTimeoutMs?: number
  /** 假 socket 注入点（自检用）；缺省用 Node 内置 WebSocket。 */
  socketFactory?: (url: string) => CdpSocket
  /** 出错信息里的标签，例如「浏览器级」/「页面」；只影响可读性。 */
  label?: string
}

/** 已经在等应答的一条命令。 */
interface PendingCommand {
  method: string
  sessionId: string | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  settle: (error: Error | null, value?: unknown) => void
}

const DEFAULT_TIMEOUT_MS = 20_000
const OPEN_TIMEOUT_MS = 10_000

/**
 * 一条 CDP 连接。
 *
 * 生命周期：{@link CdpTransport.open} 建连 → `send` 发命令 / `on` 订事件 → `close` 收尾。
 * 连接断开后本对象不可复用（要重连就新建一个），断线时所有挂着的命令会立刻被拒——
 * 等 20 秒超时再报错会让人以为是页面慢，其实是连接没了。
 */
export class CdpTransport {
  private readonly socket: CdpSocket
  private readonly defaultTimeoutMs: number
  private readonly label: string
  private readonly pending = new Map<number, PendingCommand>()
  private readonly handlers = new Map<string, Set<CdpEventHandler>>()
  private readonly anyHandlers = new Set<(event: CdpEvent) => void>()
  private readonly closeHandlers = new Set<(reason: string) => void>()
  private nextId = 1
  private closedFlag = false
  /** 断开原因：给重连逻辑判断「是浏览器死了还是我们主动关的」。 */
  private closeReason = ''

  private constructor(socket: CdpSocket, options: CdpTransportOptions) {
    this.socket = socket
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.label = options.label ?? 'CDP'
  }

  /**
   * 连上一个 WebSocket 端点并等握手完成。
   *
   * @param url - CDP 端点（`ws://127.0.0.1:PORT/devtools/browser/<uuid>`）。
   * @param options - 见 {@link CdpTransportOptions}。
   * @param signal - 取消信号：用户在握手期间按打断时立刻失败。
   */
  static async open(url: string, options: CdpTransportOptions = {}, signal?: AbortSignal): Promise<CdpTransport> {
    const factory = options.socketFactory ?? builtinWebSocketFactory()
    const socket = factory(url)
    const openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error: Error | null): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        if (error === null) resolve()
        else reject(error)
      }
      const onAbort = (): void => {
        try {
          socket.close()
        } catch {
          // 关不掉就算了，反正这次连接不要了
        }
        finish(new Error(`${options.label ?? 'CDP'} 建连被取消`))
      }
      const timer = openTimeoutMs > 0
        ? setTimeout(() => finish(new Error(`${options.label ?? 'CDP'} 建连超时（${openTimeoutMs}ms）：${url}`)), openTimeoutMs)
        : undefined
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      socket.onopen = () => finish(null)
      socket.onerror = () => finish(new Error(`${options.label ?? 'CDP'} 建连失败：${url}（浏览器没在监听这个端口，或它已经退出）`))
      socket.onclose = () => finish(new Error(`${options.label ?? 'CDP'} 建连被关闭：${url}`))
    })
    const transport = new CdpTransport(socket, options)
    socket.onopen = null
    socket.onerror = null
    socket.onmessage = (event) => {
      transport.acceptFrame(event.data)
    }
    socket.onclose = (event) => {
      transport.handleClose(describeCloseEvent(event))
    }
    return transport
  }

  /** 这条连接是不是已经断了（断了就不能再发命令）。 */
  get closed(): boolean {
    return this.closedFlag
  }

  /** 断开原因（我们主动关的是「主动关闭」，否则是底层给的原文）。 */
  get reason(): string {
    return this.closeReason
  }

  /** 还挂着等应答的命令条数（诊断与自检用）。 */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * 发一条命令并等它的应答。
   *
   * @param method - CDP 方法名，例如 `Page.navigate`。
   * @param params - 参数对象（缺省空对象）。
   * @param options - sessionId / 超时 / 取消信号。
   */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, options: CdpCommandOptions = {}): Promise<T> {
    if (this.closedFlag) {
      const why = this.closeReason === '' ? '连接已关闭' : this.closeReason
      return Promise.reject(new Error(`${this.label} 连接不可用（${why}），无法执行 ${method}`))
    }
    const id = this.nextId
    this.nextId += 1
    const sessionId = options.sessionId
    const frame: Record<string, unknown> = { id, method, params }
    if (sessionId !== undefined) frame.sessionId = sessionId
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    return new Promise<T>((resolve, reject) => {
      const settle = (error: Error | null, value?: unknown): void => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        if (entry.signal !== undefined && entry.onAbort !== undefined) {
          entry.signal.removeEventListener('abort', entry.onAbort)
        }
        if (error === null) resolve(value as T)
        else reject(error)
      }
      const signal = options.signal
      let onAbort: (() => void) | undefined
      if (signal !== undefined) {
        onAbort = () => settle(new Error(`CDP 命令被取消：${method}`))
      }
      const timer = timeoutMs > 0
        ? setTimeout(() => settle(new Error(`CDP 命令超时（${timeoutMs}ms）：${method}`)), timeoutMs)
        : undefined
      this.pending.set(id, { method, sessionId, timer, signal, onAbort, settle })
      if (signal !== undefined) {
        if (signal.aborted) {
          settle(new Error(`CDP 命令被取消：${method}`))
          return
        }
        signal.addEventListener('abort', onAbort!, { once: true })
      }
      try {
        this.socket.send(JSON.stringify(frame))
      } catch (error) {
        settle(new Error(`CDP 命令发不出去（${method}）：${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  /**
   * 订一条事件。返回退订函数。
   *
   * @param method - 事件名，例如 `Page.javascriptDialogOpening`。
   * @param handler - 收到时调用；参数是事件 params，第二参是 sessionId。
   */
  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.handlers.get(method)
    if (set === undefined) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(handler)
    return () => {
      const current = this.handlers.get(method)
      if (current === undefined) return
      current.delete(handler)
      if (current.size === 0) this.handlers.delete(method)
    }
  }

  /** 订「全部事件」（调试与自检用）。返回退订函数。 */
  onAny(handler: (event: CdpEvent) => void): () => void {
    this.anyHandlers.add(handler)
    return () => {
      this.anyHandlers.delete(handler)
    }
  }

  /**
   * 订「连接断了」。返回退订函数。
   * 崩溃重连靠它：浏览器被杀、页面被关、CDP 主动断，都会走到这里。
   */
  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler)
    return () => {
      this.closeHandlers.delete(handler)
    }
  }

  /** 主动关闭：挂着的命令会以「连接已关闭」被拒。 */
  close(): void {
    if (this.closedFlag) return
    this.handleClose('主动关闭')
    try {
      this.socket.close()
    } catch {
      // socket 已经烂了，忽略
    }
  }

  /** 取某个 session 的视图（命令自动带 sessionId，事件按 sessionId 过滤）。 */
  session(sessionId: string): CdpSessionView {
    return new CdpSessionView(this, sessionId)
  }

  /** 收帧：先看是不是应答，再看是不是事件。 */
  private acceptFrame(raw: unknown): void {
    if (typeof raw !== 'string') return
    let frame: CdpResponseFrame & { method?: string; params?: Record<string, unknown> }
    try {
      frame = JSON.parse(raw) as typeof frame
    } catch {
      return // 非 JSON 帧（协议说不会有，真出现了也别把连接搞崩）
    }
    if (frame.id !== undefined) {
      this.deliverResponse(frame)
      return
    }
    if (typeof frame.method === 'string') {
      const event: CdpEvent = {
        method: frame.method,
        params: frame.params ?? {},
        sessionId: frame.sessionId,
      }
      for (const handler of this.handlers.get(event.method) ?? []) runHandler(handler, event)
      for (const handler of this.anyHandlers) {
        try {
          handler(event)
        } catch {
          // 订阅者自己炸了不该影响别的订阅者
        }
      }
    }
  }

  /** 应答投递：核对 sessionId（发出了带 session 的命令，应答也必须带同一个 session）。 */
  private deliverResponse(frame: CdpResponseFrame): void {
    const entry = this.pending.get(frame.id!)
    if (entry === undefined) return // 超时后迟到的应答：丢掉
    if ((frame.sessionId ?? undefined) !== entry.sessionId) {
      entry.settle(
        new Error(
          `CDP 应答的会话不匹配（${entry.method}：发出时 ${entry.sessionId ?? '浏览器级'}，` +
            `应答 ${frame.sessionId ?? '浏览器级'}）`,
        ),
      )
      return
    }
    if (frame.error !== undefined) {
      const data = frame.error.data === undefined ? '' : `（${frame.error.data}）`
      entry.settle(new Error(`CDP ${entry.method} 失败：${frame.error.message ?? '未知错误'}${data}`))
      return
    }
    entry.settle(null, frame.result ?? {})
  }

  /** 断开：先给挂着的命令一个明确死因，再通知重连方。 */
  private handleClose(reason: string): void {
    if (this.closedFlag) return
    this.closedFlag = true
    this.closeReason = reason
    // 不要在这里先 delete：settle 自己负责从表里摘掉这一条，
    // 先删会让 settle 以为「已经结清了」而直接返回，挂着的命令就永远不落地。
    for (const entry of [...this.pending.values()]) {
      entry.settle(new Error(`${this.label} 连接已断开（${reason}），${entry.method} 没有拿到应答`))
    }
    for (const handler of [...this.closeHandlers]) {
      try {
        handler(reason)
      } catch {
        // 重连方自己炸了不影响别人
      }
    }
  }
}

/** 一个 session 上的便利视图：省得每次发命令都手写 sessionId。 */
export class CdpSessionView {
  readonly sessionId: string
  private readonly transport: CdpTransport

  constructor(transport: CdpTransport, sessionId: string) {
    this.transport = transport
    this.sessionId = sessionId
  }

  /** 发一条属于这个 session 的命令。 */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, options: Omit<CdpCommandOptions, 'sessionId'> = {}): Promise<T> {
    return this.transport.send<T>(method, params, { ...options, sessionId: this.sessionId })
  }

  /** 订这个 session 的事件（浏览器级事件不会投到这里）。返回退订函数。 */
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    return this.transport.on(method, (params, sessionId) => {
      if (sessionId !== this.sessionId) return
      handler(params)
    })
  }

  /** 这条 session 所在的连接（重连判断与关浏览器时要用）。 */
  get connection(): CdpTransport {
    return this.transport
  }
}

/** 事件处理器抛错不该掀翻收帧循环。 */
function runHandler(handler: CdpEventHandler, event: CdpEvent): void {
  try {
    handler(event.params, event.sessionId)
  } catch {
    // 单个订阅者出错只丢这一条
  }
}

/** 从 CloseEvent 里抠出一句能看的死因。 */
function describeCloseEvent(event: unknown): string {
  if (event !== null && typeof event === 'object') {
    const record = event as { code?: unknown; reason?: unknown }
    const code = typeof record.code === 'number' ? record.code : undefined
    const reason = typeof record.reason === 'string' && record.reason !== '' ? record.reason : undefined
    if (code !== undefined || reason !== undefined) {
      return `对端关闭（code=${code ?? '?'}${reason === undefined ? '' : `，${reason}`}）`
    }
  }
  return '连接被关闭'
}

/** 取 Node 内置 WebSocket；没有就报一句能照做的错。 */
function builtinWebSocketFactory(): (url: string) => CdpSocket {
  const globalSocket = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket
  if (typeof globalSocket !== 'function') {
    return () => {
      throw new Error('当前 Node 没有内置 WebSocket（需要 Node ≥ 22.19）；请升级 Node 后再用浏览器自动化')
    }
  }
  return (url: string) => new globalSocket(url) as CdpSocket
}
