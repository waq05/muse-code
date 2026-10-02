/**
 * MCP 客户端底座：stdio 与 streamable-http 两种传输上的 JSON-RPC 收发、工具命名、
 * 子进程环境筛选，以及 Windows 上的启动命令解析。挂到 cordis 上的那一层在
 * `src/plugins/mcp.ts`。
 *
 * 为什么不引 SDK：个人版零新增依赖，而 dsc 用到的线上方法只有 initialize /
 * notifications/initialized / tools/list / tools/call 四条，自己写一遍比拖一条依赖树省事。
 *
 * @module dsc/core/mcp
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

// ── 协议与命名常量（协议常量不随部署变，固定在这里） ──────────────────────────

/** initialize 里报的协议版本（MCP 2024-11-05）。 */
const MCP_PROTOCOL_VERSION = '2024-11-05'

/** initialize 里自报的客户端身份。 */
const CLIENT_INFO = { name: 'muse-code', version: '0.1.0' }

/** 工具名长度上限（照 codex / dsh：超长的截断后用哈希尾巴防撞）。 */
const TOOL_NAME_MAX = 64

/** 哈希尾巴的位数。 */
const TOOL_NAME_HASH = 12

/** tools/list 翻页上限：server 一直给新游标时也不能转死。 */
const MAX_TOOL_PAGES = 100

/** 子进程 stderr 最多留多少字符进错误消息（这个是给人看的原因，不是日志）。 */
const STDERR_TAIL_MAX = 2000

/**
 * 允许带进子进程的系统环境变量。
 * 其余一律不传：`process.env` 里有用户的模型 key 与各种令牌，MCP server 是第三方程序，
 * 没有理由让它看见。要传的按 server 配置显式声明。
 */
export const BASE_ENV_NAMES: readonly string[] = [
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'LANG',
]

/** PATH 里没写 PATHEXT 时按这几个后缀找可执行文件。 */
const FALLBACK_PATHEXT: readonly string[] = ['.COM', '.EXE', '.BAT', '.CMD']

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type McpTransportKind = 'stdio' | 'http'
export type McpRisk = 'read' | 'write' | 'exec'

/**
 * 一个 MCP server 的配置。stdio 与 http 的字段放在同一个对象里，
 * 用不上的那些留空串/空数组——配置来自一行 JSON，扁平结构比判别联合好校验也好改。
 */
export interface McpServerConfig {
  name: string
  transport: McpTransportKind
  /** stdio：可执行文件名或路径。 */
  command: string
  args: string[]
  /** stdio：工作目录；空串 = 跟宿主同一个目录。 */
  cwd: string
  /** stdio：显式声明要传进子进程的变量名与值。 */
  env: Record<string, string>
  /** http：streamable-http 端点。 */
  url: string
  /** http：额外请求头（认证信息放这里）。 */
  headers: Record<string, string>
  /** 按工具名指定的风险等级；没写的走 defaultRisk。 */
  risk: Record<string, McpRisk>
  /** 这个 server 没单独指定的工具按什么风险等级算。 */
  defaultRisk: McpRisk
}

/** server 返回的一个工具（还没起 dsc 的名字）。 */
export interface McpToolSpec {
  name: string
  description: string
  /** JSON Schema（OpenAI function 参数格式）。 */
  parameters: Record<string, unknown>
}

/** 一次 tools/call 的结果。 */
export interface McpCallResult {
  text: string
  isError: boolean
}

/** 一条已经握过手的连接。 */
export interface McpConnection {
  /** 底层进程还活着 / HTTP 通道还没关。 */
  readonly alive: boolean
  /**
   * T37：initialize 应答里的 `instructions`——server 用它交代自家工具的用法预期
   * （什么参数组合有意义、什么时候该用别的 server）。空串 = 没给。插件层把它挂进
   * 系统提示，模型才能看到这份交代。
   */
  readonly instructions: string
  listTools(signal: AbortSignal): Promise<McpToolSpec[]>
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>
  close(): void
}

