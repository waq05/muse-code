/**
 * Tool Search（工具渐进披露）的纯逻辑层：分词、BM25 检索、延后判定与配置校验。
 *
 * 为什么要有这一层：模型每轮请求都拿得到注册表里的全部工具 schema，MCP 一接进来就是几十个
 * 工具的参数表，其中这一轮用得上的常常只有一两条，其余 schema 白付 token。这里把
 * 「哪些工具可以从台面上撤下、撤下之后怎么用中文或英文搜回来」判定收在一处，
 * 插件那一层只管把它接到 `ctx.tools` / `ctx.guards` / `ctx.get('mcp')` 上。
 *
 * 中文为什么按 bigram 切：中文词之间没有空格，整串比对永远命不中，所以把相邻两字切成一项
 * （「创建工单」→ 创建 / 建工 / 工单），单个汉字自成一项。英文与数字按标识符切
 * （下划线与驼峰都拆开）再小写化，所以 `mcp__github__create_issue` 能用 github、issue 搜到。
 *
 * @module dsc/core/tool-search
 */
import type { ToolRisk } from './tools.js'

/** 插件配置在 `~/.dsc/plugins.json` 里的条目键，同时是设置分区的 id。 */
export const TOOL_SEARCH_CONFIG_KEY = 'tool-search'

/**
 * 可调值的区间。设置分区的控件范围与加载时的校验都读它，
 * 免得「界面允许填 30、插件只认 20」这种两处各写一遍的偏差。
 */
export const TOOL_SEARCH_LIMITS = {
  /** 一次检索最多返回几条。 */
  searchLimit: { min: 1, max: 20 },
  /** 渐进披露档位：1 只撤 MCP、2 再按规则撤、3 除保留名单外全撤。 */
  tier: { min: 1, max: 3 },
} as const

/**
 * 三档渐进披露。
 * 1 = 只把 MCP 工具的 schema 撤下，注册表里的一条不动；
 * 2 = 在 1 的基础上，再撤下命中 `deferRules` 的注册表工具；
 * 3 = MCP 与全部 write / exec 注册表工具都撤，只有命中 `keepTools` 的留着。
 */
export type ToolSearchTier = 1 | 2 | 3

/** 插件配置。 */
export interface ToolSearchConfig {
  /** 撤下 MCP 工具 schema（走 `mcp.deferSchemas()`）吗。 */
  deferMcpSchemas: boolean
  /** 撤下的力度，见 {@link ToolSearchTier}。 */
  tier: ToolSearchTier
  /** tier 2 用：命中这些 glob 的注册表工具撤下（`*` 匹配任意串）。 */
  deferRules: string[]
  /** 永远留在台面上的工具 glob，tier 2 / 3 都生效。 */
  keepTools: string[]
  /** 模型调 `tool_search` 没写 limit 时，一次返回几条。 */
  searchLimit: number
}

/** 缺省配置：只动 MCP（这是本轮最要紧的收益），注册表工具要用户点名才撤。 */
export const DEFAULT_TOOL_SEARCH_CONFIG: ToolSearchConfig = {
  deferMcpSchemas: true,
  tier: 2,
  deferRules: [],
  keepTools: [],
  searchLimit: 5,
}

/** 认得的配置项（写错的键名会被点名报错，不静默忽略）。 */
const CONFIG_KEYS = ['deferMcpSchemas', 'tier', 'deferRules', 'keepTools', 'searchLimit'] as const

/** 索引里的一篇文档：一个工具的真名与说明。 */
export interface ToolSearchDoc {
  /** 工具真名，检索结果里回给模型的就是它。 */
  name: string
  /** 一句话说明（结果列表里每条只占一行）。 */
  summary: string
  /** 进索引的说明正文（工具名另按更高权重计入）。 */
  description: string
}

/** 一条检索命中：真名 + 一句话说明 + 分数（大的更相关）。 */
export interface ToolSearchHit {
  name: string
  summary: string
  score: number
}

/** 工具名命中比说明命中更能说明「要的就是它」，所以名字的词频按这个倍数计。 */
const NAME_WEIGHT = 3

/** BM25 的词频饱和与长度归一参数：公式常量，不随部署变。 */
const BM25_K1 = 1.2
const BM25_B = 0.75

/** 汉字区块（基本区、扩展 A、兼容区）。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 关键词词元字符（英文、数字、下划线）。 */
const WORD = /[A-Za-z0-9_]/

/** 正则元字符转义，拼 glob 用。 */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g

