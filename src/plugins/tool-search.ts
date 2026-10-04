/**
 * tool-search 插件（官方可开关插件）：工具渐进披露。
 *
 * 为什么要它：agent 循环每轮请求都把 `ctx.tools.list()` 全量喂给模型，MCP 一接进来就是几十个
 * 工具的参数表，其中这一轮用得上的常常只有一两条，其余 schema 白付 token。这个插件把可以
 * 撤下的工具从台面上撤下来，换成三个常驻的桥接工具：
 *   `tool_search`   按中文或英文关键词 BM25 检索撤下的目录，返回真名、一句话说明与分数；
 *   `tool_describe` 取某条工具的完整 JSON Schema；
 *   `tool_call`     按真名调用它（撤下的工具只能这样调）。
 *
 * 两条安全约束：
 *   1. 只有 write / exec 风险的工具允许被撤下。read 工具撤下之后模型只能经 `tool_call` 调它，
 *      而 `tool_call` 自己是 exec 档、每次都要过审批卡，「只读免审批」就变成了「每次只读都弹卡」。
 *      判定在 core/tool-search.ts 的 shouldDeferTool 里，配置写了 `*` 也拦得住。
 *   2. `tool_call` 执行前按真名重走一遍守卫链：模式闸门、安全钩子、审批卡看到的都是真名与真实
 *      风险，于是「谁被批准了」在审批卡与会话日志上记的还是那条工具，而不是 `tool_call`。
 *
 * 撤下的机制见 withhold()；MCP 工具的 schema 由 MCP 客户端自己撤（`mcp.deferSchemas()`），
 * 因为工具目录的持有者才知道哪些工具正挂在 ctx.tools 上。
 *
 * @module dsc/plugins/tool-search
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import { callFacts, type ToolContext, type ToolEntry, type ToolOutput, type ToolRisk } from '../core/tools.js'
import {
  ToolSearchIndex,
  TOOL_SEARCH_CONFIG_KEY,
  TOOL_SEARCH_LIMITS,
  parseNameListText,
  resolveToolSearchConfig,
  shouldDeferTool,
  summarizeToolDescription,
  type ToolSearchConfig,
} from '../core/tool-search.js'
import type { SettingsField, SettingsValues } from '../contract.js'
import type { McpService, SettingsSectionSpec } from '../services/types.js'

/** 三个桥接工具的固定名字（它们自己不许被撤下，也不许再经 tool_call 包一层）。 */
const BRIDGE_TOOL_NAMES = new Set(['tool_search', 'tool_describe', 'tool_call'])

/** 配置与设置提示里要写清的来源文件（手改它同样生效）。 */
const PLUGINS_FILE = join(homedir(), '.dsc', 'plugins.json')

/** 目录里的一项：MCP 工具与从注册表撤下的工具在检索与调用上长一个样。 */
interface CatalogItem {
  /** 工具真名（MCP 工具就是 `mcp__<server>__<tool>`）。 */
  name: string
  /** 一句话说明（检索结果里展示）。 */
  summary: string
  /** 进索引的说明正文（MCP 工具带上 server 名，方便按 server 搜）。 */
  description: string
  parameters: Record<string, unknown>
  risk: ToolRisk
  /** `tool_describe` 里告诉模型这条工具现在在哪儿、怎么调。 */
  where: string
  /** 执行它：MCP 走 `mcp.call`，注册表工具直接 run 那条 ToolEntry。 */
  invoke: (args: Record<string, unknown>, runCtx: ToolContext) => Promise<string | ToolOutput>
}

