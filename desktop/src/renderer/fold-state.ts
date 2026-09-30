/**
 * 折叠条的展开状态存档（进程内，刷新即清）。
 *
 * 为什么要把这份状态从组件里搬出来：会话切换时宿主会 `transcript.clear()` + 重放，
 * 条目 id 从 1 重新发号，React 按 `key` 对账时会把用不上的组件卸载重挂。而
 * ToolCard / ThinkingBlock 的展开态本来只活在各自的 `useState` 里，一重挂就回默认——
 * 用户展开两条工具卡、切到别的会话看一眼再切回来，展开状态就没了。
 *
 * 存档键里带会话 id 与条目序号：同一会话的历史条目重挂时能读回原状态，不同会话天然
 * 不串味（两条会话的条目 id 都是从 1 开始的，只按 id 存会把别人的展开态借过来）。
 *
 * 只做「读一次初值、写回一次」：组件自己仍持有 useState，重挂时用初值函数把存档读回来。
 * 不引入订阅，免得每次展开都触发一次全量快照外的重渲染。
 *
 * @module desktop/renderer/fold-state
 */

const folds = new Map<string, boolean>()

/**
 * 整轮过程折叠的存档键：`会话id:turn:轮序号`。
 *
 * 与条目的 `会话id:e内容序号` 同一风格（都带会话前缀，两条会话不会互相借展开态）。
 * 用轮序号而不是条目 id 的原因与 ChatView 的 contentOrdinalAt 一样：宿主重放历史时
 * 条目 id 从 1 重新发号，而「第几轮」在两条加载路径上完全一致。
 *
 * @param sessionId 当前会话 id；未知传 null（这时整条键只有序号，也不会串味）
 * @param roundIndex 轮次序号（0 基，与 turn-timing 的 RoundInfo.index 同源）
 */
export function turnFoldKey(sessionId: string | null, roundIndex: number): string {
  return `${sessionId ?? ''}:turn:${String(roundIndex)}`
}

/** 读存档；没有记录就用调用方给的默认值（首次挂载与「没存档」是同一种情况）。 */
export function readFold(key: string | undefined, fallback: boolean): boolean {
  if (key === undefined) return fallback
  return folds.get(key) ?? fallback
}

/** 写存档；key 为 undefined 表示这个折叠条不参与存档（如轨迹页里的工具卡）。 */
export function writeFold(key: string | undefined, open: boolean): void {
  if (key === undefined) return
  folds.set(key, open)
}
