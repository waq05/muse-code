/**
 * 底部状态栏（0.6.59 对齐 dsh StatusLine 的规格，0.6.60 分段条与费用）：固定两行、无框。
 *
 * 第一行是 **context 分段进度条**——占用段按内容类型着色（system/prompt/assistant/
 * thinking/tools，dsh 蓝系谱；估算分段，见 core/token-estimate），空闲段右侧读数
 * `10k/1.0M 1.0%`。读数的分子是**最近一次请求的 prompt_tokens**（权威占用；usage
 * 累计是多轮计费和，会把滚出窗口的内容也算进去），≥80% 琥珀、≥95% 红。
 *
 * 第二行是状态字段行：段间 ` · ` 暗淡分隔（theme 的 SEP.dot），左右两组
 * space-between；后台芯片可点，直达转录。段显隐走 prefs.ui.statusBar（设置 →
 * 终端界面 → 状态栏，0.6.62），开关与数据双条件、缺一整段缺席；总宽超出预算时
 * 按 priority **整段丢弃**（对齐 dsh 的「段缺席优于段截断」——旧版全靠 ink 的
 * flex 等比压缩，宽终端一挤就段段变 `xxx...`），可丢的全丢光仍放不下才让
 * cwd/model 收缩截断。≈¥ 只在 DeepSeek 官方端点且模型有价目时出现（峰谷按
 * 北京时段分桶估算）。行数恒定是选择器几何的组成部分。
 *
 * @module dsc-tui/app/StatusBar
 */
import { useRef } from 'react'
import { Box, Text, useStdout } from 'ink'
import type { DOMElement } from 'ink'
import type { JSX } from 'react'
import type { RuntimeSnapshot, RuntimeSurfaces, StatusBarPrefsView, StatusView } from '../contract.js'
import { useClickRegion, type RegisterClick } from './click.js'
import { displayWidth } from './markdown.js'
import { CONTEXT_SEGMENTS, GAP, PAD, PALETTE, SEP, STATUS_COLOR, TEXT } from './theme.js'

/** 回合状态词：中文硬编码，本项目不做 i18n。 */
const TURN_LABEL: Record<StatusView['turnState'], string> = {
  idle: '空闲',
  thinking: '思考中',
  working: '执行中',
  'awaiting-approval': '等待审批',
}

/** 回合状态色：进行中的两种状态共用一个状态色，空闲只靠暗淡色。 */
const TURN_COLOR: Record<StatusView['turnState'], string | undefined> = {
  idle: STATUS_COLOR.idle,
  thinking: STATUS_COLOR.pending,
  working: STATUS_COLOR.pending,
  'awaiting-approval': STATUS_COLOR.waiting,
}

/** 后台会话状态点的形状与颜色（working 青 / 待审批黄 / 已完成未读绿）。 */
const BACKGROUND_DOT: Record<RuntimeSnapshot['sessionStates'][string], { mark: string; color: string | undefined }> = {
  working: { mark: '◐', color: STATUS_COLOR.pending },
  'awaiting-approval': { mark: '⚠', color: STATUS_COLOR.waiting },
  'just-finished': { mark: '✓', color: STATUS_COLOR.done },
}

/** 会话 jsonl 路径的短标识（文件名去后缀取前 8 位）。 */
export const shortId = (sessionPath: string): string =>
  (sessionPath.split(/[\\/]/).pop() ?? sessionPath).replace(/\.jsonl$/, '').slice(0, 8)

/** cwd 尾部显示：太长时只留最后两段（Windows 盘符段算一段）。 */
const shortCwd = (cwd: string): string => {
  const parts = cwd.split(/[\\/]/).filter((part) => part !== '')
  return parts.length <= 2 ? cwd : `…${parts.slice(-2).join('/')}`
}

/**
 * 字段行的一个段（0.6.62 起可配置）：text 是静态短文本，chip 是可点的后台会话。
 * priority 小者先丢，-1 = 永不丢（状态点与模型名是身份信息）。
 */
type FieldSegment =
  | { kind: 'text'; id: string; text: string; tone: 'label' | 'secondary'; color?: string; priority: number }
  | { kind: 'chip'; id: string; sessionPath: string; state: RuntimeSnapshot['sessionStates'][string]; priority: number }

