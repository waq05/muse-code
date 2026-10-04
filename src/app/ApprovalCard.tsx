/**
 * 审批卡：工具授权弹卡。四档应答——y 允许一次 / a 本会话允许 / p 永久允许 / n（或
 * Esc）拒绝；按键只渲染 request.scopes 允许的档位，命中硬地板（hardline）只留拒绝。
 * 页脚按钮可鼠标点击（列区间按显示宽度与渲染同源计算，命中即等价按键）。
 *
 * 卡上补全宿主随请求带来的富信息：reason（为何要问）、risk 风险档、当前权限/协作
 * 模式、后台会话来源，write/edit 的「将做的改动」内嵌 diff（超长折叠，v 展开/收起）。
 * 键盘与鼠标路由在 App 顶层统一处理，本组件纯展示。
 *
 * @module dsc-tui/app/ApprovalCard
 */
import { useRef } from 'react'
import { Box, Text } from 'ink'
import type { DOMElement } from 'ink'
import type { JSX } from 'react'
import type { ApprovalRequestView } from '../contract.js'
import { BORDER, GAP, PAD, STATUS_COLOR, TEXT } from './theme.js'
import { DiffBlock } from './DiffBlock.js'
import { displayWidth, useClickRegion, type RegisterClick } from './click.js'

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 风险档标签：critical / high 用失败红，medium 用等待黄，low 走暗淡。 */
const RISK_LABEL: Record<ApprovalRequestView['risk'], { text: string; color: string | undefined }> = {
  low: { text: '低风险', color: undefined },
  medium: { text: '中风险', color: STATUS_COLOR.waiting },
  high: { text: '高风险', color: STATUS_COLOR.failed },
  critical: { text: '极高风险', color: STATUS_COLOR.failed },
}

/** 会话 jsonl 路径的短标识（文件名去后缀取前 8 位）。 */
const shortId = (sessionPath: string): string =>
  (sessionPath.split(/[\\/]/).pop() ?? sessionPath).replace(/\.jsonl$/, '').slice(0, 8)

/** 页脚按钮的动作 id（App 派发成与按键等价的调用）。 */
export type ApprovalAction = 'allow-once' | 'allow-session' | 'allow-always' | 'reject' | 'toggle-diff'

interface FooterButton {
  id: ApprovalAction
  hint: string
  label: string
  color: string | undefined
  dim: boolean
}

/** 页脚按钮的渲染与点击列区间共用同一份数据，谁也不会跟谁漂。 */
const BUTTON_TEXT: Record<ApprovalAction, { hint: string; label: string; color: string | undefined; dim: boolean }> = {
  'allow-once': { hint: '[y]', label: '允许一次', color: STATUS_COLOR.done, dim: false },
  'allow-session': { hint: '[a]', label: '本会话允许', color: STATUS_COLOR.done, dim: false },
  'allow-always': { hint: '[p]', label: '永久允许', color: BORDER.active, dim: false },
  reject: { hint: '[n]', label: '拒绝', color: STATUS_COLOR.failed, dim: true },
  'toggle-diff': { hint: '[v]', label: '展开/收起差异', color: undefined, dim: true },
}

export function ApprovalCard({
  request,
  expanded,
  onAction,
  registerClick,
}: {
  request: ApprovalRequestView
  expanded: boolean
  /** 鼠标点中页脚按钮时派发（与按键等价）；缺省即无鼠标行为。 */
  onAction?: (action: ApprovalAction) => void
  registerClick?: RegisterClick
}): JSX.Element {
  const risk = RISK_LABEL[request.risk]
  const rootRef = useRef<DOMElement | null>(null)

  const buttons: ApprovalAction[] = request.hardline
    ? ['reject']
    : [
        'allow-once',
        ...(request.scopes.includes('session') ? ['allow-session' as const] : []),
        ...(request.scopes.includes('always') ? ['allow-always' as const] : []),
        'reject',
        ...(request.diff !== undefined ? (['toggle-diff'] as const) : []),
      ]

  let cursor = 0
  const spans = buttons.map((id) => {
    const text = `${BUTTON_TEXT[id].hint} ${BUTTON_TEXT[id].label}`
    const from = cursor
    cursor += displayWidth(text) + 2
    return { id, from, to: from + displayWidth(text) }
  })

  useClickRegion(rootRef, registerClick, onAction === undefined ? undefined : (col, row, top, height) => {
    // 页脚在底边框上第一行；内容列从「左边框 + paddingX」之后起算。几何点击时现量。
    const footerRow = top + height - 2
    if (row !== footerRow) return false
    const contentCol = col - (1 + PAD.inline)
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
      <Text>
        <Text {...TEXT.label} color={BORDER.alert}>
          ⚠ 工具授权：{request.toolName}
        </Text>
        <Text {...TEXT.label} color={risk.color}>
          {' '}
          （{risk.text}）
        </Text>
      </Text>
      {request.reason !== '' ? (
        <Text {...TEXT.label} color={STATUS_COLOR.waiting}>
          为何要问：{request.reason}
        </Text>
      ) : null}
      <Text {...TEXT.secondary} wrap="truncate-end">{oneLine(request.argsSummary, 200)}</Text>
      <Text {...TEXT.secondary} wrap="truncate-end">
        权限 {request.policy} · 模式 {request.mode}
        {request.sessionPath !== undefined ? ` · 来自后台会话 ${shortId(request.sessionPath)}` : ''}
      </Text>
      {request.diff !== undefined ? <DiffBlock diff={request.diff} expanded={expanded} /> : null}
      {request.hardline ? (
        <Text>
          <Text {...TEXT.label} color={STATUS_COLOR.failed}>
            [n]
          </Text>
          <Text {...TEXT.secondary}> 拒绝（命中硬地板，不可放行）</Text>
        </Text>
      ) : (
        <Text>
          {buttons.map((id) => {
            const button = BUTTON_TEXT[id]
            const first = id === buttons[0]
            return (
              <Text key={id} {...(button.dim ? TEXT.secondary : TEXT.body)}>
                <Text {...TEXT.label} color={button.color}>
                  {first ? '' : '  '}
                  {button.hint}
                </Text>
                <Text> {button.label}</Text>
              </Text>
            )
          })}
        </Text>
      )}
    </Box>
  )
}
