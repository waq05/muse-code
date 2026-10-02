/**
 * 模型能力（思考档位、档位走哪个请求字段、输入模态）的缺省值、YAML 宽容解析
 * 与线上字段映射。config.yaml 里这些字段全都可以不写：不写就是旧行为——
 * 档位走 DeepSeek 的 `thinking` 开关、四档都在、只吃文本。
 *
 * 读错的东西不抛错，逐项退回缺省值；设置界面回读时用户看得见自己填错了什么。
 *
 * @module dsc/core/model-caps
 */
import type {
  EffortLevel,
  EffortMap,
  Modality,
  ThinkingLevel,
  ThinkingParam,
} from '../contract.js'

/** 全部合法档位（按界面展示顺序，也是写回 YAML 的顺序）。 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'high', 'max']

/** 档位字段的全部合法取值。 */
export const THINKING_PARAMS: readonly ThinkingParam[] = ['thinking', 'reasoning-effort', 'none']

/** 全部输入模态。 */
export const MODALITIES: readonly Modality[] = ['text', 'image', 'video']

/** 不写 `thinkingParam` 时按 DeepSeek 风格发 `thinking:{type}`。 */
export const DEFAULT_THINKING_PARAM: ThinkingParam = 'thinking'

/** 不写档位清单时四档都在（与旧版行为一致：界面有四个档位，线上只有开关）。 */
export const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'high', 'max']

/** `reasoning-effort` 各档要发的线上值；端点用的名字不一样时，在 YAML 的 effortMap 里覆盖。 */
export const DEFAULT_EFFORT_MAP: Required<EffortMap> = { off: 'none', low: 'low', high: 'high', max: 'max' }

/** 档位中文名（界面与提示共用）。 */
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: '关',
  low: '低',
  high: '高',
  max: '最大',
}

/** 档位的英文线上值写法（表单里作为输入框提示）。 */
export const EFFORT_WIRE_HINT: Record<ThinkingLevel, string> = {
  off: 'none',
  low: 'low',
  high: 'high',
  max: 'max',
}

/** 模态中文名。 */
export const MODALITY_LABELS: Record<Modality, string> = {
  text: '文本',
  image: '照片',
  video: '视频',
}

/** 档位字段中文名与一句说明。 */
export const THINKING_PARAM_LABELS: Record<ThinkingParam, { label: string; help: string }> = {
  thinking: { label: 'thinking 开关', help: 'DeepSeek / GLM 风格：只有开与关，低·高·最大都发 enabled' },
  'reasoning-effort': { label: 'reasoning_effort', help: 'OpenAI 与多数网关风格：按档位发线上值，可逐档改名字' },
  none: { label: '不发思考字段', help: '端点没有思考参数：选哪档都不发，只有「默认」有意义' },
}

/** config.yaml 里一个模型条目的能力字段（全部可缺省，值还没校验）。 */
export interface RawModelCaps {
  /** 档位清单，如 `[off, low, high]`；也认 `thinking:`。 */
  thinkingLevels?: unknown
  thinking?: unknown
  /** 档位走哪个字段。 */
  thinkingParam?: unknown
  /** 各档的线上值；也认 `efforts:`。 */
  effortMap?: unknown
  efforts?: unknown
  /** 输入模态，如 `[text, image]`；也认旧字段 `vision: true`。 */
  modalities?: unknown
  vision?: unknown
}

/** 模型能力的四项声明（写回 YAML 与界面回填都靠它）。 */
export interface ModelCaps {
  thinkingLevels: ThinkingLevel[]
  thinkingParam: ThinkingParam
  effortMap: EffortMap
  modalities: Modality[]
}

/** 没有声明时的能力：等价于旧版行为。 */
export const DEFAULT_CAPS: ModelCaps = {
  thinkingLevels: [...DEFAULT_THINKING_LEVELS],
  thinkingParam: DEFAULT_THINKING_PARAM,
  effortMap: {},
  modalities: ['text'],
}

function asList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter((entry) => entry !== '')
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[,，\s]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
  }
  return []
}

/** 档位字段：认 thinking / reasoning-effort（也认 reasoning_effort、effort 别名）。 */
export function normalizeThinkingParam(raw: unknown): ThinkingParam {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/_/g, '-') : ''
  if (text === 'none' || text === 'off-field' || text === 'no') return 'none'
  if (text === 'reasoning-effort' || text === 'reasoning' || text === 'effort') return 'reasoning-effort'
  if (text === 'thinking' || text === 'thinking-type') return 'thinking'
  return DEFAULT_THINKING_PARAM
}

