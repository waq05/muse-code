/**
 * 工具行：折叠态就是会话流里的一行平铺文字（名称 + 参数摘要 + 状态），
 * 结果摘要作为展开块缩两格、走暗淡色；不给整行套描边框，一屏能多放下几条。
 *
 * @module dsc-tui/app/ToolCard
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { ToolCallView } from '../contract.js'
import { GAP, INDENT, SEP, STATUS_COLOR, TEXT } from './theme.js'

/** 状态标签：中文硬编码，配色只取 `STATUS_COLOR` 里的状态色。 */
const STATUS_LABEL: Record<ToolCallView['status'], { text: string; color: string | undefined }> = {
  // 模型吐了工具名、参数还没到齐（对照 dsh 的 preparing 阶段）：与「执行中」同色，
  // 但它只是「接下来要干这件事」，参数与结果都还没有。
  preparing: { text: '◌ 准备中', color: STATUS_COLOR.pending },
  running: { text: '◐ 执行中', color: STATUS_COLOR.pending },
  done: { text: '✓ 完成', color: STATUS_COLOR.done },
  failed: { text: '✗ 失败', color: STATUS_COLOR.failed },
  rejected: { text: '⊘ 已拒绝', color: STATUS_COLOR.failed },
}

/** 参数摘要截断宽度：留出名称与状态的位置，让一行不被挤到换行。 */
const ARG_PREVIEW_LIMIT = 80
/** 结果摘要截断宽度。 */
const RESULT_PREVIEW_LIMIT = 200

/** 单行化并截断。 */
const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

export function ToolCard({ call }: { call: ToolCallView }): JSX.Element {
  const status = STATUS_LABEL[call.status]
  return (
    <Box flexDirection="column" marginLeft={INDENT.tool} gap={GAP.none}>
      <Box>
        <Box flexShrink={0}>
          <Text {...TEXT.secondary}>⚙ {call.name}</Text>
        </Box>
        {call.argsText !== '' ? (
          <Box minWidth={0}>
            <Text {...TEXT.secondary} wrap="truncate-end">
              {SEP.dot}
              {oneLine(call.argsText, ARG_PREVIEW_LIMIT)}
            </Text>
          </Box>
        ) : null}
        <Box flexShrink={0}>
          <Text {...TEXT.label} color={status.color}>
            {SEP.dot}
            {status.text}
          </Text>
        </Box>
      </Box>
      {call.resultText !== undefined && call.resultText !== '' ? (
        <Box marginLeft={INDENT.detail}>
          <Text {...TEXT.secondary}>↳ {oneLine(call.resultText, RESULT_PREVIEW_LIMIT)}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
