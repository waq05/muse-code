/**
 * 工具卡：默认折叠成一条紧凑行（工具名 + 入参摘要 + 状态 + 展开箭头），点开才是完整的
 * 参数与结果；展开内容很长时，展开区顶部吸附一条带「收起」的快捷栏。
 *
 * 为什么默认折叠：以前每张卡都把入参原文摊在行上，参数一长整行就被撑满，一屏只看得下
 * 四五条；折叠成一行后同样的高度能扫过十几条，要看细节再点开。
 *
 * @module desktop/renderer/ToolCard
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { ToolCallView } from '@dsc/runtime/contract.js'
import { IconChevronDown, IconChevronUp } from './icons.js'
import { readFold, writeFold } from './fold-state.js'
import { formatDuration } from './turn-timing.js'

const STATUS_TEXT: Record<ToolCallView['status'], string> = {
  running: '进行中',
  done: '完成',
  failed: '失败',
  rejected: '已拒绝',
}

/** 紧凑行摘要的字数上限：够认出「这条在干什么」，又不至于把状态位挤出视野。 */
const SUMMARY_LIMIT = 72

/** 展开内容超过这个高度才给吸附快捷栏——小卡不背这条累赘。 */
const BAR_MIN_CONTENT_H = 400

/**
 * 每个工具从入参里优先读的字段，按顺序取前两个能用的。
 *
 * 为什么按名单挑而不是照抄参数原文：url 的 host 比整串 url 短一半且一眼认得出去哪；
 * query / path / command 本来就是人写给人看的一行，拼成 JSON 反而多出一堆引号花括号。
 */
const SUMMARY_FIELDS: Record<string, string[]> = {
  browser: ['url', 'expression', 'action'],
  web_search: ['query'],
  search: ['query'],
  session_search: ['query'],
  read: ['path'],
  write: ['path'],
  edit: ['path'],
  glob: ['pattern', 'path'],
  grep: ['pattern', 'path'],
  bash: ['command'],
  ask_user: ['questions', 'question'],
  plugin_manager: ['action', 'name'],
  skill: ['name'],
  subagent: ['description', 'prompt'],
  todo_write: ['items'],
}

/** 名单里没有的工具（含外部插件）按这套通用字段名碰运气，一个都没有就留空。 */
const COMMON_FIELDS = [
  'query',
  'url',
  'path',
  'file_path',
  'pattern',
  'command',
  'cmd',
  'question',
  'prompt',
  'name',
  'title',
  'text',
]

/** 参数原文美化：能解析成 JSON 就缩进展示，否则原样给出（模型偶尔吐半截 JSON）。 */
function prettyArgs(argsText: string): string {
  try {
    return JSON.stringify(JSON.parse(argsText), null, 2)
  } catch {
    return argsText
  }
}

/** 解析入参 JSON；解析不出来或根本不是对象（数组、裸字符串）就返回 null。 */
function parseArgs(argsText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argsText)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** 一行化：换行与连续空格压成单个空格——紧凑行只有一行高。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 超长就截断加省略号；紧凑行的高度不许被内容拉走。 */
function clip(text: string, limit = SUMMARY_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** url → 只留 host（认得出「去的哪家站点」就够）；不是绝对地址就原样返回。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * 把一个字段值折成一行文字。
 * 对象与数组只取里面的字符串，免得摘要里冒出 JSON 花括号——那是展开区该干的事。
 */
function fieldText(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = oneLine(value)
    return text === '' ? null : text
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map((item) => fieldText(item)).filter((item): item is string => item !== null)
    return parts.length === 0 ? null : parts.join('、')
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of COMMON_FIELDS) {
      const nested = fieldText(record[key])
      if (nested !== null) return nested
    }
  }
  return null
}

/**
 * 紧凑行里那句摘要：先从入参 JSON 里按工具名挑字段，挑不到就退回参数原文。
 *
 * 为什么单独成函数：三种工具（browser / web_search / 文件类）的「最可辨识字段」不一样，
 * 混在组件里 JSX 就没法读了；放在组件外也方便脱离 React 直接核对。
 */
export function toolSummary(name: string, argsText: string): string {
  const parsed = parseArgs(argsText)
  if (parsed === null) return clip(oneLine(argsText))
  const fields = SUMMARY_FIELDS[name.toLowerCase()] ?? COMMON_FIELDS
  const picked: string[] = []
  for (const field of fields) {
    const text = fieldText(parsed[field])
    if (text === null) continue
    // browser 的 url 只留 host：整串地址里大半是查询串，写进紧凑行也认不出重点。
    const value = field === 'url' ? hostOf(text) : text
    if (!picked.includes(value)) picked.push(value)
    if (picked.length === 2) break
  }
  // 一个字段都没挑到 = 这次调用没有可读入参（比如 browser 的 status/close）：摘要留空，
  // 紧凑行只显示工具名与状态，比硬塞一段 JSON 干净。
  return clip(picked.join(' · '))
}

/**
 * 展开区有多长：把每个子块的自然高度加起来。
 *
 * 为什么读 scrollHeight 而不是 offsetHeight：参数与结果两块各被 max-height 夹在
 * --dsc-tool-detail-max-h（约 180px）里，读 offsetHeight 会把任意长的内容都看成 180px，
 * 加总永远进不了 400px 阈值，快捷栏就再也不会出现。
 */
