/**
 * 审批卡：workspace-write + ask 模式下的工具授权弹卡（y 允许一次 / n 拒绝）。
 * @module dsc-tui/app/ApprovalCard
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { ApprovalRequestView } from '../contract.js'

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

export function ApprovalCard({ request }: { request: ApprovalRequestView }): JSX.Element {
  return (
    <Box borderStyle="double" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text color="yellow" bold>
        ⚠ 工具授权：{request.toolName}
      </Text>
      <Text>{oneLine(request.argsSummary, 200)}</Text>
      <Text>
        <Text color="green" bold>
          [y]
        </Text>
        <Text> 允许一次 </Text>
        <Text color="red" bold>
          [n]
        </Text>
        <Text dimColor> 拒绝</Text>
      </Text>
    </Box>
  )
}
