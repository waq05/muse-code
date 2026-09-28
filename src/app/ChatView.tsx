/**
 * 会话流：把 TranscriptEntry 序列渲染成终端块。只渲染尾部 N 条（MVP 无滚动回看）。
 * @module dsc-tui/app/ChatView
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { TranscriptEntry } from '../contract.js'
import { ToolCard } from './ToolCard.js'

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
  const cursor = streaming ? <Text color="cyan"> ▌</Text> : null
  switch (entry.kind) {
    case 'user':
      return (
        <Box marginY={0}>
          <Text color="blue" bold>
            ❯{' '}
          </Text>
          <Text>{entry.text}</Text>
        </Box>
      )
    case 'thinking': {
      if (expandThinking) {
        return (
          <Box flexDirection="column" marginY={0}>
            <Text color="magenta" dimColor>
              💭 思考
            </Text>
            <Text color="gray" dimColor>
              {entry.text}
            </Text>
          </Box>
        )
      }
      return (
        <Box marginY={0}>
          <Text color="magenta" dimColor>
            💭 思考（ctrl+t 展开）：{oneLine(entry.text, 100)}
          </Text>
        </Box>
      )
    }
    case 'text':
      return (
        <Box marginY={0}>
          <Text>
            {entry.text}
            {cursor}
          </Text>
        </Box>
      )
    case 'tool':
      return <ToolCard call={entry.call} />
    case 'system':
      return (
        <Box marginY={0}>
          <Text color="yellow" dimColor>
            ⓘ {entry.text}
          </Text>
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
    <Box flexDirection="column" flexGrow={1}>
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
        <Box>
          <Text dimColor> 输入消息开始对话；/help 查看命令，Ctrl+C 两次退出。</Text>
        </Box>
      ) : null}
    </Box>
  )
}
