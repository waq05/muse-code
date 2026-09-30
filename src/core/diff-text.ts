/**
 * 文本差异：把「改之前的行」与「改之后的行」算成标准 unified diff 的几段 hunk。
 *
 * 为什么自己写而不是引第三方包：这个仓库零额外运行时依赖（package.json 的 dependencies
 * 只有 cordis / ink / react / koffi / yaml 五样），为了一个几十行的差异算法再拉一个包，
 * 换来的是供应链上一个新的信任面与一份要跟着升的版本。算法本身是教科书写法。
 *
 * 为什么先削公共前后缀再上 LCS：DP 表的空间是 `(m+1) × (n+1)` 个格子。改一个 3000 行文件
 * 里的一行、或在一个大文件末尾追加一段，公共前后缀一削，真正进表的往往只有几行，
 * 于是「大文件小改动」这个最常见的场景根本不碰内存上限。只有中部就大改时才需要兜底：
 * 超过 {@link MAX_DIFF_CELLS} 就退回「摘要 + 第一处分歧的位置」，宁可少给信息也不把宿主拖死。
 *
 * 为什么超长行要按字符切：minified 的 js、单行几万字的 json 会让一条 diff 就撑爆上下文。
 * 截断处写清「已截断、原本多少字符」，用户和模型都知道那不是完整内容。
 *
 * @module dsc/core/diff-text
 */

/** 单行超过这么多字符就切掉（切完在行尾写明原本多少字符）。 */
export const DIFF_LINE_CHAR_LIMIT = 400

/**
 * 差异矩阵的格子数上限。超过就走摘要兜底。
 * 取 400 万格 ≈ 一张 2000×2000 的表：这个规模在毫秒级算完，内存也可控；
 * 再往上（整篇重写一万行的文件）摘要其实比逐行 diff 更可读。
 */
export const MAX_DIFF_CELLS = 4_000_000

/** 一段 diff 行（` ` 上下文 / `-` 删 / `+` 增）及其新旧行号。 */
export interface DiffLine {
  kind: 'context' | 'remove' | 'add'
  text: string
  /** 这一行在旧文件里的行号；`add` 行为 null。 */
  oldLine: number | null
  /** 这一行在新文件里的行号；`remove` 行为 null。 */
  newLine: number | null
}

/** 一段 hunk：`@@ -oldStart,oldCount +newStart,newCount @@` 加上它包含的行。 */
export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

/** 一次 diff 的结果。`ok` 为 false 时给的是摘要（算不动或没有变化）。 */
export interface DiffResult {
  /** true = 逐行 diff 算出来了（哪怕只有一段）。 */
  ok: boolean
  hunks: DiffHunk[]
  added: number
  removed: number
  /** ok=false / 内容相同时的中文说明（一行内说清原因）。 */
  note?: string
  /** true = 新旧文本完全相同。 */
  identical: boolean
  /** true = 因为超出 {@link MAX_DIFF_CELLS} 走了摘要兜底。 */
  oversize: boolean
}

