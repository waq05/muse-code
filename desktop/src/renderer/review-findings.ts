/**
 * /review findings 的解析（T18）：审查队友的汇报被 `<review-findings>` 包裹写进会话，
 * 渲染层在这里把它解析成可出卡的结构——按条渲染 + 位置行号跳转。
 *
 * 条目格式是 reviewer 角色提示词里约定的（src/core/agent-roles.ts BUILTIN_FILES.reviewer）：
 *
 * ```
 * ### [P1] 一句话标题
 * 位置：相对路径:行号
 * 说明：……（可多行）
 * 建议：……（可多行，可缺）
 * ```
 *
 * 解析刻意宽松：字段标签认全半角冒号、剥 markdown 加粗与反引号；解析不动的地方
 * 原样留进 detail——宁可展示原文，不丢内容。非 findings 文本返回 null。
 *
 * @module dsc/renderer/review-findings
 */

/** 一条 finding 的位置：仓库相对路径 + 可缺省的行号。 */
export interface ReviewFindingLocation {
  path: string
  line?: number
}

/** 一条 finding：优先级 + 标题 + 位置 + 说明 + 可缺省的建议。 */
export interface ReviewFinding {
  priority: 'P1' | 'P2' | 'P3'
  title: string
  location?: ReviewFindingLocation
  detail: string
  suggestion?: string
}

/** 一份解析完的审查汇报。 */
export interface ReviewFindingsDoc {
  /** 交结论的队友名（`<review-findings teammate="…">`）。 */
  teammate: string
  /** 审查收工状态（已完成/已停止/已失败）；老消息没有这属性。 */
  state?: string
  /** 按文档顺序的条目；模型没发现问题就是空的。 */
  findings: ReviewFinding[]
  /** 条目之前的引言（「未发现问题」的整体说明等）。 */
  trailing: string
}

/** `<review-findings …>` 包裹体（只认整体包裹：普通消息不掺这个标签）。 */
const WRAP_RE = /^<review-findings\b([^>]*)>([\s\S]*)<\/review-findings>$/i

/** 条目头：`### [P1] 标题`（井号 2–4 个都认）。 */
const HEAD_RE = /^#{2,4}\s*\[P([123])\]\s*(.+?)\s*$/

/** 捕获组给的是 `1`，优先级要的是 `P1`。 */
function priorityOf(digit: string): ReviewFinding['priority'] {
  return `P${digit}` as ReviewFinding['priority']
}

/** 字段行：`位置：…` / `说明：…` / `建议：…`（剥掉可能的加粗、反引号与列表标记后认全半角冒号）。 */
function fieldOf(rawLine: string): { key: string; value: string } | null {
  // 先剥加粗（**位置**：）再剥列表前缀（- / *），单星加粗残留不会污染 key
  const line = rawLine.replace(/\*\*/g, '').replace(/`/g, '').replace(/^\s*[*-]\s*/, '').trim()
  const at = line.search(/[：:]/)
  if (at <= 0) return null
  return { key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() }
}

/** 位置值 → { path, line? }：`src/foo.ts:123`，行号非数字就整段归 path。 */
function parseLocation(value: string): ReviewFindingLocation | undefined {
  const text = value.trim()
  if (text === '') return undefined
  const at = text.lastIndexOf(':')
  if (at > 0) {
    const line = Number.parseInt(text.slice(at + 1), 10)
    if (Number.isFinite(line) && line > 0) {
      return { path: text.slice(0, at), line }
    }
  }
  return { path: text }
}

/** 多行字段拼接：空值直接赋，续行补空格。 */
function appendLine(current: string, line: string): string {
  if (line === '') return current
  return current === '' ? line : `${current} ${line}`
}

/**
 * 解析一条会话消息：整体被 `<review-findings>` 包裹才认（返回 null = 普通消息按原样渲染）。
 */
export function parseReviewFindings(text: string): ReviewFindingsDoc | null {
  const wrapped = text.trim().match(WRAP_RE)
  if (wrapped === null) return null
  const attrs = wrapped[1] ?? ''
  const teammate = attrs.match(/(?:^|\s)teammate="([^"]*)"/)?.[1] ?? ''
  const stateMatch = attrs.match(/(?:^|\s)state="([^"]*)"/)?.[1]
  const body = (wrapped[2] ?? '').trim()
  const state = stateMatch === undefined ? {} : { state: stateMatch }

  const lines = body.split('\n')
  const heads: Array<{ index: number; priority: ReviewFinding['priority']; title: string }> = []
  for (let index = 0; index < lines.length; index += 1) {
    const head = lines[index]!.match(HEAD_RE)
    if (head !== null) {
      heads.push({ index, priority: priorityOf(head[1]!), title: head[2] ?? '' })
    }
  }
  if (heads.length === 0) {
    return { teammate, ...state, findings: [], trailing: body }
  }

  const findings: ReviewFinding[] = heads.map((head, order) => {
    const start = head.index + 1
    const end = order + 1 < heads.length ? heads[order + 1]!.index : lines.length
    const finding: ReviewFinding = { priority: head.priority, title: head.title, detail: '' }
    let section: 'detail' | 'suggestion' | null = null
    for (let index = start; index < end; index += 1) {
      const rawLine = lines[index]!
      const field = fieldOf(rawLine)
      if (field !== null && field.key === '位置') {
        const location = parseLocation(field.value)
        if (location !== undefined) finding.location = location
        section = null
        continue
      }
      if (field !== null && field.key === '说明') {
        section = 'detail'
        finding.detail = appendLine(finding.detail, field.value)
        continue
      }
      if (field !== null && field.key === '建议') {
        section = 'suggestion'
        finding.suggestion = appendLine(finding.suggestion ?? '', field.value)
        continue
      }
      if (rawLine.trim() === '') {
        section = null
        continue
      }
      // 不认识的行：说明/建议的多行续文；不在字段里就归进说明兜底（宁可多留不丢内容）
      if (section === 'suggestion') finding.suggestion = appendLine(finding.suggestion ?? '', rawLine.trim())
      else finding.detail = appendLine(finding.detail, rawLine.trim())
    }
    return finding
  })

  const trailing = lines.slice(0, heads[0]!.index).join(' ').trim()
  return { teammate, ...state, findings, trailing }
}
