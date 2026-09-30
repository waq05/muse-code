/**
 * 每轮对话底部的时间与用时：
 *   本轮时间 = 用户发消息那一刻的 HH:mm；
 *   本轮用时 = 该轮末条目 ts − 用户消息 ts（中间的工具调用、思考都算在里面）。
 *
 * 降级规则（老会话没有 ts 时是常态，不是异常）：
 * - 两个时间都拿不到 → 整行不画；
 * - 只拿得到开始时刻（这一轮的条目都没有 ts）→ 只显示 HH:mm，不显示用时；
 * - 用时算出来是负数或 NaN（日志时间乱序）→ 只显示 HH:mm。
 * 任何情况下都不会出现「NaN」或「0秒」这种假数据。
 *
 * 用时怎么算是 turn-timing.ts 的 roundDuration 说了算，这里只负责画：
 * 同一套口径只留一处，免得两个组件各算一遍算出两个数。
 *
 * @module desktop/renderer/TurnFooter
 */
import type { JSX } from 'react'
import { formatClock, formatDuration, roundDuration, type RoundInfo } from './turn-timing.js'

export function TurnFooter(props: { round: RoundInfo }): JSX.Element | null {
  const clock = formatClock(props.round.startTs)
  const used = formatDuration(roundDuration(props.round))
  if (clock === null && used === null) return null
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
    </div>
  )
}
