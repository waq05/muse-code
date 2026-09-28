/**
 * 底部状态行：模型 / effort / 回合状态 / token / 会话。
 *
 * 回合状态是状态标签（暗淡色，按需叠状态色），其余字段全是次要信息（token 统计、
 * 路径、模型名），一律暗淡色；字段之间的横向间隔与框内边距都取自 theme。
 *
 * @module dsc-tui/app/StatusBar
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { StatusView } from '../contract.js'
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

export function StatusBar({ status }: { status: StatusView }): JSX.Element {
  return (
    <Box borderStyle="round" borderColor={BORDER.frame} paddingX={PAD.inline} gap={PAD.field}>
      <Text {...TEXT.label} color={TURN_COLOR[status.turnState]}>
        {status.turnState === 'idle' ? '●' : '◐'} {TURN_LABEL[status.turnState]}
      </Text>
      <Text {...TEXT.secondary}>模型 {status.model}</Text>
      <Text {...TEXT.secondary}>effort {status.effort ?? '-'}</Text>
      {status.usage !== null ? (
        <Text {...TEXT.secondary}>
          tok {status.usage.inputTokens}↑ {status.usage.outputTokens}↓
        </Text>
      ) : null}
      <Text {...TEXT.secondary}>
        {status.sessionId === null ? '未打开会话' : `会话 ${status.sessionId.slice(0, 8)}`}
      </Text>
    </Box>
  )
}