/** 按 `\n` 切行；CRLF 的 `\r` 与 BOM 一并抹掉，免得每行都被判成「改过」。 */
export function splitLines(text: string): string[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (body === '') return []
  const normalized = body.endsWith('\n') ? body.slice(0, -1) : body
  return normalized.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** 新旧文本的换行风格是否不同（改了行尾风格要说一句，不然「整篇看起来没变」）。 */
function newlineStyleChanged(before: string, after: string): boolean {
  const style = (text: string): 'crlf' | 'lf' | 'none' =>
    text === '' ? 'none' : text.includes('\r\n') ? 'crlf' : 'lf'
  const left = style(before)
  const right = style(after)
  return left !== 'none' && right !== 'none' && left !== right
}

/** 超长行切一刀，行尾写明原本多少字符（决策理由见模块注释）。 */
function clipLine(line: string): string {
  return line.length <= DIFF_LINE_CHAR_LIMIT
    ? line
    : `${line.slice(0, DIFF_LINE_CHAR_LIMIT)}…（本行原 ${String(line.length)} 字符，预览已截断）`
}

/** 摘要兜底：说清「变了多少行」与「第一处不一样在第几行」。 */
function summarize(before: readonly string[], after: readonly string[], reason: string): DiffResult {
  let head = 0
  const shared = Math.min(before.length, after.length)
  while (head < shared && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < shared - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1
  }
  const removed = before.length - head - tail
  const added = after.length - head - tail
  const where = head < shared || removed > 0 ? `第 ${String(head + 1)} 行起` : '文件末尾'
  return {
    ok: false,
    hunks: [],
    added: Math.max(0, added),
    removed: Math.max(0, removed),
    note: `${reason}；从${where}开始不一样：删 ${String(Math.max(0, removed))} 行、加 ${String(Math.max(0, added))} 行`,
    identical: false,
    oversize: true,
  }
}

/**
 * 算一次 diff。
 *
 * @param before - 改动前的完整文本。
 * @param after - 改动后的完整文本。
 * @param contextLines - 每个 hunk 前后各留几行上下文（0 = 只给改动的行）。
 * @returns 逐行 diff；算不动或没有变化时给摘要。
 */
export function diffLines(before: string, after: string, contextLines: number): DiffResult {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  const context = Math.max(0, Math.min(Math.round(contextLines), 50))

  if (before === after) {
    return { ok: true, hunks: [], added: 0, removed: 0, identical: true, oversize: false }
  }

  const suffixNote = newlineStyleChanged(before, after) ? '（顺带改了换行风格：CRLF ↔ LF）' : ''
  const shared = Math.min(oldLines.length, newLines.length)
  let head = 0
  while (head < shared && oldLines[head] === newLines[head]) head += 1
  let tail = 0
  while (
    tail < shared - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1
  }

  const oldMiddle = oldLines.slice(head, oldLines.length - tail)
  const newMiddle = newLines.slice(head, newLines.length - tail)

  // 两侧中部任意一边为空 = 纯插入或纯删除，不必跑矩阵
  const cells = (oldMiddle.length + 1) * (newMiddle.length + 1)
  if (oldMiddle.length > 0 && newMiddle.length > 0 && cells > MAX_DIFF_CELLS) {
    return summarize(oldLines, newLines, `改动区间过大（约 ${String(oldMiddle.length)} 行 vs ${String(newMiddle.length)} 行），只给摘要`)
  }

  const ops = lcsOps(oldMiddle, newMiddle)
  /**
   * 中部逐行结果。
   * 注意下标：`oldMiddle`/`newMiddle` 是削掉公共前后缀之后的数组，
   * 而 oldCursor/newCursor 走的是**文件里的行号**，两者差一个 head，
   * 所以取文本要写 `oldMiddle[oldCursor - head]`，行号则是 `oldCursor + 1`（行号从 1 起）。
   */
  const middle: DiffLine[] = []
  let oldCursor = head
  let newCursor = head
  for (const op of ops) {
    if (op === 'context') {
      middle.push({ kind: 'context', text: oldMiddle[oldCursor - head] ?? '', oldLine: oldCursor + 1, newLine: newCursor + 1 })
      oldCursor += 1
      newCursor += 1
    } else if (op === 'remove') {
      middle.push({ kind: 'remove', text: oldMiddle[oldCursor - head] ?? '', oldLine: oldCursor + 1, newLine: null })
      oldCursor += 1
    } else {
      middle.push({ kind: 'add', text: newMiddle[newCursor - head] ?? '', oldLine: null, newLine: newCursor + 1 })
      newCursor += 1
    }
  }

  /**
   * 上下文行必须自己补回 rows 里：公共前后缀在 LCS 之前就被削掉了，
   * 那几行压根不在 `middle` 里。少了它们，hunk 就只剩光秃秃的改动行
   * （`@@ -2 +2 @@` 而不是 diff -u 的 `@@ -1,3 +1,3 @@`），
   * 用户看不出改在哪个函数、哪一段里。
   */
  const rows: DiffLine[] = [
    ...oldLines.slice(0, head).map((text, index) => ({
      kind: 'context' as const,
      text,
      oldLine: index + 1,
      newLine: index + 1,
    })),
    ...middle,
    ...oldLines.slice(oldLines.length - tail).map((text, index) => ({
      kind: 'context' as const,
      text,
      oldLine: oldLines.length - tail + index + 1,
      newLine: newLines.length - tail + index + 1,
    })),
  ]

  const hunks = groupHunks(rows, context)
  const added = middle.reduce((sum, row) => sum + (row.kind === 'add' ? 1 : 0), 0)
  const removed = middle.reduce((sum, row) => sum + (row.kind === 'remove' ? 1 : 0), 0)
  const note = suffixNote === '' ? undefined : `${suffixNote}（逐行差异已忽略行尾风格）`
  return { ok: true, hunks, added, removed, identical: false, oversize: false, ...(note !== undefined ? { note } : {}) }
}

/** 一个差异操作：保留上下文、删掉旧行、插入新行。 */
type DiffOp = 'context' | 'remove' | 'add'

/**
 * 只对「中部」求最长公共子序列，再回溯成操作序列。
 * 删与插在同一位置时先删后插（与 `diff -u` 的写法一致，读起来是「这段被替换成那段」）。
 */
function lcsOps(oldMiddle: readonly string[], newMiddle: readonly string[]): DiffOp[] {
  const m = oldMiddle.length
  const n = newMiddle.length
  if (m === 0) return new Array<DiffOp>(n).fill('add')
  if (n === 0) return new Array<DiffOp>(m).fill('remove')

  // table[i][j] = oldMiddle[i..] 与 newMiddle[j..] 的最长公共子序列长度
  const width = n + 1
  const table = new Int32Array((m + 1) * width)
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        oldMiddle[i] === newMiddle[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldMiddle[i] === newMiddle[j]) {
      ops.push('context')
      i += 1
      j += 1
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      ops.push('remove')
      i += 1
    } else {
      ops.push('add')
      j += 1
    }
  }
  while (i < m) {
    ops.push('remove')
    i += 1
  }
  while (j < n) {
    ops.push('add')
    j += 1
  }
  return ops
}

