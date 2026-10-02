/**
 * LSP 客户端：一个 (服务器, 项目根) 一个进程，外加该根的**串行队列**。
 *
 * ## 三个关键决定（都有教训在后面）
 *
 * 1. **文档同步走无状态路线**：每次查询「读盘 → `didOpen`（全量文本）→ 请求 → `didClose`」，
 *    没有 `didChange`、不缓存文档。代价是每次多两个通知；换来的是**天然没有脏文档**——
 *    模型刚用 `write`/`edit` 改完文件，语言服务器看到的必然是磁盘上那一刻的内容，
 *    不存在「服务器手里还是旧版本，诊断和定位全是幽灵」这一类 bug（hermes 在
 *    `client.py` 顶部专门记过这个坑）。同一个 uri 的 `didOpen` 版本号单调递增，
 *    这样上一轮迟到的 `publishDiagnostics` 能被认出来丢掉。
 *
 * 2. **握手只声明 utf-16**：`general.positionEncodings: ['utf-16']`。服务器回了别的编码
 *    （`utf-8` / `utf-32`）就直接失败——列偏移的算法完全不同（见 `uri.ts` 的模块注释），
 *    悄悄按 utf-16 算只会把列定位错到别处。也不声明任何动态注册：本客户端不会处理
 *    `client/registerCapability` 之后的方法，声明了就是给自己挖坑。
 *
 * 3. **取消是「先礼后兵」**：请求超时或调用方中止时先发 `$/cancelRequest`；服务器不理会
 *    （宽限期后请求还挂着）就**杀掉整个实例**。因为那个请求还在服务器里跑，它随时会吐
 *    `publishDiagnostics` 或占着文档生命周期，留着它下一次查询的结果就说不清是谁的。
 *
 * 实例的池化与调度（idle 回收、串行队列、破键退避）在同目录 `manager.ts`；应答归并的
 * 纯函数在 `normalize.ts`，诊断的行号对齐在 `line-shift.ts`——本文件只留「一个连接怎么
 * 说话」：spawn、握手、JSON-RPC、请求超时取消、无状态文档生命周期。
 *
 * @module dsc/core/lsp/client
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  MAX_MESSAGE_BYTES,
  MAX_STDERR_TAIL_BYTES,
  MessageDecoder,
  StderrTail,
  encodeMessage,
} from './framing.js'
import { asRecord, normalizeDiagnostics, normalizeHover, normalizeLocations } from './normalize.js'
import { type LspServerDef, languageIdFor } from './servers.js'
import { type LspPosition, type LspRange, pathToUri } from './uri.js'

// ── 对外类型 ─────────────────────────────────────────────────────────────────

/** 工具暴露的四个操作。 */
export type LspOperation = 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'

/** 操作清单（工具 schema 的 enum 与自检共用一份）。 */
export const LSP_OPERATIONS: readonly LspOperation[] = [
  'goToDefinition',
  'findReferences',
  'goToImplementation',
  'hover',
]

/** 操作 → LSP 请求方法。 */
const REQUEST_METHOD: Readonly<Record<LspOperation, string>> = {
  goToDefinition: 'textDocument/definition',
  findReferences: 'textDocument/references',
  goToImplementation: 'textDocument/implementation',
  hover: 'textDocument/hover',
}

/** 操作 → 服务器 capabilities 里对应的字段（判定支不支持）。 */
const CAPABILITY_FIELD: Readonly<Record<LspOperation, string>> = {
  goToDefinition: 'definitionProvider',
  findReferences: 'referencesProvider',
  goToImplementation: 'implementationProvider',
  hover: 'hoverProvider',
}

/** 一处位置。 */
export interface LspLocation {
  uri: string
  range: LspRange
}

/** 一条悬停信息（`contents` 已经归并成一段文本）。 */
export interface LspHover {
  contents: string
  range?: LspRange
}

/** 一条诊断（只留渲染要用的字段；位置是零基）。 */
export interface LspDiagnostic {
  /** 1 = ERROR、2 = WARN、3 = INFO、4 = HINT（服务器没给按 ERROR 算）。 */
  severity: number
  message: string
  code?: string
  source?: string
  range: LspRange
}

