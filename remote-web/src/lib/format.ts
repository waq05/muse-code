/**
 * 纯展示用的格式化：时间、路径、token 数、工具参数摘要。
 * 全部无副作用，测不测都不影响渲染逻辑（界面没有测试，所以这里保持「一眼看懂」）。
 */

/** 路径尾段（Windows 与 POSIX 的分隔符都认）。 */
export function pathTail(path: string, segments = 2): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  if (parts.length === 0) return path
  return parts.slice(-segments).join('/')
}

/** 文件/目录名（末段）。 */
export function pathName(path: string): string {
  return pathTail(path, 1)
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 24 小时制 HH:MM。 */
export function formatClock(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return ''
  const date = new Date(ts)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 会话列表用的人话时间：刚刚 / N 分钟前 / 今天 HH:MM / 昨天 HH:MM / MM-DD。 */
export function formatWhen(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts) || ts <= 0) return ''
  const now = Date.now()
  const diff = now - ts
  if (diff >= 0 && diff < 60_000) return '刚刚'
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const date = new Date(ts)
  const today = new Date(now)
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  if (sameDay) return formatClock(ts)
  const yesterday = new Date(now - 86_400_000)
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  if (isYesterday) return `昨天 ${formatClock(ts)}`
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** token 数的紧凑写法：1234 → 1.2k，12345 → 12k。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(Math.round(value))
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** 一行用量小字：`↑1.2k ↓340`。 */
export function usageLine(usage: { inputTokens: number; outputTokens: number }): string {
  return `↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)}`
}

/** 耗时：1.2s / 340ms / 1m12s。 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m${pad(seconds % 60)}s`
}

/**
 * 工具参数的一句话摘要：优先取 JSON 里有信息量的第一个标量字段
 * （path / command / pattern / url …），没有就退回原始文本首行。
 *
 * 为什么要挑：`argsText` 是模型给的原始 JSON，直接摊在卡片标题上会很长；
 * 审批卡与工具卡都需要「一眼看出它在动什么」。
 */
export function summarizeArgs(argsText: string, limit = 80): string {
  const text = argsText.trim()
  if (text === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return firstLine(text, limit)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return firstLine(typeof parsed === 'string' ? parsed : text, limit)
  }
  const record = parsed as Record<string, unknown>
  const preferred = ['command', 'path', 'file_path', 'filePath', 'pattern', 'url', 'query', 'prompt', 'text']
  for (const key of preferred) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return firstLine(value, limit)
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim() !== '') return firstLine(value, limit)
  }
  return firstLine(text, limit)
}

function firstLine(text: string, limit: number): string {
  const line = text.split('\n', 1)[0] ?? ''
  const trimmed = line.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}

/** 条目在列表里的 key：id 只在同一份快照内唯一，所以 kind + id + 序号一起当键。 */
export function entryKey(kind: string, id: number, index: number): string {
  return `${kind}-${id}-${index}`
}

/** 会话显示名：用户改过的标题优先，其次 cwd 尾段，最后退回 id 前 8 位。 */
export function sessionTitle(session: { id: string; cwd: string; title?: string }): string {
  const title = session.title?.trim()
  if (title !== undefined && title !== '') return title
  if (session.cwd.trim() !== '') return pathName(session.cwd)
  return session.id.slice(0, 8)
}
