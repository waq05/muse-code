/**
 * 底部状态栏（0.6.59 对齐 dsh StatusLine 的规格，0.6.60 分段条与费用）：固定两行、无框。
 *
 * 第一行是 **context 分段进度条**——占用段按内容类型着色（system/prompt/assistant/
 * thinking/tools，dsh 蓝系谱；估算分段，见 core/token-estimate），空闲段右侧读数
 * `10k/1.0M 1.0%`。读数的分子是**最近一次请求的 prompt_tokens**（权威占用；usage
 * 累计是多轮计费和，会把滚出窗口的内容也算进去），≥80% 琥珀、≥95% 红。
 *
 * 第二行是状态字段行：左组 `● 状态 · 模型 · effort · 缓存% · tok↑↓ · ≈¥ · 模式 · 权限`，
 * 右组 `ctx% · cwd · 会话id · 后台芯片`（space-between；后台芯片可点，直达转录）。
 * ≈¥ 只在 DeepSeek 官方端点且模型有价目时出现（峰谷按北京时段分桶估算）。
 * 行内文本一律 `truncate-end`：行数恒定是选择器几何的组成部分。
 *
 * @module dsc-tui/app/StatusBar
 */
import { useRef } from 'react'
import { Box, Text, useStdout } from 'ink'
import type { DOMElement } from 'ink'
import type { JSX } from 'react'
import type { RuntimeSnapshot, RuntimeSurfaces, StatusView } from '../contract.js'
import { useClickRegion, type RegisterClick } from './click.js'
import { displayWidth } from './markdown.js'
import { CONTEXT_SEGMENTS, GAP, PAD, PALETTE, STATUS_COLOR, TEXT } from './theme.js'

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
    <Box ref={ref}>
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
  onOpenAgent,
  registerClick,
}: {
  status: StatusView
  surfaces: RuntimeSurfaces
  sessionStates: RuntimeSnapshot['sessionStates']
  /** 点后台芯片：打开那个会话的转录浮层（子代理查看入口之一）。 */
  onOpenAgent?: (sessionPath: string) => void
  registerClick?: RegisterClick
}): JSX.Element {
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
  const background = Object.entries(sessionStates)
  const ctxPct =
    status.contextWindow > 0 ? `${((status.contextUsed / status.contextWindow) * 100).toFixed(1)}%` : '--%'
  return (
    <Box flexDirection="column" gap={GAP.none}>
      <ContextBar status={status} />
      <Box justifyContent="space-between">
        <Box gap={PAD.field}>
          <Text {...TEXT.label} color={TURN_COLOR[status.turnState]} wrap="truncate-end">
            {status.turnState === 'idle' ? '●' : '◐'} {TURN_LABEL[status.turnState]}
          </Text>
          <Text {...TEXT.secondary} wrap="truncate-end">{status.model}</Text>
          <Text {...TEXT.secondary} wrap="truncate-end">effort {status.effort ?? '-'}</Text>
          {usage !== null && cacheTotal > 0 ? (
            <Text {...TEXT.secondary} wrap="truncate-end">
              缓存{Math.round((cacheHit / cacheTotal) * 100)}%
            </Text>
          ) : null}
          {usage !== null ? (
            <Text {...TEXT.secondary} wrap="truncate-end">
              tok {fmtTokens(usage.inputTokens)}↑ {fmtTokens(usage.outputTokens)}↓
            </Text>
          ) : null}
          {/* 费用估算：峰谷按北京时段分桶（core/pricing），估不出来就不显示这个字段 */}
          {status.cost !== undefined ? (
            <Text {...TEXT.secondary} wrap="truncate-end">
              ≈¥{status.cost.total.toFixed(2)} {status.cost.peakNow ? '峰' : '谷'}
            </Text>
          ) : null}
          <Text {...TEXT.secondary} wrap="truncate-end">模式 {modeLabel}</Text>
          <Text {...TEXT.secondary} wrap="truncate-end">权限 {policyLabel}</Text>
        </Box>
        <Box gap={PAD.field}>
          <Text {...TEXT.secondary} wrap="truncate-end">ctx {ctxPct}</Text>
          {status.cwd !== undefined && status.cwd !== '' ? (
            <Text {...TEXT.secondary} wrap="truncate-end">{shortCwd(status.cwd)}</Text>
          ) : null}
          <Text {...TEXT.secondary} wrap="truncate-end">
            {status.sessionId === null ? '未打开会话' : `会话 ${shortId(status.sessionId)}`}
          </Text>
          {background.map(([sessionPath, state]) => (
            <BackgroundChip
              key={sessionPath}
              sessionPath={sessionPath}
              state={state}
              onOpen={onOpenAgent === undefined ? () => {} : onOpenAgent}
              registerClick={onOpenAgent === undefined ? undefined : registerClick}
            />
          ))}
        </Box>
      </Box>
    </Box>
  )
}
