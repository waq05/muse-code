/**
 * 识别宿主开场写进消息流的那条「会话 xxx · 模型 yyy」。
 *
 * 为什么需要这个模块：宿主每次开会话都会往 transcript 里塞一条 system 条目，
 * 正文是 `会话 ${id.slice(0, 8)} · 模型 ${provider}/${model}`
 * （见 src/host/kernel.ts:367）。界面这侧的状态栏第一段已经带着会话 id 与当前模型，
 * 输入区右下角也常显模型名，所以这条居中的灰字在消息流里是纯重复。
 * 宿主的条目照旧留在快照里（状态栏、上下文估算都还在用它），只是不画。
 *
 * 为什么按正文形状认而不是按 kind 认：宿主协议里 system 这一个 kind 混着沙箱提示、
 * 迁移提示、插件热挂载结果等十几种通知，只有这一条的正文长得出来这个形状。
 * 认不出就不动它——宁可按原样画出来，也不要误吞一条用户真该看到的提示。
 */
const SESSION_MARKER = /^会话 \S+ · 模型 \S+$/

/** 这条 system 通知是不是「会话 x · 模型 y」开场标（是的话界面可以不画它）。 */
export function isSessionMarker(text: string): boolean {
  return SESSION_MARKER.test(text.trim())
}
