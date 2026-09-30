/**
 * 轨迹页：agent 执行过程的时间线（对照 dsh 的「轨迹」标签）。
 *
 * 结构（改版要点）：
 * 1. 上方一条**时间概览条**（TraceTimeline）：把整轮会话按真实时间投影成横向时间轴，
 *    有耗时的工具画有宽度的条、其余只画起点刻度，拖选区间可聚焦下方记录；
 * 2. 下面是**轮次记录表**：按用户消息分轮，轮头一行（第 N 轮 + 用户消息摘要 + 步数统计）
 *    可折叠；带 `compaction` 字段的条目（实时的 system 通知 / 重放的那条摘要 user 条目）
 *    渲染成轮与轮之间的独立区段行「已压缩历史 · 第 N 次」，不归任何一轮；
 *    正文 text 条目仍不进轨迹（看内容去「对话」）；
 * 3. 每条步骤右侧一列**行内元信息**：时刻（HH:mm）· 工具耗时 · 用量；
 * 4. 点行打开右侧**检查器**（TraceInspector）：输入 / 输出 / 思考全文 / 计时 / 用量 / 附件；
 * 5. 尾部跟随：默认贴底，用户上滚暂停（不弹按钮），滚回底部附近自动恢复。
 *
 * 诚实口径：条目 `ts` 是「最后写入时刻」，工具的发起时刻只认 `call.startedAt`，耗时只认
 * `call.durationMs`——缺哪个就写「未记录」，不拿 `ts` 冒充、不编 0 秒、不虚构宽度。
 *
 * @module desktop/renderer/TraceView
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import type { StatusView, TranscriptEntry } from '@dsc/runtime/contract.js'
import { ToolCard } from './ToolCard.js'
import { TraceTimeline } from './TraceTimeline.js'
import { TraceInspector } from './TraceInspector.js'
import { IconChevronDown, IconChevronRight, IconCoins } from './icons.js'
import { AT_BOTTOM_EPS } from './JumpStrip.js'
import { formatClock } from './turn-timing.js'
import { formatTokens } from './token-estimate.js'
import {
  buildTraceModel,
  entryUsage,
  formatTraceDuration,
  rangeHits,
  type TraceRange,
  type TraceRound,
  type TraceStepEntry,
} from './trace-format.js'

/** 折叠态里的思考摘要长度：一行放不下就省略号，展开才看全文。 */
const THINK_PREVIEW_LIMIT = 90

/**
 * 「用户真的滚离底部了」的门槛（px）：比贴底判定 AT_BOTTOM_EPS（32px）宽一档，
 * 两档之间是滞回区间——停在这一带两边都不动，跟随态不会随着手抖反复翻。
 * 与 ChatView 的自动跟随是同一把尺子（那边叫 PAUSE_EPS），刻意取值一致。
 */
const TRACE_PAUSE_EPS = 120

/** 把多行文本压成一行摘要（折叠态显示用）。 */
function summarize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > THINK_PREVIEW_LIMIT ? `${flat.slice(0, THINK_PREVIEW_LIMIT)}…` : flat
}

