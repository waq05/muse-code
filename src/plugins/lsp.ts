/**
 * lsp 插件：LSP 代码智能。**默认关**（会按需拉起语言服务器子进程，属于默认关那一档）。
 *
 * 形制照 dsh 的 `packages/lsp/*`（单工具按 operation 分发 + 无状态文档同步）
 * 加 hermes 的 `agent/lsp`（内置服务器表 + marker 找根 + idle 回收 + 退避 + 编辑后诊断注入）：
 *   - 只暴露「导航」四件事：goToDefinition / findReferences（含声明）/
 *     goToImplementation / hover；rename / codeAction / format 不做（要 ApplyEdit + 审批，
 *     且与 write/edit 重复）；
 *   - 同步策略：**读盘 → didOpen（全量）→ 请求 → didClose**，天然没有脏文档；
 *   - 生命周期：每 (server, root) 一进程 + 该 root 串行队列；idle 600s 回收（下限 30s）；
 *     启动失败对破键退避；60s 请求预算，取消先 `$/cancelRequest` 再宽限杀实例；
 *   - 降级永不抛错给模型：没装 / 起不来 / 初始化超时 / 无 root →
 *     「无数据 + 原因 + stderr 尾巴 30 行」。
 *
 * ## 诊断注入为什么落在「下一次请求」而不是 write 工具的输出里
 *
 * 观察者的签名是 `observe(toolName, text) => text`，**同步**——它没法在里面等一次 LSP 往返
 * （等不了，也没法把结果塞回这次的工具输出）。所以本插件用的是内核另一条现成通道：
 * 观察者只负责把「写后诊断」挂到后台，算完攒进 `pending`，由 `ctx.prompt.transformMessages`
 * 在下一次请求的末尾补一条 system 段（`core/lifecycle-hooks.ts` 的 PostToolUse 走的是同一条路）。
 * 于是：写前基线由守卫 order 7 同步排队（`decide` 只做「读盘 + 入队」，**不阻塞这一次写**），
 * 写后诊断由观察者 order 46 入队；两侧都排在同一个 (server, root) 串行队列上，
 * 顺序天然是「写前 → 写后」。判定用**行位移映射**（`buildLineShift`）后的集合差，
 * 只报本次改动**新引入**的 ERROR——被插入行推下去的旧报错不会当成新错误。
 *
 * 两个实测过的坑（自检必须覆盖）：
 *   - URI 必须**先解码成路径再比内外**（Node 的 `pathToFileURL` 产出 `file:///C:/…`，
 *     有的服务器回 `file:///c%3A/…`；盘符大小写、UNC、`%5C`、`%00` 都要过）；
 *   - 列偏移不用换算：JS 字符串长度天然是 UTF-16 code unit，只做一基/零基转换。
 *
 * 支撑模块（本插件独占）：`src/core/lsp/{framing,client,servers,uri}.ts`
 *
 * @module dsc/plugins/lsp
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import type { ChatMessage } from '../core/llm.js'
import { wrapUntrusted } from '../core/untrusted.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import type { ToolGuardInput, ToolGuardVerdict, ToolObserver } from '../core/tool-guards.js'
import type { ToolContext } from '../core/tools.js'
import {
  type LspDiagnostic,
  type LspHover,
  type LspLocation,
  type LspOperation,
  type LspQueryOutcome,
  type LspStatusEntry,
  LSP_OPERATIONS,
  LspManager,
  buildLineShift,
  diagnosticKey,
  shiftDiagnostics,
} from '../core/lsp/client.js'
import {
  BUILTIN_SERVERS,
  type LspServerDef,
  type LspServerInfo,
  installHint,
  mergeServers,
  parseServerOverrides,
} from '../core/lsp/servers.js'
import { displayPath, toDisplayCharacter, toDisplayLine, toProtocolPosition } from '../core/lsp/uri.js'
import type { SettingsField, SettingsValue } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'

/** 插件在条目树里的键（设置分区 id 也是它）。 */
const CONFIG_KEY = 'lsp'