/** 一次查询的结果：要么有数据，要么有一句人话的原因（**永不抛给模型**）。 */
export type LspQueryOutcome =
  | { ok: true; kind: 'locations'; locations: LspLocation[]; server: string; root: string }
  | { ok: true; kind: 'hover'; hover: LspHover | null; server: string; root: string }
  | { ok: false; reason: string; server?: string; stderr?: string }

/** 一次诊断查询的结果。 */
export type LspDiagnosticsOutcome =
  | { ok: true; diagnostics: LspDiagnostic[]; server: string; root: string }
  | { ok: false; reason: string; server?: string; stderr?: string }

/** 时间预算与退避（都有缺省，只有 idle 由设置控制）。 */
export interface LspRuntimeValues {
  /** 单次 LSP 请求预算（毫秒）。 */
  requestTimeoutMs: number
  /** 握手（spawn + initialize）预算（毫秒）。 */
  initializeTimeoutMs: number
  /** 等诊断的预算（毫秒）。 */
  diagnosticsWaitMs: number
  /** 收到第一条诊断后再等一小会儿，把分几次到的 push 收齐（毫秒）。 */
  pushSettleMs: number
  /** 发出 `$/cancelRequest` 后给服务器的时间；超了就杀实例（毫秒）。 */
  cancelGraceMs: number
  /** 优雅 shutdown/exit 的预算（毫秒）。 */
  shutdownGraceMs: number
  /** 破键退避时长：这段时间内不再重试这个 (服务器, 根)（毫秒）。 */
  brokenRetryMs: number
}

/** 缺省预算。 */
export function defaultRuntimeValues(): LspRuntimeValues {
  return {
    requestTimeoutMs: 60_000,
    initializeTimeoutMs: 30_000,
    diagnosticsWaitMs: 8_000,
    pushSettleMs: 150,
    cancelGraceMs: 1_000,
    shutdownGraceMs: 2_000,
    brokenRetryMs: 5 * 60_000,
  }
}

/** 一个服务器此刻的状态（设置页与 `ctx.get('lsp').status()`）。 */
export interface LspStatusEntry {
  id: string
  command: string
  available: boolean
  /** 已起的实例数（一个项目根一个）。 */
  instances: number
  /** 这些实例服务的项目根。 */
  roots: string[]
  /** 破键还有多少秒解禁；null = 没被记破键。 */
  brokenSeconds: number | null
  /** 破键原因（一句话）。 */
  problem?: string
}

/** 建管理器要给的活配置（每次用值时现取，改配置不必重启宿主）。 */
export interface LspManagerOptions {
  /** 现在生效的服务器表。 */
  servers(): readonly LspServerDef[]
  /** idle 回收时长（毫秒）。 */
  idleTimeoutMs(): number
  /** 覆盖几个时间预算（自检里把等待压到毫秒级）。 */
  values?(): Partial<LspRuntimeValues>
  /** 覆盖子进程环境（自检注入用；缺省走白名单）。 */
  env?(): Record<string, string>
}

/** 查询/启动失败的分类：`fatal` 为真说明实例已经不能用了，要杀掉并按破键退避。 */
export class LspQueryError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
    readonly stderr?: string,
  ) {
    super(message)
    this.name = 'LspQueryError'
  }
}

// ── 一条连接（进程 + 分帧 + JSON-RPC 结账）────────────────────────────────────

/** 一条挂着的请求。 */
interface PendingRequest {
  method: string
  /** 幂等闸门：批量结账（fail）与单条应答（settleResponse）可能先后到达，只许第一次生效。 */
  settled: boolean
  settle(error: Error | null, value?: unknown): void
}

/** 连一条语言服务器进程需要的全部东西。 */
interface ConnectionOptions {
  server: LspServerDef
  /** 已解析的可执行文件与要不要经 shell。 */
  target: { file: string; shell: boolean }
  root: string
  /** 子进程环境（白名单筛过的）。 */
  env: Record<string, string>
  killGraceMs: number
  /** 进程掉了的回调（管理器的槽就是靠它清的）。 */
  onExit(reason: string): void
}

/** 一个 `textDocument/publishDiagnostics` 的载荷。 */
interface PublishDiagnostics {
  uri: string
  version: number | undefined
  items: LspDiagnostic[]
}

/**
 * 一个语言服务器进程上的 JSON-RPC 端点：id 配对、发请求/通知、回服务器的反向请求、
 * 结账与强杀、stderr 尾巴。
 */
