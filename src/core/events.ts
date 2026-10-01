/**
 * core 事件流：MiniAgent 对外发布的唯一通道，adapter 消费它折叠成
 * contract 快照（对应 dsh 的 session/event + agent/assistant-stream 合体，
 * 但形状自定、零宿主依赖）。
 *
 * @module dsc/core/events
 */
import type { FileChangeSummary } from './tools.js'

/** MiniAgent 事件。 */
export type CoreEvent =
  /**
   * 用户输入已入会话（回显）；images 是随消息发出去的 data URL 清单。
   *
   * `steering` = 这条是在助手回合**还没跑完**时插进来的（对照 dsh 的 steering 节点）。
   * 它同样会被并进这一轮的下一次模型请求（messages 是同一份），区别只在界面上：
   * 轮中途插过话的那一轮不再提供整轮折叠（对照 dsh 的 `hasInterleavedInput`）。
   */
  | { type: 'user'; text: string; images?: string[]; steering?: boolean }
  /**
   * 一次模型请求的定稿（直播尾此刻应折叠为定稿条目）。
   *
   * `finishReason` 是协议给的收尾原因；`'length'` 表示这次输出撞上了长度上限
   * （对照 dsh 的 `turn-max-tokens` 节点）。拿不到时传 null。
   */
  | { type: 'message'; text: string; reasoning: string; finishReason?: string | null }
  /** 流式增量（直播尾）。 */
  | { type: 'delta'; kind: 'text' | 'reasoning'; text: string }
  | { type: 'tool/call'; callId: string; name: string; args: string }
  /**
   * 模型开始吐某个工具调用的名字，参数还没到齐（对照 dsh 的 `preparing` 节点）。
   * 它计一次调用、不解析参数，界面上只渲染成不可展开的一行。
   */
  | { type: 'tool/prepare'; name: string }
  | { type: 'tool/result'; callId: string; text: string; error?: string }
  /**
   * 一次成功的 write / edit 落盘后的实际改动（紧跟在同 callId 的 `tool/result` 之后）。
   * adapter 折成 `kind: 'changes'` 条目，界面聚合成轮尾「文件已更改」卡。
   */
  | { type: 'tool/changes'; callId: string; change: FileChangeSummary }
  /**
   * 回合收尾的聚合改动（codex TurnDiffUpdatedNotification 的同位事件）：本回合动过的
   * 每个文件出一份「回合基线 vs 盘上终态」的差异，同文件多刀合并成一条。紧跟在
   * `turn/end` 之后发；adapter 折成 `kind: 'turnDiff'` 条目，界面优先拿它画轮尾卡。
   * 不落盘——重启恢复后界面回退逐刀合并显示。
   */
  | { type: 'turn/diff'; files: FileChangeSummary[] }
  /** 这次模型请求失败、正要重试（对照 dsh 的 `model-retry` 节点）。 */
  | { type: 'model/retry'; attempt: number; reason: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'turn/start' }
  | { type: 'turn/end'; reason: 'completed' | 'aborted' | 'error' }