/** 单次结果条数上限的缺省与夹取范围。 */
const MAX_LOCATIONS_DEFAULT = 100
const MAX_LOCATIONS_MIN = 1
const MAX_LOCATIONS_MAX = 1000

/** 单次结果字符上限（条数截断之后再截它）。 */
const MAX_RESULT_CHARS = 16_000

/** idle 回收秒数的缺省与夹取范围（下限 30：比任何单次请求预算都长，免得杀到飞行中的查询）。 */
const IDLE_SECONDS_DEFAULT = 600
const IDLE_SECONDS_MIN = 30
const IDLE_SECONDS_MAX = 86_400

/** 诊断块的三个上限（照 hermes 的 reporter：每文件 20 条、总 4000 字符、字段各自截断）。 */
const DIAGNOSTIC_MAX_PER_FILE = 20
const DIAGNOSTIC_MAX_TOTAL_CHARS = 4_000
const DIAGNOSTIC_MESSAGE_MAX = 300
const DIAGNOSTIC_CODE_MAX = 80
const DIAGNOSTIC_SOURCE_MAX = 80

/** 诊断注入只报 ERROR（1）——WARN/INFO/HINT 全进上下文会把真正的报错淹掉。 */
const DIAGNOSTIC_ERROR_SEVERITY = 1

/** 严重度文案（服务器没给 severity 时按 ERROR 算）。 */
const SEVERITY_NAMES: Readonly<Record<number, string>> = {
  1: 'ERROR',
  2: 'WARN',
  3: 'INFO',
  4: 'HINT',
}

/** 诊断注入盯的工具：只有这两个会改文件内容。 */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit'])

/** 不拦截（交给下一位守卫）。 */
const DEFER: ToolGuardVerdict = { action: 'defer' }

/** 权限模块读取的可调值；全部能在设置分区里改。 */
interface LspPluginConfig {
  /** 总开关：关掉之后工具只回一句说明，也不做诊断注入（不必停用插件）。 */
  enabled: boolean
  /** 服务器清单的一整行 JSON（追加/覆盖内置表）。 */
  servers: string
  /** idle 回收秒数。 */
  idleSeconds: number
  /** 编辑后是否注入诊断。 */
  diagnostics: boolean
  /** 单次结果最多列几条。 */
  maxLocations: number
}

/** 缺省值。 */
const DEFAULTS: LspPluginConfig = {
  enabled: true,
  servers: '',
  idleSeconds: IDLE_SECONDS_DEFAULT,
  diagnostics: true,
  maxLocations: MAX_LOCATIONS_DEFAULT,
}

/** 工具与 `ctx.get('lsp')` 共用的能力面。 */
export interface LspService {
  /**
   * 查一次并返回已经过围栏与截断的文本（与 `lsp` 工具的返回一致）。
   *
   * @param operation - 四个操作之一。
   * @param filePath - 目标文件（相对路径按会话工作目录展开）。
   * @param line - 一基行号。
   * @param character - 一基列号。
   */
  query(operation: string, filePath: string, line: number, character: number): Promise<string>
  /** 每个服务器的状态与实例数。 */
  status(): LspStatusEntry[]
  /** 现在生效的服务器表（含「PATH 里有没有」）。 */
  servers(): LspServerInfo[]
}

/** 写前留底的那份状态：观察者拿不到参数，所以靠它把「刚写的是哪个文件、写前长什么样」传过去。 */
interface WriteRecord {
  /** 绝对路径（守卫给的 target 已经绝对化）。 */
  path: string
  /** 会话工作目录（解析相对路径、渲染相对路径都用它）。 */
  cwd: string
  /** 写前的文件内容（基线诊断就是按它算的）。 */
  preText: string
  /** 写前基线诊断的取数任务（在守卫里同步入队，观察者再去等它）。 */
  baseline: Promise<{ ok: boolean; diagnostics: LspDiagnostic[] }>
  at: number
}

