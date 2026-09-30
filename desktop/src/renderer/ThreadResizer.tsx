/**
 * 中间正文列两侧的拖拽条：向外拖对称变宽、向内拖变窄，双击复位成样式表默认的 76ch。
 *
 * 宽度只写一个 CSS 变量 `--dsc-thread-max`——正文、审批卡、输入框三处都读它，
 * 所以打字的地方和读字的地方永远同宽（对照 dsh 的 ConversationWidthControls）。
 * 拖动中只改变量、不动 React 状态，松手才落盘，避免每帧重渲染整棵树。
 *
 * @module desktop/renderer/ThreadResizer
 */
import { useCallback, type JSX, type RefObject } from 'react'
import { THREAD_EDGE_BUDGET, THREAD_MIN, readRightRailPx, setRootVar, useWidthDrag } from './panels.js'

export function ThreadResizer(props: {
  /** 承载正文的那一层（`.thread-zone`），拖拽条定位在它里面。 */
  zoneRef: RefObject<HTMLElement | null>
  /** 已存档的列宽（px）。null = 还没拖过，用样式表默认的 76ch。 */
  width: number | null
  /** 松手落盘（px）。 */
  onCommit(px: number): void
  /** 双击复位：删掉存档，回到 76ch。 */
  onReset(): void
}): JSX.Element {
  /**
   * 把想要的宽度夹成当前能生效的宽度。
   * 没存档时取「真实渲染出来的宽」，不重算 76ch：字号、密度两档都会改 76ch 的实际像素，
   * 只有渲染结果作数。
   *
   * 上限除了两侧的热区预算，还要让出右缘的刻度轨道与滚动条（readRightRailPx）：
   * 拖到最宽时正文的右缘要停在刻度条左边，而不是伸到刻度底下。
   * 左边界不动——左边没有第三条轨道，原来的预算够用。
   */
  const resolve = (px: number | null): number => {
    const zone = props.zoneRef.current
    if (zone === null) return THREAD_MIN
    const max = Math.max(THREAD_MIN, zone.clientWidth - THREAD_EDGE_BUDGET - readRightRailPx())
    if (px === null) {
      const column = zone.querySelector<HTMLElement>('.chat-inner')
      return Math.min(Math.max(column?.offsetWidth ?? THREAD_MIN, THREAD_MIN), max)
    }
    return Math.min(Math.max(px, THREAD_MIN), max)
  }

  const getBase = useCallback((): number => resolve(props.width), [props.width])
  const clamp = useCallback((px: number): number => resolve(px), [props.width])
  const onDrag = useCallback((px: number): void => setRootVar('--dsc-thread-max', `${px}px`), [])
  const shared = { getBase, clamp, onDrag, trackPointerY: true }
  const left = useWidthDrag({ ...shared, sign: -2, onCommit: props.onCommit })
  const right = useWidthDrag({ ...shared, sign: 2, onCommit: props.onCommit })

  return (
    <>
      <div
        className="thread-handle"
        data-side="left"
        data-tip="拖拽调整正文宽度，双击复位"
        onPointerDown={left.onPointerDown}
        onPointerMove={left.onPointerMove}
        onPointerUp={left.onPointerUp}
        onPointerCancel={left.onPointerCancel}
        onDoubleClick={props.onReset}
      />
      <div
        className="thread-handle"
        data-side="right"
        data-tip="拖拽调整正文宽度，双击复位"
        onPointerDown={right.onPointerDown}
        onPointerMove={right.onPointerMove}
        onPointerUp={right.onPointerUp}
        onPointerCancel={right.onPointerCancel}
        onDoubleClick={props.onReset}
      />
    </>
  )
}
