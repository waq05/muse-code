/**
 * 正文 token 粗估（全仓库唯一一份）。
 *
 * 为什么单独一个模块：这段口径此前在宿主 core/compact.ts 和渲染层 token-estimate.ts
 * 各抄了一份——界面上写的「约 N token」必须和宿主自动压缩用的阈值同源，不然会出现
 * 界面说 3 万、宿主按 5 万判断压缩这种对不上的情况。现在宿主与渲染层都从这里取
 * （渲染层经 `@dsc/runtime/core/token-estimate.js`，纯函数、零依赖，进得了渲染层）。
 *
 * 口径（2026-09-29 从 chars/3 改为 CJK 分开算）：中文一个字约 0.6~0.7 token，
 * chars/3 会把中文低估约一半——自动压缩要等真实用量冲到窗口 100% 以上才触发，直接爆窗。
 * 这里中文按 0.65、其余按 0.33（≈3 字符/token）估，整体宁可高估（早压一次很便宜）
 * 也不低估（报错结束回合）。
 *
 * 凡是用了这里数字的地方都要带「约」或「~」：它是估算，不是服务端真值。
 *
 * @module dsc/core/token-estimate
 */

/** 中日韩字符区间。 */
const CJK_CHAR = /[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uA4CF\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

/** 估一段正文的 token 数（不取整；取整是调用方按展示口径自己的事）。 */
export function estimateTextTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK_CHAR.test(char)) cjk += 1
    else other += 1
  }
  return cjk * 0.65 + other * 0.33
}