export const lspPlugin: Plugin.Object = {
  name: 'lsp',
  inject: ['tools', 'settings', 'transcript', 'guards', 'prompt', 'session'],
  apply(ctx, passed: unknown) {
    /** 服务器表的解析缓存（key = 那一行 JSON 原文）。 */
    let serversCache: { text: string; defs: LspServerDef[]; problem: string | null } | undefined

    const manager: LspManager = new LspManager({
      servers: () => currentServers().defs,
      idleTimeoutMs: () => readConfig(passed).idleSeconds * 1000,
    })

    /** 最近一次写操作留的底（观察者只能从这里知道写的是哪个文件）。 */
    let lastWrite: WriteRecord | undefined
    /** 攒着等下一次请求补进去的诊断块。 */
    let pendingDiagnostics: string[] = []

    // ── 注册与退订 ──────────────────────────────────────────────────────────
    // 宿主退出时只发事件就退进程，不走 cordis 卸载：子进程得在这一步收掉，
    // 否则每退一次 dsc 就留一群语言服务器在后台（照 plugins/mcp.ts:151-155 的理由）。
    const offExit = ctx.on('dsc/exit', () => {
      manager.dispose()
    })
    const offTool = ctx.tools.register(buildTool())
    const offGuard = ctx.guards.register({
      id: 'lsp-observe',
      // 排在协作模式（10）与审批（30）之前：这里只记一份写前留底，不做任何拦阻。
      order: 7,
      decide: (input) => captureBaseline(input),
    })
    const offObserver = ctx.guards.registerObserver(buildObserver())
    const offTransform = ctx.prompt.transformMessages((messages: ChatMessage[]): ChatMessage[] => {
      if (pendingDiagnostics.length === 0) return messages
      const blocks = pendingDiagnostics
      pendingDiagnostics = []
      // 补在末尾是安全的：llm.ts 发送前会把散落的 system 并进头部那一条。
      return [...messages, { role: 'system', content: blocks.join('\n\n') }]
    })
    const offSection = ctx.settings.registerSection(buildSection())
    const offPrompt = ctx.prompt.register(
      'lsp',
      () => {
        if (!readConfig(passed).enabled) return ''
        return LSP_PROMPT_TEXT
      },
      { order: 42 },
    )
    // 服务先挂上：晚一步就有人会读到 undefined。
    const offService = ctx.provide('lsp', buildService())

    return () => {
      offExit()
      offService()
      offPrompt()
      offSection()
      offTransform()
      offObserver()
      offGuard()
      offTool()
      // 语言服务器子进程必须在这里收掉：不退就是一群孤儿进程。
      manager.dispose()
    }

    // ── 配置与服务器表 ──────────────────────────────────────────────────────

    /** 读配置：装配时传进来的那份作底，磁盘上那份覆盖它（改完设置不必重启宿主）。 */
    function readConfig(raw: unknown): LspPluginConfig {
      const source = resolvePluginConfig(CONFIG_KEY, raw)
      return {
        enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULTS.enabled,
        servers: typeof source.servers === 'string' ? source.servers : DEFAULTS.servers,
        idleSeconds: clamp(source.idleSeconds, IDLE_SECONDS_MIN, IDLE_SECONDS_MAX, DEFAULTS.idleSeconds),
        diagnostics:
          typeof source.diagnostics === 'boolean' ? source.diagnostics : DEFAULTS.diagnostics,
        maxLocations: clamp(source.maxLocations, MAX_LOCATIONS_MIN, MAX_LOCATIONS_MAX, DEFAULTS.maxLocations),
      }
    }

    /** 按那一行 JSON 现算服务器表；原文没变就用缓存（每次查询都会问一次）。 */
    function currentServers(): { defs: LspServerDef[]; problem: string | null } {
      const text = readConfig(passed).servers
      if (serversCache?.text === text) return serversCache
      const parsed = parseServerOverrides(text)
      serversCache = {
        text,
        defs: mergeServers(BUILTIN_SERVERS, parsed.servers),
        problem: parsed.problem,
      }
      return serversCache
    }

    // ── 工具 ────────────────────────────────────────────────────────────────

    function buildTool() {
      return {
        name: 'lsp',
        description:
          '按符号位置向语言服务器查代码智能（LSP）。operation 四选一：goToDefinition（定义）、' +
          'findReferences（全部引用，**结果包含声明本身**）、goToImplementation（实现）、hover（类型与文档）。' +
          'line 与 character 都是**一基**（第一行 = 1、第一列 = 1，character 按 UTF-16 码元数），' +
          '光标要落在符号上，落在空白处可能没有结果。返回的每条位置是 path:line:character（同样一基）。' +
          '普通导航优先用 grep / glob / read；只有文本匹配有歧义（同名符号、重载、动态派发）、' +
          '或改动前必须精确定位定义与引用时才用它。没装语言服务器时返回一句原因，不会报错。',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: [...LSP_OPERATIONS],
              description: 'goToDefinition / findReferences / goToImplementation / hover',
            },
            file_path: {
              type: 'string',
              description: '要查询的源文件（相对会话工作目录或绝对路径）',
            },
            line: { type: 'integer', description: '一基行号（第一行 = 1）' },
            character: { type: 'integer', description: '一基列号（第一列 = 1，按 UTF-16 码元数）' },
          },
          required: ['operation', 'file_path', 'line', 'character'],
        },
        // 只查询、不改文件：标 read 才能免审批直接放行。
        risk: 'read' as const,
        run: (args: Record<string, unknown>, runCtx: ToolContext) => runQuery(args, runCtx),
      }
    }

    /** 工具主体：**任何情况都返回文本**，绝不把异常抛给模型。 */
    async function runQuery(args: Record<string, unknown>, runCtx: ToolContext): Promise<string> {
      try {
        const config = readConfig(passed)
        if (!config.enabled) {
          return degradation('LSP 代码智能关着（设置 → LSP 代码智能 → 总开关）')
        }
        const operation = args.operation
        if (typeof operation !== 'string' || !isOperation(operation)) {
          return degradation(
            `没有数据：operation 只能是 ${LSP_OPERATIONS.join(' / ')}，收到 ${JSON.stringify(args.operation)}`,
          )
        }
        const filePath = args.file_path
        if (typeof filePath !== 'string' || filePath.trim() === '') {
          return degradation('没有数据：file_path 要是非空字符串')
        }
        let position
        try {
          position = toProtocolPosition(Number(args.line), Number(args.character))
        } catch (error) {
          return degradation(`没有数据：${errorText(error)}`)
        }
        const outcome = await manager.query(operation, filePath, position, runCtx.cwd, runCtx.signal)
        return renderOutcome(outcome, config, runCtx.cwd)
      } catch (error) {
        return degradation(`LSP 查询出错：${errorText(error)}`)
      }
    }

    /** 把查询结果渲染成给模型的文本（已经过围栏与两道上限）。 */
    function renderOutcome(outcome: LspQueryOutcome, config: LspPluginConfig, cwd: string): string {
      if (!outcome.ok) {
        const stderr = outcome.stderr === undefined || outcome.stderr === '' ? '' : `\nstderr 尾巴：\n${outcome.stderr}`
        return wrapUntrusted(`lsp:${outcome.server ?? 'none'}`, `没有数据：${outcome.reason}${stderr}`)
      }
      if (outcome.kind === 'hover') {
        return wrapUntrusted(
          `lsp:${outcome.server}`,
          boundResult(renderHover(outcome.hover, outcome.server, outcome.root, cwd), MAX_RESULT_CHARS, 'hover'),
        )
      }
      return wrapUntrusted(
        `lsp:${outcome.server}`,
        boundResult(renderLocations(outcome.locations, outcome.server, outcome.root, cwd), MAX_RESULT_CHARS, '定位结果'),
      )
    }

    /** locations：先按条数截断（附「还有 N 条未列出」），再按总字符截断；同一个文件的位置连在一起。 */
    function renderLocations(
      locations: readonly LspLocation[],
      server: string,
      root: string,
      cwd: string,
    ): string {
      const header = `找到 ${locations.length} 处（${server}${rootHint(root, cwd)}）`
      if (locations.length === 0) {
        return `${header}\n没有结果：光标可能不在符号上，或者这个符号没有定义/引用。`
      }
      const shown = locations.slice(0, readConfig(passed).maxLocations)
      // 按文件分组：保持「文件第一次出现」的顺序，同一文件的条目连成一块。
      const grouped = new Map<string, string[]>()
      for (const location of shown) {
        const path = displayPath(location.uri, cwd)
        const entry = `${path}:${toDisplayLine(location.range.start.line)}:${toDisplayCharacter(
          location.range.start.character,
        )}`
        const list = grouped.get(path)
        if (list === undefined) grouped.set(path, [entry])
        else list.push(entry)
      }
      const lines = [header]
      for (const entries of grouped.values()) lines.push(...entries)
      const omitted = locations.length - shown.length
      if (omitted > 0) lines.push(`… 还有 ${omitted} 条未列出（单次上限 ${readConfig(passed).maxLocations} 条）`)
      return lines.join('\n')
    }

    /** hover：把三种编码归并成一段文本；没有内容时给一句能自救的说明。 */
    function renderHover(hover: LspHover | null, server: string, root: string, cwd: string): string {
      const header = `悬停信息（${server}${rootHint(root, cwd)}）`
      if (hover === null || hover.contents.trim() === '') {
        return `${header}\n没有数据：这个位置没有悬停信息（光标可能不在符号上）。`
      }
      return `${header}\n${hover.contents}`
    }

    /** 项目根在文案里只出现一次，而且能在工作目录里显示成相对路径。 */
    function rootHint(root: string, cwd: string): string {
      return `，根 ${displayPath(root, cwd)}`
    }

    /** 降级文案：统一「没有数据：原因」，并且一样过围栏（stderr 与符号名都算外部文本）。 */
    function degradation(reason: string): string {
      return wrapUntrusted('lsp:none', `没有数据：${reason}`)
    }

    // ── 诊断注入：守卫记底 + 观察者挂后台 ────────────────────────────────────

    /**
     * 守卫：只读工具的 target 不记；写类工具在**动手之前**把写前内容读下来，
     * 并把基线诊断**同步入队**（不 await、不阻塞这一次写）。顺序由串行队列保证：
     * 这里入队的基线一定排在观察者那次「写后查询」前面，所以差集是干净的。
     */
    async function captureBaseline(input: ToolGuardInput): Promise<ToolGuardVerdict> {
      try {
        if (!WRITE_TOOLS.has(input.toolName)) return DEFER
        const target = input.target
        if (target === undefined) return DEFER
        const config = readConfig(passed)
        if (!config.enabled || !config.diagnostics) return DEFER
        // 这个文件现在就没有可用服务器（没装 / 没根 / 刚破键）时什么都别做，
        // 免得每次写文件都白起一次进程、白等一次超时。
        if (!manager.canServe(target, input.cwd)) return DEFER
        const preText = readText(target)
        if (preText === undefined) return DEFER
        const baseline = manager.diagnostics(target, input.cwd, preText)
        lastWrite = {
          path: target,
          cwd: input.cwd,
          preText,
          baseline: baseline.then((outcome) => ({
            ok: outcome.ok,
            diagnostics: outcome.ok ? outcome.diagnostics : [],
          })),
          at: Date.now(),
        }
      } catch {
        // 守卫抛错会被链按 deny 处理——LSP 这点事绝不该拦住一次写，所以这里自己吞掉。
        return DEFER
      }
      return DEFER
    }

    /**
     * 观察者：拿到刚写的那个文件（守卫留的底），把「写后诊断对写前基线的差集」挂到后台算。
     * 同步返回原文本——异步结果由 `transformMessages` 补进下一次请求。
     */
    function buildObserver(): ToolObserver {
      return {
        id: 'lsp',
        order: 46,
        observe(toolName: string, text: string): string {
          try {
            if (!WRITE_TOOLS.has(toolName)) return text
            const record = lastWrite
            lastWrite = undefined
            if (record === undefined) return text
            void injectDiagnostics(record).catch(() => {
              // 诊断注入是附赠信息，静默失败即可：绝不能让它的异常影响工具结果。
            })
          } catch {
            // 同上
          }
          return text
        },
      }
    }

    /** 写后取数 → 行位移 → 集合差 → 攒进 pending（下一次请求带上）。 */
    async function injectDiagnostics(record: WriteRecord): Promise<void> {
      const config = readConfig(passed)
      if (!config.enabled || !config.diagnostics) return
      const postText = readText(record.path)
      if (postText === undefined) return
      const baseline = await record.baseline
      if (!baseline.ok) return
      const post = await manager.diagnostics(record.path, record.cwd, postText)
      if (!post.ok) return
      const shift = buildLineShift(record.preText, postText)
      const seen = new Set(shiftDiagnostics(baseline.diagnostics, shift).map(diagnosticKey))
      const fresh = post.diagnostics.filter(
        (item) => item.severity === DIAGNOSTIC_ERROR_SEVERITY && !seen.has(diagnosticKey(item)),
      )
      if (fresh.length === 0) return
      const block = formatDiagnosticBlock(record.path, fresh, record.cwd)
      pendingDiagnostics.push(block)
      ctx.transcript.system(
        `lsp：${displayPath(record.path, record.cwd)} 这次改动新引入 ${fresh.length} 条 ERROR` +
          '（明细附在下一次请求里）',
      )
    }

    /** 一个 `<diagnostics file=…>` 段：每行 `ERROR [行:列] 消息 [code] (source)`，字段全部转义 + 截断。 */
    function formatDiagnosticBlock(
      filePath: string,
      diagnostics: readonly LspDiagnostic[],
      cwd: string,
    ): string {
      const header = `<diagnostics file="${escapeText(displayPath(filePath, cwd), true)}">`
      const footer = '</diagnostics>'
      // 4000 字符是**整块**的预算，所以先把头尾与「还有 N 条」的位置留出来，再逐条塞。
      const budget = DIAGNOSTIC_MAX_TOTAL_CHARS - header.length - footer.length - 1
      const lines: string[] = []
      let used = 0
      let listed = 0
      for (const item of diagnostics.slice(0, DIAGNOSTIC_MAX_PER_FILE)) {
        const line = renderDiagnostic(item)
        if (used + line.length + 1 > budget) break
        lines.push(line)
        used += line.length + 1
        listed += 1
      }
      const dropped = diagnostics.length - listed
      if (dropped > 0) lines.push(`… 还有 ${dropped} 条未列出`)
      return `${header}\n${lines.join('\n')}\n${footer}`
    }

    /** 一条诊断压成一行（字段截断 + HTML 转义：消息与标识符都来自用户代码，属外部文本）。 */
    function renderDiagnostic(item: LspDiagnostic): string {
      const severity = SEVERITY_NAMES[item.severity] ?? 'ERROR'
      const line = toDisplayLine(item.range.start.line)
      const column = toDisplayCharacter(item.range.start.character)
      const message = sanitizeField(item.message, DIAGNOSTIC_MESSAGE_MAX)
      const code = item.code === undefined ? '' : ` [${sanitizeField(item.code, DIAGNOSTIC_CODE_MAX)}]`
      const source = item.source === undefined ? '' : ` (${sanitizeField(item.source, DIAGNOSTIC_SOURCE_MAX)})`
      return `${severity} [${line}:${column}] ${message}${code}${source}`
    }

    // ── 设置分区 ────────────────────────────────────────────────────────────

    function buildSection(): SettingsSectionSpec {
      const fields = (): SettingsField[] => {
        const problem = currentServers().problem
        return [
          {
            type: 'switch',
            key: 'enabled',
            label: '启用 LSP 代码智能',
            help: '关掉之后 lsp 工具只回一句说明，也不做编辑后诊断注入（不必停用整个插件）。',
          },
          {
            type: 'text',
            key: 'servers',
            label: '服务器清单（一行 JSON）',
            mono: true,
            placeholder: '[{"id":"python","command":"pylsp","extensions":[".py"],"markers":["pyproject.toml"]}]',
            help:
              '留空就用内置表（typescript / pyright / rust / go / clangd / json / yaml）。' +
              '一项一个服务器：id + command 必填，extensions 必填（认领的扩展名），' +
              'args / markers / languageId 可省。同 id 覆盖内置项，新 id 排在内置项前面（先认领扩展名）。' +
              (problem === null ? '' : ` 现在这份读不了：${problem}`),
          },
          {
            type: 'number',
            key: 'idleSeconds',
            label: '空闲多久回收语言服务器（秒）',
            min: IDLE_SECONDS_MIN,
            max: IDLE_SECONDS_MAX,
            step: 30,
            help: '下限 30 秒：比单次请求预算还短的话会杀到正在跑的查询。',
          },
          {
            type: 'switch',
            key: 'diagnostics',
            label: '编辑后注入新引入的报错',
            help: '写文件前取一次基线，写后再取一次，只报本次新引入的 ERROR（明细附在下一次请求里）。',
          },
          {
            type: 'number',
            key: 'maxLocations',
            label: '单次结果条数上限',
            min: MAX_LOCATIONS_MIN,
            max: MAX_LOCATIONS_MAX,
            step: 10,
            help: '超过就截断并注明「还有 N 条未列出」；之后还会按 16000 字符再截一次。',
          },
          { type: 'button', action: 'status', label: '看服务器状态', style: 'ghost' },
          { type: 'info', label: '现在的情况', text: statusText(), mono: true, copyable: true },
        ]
      }

      return {
        id: CONFIG_KEY,
        title: 'LSP 代码智能',
        subtitle: '连语言服务器查定义与引用，并把本次编辑新引入的报错附在下一次请求里',
        order: 33,
        fields,
        values: (): Record<string, SettingsValue> => {
          const config = readConfig(passed)
          return {
            enabled: config.enabled,
            servers: config.servers,
            idleSeconds: config.idleSeconds,
            diagnostics: config.diagnostics,
            maxLocations: config.maxLocations,
          }
        },
        // 校验不过一律抛错：settings 服务把「返回字符串」当成成功提示，
        // 只有抛出去才会变成界面上那条红色的「保存失败：原因」。
        save: (key, value): void => {
          switch (key) {
            case 'enabled':
              writePluginConfig(CONFIG_KEY, { enabled: value === true || value === 'true' })
              break
            case 'diagnostics':
              writePluginConfig(CONFIG_KEY, { diagnostics: value === true || value === 'true' })
              break
            case 'servers': {
              const text = String(value)
              // 先试解析：存进去的东西必须是能用的，半份清单不如不存。
              const parsed = parseServerOverrides(text)
              if (parsed.problem !== null) throw new Error(parsed.problem)
              writePluginConfig(CONFIG_KEY, { servers: text.trim() })
              break
            }
            case 'idleSeconds': {
              const seconds = Number(value)
              if (!Number.isFinite(seconds)) throw new Error('idleSeconds 要填数字')
              writePluginConfig(CONFIG_KEY, {
                idleSeconds: Math.round(Math.min(Math.max(seconds, IDLE_SECONDS_MIN), IDLE_SECONDS_MAX)),
              })
              break
            }
            case 'maxLocations': {
              const count = Number(value)
              if (!Number.isFinite(count)) throw new Error('maxLocations 要填数字')
              writePluginConfig(CONFIG_KEY, {
                maxLocations: Math.round(Math.min(Math.max(count, MAX_LOCATIONS_MIN), MAX_LOCATIONS_MAX)),
              })
              break
            }
            default:
              throw new Error(`这个分区没有这项：${key}`)
          }
          serversCache = undefined
        },
        action: (name): string => {
          if (name !== 'status') throw new Error(`这个分区没有这个按钮：${name}`)
          return statusText()
        },
      }
    }

    /** 「看服务器状态」与 info 那一行共用的一句文案。 */
    function statusText(): string {
      const parsed = currentServers()
      if (parsed.problem !== null) return `服务器清单读不了：${parsed.problem}`
      const entries = manager.status()
      if (entries.length === 0) return '服务器表是空的（把内建表也覆盖没了？）'
      const parts = entries.map((entry) => describeEntry(entry))
      const ready = entries.filter((entry) => entry.available && entry.brokenSeconds === null).length
      return `${entries.length} 个服务器，${ready} 个可用：${parts.join('；')}`
    }

    /** 一个服务器在状态文案里的说法。 */
    function describeEntry(entry: LspStatusEntry): string {
      if (!entry.available) {
        const hint = installHint(entry.id)
        return `${entry.id} 没装（PATH 里没有 ${entry.command}${hint === undefined ? '' : `，${hint}`}）`
      }
      if (entry.brokenSeconds !== null) {
        return `${entry.id} 最近起不来（${entry.brokenSeconds} 秒后重试${entry.problem === undefined ? '' : `：${entry.problem}`}）`
      }
      if (entry.instances === 0) return `${entry.id} 可用，还没起进程`
      return `${entry.id} 有 ${entry.instances} 个实例`
    }

    // ── 对外服务（别的插件用 ctx.get('lsp') 读）──────────────────────────────

    function buildService(): LspService {
      return {
        query: async (operation, filePath, line, character): Promise<string> => {
          const cwd = sessionCwd()
          try {
            if (!isOperation(operation)) {
              return degradation(`没有数据：operation 只能是 ${LSP_OPERATIONS.join(' / ')}`)
            }
            const position = toProtocolPosition(line, character)
            const outcome = await manager.query(operation, filePath, position, cwd, undefined)
            return renderOutcome(outcome, readConfig(passed), cwd)
          } catch (error) {
            return degradation(`LSP 查询出错：${errorText(error)}`)
          }
        },
        status: () => manager.status(),
        servers: () => manager.servers(),
      }
    }

    /** 会话工作目录（服务这条路上没有工具上下文，只能问会话）。 */
    function sessionCwd(): string {
      try {
        return ctx.session.current().meta.cwd
      } catch {
        return process.cwd()
      }
    }
  },
}

