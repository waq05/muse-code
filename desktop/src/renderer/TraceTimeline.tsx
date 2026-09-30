/**
 * 轨迹页的时间概览条：把整个会话的步骤按「(时刻 − 首条时刻) / 总时长」投影成一条横向时间轴。
 *
 * 三条诚实规矩（对照 dsh 的时间条口径，本文件里不许破）：
 * 1. 只有拿得到 `durationMs` 的工具才画**有宽度**的条；思考 / 系统 / 计划卡只画一条起点刻度。
 *    绝不拿「总时长 ÷ 步骤数」之类的平均宽度充数——那是编出来的宽度；
 * 2. 没有耗时就不写耗时：悬停提示里给「耗时未记录」，不给 0s，也不给估算值；
 * 3. 一条带时间的记录都没有（2026-09 之前的老会话）时，整条时间轴不画，只留一句说明。
 *
 * 条自己跟随尾部：起点与终点每次渲染都从 `spanStart` / `spanEnd` 现算，新步骤一来右端就跟着长。
 *
 * 交互（滚轮缩放 / 平移这一轮不做）：悬停 500ms 出精确时刻与耗时；在轨道上拖选一段区间，
 * 下方记录表据此聚焦；点一下（没拖动）或右键清除。
 *
 * @module desktop/renderer/TraceTimeline
 */
import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { formatClockSeconds, formatTraceDuration } from './trace-format.js'
import type { TraceBoundary, TraceMark, TraceRange } from './trace-format.js'

/** 悬停多久才弹提示：500ms 是「停下来看」与「扫过去」的分界（需求指定）。 */
const HOVER_DELAY_MS = 500
/** 拖动多少像素才算拖选：小于这个数当点击处理（点击 = 清除区间）。 */
const DRAG_MIN_PX = 4

