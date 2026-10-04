/**
 * 回看浮层（Ctrl+O 打开）：全量 transcript 的滚动窗口，摆脱「直播窗只画尾部 30 条」
 * 的限制。复用 ChatView 的条目渲染（streaming 恒 false）；窗口切片与滚动偏移由
 * App 按「条」计算并路由按键（↑↓/j·k 单条、PgUp/PgDn 翻页、滚轮同义）。根盒在
 * 恒定帧里撑满、底对齐、溢出从顶上裁掉——只丢历史不丢最新。本组件纯展示。
 *
 * @module dsc-tui/app/TranscriptOverlay
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { TranscriptEntry } from '../contract.js'
import { ACCENT, BORDER, GAP, INDENT, PAD, TEXT } from './theme.js'
import { Entry } from './ChatView.js'

export function TranscriptOverlay({
  entries,
  start,
  total,
  title,
}: {
  /** 可见窗口切片（App 按滚动偏移算好传入）。 */
  entries: TranscriptEntry[]
  /** 窗口第一条在全量 transcript 里的下标（标题展示用）。 */
  start: number
  /** 全量条数。 */
  total: number
  /** 标题（省略 = 本会话回看；子代理转录复用同一浮层时传它的名字）。 */
  title?: string
}): JSX.Element {
  return (
    <Box
      borderStyle="round"
      borderColor={BORDER.active}
      paddingX={PAD.inline}
      flexDirection="column"
      flexGrow={1}
      overflowY="hidden"
      justifyContent="flex-end"
      gap={GAP.none}
    >
      <Box flexShrink={0} flexDirection="column" gap={GAP.none}>
        <Text {...TEXT.label} color={ACCENT} wrap="truncate-end">
          {title === undefined
            ? `回看全文（共 ${total} 条 · 第 ${start + 1}-${start + entries.length} 条）`
            : `${title} · ${total} 条`}
        </Text>
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} streaming={false} expandThinking={false} />
        ))}
        {entries.length === 0 ? (
          <Box marginLeft={INDENT.detail}>
            <Text {...TEXT.secondary}>（这个会话还没有条目）</Text>
          </Box>
        ) : null}
        <Text {...TEXT.secondary} wrap="truncate-end">
          ↑↓/j·k 单条 · PgUp/PgDn 翻页 · 滚轮同义 · q 或 Esc 或 Ctrl+O 关闭
        </Text>
      </Box>
    </Box>
  )
}
