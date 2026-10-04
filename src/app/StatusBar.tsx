/**
 * 底部状态栏：一个描边框里的两行（有后台会话时第三行）。
 *
 * 第一行是状态行——回合状态（彩色标签）+ 协作模式 + 权限模式（档位名读 surfaces
 * 投影的 options，不在这里抄第二份档位表）；第二行是信息行——工作目录尾部、模型、
 * 思考强度、会话累计用量（in/out + 前缀缓存命中率）、会话短 id。第三行只在有后台
 * 会话（常驻 agent / 队友）时出现：每个会话一枚状态点，后台干活这件事终端里看得见。
 *
 * 行内文本一律 `truncate-end` 保证每行不折行：行数是选择器整屏几何的组成部分
 * （App 按 statusbarLines 给选择器凑帧高，折一行鼠标命中就偏一行）。
 *
 * @module dsc-tui/app/StatusBar
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { RuntimeSnapshot, RuntimeSurfaces, StatusView } from '../contract.js'
import { BORDER, PAD, STATUS_COLOR, TEXT } from './theme.js'

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
const shortId = (sessionPath: string): string =>
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

export function StatusBar({
  status,
  surfaces,
  sessionStates,
}: {
  status: StatusView
  surfaces: RuntimeSurfaces
  sessionStates: RuntimeSnapshot['sessionStates']
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
    <Box
      borderStyle="round"
      borderColor={BORDER.frame}
      paddingX={PAD.inline}
      flexDirection="column"
      gap={0}
    >
      <Box gap={PAD.field}>
        <Text {...TEXT.label} color={TURN_COLOR[status.turnState]} wrap="truncate-end">
          {status.turnState === 'idle' ? '●' : '◐'} {TURN_LABEL[status.turnState]}
        </Text>
        <Text {...TEXT.secondary} wrap="truncate-end">模式 {modeLabel}</Text>
        <Text {...TEXT.secondary} wrap="truncate-end">权限 {policyLabel}</Text>
      </Box>
      <Box gap={PAD.field}>
        {status.cwd !== undefined && status.cwd !== '' ? (
          <Text {...TEXT.secondary} wrap="truncate-end">{shortCwd(status.cwd)}</Text>
        ) : null}
        <Text {...TEXT.secondary} wrap="truncate-end">模型 {status.model}</Text>
        <Text {...TEXT.secondary} wrap="truncate-end">effort {status.effort ?? '-'}</Text>
        {usage !== null ? (
          <Text {...TEXT.secondary} wrap="truncate-end">
            tok {fmtTokens(usage.inputTokens)}↑ {fmtTokens(usage.outputTokens)}↓
            {cacheTotal > 0 ? ` 缓存${Math.round((cacheHit / cacheTotal) * 100)}%` : ''}
          </Text>
        ) : null}
        <Text {...TEXT.secondary} wrap="truncate-end">
          {status.sessionId === null ? '未打开会话' : `会话 ${status.sessionId.slice(0, 8)}`}
        </Text>
      </Box>
      {background.length > 0 ? (
        <Box gap={PAD.field}>
          <Text {...TEXT.label}>后台</Text>
          {background.map(([sessionPath, state]) => {
            const dot = BACKGROUND_DOT[state]
            return (
              <Text key={sessionPath} {...TEXT.label} color={dot.color}>
                {dot.mark} {shortId(sessionPath)}
              </Text>
            )
          })}
        </Box>
      ) : null}
    </Box>
  )
}