/**
 * 把逐行结果切成 hunk：改动行连同前后各 {@link contextLines} 行算一段，
 * 两段之间相隔不超过 `2 × context` 行就并成一段（跟 `diff -u` 的合并规则一样），
 * 否则中间那段没改的内容就不重复贴出来了。
 */
function groupHunks(rows: readonly DiffLine[], context: number): DiffHunk[] {
  const changed = rows
    .map((row, index) => (row.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0)
  if (changed.length === 0) return []

  const ranges: Array<{ from: number; to: number }> = []
  for (const index of changed) {
    const from = Math.max(0, index - context)
    const to = Math.min(rows.length - 1, index + context)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && from <= last.to + 1) last.to = Math.max(last.to, to)
    else ranges.push({ from, to })
  }

  return ranges.map((range) => {
    const slice = rows.slice(range.from, range.to + 1)
    const first = slice[0]!
    // 起点行号：hunk 第一行有这一侧的行号就用它；没有（开头就是新增/删除行）就退到
    // 「本该显示的上一行」，两侧都没有（空文件长出来的第一段）才落到 0
    // —— 这样 @@ -0,0 @@ 只在真的从空文件新增时出现
    return {
      oldStart: first.oldLine ?? rows[range.from - 1]?.oldLine ?? 0,
      oldCount: slice.reduce((sum, row) => sum + (row.kind === 'add' ? 0 : 1), 0),
      newStart: first.newLine ?? rows[range.from - 1]?.newLine ?? 0,
      newCount: slice.reduce((sum, row) => sum + (row.kind === 'remove' ? 0 : 1), 0),
      lines: slice,
    }
  })
}

/** hunk 头 `@@ -1,3 +1,4 @@`（行数为 1 时省掉 `,1`，与 `diff -u` 的写法一致）。 */
function hunkHeader(hunk: DiffHunk): string {
  const range = (start: number, count: number): string =>
    count === 1 ? `${String(start)}` : `${String(start)},${String(count)}`
  return `@@ -${range(hunk.oldStart, hunk.oldCount)} +${range(hunk.newStart, hunk.newCount)} @@`
}

/** 把一段 hunk 铺成文本行（超长行在这里切，见 {@link clipLine}）。 */
export function renderHunk(hunk: DiffHunk): string[] {
  const body = hunk.lines.map((line) => `${line.kind === 'context' ? ' ' : line.kind === 'add' ? '+' : '-'}${clipLine(line.text)}`)
  return [hunkHeader(hunk), ...body]
}

/**
 * 整份 diff 的文本（把所有 hunk 拼起来）。
 * 只用来落日志或测试；给用户看的那份一律走 `plugins/file-review.ts` 的行数上限渲染。
 */
export function renderDiff(result: DiffResult): string {
  return result.hunks.flatMap((hunk) => renderHunk(hunk)).join('\n')
}
