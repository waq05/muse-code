/**
 * IME 光标停靠（0.6.57，0.6.59 改动态列原点）：把终端光标定位到输入框的 caret 上，
 * Windows Terminal 的 IME 组合预览（拼音）就画在输入框里，而不是屏幕左下角。
 *
 * ink 6.8 内置 `useCursor`（注释明说就是给 IME 用的）：渲染期声明 {x, y}，帧尾
 * 用 cursorUp/cursorTo 把**可见光标**停在目标位；声明 undefined 则隐藏。
 * 几何（盒的绝对行/列）渲染时现量（上一帧布局；输入框贴底天然稳定，补全面板
 * 开合那一帧滞后一帧自愈）。列原点 = 盒左 + 边框 1 + padding 1 + 提示符段
 * （「⌸ 」可选 +「❯ 」= promptCols），由 Composer 按自己的渲染传进来。
 *
 * @module dsc-tui/app/cursor
 */
import { useCursor } from 'ink'
import type { DOMElement } from 'ink'
import type { RefObject } from 'react'
import { absoluteLeft, absoluteTop } from './click.js'

/** 声明光标落点：node 是带边框的输入盒，line/col 是 caret 的逻辑行列（0 基）。 */
export function useParkedCursor(
  node: RefObject<DOMElement | null>,
  line: number,
  col: number,
  enabled: boolean,
  promptCols = 2,
): void {
  const { setCursorPosition } = useCursor()
  // ink 的约定是渲染期直接声明（内部走 ref，commit 阶段统一推送）。
  const top = enabled ? absoluteTop(node.current) : null
  const left = enabled ? absoluteLeft(node.current) : null
  setCursorPosition(
    top === null || left === null
      ? undefined
      : { x: left + 2 + promptCols + col, y: top + 1 + line },
  )
}