/** 建立一条连接的入参。 */
export interface McpOpenOptions {
  /** 握手（initialize → notifications/initialized）超时。 */
  connectTimeoutMs: number
  /** 单次请求超时。 */
  callTimeoutMs: number
  /**
   * 连接自己断了时回调一次（stdout 结束、子进程退出）。
   * http 没有常驻连接，一问一答，所以这条不会触发——那边断了就是某次 tools/call 直接抛错。
   */
  onClose: () => void
}

/** 解析一行服务器清单 JSON 的结果；problem 非空时 servers 一定是空的。 */
export interface McpServerList {
  servers: McpServerConfig[]
  problem: string | null
}

// ── 环境变量筛选 ─────────────────────────────────────────────────────────────

/**
 * 按白名单拼子进程环境。
 *
 * 只放 {@link BASE_ENV_NAMES} 里的系统变量，加上配置里显式声明的名字；
 * 声明了名字但没给值时，从父环境取同名变量（写 `{"GITHUB_TOKEN": ""}` 也能带上宿主的那个）。
 *
 * @param declaredNames - 配置里显式声明的变量名。
 * @param values - 这些名字对应的值（缺了就从 parent 取）。
 * @param parent - 父进程环境，通常是 `process.env`。
 * @returns 交给 spawn 的环境对象（不含任何未声明的变量）。
 */
export function buildChildEnv(
  declaredNames: readonly string[],
  values: Record<string, string>,
  parent: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of BASE_ENV_NAMES) {
    const value = readEnv(parent, name)
    if (value !== undefined && value !== '') env[name] = value
  }
  for (const name of declaredNames) {
    const value = values[name] ?? readEnv(parent, name)
    if (value !== undefined && value !== '') env[name] = value
  }
  return env
}

/** 按名字读环境变量；Windows 的变量名不分大小写，所以找不到时再比一遍小写。 */
function readEnv(parent: Record<string, string | undefined>, name: string): string | undefined {
  const direct = parent[name]
  if (direct !== undefined) return direct
  if (process.platform !== 'win32') return undefined
  const wanted = name.toLowerCase()
  for (const key of Object.keys(parent)) {
    if (key.toLowerCase() === wanted) return parent[key]
  }
  return undefined
}

// ── 启动命令解析 ─────────────────────────────────────────────────────────────

/** 一条能直接交给 spawn 的命令。 */
export interface SpawnPlan {
  file: string
  /** true = 要经 shell 起（`.cmd` / `.bat` 只能这么跑）。 */
  shell: boolean
}

/**
 * 把配置里的命令解析成 spawn 能用的形式。
 *
 * Windows 上 Node 只执行 PE 文件：`spawn('npx')` 明明 PATH 里有 `npx.cmd`，却会以
 * EINVAL 失败。所以这里按 PATH + PATHEXT 自己找一遍，找到 `.cmd` / `.bat` 就标上要经 shell。
 * 非 Windows 上 Node 自己能找，原样返回。
 *
 * @param command - 配置里写的命令（可以是文件名，也可以是路径）。
 * @param env - 已经筛过的子进程环境（从这里读 PATH / PATHEXT）。
 * @param cwd - 解析相对路径的基准目录；空串按当前目录。
 */
export function resolveCommand(command: string, env: Record<string, string>, cwd: string): SpawnPlan {
  if (process.platform !== 'win32') return { file: command, shell: false }
  const declared = (env.PATHEXT ?? '').split(';').filter((suffix) => suffix !== '')
  const suffixes = declared.length > 0 ? declared : FALLBACK_PATHEXT
  const roots = /[\\/]/.test(command)
    ? [isAbsolute(command) ? command : resolve(cwd === '' ? process.cwd() : cwd, command)]
    : (env.PATH ?? '')
        .split(';')
        .filter((dir) => dir !== '')
        .map((dir) => join(dir, command))
  for (const root of roots) {
    for (const candidate of [root, ...suffixes.map((suffix) => root + suffix)]) {
      if (existsSync(candidate)) return { file: candidate, shell: needsShell(candidate) }
    }
  }
  // 一个都没找到：交给 cmd 自己按 PATHEXT 找，找不到时它会往 stderr 报错，
  // 那句报错会跟着进程退出一起进 problem，比这里瞎猜一句更准。
  return { file: command, shell: true }
}