export function TraceTimeline(props: {
  marks: TraceMark[]
  boundaries: TraceBoundary[]
  spanStart: number | null
  spanEnd: number | null
  selected: TraceRange | null
  /** 选中的区间里有多少条步骤（计数在 TraceView 里算，两处不重复实现命中判定）。 */
  selectedCount: number
  onSelect: (range: TraceRange | null) => void
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null)
  /** 悬停提示：延迟到点才设置，鼠标走开就清掉。 */
  const [hover, setHover] = useState<TraceMark | null>(null)
  const hoverTimer = useRef<number | null>(null)
  /** 正在拖的区间（本地即时反馈；松手后才上报给 TraceView）。 */
  const [drag, setDrag] = useState<TraceRange | null>(null)
  const dragRef = useRef<{ pointerId: number; anchorTs: number; moved: boolean } | null>(null)

  const span = props.spanStart !== null && props.spanEnd !== null ? props.spanEnd - props.spanStart : 0
  /** 投影得出来吗：要有起止时刻，而且真的跨了一段时间。跨度为 0 时所有标记都会叠在最左端。 */
  const projectable = props.spanStart !== null && span > 0

  /** 时刻 → 轨道上的百分比。投影不出来时一律靠左，绝不按序号平均摆位。 */
  const percent = (ts: number): number => {
    if (!projectable || props.spanStart === null) return 0
    const ratio = (ts - props.spanStart) / span
    return Math.min(100, Math.max(0, ratio * 100))
  }

  const clearHover = (): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }
  /** 悬停满 500ms 才出提示；期间移开就撤掉计时器，一次都不弹。 */
  const armHover = (mark: TraceMark): void => {
    clearHover()
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null
      setHover(mark)
    }, HOVER_DELAY_MS)
  }
  const disarmHover = (): void => {
    clearHover()
    setHover(null)
  }
  useEffect(() => clearHover, [])

  /** 客户端 x → 时刻；投影不出来时返回 null（这种轨道不给拖选）。 */
  const timeAt = (clientX: number): number | null => {
    const track = trackRef.current
    if (track === null || !projectable || props.spanStart === null) return null
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return null
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return props.spanStart + ratio * span
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const at = timeAt(event.clientX)
    if (at === null) return
    disarmHover()
    dragRef.current = { pointerId: event.pointerId, anchorTs: at, moved: false }
    setDrag({ start: at, end: at })
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 指针捕获只是为了让手指拖出轨道后仍继续收 pointermove；拿不到捕获时（合成事件、
      // 个别触控实现）轨道内的拖动照旧生效，不该因为这一步把整段选择逻辑打断。
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const held = dragRef.current
    if (held === null || held.pointerId !== event.pointerId) return
    const at = timeAt(event.clientX)
    if (at === null) return
    if (!held.moved && Math.abs(at - held.anchorTs) > 0) {
      const rect = trackRef.current?.getBoundingClientRect()
      const movedPx = rect === undefined ? 0 : Math.abs(((at - held.anchorTs) / span) * rect.width)
      if (movedPx >= DRAG_MIN_PX) held.moved = true
    }
    setDrag({ start: Math.min(held.anchorTs, at), end: Math.max(held.anchorTs, at) })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const held = dragRef.current
    if (held === null || held.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const at = timeAt(event.clientX) ?? held.anchorTs
    const range = { start: Math.min(held.anchorTs, at), end: Math.max(held.anchorTs, at) }
    setDrag(null)
    // 没拖动 = 一下点击 = 清除已有区间（需求：再点一次清除）。
    if (!held.moved) {
      props.onSelect(null)
      return
    }
    props.onSelect(range)
  }

  const range = drag ?? props.selected
  const rangeLabel =
    range === null
      ? null
      : `${formatTraceDuration(range.end - range.start) ?? '0.0s'} · ${String(props.selectedCount)} 步`

  if (props.spanStart === null || props.spanEnd === null) {
    return (
      <div className="trace-timeline is-empty" data-trace-timeline="empty">
        <span className="ttl-title">时间概览</span>
        <span className="ttl-note">本会话没有记录时间戳（2026-09 之前的老会话），时间条不画。</span>
      </div>
    )
  }

  return (
    <div className="trace-timeline" data-trace-timeline="1" data-marks={String(props.marks.length)}>
      <div className="ttl-head">
        <span className="ttl-title">时间概览</span>
        <span className="ttl-range">
          {formatClockSeconds(props.spanStart)} → {formatClockSeconds(props.spanEnd)} ·{' '}
          {formatTraceDuration(span) ?? '不足 0.1s'}
        </span>
        {rangeLabel !== null && props.selected !== null && (
          <button
            type="button"
            className="ttl-chip"
            data-trace-selection-chip="1"
            data-tip="点这里清除区间（也可以在轨道上点一下、或右键清除）"
            onClick={() => props.onSelect(null)}
          >
            已选 {rangeLabel} · 清除
          </button>
        )}
      </div>
      <div
        className="ttl-track"
        ref={trackRef}
        data-trace-track="1"
        data-projectable={projectable ? '1' : '0'}
        role="group"
        aria-label="会话时间概览：横向为时间，拖选一段区间可聚焦下方记录"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null
          setDrag(null)
        }}
        onPointerLeave={disarmHover}
        onContextMenu={(event) => {
          // 右键清除：不想为了取消一次拖选还得对准轨道点一下。
          event.preventDefault()
          props.onSelect(null)
        }}
      >
        {props.boundaries.map((boundary) => (
          <span
            key={`boundary-${String(boundary.round)}`}
            className="ttl-sep"
            data-trace-boundary={String(boundary.round)}
            style={{ left: `${String(percent(boundary.ts))}%` }}
            data-tip={`第 ${String(boundary.round + 1)} 轮从这里开始`}
          />
        ))}
        {props.marks.map((mark) =>
          mark.end === null ? (
            // 没有耗时的步骤：只画起点刻度。宽度是 0，不是「很小」——不虚构。
            <span
              key={mark.id}
              className={`ttl-tick kind-${mark.kind}`}
              data-trace-mark={String(mark.id)}
              data-kind={mark.kind}
              style={{ left: `${String(percent(mark.start))}%` }}
              onPointerEnter={() => armHover(mark)}
              onPointerLeave={disarmHover}
            />
          ) : (
            <span
              key={mark.id}
              className={`ttl-bar kind-${mark.kind}`}
              data-trace-mark={String(mark.id)}
              data-kind={mark.kind}
              data-duration={String(mark.durationMs ?? '')}
              style={{
                left: `${String(percent(mark.start))}%`,
                width: `${String(Math.max(0.4, percent(mark.end) - percent(mark.start)))}%`,
              }}
              onPointerEnter={() => armHover(mark)}
              onPointerLeave={disarmHover}
            />
          ),
        )}
        {range !== null && (
          <span
            className="ttl-sel"
            data-trace-selection="1"
            style={{
              left: `${String(percent(range.start))}%`,
              width: `${String(Math.max(0.3, percent(range.end) - percent(range.start)))}%`,
            }}
          />
        )}
        {hover !== null && (
          <span
            className="ttl-tip"
            data-trace-tip="1"
            style={{ left: `${String(percent((hover.start + (hover.end ?? hover.start)) / 2))}%` }}
          >
            <b>{hover.name}</b>
            <span>{formatClockSeconds(hover.ts ?? hover.start) ?? '时刻未记录'}</span>
            <span>
              {hover.durationMs === null
                ? '耗时未记录'
                : `耗时 ${formatTraceDuration(hover.durationMs) ?? '未记录'}`}
            </span>
          </span>
        )}
      </div>
    </div>
  )
}
