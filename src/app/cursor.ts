/**
 * IME 光标停靠（0.6.57）：把终端光标定位到输入框的 caret 上，Windows Terminal
 * 的 IME 组合预览（拼音）就画在输入框里，而不是屏幕左下角。
 *
 * ink 6.8 内置 `useCursor`（注释明说就是给 IME 用的）：渲染期声明 {x, y}，帧尾
 * 用 cursorUp/cursorTo 把**可见光标**停在目标位；声明 undefined 则隐藏。这里包一层
 * 声明逻辑——Composer 传 value/caret 的逻辑行列，几何（盒在帧内的绝对行）在渲染时
 * 用 yoga 现量（上一帧的布局；输入框贴底、位置天然稳定，补全面板开合的那一帧
 * 会有一次滞后，下一帧自愈）。
 *
 * 列常量对应 Composer 的几何：0 基列 = 边框 1 + padding 1 + 提示符「❯ 」2 → 正文
 * 从第 4 列起。行 = 盒顶（含边框）+ 上边框 1 行 + 逻辑行号。
 *
 * @module dsc-tui/app/cursor
 */
import { useCursor } from 'ink'
import type { DOMElement } from 'ink'
import type { RefObject } from 'react'
import { absoluteTop } from './click.js'

/** 声明光标落点：node 是带边框的输入盒，line/col 是 caret 的逻辑行列（0 基）。 */
export function useParkedCursor(
  node: RefObject<DOMElement | null>,
  line: number,
  col: number,
  enabled: boolean,
): void {
  const { setCursorPosition } = useCursor()
  // ink 的约定是渲染期直接声明（内部走 ref，commit 阶段统一推送）。
  const top = enabled ? absoluteTop(node.current) : null
  setCursorPosition(top === null ? undefined : { x: 4 + col, y: top + 1 + line })
}