/** `.cmd` / `.bat` 只能经 cmd.exe 跑（Node 直接 CreateProcess 会拒绝）。 */
function needsShell(file: string): boolean {
  const lower = file.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat')
}

/** shell 那条路上参数由 cmd.exe 解析，带空格或元字符的要自己加引号。 */
function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

// ── 工具命名与风险等级 ───────────────────────────────────────────────────────

/** 把片段里不能出现在工具名里的字符换掉。 */
function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * 拼完整工具名：`mcp__<server>__<tool>`。
 * 超过 64 个字符时截断并接 12 位 sha256 尾巴，两个长名字因此不会撞成一个。
 *
 * @param server - server 名。
 * @param tool - server 那边的工具名。
 */
export function mcpToolName(server: string, tool: string): string {
  const raw = `mcp__${sanitize(server)}__${sanitize(tool)}`
  if (raw.length <= TOOL_NAME_MAX) return raw
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, TOOL_NAME_HASH)
  return `${raw.slice(0, TOOL_NAME_MAX - TOOL_NAME_HASH - 1)}_${digest}`
}

/** 一个工具的风险等级：配置里点名过就按配置，没点名按 server 的默认值。 */
export function riskOf(server: McpServerConfig, tool: string): McpRisk {
  return server.risk[tool] ?? server.defaultRisk
}

// ── 服务器清单解析 ───────────────────────────────────────────────────────────

/**
 * 解析设置里那一行服务器清单 JSON。
 * 数组里每一项一个 server；任何一项不合法就整份拒收，并给出第几项哪里不对——
 * 半份配置连起来比连不上更难查。
 *
 * @param text - 清单原文（空串 = 没有 server）。
 * @param fallbackRisk - 清单里没写 defaultRisk 时按它算。
 */
export function parseServerList(text: string, fallbackRisk: McpRisk): McpServerList {
  const trimmed = text.trim()
  if (trimmed === '') return { servers: [], problem: null }
  let doc: unknown
  try {
    doc = JSON.parse(trimmed)
  } catch (error) {
    return { servers: [], problem: `不是合法 JSON：${errorText(error)}` }
  }
  if (!Array.isArray(doc)) return { servers: [], problem: '服务器清单要是一个 JSON 数组' }
  const servers: McpServerConfig[] = []
  const seen = new Set<string>()
  for (let index = 0; index < doc.length; index += 1) {
    const parsed = parseServerEntry(doc[index], index, fallbackRisk)
    if (typeof parsed === 'string') return { servers: [], problem: parsed }
    if (seen.has(parsed.name)) return { servers: [], problem: `第 ${index + 1} 项的 name 与前面重了：${parsed.name}` }
    seen.add(parsed.name)
    servers.push(parsed)
  }
  return { servers, problem: null }
}