/** 档位清单：按固定顺序去重；`false` 或空清单 = 这个模型没有思考开关。 */
export function normalizeThinkingLevels(raw: unknown): ThinkingLevel[] {
  if (raw === false) return []
  const wanted = new Set(asList(raw).map((entry) => entry.toLowerCase()))
  return THINKING_LEVELS.filter((level) => wanted.has(level))
}

/** 各档线上值：`null` / 空串 = 这一档不发字段；没出现的档用缺省值。 */
export function normalizeEffortMap(raw: unknown): EffortMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const map: EffortMap = {}
  for (const level of THINKING_LEVELS) {
    const value = source[level]
    if (value === null) map[level] = null
    else if (typeof value === 'string' && value.trim() !== '') map[level] = value.trim()
    else if (typeof value === 'string') map[level] = null
  }
  return map
}

/** 模态：认常见别名（vision/photo/图片…），文本永远保留（协议里没有文本就发不出消息）。 */
export function normalizeModalities(raw: unknown, vision?: unknown): Modality[] {
  const wanted = new Set<Modality>()
  for (const entry of asList(raw)) {
    const key = entry.toLowerCase()
    if (key === 'text' || key === '文本') wanted.add('text')
    else if (key === 'image' || key === 'images' || key === 'vision' || key === 'photo' || key === 'photos' || key === '图片' || key === '照片')
      wanted.add('image')
    else if (key === 'video' || key === 'videos' || key === '视频') wanted.add('video')
  }
  // 旧配置里只有 `vision: true` 这一种写法
  if (vision === true) wanted.add('image')
  const list = MODALITIES.filter((modality) => wanted.has(modality))
  return list.includes('text') ? list : ['text', ...list]
}

/** 把 config.yaml 里一个模型条目的能力字段读成结构化能力。 */
export function readModelCaps(raw: RawModelCaps): ModelCaps {
  const levels =
    raw.thinkingLevels !== undefined
      ? normalizeThinkingLevels(raw.thinkingLevels)
      : raw.thinking !== undefined
        ? normalizeThinkingLevels(raw.thinking)
        : undefined
  const mapSource = raw.effortMap ?? raw.efforts
  return {
    thinkingLevels: levels ?? [...DEFAULT_THINKING_LEVELS],
    thinkingParam: normalizeThinkingParam(raw.thinkingParam),
    effortMap: normalizeEffortMap(mapSource),
    modalities: normalizeModalities(raw.modalities, raw.vision),
  }
}

/** 选中的档位在这个模型上是否存在（默认档永远可选）。 */
export function hasEffortLevel(caps: ModelCaps, effort: EffortLevel): boolean {
  return effort === 'default' || caps.thinkingLevels.includes(effort)
}

/** 越界的档位退回「默认」（切换模型后原来选的档位可能不存在了）。 */
export function clampEffort(caps: ModelCaps, effort: EffortLevel): EffortLevel {
  return hasEffortLevel(caps, effort) ? effort : 'default'
}

/** 一次请求要注入的思考字段（undefined = 不发）。 */
export interface EffortWire {
  /** DeepSeek / GLM 的 `thinking:{type}`。 */
  thinking?: 'enabled' | 'disabled'
  /** OpenAI 与多数网关的 `reasoning_effort`。 */
  reasoningEffort?: string
}

/**
 * 档位 → 请求字段。没有思考开关的模型、以及选了「默认」时，都不发字段。
 * @param caps - 这个模型的能力声明。
 * @param effort - 用户选的档位。
 */
export function effortToWire(caps: ModelCaps, effort: EffortLevel): EffortWire {
  if (effort === 'default') return {}
  if (caps.thinkingParam === 'none' || caps.thinkingLevels.length === 0) return {}
  if (caps.thinkingParam === 'thinking') {
    return { thinking: effort === 'off' ? 'disabled' : 'enabled' }
  }
  const declared = caps.effortMap[effort]
  const wire = declared === undefined ? DEFAULT_EFFORT_MAP[effort] : declared
  return wire === null || wire === undefined ? {} : { reasoningEffort: wire }
}