/**
 * 把一段文本切成检索词元。
 *
 * 汉字按相邻两字一项；英文与数字按标识符切（`_` 与驼峰都拆开）后小写化。
 * 中文与英文混排时两类词元都进同一个词表，所以「创建 issue」这样的查询能同时命中文档里的两半。
 *
 * @param text - 要切的文本（工具名、说明、查询都走这一个函数，切法必须一致才能对上）。
 * @returns 词元数组，顺序与出现顺序一致，允许重复（词频要用）。
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (CJK.test(char)) {
      let end = index
      while (end < text.length && CJK.test(text[end]!)) end += 1
      const run = text.slice(index, end)
      if (run.length === 1) out.push(run)
      else for (let start = 0; start + 1 < run.length; start += 1) out.push(run.slice(start, start + 2))
      index = end
      continue
    }
    if (!WORD.test(char)) {
      index += 1
      continue
    }
    let end = index
    while (end < text.length && WORD.test(text[end]!)) end += 1
    for (const part of splitIdentifier(text.slice(index, end))) out.push(part)
    index = end
  }
  return out
}

/**
 * 把 `mcp__github__create_issue`、`readFile` 这类标识符拆成小写单词。
 *
 * @param raw - 一段连续的字母数字下划线。
 * @returns 小写单词数组，空串被丢掉。
 */
function splitIdentifier(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part !== '')
}

/**
 * 把设置页那个多行文本框读成清单：一行一个名字，逗号、分号、中文逗号都能当分隔。
 *
 * @param text - 用户填的原文。
 * @returns 去掉空行后的清单；条目里带空格时抛错（工具名与通配模式里不会出现空格，多半是填错了）。
 */
export function parseNameListText(text: string): string[] {
  const out: string[] = []
  for (const piece of text.split(/[\n,，;；]+/)) {
    const name = piece.trim()
    if (name === '') continue
    if (/\s/.test(name)) throw new Error(`「${name}」中间有空格：一行写一个工具名或通配模式`)
    out.push(name)
  }
  return out
}

/**
 * 按 glob（只认 `*`）匹配工具名，大小写不敏感。
 *
 * @param pattern - 模式，例如 `mcp__github__*`。
 * @param name - 工具真名。
 * @returns 命中为 true。
 */
export function matchesToolGlob(pattern: string, name: string): boolean {
  const body = pattern
    .split('*')
    .map((piece) => piece.replace(REGEX_SPECIAL, '\\$&'))
    .join('.*')
  return new RegExp(`^${body}$`, 'i').test(name)
}

/**
 * 这条工具允许被撤下吗。
 *
 * read 风险一律不许：撤下之后模型只能经 `tool_call` 调它，而 `tool_call` 自己是 exec 档、
 * 每次都要过审批卡，「只读免审批」就变成了「每次只读都弹卡」。
 *
 * @param tool - 工具的名字与风险等级。
 * @param config - 当前配置。
 * @returns 允许撤下为 true。
 */
export function shouldDeferTool(tool: { name: string; risk: ToolRisk }, config: ToolSearchConfig): boolean {
  if (tool.risk === 'read') return false
  if (config.keepTools.some((pattern) => matchesToolGlob(pattern, tool.name))) return false
  if (config.tier === 3) return true
  if (config.tier === 1) return false
  return config.deferRules.some((pattern) => matchesToolGlob(pattern, tool.name))
}

/**
 * 取说明的第一句当「一句话说明」（结果列表里每条工具只占一行）。
 *
 * @param description - 工具的说明原文。
 * @param maxLength - 最长字符数，超出截断并补省略号。
 * @returns 压成一行的一句话；原文为空时给一句占位。
 */
export function summarizeToolDescription(description: string, maxLength = 120): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  if (flat === '') return '（没有说明）'
  const head = (flat.split(/[。！？；]|\.\s/)[0] ?? '').trim()
  const text = head === '' ? flat : head
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

/** 索引里存下来的一篇文档。 */
interface IndexedDoc {
  name: string
  summary: string
  /** 词元 → 词频（名字的词频按 {@link NAME_WEIGHT} 加权）。 */
  terms: Map<string, number>
  /** 加权后的文档长度，用于长度归一。 */
  length: number
}

/**
 * 内存 BM25 索引（零依赖，几十条文档规模一次建表就够）。
 *
 * 手写而不引依赖：这里只要「按中文 bigram 与英文单词打分排序」这一件事，
 * 引一个检索库带来的体积与版本面大于收益。
 */
export class ToolSearchIndex {
  private readonly docs: IndexedDoc[] = []
  private readonly docFreq = new Map<string, number>()
  private totalLength = 0

