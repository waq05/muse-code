/**
 * DeepSeek 官方定价与「本会话花费」估算（人民币口径）。
 *
 * 数据来源：DeepSeek 官方文档「模型 & 价格」页（2026-09 快照，与 dsh 的
 * deepseekPricing.ts 同源），单位为人民币/百万 tokens。DeepSeek 官方 API 只返回
 * token 用量、不返回金额，本模块按官方公开单价把会话累计 token 换算成金额——
 * 这是**估算**，不是账单：定价可能变动，余额扣费发生在 DeepSeek 侧（以平台账单为准）。
 *
 * 计价规则（来自官方页面）：
 *  - 扣减费用 = token 消耗量 × 模型单价；
 *  - 缓存命中的输入按命中价计费，其余输入（含写入缓存）按未命中价计费；
 *  - 高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00，其余为空闲时段
 *    （空闲价为高峰价的一半）。
 *
 * 只对 DeepSeek 官方端点生效：msc 的 provider 名是用户在 config.yaml 里自己起的，
 * 这里用「名字含 deepseek」判定（官方 API 的唯一事实来源就是它的域名单词）。
 * 其它 provider / 价目表外的模型一律返回 undefined，界面不显示金额——宁可不显示，
 * 也不给错误数字。
 *
 * @module dsc/core/pricing
 */

/** 单价对：`[空闲价, 高峰价]`，单位 元/百万 tokens。 */
export type CnyPerMillion = readonly [number, number]

/** 一个官方模型的完整价目（人民币/百万 tokens）。 */
export interface DeepseekModelPrice {
  /** 输入（缓存未命中）单价；缓存写入量按此价另计。 */
  inputMiss: CnyPerMillion
  /** 输入（缓存命中）单价。 */
  inputHit: CnyPerMillion
  /** 输出。 */
  output: CnyPerMillion
}

/**
 * 在售模型价目表，按 API model id 前缀匹配（最长前缀优先）。
 * 新模型上线而本表未收录时，估算返回 undefined，界面不显示金额（只显示
 * token 用量），不会给出错误数字。
 */
export const DEEPSEEK_MODEL_PRICES: Readonly<Record<string, DeepseekModelPrice>> = {
  'deepseek-flash': {
    inputMiss: [1.0, 2.0],
    inputHit: [0.02, 0.04],
    output: [4.0, 8.0],
  },
  'deepseek-v4-flash': {
    inputMiss: [1.0, 2.0],
    inputHit: [0.02, 0.04],
    output: [4.0, 8.0],
  },
  'deepseek-v4-flash-vision-exp': {
    inputMiss: [1.0, 2.0],
    inputHit: [0.02, 0.04],
    output: [4.0, 8.0],
  },
}

/** 是否 DeepSeek 官方 provider（定价只适用官方计费口径）。 */
export function isDeepseekProvider(provider: string): boolean {
  return /deepseek/i.test(provider)
}

/**
 * 是否处于高峰计费时段：北京时间周一至周五 9:00-12:00、14:00-18:00。
 * 北京时间为 UTC+8 固定偏移（无夏令时），用 UTC 时刻加偏移换算。
 */
export function isPeakHour(date: Date = new Date()): boolean {
  const shifted = new Date(date.getTime() + 8 * 3_600_000)
  const weekday = shifted.getUTCDay() // 0 = Sunday
  const hour = shifted.getUTCHours()
  if (weekday === 0 || weekday === 6) return false
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/** 按前缀匹配模型价目，最长前缀优先；未收录返回 undefined。 */
export function priceForModel(model: string): DeepseekModelPrice | undefined {
  let best: DeepseekModelPrice | undefined
  let bestLength = 0
  for (const [prefix, price] of Object.entries(DEEPSEEK_MODEL_PRICES)) {
    if (model.startsWith(prefix) && prefix.length > bestLength) {
      best = price
      bestLength = prefix.length
    }
  }
  return best
}

/** 一个峰/谷桶的 token 分项（与 usage 事件的字段对齐）。 */
export interface CostBucket {
  /** 缓存命中输入（按命中价计）。 */
  hit: number
  /** 其余输入（按未命中价计）。 */
  miss: number
  /** 输出。 */
  output: number
}

/** 按计价时段分桶的会话 token：每笔用量按其发生时刻落入峰或谷。 */
export interface CostBuckets {
  peak: CostBucket
  idle: CostBucket
}

/** 空的峰谷分桶（新会话累计起点）。 */
export function emptyCostBuckets(): CostBuckets {
  return {
    peak: { hit: 0, miss: 0, output: 0 },
    idle: { hit: 0, miss: 0, output: 0 },
  }
}

/**
 * 把一笔用量按发生时刻累加进分桶（不取整不设防，负数调用方自己不传）。
 * msc 的用量口径：`inputTokens` 是 prompt_tokens 总量（缓存命中**包含在内**），
 * 与 dsh 的「互斥分项」不同——所以这里先拆命中/未命中，端点没报明细时全部输入
 * 按未命中价计（保守上限，估算只会偏高不会漏）。
 */
export function addUsageToBuckets(
  buckets: CostBuckets,
  usage: { inputTokens: number; outputTokens: number; cacheHitTokens?: number; cacheMissTokens?: number },
  peak: boolean,
): void {
  const bucket = peak ? buckets.peak : buckets.idle
  const hit = usage.cacheHitTokens ?? 0
  const miss =
    usage.cacheMissTokens ??
    (usage.cacheHitTokens === undefined ? usage.inputTokens : Math.max(usage.inputTokens - hit, 0))
  bucket.hit += hit
  bucket.miss += miss
  bucket.output += usage.outputTokens
}

/** 按峰/谷单价计一桶的钱（元，未除 1e6）。 */
function bucketCost(bucket: CostBucket, price: DeepseekModelPrice, rateIndex: 0 | 1): number {
  return (
    bucket.miss * price.inputMiss[rateIndex]
    + bucket.hit * price.inputHit[rateIndex]
    + bucket.output * price.output[rateIndex]
  )
}

/** 待计价的一份累计：哪个模型、峰谷各多少 token。 */
export interface PricedEntry {
  model: string
  buckets: CostBuckets
}

/**
 * 会话费用估算（人民币，元）：逐模型查价求和，峰桶按高峰价、谷桶按空闲价。
 * 没有任何一笔可计价 token（provider 不对口 / 模型未收录 / 一次用量都没有）时
 * 返回 undefined，调用方不显示金额。
 */
export function estimateSessionCostCny(
  entries: readonly PricedEntry[],
): { total: number; peak: number; idle: number } | undefined {
  let total = 0
  let peak = 0
  let idle = 0
  let tokens = 0
  for (const entry of entries) {
    const price = priceForModel(entry.model)
    if (price === undefined) continue
    const bucketTokens =
      entry.buckets.peak.hit + entry.buckets.peak.miss + entry.buckets.peak.output
      + entry.buckets.idle.hit + entry.buckets.idle.miss + entry.buckets.idle.output
    if (bucketTokens <= 0) continue
    tokens += bucketTokens
    peak += bucketCost(entry.buckets.peak, price, 1) / 1_000_000
    idle += bucketCost(entry.buckets.idle, price, 0) / 1_000_000
  }
  if (tokens <= 0) return undefined
  total = peak + idle
  return { total, peak, idle }
}
