/**
 * core 事件流：MiniAgent 对外发布的唯一通道，adapter 消费它折叠成
 * contract 快照（对应 dsh 的 session/event + agent/assistant-stream 合体，
 * 但形状自定、零宿主依赖）。
 *
 * @module dsc/core/events
 */

/** MiniAgent 事件。 */
export type CoreEvent =
  /** 用户输入已入会话（回显）。 */
  | { type: 'user'; text: string }
  /** 一次模型请求的定稿（直播尾此刻应折叠为定稿条目）。 */
  | { type: 'message'; text: string; reasoning: string }
  /** 流式增量（直播尾）。 */
  | { type: 'delta'; kind: 'text' | 'reasoning'; text: string }
  | { type: 'tool/call'; callId: string; name: string; args: string }
  | { type: 'tool/result'; callId: string; text: string; error?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'turn/start' }
  | { type: 'turn/end'; reason: 'completed' | 'aborted' | 'error' }
