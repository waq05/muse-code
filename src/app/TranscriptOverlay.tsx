/**
 * 回看浮层（Ctrl+O 打开）：全量 transcript 的滚动窗口，摆脱「直播窗只画尾部 30 条」
 * 的限制。复用 ChatView 的条目渲染（streaming 恒 false），滚动窗口由 App 按
 * 终端行数计算并路由按键（↑↓/j/k 单条、PgUp/PgDn 翻页），本组件纯展示。
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
  offset,
  visible,
}: {
  entries: TranscriptEntry[]
  /** 从尾部往回滚的条数：0 = 最新（窗口贴着末尾），越大越往历史翻。 */
  offset: number
  /** 窗口里最多几条（按终端行数算出来的近似值）。 */
  visible: number
}): JSX.Element {
  const maxOffset = Math.max(0, entries.length - visible)
  const back = Math.min(Math.max(0, offset), maxOffset)
  const start = Math.max(0, entries.length - visible - back)
  const window = entries.slice(start, start + visible)
  return (
    <Box
      borderStyle="round"
      borderColor={BORDER.active}
      paddingX={PAD.inline}
      flexDirection="column"
      flexGrow={1}
      gap={GAP.none}
    >
      <Text {...TEXT.label} color={ACCENT}>
        回看全文（{entries.length} 条 · 第 {start + 1}-{start + window.length} 条）
      </Text>
      {window.map((entry) => (
        <Entry key={entry.id} entry={entry} streaming={false} expandThinking={false} />
      ))}
      {window.length === 0 ? (
        <Box marginLeft={INDENT.detail}>
          <Text {...TEXT.secondary}>（这个会话还没有条目）</Text>
        </Box>
      ) : null}
      <Text {...TEXT.secondary}>
        ↑↓/j·k 滚动 · PgUp/PgDn 翻页 · q 或 Esc 或 Ctrl+O 关闭
      </Text>
    </Box>
  )
}
