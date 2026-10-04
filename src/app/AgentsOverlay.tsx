/**
 * 子代理总览浮层（0.6.57，/agents 打开）：两段名单——智能体团队的队友在前
 * （名字 · 状态 · 派的任务），后台会话在后（常驻 agent 与干着活的队友会话，
 * 状态芯片同款）。选中行 Enter / 再点一次进入它的转录浮层（只读 peek）。
 *
 * 整屏浮层与 SessionPicker 同款几何：恒定帧里 flexGrow 撑满、列表行与屏幕行
 * 一一对应（点击行号 1:1 映射），溢出从顶上裁掉。纯展示。
 *
 * @module dsc-tui/app/AgentsOverlay
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { RuntimeSnapshot, TeammateView } from '../contract.js'
import { BORDER, GAP, MARK, PAD, STATUS_COLOR, TEXT } from './theme.js'

/** 队友状态的词与颜色。 */
const TEAM_STATE: Record<TeammateView['state'], { text: string; color: string | undefined }> = {
  working: { text: '工作中', color: STATUS_COLOR.pending },
  idle: { text: '待命', color: STATUS_COLOR.done },
  stopped: { text: '已停止', color: undefined },
  failed: { text: '出错', color: STATUS_COLOR.failed },
}

/** 后台会话状态点的形状与颜色（与 StatusBar 同源；不互相 import 保持浮层自洽）。 */
const BACKGROUND_DOT: Record<RuntimeSnapshot['sessionStates'][string], { mark: string; color: string | undefined }> = {
  working: { mark: '◐', color: STATUS_COLOR.pending },
  'awaiting-approval': { mark: '⚠', color: STATUS_COLOR.waiting },
  'just-finished': { mark: '✓', color: STATUS_COLOR.done },
}

/** 会话 jsonl 路径的短标识（文件名去后缀取前 8 位）。 */
const shortId = (sessionPath: string): string =>
  (sessionPath.split(/[\\/]/).pop() ?? sessionPath).replace(/\.jsonl$/, '').slice(0, 8)

export interface AgentRow {
  kind: 'teammate' | 'session'
  /** teammate 名 / 会话 jsonl 路径（打开转录的钥匙）。 */
  key: string
  file: string
  title: string
  detail: string
  stateText: string
  stateColor: string | undefined
}

/** 名单装配（App 与测试共用同一条规则，避免两处漂移）。 */
export function buildAgentRows(
  teammates: TeammateView[],
  sessionStates: RuntimeSnapshot['sessionStates'],
): AgentRow[] {
  const rows: AgentRow[] = teammates.map((mate) => {
    const state = TEAM_STATE[mate.state]
    return {
      kind: 'teammate',
      key: mate.name,
      file: mate.file,
      title: `${mate.name}（${mate.role}）`,
      detail: mate.task === '' ? `第 ${mate.rounds} 轮` : `${mate.task} · 第 ${mate.rounds} 轮`,
      stateText: state.text,
      stateColor: state.color,
    }
  })
  for (const [sessionPath, state] of Object.entries(sessionStates)) {
    const dot = BACKGROUND_DOT[state]
    rows.push({
      kind: 'session',
      key: sessionPath,
      file: sessionPath,
      title: shortId(sessionPath),
      detail: '后台会话',
      stateText: state,
      stateColor: dot.color,
    })
  }
  return rows
}

export function AgentsOverlay({
  rows,
  index,
}: {
  rows: AgentRow[]
  index: number
}): JSX.Element {
  const safeIndex = Math.max(0, Math.min(index, rows.length - 1))
  return (
    <Box
      borderStyle="round"
      borderColor={BORDER.active}
      paddingX={PAD.inline}
      flexDirection="column"
      flexGrow={1}
      overflowY="hidden"
      gap={GAP.none}
    >
      <Box flexShrink={0} flexDirection="column" gap={GAP.none}>
        <Text {...TEXT.label} color={STATUS_COLOR.pending} wrap="truncate-end">
          子代理与后台会话（{rows.length} 个）
        </Text>
        {rows.length === 0 ? (
          <Text {...TEXT.secondary} wrap="truncate-end">
            当前没有在跑的子代理；派活（智能体团队 / subagent 工具）之后这里能看到它们。
          </Text>
        ) : null}
        {rows.map((row, position) => {
          const selected = position === safeIndex
          return (
            <Text key={`${row.kind}:${row.key}`} wrap="truncate-end">
              <Text color={selected ? STATUS_COLOR.pending : undefined}>{selected ? MARK.selected : MARK.idle}</Text>
              <Text {...TEXT.body}>{row.title}</Text>
              <Text {...TEXT.label} color={row.stateColor}>
                {' '}
                · {row.stateText}
              </Text>
              <Text {...TEXT.secondary}> {row.detail}</Text>
            </Text>
          )
        })}
        <Text {...TEXT.secondary} wrap="truncate-end">
          Enter 或点击查看转录 · Esc 关闭
        </Text>
      </Box>
    </Box>
  )
}
