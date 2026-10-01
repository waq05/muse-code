/**
 * diff 行的语法高亮（对照 codex tui 的 diff_render 思路：整块高亮、超限降级）。
 *
 * 为什么按「整块代码」喂 shiki 而不是逐行：shiki 的解析器状态（多行字符串、块注释、
 * 缩进结构）是跨行的，逐行喂会把这类结构高亮碎掉。hunk 的行按出现顺序拼回一段代码，
 * 一次 codeToTokens 拿到每行的 token，再映射回各行——增删行交替处的语法流会有轻微
 * 错位（codex 的 syntect 同样如此），换来的是单行内的关键字/字符串/注释高亮基本全对。
 *
 * 超大 hunk 自动降级为纯文本（抄 codex 的防护线：高亮是有解析成本的，diff 面板的
 * 主任务是「看结构」，不是「看颜色」——降级不影响可用性）。
 *
 * @module desktop/renderer/diff-highlight
 */
import { getHighlighter, langForPath, loadLang } from './file-preview.js'

/** 高亮的规模上限（行数 / 字符数），超了整块返回 null（纯文本渲染）。 */
const MAX_HIGHLIGHT_LINES = 2000
const MAX_HIGHLIGHT_BYTES = 512 * 1024

/** 一行的高亮产物：每段 token 一条（html 是已转义并带双主题 CSS 变量的 <span>）。 */
export interface HighlightedLine {
  segments: string[]
}

/**
 * 把一段代码（通常是 hunk 行按行序拼接）高亮成逐行的 token HTML。
 * 没有对应语法 / 超限 / shiki 失败 → 返回 null，调用方回落纯文本。
 */
export async function highlightLines(code: string, path: string): Promise<HighlightedLine[] | null> {
  const lang = langForPath(path)
  if (lang === undefined) return null
  const lines = code.split('\n')
  if (lines.length > MAX_HIGHLIGHT_LINES || code.length > MAX_HIGHLIGHT_BYTES) return null
  try {
    // 表里没有这门语法时 loadLang 静默返回，下面的 codeToTokens 会抛「未装载」——
    // 与 shiki 自身的解析失败一起归到 null（纯文本回落），调用方不用区分原因。
    await loadLang(lang)
    const highlighter = await getHighlighter()
    const result = highlighter.codeToTokens(code, {
      lang,
      themes: { light: 'github-light', dark: 'one-dark-pro' },
      defaultColor: false,
    })
    return result.tokens.map((tokens) => ({
      segments: tokens.map((token) => {
        const style = token.htmlStyle ?? { color: token.color }
        const css = Object.entries(style)
          .map(([name, value]) => `${name}:${value}`)
          .join(';')
        return `<span style="${css}">${escapeHtml(token.content)}</span>`
      }),
    }))
  } catch {
    return null
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** token 内容是文件原文，拼进 innerHTML 前必须转义（shiki 只转义自己的结构，不代管 content）。 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}