/** 段的显示宽度（chip 按渲染文本 `mark id` 算）。 */
const segmentWidth = (segment: FieldSegment): number => {
  if (segment.kind === 'chip') {
    return displayWidth(`${BACKGROUND_DOT[segment.state].mark} ${shortId(segment.sessionPath)}`)
  }
  return displayWidth(segment.text)
}

/** 一组段的总宽：段宽之和 + 段间 ` · ` 分隔（组内只有一段时没有分隔）。 */
const groupWidth = (segments: readonly FieldSegment[]): number =>
  segments.reduce((sum, segment) => sum + segmentWidth(segment), 0) +
  Math.max(0, segments.length - 1) * displayWidth(SEP.dot)

/**
 * 优先级丢段：左右组总宽（+ 最小 2 列组间缝）超出预算时，按 priority 从小到大
 * **整段**丢弃重算，直到放得下或没有可丢段。返回筛选后的两份列表（原数组不动）。
 */
function fitSegments(
  left: readonly FieldSegment[],
  right: readonly FieldSegment[],
  budget: number,
): { left: FieldSegment[]; right: FieldSegment[] } {
  let leftFitted = [...left]
  let rightFitted = [...right]
  const overflow = (): boolean => groupWidth(leftFitted) + groupWidth(rightFitted) + 2 > budget
  while (overflow()) {
    const droppable = [...leftFitted, ...rightFitted]
      .filter((segment) => segment.priority >= 0)
      .sort((a, b) => a.priority - b.priority)[0]
    if (droppable === undefined) break
    leftFitted = leftFitted.filter((segment) => segment !== droppable)
    rightFitted = rightFitted.filter((segment) => segment !== droppable)
  }
  return { left: leftFitted, right: rightFitted }
}

/** token 数的人话格式（dsh StatusMetrics 同口径）：988 / 3.4k / 12k / 1.0M。 */
const fmtTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/** 后台会话芯片：一枚状态点 + 短 id，整枚可点，点了开那个会话的转录浮层。 */
function BackgroundChip({
  sessionPath,
  state,
  onOpen,
  registerClick,
}: {
  sessionPath: string
  state: RuntimeSnapshot['sessionStates'][string]
  onOpen: (sessionPath: string) => void
  registerClick?: RegisterClick
}): JSX.Element {
  const ref = useRef<DOMElement | null>(null)
  const dot = BACKGROUND_DOT[state]
  useClickRegion(ref, registerClick, (col, row, top, height) => {
    if (row < top || row >= top + height) return false
    onOpen(sessionPath)
    return true
  })
  return (
    <Box ref={ref} flexShrink={0}>
      <Text {...TEXT.label} color={dot.color} wrap="truncate-end">
        {dot.mark} {shortId(sessionPath)}
      </Text>
    </Box>
  )
}

/** 全零分段（快照缺字段时的兜底：老 mock / 旧版本快照没有 contextSegments 也不许炸）。 */
const EMPTY_SEGMENTS: StatusView['contextSegments'] = {
  system: 0,
  prompt: 0,
  assistant: 0,
  thinking: 0,
  tools: 0,
}

/**
 * context 分段进度条（dsh renderContextBar 的 JSX 版）：占用段各一块纯色
 * （childless Box——渲染器按自身矩形填背景色），空闲段深底、右缘挂读数。
 * 列宽分配 = largest-remainder + 每个可见段至少 1 列（dsh allocateBarColumns 同款）。
 */
