/**
 * 每轮对话底部的一行：时刻 + 用时 + 分叉入口。
 *   本轮时间 = 用户发消息那一刻的 HH:mm；
 *   本轮用时 = 该轮末条目 ts − 用户消息 ts（中间的工具调用、思考都算在里面）。
 *
 * 降级规则（老会话没有 ts 时是常态，不是异常）：
 * - 两个时间都拿不到、又没有分叉按钮要画 → 整行不画；
 * - 只拿得到开始时刻（这一轮的条目都没有 ts）→ 只显示 HH:mm，不显示用时；
 * - 用时算出来是负数或 NaN（日志时间乱序）→ 只显示 HH:mm。
 * 任何情况下都不会出现「NaN」或「0秒」这种假数据。
 *
 * 这一轮还在跑（running）时时间和用时都不画：那一刻流末尾的状态行正在报同一份时间，
 * 两处一起跳反而乱；但分叉按钮要留在这一行上（置灰），用户才知道这一轮结束时能在哪分叉。
 *
 * 「分叉」这颗按钮挂在这一行的右端（时间/用时的右边）：它按的是「以这一轮的用户消息为界
 * 复制出一份新会话」，跟这一轮的时间是同一件事的两面，所以跟时间同处一行。
 * 只读视图（队友运行记录）不传 onFork，这里整颗不画——宿主本来就拒绝分叉队友文件。
 *
 * 用时怎么算是 turn-timing.ts 的 roundDuration 说了算，这里只负责画：
 * 同一套口径只留一处，免得两个组件各算一遍算出两个数。
 *
 * @module desktop/renderer/TurnFooter
 */
import type { JSX } from 'react'
import { IconBranch } from './icons.js'
import { formatClock, formatDuration, roundDuration, type RoundInfo } from './turn-timing.js'

export function TurnFooter(props: {
  round: RoundInfo
  /** 这一轮还在跑：时间与用时先不画（状态行正在报同一份时间），分叉按钮置灰留着。 */
  running?: boolean
  /**
   * 以这一轮的用户消息为界分叉出新会话（参数是那条用户消息在 entries 里的下标）。
   * 不传 = 这个视图不提供分叉（只读视图），按钮整颗不画。
   */
  onFork?: (entryIndex: number) => void
  /** 分叉按钮能不能按：一轮正在跑、或这条消息之前没有内容时为真。 */
  forkDisabled?: boolean
  /** 分叉按钮的悬停提示；不传用默认那句（分叉点定不下来时的原因由 ChatView 传进来）。 */
  forkTitle?: string
}): JSX.Element | null {
  const running = props.running === true
  const clock = running ? null : formatClock(props.round.startTs)
  const used = running ? null : formatDuration(roundDuration(props.round))
  const fork = props.onFork !== undefined
  // 老会话两个时间都拿不到、又没有分叉入口要画：这一行不必占位
  if (clock === null && used === null && !fork) return null
  return (
    <div className="round-foot">
      {clock !== null && (
        <span className="round-clock" title="这条消息发出的时刻（本机时区）">
          {clock}
        </span>
      )}
      {clock !== null && used !== null && (
        <span className="round-sep" aria-hidden="true">
          ·
        </span>
      )}
      {used !== null && (
        <span
          className="round-used"
          title="从发出这条消息到这一轮最后一次写入（中间的工具调用与思考都算在内）"
        >
          用时 {used}
        </span>
      )}
      {fork && (
        <button
          type="button"
          className="user-act"
          title={props.forkTitle ?? '以这条消息为界分叉出新会话'}
          aria-label="以这条消息为界分叉出新会话"
          disabled={props.forkDisabled === true}
          onClick={() => props.onFork?.(props.round.startIndex)}
        >
          <IconBranch size={12} />
        </button>
      )}
    </div>
  )
}