export function TraceView(props: {
  entries: TranscriptEntry[]
  status: StatusView
}): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)
  /** 展开着的轮次序号；默认只放最新一轮。 */
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  /** 检查器正开着的那条记录（存 id 而不是对象：运行中的工具卡会持续更新，按 id 现取才跟得上）。 */
  const [inspectId, setInspectId] = useState<number | null>(null)
  /** 时间条上拖选出来的区间。 */
  const [selected, setSelected] = useState<TraceRange | null>(null)

  /**
   * 还在不在「跟随最新内容」。
   *
   * 为什么用 ref 不用 state：这个判断挂在滚动事件与每次渲染上，走 state 会为了一个
   * 只在切换瞬间才变的值多渲染一轮；需求也明确「不弹任何按钮」，所以它没有配套 UI。
   * 判定沿 ChatView 的做法：离开底部 TRACE_PAUSE_EPS 就暂停，回到 AT_BOTTOM_EPS 以内恢复。
   */
  const followRef = useRef(true)
  /**
   * 我们自己钉底时落到的那个 scrollTop。
   *
   * 为什么要记这一笔：`scrollTop = scrollHeight` 是程序性滚动，但它同样会（异步）发一个
   * scroll 事件；不认这一笔的话，自动跟随会把**自己钉的那一下**判成「用户滚离」，
   * 于是新步骤一来就自己停了跟随。
   */
  const autoTopRef = useRef(-1)
  /** 已经聚焦过的那个区间（同一区间不重复滚，内容更新时不把视角反复拽走）。 */
  const appliedSelection = useRef<TraceRange | null>(null)
  /** 待聚焦的步骤 id：等它所在的那一轮渲染出来再滚（见下面的聚焦 effect）。 */
  const [focusId, setFocusId] = useState<number | null>(null)

  const model = useMemo(() => buildTraceModel(props.entries), [props.entries])
  const rounds = model.rounds
  const toolCount = props.entries.filter((entry) => entry.kind === 'tool').length
  const usage = props.status.usage

  /** 条目 id → 轮次序号（检查器标题、命中步骤的轮次都要用）。 */
  const roundOfEntry = useMemo(() => {
    const map = new Map<number, number>()
    for (const round of rounds) {
      if (round.user !== null) map.set(round.user.id, round.index)
      for (const step of round.steps) map.set(step.id, round.index)
    }
    return map
  }, [rounds])

  /**
   * 每轮的用量真值：轮内**最后一条**带 usage 的 text / tool 条目（contract.ts 的口径）。
   * 为什么整轮键起来：同一轮里靠前的条目挂的是「到那一刻为止」的累计，逐条显示会让人
   * 把中间值读成整轮量；这里只认最后一条，其余行不显示用量。
   */
  const roundUsage = useMemo(() => {
    const map = new Map<number, { entryId: number; total: number }>()
    for (const round of rounds) {
      for (const step of round.steps) {
        const own = entryUsage(step)
        if (own !== null) map.set(round.index, { entryId: step.id, total: own.inputTokens + own.outputTokens })
      }
    }
    return map
  }, [rounds])

  /** 选中的区间命中了哪些步骤（没选就是空集，界面不画任何命中样式）。 */
  const hitIds = useMemo(() => {
    const hits = new Set<number>()
    if (selected === null) return hits
    for (const mark of model.marks) if (rangeHits(mark, selected)) hits.add(mark.id)
    return hits
  }, [model.marks, selected])

  /** 按 id 找条目：检查器要拿到最新的那一份（工具卡的结果是后到的）。 */
  const inspectEntry = useMemo(
    () => (inspectId === null ? null : (props.entries.find((entry) => entry.id === inspectId) ?? null)),
    [inspectId, props.entries],
  )

  // 最新一轮默认展开：新的一轮到来时把它打开，旧的保持用户留下的折叠状态。
  useEffect(() => {
    if (rounds.length === 0) return
    setExpanded((current) => {
      const last = rounds.length - 1
      if (current.has(last)) return current
      return new Set(current).add(last)
    })
  }, [rounds.length])

  /**
   * 尾部跟随：内容变了就把尾巴贴到底——前提是「还在跟随」。
   * 轨迹表是往下 append 行（不是像流式正文那样改已有元素的高度），所以不需要 ChatView
   * 那套「自己钉的那一下」之外的额外处理，这里从简。
   */
  useEffect(() => {
    const element = scroller.current
    if (element === null || !followRef.current) return
    element.scrollTop = element.scrollHeight
    autoTopRef.current = element.scrollTop
  }, [props.entries])

  /**
   * 滚动 = 用户对视角的表态：离开底部就暂停跟随，回到贴底档（32px）以内就恢复。
   * 滚动事件可能来自「我们自己钉底那一下」，落点与 autoTopRef 重合就不算用户滚离。
   */
  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    const onScroll = (): void => {
      if (Math.abs(element.scrollTop - autoTopRef.current) <= 1) return
      const limit = element.scrollHeight - element.clientHeight
      // 一屏装得下：不存在「离开底部」，跟随照旧
      if (limit <= 0) {
        followRef.current = true
        return
      }
      const away = limit - element.scrollTop
      if (away <= AT_BOTTOM_EPS) followRef.current = true
      else if (away > TRACE_PAUSE_EPS) followRef.current = false
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [])

  /** 点行开检查器：卡片自己的交互（折叠、参数里的按钮、划选文本）不抢过来。 */
  const openFromRow = (event: ReactMouseEvent<HTMLDivElement>, step: TraceStepEntry): void => {
    const target = event.target
    if (
      target instanceof HTMLElement &&
      target.closest('button, a, summary, .tool-head, .tool-body, [data-trace-open]') !== null
    ) {
      return
    }
    setInspectId(step.id)
  }

  const clearSelection = useCallback((): void => setSelected(null), [])
  const closeInspector = useCallback((): void => setInspectId(null), [])

  /**
   * 拖选之后聚焦：把命中所在的轮打开，并记下要滚到哪一条。
   * 同一个区间只做一次（内容再更新也不把用户正在看的视角拽走）。
   */
  useEffect(() => {
    if (selected === null) {
      appliedSelection.current = null
      return
    }
    if (appliedSelection.current === selected) return
    appliedSelection.current = selected
    const hits = model.marks.filter((mark) => rangeHits(mark, selected))
    if (hits.length === 0) return
    setExpanded((current) => {
      const next = new Set(current)
      for (const hit of hits) next.add(hit.round)
      return next
    })
    setFocusId(hits[0]?.id ?? null)
  }, [selected, model.marks])

  /** 真要滚，得等命中的那一轮已经渲染出来（折着的轮里没有那条记录）。 */
  useEffect(() => {
    if (focusId === null) return
    const element = scroller.current
    const target = element?.querySelector(`[data-trace-step="${String(focusId)}"]`)
    if (element === null || !(target instanceof HTMLElement)) return
    target.scrollIntoView({ block: 'center' })
    autoTopRef.current = element.scrollTop
    // 用户在看区间内的记录，不该被下一条新记录拽回底部：这一下之后暂停跟随，
    // 滚回底部附近（32px）会自动恢复。
    followRef.current = false
    setFocusId(null)
  }, [focusId, expanded, model.marks])

  if (model.segments.length === 0) {
    return (
      <div className="trace-page">
        <div className="chat" ref={scroller}>
          <div className="chat-inner trace">
            <div className="trace-empty">本会话还没有执行轨迹。发送消息或使用工具后，这里会显示执行过程。</div>
          </div>
        </div>
      </div>
    )
  }

  const allOpen = expanded.size >= rounds.length
  const toggleAll = (): void => {
    setExpanded(allOpen ? new Set() : new Set(rounds.map((_, index) => index)))
  }
  const toggleRound = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="trace-page">
      <div className="chat" ref={scroller}>
        <div className="chat-inner trace">
          <TraceTimeline
            marks={model.marks}
            boundaries={model.boundaries}
            spanStart={model.spanStart}
            spanEnd={model.spanEnd}
            selected={selected}
            selectedCount={hitIds.size}
            onSelect={setSelected}
          />

          <div className="trace-stats">
            <span>{rounds.length} 轮</span>
            <span>{toolCount} 次工具调用</span>
            {usage !== null && (
              <span>
                <IconCoins size={12} /> {formatTokens(usage.inputTokens + usage.outputTokens)} tok
              </span>
            )}
            {selected !== null && (
              <span className="trace-focus-chip" data-trace-focus="1">
                已聚焦区间内 {hitIds.size} 步
              </span>
            )}
            <button className="text-btn trace-toggle-all" onClick={toggleAll}>
              {allOpen ? '全部折叠' : '全部展开'}
            </button>
          </div>

          {model.segments.map((segment) =>
            segment.type === 'compaction' ? (
              // 压缩落点：轮与轮之间的独立区段行（对照 dsh 的 Between turns）。
              // 渲染层只认 entry.compaction 这个字段，不做任何正文文本匹配。
              <div
                className="trace-compact"
                key={`compact-${String(segment.entry.id)}`}
                data-trace-compaction={String(segment.count)}
                data-tip="从这一刻起，模型看到的历史已经是压缩后的摘要"
              >
                <span className="trace-compact-rule" />
                <span className="trace-compact-tag">已压缩历史 · 第 {segment.count} 次</span>
                <span className="trace-compact-rule" />
              </div>
            ) : (
              <RoundBlock
                key={`round-${String(segment.round.index)}`}
                round={segment.round}
                open={expanded.has(segment.round.index)}
                onToggle={() => toggleRound(segment.round.index)}
                usage={roundUsage.get(segment.round.index) ?? null}
                hitIds={hitIds}
                dimmed={selected !== null}
                inspectingId={inspectId}
                onOpenInspector={setInspectId}
                onRowClick={openFromRow}
              />
            ),
          )}
        </div>
      </div>

      {inspectEntry !== null && (
        <>
          {/* 遮罩：点一下就关（需求指定的两种关闭方式之一，另一种是右上角的 ×） */}
          <div className="trace-scrim" data-trace-scrim="1" onClick={closeInspector} />
          <TraceInspector
            entry={inspectEntry}
            round={roundOfEntry.get(inspectEntry.id) ?? null}
            usageIsRoundTotal={
              inspectEntry.kind === 'text' || inspectEntry.kind === 'tool'
                ? roundUsage.get(roundOfEntry.get(inspectEntry.id) ?? -1)?.entryId === inspectEntry.id
                : false
            }
            onClose={closeInspector}
          />
        </>
      )}
    </div>
  )
}

