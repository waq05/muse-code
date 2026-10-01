/**
 * 视口高度：把「这台设备此刻真能看见的高度」写进 CSS 变量 `--app-h`。
 *
 * 为什么不能只用 CSS 的 `100dvh`：`dvh` 是「动态视口」，可它的实现并不一致。
 * 在自带底部工具栏的手机浏览器与 WebView 里，它按「工具栏收起时」的大视口算，
 * 于是这套固定高度的 flex 列（`.app` → `.page` → 对话流 + 发送框）比可见区域更高，
 * 最底下的发送框被推到工具栏下面；而页面本身不滚（`body { overflow: hidden }`，
 * 滚动只发生在对话流里），用户既看不到也够不着它——真机上表现为「网页没有输入框」。
 *
 * `visualViewport.height` 才是用户此刻真能看见的高度：工具栏、软键盘弹起都会让它
 * 变小，所以用它算。拿不到 `visualViewport` 的浏览器退回 `window.innerHeight`；
 * CSS 里还留了 `100%` 与 `100svh` 两级兜底，JS 没跑到也不会像 `100dvh` 那样溢出。
 *
 * 另一个坑：iOS 上工具栏收起/展开**不一定**发 `window.resize`，但一定会动
 * `visualViewport`，所以除了 `resize` 还要听它的 `scroll`。
 *
 * @module remote-web/lib/viewport
 */

/** 极端值（0、NaN、个位数）会把布局压没，兜底一个最小高度。 */
const MIN_HEIGHT = 320

/** CSS 变量名：`styles.css` 的 `.app` 把它当高度的最后一层兜底。 */
export const APP_HEIGHT_VAR = '--app-h'

/** 只取用得到的那一个字段，便于单测塞假对象。 */
export interface ViewportLike {
  height: number
}

/**
 * 算出要写进 CSS 的高度（px，整数）。
 *
 * @param viewport - `window.visualViewport`（可为空：老浏览器没有它，单测也塞 null）
 * @param innerHeight - `window.innerHeight`，兜底用
 * @returns 可见高度；两个来源都不可用时返回 {@link MIN_HEIGHT}
 */
export function appHeight(viewport: ViewportLike | null | undefined, innerHeight: number): number {
  const fromViewport = viewport !== null && viewport !== undefined && Number.isFinite(viewport.height) && viewport.height > 0
  const raw = fromViewport ? (viewport as ViewportLike).height : innerHeight
  if (Number.isFinite(raw) === false || raw <= 0) return MIN_HEIGHT
  return Math.max(MIN_HEIGHT, Math.round(raw))
}

/**
 * 装上监听并立刻写一次变量；返回卸载函数。
 *
 * 用 `addEventListener` 而不是 `onresize =`：后者会把同一 target 上别人的处理器顶掉。
 * 可重复安装/卸载（React 严格模式会 mount 两次），卸载后不留监听器。
 *
 * @param target - 默认 `window`；单测可以塞一个带 `document`/`innerHeight`/`addEventListener` 的假对象
 * @returns 卸载函数
 */
export function installViewportHeight(target: Window = window): () => void {
  const doc = target.document
  const viewport = (target as unknown as { visualViewport?: (ViewportLike & EventTarget) | null }).visualViewport ?? null

  const apply = (): void => {
    const height = appHeight(viewport, target.innerHeight)
    doc.documentElement.style.setProperty(APP_HEIGHT_VAR, `${String(height)}px`)
  }

  apply()
  target.addEventListener('resize', apply)
  target.addEventListener('orientationchange', apply)
  viewport?.addEventListener('resize', apply)
  // iOS 工具栏收起/展开只动 visualViewport，不发 window.resize
  viewport?.addEventListener('scroll', apply)

  return () => {
    target.removeEventListener('resize', apply)
    target.removeEventListener('orientationchange', apply)
    viewport?.removeEventListener('resize', apply)
    viewport?.removeEventListener('scroll', apply)
  }
}
