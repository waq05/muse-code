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
 * 另外两件收尾的事：idle 600 秒回收（设置里可调，下限 30 秒——低于单次请求预算会杀到
 * 飞行中的查询）；启动失败/崩溃对 (服务器, 根) 记一笔**破键**，短时间内不再重试，
 * 免得每次写文件都白等一次 30 秒的启动超时（hermes 的 broken-set 是同一个理由）。
 *
 * @module dsc/core/lsp/client
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { buildChildEnv } from '../mcp.js'
import {
  MAX_MESSAGE_BYTES,
  MAX_STDERR_TAIL_BYTES,
  MessageDecoder,
  StderrTail,
  encodeMessage,
} from './framing.js'
import {
  type LspServerDef,
  type LspServerInfo,
  describeServers,
  findProjectRoot,
  findServerForFile,
  installHint,
  languageIdFor,
  resolveExecutable,
} from './servers.js'
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
class LspQueryError extends Error {
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
class LspInstance {
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

// ── 管理器（池 + 串行队列 + idle 回收 + 破键退避）─────────────────────────────

/** 池子里的一条记录。 */
interface InstanceRecord {
  key: string
  server: LspServerDef
  root: string
  instance: LspInstance
  /** 队列里还有活没干完的条数（有活就不回收）。 */
  inflight: number
  /** 最后一次用它的时刻（毫秒）。 */
  lastUsed: number
}

/** 一个 (服务器, 根) 的破键。 */
interface BrokenMark {
  until: number
  reason: string
}

/** 查询计划：找好了服务器与根，接下来只剩起进程/排队。 */
interface QueryPlan {
  server: LspServerDef
  root: string
  path: string
  key: string
  target: { file: string; shell: boolean }
}

/**
 * LSP 管理器：持有所有实例、按 (服务器, 根) 串行、按 idle 回收、按破键退避。
 * 外部只会调 {@link LspManager.query} / {@link LspManager.diagnostics} / status / servers / dispose。
 */
export class LspManager {
  private readonly records = new Map<string, InstanceRecord>()
  private readonly starting = new Map<string, Promise<InstanceRecord>>()
  private readonly broken = new Map<string, BrokenMark>()
  /** 每个 key 的串行尾巴：排队是**同步**接上的，所以「写前基线」一定排在「写后查询」前面。 */
  private readonly tails = new Map<string, Promise<unknown>>()
  private reaper: NodeJS.Timeout | undefined
  private disposed = false
  private readonly env: Record<string, string>

  constructor(private readonly options: LspManagerOptions) {
    this.env = options.env?.() ?? buildChildEnv([], {}, process.env)
    this.scheduleSweep()
  }

  /**
   * 排下一次 idle 清扫。每次重算间隔（idle 一半，夹在 5 秒到 60 秒之间），
   * 所以用户在设置里把 idle 从 600 秒改成 30 秒之后，下一次清扫的节奏就跟着变了。
   */
  private scheduleSweep(): void {
    if (this.disposed) return
    const delay = Math.max(5_000, Math.min(60_000, Math.round(this.options.idleTimeoutMs() / 2)))
    const timer = setTimeout(() => {
      this.reaper = undefined
      void this.sweepIdle().finally(() => {
        this.scheduleSweep()
      })
    }, delay)
    // 挂着的清扫定时器不能把宿主进程钉住不退出
    timer.unref()
    this.reaper = timer
  }

  /** 现在生效的服务器表（连「PATH 里有没有」一起给）。 */
  servers(): LspServerInfo[] {
    return describeServers(this.options.servers(), this.env, process.cwd())
  }

  /** 每个服务器此刻的状态与实例数。 */
  status(): LspStatusEntry[] {
    const now = Date.now()
    const instancesByServer = new Map<string, string[]>()
    for (const record of this.records.values()) {
      const roots = instancesByServer.get(record.server.id) ?? []
      roots.push(record.root)
      instancesByServer.set(record.server.id, roots)
    }
    return this.options.servers().map((server) => {
      const mark = this.brokenIn(server.id, now)
      const roots = instancesByServer.get(server.id) ?? []
      const target = resolveExecutable(server.command, this.env, process.cwd())
      return {
        id: server.id,
        command: server.command,
        available: target !== undefined,
        instances: roots.length,
        roots,
        brokenSeconds: mark === null ? null : Math.max(0, Math.ceil((mark.until - now) / 1000)),
        ...(mark === null ? {} : { problem: mark.reason }),
      }
    })
  }

