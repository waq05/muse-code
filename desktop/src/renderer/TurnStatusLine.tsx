/**
 * 助手回合进行中的状态行（对照 dsh 截图的那两行）：
 *   第一行：旋转圈 + 阶段说明（正在分析请求 / 正在执行工具 / 等待你的确认）；
 *   第二行：星标 + 当前活动名（正在调用 read_file）+ 已用时 + 尾部动画省略号。
 *
 * 计时口径：这一轮从用户消息发出算起（条目上的 ts，见 turn-timing.ts）。
 * 老会话拿不到 ts 时退回「本组件第一次看到这一轮的时刻」——计时器因此永远有值，
 * 不会显示 NaN；它只是不精确，这比整块不显示要好。
 *
 * 动画只走 CSS keyframes（styles.css 末尾那一区），并在
 * `prefers-reduced-motion: reduce` 下降级为静态。
 *
 * @module desktop/renderer/TurnStatusLine
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { IconSpark } from './icons.js'
import { formatDuration } from './turn-timing.js'

export function TurnStatusLine(props: {
  /** 第一行的阶段说明。 */
  stage: string
  /** 第二行的当前活动名。 */
  activity: string
  /** 这一轮的开始时刻；拿不到（老会话）传 null。 */
  startedAt: number | null
}): JSX.Element {
  // 组件挂载那一刻当兜底起点：这一轮可能在本视图打开之前就开始了，只能从这里算
  const fallbackStart = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())

  // 每秒跳一次。这个 interval 只在状态行挂着的时候存在，回合结束随组件一起卸载。
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const elapsed = formatDuration(now - (props.startedAt ?? fallbackStart.current))

  return (
    <div className="turn-status">
      <div className="turn-status-row">
        {/* 圈只有装饰作用，念出来是一串无意义的字：aria-hidden */}
        <span className="turn-status-spin" aria-hidden="true" />
        {/* 阶段会变，用一个 live region 报出去；下面那个每秒跳的计时器不报，
            否则读屏会每秒念一遍用时 */}
        <span className="turn-status-stage" role="status">
          {props.stage}
        </span>
      </div>
      <div className="turn-status-row">
        <IconSpark size={12} className="turn-status-icon" />
        <span className="turn-status-activity">
          {props.activity}
          {elapsed === null ? null : `，用时 ${elapsed}`}
        </span>
        <span className="turn-status-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  )
}
