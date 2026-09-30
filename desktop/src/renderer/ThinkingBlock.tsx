/**
 * 思考过程折叠条（对照 dsh 的 ReasoningRow）：默认折叠成一行「图标 + 标题 + 分隔点 + 摘要」，
 * 点开才是完整思考原文；展开内容超过约 400px 时，展开区顶部吸附一条带「收起」的快捷栏。
 *
 * 折叠态这一行的语义照 dsh 的原文搬（packages/client/ui-chat/src/client/chat/ReasoningRow.tsx）：
 * - 摘要：收工时取首行（ReasoningRow.tsx:11-14 的 firstLine），跑动中取「最新一个已经写完的
 *   段落的首行」（:16-32 的 latestCompletedParagraphFirstLine，段落之间以空行分隔）——直播时
 *   最后一行还在往外吐字，拿它当摘要会一个字跳一次，所以只认写完的段落；
 * - 摘要去掉 Markdown 的 `**` 标记（:57）：一行预览里不该出现字面量星号；
 * - 标题与摘要之间是一个 2px 的分隔点（ReasoningRow.module.css:37-44）；摘要吃掉剩余宽度、
 *   超长走省略号（:49-63）；
 * - 跑动中摘要右边用渐隐遮罩收口（:65-72），并叠一道从左到右的扫光——dsh 的 TextShimmer
 *   （TextShimmer.module.css:34-42 复制一份文字盖上去、:61-67 是 1.5s steps(48) 的循环）；
 *   这道扫光加上品牌色，就是「跑动 / 完成」两态的区分（ReasoningRow.tsx:80 的 data-state）；
 * - 整行都可点开合、Enter/Space 同效（DisclosureRow.tsx:61-70 与 :84-94 的
 *   expandOnRowClick + 键盘处理），不是只有行尾箭头能点。
 *
 * 为什么和 ToolCard 的紧凑行用同一组规格：思考与工具卡在对话流里是紧挨着的两种「过程」
 * 条目，形状一致扫视时才不用重新认一遍（见 styles.css 末尾「思考过程折叠优化」与
 * 「会话脚注与思考折叠改版」两段）。
 *
 * 展开是有高度过渡的：grid-template-rows 0fr → 1fr 配上 @starting-style（styles.css 末尾），
 * 高度自己长出来，不需要预先量内容高度；`prefers-reduced-motion: reduce` 下降级成瞬时。
 * 因为高度过渡要裁剪，而 overflow 非 visible 的祖先会把 sticky 的参照系换掉，带「收起」的
 * 吸附快捷栏这次搬到 .think-body 外面（它是 .think-block 的直接子项，吸附参照系仍然是滚动
 * 容器 .chat，行为与改之前一致）。
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

/** 首行：直到第一个换行为止（dsh ReasoningRow.tsx:11-14）。 */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/**
 * 最新一个「已经写完的段落」的首行（dsh ReasoningRow.tsx:16-32）。
 *
 * 段落之间以空行（一行里只有空白）分隔。最后一个段落如果还没写到换行，说明它正在被吐字，
 * 不能拿来当摘要——所以从后往前找第一个「首行已经收尾」的段落。一段都没写完就返回空串，
 * 界面据此只画标题、不画分隔点与摘要。
 */
function latestCompletedParagraphFirstLine(text: string): string {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  while (true) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null ? text.length
      : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

/**
 * 展开区有多长：把每个子块的自然高度加起来，量之前先跳过快捷栏自己。
 *
 * 快捷栏这次搬到了 .think-body 外面（高度过渡要裁剪，见文件头），所以它本来就不在这份
 * 清单里；这里的跳过留着兜底，免得日后谁把它放回来又把「390 + 26 > 400」算成需要吸附。
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
  showPreview = true,
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
  /**
   * 折叠态那一行要不要画摘要预览（对齐 dsh 的 settledReasoningPreview，见
   * packages/client/ui-chat/src/client/presentation-policy.ts:29「过程折叠程度 = 紧凑」那一档
   * 是 false）。false 时分隔点与摘要一起不渲染，标题右边直接是箭头；跑动中永远是 true——
   * 正在写的那一段是「它现在在干什么」的唯一线索，不能因为档位把它藏了。
   */
  showPreview?: boolean
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

  // 摘要（折叠态那一行右边那一段）：跑动中只认写完的段落，收工后取首行；`**` 一律去掉。
  const summaryText = live ? latestCompletedParagraphFirstLine(text) : firstLine(text)
  const summary = summaryText.replaceAll('**', '')
  // 这一行现在画不画摘要：空摘要不画，紧凑档的定稿条也不画（跑动中照画，见 showPreview 的注释）。
  const preview = summary !== '' && (live || showPreview)

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
    <div
      className={`think-block${live ? ' live' : ''}${open ? ' open' : ''}`}
      // 两态走 dsh 的 data-state（ReasoningRow.tsx:80）；.live 是直播尾这个概念，样式里仍在用
      data-state={live ? 'running' : 'ok'}
      // 折叠态有没有摘要可画（dsh 的 data-preview，ReasoningRow.tsx:82）：空摘要不占位，
      // 紧凑档的定稿条也不占位（那一档的语义就是「只剩标题 + 箭头」）。
      data-preview={preview ? '1' : undefined}
    >
      {/* 跑动这一态在视觉上是扫光 + 品牌色，读屏读不到「扫光」，所以补一句只给读屏的说明
          （对照 dsh ReasoningRow.tsx:84 的 visuallyHidden 运行中标签）。 */}
      {live && <span className="think-sr">正在思考</span>}
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
        {/* 分隔点：只在真有摘要时画（dsh 的 .separator 与 .summary 同生共死；
            紧凑档的定稿条两个都不画，箭头因此紧跟在标题右边，与 dsh 一致）。 */}
        {preview && <span className="think-dot" aria-hidden="true" />}
        {/* 摘要行：不是「摘要有内容」时也渲染（空摘要时是个空盒子），它的 flex:1 负责把行尾
            箭头与状态推到最后；紧凑档定稿条整个不渲染，这时箭头按内容排到标题右侧。 */}
        {preview && (
          <span className="think-summary" data-streaming={live || undefined}>
            <span className="think-summary-text" data-shimmer={live && summary !== '' ? summary : undefined}>
              {summary}
            </span>
          </span>
        )}
        {/* 进行中的小圈：系统里说「少动」时扫光会停，这枚静态环就是那会儿唯一的活动标记，
            所以留着它，而不是只靠扫光表达「还在想」。 */}
        <span className="think-status">{live && <i className="think-spin" aria-hidden />}</span>
        <IconChevronDown size={11} className="think-chevron" />
      </div>
      {/* 吸附快捷栏：这次是 .think-block 的直接子项（不再套在 .think-body 里），
          这样展开区可以放心用 overflow 裁剪做高度过渡，sticky 的参照系仍是 .chat。 */}
      {open && barVisible && (
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
      {open && (
        <div className="think-body" ref={bodyRef}>
          {/* 高度过渡要把溢出的正文裁掉，裁剪层单独一层；正文自己的左边线留在 .think-text 上 */}
          <div className="think-body-clip">
            <div className="think-text">{text}</div>
          </div>
        </div>
      )}
    </div>
  )
}