class LspConnection {
  private readonly child: ChildProcess
  private readonly decoder = new MessageDecoder(MAX_MESSAGE_BYTES)
  private readonly tail = new StderrTail(MAX_STDERR_TAIL_BYTES)
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  /** 这条连接为什么废了（进程退出、管道写失败、取消没人理会……）。 */
  private closeReason: Error | undefined
  private killTimer: NodeJS.Timeout | undefined
  private exited = false
  private readonly closedPromise: Promise<void>
  private resolveClosed: (() => void) | undefined
  /** 服务器推来的诊断（按 uri 存最近一次）。 */
  private readonly pushes = new Map<string, PublishDiagnostics>()
  private readonly pushListeners = new Set<(push: PublishDiagnostics) => void>()

  constructor(private readonly options: ConnectionOptions) {
    this.closedPromise = new Promise<void>((done) => {
      this.resolveClosed = done
    })
    const args = options.target.shell ? options.server.args.map(quoteForCmd) : options.server.args
    this.child = spawn(options.target.file, args, {
      cwd: options.root,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: options.target.shell,
    })
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.onStdout(chunk)
    })
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.tail.push(chunk)
    })
    this.child.on('error', (error) => {
      this.fail(new Error(`语言服务器进程起不来：${error.message}`))
      this.finish()
    })
    // stdin 出错说明管道断了，紧跟着就是 exit；这里不重复报，交给 exit 那条路。
    this.child.stdin?.on('error', () => {})
    this.child.on('exit', (code, signal) => {
      const tail = this.stderrTail()
      const how = signal ?? (code === null ? '未知' : String(code))
      // 尾巴单独挂在 LspQueryError.stderr 上，不要拼进 message：启动失败的原因由
      // startFailure 按「消息 + stderr 尾巴」组装，并把 stderr 透传给调用方——
      // 拼在 message 里，outcome 就丢了结构化的 stderr 字段，模型看不出为什么起不来。
      this.fail(new LspQueryError(`语言服务器进程退出（${how}）`, true, tail === '' ? undefined : tail))
      this.finish()
    })
  }

  /** 进程退没退（close 事件之后恒为 true）。 */
  get failed(): boolean {
    return this.closeReason !== undefined
  }

  /** 进程已经退出的信号。 */
  get closed(): Promise<void> {
    return this.closedPromise
  }

  /** stderr 末尾 30 行（给模型的降级文案用）。 */
  stderrTail(): string {
    return this.tail.tailLines(30)
  }

  /**
   * 发一条请求等结果。
   *
   * @param method - JSON-RPC 方法。
   * @param params - 参数。
   * @param signal - 调用方的取消信号（工具被中断时用它）。
   * @param timeoutMs - 这次请求的预算。
   */
  request(method: string, params: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
    const id = this.nextId
    this.nextId += 1
    return new Promise<unknown>((resolveValue, rejectValue) => {
      if (this.closeReason !== undefined) {
        rejectValue(this.closeReason)
        return
      }
      const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
      if (signal !== undefined) signals.push(signal)
      const gate = AbortSignal.any(signals)
      let graceTimer: NodeJS.Timeout | undefined
      const onAbort = (): void => {
        if (!this.pending.has(id)) return
        const why =
          signal?.aborted === true
            ? `LSP 请求被取消：${method}`
            : `LSP 请求超过 ${timeoutMs}ms 没回：${method}`
        // 先礼：标准取消通知，认它的服务器会回一个 RequestCancelled 错误响应。
        this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })
        // 后兵：宽限期里还没结账，说明它不理会取消——连实例一起收掉。
        graceTimer = setTimeout(() => {
          if (!this.pending.has(id)) return
          this.fail(new Error(`${why}；服务器没理会 $/cancelRequest，已把这个语言服务器收掉`))
          this.terminate()
        }, this.options.killGraceMs)
        graceTimer.unref()
      }
      const entry: PendingRequest = {
        method,
        settled: false,
        settle: (error, value) => {
          // 幂等闸门必须用本地标记，不能用「表里还有没有这条」：
          // fail() 收掉整个实例时是先清空 pending 再逐个 settle（见下方 fail），
          // 若在这里先 delete 再判返回值，批量结账的每一次都会因为表已空而提前返回，
          // 挂着的请求就永远不落地——事件循环排空，进程直接以 code 13 退出。
          if (entry.settled) return
          entry.settled = true
          this.pending.delete(id)
          gate.removeEventListener('abort', onAbort)
          if (graceTimer !== undefined) clearTimeout(graceTimer)
          if (error === null) resolveValue(value)
          else rejectValue(error)
        },
      }
      this.pending.set(id, entry)
      if (gate.aborted) {
        onAbort()
        return
      }
      gate.addEventListener('abort', onAbort, { once: true })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** 发一条通知（不等回应）。写失败就按连接废掉处理：后面的请求会以同样的原因失败。 */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** 挂一位诊断监听（用 `didOpen` 打开文档之后才注册，避开上一轮迟到的 push）。 */
  onPush(listener: (push: PublishDiagnostics) => void): () => void {
    this.pushListeners.add(listener)
    return () => {
      this.pushListeners.delete(listener)
    }
  }

  /** 最近一次 push（按 uri）。 */
  latestPush(uri: string): PublishDiagnostics | undefined {
    return this.pushes.get(uri)
  }

  /** 清掉某个 uri 的旧 push（新一轮 didOpen 之前调用）。 */
  forgetPush(uri: string): void {
    this.pushes.delete(uri)
  }

  /** 先 SIGTERM，宽限期内没退就 SIGKILL。幂等。 */
  terminate(): void {
    if (this.exited) return
    const child = this.child
    try {
      if (process.platform === 'win32') child.kill()
      else child.kill('SIGTERM')
    } catch {
      // 已经退了的进程再 kill 会抛，无害
    }
    if (this.exited) return
    this.killTimer = setTimeout(() => {
      if (this.exited) return
      try {
        child.kill('SIGKILL')
      } catch {
        // 同上
      }
    }, this.options.killGraceMs)
    this.killTimer.unref()
  }

  /** 记下致命原因并让所有挂着的请求当场结账。 */
  private fail(error: Error): void {
    if (this.closeReason === undefined) this.closeReason = error
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const entry of waiting) entry.settle(error)
  }

  private finish(): void {
    this.exited = true
    if (this.killTimer !== undefined) {
      clearTimeout(this.killTimer)
      this.killTimer = undefined
    }
    this.pushListeners.clear()
    const reason = this.closeReason?.message ?? '语言服务器进程结束'
    this.options.onExit(reason)
    this.resolveClosed?.()
  }

  private write(message: unknown): void {
    if (this.closeReason !== undefined) return
    const stdin = this.child.stdin
    if (stdin === null || stdin.destroyed) {
      this.fail(new Error('语言服务器的输入口已经关了'))
      return
    }
    let framed: Buffer
    try {
      framed = encodeMessage(message)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    stdin.write(framed, (error) => {
      if (error !== null && error !== undefined) this.fail(new Error(`往语言服务器写消息失败：${error.message}`))
    })
  }

  private onStdout(chunk: Buffer): void {
    let messages: unknown[]
    try {
      messages = this.decoder.push(chunk)
    } catch (error) {
      // 分帧坏了以后流位置就再也对不上了：整条连接按废掉处理，把进程收掉。
      this.fail(error instanceof Error ? error : new Error(String(error)))
      this.terminate()
      return
    }
    for (const message of messages) this.dispatch(message)
  }

  private dispatch(message: unknown): void {
    const frame = asRecord(message)
    if (frame === null) return
    const method = frame.method
    const id = frame.id
    // 服务器发来的请求：得回一个响应，不然它可能一直等。
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      this.answerServerRequest(id, method)
      return
    }
    if (typeof method === 'string') {
      this.onNotification(method, frame.params)
      return
    }
    if (typeof id === 'number') this.settleResponse(id, frame)
  }

  private settleResponse(id: number, frame: Record<string, unknown>): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    const error = asRecord(frame.error)
    if (error !== null) {
      const message = typeof error.message === 'string' ? error.message : '语言服务器报了错'
      const code = typeof error.code === 'number' ? `（code ${error.code}）` : ''
      entry.settle(new Error(`${message}${code}`))
      return
    }
    entry.settle(null, frame.result)
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'textDocument/publishDiagnostics') return
    const doc = asRecord(params)
    const uri = typeof doc?.uri === 'string' ? doc.uri : undefined
    if (uri === undefined) return
    const push: PublishDiagnostics = {
      uri,
      version: typeof doc?.version === 'number' ? doc.version : undefined,
      items: normalizeDiagnostics(doc?.diagnostics),
    }
    this.pushes.set(uri, push)
    for (const listener of [...this.pushListeners]) listener(push)
  }

  /**
   * 回服务器的反向请求。本客户端**不声明动态注册**，所以这里只兜住几个必须应答的方法：
   * 生命周期类回 null，`workspace/configuration` 回一无所知，`workspace/applyEdit` 直接拒
   * （这个宿主从不替用户改文件）。
   */
  private answerServerRequest(id: number | string, method: string): void {
    if (method === 'workspace/applyEdit') {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: '本客户端不允许语言服务器直接改文件' },
      })
      return
    }
    this.write({ jsonrpc: '2.0', id, result: null })
  }
}