export const toolSearchPlugin: Plugin.Object = {
  name: 'tool-search',
  inject: ['tools', 'guards', 'settings'],
  apply(ctx, passed) {
    // 先把配置校验一遍：写错了插件就挂不上（错在哪、去哪儿改由 readConfig 的消息说清），
    // 别带着一份坏配置跑起来、等模型调工具时才炸。
    readConfig()

    /** 本插件从注册表撤下的工具：撤下后只活在这里，`tool_call` 直接 run 它。 */
    const held = new Map<string, ToolEntry>()
    /** 注册过的东西都留退订函数，插件卸载时原样撤掉。 */
    const disposers: (() => void)[] = []

    /** 取 MCP 客户端。它是可选服务（插件没开时不存在），所以必须走 ctx.get，不能写 ctx.mcp。 */
    const mcpService = (): McpService | undefined => ctx.get('mcp')

    function readConfig(): ToolSearchConfig {
      return resolveToolSearchConfig(resolvePluginConfig(TOOL_SEARCH_CONFIG_KEY, passed))
    }

    /**
     * 把一条注册表工具从每轮请求里撤下。
     *
     * ToolService 只有 register / list，没有「按名字删」这个方法；注册表按 name 存，
     * 退订函数判等的是「这个名字底下还是不是我这一条」，所以把同一条 ToolEntry 再注册一次
     * 随即退订，效果就是按名字把它拿下来。撤下的条目留在 held 里，`tool_call` 直接 run 它。
     * 将来 ToolService 长出真正的 unregister，改这一处即可。
     */
    function withhold(entry: ToolEntry): void {
      ctx.tools.register(entry)()
      held.set(entry.name, entry)
    }

    /** 把撤下的注册表工具全部放回注册表（配置换挡与插件卸载都要先还原再重算）。 */
    function restoreHeld(): void {
      if (held.size === 0) return
      // 不放回退订函数：这些工具的所有者是注册它们的那个插件，本插件只是替它扣了一阵子
      for (const entry of held.values()) ctx.tools.register(entry)
      held.clear()
    }

    /**
     * 按当前配置重算该撤谁。
     *
     * 先还原再撤：设置页保存后立刻生效，不必重启宿主。代价是被放回的工具会排到
     * `ctx.tools.list()` 的末尾（顺序只在改配置这一次变），改完这一轮之后又稳定下来。
     */
    function syncDeferral(): void {
      const config = readConfig()
      restoreHeld()
      // tier 1 只动 MCP，注册表里的一条都不撤
      if (config.tier !== 1) {
        for (const entry of ctx.tools.list()) {
          if (BRIDGE_TOOL_NAMES.has(entry.name)) continue
          if (!shouldDeferTool(entry, config)) continue
          withhold(entry)
        }
      }
      const mcp = mcpService()
      if (config.deferMcpSchemas && mcp !== undefined) mcp.deferSchemas()
    }

    /** 现在能检索、能调用的目录：MCP 工具（`mcp.tools()`）+ 本插件撤下的注册表工具。 */
    function catalogItems(): CatalogItem[] {
      const items: CatalogItem[] = []
      const mcp = mcpService()
      if (mcp !== undefined) {
        for (const info of mcp.tools()) {
          items.push({
            name: info.name,
            summary: summarizeToolDescription(info.description),
            description: `（MCP server：${info.server}）${info.description}`,
            parameters: info.parameters,
            risk: info.risk,
            where: `MCP server ${info.server} 的工具，schema 已从每轮请求里撤下，调用走 tool_call`,
            invoke: (callArgs, runCtx) => mcp.call(info.name, callArgs, runCtx.signal),
          })
        }
      }
      for (const entry of held.values()) {
        items.push({
          name: entry.name,
          summary: summarizeToolDescription(entry.description),
          description: entry.description,
          parameters: entry.parameters,
          risk: entry.risk,
          where: '已从台面上撤下，调用走 tool_call（调用时会按这个真名过一遍审批与安全钩子）',
          invoke: (callArgs, runCtx) =>
            entry.run(callArgs, {
              cwd: runCtx.cwd,
              signal: runCtx.signal,
              sessionId: runCtx.sessionId,
              sessionPath: runCtx.sessionPath,
            }),
        })
      }
      return items
    }

    /**
     * 按真名找一条工具：先看撤下的目录，再退回台面上的注册表。
     * 两条路都用真名索引，所以模型看到的工具名与守卫链看到的工具名始终是同一个。
     */
    function resolveTool(name: string): CatalogItem | undefined {
      const fromCatalog = catalogItems().find((item) => item.name === name)
      if (fromCatalog !== undefined) return fromCatalog
      const live = ctx.tools.list().find((entry) => entry.name === name)
      if (live === undefined) return undefined
      return {
        name: live.name,
        summary: summarizeToolDescription(live.description),
        description: live.description,
        parameters: live.parameters,
        risk: live.risk,
        where: '就在台面上，可以直接调用（经 tool_call 走等于多过一道审批）',
        invoke: (callArgs, runCtx) =>
          live.run(callArgs, {
            cwd: runCtx.cwd,
            signal: runCtx.signal,
            sessionId: runCtx.sessionId,
            sessionPath: runCtx.sessionPath,
          }),
      }
    }

    /**
     * 取 `arguments` 参数：对象直接用；字符串当 JSON 解析（模型偶尔把对象写成字符串）。
     *
     * @param value - 模型给的 arguments。
     * @returns 传给目标工具的参数对象；空值当空对象。
     * @throws 串不是合法 JSON、或解析出来不是对象时抛错，让模型自己改。
     */
    function readCallArgs(value: unknown): Record<string, unknown> {
      if (value === undefined || value === null) return {}
      if (typeof value === 'string') {
        if (value.trim() === '') return {}
        let parsed: unknown
        try {
          parsed = JSON.parse(value)
        } catch (error) {
          // 模型把参数写成了非 JSON 的串：把解析器的原因一并带出去，它才知道改哪儿
          const reason = error instanceof Error ? error.message : String(error)
          throw new Error(`arguments 不是合法 JSON：${reason}`)
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('arguments 解析出来不是对象，照 tool_describe 给出的 JSON Schema 填')
        }
        return parsed as Record<string, unknown>
      }
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('arguments 要是一个对象')
      return value as Record<string, unknown>
    }

    // ── 三个桥接工具 ──────────────────────────────────────────────────────────

    const searchTool: ToolEntry = {
      name: 'tool_search',
      description:
        '在「已从台面上撤下」的工具里检索：按关键词返回工具真名、一句话说明与匹配分数。' +
        '中文与英文都能搜（中文按相邻两字切词）。搜到之后先用 tool_describe 看参数，' +
        '再用 tool_call 按真名调用；台面上已有的工具直接用，不必搜。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，中文英文都行，例如「创建工单」「github issue」' },
          limit: { type: 'number', description: '最多返回几条；不写就用配置里的条数' },
        },
        required: ['query'],
      },
      risk: 'read',
      async run(args) {
        const query = String(args.query ?? '').trim()
        if (query === '') throw new Error('query 不能为空：写几个关键词，中文英文都行')
        const config = readConfig()
        const num = Number(args.limit)
        const limit = Number.isFinite(num)
          ? Math.min(Math.max(Math.round(num), TOOL_SEARCH_LIMITS.searchLimit.min), TOOL_SEARCH_LIMITS.searchLimit.max)
          : config.searchLimit
        const catalog = catalogItems()
        const index = new ToolSearchIndex()
        for (const item of catalog) {
          index.add({ name: item.name, summary: item.summary, description: item.description })
        }
        const hits = index.search(query, limit)
        if (hits.length === 0) {
          return `「${query}」没搜到匹配的工具（现在撤下的目录共 ${String(catalog.length)} 条）。换个关键词，或直接用工具真名。`
        }
        const lines = hits.map(
          (hit, position) => `${String(position + 1)}. ${hit.name}　分数 ${hit.score.toFixed(3)}\n   ${hit.summary}`,
        )
        return (
          `检索「${query}」命中 ${String(hits.length)} 条（撤下的目录共 ${String(catalog.length)} 条）：\n` +
          `${lines.join('\n')}\n` +
          '要看参数用 tool_describe，要调用用 tool_call（按上面的真名填）。'
        )
      },
    }

    const describeTool: ToolEntry = {
      name: 'tool_describe',
      description:
        '取一条工具的完整参数 JSON Schema：撤下的与台面上的都能取。' +
        '参数填错多半是没先看它；调用撤下的工具前先看这一眼再 tool_call。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '工具真名，例如 mcp__github__create_issue' } },
        required: ['name'],
      },
      risk: 'read',
      async run(args) {
        const name = String(args.name ?? '').trim()
        if (name === '') throw new Error('name 不能为空：填工具的真名（tool_search 给出的那个）')
        const target = resolveTool(name)
        if (target === undefined) {
          throw new Error(`没有这个工具：${name}。先用 tool_search 搜名字，或者确认这个名字拼对了。`)
        }
        return (
          `${target.name}（风险 ${target.risk}；${target.where}）\n` +
          `${JSON.stringify(target.parameters, null, 2)}`
        )
      },
    }

    const callTool: ToolEntry = {
      name: 'tool_call',
      description:
        '按真名调用一条工具（撤下的工具只能这样调）。真名与参数照 tool_search / tool_describe 给出的填，别自己猜。' +
        '执行前会按真实工具名重走一遍审批与安全钩子，所以被撤下的写操作照样会弹卡、也照样能被规则拦下。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '要调用的工具真名（tool_search 或 tool_describe 给出的那个）' },
          arguments: {
            type: 'object',
            description: '传给该工具的参数对象，字段照 tool_describe 给出的 JSON Schema 填',
          },
        },
        required: ['name'],
      },
      risk: 'exec',
      async run(args, runCtx) {
        const name = String(args.name ?? '').trim()
        if (name === '') throw new Error('name 不能为空：填工具的真名（tool_search 给出的那个）')
        if (BRIDGE_TOOL_NAMES.has(name)) {
          throw new Error(`${name} 本来就在台面上，直接调用它就行，不用经 tool_call 再包一层`)
        }
        const target = resolveTool(name)
        if (target === undefined) {
          throw new Error(`没有这个工具：${name}。先用 tool_search 搜名字（例如「创建工单」或 github issue）。`)
        }
        const callArgs = readCallArgs(args.arguments)
        // 关键一条：工具是被撤下之后经桥接层执行的，但守卫链必须按真实工具名与真实风险判定——
        // 否则模式闸门、安全钩子、审批卡看到的都是 tool_call，会话日志里也记不出到底批准了谁。
        const verdict = await ctx.guards.gate({
          toolName: name,
          risk: target.risk,
          cwd: runCtx.cwd,
          args: callArgs,
          signal: runCtx.signal,
          sessionId: runCtx.sessionId,
          sessionPath: runCtx.sessionPath,
          ...callFacts(callArgs, runCtx.cwd),
        })
        // 守卫说拒：理由原文回给模型（由循环记成这次工具失败），不静默、也不改写成别的话
        if (verdict.action === 'deny') throw new Error(verdict.reason)
        return target.invoke(callArgs, runCtx)
      },
    }

    for (const tool of [searchTool, describeTool, callTool]) disposers.push(ctx.tools.register(tool))

    // ── 设置分区 ──────────────────────────────────────────────────────────────

    /** 现在撤下了哪些工具（设置分区里那张现状清单）。 */
    function withheldText(config: ToolSearchConfig): string {
      const mcp = mcpService()
      // 开关关着时 MCP 的 schema 根本没撤，不能把它算进这张清单
      const mcpNames = config.deferMcpSchemas && mcp !== undefined ? mcp.tools().map((tool) => tool.name).sort() : []
      const heldNames = [...held.keys()].sort()
      if (mcpNames.length === 0 && heldNames.length === 0) {
        const mcpNote = config.deferMcpSchemas ? '' : '（MCP 那把开关关着，MCP 工具的 schema 没撤）'
        return `现在没有撤下任何工具：台面上就是注册表里的全部工具。${mcpNote}`
      }
      const lines: string[] = []
      if (config.deferMcpSchemas) {
        lines.push(`MCP 工具 ${String(mcpNames.length)} 条${mcpNames.length === 0 ? '' : `：${mcpNames.join('、')}`}`)
      } else {
        lines.push('MCP 工具的 schema 没撤（开关关着）')
      }
      lines.push(`注册表工具 ${String(heldNames.length)} 条${heldNames.length === 0 ? '' : `：${heldNames.join('、')}`}`)
      lines.push('read 工具不会出现在这两行里：它们必须留在台面上，否则每次只读都要过一张审批卡。')
      return lines.join('\n')
    }

    const section: SettingsSectionSpec = {
      id: TOOL_SEARCH_CONFIG_KEY,
      title: '工具渐进披露',
      subtitle: '每轮只为用得上的工具付 schema：撤下的工具用 tool_search / tool_describe / tool_call 找回来',
      order: 47,
      fields(): SettingsField[] {
        const config = readConfig()
        return [
          {
            type: 'info',
            label: '常驻台面的三个工具',
            text:
              'tool_search：按关键词（中文按相邻两字切，英文按单词）在撤下的目录里检索；\n' +
              'tool_describe：取某条工具的完整参数 JSON Schema；\n' +
              'tool_call：按真名调用它，调用前按真名重走审批与安全钩子。',
          },
          {
            type: 'switch',
            key: 'deferMcpSchemas',
            label: '撤下 MCP 工具的 schema',
            help: 'MCP 一接进来就是几十个工具的参数表，撤下收益最大。撤下由 MCP 客户端一次性执行，关掉要重启宿主才恢复。',
          },
          {
            type: 'select',
            key: 'tier',
            label: '渐进披露档位',
            options: [
              { value: '1', label: '1：只撤 MCP 工具' },
              { value: '2', label: '2：再撤下面规则命中的工具（缺省）' },
              { value: '3', label: '3：除保留名单外，会改东西的工具全撤' },
            ],
            help: '只有 write / exec 风险的工具会被撤下；read 工具一律留在台面上。',
          },
          {
            type: 'text',
            key: 'deferRules',
            label: '延后规则（一行一条，支持 *）',
            placeholder: 'mcp__github__*\nedit',
            mono: true,
            help: '只在档位 2 生效。命中的工具被撤下后要用 tool_call 调，每次调用都会过审批卡。',
          },
          {
            type: 'text',
            key: 'keepTools',
            label: '永远留在台面上的工具（一行一条）',
            placeholder: 'bash',
            mono: true,
            help: '档位 2、3 都生效。常用且不想每次都过 tool_call 的工具写在这里。',
          },
          {
            type: 'number',
            key: 'searchLimit',
            label: '一次检索最多返回几条',
            min: TOOL_SEARCH_LIMITS.searchLimit.min,
            max: TOOL_SEARCH_LIMITS.searchLimit.max,
            step: 1,
            help: '模型调 tool_search 时也能自己指定，上限就是这里。',
          },
          { type: 'info', label: '现在撤下了这些', text: withheldText(config), help: `配置存在 ${PLUGINS_FILE} 的 ${TOOL_SEARCH_CONFIG_KEY} 条目里，手改同样生效。` },
          {
            type: 'info',
            label: '当前配置',
            text: `规则 ${config.deferRules.length === 0 ? '（空）' : config.deferRules.join('、')}｜保留 ${config.keepTools.length === 0 ? '（空）' : config.keepTools.join('、')}`,
          },
        ]
      },
      values(): SettingsValues {
        const config = readConfig()
        return {
          deferMcpSchemas: config.deferMcpSchemas,
          // 下拉框回的是字符串，这里也回字符串，免得界面认不出当前选中项
          tier: String(config.tier),
          deferRules: config.deferRules.join('\n'),
          keepTools: config.keepTools.join('\n'),
          searchLimit: config.searchLimit,
        }
      },
      save(key, value): string | void {
        try {
          switch (key) {
            case 'deferMcpSchemas': {
              if (typeof value !== 'boolean') return '这个开关只能是开或关'
              writePluginConfig(TOOL_SEARCH_CONFIG_KEY, { deferMcpSchemas: value })
              break
            }
            case 'tier': {
              const tier = Number(value)
              if (!Number.isInteger(tier) || tier < TOOL_SEARCH_LIMITS.tier.min || tier > TOOL_SEARCH_LIMITS.tier.max) {
                return `档位只能是 1、2 或 3，收到 ${String(value)}`
              }
              writePluginConfig(TOOL_SEARCH_CONFIG_KEY, { tier })
              break
            }
            case 'deferRules': {
              writePluginConfig(TOOL_SEARCH_CONFIG_KEY, { deferRules: parseNameListText(String(value)) })
              break
            }
            case 'keepTools': {
              writePluginConfig(TOOL_SEARCH_CONFIG_KEY, { keepTools: parseNameListText(String(value)) })
              break
            }
            case 'searchLimit': {
              const limit = Number(value)
              if (!Number.isInteger(limit) || limit < TOOL_SEARCH_LIMITS.searchLimit.min || limit > TOOL_SEARCH_LIMITS.searchLimit.max) {
                return `条数要在 ${TOOL_SEARCH_LIMITS.searchLimit.min}~${TOOL_SEARCH_LIMITS.searchLimit.max} 之间，收到 ${String(value)}`
              }
              writePluginConfig(TOOL_SEARCH_CONFIG_KEY, { searchLimit: limit })
              break
            }
            default:
              return `这个分区没有这项：${key}`
          }
        } catch (error) {
          // parseNameListText 会为「名字里带空格」抛错：这类输入是用户填错了，把原因回显给他改
          return error instanceof Error ? error.message : String(error)
        }
        // 配置存完立刻换挡，不必重启宿主
        syncDeferral()
        return undefined
      },
    }
    const offSection = ctx.settings.registerSection(section)
    disposers.push(offSection)

    // 三个桥接工具已经挂上，现在按配置撤一轮
    syncDeferral()

    return () => {
      for (const off of disposers) off()
      // 卸载时把撤下的工具放回注册表：撤下只是替宿主省 token，卸载了就不该再扣着别人的工具
      restoreHeld()
    }
  },
}