function ContextBar({ status }: { status: StatusView }): JSX.Element {
  const { stdout } = useStdout()
  const width = Math.max(10, (stdout?.columns ?? 100) - PAD.page * 2)
  const window = status.contextWindow
  const used = window > 0 ? Math.min(status.contextUsed ?? 0, window) : 0
  const ratio = window > 0 ? used / window : 0
  const pctText = window > 0 ? `${(ratio * 100).toFixed(1)}%` : '--%'
  // 读数阶梯（dsh contextBarReadout）：全形式放不下就退到只剩百分比
  const fullReadout = `${fmtTokens(used)}/${window > 0 ? fmtTokens(window) : '--'} ${pctText}`
  const readout = width - displayWidth(fullReadout) >= 2 ? fullReadout : pctText
  const readoutWidth = displayWidth(readout)

  // 分段列宽：空闲段 = 窗口 − 权威占用（不是分段之和——分段是估算，只管颜色组成）。
  // 窗口未知（0）时整条画成空闲段：状态栏行数是恒定几何，条不能塌成 0 行。
  const free = window > 0 ? Math.max(0, window - used) : width
  const segments = status.contextSegments ?? EMPTY_SEGMENTS
  const values = [...CONTEXT_SEGMENTS.map((segment) => segments[segment.key] ?? 0), free]
  const columns = allocateBarColumns(values, width)

  const nodes: JSX.Element[] = []
  for (const [index, segment] of CONTEXT_SEGMENTS.entries()) {
    const segmentWidth = columns[index] ?? 0
    if (segmentWidth <= 0) continue
    nodes.push(
      <Box key={segment.key} width={segmentWidth} height={1} flexShrink={0} backgroundColor={segment.color} />,
    )
  }
  const freeWidth = columns[CONTEXT_SEGMENTS.length] ?? 0
  if (freeWidth > 0) {
    // 读数永远贴条右缘；压力阈值染读数（空闲段底色不动）
    const pressure = ratio >= 0.95 ? PALETTE.error : ratio >= 0.8 ? PALETTE.warning : undefined
    nodes.push(
      <Box key="free" width={freeWidth} height={1} flexShrink={0} backgroundColor={PALETTE.surface}>
        <Text color={pressure ?? undefined} dimColor={pressure === undefined} wrap="truncate-end">
          {' '.repeat(Math.max(0, freeWidth - readoutWidth))}{readout}
        </Text>
      </Box>,
    )
  }
  return (
    <Box flexDirection="row" flexShrink={0}>
      {nodes}
    </Box>
  )
}

/** largest-remainder 列宽分配（dsh StatusMetrics 同款）：可见段先各保 1 列，其余按比例分。 */
function allocateBarColumns(values: readonly number[], width: number): number[] {
  const allocate = (columns: number): number[] => {
    if (columns <= 0) return values.map(() => 0)
    const total = values.reduce((sum, value) => sum + value, 0)
    if (total <= 0) return values.map(() => 0)
    const raw = values.map((value) => (value / total) * columns)
    const floored = raw.map(Math.floor)
    let remaining = columns - floored.reduce((sum, value) => sum + value, 0)
    const byRemainder = raw
      .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
      .sort((left, right) => right.remainder - left.remainder)
    for (const slot of byRemainder) {
      if (remaining <= 0) break
      floored[slot.index] = (floored[slot.index] ?? 0) + 1
      remaining -= 1
    }
    return floored
  }
  const visible = values.map((value, index) => (value > 0 ? index : -1)).filter((index) => index >= 0)
  if (visible.length === 0 || visible.length >= width) return allocate(width)
  const minimum = values.map(() => 0)
  for (const index of visible) minimum[index] = 1
  const rest = allocate(width - visible.length)
  return minimum.map((min, index) => min + (rest[index] ?? 0))
}