/** shell 那条路上参数由 cmd.exe 解析，带空格或元字符的要自己加引号（照 `core/mcp.ts`）。 */
function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

// ── 一个实例（握手 + 无状态文档生命周期）─────────────────────────────────────

/** 正在等的那次诊断：新一轮开始时把上一轮直接掐掉，免得它的回调把这一轮的结果结账。 */
interface DiagnosticWaiter {
  uri: string
  cancel(): void
}

/** 建实例要的全部东西。 */
interface InstanceOptions {
  server: LspServerDef
  root: string
  target: { file: string; shell: boolean }
  env: Record<string, string>
  values: LspRuntimeValues
  onExit(reason: string): void
}

/** 一个已经握过手的语言服务器实例。串行化在管理器那一层（按 key 排队）。 */
export class LspInstance {
  private readonly connection: LspConnection
  private capabilities: Record<string, unknown> = {}
  /** 握手落地（失败就 reject）；管理器等它一次，之后池子里的实例都是握过手的。 */
  readonly ready: Promise<void>
  private disposed = false
  /** 同一个 uri 的 didOpen 版本号：单调递增，用来认掉上一轮迟到的诊断。 */
  private readonly docVersions = new Map<string, number>()
  private waiter: DiagnosticWaiter | undefined

  constructor(private readonly options: InstanceOptions) {
    this.connection = new LspConnection({
      server: options.server,
      target: options.target,
      root: options.root,
      env: options.env,
      killGraceMs: options.values.cancelGraceMs,
      onExit: options.onExit,
    })
    this.ready = this.initialize()
    // 握手失败不能让它在第一个 await 之前变成未处理的 rejection。
    this.ready.catch(() => {})
  }