/** 解析清单里的一项；返回字符串 = 这一项哪里不对。 */
function parseServerEntry(entry: unknown, index: number, fallbackRisk: McpRisk): McpServerConfig | string {
  const where = `第 ${index + 1} 项`
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return `${where}不是一个对象`
  const raw = entry as Record<string, unknown>
  const name = asText(raw.name)
  if (name === undefined || name === '') return `${where}缺 name`
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(name)) {
    return `${where}的 name「${name}」只能用字母、数字与 _ . -，且不超过 40 个字`
  }
  const transport = raw.transport === undefined ? 'stdio' : asText(raw.transport)
  if (transport !== 'stdio' && transport !== 'http') return `${where}的 transport 只能是 stdio 或 http`
  const args = asTextList(raw.args)
  if (args === undefined) return `${where}的 args 要是一个字符串数组`
  const env = asTextMap(raw.env)
  if (env === undefined) return `${where}的 env 要是「变量名: 值」的对象`
  const headers = asTextMap(raw.headers)
  if (headers === undefined) return `${where}的 headers 要是「头名: 值」的对象`
  const risk = asRiskMap(raw.risk)
  if (risk === undefined) return `${where}的 risk 要是「工具名: read|write|exec」的对象`
  const declaredRisk = raw.defaultRisk === undefined ? fallbackRisk : asRisk(raw.defaultRisk)
  if (declaredRisk === undefined) return `${where}的 defaultRisk 只能是 read、write 或 exec`
  const command = asText(raw.command) ?? ''
  const url = asText(raw.url) ?? ''
  if (transport === 'stdio' && command === '') return `${where}（${name}）是 stdio，必须写 command`
  if (transport === 'http' && !/^https?:\/\//.test(url)) {
    return `${where}（${name}）是 http，url 要以 http:// 或 https:// 开头`
  }
  return {
    name,
    transport,
    command,
    args,
    cwd: asText(raw.cwd) ?? '',
    env,
    url,
    headers,
    risk,
    defaultRisk: declaredRisk,
  }
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

function asTextList(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    out.push(item)
  }
  return out
}

function asTextMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined
    out[key] = item
  }
  return out
}

function asRiskMap(value: unknown): Record<string, McpRisk> | undefined {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, McpRisk> = {}
  for (const [key, item] of Object.entries(value)) {
    const risk = asRisk(item)
    if (risk === undefined) return undefined
    out[key] = risk
  }
  return out
}

/** 认得出就返回风险等级，认不出返回 undefined（调用方决定是报错还是用缺省）。 */
export function asRisk(value: unknown): McpRisk | undefined {
  return value === 'read' || value === 'write' || value === 'exec' ? value : undefined
}

/** 错误对象取一句话；不是 Error 就字符串化。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── JSON-RPC 通道 ────────────────────────────────────────────────────────────

/** 一条能发请求的通道；stdio 与 http 各实现一份。 */
interface Channel {
  readonly alive: boolean
  request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  notify(method: string, params?: Record<string, unknown>): void
  close(): void
}

/** 一条发出去还没结账的请求。 */
interface Pending {
  /** 结账：先从表里摘掉，再 resolve/reject——重复调用是空操作。 */
  settle(error: Error | null, value?: unknown): void
}

/** JSON-RPC 错误对象压成一句话。 */
function rpcErrorMessage(error: unknown): string {
  if (error === null || typeof error !== 'object') return `MCP 错误：${String(error)}`
  const doc = error as Record<string, unknown>
  const message = typeof doc.message === 'string' ? doc.message : JSON.stringify(error)
  return typeof doc.code === 'number' ? `MCP 错误 ${doc.code}：${message}` : `MCP 错误：${message}`
}

/** 有 error 就抛，没有就取 result。 */
function unwrapRpc(message: Record<string, unknown>): unknown {
  if (message.error !== undefined && message.error !== null) throw new Error(rpcErrorMessage(message.error))
  return message.result
}

/** 认得出是个对象就返回，否则 null。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** 超时或取消，给一句能直接进 problem 的话。 */
function abortReason(signal: AbortSignal, timeoutMs: number): string {
  return signal.aborted ? `请求被取消（超过 ${timeoutMs}ms 的闸门已开）` : `请求超过 ${timeoutMs}ms 没回`
}

/** stdio 通道：一个子进程，按行分帧的 JSON-RPC。 */
class StdioChannel implements Channel {
  private readonly pending = new Map<number, Pending>()
  private buffer = ''
  private stderrTail = ''
  private nextId = 0
  private closed = false

