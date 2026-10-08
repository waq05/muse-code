/**
 * 输出速度（tok/s）与首字延迟的口径：唯一原件，界面与测试都从这里取。
 *
 * 算法照 dsh 的 sessionStats 投影（packages/session/session-stats/src/projection.ts:130-170）：
 * - 首字延迟 = 每次请求「发出 → 第一口输出」的墙钟，只在真拿到第一口的请求上累计；
 * - 分子分母**成对**取：同一次请求既要有第一口输出的时刻、又要有服务端上报的输出 token，
 *   才同时算进 decodeTokens 与 decodeMs——不能拿一部分请求的时间去除另一部分请求的 token；
 * - 分母是**纯解码时间**（第一口输出 → 定稿），首字等待、工具执行、等下一个请求的空转
 *   都不在里面；整个会话累计，不是「本轮」。
 *
 * 为什么单开一个文件：桌面状态栏、终端界面、测试必须同口径，谁也不许自己再写一遍除法。
 * 渲染层经 `@dsc/runtime/core/throughput.js` 转出口取用（desktop/src/renderer/token-estimate.ts）。
 *
 * @module dsc/core/throughput
 */

/**
 * 一次会话（或一次测量窗口）的墙钟累计与样本数。
 *
 * 全部只累计「有真值」的那部分：缺样本的请求不占分子也不占分母（宁缺不假）。
 */
export interface ThroughputTotals {
  /** 首字延迟的样本数：拿到第一口输出的请求数。 */
  ttftSteps: number
  /** 这些请求「发出 → 第一口输出」的累计毫秒。 */
  ttftMs: number
  /** 已定稿请求「发出 → 定稿」的累计毫秒（含内部重试与首字等待）。 */
  llmMs: number
  /** 解码期的累计毫秒（第一口输出 → 定稿），分母样本与 decodeTokens 同一批请求。 */
  decodeMs: number
  /** 与 decodeMs 同一批请求的服务端输出 token 之和。 */
  decodeTokens: number
}

/**
 * 输出速度（token/秒）：整个会话累计，除以纯解码时间。
 *
 * 解码期为 0（老日志没记时刻、或这一会话还没请求定稿）时返回 null——
 * 界面据此整段省略，绝不去除一个 0 印出天文数字。
 */
export function tokensPerSecond(totals: Pick<ThroughputTotals, 'decodeMs' | 'decodeTokens'>): number | null {
  if (!(totals.decodeMs > 0)) return null
  return totals.decodeTokens / (totals.decodeMs / 1_000)
}

/** 首字延迟平均（毫秒）：没有样本时返回 null，界面据此省略这一行。 */
export function averageTtftMs(totals: Pick<ThroughputTotals, 'ttftMs' | 'ttftSteps'>): number | null {
  if (!(totals.ttftSteps > 0)) return null
  return totals.ttftMs / totals.ttftSteps
}

/**
 * 速度读数格式（对照 dsh 的 formatTokensPerSecond）：
 * 10 以上给整数，10 以下给一位小数——8.4 / 12，不写 8.40 / 11.7。
 */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}
