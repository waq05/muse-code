/**
 * 回合刻度条（对照 dsh 右缘的「快速跳转」）：会话里每个用户回合一枚短横，
 * 纵向均布在消息区右缘；当前读到的那一回合加亮，点刻度平滑滚到那条消息，
 * 原生 title 显示该回合的起头一句。
 *
 * 锚点直接从滚动容器里数 `.entry-user` 节点——跳转本来就是 DOM 行为，
 * 与 entries 的顺序天然一一对应（每个 kind:'user' 条目渲染一个 .entry-user）。
 *
 * @module desktop/renderer/JumpStrip
 */
import { useEffect, useState, type JSX } from 'react'
import type { TranscriptEntry } from '@dsc/runtime/contract.js'

/** 视口上缘往下 40% 这条线扫过哪个回合，哪个就算「正在读」。 */
const READ_LINE = 0.4

export function JumpStrip(props: {
  scrollerRef: React.RefObject<HTMLDivElement | null>
  entries: TranscriptEntry[]
}): JSX.Element | null {
  const [anchors, setAnchors] = useState<HTMLElement[]>([])
  const [current, setCurrent] = useState(-1)
  const [scrollable, setScrollable] = useState(false)

  // 与 anchors 一一对应的回合预览（title 用）
  const previews = props.entries
    .filter((entry): entry is Extract<TranscriptEntry, { kind: 'user' }> => entry.kind === 'user')
    .map((entry) => entry.text.replace(/\s+/g, ' ').trim().slice(0, 80))

  useEffect(() => {
    const scroller = props.scrollerRef.current
    if (scroller === null) return
    setAnchors([...scroller.querySelectorAll<HTMLElement>('.entry-user')])
    setScrollable(scroller.scrollHeight > scroller.clientHeight + 40)
  }, [props.entries, props.scrollerRef])

  useEffect(() => {
    const scroller = props.scrollerRef.current
    if (scroller === null) return
    let raf = 0
    const update = (): void => {
      raf = 0
      const top = scroller.getBoundingClientRect().top
      const line = top + scroller.clientHeight * READ_LINE
      let index = -1
      anchors.forEach((node, i) => {
        if (node.getBoundingClientRect().top <= line) index = i
      })
      setCurrent(index)
    }
    const onScroll = (): void => {
      if (raf === 0) raf = requestAnimationFrame(update)
    }
    update()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [anchors, props.scrollerRef])

  // 少于两个回合、或一屏装得下时没有可跳的东西，不画
  if (!scrollable || anchors.length < 2) return null

  return (
    <div className="jump-strip" role="navigation" aria-label="快速跳转">
      {anchors.map((node, index) => (
        <button
          key={index}
          className={`jump-tick${index === current ? ' on' : ''}`}
          title={`回合 ${String(index + 1)}/${String(anchors.length)} · ${previews[index] ?? ''}`}
          onClick={() => node.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        />
      ))}
    </div>
  )
}
