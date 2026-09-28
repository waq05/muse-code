/**
 * 底部状态行：模型 / effort / 回合状态 / token / 会话。
 * @module dsc-tui/app/StatusBar
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { StatusView } from '../contract.js'

const TURN_LABEL: Record<StatusView['turnState'], string> = {
  idle: '空闲',
  thinking: '思考中',
  working: '执行中',
  'awaiting-approval': '等待审批',
}

const TURN_COLOR: Record<StatusView['turnState'], string> = {
  idle: 'gray',
  thinking: 'cyan',
  working: 'green',
  'awaiting-approval': 'yellow',
}

export function StatusBar({ status }: { status: StatusView }): JSX.Element {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} gap={2}>
      <Text color={TURN_COLOR[status.turnState]} bold>
        {status.turnState === 'idle' ? '●' : '◐'} {TURN_LABEL[status.turnState]}
      </Text>
      <Text dimColor>模型 {status.model}</Text>
      <Text dimColor>effort {status.effort ?? '-'}</Text>
      {status.usage !== null ? (
        <Text dimColor>
          tok {status.usage.inputTokens}↑ {status.usage.outputTokens}↓
        </Text>
      ) : null}
      <Text dimColor>
        {status.sessionId === null ? '未打开会话' : `会话 ${status.sessionId.slice(0, 8)}`}
      </Text>
    </Box>
  )
}
