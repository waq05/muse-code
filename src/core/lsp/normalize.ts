/**
 * LSP 应答归并的纯函数：把服务器给的各种形状（Location / LocationLink /
 * MarkupContent / MarkedString / Diagnostic）收敛成 dsc 自己的类型。
 *
 * 为什么要单独一个模块：这一段是纯函数（不碰进程、不碰流），是自检的重点覆盖对象
 * （`shots/lsp-check.mjs`），和 client.ts 里的连接/实例生命周期（spawn、握手、超时）
 * 完全是两种东西。放同一份 1578 行的文件里，改归并逻辑要在进程管理的代码堆里找。
 *
 * 本模块只从 client.ts 拿类型（`import type`，编译期擦除），运行时方向永远是
 * client → normalize，不成环。
 *
 * @module dsc/core/lsp/normalize
 */
import type { LspDiagnostic, LspHover, LspLocation } from './client.js'
import type { LspPosition, LspRange } from './uri.js'

/** 认得出是个普通对象就返回，否则 null。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 线上坐标是不是非负整数。 */
function isProtocolPosition(value: unknown): value is LspPosition {
  const doc = asRecord(value)
  if (doc === null) return false
  return (
    typeof doc.line === 'number' &&
    Number.isInteger(doc.line) &&
    doc.line >= 0 &&
    typeof doc.character === 'number' &&
    Number.isInteger(doc.character) &&
    doc.character >= 0
  )
}

/** 线上区间是不是合法。 */
function isRange(value: unknown): value is LspRange {
  const doc = asRecord(value)
  if (doc === null) return false
  return isProtocolPosition(doc.start) && isProtocolPosition(doc.end)
}

/** 复制一份区间（只留四个数字，免得把服务器给的额外字段带进会话）。 */
function toRange(range: LspRange): LspRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

/**
 * 归并导航结果：`Location` / `Location[]` / `LocationLink[]` / `null` 都收成 {@link LspLocation} 数组。
 * `LocationLink` 取 `targetUri` + `targetSelectionRange`（要的是符号本身的区间，不是整块上下文）。
 *
 * @throws Error - 结果里有既不是 Location 也不是 LocationLink 的项（协议坏了，由调用方转成降级文案）。
 */
export function normalizeLocations(payload: unknown): LspLocation[] {
  if (payload === null || payload === undefined) return []
  const elements = Array.isArray(payload) ? payload : [payload]
  const out: LspLocation[] = []
  for (const element of elements) {
    const doc = asRecord(element)
    if (doc === null) throw new Error('LSP 定位结果里有不是对象的项')
    if (typeof doc.targetUri === 'string' && isRange(doc.targetSelectionRange)) {
      out.push({ uri: doc.targetUri, range: toRange(doc.targetSelectionRange) })
      continue
    }
    if (typeof doc.uri === 'string' && isRange(doc.range)) {
      out.push({ uri: doc.uri, range: toRange(doc.range) })
      continue
    }
    throw new Error('LSP 定位结果里既不是 Location 也不是 LocationLink')
  }
  return out
}

/**
 * 归并 hover：`MarkupContent` 取 `value`；字符串形式的 `MarkedString` 原样；
 * 带 `language` 的 `MarkedString` 渲染成围栏代码块；数组用空行连接。空内容返回 null。
 */
export function normalizeHover(payload: unknown): LspHover | null {
  if (payload === null || payload === undefined) return null
  const doc = asRecord(payload)
  if (doc === null) throw new Error('LSP hover 结果不是对象')
  const contents = renderHoverContents(doc.contents)
  if (contents === '') return null
  if (doc.range === undefined) return { contents }
  if (!isRange(doc.range)) throw new Error('LSP hover 结果里的 range 畸形')
  return { contents, range: toRange(doc.range) }
}

/** 三种 `Hover.contents` 编码渲染成一段文本。 */
function renderHoverContents(contents: unknown): string {
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map((item) => renderMarkedString(item)).join('\n\n')
  }
  const doc = asRecord(contents)
  if (doc === null) return ''
  if ((doc.kind === 'markdown' || doc.kind === 'plaintext') && typeof doc.value === 'string') return doc.value
  if (typeof doc.language === 'string' && typeof doc.value === 'string') {
    return renderMarkedString({ language: doc.language, value: doc.value })
  }
  return ''
}

/** 一个 `MarkedString`：字符串原样，对象渲染成围栏代码块。 */
function renderMarkedString(value: unknown): string {
  if (typeof value === 'string') return value
  const doc = asRecord(value)
  if (doc !== null && typeof doc.language === 'string' && typeof doc.value === 'string') {
    return `\`\`\`${doc.language}\n${doc.value}\n\`\`\``
  }
  return ''
}

/** 把服务器给的诊断数组归并成 {@link LspDiagnostic}（缺 severity 按 ERROR 算，与 hermes 一致）。 */
export function normalizeDiagnostics(payload: unknown): LspDiagnostic[] {
  if (!Array.isArray(payload)) return []
  const out: LspDiagnostic[] = []
  for (const item of payload) {
    const doc = asRecord(item)
    if (doc === null || !isRange(doc.range)) continue
    const severity = typeof doc.severity === 'number' ? doc.severity : 1
    out.push({
      severity,
      message: typeof doc.message === 'string' ? doc.message : '',
      ...(doc.code === undefined || doc.code === null ? {} : { code: String(doc.code) }),
      ...(typeof doc.source === 'string' ? { source: doc.source } : {}),
      range: toRange(doc.range),
    })
  }
  return out
}

/** 诊断的身份：增量比对靠它（严重度、编码、来源、原文、整条区间）。 */
export function diagnosticKey(diagnostic: LspDiagnostic): string {
  const { start, end } = diagnostic.range
  return [
    diagnostic.severity,
    diagnostic.code ?? '',
    diagnostic.source ?? '',
    diagnostic.message,
    start.line,
    start.character,
    end.line,
    end.character,
  ].join('\u0001')
}
