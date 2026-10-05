/**
 * 终端 markdown 子集解析器（0.6.58）：把模型回答里常见的 markdown 结构解析成
 * 可直接渲染的块列表。对齐 dsh-TUI markdown.ts 的能力面（标题/粗体/斜体/行内代码/
 * 链接/列表/表格/引用/围栏代码块），**不做完整 CommonMark**——解析失败或没见过的
 * 语法按普通文本渲染，永远不比裸文本差。
 *
 * 纯函数、无 React 依赖；渲染在 MarkdownView.tsx。显示宽度一律按 CJK=2
 * （与 click.ts 的 displayWidth 同源语义），表格列宽才会和终端对得上。
 *
 * @module dsc-tui/app/markdown
 */

/** 行内片段：一段同样式的文字。 */
export interface MarkdownSpan {
  text: string
  bold?: boolean
  italic?: boolean
  /** 行内代码（渲染成权限蓝）。 */
  code?: boolean
  /** 链接目标（渲染时文本加下划线与强调色；url 与文本不同则补注）。 */
  link?: string
}

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; spans: MarkdownSpan[] }
  | { kind: 'paragraph'; rows: MarkdownSpan[][] }
  | { kind: 'list'; ordered: boolean; items: MarkdownSpan[][] }
  | { kind: 'code'; lang: string | null; lines: string[] }
  | { kind: 'quote'; spans: MarkdownSpan[] }
  | { kind: 'table'; header: MarkdownSpan[][]; rows: MarkdownSpan[][][] }

/**
 * 行内解析：`代码`、**粗体**、__粗体__、*斜体*、_斜体_（贴词的 _ 不算，snake_case
 * 不误伤）、[文本](url)。嵌套（粗体里套代码）递归展开，样式叠加。
 */
export function parseInline(text: string, base: Partial<MarkdownSpan> = {}): MarkdownSpan[] {
  const spans: MarkdownSpan[] = []
  const pattern =
    /(`+)([^`]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])|\[([^\]\n]+?)\]\(([^)\s]+?)\)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const plain = text.slice(last, match.index)
    if (plain !== '') spans.push({ text: plain, ...base })
    const [, codeFence, code, boldA, boldB, italicA, italicB, linkText, linkUrl] = match
    if (codeFence !== undefined) {
      spans.push(...parseInline(code, { ...base, code: true }))
    } else if (boldA !== undefined) {
      spans.push(...parseInline(boldA, { ...base, bold: true }))
    } else if (boldB !== undefined) {
      spans.push(...parseInline(boldB, { ...base, bold: true }))
    } else if (italicA !== undefined) {
      spans.push(...parseInline(italicA, { ...base, italic: true }))
    } else if (italicB !== undefined) {
      spans.push(...parseInline(italicB, { ...base, italic: true }))
    } else if (linkText !== undefined) {
      spans.push(...parseInline(linkText, { ...base, link: linkUrl }))
    }
    last = match.index + match[0].length
  }
  const rest = text.slice(last)
  if (rest !== '') spans.push({ text: rest, ...base })
  return spans
}

const FENCE_OPEN = /^\s*```(\S*)\s*$/
const FENCE_CLOSE = /^\s*```\s*$/
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const LIST_CONT = /^\s{2,}(\S.*)$/

const isTableSeparator = (line: string): boolean =>
  /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-') && line.includes('|')

/** 按 | 切一行表格行（首尾竖线可省），单元格过行内解析。 */
const splitTableRow = (line: string): MarkdownSpan[][] => {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split('|').map((cell) => parseInline(cell.trim()))
}

/** 这行是不是某个块结构的开头（段落收集的终止条件）。 */
const isBlockStart = (line: string, next: string | undefined): boolean =>
  FENCE_OPEN.test(line) ||
  HEADING.test(line) ||
  BULLET.test(line) ||
  ORDERED.test(line) ||
  QUOTE.test(line) ||
  (line.includes('|') && next !== undefined && isTableSeparator(next))

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      index += 1
      continue
    }
    const fence = FENCE_OPEN.exec(line)
    if (fence !== null) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !FENCE_CLOSE.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1 // 吃掉闭合围栏（没闭合也照收）
      blocks.push({ kind: 'code', lang: fence[1] === '' ? null : fence[1], lines: body })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = Math.min(3, Math.max(1, heading[1].length)) as 1 | 2 | 3
      blocks.push({ kind: 'heading', level, spans: parseInline(heading[2]) })
      index += 1
      continue
    }
    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const rows = [splitTableRow(line)]
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rows.push(splitTableRow(lines[index]))
        index += 1
      }
      blocks.push({ kind: 'table', header: rows.shift() ?? [], rows })
      continue
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line) && !BULLET.test(line)
      const items: MarkdownSpan[][] = []
      while (index < lines.length) {
        const item = ordered ? ORDERED.exec(lines[index]) : BULLET.exec(lines[index])
        if (item !== null) {
          items.push(parseInline(item[1]))
          index += 1
          continue
        }
        const cont = LIST_CONT.exec(lines[index])
        if (cont !== null && items.length > 0) {
          items[items.length - 1].push({ text: ` ${cont[1]}` })
          index += 1
          continue
        }
        break
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote !== null) {
      blocks.push({ kind: 'quote', spans: parseInline(quote[1]) })
      index += 1
      continue
    }
    // 段落：连续的普通行收进一个块（块内逐行渲染，模型少有硬换行，各终端自己 wrap）
    const rows: string[] = [line]
    index += 1
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !isBlockStart(lines[index], lines[index + 1])
    ) {
      rows.push(lines[index])
      index += 1
    }
    blocks.push({ kind: 'paragraph', rows: rows.map((row) => parseInline(row)) })
  }
  return blocks
}

/** 与终端一致的显示宽度：CJK/全角记 2（与 click.ts 同源实现，避免互相 import 循环）。 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    width += isWideCodePoint(code) ? 2 : 1
  }
  return width
}

const isWideCodePoint = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1faff) ||
  (code >= 0x20000 && code <= 0x3fffd)

/** 按显示宽度补空格到指定列数（超宽截断加省略号）。 */
export function padCell(text: string, width: number): string {
  const current = displayWidth(text)
  if (current > width) return `${trimToWidth(text, width - 1)}…`
  return `${text}${' '.repeat(width - current)}`
}

const trimToWidth = (text: string, width: number): string => {
  let out = ''
  let used = 0
  for (const char of text) {
    const w = displayWidth(char)
    if (used + w > width) break
    out += char
    used += w
  }
  return out
}