/** 系统提示那一段：把「什么时候才该用它」与坐标基写清楚。 */
const LSP_PROMPT_TEXT = [
  'LSP 代码智能（lsp 工具）：普通导航优先用 grep / glob / read；',
  '只有文本匹配有歧义（同名符号、重载、动态派发），或者动手改之前需要精确定位定义与引用时，才用 lsp 工具。',
  'operation 四选一：goToDefinition / findReferences（结果包含声明本身）/ goToImplementation / hover。',
  '坐标是**一基**：line 与 character 都从 1 数（character 按 UTF-16 码元），光标要落在符号上；',
  '返回的 path:line:character 同样是一基，可以直接拿去 read。',
  '没装语言服务器时它会回一句原因，不要反复重试同一个查询。',
].join('\n')

/** 操作名的运行时校验。 */
function isOperation(value: string): value is LspOperation {
  return (LSP_OPERATIONS as readonly string[]).includes(value)
}

/** 数字类配置的兜底：不是有限数就用缺省，否则夹进范围。 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(Math.max(Math.round(num), min), max)
}

/** 错误对象取一句话。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 读文件为文本；读不到（不存在 / 权限）给 undefined，由调用方跳过这一步。 */
function readText(filePath: string): string | undefined {
  try {
    // 同步读是必须的：守卫要拿到「写前那一刻」的内容，异步读会和紧接着的写抢时间。
    return readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

/** 按字符数截断一段完整结果（把说明本身也留在预算里）。 */
function boundResult(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text
  const notice = `\n… ${label}超过 ${maxChars} 字符，已截断`
  if (notice.length >= maxChars) return notice.slice(0, maxChars)
  return `${text.slice(0, maxChars - notice.length)}${notice}`
}

/** HTML 转义（`<` `>` `&`，属性里连引号一起转）：别让用户代码里的记号把诊断块提前闭合。 */
function escapeText(value: string, attribute: boolean): string {
  const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return attribute ? escaped.replace(/"/g, '&quot;') : escaped
}

/** 单行化 + 去控制字符 + 截断 + 转义：语言服务器给的每一个字段都要过这一道。 */
function sanitizeField(value: string, limit: number): string {
  const flat = value.replace(/[\r\n\t]+/g, ' ')
  let printable = ''
  for (const char of flat) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x20 && code !== 0x7f) printable += char
  }
  return escapeText(printable.trim().slice(0, limit), false)
}
