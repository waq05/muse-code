/**
 * MCP 客户端（官方插件）：把配置里的 MCP server 接进来，工具挂成
 * `mcp__<server>__<tool>` 注册进 `ctx.tools`，返回值一律先过防注入围栏。
 *
 * **连接全在后台跑**：`src/host/kernel.ts` 是 `await root.plugin(...)`，
 * 一个起不来的 server 如果在 apply 里等它，会把整个 createKernel 一起拖住。
 * 所以状态经 `servers()` 暴露，失败写一条会话流说明，并按退避重连；
 * 一个 server 连不上不影响其它 server，也不影响宿主。
 *
 * 服务器清单只能在设置里存成一行 JSON（设置控件只有单行 text，摆不下多行结构），
 * 保存时整份解析校验，任何一项不合法就整份拒收并指出第几项哪里不对。
 *
 * @module dsc/plugins/mcp
 */
import type { Plugin } from '@deepseek-ai/cordis'
import {
  asRisk,
  mcpToolName,
  openConnection,
  parseServerList,
  riskOf,
  type McpCapabilities,
  type McpConnection,
  type McpRisk,
  type McpServerConfig,
  type McpToolSpec,
} from '../core/mcp.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import { wrapUntrusted } from '../core/untrusted.js'
import { argsSummary, type ToolEntry } from '../core/tools.js'
import type { SettingsField, SettingsValues } from '../contract.js'
import type { McpServerInfo, McpService, McpToolInfo, SettingsSectionSpec } from '../services/types.js'

/** 插件在 `~/.dsc/plugins.json` 条目树里的键（设置分区 id 也是它）。 */
const CONFIG_KEY = 'mcp'

/** 权限模块读取的可调值；全部能在设置分区里改。 */
interface McpPluginConfig {
  /** 服务器清单一整行 JSON（见 parseServerList）。 */
  servers: string
  /** 清单里没写 defaultRisk 的 server 用哪一档。 */
  defaultRisk: McpRisk
  /** 单次请求超时（毫秒）。 */
  callTimeoutMs: number
  /** initialize 握手超时（毫秒）。 */
  connectTimeoutMs: number
  reconnect: boolean
  reconnectInitialDelayMs: number
  reconnectMaxDelayMs: number
  reconnectMaxAttempts: number
}

/** 缺省值：工具风险保守标 exec（未配置的 MCP 工具宁可直接弹审批卡）。 */
const DEFAULTS: McpPluginConfig = {
  servers: '[]',
  defaultRisk: 'exec',
  callTimeoutMs: 60_000,
  connectTimeoutMs: 20_000,
  reconnect: true,
  reconnectInitialDelayMs: 1000,
  reconnectMaxDelayMs: 30_000,
  reconnectMaxAttempts: 5,
}

/** 超时类可调值的夹取范围。 */
const TIMEOUT_MIN_MS = 1000
const TIMEOUT_MAX_MS = 600_000

/** 连续重试次数的夹取范围。 */
const ATTEMPTS_MIN = 1
const ATTEMPTS_MAX = 50

/** 一个 server 在此刻的运行时状态。 */
interface ServerState {
  /** 这份配置（含已解析好的 defaultRisk）。 */
  config: McpServerConfig
  /** 给 `servers()` 看的那份投影，就地在它上面改。 */
  info: McpServerInfo
  /** 当前这条连接；连上之前与掉线之后都是 undefined。 */
  connection: McpConnection | undefined
  /** 这个 server 现在有哪些工具（与有没有注册进 ctx.tools 无关）。 */
  tools: McpToolInfo[]
  /** T24：这个 server 声明的能力（连接握手时读到；没连上全是 false）。 */
  capabilities: McpCapabilities
  /** 已注册进 ctx.tools 的工具的清理函数，按完整工具名索引。 */
  disposers: Map<string, () => void>
  /** 连续失败次数，成功一次清零。 */
  failures: number
  /** 挂着的那次重连计时器。 */
  timer: NodeJS.Timeout | undefined
  /** true = 这个 state 已经作废（配置改了或插件卸了），回调一律不再理它。 */
  closed: boolean
}

