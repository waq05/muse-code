/**
 * 压缩摘要的机械加固件：锚点索引（正则从原文抽，不经模型改写）、
 * 真实用户原话逐字引用、细节找回指针。
 *
 * 为什么单独成模块：这三样是「摘要里不许走样」的最后一道保险，全是纯函数，
 * 可以脱离模型单独断言（见 shots/compact-check.mjs）。
 *
 * @module dsc/core/compact-anchors
 */
import type { ChatMessage } from './llm.js'
import { contentText } from './llm.js'

/** 摘要消息的开头标记。摘要本身也是一条 `role: 'user'` 的消息，靠它把真用户消息认出来。 */
export const SUMMARY_BANNER = '[先前对话的交接摘要（原文已压缩）]'

/** 锚点索引的标题。 */
const ANCHOR_HEADING = '## 锚点索引（正则从原文机械抽取）'
/** 锚点索引的脚注。 */
const ANCHOR_NOTE = '（以上标识符逐字来自被压缩的原文，引用时照抄，不要改写。）'
/** 用户原话区的标题。 */
const USER_HEADING = '## 用户原话（逐字引用，最新在前）'
/** 用户原话区的脚注。 */
const USER_NOTE = '（上面是压缩区里真实用户说过的话，逐字引用；摘要的转述与它们冲突时以这些话为准。）'
/** 细节找回区的标题。 */
const RECOVERY_HEADING = '## 细节找回'
/** 截断标记。 */
const ELISION_MARKER = '……（后文省略）'
/** 单条用户原话最多引这么多字符，免得一次长粘贴吃掉整个预算。 */
const USER_MESSAGE_MAX_CHARS = 4000

/** 锚点索引的字符预算缺省值（可配 `compact.anchorBudgetChars`）。 */
export const DEFAULT_ANCHOR_BUDGET_CHARS = 6000

/** 用户原话引用的字符预算缺省值（可配 `compact.userQuoteBudgetChars`）。 */
export const DEFAULT_USER_QUOTE_BUDGET_CHARS = 8000

/** 认得出的源码/配置扩展名：文件锚点按它认文件，分支过滤按它排除网址里的路径。 */
const SOURCE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'py', 'rs', 'go',
  'md', 'yaml', 'yml', 'json', 'toml', 'sh', 'ps1', 'css', 'html',
]
const SOURCE_EXTENSION = new RegExp(`\\.(?:${SOURCE_EXTENSIONS.join('|')})$`, 'i')
/** 文件锚点：路径里允许反斜杠，dsc 在 Windows 上跑，日志里的路径多半是 `D:\a\b.ts`。 */
const FILE_PATTERN = new RegExp(
  `\\b[\\w.\\\\/-]*[\\\\/][\\w.-]+\\.(?:${SOURCE_EXTENSIONS.join('|')})\\b`,
  'g',
)

/** 一次锚点命中。 */
interface AnchorMatch {
  /** 命中的原文（已去掉尾随标点）。 */
  value: string
  /** 命中在原文里的起始下标。 */
  index: number
}

/** 一类锚点。 */
interface AnchorCategory {
  /** 这一行开头的标签。 */
  label: string
  pattern: RegExp
  /** 这一类最多列几项。 */
  cap: number
  /** 额外的排除判据；不给就全收。 */
  keep?: (text: string, match: AnchorMatch) => boolean
}

/** uuid 里十六进制字符的判据。 */
const HEX = /[0-9a-fA-F]/

/**
 * uuid 末段是 12 位十六进制，正中 commit 的 `\b[0-9a-f]{9,40}\b`。
 * 前一位是 `-`、再前一位还是十六进制字符，就说明这串是 uuid 尾巴而不是 commit。
 */
function notUuidTail(text: string, match: AnchorMatch): boolean {
  return !(match.index >= 2 && text[match.index - 1] === '-' && HEX.test(text[match.index - 2]))
}

