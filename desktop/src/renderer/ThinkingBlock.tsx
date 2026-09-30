/**
 * 思考过程折叠条：默认折叠成一条紧凑行（行首星标 + 「思考过程」 + 行尾箭头），点开才是
 * 完整的思考原文；展开内容超过约 400px 时，展开区顶部吸附一条带「收起」的快捷栏。
 *
 * 为什么和 ToolCard 的紧凑行用同一组规格：思考与工具卡在对话流里是紧挨着的两种「过程」
 * 条目，改动前一边是 12px 正文灰、10px 内距、原生 details 折叠，另一边是 11px 等宽、8px
 * 内距、手写 div 折叠——同一屏里两套形状，扫视时要重新认一次样式。现在两边的紧凑行共用
 * 同一组令牌（见 styles.css 末尾「思考过程折叠优化」那一区）：行高 --dsc-row-h、内距
 * 0 8px、圆角 --dsc-r-control、悬停 --dsc-row-hover-bg、按下 --dsc-row-active-bg、
 * 过渡 --dsc-dur、行尾箭头 11px + 180° 旋转、快捷栏 sticky top:0 + 不透明底色。
 * 唯一刻意不同的是标题字号：思考标题用 --dsc-fs-ui（12px），因为思考正文本身就是给人读的
 * 脚手架，标题比正文（--dsc-fs-caption 也是 12px）还小会读不出来；工具名走等宽 11px 是
 * 为了和它下面等宽的参数摘要对齐。
 *
 * 默认状态沿用改动前的语义（不改成默认展开）：定稿条目挂载即折叠；直播尾那一条
 * （ChatView 传 live，即 entry.id < 0）挂载即展开，让用户看得见模型正在想什么，
 * 直播过程中也允许自己收起或再展开。
 *
 * @module desktop/renderer/ThinkingBlock
 */
import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import { IconChevronDown, IconChevronUp, IconSpark } from './icons.js'
import { readFold, writeFold } from './fold-state.js'

/** 展开内容超过这个高度才给吸附快捷栏——短思考不背这条累赘（与 ToolCard 同值）。 */
const BAR_MIN_CONTENT_H = 400

/**
 * 展开区有多长：把每个子块的自然高度加起来，量之前先跳过快捷栏自己。
 *
 * 为什么要跳过：快捷栏自己约一行高（--dsc-row-h），算进去会自我维持——内容 390 + 栏 26
 * 就过 400 了 → 显示栏 → 下一轮又量到 416 → 一直显示。所以按 data 标记把它排除。
 * 口径与 ToolCard.tsx 的 expandedContentHeight 一致。
 */
function expandedContentHeight(body: HTMLElement): number {
  let total = 0
  for (const child of Array.from(body.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (child.dataset.thinkChrome !== undefined) continue
    total += Math.max(child.scrollHeight, child.offsetHeight)
  }
  return total
}

export function ThinkingBlock({
  text,
  live,
  storeKey,
}: {
  /** 思考原文：定稿后是一条，直播中每来一段它会变长。 */
  text: string
  /** 是不是直播尾那一条（ChatView 传 entry.id < 0）：决定进行中反馈与初始展开态。 */
  live: boolean
  /**
   * 展开状态的存档键（`会话:条目`，见 fold-state.ts）。传了才存档：
   * 会话切换会把条目整表重建，重挂时从这个键读回用户上次的展开选择。
   */
  storeKey?: string
}): JSX.Element {
  // 直播尾挂载即展开（沿用改动前 `open={entry.id < 0}` 的语义）；定稿条目默认折叠。
  // 有存档就认存档：重挂（换会话再切回来）时不能让用户的展开白点。
  const [open, setOpen] = useState(() => readFold(storeKey, live))
  const [barVisible, setBarVisible] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /** 展开态一变就写回存档：组件被重挂时下一个实例才读得到。 */
  const setOpenPersisted = (next: boolean): void => {
    writeFold(storeKey, next)
    setOpen(next)
  }

  // 展开内容够长才给快捷栏；阈值判断放在布局之后量，量的是真实像素而不是估算。
  // 直播时 text 一直在变长，所以依赖里带上它，并挂 ResizeObserver 跟着重量。
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body === null || !open) {
      setBarVisible(false)
      return
    }
    const measure = (): void => setBarVisible(expandedContentHeight(body) > BAR_MIN_CONTENT_H)
    measure()
    // 换字号、换密度、直播追加内容都会改展开区高度，所以跟着重量，而不是只量一次。
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [open, text])

  const toggle = (): void => setOpenPersisted(!open)

  return (
    <div className={`think-block${live ? ' live' : ''}${open ? ' open' : ''}`}>
      <div
        className="think-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-tip={open ? '点击收起这段思考过程' : '点击展开这段思考过程'}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          // 空格按在 div 上默认会滚页面，先挡掉再自己处理（与 ToolCard 紧凑行同款）。
          event.preventDefault()
          toggle()
        }}
      >
        <IconSpark size={12} className="think-star" />
        <span className="think-label">思考过程</span>
        {/* 状态格始终渲染（定稿时是空串）：它的 flex:1 负责把行尾箭头顶到最右，
            同 ToolCard 里那个始终渲染的 .preview */}
        <span className="think-status">
          {live && <i className="think-spin" aria-hidden />}
          {live ? '进行中' : ''}
        </span>
        <IconChevronDown size={11} className="think-chevron" />
      </div>
      {open && (
        <div className="think-body" ref={bodyRef}>
          {barVisible && (
            <div className="think-bar" data-think-chrome="1">
              <span className="think-bar-status">思考过程 · {live ? '进行中' : '已完成'}</span>
              {/* 直播时也保留「收起」：思考段是只读文本，收起它不会被理解成取消任务
                  （工具卡在 running 时藏按钮，是因为那里收起有「任务被中断」的歧义）。 */}
              <button
                type="button"
                className="think-collapse"
                title="收起这段思考过程"
                onClick={() => setOpenPersisted(false)}
              >
                收起
                <IconChevronUp size={11} />
              </button>
            </div>
          )}
          <div className="think-text">{text}</div>
        </div>
      )}
    </div>
  )
}