  constructor(
    private readonly child: ChildProcess,
    private readonly timeoutMs: number,
    private readonly onClose: () => void,
  ) {
    child.stdout?.on('data', (chunk: Buffer) => {
      this.onStdout(chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_MAX)
    })
    child.on('error', (error) => {
      this.shutdown(`MCP server 进程起不来：${error.message}`)
    })
    // stdin 出错说明管道断了，紧跟着就是 exit；这里不重复报，交给 exit 那条路。
    child.stdin?.on('error', () => {})
    child.on('exit', (code, signal) => {
      const tail = this.stderrTail.trim()
      this.shutdown(
        `MCP server 进程退出（${signal ?? code ?? '未知'}）${tail === '' ? '' : `：${tail}`}`,
      )
    })
  }

  get alive(): boolean {
    return !this.closed && this.child.exitCode === null
  }

  request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    return new Promise<unknown>((resolveValue, rejectValue) => {
      if (this.closed) {
        rejectValue(new Error('MCP 连接已经关了'))
        return
      }
      const id = (this.nextId += 1)
      const gate = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
      const onAbort = (): void => {
        const entry = this.pending.get(id)
        entry?.settle(new Error(`${abortReason(signal, this.timeoutMs)}：${method}`))
      }
      const entry: Pending = {
        settle: (error, value) => {
          if (!this.pending.delete(id)) return
          gate.removeEventListener('abort', onAbort)
          if (error === null) resolveValue(value)
          else rejectValue(error)
        },
      }
      this.pending.set(id, entry)
      // 已经把闸门拉下的调用方（上一轮被打断）不必再往管道里写一行
      if (gate.aborted) {
        entry.settle(new Error(`${abortReason(signal, this.timeoutMs)}：${method}`))
        return
      }
      gate.addEventListener('abort', onAbort, { once: true })
      const stdin = this.child.stdin
      if (stdin === null || stdin.destroyed) {
        entry.settle(new Error('MCP 子进程的输入口已经关了'))
        return
      }
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error !== null && error !== undefined) entry.settle(new Error(`往 MCP 子进程写请求失败：${error.message}`))
      })
    })
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const stdin = this.child.stdin
    if (this.closed || stdin === null || stdin.destroyed) return
    const doc: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) doc.params = params
    stdin.write(`${JSON.stringify(doc)}\n`, (error) => {
      // 通知发不出去不影响结论：紧随其后的请求会以同样的原因失败，那时才报给调用方。
      if (error !== null && error !== undefined) this.shutdown(`往 MCP 子进程写通知失败：${error.message}`)
    })
  }

  close(): void {
    this.shutdown('MCP 连接被主动关闭')
    if (this.child.exitCode === null) this.child.kill()
  }

  /** 收尾：拒掉所有挂着的请求，再通知插件层这条连接没了。 */
  private shutdown(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const entry of [...this.pending.values()]) entry.settle(new Error(reason))
    this.pending.clear()
    this.onClose()
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') this.onLine(line)
    }
  }

  private onLine(line: string): void {
    let doc: unknown
    try {
      doc = JSON.parse(line)
    } catch {
      // server 往 stdout 打日志、或者半截帧：MCP 只认整行 JSON，这些行直接丢
      return
    }
    const message = asRecord(doc)
    if (message === null) return
    const id = message.id
    // server 主动发的通知、以及它反向发起的请求，本客户端都不认，丢掉
    if (typeof id !== 'number') return
    const entry = this.pending.get(id)
    if (entry === undefined) return
    if (message.error !== undefined && message.error !== null) {
      entry.settle(new Error(rpcErrorMessage(message.error)))
      return
    }
    entry.settle(null, message.result)
  }
}

/** http 通道：streamable-http，一问一答，Session id 记下来在后续请求回填。 */
class HttpChannel implements Channel {
  private nextId = 0
  private sessionId: string | undefined
  private closed = false

