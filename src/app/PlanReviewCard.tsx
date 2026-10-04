/**
 * 计划评审卡：exit_plan_mode 提交的计划等用户批（键盘路由在 App 顶层，本组件纯展示）。
 *
 * y 批准（批准后宿主自动切回执行模式开工）/ n（或 Esc）拒绝 / e 带反馈退回——
 * App 收到 e 后把 Composer 临时切成反馈输入框，提交即把反馈原话捎给模型。
 * 计划全文超长折叠（只留前几行），v 展开/收起全文。
 *
 * @module dsc-tui/app/PlanReviewCard
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { PlanView } from '../contract.js'
import { ACCENT, BORDER, GAP, PAD, STATUS_COLOR, TEXT } from './theme.js'

/** 折叠时保留的正文行数。 */
const PREVIEW_LINES = 12

export function PlanReviewCard({
  plan,
  expanded,
  feedbacking,
}: {
  plan: PlanView
  expanded: boolean
  feedbacking: boolean
}): JSX.Element {
  const lines = plan.text.split('\n')
  const folded = !expanded && lines.length > PREVIEW_LINES + 1
  const shown = folded ? lines.slice(0, PREVIEW_LINES) : lines
  return (
    <Box
      borderStyle="double"
      borderColor={BORDER.alert}
      paddingX={PAD.inline}
      flexDirection="column"
      marginTop={GAP.tight}
      gap={GAP.none}
    >
      <Text {...TEXT.label} color={BORDER.alert}>
        ☐ 计划评审：{plan.title}
      </Text>
      <Text {...TEXT.secondary}>计划文件：{plan.file}</Text>
      <Box flexDirection="column" gap={GAP.none}>
        {shown.map((line, position) => (
          <Text key={position} {...TEXT.body}>
            {line === '' ? ' ' : line}
          </Text>
        ))}
      </Box>
      {folded ? (
        <Text {...TEXT.secondary}>… 共 {lines.length} 行，v 展开/收起全文</Text>
      ) : null}
      {feedbacking ? (
        <Text {...TEXT.label} color={STATUS_COLOR.waiting}>
          带反馈退回：在下方输入框写反馈原话，Enter 提交，Esc 取消
        </Text>
      ) : (
        <Text>
          <Text {...TEXT.label} color={STATUS_COLOR.done}>
            [y]
          </Text>
          <Text {...TEXT.body}> 批准开工 </Text>
          <Text {...TEXT.label} color={STATUS_COLOR.failed}>
            [n]
          </Text>
          <Text {...TEXT.body}> 拒绝 </Text>
          <Text {...TEXT.label} color={ACCENT}>
            [e]
          </Text>
          <Text {...TEXT.secondary}> 带反馈退回</Text>
        </Text>
      )}
    </Box>
  )
}