/** 一轮：轮头一行 + 展开后的步骤表。 */
function RoundBlock({
  round,
  open,
  onToggle,
  usage,
  hitIds,
  dimmed,
  inspectingId,
  onOpenInspector,
  onRowClick,
}: {
  round: TraceRound
  open: boolean
  onToggle: () => void
  usage: { entryId: number; total: number } | null
  hitIds: Set<number>
  /** 时间条上有选中区间时，未命中的步骤要压暗（聚焦效果）。 */
  dimmed: boolean
  inspectingId: number | null
  onOpenInspector: (id: number) => void
  onRowClick: (event: ReactMouseEvent<HTMLDivElement>, step: TraceStepEntry) => void
}): JSX.Element {
  const tools = round.steps.filter((step) => step.kind === 'tool').length
  const user = round.user
  const images = user?.images?.length ?? 0
  return (
    <div className={`trace-round${open ? ' open' : ''}`} data-trace-round={String(round.index)}>
      <div className="round-line">
        <button
          className="round-head"
          data-round-index={String(round.index)}
          aria-expanded={open}
          data-tip={open ? '折叠这一轮' : '展开这一轮的执行步骤'}
          onClick={onToggle}
        >
          <span className="round-caret">
            {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          </span>
          <span className="round-no">第 {round.index + 1} 轮</span>
          {user !== null && <span className="round-user">{user.text}</span>}
          {images > 0 && <span className="round-attach">{images} 张附件</span>}
          <span className="round-meta">
            {round.steps.length === 0 ? '无步骤' : `${round.steps.length} 步 · ${tools} 次工具`}
          </span>
          {usage !== null && (
            <span
              className="round-tok"
              data-tip="这一轮所有模型请求的 prompt + completion 之和（宿主上报的真值）"
            >
              {formatTokens(usage.total)} tok
            </span>
          )}
        </button>
        {user !== null && (
          <button
            type="button"
            className="round-open"
            data-trace-open={String(user.id)}
            data-tip="查看这条用户消息与附件"
            aria-label="查看这条用户消息与附件"
            onClick={() => onOpenInspector(user.id)}
          >
            <IconChevronRight size={12} />
          </button>
        )}
      </div>
      {open &&
        (round.steps.length === 0 ? (
          <div className="round-none">无工具调用与系统事件</div>
        ) : (
          <div className="round-steps">
            {round.steps.map((step) => (
              <StepRow
                key={step.id}
                step={step}
                round={round.index}
                hit={hitIds.has(step.id)}
                dim={dimmed && !hitIds.has(step.id)}
                inspecting={inspectingId === step.id}
                usageTotal={roundUsageOwnTotal(step, usage)}
                onOpenInspector={onOpenInspector}
                onRowClick={onRowClick}
              />
            ))}
          </div>
        ))}
    </div>
  )
}

/**
 * 这一行自己带的用量：只有它就是本轮的真值那一行才显示。
 * 中间的累计值不显示——同一轮里每条都挂着一个数，逐条画会让人以为那是每一步花的量。
 */
function roundUsageOwnTotal(
  step: TraceStepEntry,
  usage: { entryId: number; total: number } | null,
): number | null {
  if (usage === null || usage.entryId !== step.id) return null
  return usage.total
}

/** 一条步骤：内容 + 右侧行内元信息（时刻 / 耗时 / 用量 / 打开检查器）。 */
function StepRow({
  step,
  round,
  hit,
  dim,
  inspecting,
  usageTotal,
  onOpenInspector,
  onRowClick,
}: {
  step: TraceStepEntry
  round: number
  hit: boolean
  dim: boolean
  inspecting: boolean
  usageTotal: number | null
  onOpenInspector: (id: number) => void
  onRowClick: (event: ReactMouseEvent<HTMLDivElement>, step: TraceStepEntry) => void
}): JSX.Element {
  // 行内时刻取条目 ts（HH:mm）——工具的**发起**时刻另有 startedAt，两者不是一回事。
  const clock = formatClock(step.ts ?? null)
  const duration = step.kind === 'tool' ? formatTraceDuration(step.call.durationMs ?? null) : null
  const status = step.kind === 'tool' ? step.call.status : null
  return (
    <div
      className={`step trace-step${hit ? ' is-hit' : ''}${dim ? ' is-dim' : ''}${inspecting ? ' is-inspecting' : ''}`}
      data-trace-step={String(step.id)}
      data-round={String(round)}
      data-kind={step.kind}
      data-status={status ?? undefined}
      data-hit={hit ? '1' : undefined}
      onClick={(event) => onRowClick(event, step)}
    >
      <div className="trace-step-body">
        {step.kind === 'tool' && <ToolCard call={step.call} />}
        {step.kind === 'thinking' && (
          <details className="trace-think">
            <summary data-tip="展开思考全文">
              <span className="th-label">思考</span>
              <span className="th-preview">{summarize(step.text)}</span>
              <IconChevronDown size={13} className="th-chevron" />
            </summary>
            <div className="body">{step.text}</div>
          </details>
        )}
        {step.kind === 'system' && (
          <div className="trace-sys" data-tip={step.text}>
            {step.text}
          </div>
        )}
        {step.kind === 'plan' && (
          <div className="trace-plan" data-tip={step.plan.text}>
            <span className="th-label">计划</span>
            <span className="plan-title">{step.plan.title}</span>
            <span className="plan-file">{step.plan.file}</span>
          </div>
        )}
      </div>
      <div className="trace-meta">
        {clock !== null && (
          <span className="tmeta-clock" data-tip="这条记录最后写入的时刻（本机时区）">
            {clock}
          </span>
        )}
        {duration !== null && (
          <span className="tmeta-dur" data-tip="这次工具调用从发起到结果回来的耗时">
            {duration}
          </span>
        )}
        {usageTotal !== null && (
          <span className="tmeta-tok" data-tip="这一轮所有模型请求的 prompt + completion 之和">
            {formatTokens(usageTotal)} tok
          </span>
        )}
        <button
          type="button"
          className="tmeta-open"
          data-trace-open={String(step.id)}
          data-tip="打开检查器：输入、输出、思考全文、计时与用量"
          aria-label="打开检查器"
          onClick={() => onOpenInspector(step.id)}
        >
          <IconChevronRight size={12} />
        </button>
      </div>
    </div>
  )
}