  /**
   * 一次查询。任何一步不行都给 `{ ok: false, reason }`，**不抛给调用方**。
   *
   * @param operation - 四个操作之一。
   * @param filePath - 目标文件（相对路径按 cwd 展开）。
   * @param line - 一基行号。
   * @param character - 一基列号。
   * @param position - 已经换算好的零基坐标。
   * @param cwd - 会话工作目录。
   * @param signal - 取消信号。
   */
  async query(
    operation: LspOperation,
    filePath: string,
    position: LspPosition,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<LspQueryOutcome> {
    const plan = this.plan(filePath, cwd)
    if (!plan.ok) return plan
    const blocked = this.brokenReason(plan.plan.key)
    if (blocked !== null) return { ok: false, reason: blocked, server: plan.plan.server.id }
    return await this.enqueue(plan.plan.key, async () => {
      const acquired = await this.acquire(plan.plan)
      if (!acquired.ok) {
        return {
          ok: false,
          reason: acquired.reason,
          server: plan.plan.server.id,
          ...(acquired.stderr === undefined ? {} : { stderr: acquired.stderr }),
        }
      }
      const record = acquired.record
      record.inflight += 1
      record.lastUsed = Date.now()
      try {
        const result = await record.instance.query(operation, plan.plan.path, position, signal)
        return { ok: true, ...result, server: plan.plan.server.id, root: plan.plan.root }
      } catch (error) {
        return await this.failed(plan.plan, record.instance, error)
      } finally {
        record.inflight -= 1
        record.lastUsed = Date.now()
      }
    })
  }

  /**
   * 一个文件此刻的诊断。`content` 给了就按它算（写前基线用写前的内容），没给就读盘。
   *
   * @param filePath - 目标文件（相对路径按 cwd 展开）。
   * @param cwd - 会话工作目录。
   * @param content - 想让服务器看到的文本；缺省读盘。
   * @param signal - 取消信号。
   */
  async diagnostics(
    filePath: string,
    cwd: string,
    content?: string,
    signal?: AbortSignal,
  ): Promise<LspDiagnosticsOutcome> {
    const plan = this.plan(filePath, cwd)
    if (!plan.ok) return plan
    const blocked = this.brokenReason(plan.plan.key)
    if (blocked !== null) return { ok: false, reason: blocked, server: plan.plan.server.id }
    return await this.enqueue(plan.plan.key, async () => {
      const acquired = await this.acquire(plan.plan)
      if (!acquired.ok) {
        return {
          ok: false,
          reason: acquired.reason,
          server: plan.plan.server.id,
          ...(acquired.stderr === undefined ? {} : { stderr: acquired.stderr }),
        }
      }
      const record = acquired.record
      record.inflight += 1
      record.lastUsed = Date.now()
      try {
        const items = await record.instance.diagnostics(plan.plan.path, content, signal)
        if (items === null) {
          return {
            ok: false,
            reason: `${plan.plan.server.id} 在 ${this.values().diagnosticsWaitMs}ms 内没给出诊断（可能还在建索引）`,
            server: plan.plan.server.id,
          }
        }
        return {
          ok: true,
          diagnostics: items,
          server: plan.plan.server.id,
          root: plan.plan.root,
        }
      } catch (error) {
        return await this.failed(plan.plan, record.instance, error)
      } finally {
        record.inflight -= 1
        record.lastUsed = Date.now()
      }
    })
  }

  /** 这个文件现在有没有可用的服务器（守卫据此决定要不要记基线，免得白起进程）。 */
  canServe(filePath: string, cwd: string): boolean {
    const plan = this.plan(filePath, cwd)
    return plan.ok && this.brokenReason(plan.plan.key) === null
  }

  /**
   * 收掉全部子进程与定时器。**同步**：disposer 与 `dsc/exit` 都在同步路径上，
   * 这里只发信号不等待——不退进程就会留一群语言服务器在后台（照 `plugins/mcp.ts:151-155` 的理由）。
   */
  dispose(): void {
    this.disposed = true
    if (this.reaper !== undefined) {
      clearTimeout(this.reaper)
      this.reaper = undefined
    }
    for (const record of this.records.values()) record.instance.terminateNow()
    this.records.clear()
    this.starting.clear()
    this.tails.clear()
  }

  private values(): LspRuntimeValues {
    return { ...defaultRuntimeValues(), ...this.options.values?.() }
  }

  /** 找服务器、找根、确认可执行文件都在；任何一步不行都给一句原因。 */
  private plan(
    filePath: string,
    cwd: string,
  ): { ok: true; plan: QueryPlan } | { ok: false; reason: string; server?: string } {
    const path = isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
    if (!existsSync(path)) return { ok: false, reason: `文件不存在：${path}` }
    const servers = this.options.servers()
    const server = findServerForFile(servers, path)
    if (server === undefined) {
      return {
        ok: false,
        reason: `没有认领 ${extensionHint(path)} 的语言服务器（内置表里没有这种扩展名，可以在设置里用一行 JSON 追加）`,
      }
    }
    const target = resolveExecutable(server.command, this.env, process.cwd())
    if (target === undefined) {
      const hint = installHint(server.id)
      return {
        ok: false,
        server: server.id,
        reason:
          `PATH 里找不到 ${server.id} 服务器的可执行文件 ${server.command}` +
          `${hint === undefined ? '' : `（装法：${hint}）`}`,
      }
    }
    const root = findProjectRoot(path, server.markers)
    if (root === undefined) {
      return {
        ok: false,
        server: server.id,
        reason:
          `${path} 往上找不到 ${server.markers.slice(0, 3).join(' / ')} 这些标记，定不了项目根` +
          '（语言服务器需要一个工作区根才能建索引）',
      }
    }
    return {
      ok: true,
      plan: { server, root, path, key: `${server.id}\u0000${root}`, target },
    }
  }

  /** 破键还没解禁就给一句原因（带上还剩多久）。 */
  private brokenReason(key: string): string | null {
    const mark = this.broken.get(key)
    if (mark === undefined) return null
    const left = mark.until - Date.now()
    if (left <= 0) {
      this.broken.delete(key)
      return null
    }
    const [serverId, root] = key.split('\u0000')
    return `${serverId} 在 ${root} 上最近起不来，先不重试（还有 ${Math.ceil(left / 1000)} 秒）：${mark.reason}`
  }

  /** 某个服务器当前有没有破键（status 用）。 */
  private brokenIn(serverId: string, now: number): BrokenMark | null {
    for (const [key, mark] of this.broken) {
      if (!key.startsWith(`${serverId}\u0000`)) continue
      if (mark.until > now) return mark
      this.broken.delete(key)
    }
    return null
  }

  /** 记一笔破键（同一个 key 只留最长的那次，免得后来的短退避把长退避顶掉）。 */
  private markBroken(key: string, reason: string): void {
    const until = Date.now() + this.values().brokenRetryMs
    const current = this.broken.get(key)
    if (current !== undefined && current.until >= until) return
    this.broken.set(key, { until, reason })
  }

  /** 同步把这次操作接到该 key 的尾巴上：排队顺序 = 调用顺序（写前基线必须排在写后查询前面）。 */
  private enqueue<T>(key: string, op: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const run = previous.then(op, op)
    this.tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  /**
   * 取实例：池子里有就用，没有就起一个。同一个 key 上的并发请求共用同一次启动。
   *
   * @returns 记录，或一句起不来的原因（起不来时已经记好破键）。
   */
  private async acquire(
    plan: QueryPlan,
  ): Promise<{ ok: true; record: InstanceRecord } | { ok: false; reason: string; stderr?: string }> {
    if (this.disposed) return { ok: false, reason: 'LSP 管理器已经收掉了' }
    const existing = this.records.get(plan.key)
    if (existing !== undefined && !existing.instance.dead) return { ok: true, record: existing }
    const pendingStart = this.starting.get(plan.key)
    if (pendingStart !== undefined) {
      try {
        return { ok: true, record: await pendingStart }
      } catch (error) {
        return { ok: false, ...this.startFailure(plan, error) }
      }
    }
    const start = this.startInstance(plan)
    this.starting.set(plan.key, start)
    try {
      return { ok: true, record: await start }
    } catch (error) {
      return { ok: false, ...this.startFailure(plan, error) }
    } finally {
      this.starting.delete(plan.key)
    }
  }

  private async startInstance(plan: QueryPlan): Promise<InstanceRecord> {
    const instance = new LspInstance({
      server: plan.server,
      root: plan.root,
      target: plan.target,
      env: this.env,
      values: this.values(),
      onExit: (reason) => {
        this.onInstanceExit(plan.key, instance, reason)
      },
    })
    try {
      // 握手失败要在这里就暴露：进了池子以后每条查询都得再等一次 30 秒才算知道它起不来。
      await instance.ready
    } catch (error) {
      instance.terminateNow()
      throw error
    }
    const record: InstanceRecord = {
      key: plan.key,
      server: plan.server,
      root: plan.root,
      instance,
      inflight: 0,
      lastUsed: Date.now(),
    }
    this.records.set(plan.key, record)
    return record
  }

  /** 启动失败的原因与 stderr 尾巴：两个都要回给调用方——尾巴是「为什么起不来」的唯一线索。 */
  private startFailure(plan: QueryPlan, error: unknown): { reason: string; stderr?: string } {
    const message = errorText(error)
    const stderr = error instanceof LspQueryError ? error.stderr : undefined
    this.markBroken(plan.key, message)
    const [serverId, root] = [plan.server.id, plan.root]
    return {
      reason:
        `${serverId} 语言服务器在 ${root} 起不来：${message}` +
        `${stderr === undefined || stderr === '' ? '' : `\nstderr 尾巴：\n${stderr}`}`,
      ...(stderr === undefined || stderr === '' ? {} : { stderr }),
    }
  }

  /** 实例自己退了（崩溃、被杀、退出）：清槽 + 记破键。 */
  private onInstanceExit(key: string, instance: LspInstance, reason: string): void {
    const record = this.records.get(key)
    if (record !== undefined && record.instance === instance) this.records.delete(key)
    if (this.disposed) return
    this.markBroken(key, reason.split('\n')[0] ?? reason)
  }

  /** 一次操作失败：致命的（传输/超时）杀掉实例并记破键，非致命的只回一句话。 */
  private async failed(
    plan: QueryPlan,
    instance: LspInstance,
    error: unknown,
  ): Promise<{ ok: false; reason: string; server: string; stderr?: string }> {
    const message = errorText(error)
    const stderr = instance.stderrTail()
    const fatal = error instanceof LspQueryError ? error.fatal : true
    if (fatal) {
      const record = this.records.get(plan.key)
      if (record !== undefined && record.instance === instance) this.records.delete(plan.key)
      this.markBroken(plan.key, message)
      instance.terminateNow()
    }
    return {
      ok: false,
      server: plan.server.id,
      reason: `${plan.server.id} 这次查询没成：${message}`,
      ...(stderr === '' ? {} : { stderr }),
    }
  }

  /**
   * 扫一遍 idle：超时没用过的实例收掉（有活干的不动）。
   *
   * 定时器调它；自检也直接调它（不然要干等 5 秒才轮到定时器）。
   */
  async sweepIdle(): Promise<void> {
    if (this.disposed) return
    const idleMs = this.options.idleTimeoutMs()
    const cutoff = Date.now() - idleMs
    const victims: InstanceRecord[] = []
    for (const record of this.records.values()) {
      if (record.inflight > 0 || record.lastUsed > cutoff) continue
      this.records.delete(record.key)
      victims.push(record)
    }
    for (const record of victims) await record.instance.shutdown()
  }
}

// ── 纯函数：结果归并与诊断增量（自检重点覆盖）─────────────────────────────────

/** 认得出是个普通对象就返回，否则 null。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 读文件为 UTF-16 字符串（LSP 的列偏移就是这个单位，见 uri.ts）。 */
function readText(filePath: string): string {
  return readFileSync(filePath, 'utf8')
}

/** 错误对象取一句话。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 扩展名提示（降级文案里那句「没有认领 .xyz 的服务器」）。 */
function extensionHint(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : base
}

/** 服务器声明的能力是不是「有」。 */
function supportsOperation(capabilities: Record<string, unknown>, operation: LspOperation): boolean {
  const value = capabilities[CAPABILITY_FIELD[operation]]
  if (value === undefined || value === null || value === false) return false
  return true
}

/** 线上坐标是不是非负整数。 */
function isProtocolPosition(value: unknown): value is LspPosition {
  const doc = asRecord(value)
  if (doc === null) return false
  return (
    typeof doc.line === 'number' &&
    Number.isInteger(doc.line) &&
    doc.line >= 0 &&
    typeof doc.character === 'number' &&
    Number.isInteger(doc.character) &&
    doc.character >= 0
  )
}

/** 线上区间是不是合法。 */
function isRange(value: unknown): value is LspRange {
  const doc = asRecord(value)
  if (doc === null) return false
  return isProtocolPosition(doc.start) && isProtocolPosition(doc.end)
}

/** 复制一份区间（只留四个数字，免得把服务器给的额外字段带进会话）。 */
function toRange(range: LspRange): LspRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

/**
 * 归并导航结果：`Location` / `Location[]` / `LocationLink[]` / `null` 都收成 {@link LspLocation} 数组。
 * `LocationLink` 取 `targetUri` + `targetSelectionRange`（要的是符号本身的区间，不是整块上下文）。
 *
 * @throws Error - 结果里有既不是 Location 也不是 LocationLink 的项（协议坏了，由调用方转成降级文案）。
 */
export function normalizeLocations(payload: unknown): LspLocation[] {
  if (payload === null || payload === undefined) return []
  const elements = Array.isArray(payload) ? payload : [payload]
  const out: LspLocation[] = []
  for (const element of elements) {
    const doc = asRecord(element)
    if (doc === null) throw new Error('LSP 定位结果里有不是对象的项')
    if (typeof doc.targetUri === 'string' && isRange(doc.targetSelectionRange)) {
      out.push({ uri: doc.targetUri, range: toRange(doc.targetSelectionRange) })
      continue
    }
    if (typeof doc.uri === 'string' && isRange(doc.range)) {
      out.push({ uri: doc.uri, range: toRange(doc.range) })
      continue
    }
    throw new Error('LSP 定位结果里既不是 Location 也不是 LocationLink')
  }
  return out
}

/**
 * 归并 hover：`MarkupContent` 取 `value`；字符串形式的 `MarkedString` 原样；
 * 带 `language` 的 `MarkedString` 渲染成围栏代码块；数组用空行连接。空内容返回 null。
 */
export function normalizeHover(payload: unknown): LspHover | null {
  if (payload === null || payload === undefined) return null
  const doc = asRecord(payload)
  if (doc === null) throw new Error('LSP hover 结果不是对象')
  const contents = renderHoverContents(doc.contents)
  if (contents === '') return null
  if (doc.range === undefined) return { contents }
  if (!isRange(doc.range)) throw new Error('LSP hover 结果里的 range 畸形')
  return { contents, range: toRange(doc.range) }
}

/** 三种 `Hover.contents` 编码渲染成一段文本。 */
function renderHoverContents(contents: unknown): string {
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map((item) => renderMarkedString(item)).join('\n\n')
  }
  const doc = asRecord(contents)
  if (doc === null) return ''
  if ((doc.kind === 'markdown' || doc.kind === 'plaintext') && typeof doc.value === 'string') return doc.value
  if (typeof doc.language === 'string' && typeof doc.value === 'string') {
    return renderMarkedString({ language: doc.language, value: doc.value })
  }
  return ''
}

/** 一个 `MarkedString`：字符串原样，对象渲染成围栏代码块。 */
function renderMarkedString(value: unknown): string {
  if (typeof value === 'string') return value
  const doc = asRecord(value)
  if (doc !== null && typeof doc.language === 'string' && typeof doc.value === 'string') {
    return `\`\`\`${doc.language}\n${doc.value}\n\`\`\``
  }
  return ''
}

/** 把服务器给的诊断数组归并成 {@link LspDiagnostic}（缺 severity 按 ERROR 算，与 hermes 一致）。 */
export function normalizeDiagnostics(payload: unknown): LspDiagnostic[] {
  if (!Array.isArray(payload)) return []
  const out: LspDiagnostic[] = []
  for (const item of payload) {
    const doc = asRecord(item)
    if (doc === null || !isRange(doc.range)) continue
    const severity = typeof doc.severity === 'number' ? doc.severity : 1
    out.push({
      severity,
      message: typeof doc.message === 'string' ? doc.message : '',
      ...(doc.code === undefined || doc.code === null ? {} : { code: String(doc.code) }),
      ...(typeof doc.source === 'string' ? { source: doc.source } : {}),
      range: toRange(doc.range),
    })
  }
  return out
}

/** 诊断的身份：增量比对靠它（严重度、编码、来源、原文、整条区间）。 */
export function diagnosticKey(diagnostic: LspDiagnostic): string {
  const { start, end } = diagnostic.range
  return [
    diagnostic.severity,
    diagnostic.code ?? '',
    diagnostic.source ?? '',
    diagnostic.message,
    start.line,
    start.character,
    end.line,
    end.character,
  ].join('\u0001')
}

/** LCS 动态规划的格子上限（超了就退回贪心匹配，别为了对齐行号吃爆内存）。 */
const LCS_MAX_CELLS = 1_000_000

/**
 * 建一张写前 → 写后的行号映射（零基，`null` = 那一行被删了）。
 *
 * 为什么需要：增量过滤的关键是「同一条诊断，只是被上面的插入行推下去了」。如果只按
 * (消息, 区间) 比，位移过的旧诊断会被当成新引入的，写完一次文件就报一堆假错。
 * 做法与 hermes 的 `range_shift.py` 同一个思路：先削掉公共前后缀（单点编辑的中段因此很短），
 * 中段用 LCS 对齐（`equal` 的行按偏移映射，被替换/删掉的行映射到 `null`），尾部整体平移。
 *
 * @param preText - 写前的文本。
 * @param postText - 写后的文本。
 * @returns `shift(line) -> 新行号 | null`（行号越界时锚到最后一行）。
 */
export function buildLineShift(preText: string, postText: string): (line: number) => number | null {
  const pre = splitLines(preText)
  const post = splitLines(postText)
  if (pre.length === post.length && pre.every((line, index) => line === post[index])) {
    return (line) => line
  }
  let prefix = 0
  while (prefix < pre.length && prefix < post.length && pre[prefix] === post[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < pre.length - prefix &&
    suffix < post.length - prefix &&
    pre[pre.length - 1 - suffix] === post[post.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const preMiddle = pre.slice(prefix, pre.length - suffix)
  const postMiddle = post.slice(prefix, post.length - suffix)
  const middleMap = lcsLineMap(preMiddle, postMiddle)
  const tailShift = post.length - pre.length
  return (line) => {
    if (line < 0) return null
    if (line < prefix) return line
    if (line >= pre.length - suffix) {
      // 尾部：整体平移；落在文件末尾之外的锚到最后一行（与 hermes 一致）。
      if (line >= pre.length) return post.length === 0 ? null : post.length - 1
      return line + tailShift
    }
    const mapped = middleMap[line - prefix]
    return mapped === null || mapped === undefined ? null : mapped + prefix
  }
}

/** 拆行（LSP 按 `\n` 数行，`\r` 只是行尾的一部分）。 */
function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

/** 中段对齐：`a[i]` 对应 `b[j]` 就记 j，对不上记 null。 */
function lcsLineMap(a: string[], b: string[]): Array<number | null> {
  const out: Array<number | null> = new Array<number | null>(a.length).fill(null)
  if (a.length === 0 || b.length === 0) return out
  if ((a.length + 1) * (b.length + 1) > LCS_MAX_CELLS) return greedyLineMap(a, b)
  const width = b.length + 1
  const table = new Int32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!)
    }
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out[i] = j
      i += 1
      j += 1
      continue
    }
    if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) i += 1
    else j += 1
  }
  return out
}

/** 太大时的兜底：按文本贪心配对（每个 b 行只用一次，从左往右）。 */
function greedyLineMap(a: string[], b: string[]): Array<number | null> {
  const out: Array<number | null> = new Array<number | null>(a.length).fill(null)
  const index = new Map<string, number[]>()
  for (const [j, line] of b.entries()) {
    const list = index.get(line)
    if (list === undefined) index.set(line, [j])
    else list.push(j)
  }
  let floor = -1
  for (const [i, line] of a.entries()) {
    const candidates = index.get(line)
    if (candidates === undefined) continue
    const hit = candidates.find((j) => j > floor)
    if (hit === undefined) continue
    out[i] = hit
    floor = hit
  }
  return out
}

/** 把基线诊断按行位移映射到写后的坐标；落在被删区域里的直接出局。 */
export function shiftDiagnostics(
  diagnostics: readonly LspDiagnostic[],
  shift: (line: number) => number | null,
): LspDiagnostic[] {
  const out: LspDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const startLine = shift(diagnostic.range.start.line)
    if (startLine === null) continue
    const endLine = shift(diagnostic.range.end.line) ?? startLine
    out.push({
      ...diagnostic,
      range: {
        start: { line: startLine, character: diagnostic.range.start.character },
        end: { line: endLine, character: diagnostic.range.end.character },
      },
    })
  }
  return out
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
