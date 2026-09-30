/**
 * 回合刻度条（对照 dsh 右缘的「快速跳转」）：会话里每个用户回合一枚短横，
 * 纵向均布在消息区右缘；当前读到的那一回合加亮，点刻度平滑滚到那条消息，
 * 原生 title 显示该回合的起头一句。
 *
 * 判定口径（这次修的就是它）：以滚动容器的真实 `scrollTop` 与视口上缘的命中测试为准。
 * 具体做法是在容器上缘往里 8px 处放一条「探针线」：
 * 1. 先在探针线上做一次 `elementFromPoint` 命中测试。ChatView 给每条条目挂了
 *    `data-round`，命中哪个条目就知道用户正看着第几轮——这比「取视口高度的某个百分比」
 *    准得多：长回答里 40% 那条线扫到的回合常常已经不是屏幕上那一个了。
 * 2. 探针落在条目之间的空隙（命中不到 data-round）或被浮层挡住时，退回几何判定：
 *    用真实 `scrollTop` 与各回合起点的实际位置比，取「起点在探针之前的最后一回合」。
 * 3. 一次都没滚过第一回合（探针线还在第一枚刻度上方）时高亮第一回合——
 *    那时用户看的就是它，不该出现「一枚都不亮」。
 * 4. 已经贴到最底下时高亮最后一回合（阈值见 AT_BOTTOM_EPS）：新回复是边流边自动
 *    滚到底的，那一刻亮着倒数第二个刻度就与眼睛不一致了。
 *
 * 滚动事件用 requestAnimationFrame 合并（一帧最多量一次）；内容异步撑高
 * （图片、代码块、流式文字）不发 scroll 事件，所以另外挂 ResizeObserver 补算。
 *
 * 刻度条与对话区滚动条各占一条轨道的事在 styles.css 末尾那一区：这里只管逻辑。
 *
 * @module desktop/renderer/JumpStrip
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import type { TranscriptEntry } from '@dsc/runtime/contract.js'

/** 探针线离滚动容器上缘的距离：用户最先看到的那条内容线。 */
const PROBE_INSET = 8
/**
 * 贴到底部的判定阈值：离最底下不到这么多像素就算「跟着最新回复看」。
 * 为什么要单独判这一档：新回复是边流边自动滚到底的，而最新那条用户消息往往还露在
 * 探针线下方几十像素处、屏幕顶上反而铺着上一轮的收尾正文——只按探针线算的话，
 * 正在看最新一轮却亮着倒数第二个刻度。贴底时高亮最后一回合才和眼睛一致。
 */
const AT_BOTTOM_EPS = 32

/**
 * 视口顶部那一条属于哪一回合。
 * @returns 回合下标（0 基）；一枚刻度都没有时返回 -1。
 */
function readCurrent(scroller: HTMLDivElement, anchors: HTMLElement[]): number {
  if (anchors.length === 0) return -1
  const box = scroller.getBoundingClientRect()
  const { scrollTop } = scroller

  // ── 0) 贴底：正在看最新一轮 ──
  const maxScroll = scroller.scrollHeight - scroller.clientHeight
  if (maxScroll > 0 && maxScroll - scrollTop <= AT_BOTTOM_EPS) return anchors.length - 1

  // ── 1) 命中测试：探针线上是什么，就按它身上的 data-round 认回合 ──
  const probeY = box.top + PROBE_INSET
  // x 取滚动容器内容区的横向中点。为什么不用「左缘 + 常量」：正文列是居中的，
  // 窗口一宽，左缘往右固定距离早就落在正文列左边的空白里了，命中的永远是背景。
  const probeX = box.left + scroller.clientWidth / 2
  const hit = document.elementFromPoint(probeX, probeY)
  if (hit !== null && scroller.contains(hit)) {
    const row = hit.closest('[data-round]')
    const value = row === null ? Number.NaN : Number(row.getAttribute('data-round'))
    if (Number.isInteger(value) && value >= 0 && value < anchors.length) return value
  }

  // ── 2) 几何兜底：真实 scrollTop 与各回合起点的实际位置比 ──
  // 为什么不用 offsetTop：它相对最近的定位祖先，滚动容器一族一变就整体错位。
  // 这里用 getBoundingClientRect 与容器位置换算成「内容坐标」，两个值都来自真实滚动状态。
  let index = -1
  for (let i = 0; i < anchors.length; i += 1) {
    const node = anchors[i]
    if (node === undefined) continue
    const nodeTop = node.getBoundingClientRect().top - box.top + scrollTop
    if (nodeTop <= scrollTop + PROBE_INSET) index = i
    else break
  }
  // ── 3) 还在最顶上：高亮第一回合，而不是一枚都不亮 ──
  return index === -1 ? 0 : index
}

export function JumpStrip(props: {
  scrollerRef: React.RefObject<HTMLDivElement | null>
  entries: TranscriptEntry[]
}): JSX.Element | null {
  // 锚点放 ref 里：滚动时每帧都要重算，但只有「枚数」和「当前项」变了才需要重渲染
  const anchorsRef = useRef<HTMLElement[]>([])
  const [tickCount, setTickCount] = useState(0)
  const [current, setCurrent] = useState(-1)
  const [scrollable, setScrollable] = useState(false)

  // 与 anchors 一一对应的回合预览（title 用）
  const previews = props.entries
    .filter((entry): entry is Extract<TranscriptEntry, { kind: 'user' }> => entry.kind === 'user')
    .map((entry) => entry.text.replace(/\s+/g, ' ').trim().slice(0, 80))

  useEffect(() => {
    const scroller = props.scrollerRef.current
    if (scroller === null) return
    let raf = 0

    // 所有重算都走这一条：从 DOM 现量锚点、现算当前回合
    const measure = (): void => {
      raf = 0
      const anchors = [...scroller.querySelectorAll<HTMLElement>('.entry-user')]
      anchorsRef.current = anchors
      setTickCount(anchors.length)
      // 比视口高 40px 以上才算有得跳：刚好差几像素时画出来纯属干扰
      setScrollable(scroller.scrollHeight > scroller.clientHeight + 40)
      setCurrent(readCurrent(scroller, anchors))
    }
    // rAF 合并：一次滚动里连发几十个事件也只量一次
    const schedule = (): void => {
      if (raf === 0) raf = requestAnimationFrame(measure)
    }

    schedule()
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    // 内容撑高/收窄（图片解码完、代码块展开、流式文字变长）不发 scroll：
    // 容器和目标内容各自的尺寸变化都要补算一次，否则高亮会停在旧位置
    const observer = new ResizeObserver(schedule)
    observer.observe(scroller)
    const inner = scroller.firstElementChild
    if (inner !== null) observer.observe(inner)

    return () => {
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [props.entries, props.scrollerRef])

  // 少于两个回合、或一屏装得下时没有可跳的东西，不画
  if (!scrollable || tickCount < 2) return null

  return (
    <div className="jump-strip" role="navigation" aria-label="快速跳转">
      {Array.from({ length: tickCount }, (_, index) => (
        <button
          key={index}
          className={`jump-tick${index === current ? ' on' : ''}`}
          title={`回合 ${String(index + 1)}/${String(tickCount)} · ${previews[index] ?? ''}`}
          aria-current={index === current ? 'true' : undefined}
          onClick={() => anchorsRef.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        />
      ))}
    </div>
  )
}