/**
 * 网址里的路径会被分支名正则带出来（`example.com/docs/compact.ts` 命中 `docs/compact.ts`）。
 * 前一位是路径分隔符、点或连字符时，它是一段更长路径的一部分，不是分支名；
 * 以已知源码扩展名结尾的同样不是分支名。
 */
function notPathFragment(text: string, match: AnchorMatch): boolean {
  if (match.index > 0 && /[\w./\\-]/.test(text[match.index - 1])) return false
  return !SOURCE_EXTENSION.test(match.value)
}

/** 锚点分类：照 hermes 的分类，去掉 dsc 里不存在的 `@handle`。 */
const ANCHOR_CATEGORIES: AnchorCategory[] = [
  { label: 'PR 号与 issue', pattern: /#\d{3,6}\b/g, cap: 120 },
  { label: 'commit', pattern: /\b[0-9a-f]{9,40}\b/g, cap: 40, keep: notUuidTail },
  {
    label: '分支',
    pattern: /\b(?:fix|feat|docs|refactor|chore|salvage|ent)\/[A-Za-z0-9._/-]{3,60}/g,
    cap: 40,
    keep: notPathFragment,
  },
  { label: '文件', pattern: FILE_PATTERN, cap: 80 },
  {
    label: '报错',
    // errno 只认 Node / Windows 上真会冒出来的那几个：全大写标识符（EVENT 这类）不该被当报错。
    pattern: /\b(?:[A-Z][a-zA-Z]*(?:Error|Exception)|ENOENT|EACCES|EPERM|ENOSPC|EEXIST|EBUSY|EMFILE|ETIMEDOUT|ECONNREFUSED|ECONNRESET|SIGKILL|SIGTERM|SIGINT|Traceback)\b[^\n]{0,90}/g,
    cap: 40,
  },
  { label: '链接', pattern: /https?:\/\/[^\s)"']{10,110}/g, cap: 30 },
]

/** 抓一类锚点：去重、按出现次数排（次数相同按最后一次出现的先后），带 `(xN)` 计数。 */
function harvest(text: string, category: AnchorCategory): string[] {
  const counts = new Map<string, number>()
  const lastSeen = new Map<string, number>()
  for (const found of text.matchAll(category.pattern)) {
    const value = found[0].trim().replace(/[.,;:]+$/, '')
    const match: AnchorMatch = { value, index: found.index ?? 0 }
    if (value === '' || category.keep?.(text, match) === false) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
    lastSeen.set(value, match.index)
  }
  return [...counts.keys()]
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || (lastSeen.get(b) ?? 0) - (lastSeen.get(a) ?? 0))
    .slice(0, category.cap)
    .map((value) => ((counts.get(value) ?? 0) > 1 ? `${value}(x${counts.get(value) ?? 0})` : value))
}

/**
 * 从被压缩的原文里抽锚点索引：PR 号、commit、分支、文件、报错、链接。
 * @param text - 压缩区原文。**不要**传截断过的转写——工具参数被截到 120 字符时，路径与报错会断在半截上。
 * @param budgetChars - 整段索引（含标题与脚注）的字符预算；装不下的整类丢掉，不切半行。
 * @returns 形如 `\n\n## 锚点索引……\nPR 号与 issue：#12\n……` 的文本；一条都没抽到或预算装不下标题时返回空串。
 */
export function buildAnchorIndex(text: string, budgetChars: number): string {
  const head = `\n\n${ANCHOR_HEADING}\n`
  const note = `\n${ANCHOR_NOTE}`
  let body = ''
  for (const category of ANCHOR_CATEGORIES) {
    const values = harvest(text, category)
    if (values.length === 0) continue
    const next = body === '' ? `${category.label}：${values.join('、')}` : `${body}\n${category.label}：${values.join('、')}`
    if (head.length + next.length + note.length > budgetChars) break
    body = next
  }
  return body === '' ? '' : `${head}${body}${note}`
}

/**
 * 这条消息是不是「真用户说的话」。
 * 压缩后的摘要本身在内存里就是一条 `role: 'user'` 的消息，不能把它当用户原话再引一遍。
 * @param message - 待判消息。
 * @returns 是真实用户消息（有正文、且不是摘要）返回 true。
 */
export function isRealUserMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false
  const text = contentText(message.content).trim()
  return text !== '' && !text.startsWith(SUMMARY_BANNER)
}