export function StatusBar({
  status,
  surfaces,
  sessionStates,
  config,
  onOpenAgent,
  registerClick,
}: {
  status: StatusView
  surfaces: RuntimeSurfaces
  sessionStates: RuntimeSnapshot['sessionStates']
  /** 段显隐（prefs.ui.statusBar；设置 → 终端界面 → 状态栏 子页可改）。 */
  config: StatusBarPrefsView
  /** 点后台芯片：打开那个会话的转录浮层（子代理查看入口之一）。 */
  onOpenAgent?: (sessionPath: string) => void
  registerClick?: RegisterClick
}): JSX.Element {
  const { stdout } = useStdout()
  const modeLabel =
    surfaces.mode.options.find((option) => option.id === surfaces.mode.current)?.label ??
    surfaces.mode.current
  const policyLabel =
    surfaces.policy.options.find((option) => option.id === surfaces.policy.current)?.label ??
    surfaces.policy.current
  const usage = status.usage
  const cacheHit = usage?.cacheHitTokens ?? 0
  const cacheMiss = usage?.cacheMissTokens ?? 0
  const cacheTotal = cacheHit + cacheMiss
  const ctxPct =
    status.contextWindow > 0 ? `${((status.contextUsed / status.contextWindow) * 100).toFixed(1)}%` : '--%'

  // 段装配：开关（config）与数据（usage/cost/cwd）双条件，缺一整段缺席。
  // priority 只排「谁先被丢」，与左右组内的显示顺序无关。
  const left: FieldSegment[] = [
    {
      kind: 'text',
      id: 'turn',
      text: `${status.turnState === 'idle' ? '●' : '◐'} ${TURN_LABEL[status.turnState]}`,
      tone: 'label',
      color: TURN_COLOR[status.turnState],
      priority: -1,
    },
  ]
  if (config.model) left.push({ kind: 'text', id: 'model', text: status.model, tone: 'secondary', priority: -1 })
  if (config.effort)
    left.push({ kind: 'text', id: 'effort', text: `effort ${status.effort ?? '-'}`, tone: 'secondary', priority: 5 })
  if (config.cache && usage !== null && cacheTotal > 0)
    left.push({ kind: 'text', id: 'cache', text: `缓存${Math.round((cacheHit / cacheTotal) * 100)}%`, tone: 'secondary', priority: 3 })
  if (config.tokens && usage !== null)
    left.push({
      kind: 'text',
      id: 'tokens',
      text: `tok ${fmtTokens(usage.inputTokens)}↑ ${fmtTokens(usage.outputTokens)}↓`,
      tone: 'secondary',
      priority: 0,
    })
  // 费用估算：峰谷按北京时段分桶（core/pricing），估不出来就不显示这个字段
  if (config.cost && status.cost !== undefined)
    left.push({
      kind: 'text',
      id: 'cost',
      text: `≈¥${status.cost.total.toFixed(2)} ${status.cost.peakNow ? '峰' : '谷'}`,
      tone: 'secondary',
      priority: 2,
    })
  if (config.mode) left.push({ kind: 'text', id: 'mode', text: `模式 ${modeLabel}`, tone: 'secondary', priority: 4 })
  if (config.policy) left.push({ kind: 'text', id: 'policy', text: `权限 ${policyLabel}`, tone: 'secondary', priority: 7 })

  const right: FieldSegment[] = []
  if (config.ctx) right.push({ kind: 'text', id: 'ctx', text: `ctx ${ctxPct}`, tone: 'secondary', priority: 6 })
  if (config.cwd && status.cwd !== undefined && status.cwd !== '')
    right.push({ kind: 'text', id: 'cwd', text: shortCwd(status.cwd), tone: 'secondary', priority: 9 })
  if (config.session)
    right.push({
      kind: 'text',
      id: 'session',
      text: status.sessionId === null ? '未打开会话' : `会话 ${shortId(status.sessionId)}`,
      tone: 'secondary',
      priority: 1,
    })
  for (const [sessionPath, state] of Object.entries(sessionStates)) {
    right.push({ kind: 'chip', id: `chip:${sessionPath}`, sessionPath, state, priority: 8 })
  }

  // 宽度预算 = 终端列 − root 的页边距；丢段后仍溢出才让 cwd/model 收缩截断。
  const budget = Math.max(10, (stdout?.columns ?? 100) - PAD.page * 2)
  const fitted = fitSegments(left, right, budget)
  const shrink = groupWidth(fitted.left) + groupWidth(fitted.right) + 2 > budget
  const flexible = (segment: FieldSegment): boolean =>
    shrink && segment.kind === 'text' && (segment.id === 'cwd' || segment.id === 'model')

  /** 一组段 → 带 ` · ` 分隔的节点序列；分隔钉死不缩，可缩的只有 cwd/model。 */
  const renderGroup = (segments: readonly FieldSegment[]): JSX.Element[] =>
    segments.map((segment, index) => (
      <Box key={segment.id} flexShrink={flexible(segment) ? 1 : 0}>
        {index > 0 ? (
          <Box flexShrink={0}>
            <Text {...TEXT.secondary}>{SEP.dot}</Text>
          </Box>
        ) : null}
        {segment.kind === 'chip' ? (
          <BackgroundChip
            sessionPath={segment.sessionPath}
            state={segment.state}
            onOpen={onOpenAgent === undefined ? () => {} : onOpenAgent}
            registerClick={onOpenAgent === undefined ? undefined : registerClick}
          />
        ) : (
          <Text
            {...(segment.tone === 'label' ? TEXT.label : TEXT.secondary)}
            color={segment.color}
            wrap="truncate-end"
          >
            {segment.text}
          </Text>
        )}
      </Box>
    ))

  return (
    <Box flexDirection="column" gap={GAP.none}>
      <ContextBar status={status} />
      <Box justifyContent="space-between">
        <Box>{renderGroup(fitted.left)}</Box>
        <Box>{renderGroup(fitted.right)}</Box>
      </Box>
    </Box>
  )
}