  /** 进程退没退 / 有没有被废掉。 */
  get dead(): boolean {
    return this.disposed || this.connection.failed
  }

  /** stderr 末尾 30 行（降级文案用）。 */
  stderrTail(): string {
    return this.connection.stderrTail()
  }

  private async initialize(): Promise<void> {
    const result = await this.connection.request(
      'initialize',
      {
        // 不报宿主 PID：进程可能不在同一个命名空间里，报了只会让服务器去监控一个不相干的进程。
        processId: null,
        rootUri: pathToUri(this.options.root),
        workspaceFolders: [{ uri: pathToUri(this.options.root), name: 'workspace' }],
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions: null,
      },
      undefined,
      this.options.values.initializeTimeoutMs,
    )
    const caps = asRecord(asRecord(result)?.capabilities) ?? {}
    // 缺省就是 utf-16；回别的编码直接失败——列偏移算法完全不同，不能将就。
    const encoding = caps.positionEncoding
    if (encoding !== undefined && encoding !== 'utf-16') {
      throw new LspQueryError(
        `服务器要用 ${String(encoding)} 位置编码，本客户端只支持 utf-16（列偏移按 UTF-16 码元算）`,
        true,
        this.connection.stderrTail(),
      )
    }
    this.capabilities = caps
    this.connection.notify('initialized', {})
  }