  constructor(
    private readonly url: string,
    private readonly extraHeaders: Record<string, string>,
    private readonly timeoutMs: number,
  ) {}

  get alive(): boolean {
    return !this.closed
  }

  async request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const id = (this.nextId += 1)
    return await this.post({ jsonrpc: '2.0', id, method, params }, id, signal)
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const doc: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) doc.params = params
    // 通知不等应答；发失败也不影响后面第一个真请求的结论，那条路上会报。
    void this.post(doc, null, new AbortController().signal).catch(() => {})
  }

  close(): void {
    this.closed = true
  }

  /** 发一条 JSON-RPC 消息；expectId 非 null 时等那条 id 的应答。 */
  private async post(
    payload: Record<string, unknown>,
    expectId: number | null,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) throw new Error('MCP 连接已经关了')
    const gate = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.extraHeaders,
    }
    if (this.sessionId !== undefined) headers['mcp-session-id'] = this.sessionId
    let response: Response
    try {
      response = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: gate })
    } catch (error) {
      throw new Error(`MCP HTTP 请求发不出去（${abortReason(signal, this.timeoutMs)}）：${errorText(error)}`)
    }
    // server 可能在任意一条响应上发新的 Session id，见到就记下来
    const session = response.headers.get('mcp-session-id')
    if (session !== null && session !== '') this.sessionId = session
    if (!response.ok) {
      const detail = await response.text().then(
        (text) => text.slice(0, 300),
        () => '',
      )
      throw new Error(`MCP HTTP ${response.status}：${detail}`)
    }
    if (expectId === null) {
      await response.body?.cancel().catch(() => {})
      return undefined
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) return await readSseFor(response, expectId)
    const text = await response.text()
    if (text.trim() === '') return undefined
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      throw new Error(`MCP HTTP 回的不是 JSON：${text.slice(0, 200)}`)
    }
    const message = asRecord(doc)
    if (message === null) throw new Error('MCP HTTP 回的不是一个 JSON-RPC 对象')
    return unwrapRpc(message)
  }
}

/**
 * 读 SSE 响应体，直到出现 expectId 那条应答，然后立刻取消读取。
 * 非 JSON 的行（心跳、注释）与别人家 id 的事件都跳过。
 */
async function readSseFor(response: Response, expectId: number): Promise<unknown> {
  const body = response.body
  if (body === null) throw new Error('MCP HTTP 声明是 SSE，却没有响应体')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        const payload = line.startsWith('data:') ? line.slice(5).trim() : ''
        if (payload !== '' && payload !== '[DONE]') {
          const match = matchSseChunk(payload, expectId)
          if (match.matched) {
            await reader.cancel()
            return match.value
          }
        }
        index = buffer.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
  throw new Error('MCP HTTP 的 SSE 流读完了，也没等到这个请求的应答')
}

/** 一条 SSE data 是不是我们等的那个应答；匹配上时顺便把结果取出来（有 error 就抛）。 */
function matchSseChunk(payload: string, expectId: number): { matched: boolean; value: unknown } {
  let doc: unknown
  try {
    doc = JSON.parse(payload)
  } catch {
    // SSE 里混着非 JSON 的心跳分片，跳过继续读
    return { matched: false, value: undefined }
  }
  const message = asRecord(doc)
  if (message === null || message.id !== expectId) return { matched: false, value: undefined }
  return { matched: true, value: unwrapRpc(message) }
}

// ── 连接 ─────────────────────────────────────────────────────────────────────

/**
 * 建一条连接并握手（initialize → notifications/initialized）。
 * 只握手，不列工具——列工具是 {@link McpConnection.listTools} 的事，
 * 插件层要在拿到连接之后才能把它记成「当前这条」。
 *
 * @param server - 目标 server 的配置。
 * @param options - 超时与断线回调。
 */