/**
 * 截断一段文本，截断处补省略标记。
 * @param text - 原文。
 * @param maxChars - 结果的最大字符数。
 * @returns 长度不超过 `maxChars` 的文本；空间连省略标记都放不下时只按长度切，不补标记。
 */
export function elide(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  if (maxChars <= ELISION_MARKER.length) return clip(text, maxChars)
  return `${clip(text, maxChars - ELISION_MARKER.length)}${ELISION_MARKER}`
}

/** 按长度切字符串，别把代理对（emoji 这类）切成半个。 */
function clip(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const code = text.charCodeAt(maxChars - 1)
  const cut = code >= 0xd800 && code <= 0xdbff ? maxChars - 1 : maxChars
  return text.slice(0, cut)
}

/** 每行前面加引用号。 */
function quoteLines(text: string): string {
  return `> ${text.split('\n').join('\n> ')}`
}

/**
 * 逐字引用压缩区里的真实用户消息（最新在前）。
 * @param messages - 压缩区的消息；其中形如摘要的「假 user」会被排除。
 * @param budgetChars - 整段引用（含标题与脚注）的字符预算；超了就丢最老的几条，单条超长用省略号切断。
 * @returns 引用区文本；一条真用户消息都没有、或预算装不下标题时返回空串。
 */
export function collectVerbatimUserMessages(messages: readonly ChatMessage[], budgetChars: number): string {
  const head = `\n\n${USER_HEADING}\n`
  const note = `\n${USER_NOTE}`
  const room0 = budgetChars - head.length - note.length
  if (room0 <= 0) return ''
  const quotes: string[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRealUserMessage(message)) continue
    const text = contentText(message.content).trim()
    const gap = quotes.length === 0 ? 0 : 2
    const room = room0 - used - gap
    // 引用号占 `2 × 行数`，先把这块留出来，剩下的才是正文能用的字符数
    const limit = Math.min(USER_MESSAGE_MAX_CHARS, room - 2 * text.split('\n').length)
    if (limit <= 0) break
    const quoted = quoteLines(elide(text, limit))
    quotes.push(quoted)
    used += quoted.length + gap
  }
  return quotes.length === 0 ? '' : `${head}${quotes.join('\n\n')}${note}`
}

/** 细节找回指针要填的内容。 */
export interface RecoveryPointer {
  /** 这次折进摘要的消息条数。 */
  regionMessages: number
  /** 会话 jsonl 的路径：手上没有检索工具时读它。 */
  sessionFile: string
}

/**
 * 生成「细节找回」指针：被折掉的原文还在会话日志里，需要细节时去哪儿看。
 * 写成条件句：当前有 `session_search` 工具就用它，没有就直接读 jsonl——不许硬依赖某个工具存在。
 * @param pointer - 折掉多少条、日志在哪个文件。
 * @returns 附在摘要末尾的指针文本。
 */
export function buildRecoveryFooter(pointer: RecoveryPointer): string {
  return `\n\n${RECOVERY_HEADING}\n`
    + `这次折掉的 ${pointer.regionMessages} 条消息原文完整留在会话日志里：${pointer.sessionFile}。\n`
    + '摘要没写到的细节（完整命令输出、文件内容、报错原文、更早的思路）需要时：'
    + '当前会话有 session_search 工具就用它按关键词检索，没有这个工具就直接读上面这个 jsonl 文件。\n'
    + '查得到的东西不要猜。'
}
