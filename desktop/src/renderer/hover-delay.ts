/**
 * 「停 500ms 出卡、移开 100ms 后收」的悬停计时（dsh HoverCard 的节奏）。
 * 轮尾「文件已更改」卡的文件行与正文里的文件提及 chip 两处共用同一份；
 * 收卡的 100ms 延迟同时留出「把鼠标移进卡里」的间隙——移进去了 keep() 就续命。
 *
 * @module desktop/renderer/hover-delay
 */
import { useEffect, useRef, useState } from 'react'

/** 悬停多久才出卡（ms）：短了划过就闪，长了像坏了。 */
const HOVER_DELAY_MS = 500
/** 移开多久后收卡（ms）：dsh HoverCard 的 100ms 淡出。 */
const HOVER_CLOSE_MS = 100

/** 出卡后挂在 state 上的三样：悬停对象、触发元素的矩形、预览卡的基准宽度。 */
export interface HoverState<T> {
  item: T
  anchor: DOMRect
  cardWidth: number
}

export function useHoverDelay<T>(): {
  hover: HoverState<T> | null
  /** 元素上停下来了：起出卡计时（已有的收卡倒计时一并取消）。 */
  arm: (item: T, anchor: DOMRect, cardWidth?: number) => void
  /** 鼠标移开：起 100ms 收卡倒计时。 */
  disarm: () => void
  /** 鼠标进了卡里：取消收卡倒计时。 */
  keep: () => void
  /** 立刻收卡（Esc / 换行）。 */
  close: () => void
} {
  const [hover, setHover] = useState<HoverState<T> | null>(null)
  const armRef = useRef<number | null>(null)
  const closeRef = useRef<number | null>(null)
  const clearArm = (): void => {
    if (armRef.current !== null) {
      window.clearTimeout(armRef.current)
      armRef.current = null
    }
  }
  const clearClose = (): void => {
    if (closeRef.current !== null) {
      window.clearTimeout(closeRef.current)
      closeRef.current = null
    }
  }
  useEffect(
    () => () => {
      clearArm()
      clearClose()
    },
    [],
  )
  const arm = (item: T, anchor: DOMRect, cardWidth = 520): void => {
    clearArm()
    clearClose()
    armRef.current = window.setTimeout(() => setHover({ item, anchor, cardWidth }), HOVER_DELAY_MS)
  }
  const disarm = (): void => {
    clearArm()
    clearClose()
    closeRef.current = window.setTimeout(() => setHover(null), HOVER_CLOSE_MS)
  }
  return {
    hover,
    arm,
    disarm,
    keep: clearClose,
    close: (): void => {
      clearArm()
      clearClose()
      setHover(null)
    },
  }
}