export async function openConnection(server: McpServerConfig, options: McpOpenOptions): Promise<McpConnection> {
  const channel: Channel =
    server.transport === 'http'
      ? new HttpChannel(server.url, server.headers, options.callTimeoutMs)
      : new StdioChannel(spawnStdio(server), options.callTimeoutMs, options.onClose)
  let instructions = ''
  try {
    // T37：initialize 的应答不再整个丢掉——里面的 `instructions` 是 server 交代
    // 自家工具怎么用的说明书，摘出来随连接交还。
    const initResult = await channel.request(
      'initialize',
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      AbortSignal.timeout(options.connectTimeoutMs),
    )
    const initDoc = asRecord(initResult)
    const declared = initDoc?.instructions
    if (typeof declared === 'string') instructions = declared
    channel.notify('notifications/initialized')
  } catch (error) {
    channel.close()
    throw error
  }
  return {
    get alive(): boolean {
      return channel.alive
    },
    instructions,
    listTools: (signal) => listAllTools(channel, signal),
    callTool: (name, args, signal) => callTool(channel, name, args, signal),
    close: () => {
      channel.close()
    },
  }
}

/** 按配置起子进程：环境是筛过的，命令是按 PATH + PATHEXT 解析过的。 */
function spawnStdio(server: McpServerConfig): ChildProcess {
  const env = buildChildEnv(Object.keys(server.env), server.env, process.env)
  const plan = resolveCommand(server.command, env, server.cwd)
  return spawn(plan.file, plan.shell ? server.args.map(quoteForCmd) : server.args, {
    env,
    cwd: server.cwd === '' ? undefined : server.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: plan.shell,
  })
}

/** 列全部工具，跟着 nextCursor 翻页；游标兜圈子时立刻收手。 */
async function listAllTools(channel: Channel, signal: AbortSignal): Promise<McpToolSpec[]> {
  const tools: McpToolSpec[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await channel.request('tools/list', cursor === undefined ? {} : { cursor }, signal)
    const doc = asRecord(result)
    const listed = doc?.tools
    if (Array.isArray(listed)) {
      for (const item of listed) {
        const tool = readToolSpec(item)
        if (tool !== null) tools.push(tool)
      }
    }
    const next = doc?.nextCursor
    if (typeof next !== 'string' || next === '' || seen.has(next)) return tools
    seen.add(next)
    cursor = next
  }
  return tools
}

/** 读 server 返回的一个工具定义；没有名字的项丢掉（dsc 的工具名必须有名字）。 */
function readToolSpec(item: unknown): McpToolSpec | null {
  const doc = asRecord(item)
  if (doc === null || typeof doc.name !== 'string' || doc.name === '') return null
  const schema = asRecord(doc.inputSchema)
  return {
    name: doc.name,
    description: typeof doc.description === 'string' ? doc.description : '',
    parameters: schema ?? { type: 'object', properties: {} },
  }
}

/** 调一次工具，把 content 里的文本部分拼起来。 */
async function callTool(
  channel: Channel,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<McpCallResult> {
  const result = await channel.request('tools/call', { name, arguments: args }, signal)
  const doc = asRecord(result) ?? {}
  return { text: readContentText(doc.content), isError: doc.isError === true }
}

/** content 数组里的文本拼起来；图片这类非文本内容只留一句说明。 */
function readContentText(content: unknown): string {
  if (!Array.isArray(content)) return '（这次调用没有返回内容）'
  const parts: string[] = []
  for (const item of content) {
    const doc = asRecord(item)
    if (doc === null) continue
    if (doc.type === 'text' && typeof doc.text === 'string') {
      parts.push(doc.text)
      continue
    }
    if (typeof doc.type === 'string') parts.push(`[${doc.type} 类型的内容，纯文本结果里显示不了]`)
  }
  return parts.length === 0 ? '（这次调用没有返回内容）' : parts.join('\n')
}
