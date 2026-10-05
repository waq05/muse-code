/**
 * 计划评审卡：exit_plan_mode 提交的计划等用户批。y 批准（批准后宿主自动切回执行
 * 模式开工）/ n（或 Esc）拒绝 / e 带反馈退回——App 收到 e 后把 Composer 临时切成
 * 反馈输入框，提交即把反馈原话捎给模型。计划全文超长折叠（只留前几行），v 或点击
 * 「… 共 N 行」标记行展开/收起；页脚按钮可鼠标点击（列区间与渲染同源计算）。
 * 键盘与鼠标路由在 App 顶层统一处理，本组件纯展示。
 *
 * @module dsc-tui/app/PlanReviewCard
 */
import { useRef } from 'react'
import { Box, Text } from 'ink'
import type { DOMElement } from 'ink'
import type { JSX } from 'react'
import type { PlanView } from '../contract.js'
import { ACCENT, BORDER, GAP, PAD, STATUS_COLOR, TEXT } from './theme.js'
import { absoluteLeft, displayWidth, useClickRegion, type RegisterClick } from './click.js'

/** 折叠时保留的正文行数。 */
const PREVIEW_LINES = 12

/** 页脚按钮的动作 id（App 派发成与按键等价的调用）。 */
export type PlanAction = 'approve' | 'reject' | 'feedback'

const BUTTONS: { id: PlanAction; hint: string; label: string; hintColor: string | undefined; labelDim: boolean }[] = [
  { id: 'approve', hint: '[y]', label: '批准开工', hintColor: STATUS_COLOR.done, labelDim: false },
  { id: 'reject', hint: '[n]', label: '拒绝', hintColor: STATUS_COLOR.failed, labelDim: false },
  { id: 'feedback', hint: '[e]', label: '带反馈退回', hintColor: ACCENT, labelDim: true },
]

export function PlanReviewCard({
  plan,
  expanded,
  feedbacking,
  onAction,
  registerClick,
}: {
  plan: PlanView
  expanded: boolean
  feedbacking: boolean
  /** 鼠标点中页脚按钮 / 折叠标记行时派发；缺省即无鼠标行为。 */
  onAction?: (action: PlanAction | 'toggle') => void
  registerClick?: RegisterClick
}): JSX.Element {
  const rootRef = useRef<DOMElement | null>(null)
  const lines = plan.text.split('\n')
  const folded = !expanded && lines.length > PREVIEW_LINES + 1
  const shown = folded ? lines.slice(0, PREVIEW_LINES) : lines

  let cursor = 0
  const spans = BUTTONS.map((button) => {
    const text = `${button.hint} ${button.label}`
    const from = cursor
    cursor += displayWidth(text) + 2
    return { id: button.id, from, to: from + displayWidth(text) }
  })

  useClickRegion(rootRef, registerClick, onAction === undefined ? undefined : (col, row, top, height) => {
    // 几何点击时现量：页脚在底边框上第一行（反馈输入态没有页脚）；
    // 折叠标记行在页脚之上（feedbacking 时就是最末内容行）。
    const footerRow = feedbacking ? null : top + height - 2
    const markerRow = folded ? top + height - 2 - (feedbacking ? 0 : 1) : null
    if (markerRow !== null && row === markerRow) {
      onAction('toggle')
      return true
    }
    if (footerRow === null || row !== footerRow) return false
    // 页边距/边框/padding 的列原点点击时现量（对根帧 paddingX 变化免疫）
    const contentCol = col - ((absoluteLeft(rootRef.current) ?? 0) + 1 + PAD.inline)
    const hit = spans.find((span) => contentCol >= span.from && contentCol < span.to)
    if (hit === undefined) return false
    onAction(hit.id)
    return true
  })

  return (
    <Box
      ref={rootRef}
      borderStyle="double"
      borderColor={BORDER.alert}
      paddingX={PAD.inline}
      flexDirection="column"
      marginTop={GAP.tight}
      gap={GAP.none}
    >
      <Text {...TEXT.label} color={BORDER.alert} wrap="truncate-end">
        ☐ 计划评审：{plan.title}
      </Text>
      <Text {...TEXT.secondary} wrap="truncate-end">计划文件：{plan.file}</Text>
      <Box flexDirection="column" gap={GAP.none}>
        {shown.map((line, position) => (
          <Text key={position} {...TEXT.body} wrap="truncate-end">
            {line === '' ? ' ' : line}
          </Text>
        ))}
      </Box>
      {folded ? (
        <Text {...TEXT.secondary}>… 共 {lines.length} 行，v 或点击本行展开/收起全文</Text>
      ) : null}
      {feedbacking ? (
        <Text {...TEXT.label} color={STATUS_COLOR.waiting}>
          带反馈退回：在下方输入框写反馈原话，Enter 提交，Esc 取消
        </Text>
      ) : (
        <Text>
          {BUTTONS.map((button, position) => (
            <Text key={button.id} {...(button.labelDim ? TEXT.secondary : TEXT.body)}>
              <Text {...TEXT.label} color={button.hintColor}>
                {position === 0 ? '' : '  '}
                {button.hint}
              </Text>
              <Text> {button.label}</Text>
            </Text>
          ))}
        </Text>
      )}
    </Box>
  )
}
