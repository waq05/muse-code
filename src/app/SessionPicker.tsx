/**
 * 会话选择器：/resume 打开，↑↓ 选择，Enter 恢复，Esc 取消。
 * （MVP 不显示标题——persistence 快照 header 无 title 字段。）
 * @module dsc-tui/app/SessionPicker
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { SessionSummary } from '../contract.js'

const LIST_LIMIT = 12

const shortDate = (createdAt: number): string => {
  const date = new Date(createdAt)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 键盘路由（↑↓/Enter/Esc）在 App 顶层统一处理，本组件纯展示。 */
export interface SessionPickerProps {
  sessions: SessionSummary[]
  loading: boolean
  index: number
  onIndex: (index: number) => void
}

export function SessionPicker({ sessions, loading, index, onIndex }: SessionPickerProps): JSX.Element {
  const list = sessions.slice(0, LIST_LIMIT)
  const safeIndex = Math.min(index, Math.max(0, list.length - 1))
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold color="cyan">
        恢复会话 {loading ? '（读取中…）' : `（${list.length} 条）`}
      </Text>
      {list.length === 0 && !loading ? <Text dimColor>（没有历史会话）</Text> : null}
      {list.map((session, position) => {
        // v2 的 id 是 jsonl 文件路径；展示取文件名前 8 位
        const shortId = (session.id.split(/[\\/]/).pop() ?? session.id).replace(/\.jsonl$/, '').slice(0, 8)
        return (
          <Text key={session.id} color={position === safeIndex ? 'cyan' : undefined} bold={position === safeIndex}>
            {position === safeIndex ? '❯ ' : '  '}
            {shortDate(session.createdAt)}  {session.cwd || '(无目录)'}  {shortId}
          </Text>
        )
      })}
      <Text dimColor>↑↓ 选择 · Enter 恢复 · Esc 取消</Text>
    </Box>
  )
}
