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