/** 状态灯的中文说法（设置分区的「现在的状态」那一行）。 */
const STATE_LABELS: Record<McpServerInfo['state'], string> = {
  ready: '已连上',
  connecting: '正在连',
  failed: '没连上',
}

/** 读配置：装配时传进来的那份作底，磁盘上那份覆盖它（改完设置不必重启宿主）。 */
function readConfig(passed?: unknown): McpPluginConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const risk = asRisk(raw.defaultRisk)
  return {
    servers: typeof raw.servers === 'string' ? raw.servers : DEFAULTS.servers,
    defaultRisk: risk ?? DEFAULTS.defaultRisk,
    callTimeoutMs: clamp(raw.callTimeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, DEFAULTS.callTimeoutMs),
    connectTimeoutMs: clamp(raw.connectTimeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, DEFAULTS.connectTimeoutMs),
    reconnect: typeof raw.reconnect === 'boolean' ? raw.reconnect : DEFAULTS.reconnect,
    reconnectInitialDelayMs: clamp(raw.reconnectInitialDelayMs, 1, TIMEOUT_MAX_MS, DEFAULTS.reconnectInitialDelayMs),
    reconnectMaxDelayMs: clamp(raw.reconnectMaxDelayMs, 1, TIMEOUT_MAX_MS, DEFAULTS.reconnectMaxDelayMs),
    reconnectMaxAttempts: clamp(raw.reconnectMaxAttempts, ATTEMPTS_MIN, ATTEMPTS_MAX, DEFAULTS.reconnectMaxAttempts),
  }
}

/** 数字类配置的兜底：不是有限数就用缺省，否则夹进范围。 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(Math.max(Math.round(num), min), max)
}

/** 把 server 返回的工具定义起成目录项（完整名、风险等级都在这儿定）。 */
function toToolInfo(server: McpServerConfig, spec: McpToolSpec): McpToolInfo {
  return {
    name: mcpToolName(server.name, spec.name),
    server: server.name,
    tool: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    risk: riskOf(server, spec.name),
  }
}

/** 连接参数：只有这几个变了才值得断开重连，风险等级变了现改就行。 */
function connectionKey(server: McpServerConfig): string {
  return JSON.stringify([server.transport, server.command, server.args, server.cwd, server.env, server.url, server.headers])
}

