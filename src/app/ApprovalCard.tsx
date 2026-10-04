/**
 * 审批卡：工具授权弹卡。四档应答——y 允许一次 / a 本会话允许 / p 永久允许 / n（或
 * Esc）拒绝；按键只渲染 request.scopes 允许的档位，命中硬地板（hardline）只留拒绝。
 *
 * 卡上补全宿主随请求带来的富信息：reason（为何要问）、risk 风险档、当前权限/协作
 * 模式、后台会话来源，write/edit 的「将做的改动」内嵌 diff（超长折叠，v 展开/收起）。
 * 键盘路由在 App 顶层统一处理，本组件纯展示。
 *
 * @module dsc-tui/app/ApprovalCard
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { ApprovalRequestView } from '../contract.js'
import { BORDER, GAP, PAD, STATUS_COLOR, TEXT } from './theme.js'
import { DiffBlock } from './DiffBlock.js'

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

export function ApprovalCard({
  request,
  expanded,
}: {
  request: ApprovalRequestView
  expanded: boolean
}): JSX.Element {
  const risk = RISK_LABEL[request.risk]
  return (
    <Box
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
      <Text {...TEXT.secondary}>{oneLine(request.argsSummary, 200)}</Text>
      <Text {...TEXT.secondary}>
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
          <Text {...TEXT.label} color={STATUS_COLOR.done}>
            [y]
          </Text>
          <Text {...TEXT.body}> 允许一次</Text>
          {request.scopes.includes('session') ? (
            <>
              <Text {...TEXT.label} color={STATUS_COLOR.done}>
                {'  '}[a]
              </Text>
              <Text {...TEXT.body}> 本会话允许</Text>
            </>
          ) : null}
          {request.scopes.includes('always') ? (
            <>
              <Text {...TEXT.label} color={BORDER.active}>
                {'  '}[p]
              </Text>
              <Text {...TEXT.body}> 永久允许</Text>
            </>
          ) : null}
          <Text {...TEXT.label} color={STATUS_COLOR.failed}>
            {'  '}[n]
          </Text>
          <Text {...TEXT.secondary}> 拒绝</Text>
          {request.diff !== undefined ? (
            <Text {...TEXT.secondary}>  [v] 展开/收起差异</Text>
          ) : null}
        </Text>
      )}
    </Box>
  )
}
