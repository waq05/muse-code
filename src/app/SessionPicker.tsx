/**
 * 会话选择器（/resume / Ctrl+P? 不，入口就是 /resume）：升级版。
 *
 * 展示全量列表（置顶优先、按最近更新排序、输入即筛选——筛选与排序在 App 侧算好），
 * 行内带标题、置顶标、后台状态点；Tab 切「活动 / 归档」两页；动作键全部走 Ctrl 组合
 * （普通字符留给筛选输入）：Ctrl+R 改名、Ctrl+P 置顶、Ctrl+A 归档、Ctrl+U 恢复、
 * Ctrl+X 删除（再按一次确认，进回收站）、Ctrl+F 按最后一条用户消息分叉。
 * 键盘路由在 App 顶层统一处理，本组件纯展示。
 *
 * @module dsc-tui/app/SessionPicker
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { SessionRunState, SessionSummary } from '../contract.js'
import { ACCENT, BORDER, GAP, MARK, PAD, SEP, STATUS_COLOR, TEXT } from './theme.js'

const shortDate = (createdAt: number): string => {
  const date = new Date(createdAt)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 后台状态点的形状与颜色（与 StatusBar 同一套语义）。 */
const STATE_DOT: Record<SessionRunState, { mark: string; color: string | undefined }> = {
  working: { mark: '◐', color: STATUS_COLOR.pending },
  'awaiting-approval': { mark: '⚠', color: STATUS_COLOR.waiting },
  'just-finished': { mark: '✓', color: STATUS_COLOR.done },
}

/** 键盘路由（↑↓/Enter/Esc/Ctrl+* 与筛选输入）在 App 顶层统一处理，本组件纯展示。 */
export interface SessionPickerProps {
  sessions: SessionSummary[]
  loading: boolean
  index: number
  onIndex: (index: number) => void
  /** 当前页：active = 活动区，archived = 归档区（Tab 切换）。 */
  page: 'active' | 'archived'
  /** 筛选词（输入即筛选）。 */
  query: string
  /** 改名模式下的输入缓冲（非空时输入行走改名态）。 */
  buffer: string | null
  /** Ctrl+X 已按过一次（等待确认删除）。 */
  armed: boolean
  /** 跨会话运行状态（状态点数据源）。 */
  sessionStates: Record<string, SessionRunState>
}

export function SessionPicker({
  sessions,
  loading,
  index,
  onIndex,
  page,
  query,
  buffer,
  armed,
  sessionStates,
}: SessionPickerProps): JSX.Element {
  const safeIndex = Math.min(index, Math.max(0, sessions.length - 1))
  return (
    <Box
      borderStyle="round"
      borderColor={BORDER.active}
      paddingX={PAD.inline}
      flexDirection="column"
      marginTop={GAP.tight}
      gap={GAP.none}
    >
      <Text {...TEXT.label} color={ACCENT}>
        {page === 'active' ? '恢复会话' : '归档会话'}
        {loading ? '（读取中…）' : `（${sessions.length} 条）`}
        <Text {...TEXT.secondary}>{SEP.gap}Tab 切{page === 'active' ? '归档' : '活动'}页</Text>
      </Text>
      <Text>
        <Text {...TEXT.label} color={ACCENT}>
          筛选{' '}
        </Text>
        <Text {...(query === '' ? TEXT.secondary : TEXT.body)}>
          {query === '' ? '（直接输入按标题/目录/id 过滤）' : query}
          {buffer === null ? <Text {...TEXT.secondary}>▏</Text> : null}
        </Text>
      </Text>
      {buffer !== null ? (
        <Text {...TEXT.label} color={STATUS_COLOR.waiting}>
          改名：{buffer}▏（Enter 确认 · Esc 取消）
        </Text>
      ) : null}
      {sessions.length === 0 && !loading ? (
        <Text {...TEXT.secondary}>（没有匹配的会话）</Text>
      ) : null}
      {sessions.map((session, position) => {
        // v2 的 id 是 jsonl 文件路径；展示取文件名前 8 位
        const shortId = (session.id.split(/[\\/]/).pop() ?? session.id)
          .replace(/\.jsonl$/, '')
          .slice(0, 8)
        const selected = position === safeIndex
        const state = sessionStates[session.id]
        const dot = state !== undefined ? STATE_DOT[state] : undefined
        return (
          <Box key={session.id}>
            <Text {...TEXT.label} color={selected ? ACCENT : undefined}>
              {selected ? MARK.selected : MARK.idle}
            </Text>
            {session.pinnedAt !== undefined ? (
              <Text {...TEXT.label} color={STATUS_COLOR.waiting}>
                ★{' '}
              </Text>
            ) : null}
            <Text {...TEXT.secondary}>{shortDate(session.createdAt)}</Text>
            <Text {...TEXT.body} color={selected ? ACCENT : undefined} wrap="truncate-end">
              {SEP.gap}
              {session.title ?? (session.cwd || '(无目录)')}
            </Text>
            {dot !== undefined ? (
              <Text {...TEXT.label} color={dot.color}>
                {SEP.gap}
                {dot.mark}
              </Text>
            ) : null}
            <Text {...TEXT.secondary}>
              {SEP.gap}
              {shortId}
            </Text>
          </Box>
        )
      })}
      {buffer !== null ? null : (
        <Text {...TEXT.secondary}>
          ↑↓ 选择 · Enter 打开 · Ctrl+R 改名 · Ctrl+P 置顶
          {page === 'active' ? ' · Ctrl+A 归档' : ' · Ctrl+U 恢复'}
          {' · '}Ctrl+F 分叉{armed ? '' : ' · Ctrl+X 删除（再按一次确认）'}
          {armed ? <Text {...TEXT.label} color={STATUS_COLOR.failed}> · 再按一次 Ctrl+X 确认永久删除</Text> : null}
          {' · '}Esc 关闭
        </Text>
      )}
    </Box>
  )
}