export const mcpPlugin: Plugin.Object = {
  name: 'mcp',
  // approval：T24 elicitation——server 反向要确认时走审批卡
  inject: ['tools', 'transcript', 'settings', 'prompt', 'approval'],
  apply(ctx, passed: unknown) {
    let deferred = false
    const states = new Map<string, ServerState>()
    /** 全部 server 的工具，按完整工具名索引（渐进披露的检索对象）。 */
    const catalog = new Map<string, McpToolInfo>()
    /** T37：每个 server 挂在系统提示里的 instructions 段的退订函数。 */
    const instructionDisposers = new Map<string, () => void>()
    /** T24：mcp_resources / mcp_prompts 两个全局工具的退订函数（按能力在场）。 */
    const capabilityDisposers = new Map<string, () => void>()
    /** instructions 的字符上限（dsh 的 server-context 同一量级：交代用法，不塞整本手册）。 */
    const INSTRUCTIONS_CAP = 4_000

    // 先把服务挂上再连：晚一步就有人会读到 undefined
    const offService = ctx.provide('mcp', buildService())
    const offSection = ctx.settings.registerSection(buildSection())
    // 宿主退出时只发事件就退进程，不走 cordis 卸载：子进程得在这一步收掉，
    // 否则每退一次 Muse Code 就留一群 MCP server 在后台
    const offExit = ctx.on('dsc/exit', () => {
      for (const name of [...states.keys()]) stopServer(name)
    })

    const startup = parseConfig()
    if (startup.problem !== null) {
      ctx.transcript.system(`MCP 的服务器清单读不了，这次一个都没连：${startup.problem}`)
    } else {
      for (const server of startup.servers) startServer(server)
    }

    return () => {
      offExit()
      offSection()
      for (const dispose of capabilityDisposers.values()) dispose()
      capabilityDisposers.clear()
      for (const name of [...states.keys()]) stopServer(name)
      offService()
    }

    // ── 能力面 ──────────────────────────────────────────────────────────────

    function buildService(): McpService {
      return {
        servers: (): McpServerInfo[] => [...states.values()].map((state) => ({ ...state.info })),
        tools: (): McpToolInfo[] => [...catalog.values()],
        call: (name, args, signal) => callTool(name, args, signal),
        deferSchemas: (): void => {
          // 由工具目录的持有者（Tool Search）决定谁留在台面上；重复调用是空操作。
          // 撤的只是「动手类」（write / exec）的 schema，见 applyTools。
          deferred = true
          for (const state of states.values()) applyTools(state)
        },
      }
    }

    /**
     * 按完整工具名调一次。结果先进围栏再回模型；server 报错时也要包完再抛，
     * 免得把外部文本原样塞进错误消息。
     */
    async function callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
      const tool = catalog.get(name)
      if (tool === undefined) throw new Error(`没有这个 MCP 工具：${name}`)
      const state = states.get(tool.server)
      const connection = state?.connection
      if (connection === undefined || !connection.alive) {
        const problem = state?.info.problem
        throw new Error(`MCP server ${tool.server} 现在没连上${problem === undefined ? '' : `：${problem}`}`)
      }
      const result = await connection.callTool(tool.tool, args, signal)
      const text = wrapUntrusted(`mcp:${tool.server}`, result.text)
      if (result.isError) throw new Error(text)
      return text
    }

    // ── 工具注册 ────────────────────────────────────────────────────────────

    function rebuildCatalog(): void {
      catalog.clear()
      for (const state of states.values()) {
        for (const tool of state.tools) catalog.set(tool.name, tool)
      }
    }

    function dropTools(state: ServerState): void {
      for (const dispose of state.disposers.values()) dispose()
      state.disposers.clear()
      // T37：工具撤下了，说明段落也跟着摘（连接断了还留着旧的用法说明只会误导模型）
      instructionDisposers.get(state.config.name)?.()
      instructionDisposers.delete(state.config.name)
    }

    /** T37：连接就绪后把 server 的 instructions 挂进系统提示（有就挂，空串不挂）。 */
    function syncInstructions(state: ServerState): void {
      instructionDisposers.get(state.config.name)?.()
      instructionDisposers.delete(state.config.name)
      const declared = (state.connection?.instructions ?? '').trim()
      if (declared === '') return
      const clipped =
        declared.length > INSTRUCTIONS_CAP ? `${declared.slice(0, INSTRUCTIONS_CAP)}…（说明过长已截断）` : declared
      instructionDisposers.set(
        state.config.name,
        ctx.prompt.register(
          `mcp-instructions-${state.config.name}`,
          () => `MCP 服务器「${state.config.name}」对自己工具的用法交代：\n${clipped}`,
          { order: 55 },
        ),
      )
    }

    // ── T24：resources / prompts 两个全局工具 ───────────────────────────────

    /** 挑出目标 server：带名字就只那一个（报错给模型看），不带就是全部还连着的。 */
    function pickStates(serverName: string): ServerState[] {
      if (serverName === '') {
        return [...states.values()].filter((state) => state.connection?.alive === true)
      }
      const state = states.get(serverName)
      if (state === undefined || state.connection?.alive !== true) {
        throw new Error(`没有叫 ${serverName} 且已连上的 MCP server（能用的：${[...states.keys()].join('、') || '无'}）`)
      }
      return [state]
    }

    /** 任一 server 声明了对应能力才注册对应工具；最后一个支持它的 server 掉线就撤。 */
    function syncCapabilityTools(): void {
      const anyResources = [...states.values()].some((state) => state.capabilities.resources && !state.closed)
      const anyPrompts = [...states.values()].some((state) => state.capabilities.prompts && !state.closed)
      const want = new Set<string>([
        ...(anyResources ? ['mcp_resources'] : []),
        ...(anyPrompts ? ['mcp_prompts'] : []),
      ])
      for (const [name, dispose] of [...capabilityDisposers]) {
        if (!want.has(name)) {
          dispose()
          capabilityDisposers.delete(name)
        }
      }
      if (want.has('mcp_resources') && !capabilityDisposers.has('mcp_resources')) {
        capabilityDisposers.set('mcp_resources', ctx.tools.register(resourcesTool()))
      }
      if (want.has('mcp_prompts') && !capabilityDisposers.has('mcp_prompts')) {
        capabilityDisposers.set('mcp_prompts', ctx.tools.register(promptsTool()))
      }
    }

    /** 列资源 / 读资源。list 不带 server 列全部；read 必须指明 server 与 uri。 */
    async function runResources(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
      const action = String(args.action ?? 'list')
      if (action === 'list') {
        const targets = pickStates(String(args.server ?? '')).filter((state) => state.capabilities.resources)
        if (targets.length === 0) return '（现在没有任何已连上的 server 声明 resources 能力）'
        const lines: string[] = []
        for (const state of targets) {
          const listed = await state.connection!.listResources(signal)
          lines.push(`「${state.config.name}」${listed.length} 个资源：`)
          for (const resource of listed) {
            lines.push(
              `- ${resource.name}（uri: ${resource.uri}${resource.mimeType === '' ? '' : `，${resource.mimeType}`}）${resource.description}`,
            )
          }
          state.info = { ...state.info, resources: listed.length }
        }
        return wrapUntrusted('mcp-resources', lines.join('\n'))
      }
      if (action === 'read') {
        const uri = String(args.uri ?? '')
        if (uri === '') return 'read 要带上 uri（list 里看到的那个）'
        const [state] = pickStates(String(args.server ?? ''))
        const read = await state.connection!.readResource(uri, signal)
        return wrapUntrusted(`mcp-resource:${state.config.name}`, read.text)
      }
      return `不认识的 action「${action}」。要用的值：list / read`
    }

    /** 列提示模板 / 取一份模板。get 要 server + name；模板参数按 list 给的名单填。 */
    async function runPrompts(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
      const action = String(args.action ?? 'list')
      if (action === 'list') {
        const targets = pickStates(String(args.server ?? '')).filter((state) => state.capabilities.prompts)
        if (targets.length === 0) return '（现在没有任何已连上的 server 声明 prompts 能力）'
        const lines: string[] = []
        for (const state of targets) {
          const listed = await state.connection!.listPrompts(signal)
          lines.push(`「${state.config.name}」${listed.length} 个提示模板：`)
          for (const prompt of listed) {
            lines.push(
              `- ${prompt.name}${prompt.arguments.length === 0 ? '' : `（参数：${prompt.arguments.join('、')}）`} ${prompt.description}`,
            )
          }
          state.info = { ...state.info, prompts: listed.length }
        }
        return wrapUntrusted('mcp-prompts', lines.join('\n'))
      }
      if (action === 'get') {
        const name = String(args.name ?? '')
        if (name === '') return 'get 要带上模板名（list 里看到的那个）'
        const [state] = pickStates(String(args.server ?? ''))
        const rawArguments = asRecord(args.arguments) ?? {}
        const templateArguments: Record<string, string> = {}
        for (const [key, value] of Object.entries(rawArguments)) templateArguments[key] = String(value)
        const got = await state.connection!.getPrompt(name, templateArguments, signal)
        return wrapUntrusted(`mcp-prompt:${state.config.name}`, got.text)
      }
      return `不认识的 action「${action}」。要用的值：list / get`
    }

    function resourcesTool(): ToolEntry {
      return {
        name: 'mcp_resources',
        description:
          '列出已连上 MCP server 暴露的资源（resources/list），或读一份资源的内容（resources/read）。' +
          '资源是 server 侧的文件/数据（文档、配置、日志…）；先 list 看到 uri，再 read 按 uri 取内容。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'read'], description: '要做什么' },
            server: { type: 'string', description: 'MCP server 名；list 不填 = 全部，read 必填' },
            uri: { type: 'string', description: 'read 必填：资源的 uri' },
          },
          required: ['action'],
        },
        risk: 'read',
        run: (args, runCtx) => runResources(args, runCtx.signal),
      }
    }

    function promptsTool(): ToolEntry {
      return {
        name: 'mcp_prompts',
        description:
          '列出已连上 MCP server 提供的提示模板（prompts/list），或取一份模板的完整内容（prompts/get）。' +
          '模板是 server 预制的高质量提问/任务书；get 时按 list 给的参数名单填 arguments。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'get'], description: '要做什么' },
            server: { type: 'string', description: 'MCP server 名；list 不填 = 全部，get 必填' },
            name: { type: 'string', description: 'get 必填：模板名' },
            arguments: { type: 'object', description: 'get 可选：模板参数，形如 {"语言":"中文"}' },
          },
          required: ['action'],
        },
        risk: 'read',
        run: (args, runCtx) => runPrompts(args, runCtx.signal),
      }
    }

    /**
     * 把这个 server 的工具挂进 ctx.tools；已经撤下 schema 时只挂只读那几条。
     *
     * 撤下只针对「动手类」（write / exec）：只读工具留在台面上才有免审批的资格；
     * 把它们一起撤掉，等于把每次读也推去走 tool_call 的 exec 审批卡，反倒更烦。
     */
    function applyTools(state: ServerState): void {
      dropTools(state)
      for (const tool of state.tools) {
        if (deferred && tool.risk !== 'read') continue
        const entry: ToolEntry = {
          name: tool.name,
          description: `（MCP server：${tool.server}）${tool.description}`,
          parameters: tool.parameters,
          risk: tool.risk,
          run: (args, runCtx) => callTool(tool.name, args, runCtx.signal),
        }
        state.disposers.set(tool.name, ctx.tools.register(entry))
      }
    }

    // ── 连接与重连 ──────────────────────────────────────────────────────────

    function startServer(server: McpServerConfig): void {
      const state: ServerState = {
        config: server,
        info: { name: server.name, transport: server.transport, tools: 0, state: 'connecting' },
        connection: undefined,
        tools: [],
        capabilities: { resources: false, prompts: false },
        disposers: new Map(),
        failures: 0,
        timer: undefined,
        closed: false,
      }
      states.set(server.name, state)
      void connect(state)
    }

    function stopServer(name: string): void {
      const state = states.get(name)
      if (state === undefined) return
      states.delete(name)
      state.closed = true
      if (state.timer !== undefined) clearTimeout(state.timer)
      dropTools(state)
      state.connection?.close()
      state.connection = undefined
      state.tools = []
      rebuildCatalog()
      syncCapabilityTools()
    }

    async function connect(state: ServerState): Promise<void> {
      if (state.closed) return
      const hadFailed = state.info.state === 'failed'
      state.info.state = 'connecting'
      delete state.info.problem
      // 连接对象要能认出「这条是不是当前这条」，所以先留一个盒子再填
      const box: { value: McpConnection | undefined } = { value: undefined }
      const current = readConfig(passed)
      try {
        const connection = await openConnection(state.config, {
          connectTimeoutMs: current.connectTimeoutMs,
          callTimeoutMs: current.callTimeoutMs,
          onClose: () => {
            onConnectionClosed(state, box.value)
          },
          // T24：server 反向发起 elicitation 时走审批卡——卡上写明是哪个 server 在要确认、
          // 它说明了什么；同意回 accept，拒绝回 decline。等卡期间连接断了就走 abort。
          onElicitation: async (request) => {
            const schemaText =
              Object.keys(request.requestedSchema).length === 0 ? '' : ` 参数结构：${JSON.stringify(request.requestedSchema)}`
            const decision = await ctx.approval.decide(
              {
                toolName: `MCP elicitation · ${state.config.name}`,
                argsSummary: `${state.config.name} 请求确认：${request.message}${schemaText}`,
                args: { message: request.message, requestedSchema: request.requestedSchema },
                cwd: '',
              },
              AbortSignal.timeout(ELICITATION_TIMEOUT_MS),
            )
            return decision === 'reject' ? { action: 'decline' } : { action: 'accept' }
          },
        })
        box.value = connection
        const specs = await connection.listTools(new AbortController().signal)
        if (state.closed) {
          connection.close()
          return
        }
        state.connection = connection
        state.capabilities = connection.capabilities
        state.tools = specs.map((spec) => toToolInfo(state.config, spec))
        state.info.tools = state.tools.length
        state.info.state = 'ready'
        state.failures = 0
        rebuildCatalog()
        applyTools(state)
        syncInstructions(state)
        syncCapabilityTools()
        // T24：资源与提示的条数是「连上后再补一轮列表」才知道的——异步补，
        // 不阻塞 ready 状态；server 没声明对应能力就不白跑这一趟。
        if (state.capabilities.resources) void countResources(state)
        if (state.capabilities.prompts) void countPrompts(state)
        if (hadFailed) {
          ctx.transcript.system(`MCP server ${state.config.name} 重新连上了，带了 ${state.tools.length} 个工具`)
        }
      } catch (error) {
        box.value = undefined
        markFailed(state, errorText(error))
      }
    }

  /** 连接自己断了：只有「还在用的那条」配得上把状态打成失败。 */
  function onConnectionClosed(state: ServerState, connection: McpConnection | undefined): void {
    if (state.closed) return
    if (connection === undefined || state.connection !== connection) return
    state.connection = undefined
    markFailed(state, '连接断了')
  }

  /** T24：连上后补拉资源清单，条数写进状态投影（失败静默——状态行少个数而已）。 */
  async function countResources(state: ServerState): Promise<void> {
    try {
      const connection = state.connection
      if (connection === undefined || !connection.alive) return
      const listed = await connection.listResources(new AbortController().signal)
      if (!state.closed && state.connection === connection) state.info = { ...state.info, resources: listed.length }
    } catch {
      // 有些 server 声明了能力但列表为空/报错：不影响工具与连接本身
    }
  }

  /** T24：同 {@link countResources}，补的是提示模板条数。 */
  async function countPrompts(state: ServerState): Promise<void> {
    try {
      const connection = state.connection
      if (connection === undefined || !connection.alive) return
      const listed = await connection.listPrompts(new AbortController().signal)
      if (!state.closed && state.connection === connection) state.info = { ...state.info, prompts: listed.length }
    } catch {
      // 同上
    }
  }

  function markFailed(state: ServerState, message: string): void {
    if (state.closed) return
    const first = state.info.state !== 'failed'
    state.info.state = 'failed'
    state.info.problem = message
    state.info.tools = 0
    state.connection = undefined
    state.capabilities = { resources: false, prompts: false }
    state.tools = []
    rebuildCatalog()
    dropTools(state)
    syncCapabilityTools()
    // 同一次掉线只报第一回；反复重试失败不再刷屏，放弃时另有一条
    if (first) ctx.transcript.system(`MCP server ${state.config.name} 没连上：${message}`)
    scheduleReconnect(state)
  }

    function scheduleReconnect(state: ServerState): void {
      const current = readConfig(passed)
      if (state.closed || !current.reconnect) return
      state.failures += 1
      if (state.failures > current.reconnectMaxAttempts) {
        ctx.transcript.system(
          `MCP server ${state.config.name} 连续 ${current.reconnectMaxAttempts} 次没连上，先不重试了。` +
            '改完配置到设置里点「重连全部服务器」，或者重启 Muse Code。',
        )
        return
      }
      const delay = Math.min(
        current.reconnectMaxDelayMs,
        current.reconnectInitialDelayMs * 2 ** (state.failures - 1),
      )
      const timer = setTimeout(() => {
        state.timer = undefined
        void connect(state)
      }, delay)
      state.timer = timer
      // 挂着的重试不能把宿主进程钉住不退出
      timer.unref()
    }

    // ── 配置变更 ────────────────────────────────────────────────────────────

    function parseConfig(): ReturnType<typeof parseServerList> {
      const current = readConfig(passed)
      return parseServerList(current.servers, current.defaultRisk)
    }

    /** 配置改完之后对齐一遍：连接参数变了的重连，只改了风险等级的现改。 */
    function applyConfig(): void {
      const parsed = parseConfig()
      if (parsed.problem !== null) {
        ctx.transcript.system(`MCP 的服务器清单读不了，沿用现在这些连接：${parsed.problem}`)
        return
      }
      const wanted = new Map(parsed.servers.map((server) => [server.name, server]))
      for (const [name, state] of [...states]) {
        const next = wanted.get(name)
        if (next === undefined || connectionKey(next) !== connectionKey(state.config)) {
          stopServer(name)
          continue
        }
        if (JSON.stringify(next) !== JSON.stringify(state.config)) {
          state.config = next
          state.tools = state.tools.map((tool) => ({ ...tool, risk: riskOf(next, tool.tool) }))
          rebuildCatalog()
          applyTools(state)
        }
      }
      for (const [name, server] of wanted) {
        if (!states.has(name)) startServer(server)
      }
    }

    /** 配置改完把还躺着的 server 推一把：用户修完东西点保存，不该还要重启宿才生效。 */
    function retryIdle(): void {
      for (const state of states.values()) {
        if (!state.closed && state.info.state === 'failed' && state.timer === undefined) {
          state.failures = 0
          void connect(state)
        }
      }
    }

    // ── 设置分区 ────────────────────────────────────────────────────────────

    function statusText(): string {
      const parsed = parseConfig()
      const lines: string[] = []
      if (parsed.problem !== null) lines.push(`清单有问题：${parsed.problem}`)
      for (const state of states.values()) {
        const info = state.info
        lines.push(
          `${info.name}（${info.transport}）：${STATE_LABELS[info.state]}，${info.tools} 个工具` +
            `${info.problem === undefined ? '' : `，${info.problem}`}`,
        )
      }
      if (lines.length === 0) lines.push('还没有配 server')
      return lines.join('\n')
    }

    function buildSection(): SettingsSectionSpec {
      const fields = (): SettingsField[] => [
        {
          type: 'text',
          key: 'servers',
          label: '服务器清单（一行 JSON）',
          mono: true,
          placeholder: '[{"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_TOKEN":""}}]',
          help:
            '一个数组，一项一个 server。stdio 写 name + command（+ args/cwd/env），' +
            'http 写 name + transport:"http" + url（+ headers）。' +
            'env 里的变量名会原样传进子进程；值留空串就从宿主环境取同名变量。' +
            '想给某个工具单独定风险等级，加 "risk":{"工具名":"read"}；' +
            '整个 server 的缺省档是 "defaultRisk"。保存时会整份校验。',
        },
        {
          type: 'select',
          key: 'defaultRisk',
          label: '没写 defaultRisk 的 server 用哪一档',
          options: [
            { value: 'exec', label: 'exec，每次都弹审批卡（推荐）' },
            { value: 'write', label: 'write，写类操作弹审批卡' },
            { value: 'read', label: 'read，直接放行（只读的 server 才选）' },
          ],
          help: 'MCP 工具是外面来的程序，拿不准它会做什么时保守一点。',
        },
        { type: 'number', key: 'callTimeoutMs', label: '单次调用超时（毫秒）', min: TIMEOUT_MIN_MS, max: TIMEOUT_MAX_MS, step: 1000 },
        { type: 'number', key: 'connectTimeoutMs', label: '握手超时（毫秒）', min: TIMEOUT_MIN_MS, max: TIMEOUT_MAX_MS, step: 1000 },
        { type: 'switch', key: 'reconnect', label: '掉线后自动重连' },
        { type: 'number', key: 'reconnectInitialDelayMs', label: '重连首次等待（毫秒）', min: 1, max: TIMEOUT_MAX_MS, step: 100 },
        { type: 'number', key: 'reconnectMaxDelayMs', label: '重连最长等待（毫秒）', min: 1, max: TIMEOUT_MAX_MS, step: 1000 },
        { type: 'number', key: 'reconnectMaxAttempts', label: '连续失败几次后放弃', min: ATTEMPTS_MIN, max: ATTEMPTS_MAX, step: 1 },
        { type: 'button', action: 'reload', label: '重连全部服务器', style: 'ghost', help: '断开现有连接重新连一遍，状态看下一行。' },
        { type: 'info', label: '现在的状态', text: statusText(), mono: true, copyable: true },
      ]

      return {
        id: CONFIG_KEY,
        title: 'MCP 服务器',
        subtitle: '把外部 MCP server 的工具接进模型',
        order: 47,
        fields,
        values: (): SettingsValues => {
          const current = readConfig(passed)
          return {
            servers: current.servers,
            defaultRisk: current.defaultRisk,
            callTimeoutMs: current.callTimeoutMs,
            connectTimeoutMs: current.connectTimeoutMs,
            reconnect: current.reconnect,
            reconnectInitialDelayMs: current.reconnectInitialDelayMs,
            reconnectMaxDelayMs: current.reconnectMaxDelayMs,
            reconnectMaxAttempts: current.reconnectMaxAttempts,
          }
        },
        // 校验不过一律抛错：settings 服务把「返回字符串」当成成功提示，
        // 只有抛出去才会变成界面上那条红色的「保存失败：原因」
        save: (key, value): void => {
          switch (key) {
            case 'servers': {
              const text = String(value)
              // 先按当前 defaultRisk 试解析：存进去的东西必须是能连起来的
              const parsed = parseServerList(text, readConfig(passed).defaultRisk)
              if (parsed.problem !== null) throw new Error(parsed.problem)
              writePluginConfig(CONFIG_KEY, { servers: text.trim() })
              break
            }
            case 'defaultRisk': {
              const risk = asRisk(value)
              if (risk === undefined) throw new Error(`defaultRisk 只能是 read、write 或 exec，收到 ${String(value)}`)
              writePluginConfig(CONFIG_KEY, { defaultRisk: risk })
              break
            }
            case 'callTimeoutMs':
            case 'connectTimeoutMs':
            case 'reconnectInitialDelayMs':
            case 'reconnectMaxDelayMs':
            case 'reconnectMaxAttempts': {
              const num = Number(value)
              if (!Number.isFinite(num)) throw new Error(`${key} 要填数字`)
              writePluginConfig(CONFIG_KEY, { [key]: Math.round(num) })
              break
            }
            case 'reconnect':
              writePluginConfig(CONFIG_KEY, { reconnect: value === true || value === 'true' })
              break
            default:
              throw new Error(`这个分区没有这项：${key}`)
          }
          applyConfig()
          retryIdle()
        },
        action: (name): string => {
          if (name !== 'reload') throw new Error(`这个分区没有这个按钮：${name}`)
          for (const key of [...states.keys()]) stopServer(key)
          const parsed = parseConfig()
          if (parsed.problem !== null) throw new Error(parsed.problem)
          for (const server of parsed.servers) startServer(server)
          return `已按配置重新发起连接：${parsed.servers.length} 个 server（连没连上看下一行）`
        },
      }
    }
  },
}

/** 错误对象取一句话。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 认得出是个对象就返回，否则 null（模板参数等宽松入参的兜底）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** T24：elicitation 等人点卡的上限（毫秒）——审批卡可以慢慢等，但不能永远挂着。 */
const ELICITATION_TIMEOUT_MS = 600_000
