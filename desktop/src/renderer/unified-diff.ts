/**
 * git unified diff 文本 → DiffHunkView[]（dock `git-diff` 服务回的是 diff 文本，
 * 审查面板那套 DiffRows 只认结构化 hunk，这层解析补上缺口）。
 *
 * 只做渲染用解析：对不认识的行跳过、hunk 计数以实际行数为准（git 在文件末尾
 * 没换行等场景下 `@@` 头的计数与实际行会差一），解析失败宁可少一段也不抛错。
 *
 * @module desktop/renderer/unified-diff
 */
import type { DiffHunkView, DiffLineView } from '@dsc/runtime/contract.js'

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** 从单文件（或全量）的 unified diff 文本解析出全部 hunk；没有 hunk 就给空数组。 */
export function parseUnifiedDiff(text: string): DiffHunkView[] {
  const hunks: DiffHunkView[] = []
  const lines = text.split(/\r?\n/)
  let at = 0
  while (at < lines.length) {
    const head = (lines[at] ?? '').match(HUNK_HEAD)
    if (head === null) {
      at += 1
      continue
    }
    at += 1
    const rows: DiffLineView[] = []
    let oldLine = Number(head[1])
    let newLine = Number(head[3])
    while (at < lines.length) {
      const line = lines[at] ?? ''
      if (HUNK_HEAD.test(line)) break
      const tag = line.charAt(0)
      if (tag === '\\') {
        // 「\ No newline at end of file」：标注行，不进差异正文
        at += 1
        continue
      }
      if (tag === ' ') {
        rows.push({ kind: 'context', text: line.slice(1), oldLine, newLine })
        oldLine += 1
        newLine += 1
      } else if (tag === '-') {
        rows.push({ kind: 'remove', text: line.slice(1), oldLine, newLine: null })
        oldLine += 1
      } else if (tag === '+') {
        rows.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine })
        newLine += 1
      } else {
        // `diff --git` / `index` / `---` / `+++` / 空行等：hunk 结束
        break
      }
      at += 1
    }
    if (rows.length > 0) {
      hunks.push({
        oldStart: Number(head[1]),
        oldCount: rows.reduce((sum, row) => sum + (row.kind === 'add' ? 0 : 1), 0),
        newStart: Number(head[3]),
        newCount: rows.reduce((sum, row) => sum + (row.kind === 'remove' ? 0 : 1), 0),
        lines: rows,
      })
    }
  }
  return hunks
}

/** 全量 git diff 按文件切段后的每一段：git 相对路径 + 该文件的 hunk。 */
export interface UnifiedFileDiff {
  /** git 报出的相对仓库根路径（`b/` 侧；rename 时也是新路径）。 */
  path: string
  added: number
  removed: number
  hunks: DiffHunkView[]
}

/** 把全量 git diff 文本按 `diff --git` 行切成每文件一段；没有 diff 体（全是 clean）就给空数组。 */
export function splitUnifiedDiffByFile(text: string): UnifiedFileDiff[] {
  const files: UnifiedFileDiff[] = []
  const chunks = text.split(/^diff --git /m).filter((chunk) => chunk.trim() !== '')
  for (const chunk of chunks) {
    const firstLineEnd = chunk.indexOf('\n')
    const first = firstLineEnd < 0 ? chunk : chunk.slice(0, firstLineEnd)
    // 首行形如 `a/src/x.ts b/src/x.ts`：取 `b/` 侧（rename 时它也是新路径）
    const nameMatch = first.match(/^a\/(.*) b\/(.*)$/)
    const path = (nameMatch !== null ? nameMatch[2] : first).trim()
    if (path === '') continue
    const hunks = parseUnifiedDiff(chunk)
    if (hunks.length === 0) continue
    let added = 0
    let removed = 0
    for (const hunk of hunks) {
      for (const row of hunk.lines) {
        if (row.kind === 'add') added += 1
        else if (row.kind === 'remove') removed += 1
      }
    }
    files.push({ path, added, removed, hunks })
  }
  return files
}
