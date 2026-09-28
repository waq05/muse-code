/**
 * 审批卡：workspace-write + ask 模式下的工具授权弹卡（y 允许一次 / n 拒绝）。
 *
 * 排版：参数摘要属次要信息（暗淡色），按键与状态词属状态标签（暗淡色 + 状态色），
 * 与上下文的分隔间距取自 `GAP.tight`。
 *
 * @module dsc-tui/app/ApprovalCard
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { ApprovalRequestView } from '../contract.js'
import { BORDER, GAP, PAD, STATUS_COLOR, TEXT } from './theme.js'

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

export function ApprovalCard({ request }: { request: ApprovalRequestView }): JSX.Element {
  return (
    <Box
      borderStyle="double"
      borderColor={BORDER.alert}
      paddingX={PAD.inline}
      flexDirection="column"
      marginTop={GAP.tight}
      gap={GAP.none}
    >
      <Text {...TEXT.label} color={BORDER.alert}>
        ⚠ 工具授权：{request.toolName}
      </Text>
      <Text {...TEXT.secondary}>{oneLine(request.argsSummary, 200)}</Text>
      <Text>
        <Text {...TEXT.label} color={STATUS_COLOR.done}>
          [y]
        </Text>
        <Text {...TEXT.body}> 允许一次 </Text>
        <Text {...TEXT.label} color={STATUS_COLOR.failed}>
          [n]
        </Text>
        <Text {...TEXT.secondary}> 拒绝</Text>
      </Text>
    </Box>
  )
}
