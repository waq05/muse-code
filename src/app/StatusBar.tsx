/**
 * 底部状态栏（0.6.57 压缩版）：去掉描边框，固定两行——省出的 3 行全部还给聊天区。
 *
 * 第一行是状态行：回合状态（彩色标签）+ 协作模式 + 权限模式 + 模型 + 思考强度 +
 * 会话累计用量（in/out + 前缀缓存命中率）；第二行是位置行：工作目录尾部、会话短 id，
 * 以及后台会话状态芯片（常驻 agent / 队友，每个一枚状态点，**点击直接看它的转录**，
 * 对齐 dsh 状态栏「● N chip」的入口思路）。对齐 codex status_indicator 的取舍：
 * 状态行保持单行不折行（`truncate-end`），行数恒定让选择器几何保持稳定。
 *
 * @module dsc-tui/app/StatusBar
 */
import { useRef } from 'react'
import { Box, Text } from 'ink'
import type { DOMElement } from 'ink'
import type { JSX } from 'react'
import type { RuntimeSnapshot, RuntimeSurfaces, StatusView } from '../contract.js'
import { useClickRegion, type RegisterClick } from './click.js'
import { GAP, PAD, STATUS_COLOR, TEXT } from './theme.js'

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

/** token 数的人话格式：1.2M / 45.6k / 890。 */
const fmtTokens = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}k`
      : String(value)

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
  return (
    <Box flexDirection="column" gap={GAP.none}>
      <Box gap={PAD.field}>
        <Text {...TEXT.label} color={TURN_COLOR[status.turnState]} wrap="truncate-end">
          {status.turnState === 'idle' ? '●' : '◐'} {TURN_LABEL[status.turnState]}
        </Text>
        <Text {...TEXT.secondary} wrap="truncate-end">模式 {modeLabel}</Text>
        <Text {...TEXT.secondary} wrap="truncate-end">权限 {policyLabel}</Text>
        <Text {...TEXT.secondary} wrap="truncate-end">{status.model}</Text>
        <Text {...TEXT.secondary} wrap="truncate-end">effort {status.effort ?? '-'}</Text>
        {usage !== null ? (
          <Text {...TEXT.secondary} wrap="truncate-end">
            tok {fmtTokens(usage.inputTokens)}↑ {fmtTokens(usage.outputTokens)}↓
            {cacheTotal > 0 ? ` 缓存${Math.round((cacheHit / cacheTotal) * 100)}%` : ''}
          </Text>
        ) : null}
      </Box>
      <Box gap={PAD.field}>
        {status.cwd !== undefined && status.cwd !== '' ? (
          <Text {...TEXT.secondary} wrap="truncate-end">{shortCwd(status.cwd)}</Text>
        ) : null}
        <Text {...TEXT.secondary} wrap="truncate-end">
          {status.sessionId === null ? '未打开会话' : `会话 ${shortId(status.sessionId)}`}
        </Text>
        {background.length > 0 ? (
          <Text {...TEXT.label} wrap="truncate-end">后台</Text>
        ) : null}
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
  )
}
