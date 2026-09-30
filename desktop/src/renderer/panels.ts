/**
 * 面板尺寸：侧栏宽度、侧栏是否收成图标窄栏、中间对话列宽——三项都能用鼠标拖，
 * 拖完的值存在 renderer 的 localStorage 里。
 *
 * 为什么不写进 ~/.dsc/settings.json：那份文件存的是跨机器的用户偏好（外观、
 * 会话排序），而「这个窗口在这台机器上拖成多宽」属于窗口几何，和 dock 宽度
 * （`dsc.dockWidth`）是同一类东西，留在本地。
 *
 * @module desktop/renderer/panels
 */
import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react'

/** 侧栏拖拽下限：比样式表默认的 237px 再窄一点，容得下短工作区名。 */
export const SIDEBAR_MIN = 200
/** 侧栏拖拽上限：再宽就快把正文挤没了，要宽正文请用正文两侧的拖拽条。 */
export const SIDEBAR_MAX = 420

/** 中间列拖拽下限：480px 以下正文会窄到没法读。 */
export const THREAD_MIN = 480
/** 中间列两侧要留给拖拽条和 safe 区的宽度：24px 内缩 + 10px 热区，两边各一份，再留点余量。 */
export const THREAD_EDGE_BUDGET = 80
/**
 * 右缘那两条轨道占掉的宽度：回合刻度条的专属轨道（`--dsc-jump-lane`，里面是
 * 刻度 16px + 与正文 4px 间隙 + 与滚动条 12px 间隙）加上竖向滚动条（`--dsc-scrollbar-w`）。
 *
 * 正文拖到最宽时，光是 `THREAD_EDGE_BUDGET` 只按「热区 + 内缩」留白，
 * 这两条轨道就得靠 `.chat` 的右内距替正文让位——一旦谁动了那个内距，正文立刻伸到刻度底下。
 * 所以把这条轨道也算进拖宽的上限里：上限自己守住刻度，不再依赖别处的内距。
 *
 * 数字从样式表现读（见 readRootPx），不在这里抄一份：tokens.css 里改了刻度轨道宽，
 * 这里跟着变，不会出现两处数字各说各话。
 *
 * @returns 右缘轨道总宽（px）
 */
export function readRightRailPx(): number {
  return readRootPx('--dsc-jump-lane', 32) + readRootPx('--dsc-scrollbar-w', 8)
}
/** 读档时的宽度天花板。真正的上限是当时的窗口宽，拖的时候现场算；这里只挡住存坏的脏值。 */
export const STORED_MAX = 3200

/** 三个值各自的 localStorage 键。 */
export const PANEL_KEYS = {
  sidebarWidth: 'dsc.sidebarWidth',
  sidebarRail: 'dsc.sidebarRail',
  threadWidth: 'dsc.threadWidth',
} as const

/**
 * 读一个存过的面板宽度。没存过、存坏、或落在区间外都算没有。
 *
 * @param key localStorage 键
 * @param min 允许下限（px）
 * @param max 允许上限（px）
 * @returns 存过的宽度，或 null（表示用样式表默认宽）
 */
export function readStoredPx(key: string, min: number, max: number): number | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    const px = Number(raw)
    return Number.isFinite(px) && px >= min && px <= max ? px : null
  } catch (error) {
    console.warn('[renderer] 面板宽度读取失败，回退默认宽', error)
    return null
  }
}

/**
 * 落盘一个面板宽度；传 null 表示复位（删键，回到样式表默认）。
 *
 * @param key localStorage 键
 * @param px 要存的宽度，null = 复位
 */
export function writeStoredPx(key: string, px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(px))
  } catch (error) {
    // 隐私模式或配额满都会抛；大不了下次启动回到默认宽，不该打断拖动。
    console.warn('[renderer] 面板宽度写入失败', error)
  }
}

/**
 * 读一个开关（侧栏收起状态）。
 *
 * @param key localStorage 键
 * @returns 上次存的开关状态
 */
export function readStoredFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch (error) {
    console.warn('[renderer] 面板开关读取失败，回退展开', error)
    return false
  }
}

/**
 * 落盘一个开关。
 *
 * @param key localStorage 键
 * @param on 开关状态
 */
export function writeStoredFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch (error) {
    console.warn('[renderer] 面板开关写入失败', error)
  }
}

/**
 * 往根元素上写一个 CSS 变量，把拖出来的宽度交给样式表。
 * 传 null 就撤掉行内值，让样式表里 `:root` 那份默认值重新生效。
 *
 * @param name 变量名（`--dsc-*`）
 * @param value 值，null = 撤掉
 */