  /** 等握手落地；调用方的中止与握手超时都要能提前退出。 */
  private async awaitReady(signal: AbortSignal | undefined): Promise<void> {
    if (this.disposed) throw new LspQueryError('这个语言服务器实例已经收掉了', true)
    if (signal === undefined) {
      await this.ready
      return
    }
    if (signal.aborted) throw new LspQueryError('LSP 请求被取消', false)
    await Promise.race([
      this.ready,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new LspQueryError('LSP 请求被取消', true)), { once: true })
      }),
    ])
  }

  /**
   * 跑一次查询：读盘 → didOpen → 请求 → didClose。
   *
   * @param operation - 四个操作之一。
   * @param filePath - 目标文件（绝对路径，调用方已确认存在）。
   * @param position - 零基坐标。
   * @param signal - 调用方的取消信号。
   */
  async query(
    operation: LspOperation,
    filePath: string,
    position: LspPosition,
    signal: AbortSignal | undefined,
  ): Promise<{ kind: 'locations'; locations: LspLocation[] } | { kind: 'hover'; hover: LspHover | null }> {
    await this.awaitReady(signal)
    if (!supportsOperation(this.capabilities, operation)) {
      throw new LspQueryError(
        `${this.options.server.id} 语言服务器没声明支持 ${operation}（capabilities 里没有 ${CAPABILITY_FIELD[operation]}）`,
        false,
      )
    }
    const uri = pathToUri(filePath)
    const text = readText(filePath)
    const version = this.nextVersion(uri)
    this.connection.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: languageIdFor(this.options.server, filePath), version, text },
    })
    try {
      const params: Record<string, unknown> = {
        textDocument: { uri },
        position: { line: position.line, character: position.character },
        // findReferences 一律带上声明：调用方没有开关，影响面分析里「定义处」不能少。
        ...(operation === 'findReferences' ? { context: { includeDeclaration: true } } : {}),
      }
      const payload = await this.connection.request(
        REQUEST_METHOD[operation],
        params,
        signal,
        this.options.values.requestTimeoutMs,
      )
      return operation === 'hover'
        ? { kind: 'hover', hover: normalizeHover(payload) }
        : { kind: 'locations', locations: normalizeLocations(payload) }
    } finally {
      // 已经废掉的连接别再写：didClose 会和正在进行的收尾抢管道。
      if (!this.dead) this.connection.notify('textDocument/didClose', { textDocument: { uri } })
    }
  }

  /**
   * 取一个文件此刻的诊断。
   *
   * 两条路同时走：等 `publishDiagnostics` 推（多数服务器），以及（声明了 `diagnosticProvider`
   * 时）主动 `textDocument/diagnostic` 拉。谁先给出非空结果就用谁，都没有就返回 null
   * ——「服务器还没给结论」和「这个文件没问题」是两件不同的事，不能混。
   *
   * @param filePath - 绝对路径。
   * @param content - 想让它看到的文本；缺省读盘（写前基线就靠这个参数喂写前的内容）。
   * @param signal - 取消信号。
   */
  async diagnostics(
    filePath: string,
    content: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<LspDiagnostic[] | null> {
    await this.awaitReady(signal)
    const uri = pathToUri(filePath)
    const text = content ?? readText(filePath)
    const version = this.nextVersion(uri)
    this.connection.forgetPush(uri)
    this.dropWaiter()
    this.connection.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: languageIdFor(this.options.server, filePath), version, text },
    })
    try {
      const pushed = this.waitForPush(uri, version, signal)
      const pulled = this.supportsPull() ? this.pullDiagnostics(uri, signal) : Promise.resolve(null)
      const items = await firstNonNull([pushed, pulled])
      return items
    } finally {
      this.dropWaiter()
      if (!this.dead) this.connection.notify('textDocument/didClose', { textDocument: { uri } })
    }
  }

  /** 服务器声明了拉模式诊断吗。 */
  private supportsPull(): boolean {
    return this.capabilities.diagnosticProvider !== undefined && this.capabilities.diagnosticProvider !== null
  }

  /** 主动拉一次文档诊断（服务器不支持/报错都当没有，不抛）。 */
  private async pullDiagnostics(uri: string, signal: AbortSignal | undefined): Promise<LspDiagnostic[] | null> {
    try {
      const result = await this.connection.request(
        'textDocument/diagnostic',
        { textDocument: { uri } },
        signal,
        this.options.values.diagnosticsWaitMs,
      )
      const doc = asRecord(result)
      if (doc === null || !Array.isArray(doc.items)) return null
      return normalizeDiagnostics(doc.items)
    } catch {
      return null
    }
  }

  /**
   * 等这个 uri 的 push 诊断：等到第一条之后，再等 `pushSettleMs` 把分几次到的收齐。
   * 版本比这次 didOpen 老的一律丢掉（那是上一轮迟到的推送）。
   */
  private async waitForPush(
    uri: string,
    version: number,
    signal: AbortSignal | undefined,
  ): Promise<LspDiagnostic[] | null> {
    return await new Promise<LspDiagnostic[] | null>((done) => {
      let finished = false
      let settleTimer: NodeJS.Timeout | undefined
      const timeoutTimer = setTimeout(() => finish(null), this.options.values.diagnosticsWaitMs)
      timeoutTimer.unref()
      const finish = (items: LspDiagnostic[] | null): void => {
        if (finished) return
        finished = true
        clearTimeout(timeoutTimer)
        if (settleTimer !== undefined) clearTimeout(settleTimer)
        offPush()
        signal?.removeEventListener('abort', onAbort)
        if (this.waiter?.uri === uri) this.waiter = undefined
        done(items)
      }
      const collect = (): void => {
        if (finished) return
        if (settleTimer !== undefined) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
          const latest = this.connection.latestPush(uri)
          if (latest === undefined) {
            finish(null)
            return
          }
          if (latest.version !== undefined && latest.version < version) {
            finish(null)
            return
          }
          finish(latest.items)
        }, this.options.values.pushSettleMs)
        settleTimer.unref()
      }
      const onAbort = (): void => finish(null)
      const offPush = this.connection.onPush((push) => {
        if (push.uri !== uri) return
        if (push.version !== undefined && push.version < version) return
        collect()
      })
      this.waiter = { uri, cancel: () => finish(null) }
      if (signal !== undefined) {
        if (signal.aborted) {
          finish(null)
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /** 掐掉还挂着的等待（新一轮诊断之前调用）。 */
  private dropWaiter(): void {
    const current = this.waiter
    this.waiter = undefined
    current?.cancel()
  }

  /** 这个 uri 的下一个 didOpen 版本号。 */
  private nextVersion(uri: string): number {
    const next = (this.docVersions.get(uri) ?? 0) + 1
    this.docVersions.set(uri, next)
    return next
  }

  /** 优雅收尾：shutdown → exit → （超时或失败就）强杀。 */
  async shutdown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.connection.request('shutdown', null, undefined, this.options.values.shutdownGraceMs)
      this.connection.notify('exit', null)
      await Promise.race([
        this.connection.closed,
        new Promise<void>((done) => {
          const timer = setTimeout(done, this.options.values.shutdownGraceMs)
          timer.unref()
        }),
      ])
    } catch {
      // 优雅收不掉（进程已经死了 / 不理会 shutdown）就走下面的强杀
    }
    this.connection.terminate()
    this.docVersions.clear()
  }

  /** 立刻收（宿主退出、插件卸载时用，不等优雅流程）。 */
  terminateNow(): void {
    this.disposed = true
    this.connection.terminate()
  }
}

