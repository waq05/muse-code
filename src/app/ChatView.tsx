/**
 * 会话流：把 TranscriptEntry 序列渲染成终端块。只渲染尾部 N 条（MVP 无滚动回看）。
 *
 * 排版走 theme 的三档文字：助手回答与用户输入是正文（默认前景），思考正文与系统
 * 说明是次要信息（暗淡色），思考标题是状态标签（暗淡色 + 状态色）。条目之间贴排，
 * 纵向间距只在 `ChatView` 这一处声明。
 *
 * @module dsc-tui/app/ChatView
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { TranscriptEntry } from '../contract.js'
import { ToolCard } from './ToolCard.js'
import { ACCENT, GAP, INDENT, STATUS_COLOR, TEXT } from './theme.js'

/** 尾部渲染窗口：防止长会话每帧 reconcile 过多节点。 */
const TAIL = 30

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function Entry({
  entry,
  streaming,
  expandThinking,
}: {
  entry: TranscriptEntry
  streaming: boolean
  expandThinking: boolean
}): JSX.Element | null {
  const cursor = streaming ? <Text color={ACCENT}> ▌</Text> : null
  switch (entry.kind) {
    case 'user':
      return (
        <Box>
          <Text {...TEXT.label}>❯ </Text>
          <Text {...TEXT.body}>{entry.text}</Text>
        </Box>
      )
    case 'thinking': {
      if (expandThinking) {
        return (
          <Box flexDirection="column" gap={GAP.none}>
            <Text {...TEXT.label} color={STATUS_COLOR.pending}>
              💭 思考中
            </Text>
            <Box marginLeft={INDENT.detail}>
              <Text {...TEXT.secondary}>{entry.text}</Text>
            </Box>
          </Box>
        )
      }
      return (
        <Box>
          <Text {...TEXT.label} color={STATUS_COLOR.pending}>
            💭 思考中（ctrl+t 展开）：
          </Text>
          <Text {...TEXT.secondary}>{oneLine(entry.text, 100)}</Text>
        </Box>
      )
    }
    case 'text':
      return (
        <Box>
          <Text {...TEXT.body}>
            {entry.text}
            {cursor}
          </Text>
        </Box>
      )
    case 'tool':
      return <ToolCard call={entry.call} />
    case 'system':
      return (
        <Box>
          <Text {...TEXT.secondary}>ⓘ {entry.text}</Text>
        </Box>
      )
    default:
      return null
  }
}

export function ChatView({
  entries,
  turnState,
  expandThinking,
}: {
  entries: TranscriptEntry[]
  turnState: 'idle' | 'thinking' | 'working' | 'awaiting-approval'
  expandThinking: boolean
}): JSX.Element {
  const tail = entries.slice(-TAIL)
  // 直播尾（负 id）与最后定稿 text 条目才带光标闪烁位。
  const lastId = tail[tail.length - 1]?.id
  return (
    <Box flexDirection="column" flexGrow={1} gap={GAP.none}>
      {tail.map((entry) => (
        <Entry
          key={entry.id}
          entry={entry}
          streaming={
            entry.id === lastId &&
            entry.id < 0 &&
            (turnState === 'thinking' || turnState === 'working')
          }
          expandThinking={expandThinking}
        />
      ))}
      {tail.length === 0 ? (
        <Box marginLeft={INDENT.detail}>
          <Text {...TEXT.secondary}>输入消息开始对话；/help 查看命令，Ctrl+C 两次退出。</Text>
        </Box>
      ) : null}
    </Box>
  )
}
