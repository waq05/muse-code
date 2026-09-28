/**
 * 工具调用卡片：名称 + 状态 + 参数摘要 +（完成后的）结果摘要。
 * @module dsc-tui/app/ToolCard
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { ToolCallView } from '../contract.js'

const STATUS: Record<ToolCallView['status'], { icon: string; color: string }> = {
  running: { icon: '◐ 运行中', color: 'cyan' },
  done: { icon: '✓ 完成', color: 'green' },
  failed: { icon: '✗ 失败', color: 'red' },
  rejected: { icon: '⊘ 已拒绝', color: 'red' },
}

/** 单行化并截断。 */
const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

export function ToolCard({ call }: { call: ToolCallView }): JSX.Element {
  const status = STATUS[call.status]
  return (
    <Box borderStyle="single" borderColor={call.status === 'running' ? 'cyan' : 'gray'} paddingX={1} marginY={0}>
      <Box flexDirection="column" width="100%">
        <Text>
          <Text bold color="magenta">
            ⚙ {call.name}
          </Text>
          <Text>  </Text>
          <Text color={status.color}>{status.icon}</Text>
        </Text>
        {call.argsText !== '' ? <Text dimColor>⌨ {oneLine(call.argsText, 120)}</Text> : null}
        {call.resultText !== undefined && call.resultText !== '' ? (
          <Text color={call.status === 'failed' ? 'red' : 'gray'}>↳ {oneLine(call.resultText, 200)}</Text>
        ) : null}
      </Box>
    </Box>
  )
}