function expandedContentHeight(body: HTMLElement): number {
  let total = 0
  for (const child of Array.from(body.children)) {
    if (!(child instanceof HTMLElement)) continue
    // 快捷栏自己不算内容。把它算进去会自我维持：内容 390 + 栏 26 > 400 → 显示栏 →
    // 下一轮又量到 416 → 一直显示。所以量之前先把它排除。
    if (child.dataset.tcChrome !== undefined) continue
    total += Math.max(child.scrollHeight, child.offsetHeight)
  }
  return total
}

export function ToolCard({
  call,
  defaultOpen = false,
  storeKey,
}: {
  call: ToolCallView
  defaultOpen?: boolean
  /**
   * 展开状态的存档键（`会话:条目`，见 fold-state.ts）。传了才存档：
   * 会话切换会把条目整表重建，重挂时从这个键读回用户上次的展开选择。
   */
  storeKey?: string
}): JSX.Element {
  const status = call.status
  const running = status === 'running'
  const [open, setOpen] = useState(() => readFold(storeKey, defaultOpen))
  const [barVisible, setBarVisible] = useState(false)

  /** 展开态一变就写回存档：组件被重挂时下一个实例才读得到。 */
  const setOpenPersisted = (next: boolean): void => {
    writeFold(storeKey, next)
    setOpen(next)
  }
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  // 用时：ToolCallView 上没有耗时字段，adapter 记的时间也没传进卡片，所以只能在这一层量
  // 「挂载那一刻 → 状态离开 running 那一刻」。历史会话重放时卡片是带着终态挂载的，起点
  // 不存在（null），这时快捷栏只显示状态、不显示用时。
  const startedAtRef = useRef<number | null>(running ? Date.now() : null)
  const [elapsed, setElapsed] = useState<number | null>(null)

  useEffect(() => {
    if (running) {
      startedAtRef.current = Date.now()
      return
    }
    const started = startedAtRef.current
    if (started === null) return
    startedAtRef.current = null
    setElapsed(Math.max(0, Date.now() - started))
  }, [running])

  // 展开内容够长才给快捷栏；阈值判断放在布局之后量，量的是真实像素而不是估算。
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body === null || !open) {
      setBarVisible(false)
      return
    }
    const measure = (): void => setBarVisible(expandedContentHeight(body) > BAR_MIN_CONTENT_H)
    measure()
    // 换字号、换密度、结果后到都会改展开区高度，所以跟着重量，而不是只量一次。
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [open, call.argsText, call.resultText, status])

  /**
   * 吸附态要额外补一条与滚动容器顶部内距等高的底。
   *
   * 为什么：sticky 只把栏吸到滚动容器的内容盒顶端，`.chat` 顶部还有 12px 内距，
   * 那条缝里会露出半行刚滚过去的参数——看着像渲染坏了。判断「栏顶是否已经贴住滚动
   * 容器顶端」（阈值取自 .chat 真实的内距，不写死像素），贴住了才加 .stuck 补缝；
   * 没贴住就不加，否则这条底会盖在紧凑行的下半截文字上。
   */
  useEffect(() => {
    if (!open || !barVisible) return
    const bar = barRef.current
    const body = bodyRef.current
    if (bar === null || body === null) return
    const chat = body.closest('.chat')
    if (!(chat instanceof HTMLElement)) return
    const padTop = Number.parseFloat(getComputedStyle(chat).paddingTop)
    const threshold = (Number.isFinite(padTop) ? padTop : 12) + 1.5
    const sync = (): void => {
      const gap = bar.getBoundingClientRect().top - chat.getBoundingClientRect().top
      bar.classList.toggle('stuck', gap <= threshold)
    }
    sync()
    chat.addEventListener('scroll', sync, { passive: true })
    return () => chat.removeEventListener('scroll', sync)
  }, [open, barVisible, call.argsText, call.resultText, status])

  const summary = toolSummary(call.name, call.argsText)
  const duration = formatDuration(elapsed)
  const barStatus =
    running || duration === null ? STATUS_TEXT[status] : `${STATUS_TEXT[status]} · 用时 ${duration}`

  return (
    <div className={`entry tool-card status-${status}${open ? ' open' : ''}`}>
      <div
        className="tool-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-tip={open ? '点击收起' : '点击展开参数与结果'}
        onClick={() => setOpenPersisted(!open)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          // 空格按在 div 上默认会滚页面，先挡掉再自己处理。
          event.preventDefault()
          setOpenPersisted(!open)
        }}
      >
        <span className="name">{call.name}</span>
        {/* 摘要这一格始终渲染（哪怕是空串）：它的 flex:1 负责把状态与箭头顶到行尾 */}
        <span className="preview">{summary}</span>
        <span className="status">
          {running && <i className="tc-spin" aria-hidden />}
          {STATUS_TEXT[status]}
        </span>
        <IconChevronDown size={11} className="tc-chevron" />
      </div>
      {open && (
        <div className="tool-body" ref={bodyRef}>
          {barVisible && (
            <div className="tc-bar" data-tc-chrome="1" ref={barRef}>
              <span className="tc-bar-status">{barStatus}</span>
              {/* 还在跑的时候不给「收起」：这一刻收起只会让人以为任务被取消了。 */}
              {!running && (
                <button
                  type="button"
                  className="tc-collapse"
                  title="收起这张工具卡"
                  onClick={() => setOpenPersisted(false)}
                >
                  收起
                  <IconChevronUp size={11} />
                </button>
              )}
            </div>
          )}
          <div className="label">参数</div>
          <div className="args">{prettyArgs(call.argsText)}</div>
          {call.resultText !== undefined && call.resultText !== '' && (
            <>
              <div className="label">结果</div>
              <div className="result">{call.resultText}</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