  /**
   * 加一篇文档。同一个名字重复加不查重，调用方自己保证（目录本身就是按名字唯一的）。
   *
   * @param doc - 工具的真名、一句话说明与说明正文。
   */
  add(doc: ToolSearchDoc): void {
    const terms = new Map<string, number>()
    let length = 0
    const bump = (term: string, weight: number): void => {
      terms.set(term, (terms.get(term) ?? 0) + weight)
      length += weight
    }
    for (const term of tokenize(doc.name)) bump(term, NAME_WEIGHT)
    for (const term of tokenize(doc.description)) bump(term, 1)
    for (const term of terms.keys()) this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1)
    this.docs.push({ name: doc.name, summary: doc.summary, terms, length })
    this.totalLength += length
  }

  /** 索引里有多少篇文档。 */
  get size(): number {
    return this.docs.length
  }

  /**
   * 按查询词打分排序取前 limit 条。
   *
   * @param query - 查询原文（中文、英文混排都行）。
   * @param limit - 最多返回几条；≤0 直接返回空。
   * @returns 分数大于 0 的命中，分数降序；同分按名字升序，保证两次结果稳定。
   */
  search(query: string, limit: number): ToolSearchHit[] {
    if (limit <= 0 || this.docs.length === 0) return []
    const terms = [...new Set(tokenize(query))].filter((term) => this.docFreq.has(term))
    if (terms.length === 0) return []
    const total = this.docs.length
    const avgLength = this.totalLength > 0 ? this.totalLength / total : 1
    const scored = this.docs.map((doc) => {
      let score = 0
      for (const term of terms) {
        const tf = doc.terms.get(term) ?? 0
        if (tf === 0) continue
        const df = this.docFreq.get(term) ?? 0
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
        score += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgLength))
      }
      return { doc, score }
    })
    return scored
      .filter((hit) => hit.score > 0)
      .sort((a, b) => (b.score === a.score ? a.doc.name.localeCompare(b.doc.name) : b.score - a.score))
      .slice(0, limit)
      .map((hit) => ({ name: hit.doc.name, summary: hit.doc.summary, score: hit.score }))
  }
}

/**
 * 校验收到的配置，错了就抛错（加载时报错，别等模型调工具才发现）。
 *
 * @param raw - `resolvePluginConfig('tool-search', passed)` 合并出来的原始对象。
 * @returns 每个字段都有值的配置。
 * @throws 配置项类型不对、档位越界、条数越界、出现不认识的键时抛错，消息里说清错在哪、去哪儿改。
 */
export function resolveToolSearchConfig(raw: unknown): ToolSearchConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${TOOL_SEARCH_CONFIG_KEY} 的配置要是一个对象；到 ~/.dsc/plugins.json 或设置页的「工具渐进披露」分区改`)
  }
  const doc = raw as Record<string, unknown>
  for (const key of Object.keys(doc)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${TOOL_SEARCH_CONFIG_KEY} 不认识配置项「${key}」，它认得的是 ${CONFIG_KEYS.join('、')}`)
    }
  }
  const config: ToolSearchConfig = { ...DEFAULT_TOOL_SEARCH_CONFIG }

  if (doc.deferMcpSchemas !== undefined) {
    if (typeof doc.deferMcpSchemas !== 'boolean') {
      throw new Error(`deferMcpSchemas 只能是 true 或 false，收到 ${JSON.stringify(doc.deferMcpSchemas)}`)
    }
    config.deferMcpSchemas = doc.deferMcpSchemas
  }

  if (doc.tier !== undefined) {
    const tier = readInteger(doc.tier, TOOL_SEARCH_LIMITS.tier.min, TOOL_SEARCH_LIMITS.tier.max)
    // 三档各自撤什么写在 ToolSearchTier 上，这里只点一遍，用户看报错就知道该填几
    if (tier === undefined) throw new Error('tier 只能是 1（只撤 MCP）、2（再按规则撤）或 3（除保留名单外全撤）')
    config.tier = tier as ToolSearchTier
  }

  config.deferRules = readNameList(doc.deferRules, 'deferRules')
  config.keepTools = readNameList(doc.keepTools, 'keepTools')

  if (doc.searchLimit !== undefined) {
    const { min, max } = TOOL_SEARCH_LIMITS.searchLimit
    const limit = readInteger(doc.searchLimit, min, max)
    if (limit === undefined) throw new Error(`searchLimit 要在 ${min}~${max} 之间，收到 ${JSON.stringify(doc.searchLimit)}`)
    config.searchLimit = limit
  }

  return config
}

/**
 * 读一个区间内的整数：数字直接用，数字字符串（设置页回的就是字符串）转过来。
 *
 * 为什么不用 `Number(value)` 一把梭：`Number(true)` 是 1、`Number('')` 是 0，
 * 那样 `tier: true` 会被当成合法档位，配置写错却静默生效。
 *
 * @param value - 原始值。
 * @param min - 下界（含）。
 * @param max - 上界（含）。
 * @returns 合法整数；不是整数或越界时 undefined。
 */
function readInteger(value: unknown, min: number, max: number): number | undefined {
  const num =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isInteger(num) || num < min || num > max) return undefined
  return num
}

/**
 * 读一份名字清单：数组直接用，字符串按 {@link parseNameListText} 切（手改配置文件时常写成一行串）。
 *
 * @param value - 原始值，可以是 undefined（回落到空清单）。
 * @param label - 出错时消息里点名的字段。
 * @returns 名字清单。
 */
function readNameList(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return parseNameListText(value)
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const item of value) {
      if (typeof item !== 'string') {
        throw new Error(`${label} 只能是字符串数组，里面有 ${typeof item}`)
      }
      const name = item.trim()
      if (name === '') continue
      if (/\s/.test(name)) throw new Error(`${label} 里的「${name}」带空格：工具名与通配模式里不会出现空格`)
      out.push(name)
    }
    return out
  }
  throw new Error(`${label} 要么是多行文本，要么是字符串数组，收到 ${JSON.stringify(value)}`)
}
