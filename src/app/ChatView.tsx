/**
 * 会话流：把 TranscriptEntry 序列渲染成终端块。只渲染尾部 N 条（回看走 Ctrl+O 浮层，
 * 见批次三；本组件保持「直播窗」定位）。
 *
 * 排版走 theme 的三档文字：助手回答与用户输入是正文（默认前景），思考正文与系统
 * 说明是次要信息（暗淡色），思考标题是状态标签（暗淡色 + 状态色）。条目之间贴排，
 * 纵向间距只在 `ChatView` 这一处声明。
 *
 * 过程节点如实显示：中断/失败的轮有轮尾标记、输出截断与模型重试各有自己的行、
 * 轮尾有「文件已更改」聚合、计划卡带批准状态、插话带 ↩ 徽标、压缩落点画分隔线——
 * 失败轮和成功轮在终端里不再长得一样。
 *
 * @module dsc-tui/app/ChatView
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { TranscriptEntry } from '../contract.js'
import { ToolCard } from './ToolCard.js'
import { ACCENT, DIFF_COLOR, GAP, INDENT, STATUS_COLOR, TEXT } from './theme.js'

/** 尾部渲染窗口：防止长会话每帧 reconcile 过多节点。 */
const TAIL = 30

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 文件路径的末段（显示用）。 */
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** 压缩落点的分隔线（system 通知与重放摘要共用一条样式）。 */
function CompactionRule({ count }: { count: number }): JSX.Element {
  return (
    <Text {...TEXT.label} color={ACCENT}>
      ⎯ 已压缩历史 · 第 {count} 次 ⎯
    </Text>
  )
}

/** 单条条目的渲染（回看浮层复用同一份，直播光标由 streaming 控制）。 */
export function Entry({
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
        <Box flexDirection="column" gap={GAP.none}>
          {entry.compaction !== undefined ? <CompactionRule count={entry.compaction.count} /> : null}
          <Box>
            <Text {...TEXT.label}>
              ❯{entry.steering === true ? ' ↩' : ''}{' '}
            </Text>
            <Text {...TEXT.body}>{entry.text}</Text>
          </Box>
          {entry.images !== undefined && entry.images.length > 0 ? (
            <Box marginLeft={INDENT.detail}>
              <Text {...TEXT.secondary}>🖼 {entry.images.length} 张图片</Text>
            </Box>
          ) : null}
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
    case 'plan': {
      const state =
        entry.plan.decision === 'approved'
          ? { text: '已批准', color: STATUS_COLOR.done }
          : entry.plan.decision === 'rejected'
            ? { text: '未批准', color: STATUS_COLOR.failed }
            : { text: '待评审', color: STATUS_COLOR.waiting }
      return (
        <Box flexDirection="column" marginLeft={INDENT.tool} gap={GAP.none}>
          <Text>
            <Text {...TEXT.secondary}>📋 计划 </Text>
            <Text {...TEXT.body}>{oneLine(entry.plan.title, 60)}</Text>
            <Text {...TEXT.label} color={state.color}>
              {' '}
              · {state.text}
            </Text>
          </Text>
          <Box marginLeft={INDENT.detail}>
            <Text {...TEXT.secondary}>{entry.plan.file}</Text>
          </Box>
        </Box>
      )
    }
    case 'system':
      return (
        <Box flexDirection="column" gap={GAP.none}>
          {entry.compaction !== undefined ? <CompactionRule count={entry.compaction.count} /> : null}
          <Text {...TEXT.secondary}>ⓘ {entry.text}</Text>
        </Box>
      )
    case 'turn-end':
      return (
        <Text {...TEXT.label} color={entry.reason === 'error' ? STATUS_COLOR.failed : STATUS_COLOR.waiting}>
          {entry.reason === 'error' ? '✗ 过程失败' : '⏹ 已停止'}
        </Text>
      )
    case 'turn-max-tokens':
      return (
        <Text {...TEXT.label} color={STATUS_COLOR.waiting}>
          ⚠ 输出达到长度上限，本轮被截断
        </Text>
      )
    case 'model-retry':
      return (
        <Text {...TEXT.secondary}>
          ↻ 第 {entry.attempt} 次重试：{oneLine(entry.text, 120)}
        </Text>
      )
    case 'changes':
      return (
        <Text {...TEXT.secondary}>
          ✎ {baseName(entry.file.path)}{' '}
          <Text color={DIFF_COLOR.add}>+{entry.file.added}</Text>{' '}
          <Text color={DIFF_COLOR.del}>−{entry.file.removed}</Text>
        </Text>
      )
    case 'turnDiff': {
      const added = entry.files.reduce((sum, file) => sum + file.added, 0)
      const removed = entry.files.reduce((sum, file) => sum + file.removed, 0)
      const names = entry.files
        .slice(0, 3)
        .map((file) => baseName(file.path))
        .join('、')
      return (
        <Text {...TEXT.label}>
          ✎ 本轮改动 {entry.files.length} 个文件（+{added} −{removed}）
          {names !== '' ? `：${names}${entry.files.length > 3 ? '…' : ''}` : ''}
        </Text>
      )
    }
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
          <Text {...TEXT.secondary}>输入消息开始对话；/help 查看命令，Esc 打断回合，Ctrl+O 回看全文。</Text>
        </Box>
      ) : null}
    </Box>
  )
}