/** 握手时声明的客户端能力：只声明 utf-16、hover markdown/plaintext、definition/implementation 的 linkSupport，不声明动态注册。 */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  // workspace 这两项如实声明：服务器（pyright 之类）会来问 workspace/configuration，
  // 我们一律回 null（见 answerServerRequest），比它自己去猜配置要好。
  workspace: { workspaceFolders: true, configuration: true },
  textDocument: {
    synchronization: { dynamicRegistration: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
  },
} as const

// ── 连接/实例侧的小工具 ──────────────────────────────────────────────────────

/** 读文件为 UTF-16 字符串（LSP 的列偏移就是这个单位，见 uri.ts）。 */
function readText(filePath: string): string {
  return readFileSync(filePath, 'utf8')
}

/** 服务器声明的能力是不是「有」。 */
function supportsOperation(capabilities: Record<string, unknown>, operation: LspOperation): boolean {
  const value = capabilities[CAPABILITY_FIELD[operation]]
  if (value === undefined || value === null || value === false) return false
  return true
}

/** 谁先给出非空结果就用谁；全是 null 才返回 null。 */
async function firstNonNull(
  sources: readonly Promise<LspDiagnostic[] | null>[],
): Promise<LspDiagnostic[] | null> {
  return await new Promise<LspDiagnostic[] | null>((done) => {
    let remaining = sources.length
    let finished = false
    if (remaining === 0) {
      done(null)
      return
    }
    for (const source of sources) {
      void source.then((items) => {
        remaining -= 1
        if (finished) return
        if (items !== null) {
          finished = true
          done(items)
          return
        }
        if (remaining === 0) {
          finished = true
          done(null)
        }
      })
    }
  })
}