export function setRootVar(name: string, value: string | null): void {
  const root = document.documentElement
  if (value === null) root.style.removeProperty(name)
  else root.style.setProperty(name, value)
}

/**
 * 读根元素上某个 CSS 变量的当前值（px 数）。用来取样式表默认宽，免得这里再抄一份常量。
 *
 * @param name 变量名
 * @param fallback 变量缺失或不是长度时的兜底值（px）
 * @returns 像素值
 */
export function readRootPx(name: string, fallback: number): number {
  const px = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
  return Number.isFinite(px) && px > 0 ? px : fallback
}

/** 一次拖拽宽度所需的全部回调，见 `useWidthDrag`。 */
export interface WidthDragOptions {
  /** 按下瞬间的基准宽度（px）。要取当时的真实生效值，别取一个猜的默认数。 */
  getBase(): number
  /** 鼠标向右移 1px，宽度变多少 px。侧栏分界线是 1；正文右侧拖拽条是 2（左右一起长），左侧是 -2。 */
  sign: number
  /** 把宽度夹进本面板允许的区间。 */
  clamp(px: number): number
  /** 拖动中的每一帧（已夹好）。 */
  onDrag(px: number): void
  /** 松手：把最终宽度落盘。 */
  onCommit(px: number): void
  /** 是否把鼠标竖向位置写进热区的 `--dsc-handle-y`，供高亮跟着走。默认不写。 */
  trackPointerY?: boolean
}

/** `useWidthDrag` 交回给热区的事件处理器。 */
export interface WidthDragHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void
  onPointerUp(event: ReactPointerEvent<HTMLElement>): void
  onPointerCancel(event: ReactPointerEvent<HTMLElement>): void
}

/**
 * 拖一条竖直边界改宽度：按下抓指针，移动回灌新宽度，松手落盘，取消则退回原宽。
 *
 * 用 Pointer Capture 而不是挂 window 监听：指针被这条热区攥住，鼠标拖出窗口外
 * 再回来还在接着拖，也不会漏掉 mouseup 卡在「拖拽中」。移动按帧合并，
 * 一帧最多改一次宽度。拖动期间给 <body> 挂 `.resizing`（锁光标、禁选中、
 * 关掉面板的宽度过渡，见 styles.css）。
 *
 * @param options 基准宽、方向、夹取区间、拖动与落盘回调
 * @returns 直接摊到热区元素上的四个指针事件处理器
 */
export function useWidthDrag(options: WidthDragOptions): WidthDragHandlers {
  const base = useRef(0)
  const originX = useRef(0)
  const latestX = useRef(0)
  const dragging = useRef(false)
  const frame = useRef<number | null>(null)
  // 处理器要保持稳定，所以每次读最新的回调，而不是把回调闭进处理器里。
  const cb = useRef(options)
  cb.current = options

  const cancelFrame = (): void => {
    if (frame.current === null) return
    cancelAnimationFrame(frame.current)
    frame.current = null
  }
  const widthAt = (clientX: number): number =>
    cb.current.clamp(base.current + cb.current.sign * (clientX - originX.current))
  const release = (event: ReactPointerEvent<HTMLElement>): void => {
    dragging.current = false
    cancelFrame()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    event.currentTarget.toggleAttribute('data-dragging', false)
    document.body.classList.remove('resizing')
  }

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    base.current = cb.current.getBase()
    originX.current = event.clientX
    latestX.current = event.clientX
    dragging.current = true
    event.currentTarget.toggleAttribute('data-dragging', true)
    document.body.classList.add('resizing')
  }, [])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (!dragging.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    latestX.current = event.clientX
    if (cb.current.trackPointerY === true) {
      const box = event.currentTarget.getBoundingClientRect()
      event.currentTarget.style.setProperty('--dsc-handle-y', `${event.clientY - box.top}px`)
    }
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      cb.current.onDrag(widthAt(latestX.current))
    })
  }, [])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (!dragging.current) return
    // 只按了一下没拖动，就别用当时被窗口夹过的显示值去覆盖更宽的存档。
    const moved = event.clientX !== originX.current
    const px = widthAt(event.clientX)
    release(event)
    if (moved) cb.current.onCommit(px)
  }, [])

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (!dragging.current) return
    release(event)
    // 中途被打断：丢掉这一趟的拖动，回到已存档的宽度。
    cb.current.onDrag(cb.current.getBase())
  }, [])

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}
