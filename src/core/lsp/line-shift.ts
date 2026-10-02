/**
 * 诊断增量的行号对齐：建一张「写前 → 写后」的行号映射，把基线诊断平移到写后坐标。
 *
 * 为什么要单独一个模块：这段是纯算法（LCS 动态规划 + 贪心兜底），和连接/进程零关系，
 * 却是写文件后「假错不冒出来」的关键——增量过滤靠它认出「同一条诊断，只是被上面的
 * 插入行推下去了」。单独成模块，改算法不用在 client.ts 的进程管理代码里找，自检
 * （`shots/lsp-check.mjs`）也直接打这里。
 *
 * 本模块只从 client.ts 拿类型（`import type`，编译期擦除），运行时无依赖。
 *
 * @module dsc/core/lsp/line-shift
 */
import type { LspDiagnostic } from './client.js'

/** LCS 动态规划的格子上限（超了就退回贪心匹配，别为了对齐行号吃爆内存）。 */
const LCS_MAX_CELLS = 1_000_000

/**
 * 建一张写前 → 写后的行号映射（零基，`null` = 那一行被删了）。
 *
 * 为什么需要：增量过滤的关键是「同一条诊断，只是被上面的插入行推下去了」。如果只按
 * (消息, 区间) 比，位移过的旧诊断会被当成新引入的，写完一次文件就报一堆假错。
 * 做法与 hermes 的 `range_shift.py` 同一个思路：先削掉公共前后缀（单点编辑的中段因此很短），
 * 中段用 LCS 对齐（`equal` 的行按偏移映射，被替换/删掉的行映射到 `null`），尾部整体平移。
 *
 * @param preText - 写前的文本。
 * @param postText - 写后的文本。
 * @returns `shift(line) -> 新行号 | null`（行号越界时锚到最后一行）。
 */
export function buildLineShift(preText: string, postText: string): (line: number) => number | null {
  const pre = splitLines(preText)
  const post = splitLines(postText)
  if (pre.length === post.length && pre.every((line, index) => line === post[index])) {
    return (line) => line
  }
  let prefix = 0
  while (prefix < pre.length && prefix < post.length && pre[prefix] === post[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < pre.length - prefix &&
    suffix < post.length - prefix &&
    pre[pre.length - 1 - suffix] === post[post.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const preMiddle = pre.slice(prefix, pre.length - suffix)
  const postMiddle = post.slice(prefix, post.length - suffix)
  const middleMap = lcsLineMap(preMiddle, postMiddle)
  const tailShift = post.length - pre.length
  return (line) => {
    if (line < 0) return null
    if (line < prefix) return line
    if (line >= pre.length - suffix) {
      // 尾部：整体平移；落在文件末尾之外的锚到最后一行（与 hermes 一致）。
      if (line >= pre.length) return post.length === 0 ? null : post.length - 1
      return line + tailShift
    }
    const mapped = middleMap[line - prefix]
    return mapped === null || mapped === undefined ? null : mapped + prefix
  }
}

/** 拆行（LSP 按 `\n` 数行，`\r` 只是行尾的一部分）。 */
function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

/** 中段对齐：`a[i]` 对应 `b[j]` 就记 j，对不上记 null。 */
function lcsLineMap(a: string[], b: string[]): Array<number | null> {
  const out: Array<number | null> = new Array<number | null>(a.length).fill(null)
  if (a.length === 0 || b.length === 0) return out
  if ((a.length + 1) * (b.length + 1) > LCS_MAX_CELLS) return greedyLineMap(a, b)
  const width = b.length + 1
  const table = new Int32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!)
    }
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out[i] = j
      i += 1
      j += 1
      continue
    }
    if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) i += 1
    else j += 1
  }
  return out
}

/** 太大时的兜底：按文本贪心配对（每个 b 行只用一次，从左往右）。 */
function greedyLineMap(a: string[], b: string[]): Array<number | null> {
  const out: Array<number | null> = new Array<number | null>(a.length).fill(null)
  const index = new Map<string, number[]>()
  for (const [j, line] of b.entries()) {
    const list = index.get(line)
    if (list === undefined) index.set(line, [j])
    else list.push(j)
  }
  let floor = -1
  for (const [i, line] of a.entries()) {
    const candidates = index.get(line)
    if (candidates === undefined) continue
    const hit = candidates.find((j) => j > floor)
    if (hit === undefined) continue
    out[i] = hit
    floor = hit
  }
  return out
}

/** 把基线诊断按行位移映射到写后的坐标；落在被删区域里的直接出局。 */
export function shiftDiagnostics(
  diagnostics: readonly LspDiagnostic[],
  shift: (line: number) => number | null,
): LspDiagnostic[] {
  const out: LspDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const startLine = shift(diagnostic.range.start.line)
    if (startLine === null) continue
    const endLine = shift(diagnostic.range.end.line) ?? startLine
    out.push({
      ...diagnostic,
      range: {
        start: { line: startLine, character: diagnostic.range.start.character },
        end: { line: endLine, character: diagnostic.range.end.character },
      },
    })
  }
  return out
}
