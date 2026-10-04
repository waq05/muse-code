/**
 * 常驻任务条：目标条与任务清单条（会话流之下、弹卡之上，输入框一眼能看见的地方）。
 *
 * 纯展示——操作走 /goal 与 /todo 命令（单行命令在终端里比隐藏热键更可发现）。
 * 没有目标/任务时不占任何行。
 *
 * @module dsc-tui/app/TaskStrips
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { GoalView, TodoView } from '../contract.js'
import { GAP, STATUS_COLOR, TEXT } from './theme.js'

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 目标阶段词与颜色。 */
const GOAL_PHASE: Record<GoalView['phase'], { text: string; color: string | undefined }> = {
  active: { text: '进行中', color: STATUS_COLOR.pending },
  paused: { text: '已暂停', color: undefined },
  blocked: { text: '受阻', color: STATUS_COLOR.failed },
  complete: { text: '已完成', color: STATUS_COLOR.done },
}

export function GoalStrip({ goal }: { goal: GoalView }): JSX.Element {
  const phase = GOAL_PHASE[goal.phase]
  return (
    <Text {...TEXT.label} color={phase.color}>
      ◎ 目标 {oneLine(goal.objective, 60)} · {phase.text} · 第 {goal.rounds}/{goal.maxRounds} 轮
      {goal.phase === 'blocked' && goal.blockedReason !== undefined
        ? ` · ${oneLine(goal.blockedReason, 40)}`
        : ''}
      （/goal 管理）
    </Text>
  )
}

export function TodoStrip({ todos }: { todos: TodoView }): JSX.Element | null {
  if (todos.total === 0) return null
  const allDone = todos.done >= todos.total
  return (
    <Text {...TEXT.label} color={allDone ? STATUS_COLOR.done : undefined}>
      ☑ {todos.done}/{todos.total}
      {todos.active !== null ? ` · 当前：${oneLine(todos.active, 60)}` : ''}
      （/todo 看全部）
    </Text>
  )
}

/** 两条一起排（间距在这里一处声明）。 */
export function TaskStrips({ goal, todos }: { goal: GoalView | null; todos: TodoView }): JSX.Element | null {
  if (goal === null && todos.total === 0) return null
  return (
    <Box flexDirection="column" gap={GAP.none}>
      {goal !== null ? <GoalStrip goal={goal} /> : null}
      <TodoStrip todos={todos} />
    </Box>
  )
}
