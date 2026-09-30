/**
 * 正文 token 粗估 + 数量格式化。
 *
 * 为什么在渲染层自己估：宿主既没在 transcript 里按条记录「这条消息用了多少
 * token」，也没上报上下文构成（系统提示词 / 工具定义各占多少），界面只拿得到
 * 正文本身。估的口径抄宿主 core/compact.ts 的那一套（中文一个字约 0.65 token、
 * 其余约 0.33），这样界面上写的「约」和宿主自动压缩用的阈值同源，不会出现
 * 界面说 3 万、宿主按 5 万判断压缩这种对不上的情况。
 *
 * 凡是用了这里数字的地方都要带「约」或「~」：它是估算，不是服务端真值。
 *
 * @module desktop/renderer/token-estimate
 */

/** 中日韩字符区间（与 core/compact.ts 的 CJK_CHAR 一致）。 */
const CJK_CHAR = /[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uA4CF\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

/** 估一段正文的 token 数（向上取整，宁可高估一点）。 */
export function estimateTextTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK_CHAR.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk * 0.65 + other * 0.33)
}

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
