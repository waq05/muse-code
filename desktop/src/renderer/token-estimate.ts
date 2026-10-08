/**
 * 正文 token 粗估（转出口）+ 数量格式化。
 *
 * 为什么渲染层还有这个文件：宿主与界面的「约 N token」必须同口径——估算函数的唯一
 * 原件在宿主 `core/token-estimate.ts`（经 `@dsc/runtime` 取用，纯函数、零依赖），
 * 这里只做转出口给各组件一行 import，外加渲染层自己的数量格式化。
 *
 * 凡是用了估算数字的地方都要带「约」或「~」：它是估算，不是服务端真值。
 *
 * @module desktop/renderer/token-estimate
 */

export { estimateTextTokens } from '@dsc/runtime/core/token-estimate.js'

/**
 * 输出速度与首字延迟的口径原件在宿主 `core/throughput.ts`：转出口给各组件一行 import。
 * 谁都不许在渲染层自己再写一遍 `token ÷ 秒` —— 口径只许有一份。
 */
export {
  averageTtftMs,
  formatTokensPerSecond,
  tokensPerSecond,
} from '@dsc/runtime/core/throughput.js'

/** 去掉小数末尾多余的 0：46.0K → 46K，1.00M → 1M。 */
function trimZero(value: number): string {
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/**
 * 数量按 K / M 压短（对照 dsh 的 123M tok / ~46.1K）：
 * 1000 以下给原值，之后各有两级精度，窗口值 128000 也会读成 128K。
 */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count))
  if (count < 1_000_000) return `${trimZero(count / 1_000)}K`
  return `${trimZero(count / 1_000_000)}M`
}

/**
 * 精确数量：千分位逗号（对照 dsh 的 6,912,345 tok）。
 *
 * 紧凑那份给状态栏与侧栏的单行读数用，卡片里给精确值——与 dsh 同一分工
 * （pill 紧凑、详情卡精确）。
 */
export function formatExactTokens(count: number): string {
  return Math.round(count).toLocaleString('en-US')
}

/** 把命中率换算成「百分比整数单位」（0 位小数 = 1 单位 1%，1 位小数 = 1 单位 0.1%）。 */
function roundedPercentUnits(cacheReadTokens: number, denominator: number, decimalPlaces: 0 | 1): number {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10
  const scale = unitsPerPercent * 100
  const doubledScale = scale * 2
  const denominatorQuotient = Math.floor(denominator / doubledScale)
  const denominatorRemainder = denominator % doubledScale
  let lower = 0
  let upper = scale
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient
      + Math.ceil((factor * denominatorRemainder) / doubledScale)
    if (cacheReadTokens >= threshold) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

/** 百分比单位 → 显示文本（1 位小数档末尾的 0 省掉）。 */
function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / 10)
  const tenths = units % 10
  return tenths === 0 ? String(whole) : `${whole}.${String(tenths)}`
}

/**
 * 前缀缓存命中率（对照 dsh 的 formatCacheHitPercent）：部分命中绝不四舍五入成
 * 100%——差几个 token 时加位数把它和满命中区分开（99.9 / 99.996…）。分母
 * （prompt 侧总量）为 0 时返回 null，调用方整行省略。
 */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0,
): string | null {
  if (promptTokens === 0) return null
  const missedInputTokens = promptTokens - cacheReadTokens
  if (missedInputTokens === 0) return '100'
  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000
  if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces)
  let distinguishingPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(promptTokens / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    distinguishingPlaces += 1
  }
  const denominatorOnes = promptTokens % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${String(10 - roundedLoss)}`
}
