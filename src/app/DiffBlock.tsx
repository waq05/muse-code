/**
 * 差异块：unified hunk 的终端渲染（审批卡「将做的改动」与批次二的轮尾文件更改卡共用）。
 * 新增行绿、删除行红、上下文暗淡；默认折叠（只留前若干行），expanded 展开全部。
 *
 * @module dsc-tui/app/DiffBlock
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { ApprovalDiffView, DiffLineView } from '../contract.js'
import { DIFF_COLOR, GAP, INDENT, TEXT } from './theme.js'

/** 折叠时最多显示的差异行数（hunk 头不计）。 */
const FOLD_LINES = 14

function DiffRow({ line }: { line: DiffLineView }): JSX.Element {
  if (line.kind === 'add') return <Text color={DIFF_COLOR.add}>+ {line.text}</Text>
  if (line.kind === 'remove') return <Text color={DIFF_COLOR.del}>− {line.text}</Text>
  return <Text {...TEXT.secondary}>  {line.text}</Text>
}

export function DiffBlock({ diff, expanded }: { diff: ApprovalDiffView; expanded: boolean }): JSX.Element {
  const totalLines = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  const rows: JSX.Element[] = []
  let remaining = expanded ? Number.POSITIVE_INFINITY : FOLD_LINES
  for (const hunk of diff.hunks) {
    if (remaining <= 0) break
    rows.push(
      <Text key={`h${rows.length}`} {...TEXT.secondary}>
        @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
      </Text>,
    )
    for (const line of hunk.lines) {
      if (remaining <= 0) break
      rows.push(<DiffRow key={`l${rows.length}`} line={line} />)
      remaining -= 1
    }
  }
  const shown = totalLines - Math.max(0, remaining === Number.POSITIVE_INFINITY ? 0 : remaining)
  const hidden = totalLines - shown
  return (
    <Box flexDirection="column" marginTop={GAP.none} gap={GAP.none}>
      <Text {...TEXT.secondary}>
        将做的改动：{diff.path}（{diff.status === 'added' ? '新建' : '修改'}，+{diff.added} −{diff.removed}
        {diff.fellBack === true ? '，按参数推算' : ''}
        {diff.mismatch === 'missing' ? '，⚠ old 在盘上匹配不到，照参数执行会失败' : ''}
        {diff.mismatch === 'ambiguous' ? '，⚠ old 匹配多处，照参数执行会失败' : ''}）
      </Text>
      <Box flexDirection="column" marginLeft={INDENT.detail} gap={GAP.none}>
        {rows}
      </Box>
      {hidden > 0 || diff.truncated === true ? (
        <Text {...TEXT.secondary}>
          … 还有 {hidden} 行{diff.truncated === true ? '（超预算已截断）' : ''}，v 展开/收起
        </Text>
      ) : null}
    </Box>
  )
}
