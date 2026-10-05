/**
 * markdown 渲染组件（0.6.58）：把 markdown.ts 解析出的块画进 ink——对齐 dsh-TUI
 * 的排版规格：H1 强调色粗体下划线 / H2 权限蓝粗体 / H3+ 粗体正文、行内代码权限蓝、
 * 链接强调色下划线（url 退化补注——终端没有可点的超链接，藏掉 url 会丢信息）、
 * 列表符号权限蓝、引用 ▎ 暗淡斜体、代码块两格缩进无闭合围栏、表格 ┌─┬┐ 框线 +
 * 表头粗体居中（超宽降级成 label: value 行）。块与块之间空一行。
 *
 * 解析结果按 source memo（同一条目重渲染不重解析）；流式光标 `▌` 追加在最后一段。
 * 正文行一律自然折行（truncate 会把长回答砍成一行；高度交给聊天视口顶部裁剪）。
 *
 * @module dsc-tui/app/MarkdownView
 */
import { useMemo } from 'react'
import { Box, Text, useStdout } from 'ink'
import type { JSX } from 'react'
import {
  displayWidth,
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownSpan,
} from './markdown.js'
import { PAD, PALETTE, TEXT } from './theme.js'

/** 行内片段 → ink Text 序列（链接补注 url）。 */
function Spans({ spans }: { spans: MarkdownSpan[] }): JSX.Element {
  return (
    <>
      {spans.map((span, index) => {
        const style = {
          ...(span.bold === true ? { bold: true } : {}),
          ...(span.italic === true ? { italic: true } : {}),
        }
        if (span.code === true) {
          return (
            <Text key={index} {...style} color={PALETTE.permission}>
              {span.text}
            </Text>
          )
        }
        if (span.link !== undefined) {
          return (
            <Text key={index}>
              <Text {...style} color={PALETTE.accent} underline>
                {span.text}
              </Text>
              {span.text !== span.link ? <Text {...TEXT.secondary}> ({span.link})</Text> : null}
            </Text>
          )
        }
        return (
          <Text key={index} {...TEXT.body} {...style}>
            {span.text}
          </Text>
        )
      })}
    </>
  )
}

/** 表格：┌─┬┐ 框线 + 表头粗体居中；总宽超限降级成「表头： 首格；次格」行。 */
function TableView({
  header,
  rows,
  maxWidth,
}: {
  header: MarkdownSpan[][]
  rows: MarkdownSpan[][][]
  maxWidth: number
}): JSX.Element {
  const columnCount = Math.max(header.length, ...rows.map((row) => row.length), 1)
  const widths: number[] = []
  for (let c = 0; c < columnCount; c += 1) {
    let width = 0
    for (const span of header[c] ?? []) width = Math.max(width, displayWidth(span.text))
    for (const row of rows) {
      for (const span of row[c] ?? []) width = Math.max(width, displayWidth(span.text))
    }
    widths.push(Math.max(3, Math.min(width, 42)))
  }
  const total = widths.reduce((sum, w) => sum + w, 0) + columnCount * 3 + 1
  if (total > maxWidth) {
    const label = header.map((spans) => spans.map((span) => span.text).join('')).join('·')
    return (
      <Box flexDirection="column">
        {rows.map((row, index) => {
          const cells = row.flatMap((cell, c) =>
            c === 0 ? cell : [{ text: '；' }, ...cell],
          )
          return (
            <Text key={index}>
              <Text bold>{label}</Text>
              <Text {...TEXT.secondary}>： </Text>
              <Spans spans={cells} />
            </Text>
          )
        })}
      </Box>
    )
  }
  const borderRow = (left: string, mid: string, right: string): string =>
    left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right
  const cellRow = (cells: MarkdownSpan[][], bold: boolean, center: boolean): JSX.Element => (
    <Text>
      │
      {widths.map((width, c) => {
        const spans = cells[c] ?? []
        const plain = spans.map((span) => span.text).join('')
        const pad = Math.max(0, width - displayWidth(plain))
        const leftPad = center ? Math.floor(pad / 2) : 0
        // 段宽 = 1空格 + 内容(width) + 1空格 = w+2，与边框段 '─'.repeat(w+2) 对齐
        return (
          <Text key={c}>
            {' '}
            {' '.repeat(leftPad)}
            {bold ? <Text bold>{plain}</Text> : <Spans spans={spans} />}
            {' '.repeat(pad - leftPad)}
            {' '}
            │
          </Text>
        )
      })}
    </Text>
  )
  return (
    <Box flexDirection="column">
      <Text>{borderRow('┌', '┬', '┐')}</Text>
      {cellRow(header, true, true)}
      <Text>{borderRow('├', '┼', '┤')}</Text>
      {rows.map((row, index) => (
        <Box key={index}>
          {cellRow(row, false, false)}
        </Box>
      ))}
      <Text>{borderRow('└', '┴', '┘')}</Text>
    </Box>
  )
}

function BlockView({
  block,
  maxWidth,
  isLast,
  cursor,
}: {
  block: MarkdownBlock
  maxWidth: number
  isLast: boolean
  cursor: boolean
}): JSX.Element {
  switch (block.kind) {
    case 'heading': {
      const text = block.spans.map((span) => span.text).join('')
      if (block.level === 1) {
        return (
          <Text bold color={PALETTE.accent} underline>
            {text}
          </Text>
        )
      }
      if (block.level === 2) {
        return (
          <Text bold color={PALETTE.permission}>
            {text}
          </Text>
        )
      }
      return <Text bold>{text}</Text>
    }
    case 'paragraph':
      return (
        <Box flexDirection="column">
          {block.rows.map((row, index) => {
            const lastRow = index === block.rows.length - 1
            return (
              <Text key={index}>
                <Spans spans={row} />
                {cursor && isLast && lastRow ? <Text color={PALETTE.accent}> ▌</Text> : null}
              </Text>
            )
          })}
        </Box>
      )
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, index) => (
            <Text key={index}>
              {block.ordered ? (
                <Text color={PALETTE.permission} bold>
                  {index + 1}.
                </Text>
              ) : (
                <Text color={PALETTE.permission}>-</Text>
              )}
              <Text> </Text>
              <Spans spans={item} />
            </Text>
          ))}
        </Box>
      )
    case 'quote':
      return (
        <Text>
          <Text {...TEXT.secondary}>▎ </Text>
          <Text {...TEXT.body} italic>
            <Spans spans={block.spans} />
          </Text>
        </Text>
      )
    case 'code':
      return (
        <Box flexDirection="column">
          {block.lang !== null ? <Text {...TEXT.secondary}>```{block.lang}</Text> : null}
          {block.lines.map((line, index) => (
            <Text key={index} {...TEXT.body}>
              {'  '}
              {line}
            </Text>
          ))}
        </Box>
      )
    case 'table':
      return <TableView header={block.header} rows={block.rows} maxWidth={maxWidth} />
  }
}

export function MarkdownView({
  source,
  cursor = false,
}: {
  source: string
  /** 流式光标（追加在最后一个段落行尾）。 */
  cursor?: boolean
}): JSX.Element {
  const { stdout } = useStdout()
  const maxWidth = Math.max(20, (stdout?.columns ?? 100) - PAD.page * 2 - 2)
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <Box flexDirection="column" gap={1}>
      {blocks.map((block, index) => (
        <BlockView
          key={index}
          block={block}
          maxWidth={maxWidth}
          isLast={index === blocks.length - 1}
          cursor={cursor}
        />
      ))}
      {blocks.length === 0 && cursor ? <Text color={PALETTE.accent}> ▌</Text> : null}
    </Box>
  )
}
