/**
 * 底部状态栏（0.6.59 对齐 dsh StatusLine 的规格）：固定两行、无框。
 *
 * 第一行是 **context 进度条**——全宽背景色带，占用段着色（≥80% 琥珀、≥95% 红），
 * 空闲段右侧读数 `10k/1.0M 1.0%`（formatTokens 与 dsh 同口径：988 / 3.4k / 12k /
 * 1.0M）。数据源 status.usage（当前会话增量）+ status.contextWindow（模型窗口）。
 *
 * 第二行是状态字段行：左组 `● 状态 · 模型 · effort · 缓存% · tok↑↓ · 模式 · 权限`，
 * 右组 `ctx% · cwd · 会话id · 后台芯片`（space-between；后台芯片可点，直达转录）。
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
import { GAP, PAD, PALETTE, STATUS_COLOR, TEXT } from './theme.js'

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

/** context 进度条：占用段 bg 着色，空闲段深底 + 右对齐读数；条宽恒等于可用列宽。 */
function ContextBar({ status }: { status: StatusView }): JSX.Element {
  const { stdout } = useStdout()
  const width = Math.max(10, (stdout?.columns ?? 100) - PAD.page * 2)
  const used = status.usage === null ? 0 : status.usage.inputTokens + status.usage.outputTokens
  const window = status.contextWindow
  const ratio = window > 0 ? Math.min(1, used / window) : 0
  const pctText = window > 0 ? `${(ratio * 100).toFixed(1)}%` : '--%'
  const readout = `${fmtTokens(used)}/${window > 0 ? fmtTokens(window) : '--'} ${pctText}`
  const readoutWidth = displayWidth(readout)
  // 读数永远贴条右缘：占用段最长留到「宽 − 读数 − 1」，避免极满时读数溢出条外
  const filledMax = Math.max(0, width - readoutWidth - 1)
  const filled = ratio > 0 ? Math.min(Math.max(1, Math.round(width * ratio)), filledMax) : 0
  const freeBg = width - filled - readoutWidth
  const fillColor =
    ratio >= 0.95 ? PALETTE.error : ratio >= 0.8 ? PALETTE.warning : PALETTE.brand
  return (
    <Box>
      <Text>
        {filled > 0 ? <Text backgroundColor={fillColor}>{' '.repeat(filled)}</Text> : null}
        {freeBg > 0 ? <Text backgroundColor={PALETTE.surface}>{' '.repeat(freeBg)}</Text> : null}
        <Text backgroundColor={PALETTE.surface} {...TEXT.secondary}>
          {readout}
        </Text>
      </Text>
    </Box>
  )
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
  const used = usage === null ? 0 : usage.inputTokens + usage.outputTokens
  const ctxPct =
    status.contextWindow > 0 ? `${((used / status.contextWindow) * 100).toFixed(1)}%` : '--%'
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
