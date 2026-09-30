/**
 * 中间正文列两侧的拖拽条：向外拖对称变宽、向内拖变窄，双击复位成样式表默认的 76ch。
 *
 * 宽度只写一个 CSS 变量 `--dsc-thread-max`——正文、审批卡、输入框三处都读它，
 * 所以打字的地方和读字的地方永远同宽（对照 dsh 的 ConversationWidthControls）。
 * 拖动中只改变量、不动 React 状态，松手才落盘，避免每帧重渲染整棵树。
 *
 * 把手摆在哪（本轮改版）：贴着正文列（`.chat-inner`）真正渲染出来的左右边缘，
 * 列变宽、窗口缩放、侧栏拖宽时把手跟着列走（对照 dsh 的对话宽度调节，把手就在列边上）。
 * 改版前把手按「50% ± 列宽/2 + 24px」算，落在正文列之外 24px 的空白里；而正文列是
 * 在滚动区里居中的，滚动区右侧还留着刻度轨道（`.chat` 的 padding-right），列的中心根本
 * 不是这一层的中心——两处偏差叠起来，把手离正文边缘就有半格远，用户找不到。
 *
 * 为什么不继续用纯 CSS 算：列在滚动区里怎么居中取决于 `.chat` 的右内距、滚动条槽与
 * `scrollbar-gutter: stable`（见 styles.css 的「对话区状态与刻度优化」段），在另一层
 * （`.thread-zone`）里重算一遍等于把那份布局抄第二遍，抄错就是几像素的错位。
 * 所以这里量一次真实矩形，把左右缘写进两个变量，样式表只管摆位。
 *
 * @module desktop/renderer/ThreadResizer
 */
import { useCallback, useLayoutEffect, useRef, type JSX, type RefObject } from 'react'
import { THREAD_EDGE_BUDGET, THREAD_MIN, readRightRailPx, setRootVar, useWidthDrag } from './panels.js'

/** 正文列左右缘相对本层左缘的像素，写进这两个变量（见文件头：量出来比算出来稳）。 */
const COL_START_VAR = '--dsc-thread-col-start'
const COL_END_VAR = '--dsc-thread-col-end'

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

  /**
   * 本层（`.thread-zone`）是哪个元素：两条把手就是它的直接子项，所以从把手往上一格就是它。
   *
   * 为什么不直接用 props.zoneRef：React 的 layout 阶段是「子先于父」——父子在同一个提交里
   * 创建时（欢迎页切到会话那一提交就是这样），轮到本组件的 layout effect，父元素自己的
   * ref 还没挂上，zoneRef.current 是 null。那一次量就白跑，而且观察器也挂不上，之后除非
   * 用户拖动（onDrag 里会重量一次），把手会一直停在样式表的兜底位置上。
   * 父元素在 DOM 上却是现成的（插入阶段早于 layout 阶段），所以从把手往上取。
   */
  const leftRef = useRef<HTMLDivElement | null>(null)
  const zoneOf = useCallback(
    (): HTMLElement | null => leftRef.current?.parentElement ?? props.zoneRef.current,
    [props.zoneRef],
  )

  /**
   * 量一次正文列的两个边缘（相对本层的左缘），写进变量给两条把手用。
   *
   * 用 getBoundingClientRect 相减而不是 offsetLeft：正文列的定位祖先未必是这一层
   * （中间还有 .chat-wrap），两边各自算坐标系容易差一层；矩形相减与祖先是谁无关。
   * 两个变量都带 px 单位写在本层上，样式表里的 left 直接用。
   */
  const measure = useCallback((): void => {
    const zone = zoneOf()
    if (zone === null) return
    const column = zone.querySelector<HTMLElement>('.chat-inner')
    if (column === null) return
    const zoneBox = zone.getBoundingClientRect()
    const columnBox = column.getBoundingClientRect()
    zone.style.setProperty(COL_START_VAR, `${String(columnBox.left - zoneBox.left)}px`)
    zone.style.setProperty(COL_END_VAR, `${String(columnBox.right - zoneBox.left)}px`)
  }, [zoneOf])

  // 挂载后先量一次（useLayoutEffect：赶在第一帧画出来之前，把手不会先落在错位置再跳一格），
  // 然后跟着三路信号重量：
  //   1. 根变量 --dsc-thread-max 一变就重量（MutationObserver 盯 <html> 的 style）——
  //      拖动中的每一帧、松手落盘、双击复位都会改它，这条最直接，不依赖观察器的投递时机；
  //   2. 正文列自己的尺寸变了（ResizeObserver）——窗口缩放、侧栏拖宽都会挪动它；
  //   3. 窗口 resize 兜底（有些环境里观察器在页面不可见时不投递）。
  // 三路都指向同一个 measure()，重复调用只是多读一次矩形，没有副作用。
  useLayoutEffect(() => {
    measure()
    const zone = zoneOf()
    if (zone === null) return
    const observer = new ResizeObserver(measure)
    observer.observe(zone)
    const column = zone.querySelector<HTMLElement>('.chat-inner')
    if (column !== null) observer.observe(column)
    const rootWatcher = new MutationObserver(measure)
    rootWatcher.observe(document.documentElement, { attributeFilter: ['style'], attributes: true })
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      rootWatcher.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure, zoneOf, props.width])

  const getBase = useCallback((): number => resolve(props.width), [props.width])
  const clamp = useCallback((px: number): number => resolve(px), [props.width])
  // 拖动中列宽每帧都在变，而 ResizeObserver 是下一帧才回调：这里顺手重量一次，
  // 把手与列缘同帧对齐，不会拖起来像「把手黏在原处」。
  const onDrag = useCallback(
    (px: number): void => {
      setRootVar('--dsc-thread-max', `${px}px`)
      measure()
    },
    [measure],
  )
  const shared = { getBase, clamp, onDrag, trackPointerY: true }
  const left = useWidthDrag({ ...shared, sign: -2, onCommit: props.onCommit })
  const right = useWidthDrag({ ...shared, sign: 2, onCommit: props.onCommit })

  return (
    <>
      <div
        ref={leftRef}
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
