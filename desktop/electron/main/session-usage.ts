/**
 * 会话用量的只读投影：壳进程直接读宿主写的 `~/.dsc/usage/usage.jsonl`
 * （每次模型请求追加一行，格式见 dsc 的 core/usage-log.ts）。
 *
 * 为什么在壳里读而不是问宿主：宿主那侧的实现与协议白名单都在 dsc 的
 * src/plugins 下，本轮改动不碰那一层；而这份日志本来就是纯数据文件，
 * 壳进程读它只多一次 IO，既不写文件也不改宿主的任何运行状态。
 *
 * 只读是本模块的硬约束：不写日志、不碰会话 jsonl、失败一律返回 null
 * （底部状态栏对应那段自然省略，比显示一个错数好）。
 *
 * @module desktop/main/session-usage
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export interface SessionUsageView {
  /** 这个会话在日志里的模型请求条数（含切到本进程之前的历史请求）。 */
  requests: number
  inputTokens: number
  outputTokens: number
  /**
   * 最后一次请求的输入 token：每次请求都会重发完整上下文，
   * 所以这就是此刻的上下文占用（服务端真值，不是估算）。
   */
  lastInputTokens: number
  /** 最后一次请求落盘的时刻（毫秒）；没有时间戳的行记 0。 */
  lastAt: number
}

/** 用量日志路径（与宿主 core/usage-log.ts 的 usageFile() 同一个文件）。 */
function usageFile(): string {
  return join(app.getPath('home'), '.dsc', 'usage', 'usage.jsonl')
}

/**
 * 按会话 id 汇总用量日志；这个会话一条记录都没有时返回 null。
 *
 * 逐行扫描：文件每行约 100 字节，一次全读再筛比建索引简单，热路径上
 * 也只在「切会话」和「每轮结束」各跑一次（见渲染层 StatusBar 的取数时机）。
 */
export function readSessionUsage(sessionId: string): SessionUsageView | null {
  if (sessionId === '') return null
  const file = usageFile()
  if (!existsSync(file)) return null
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // 刚写盘/被别的进程占着：这一拍给不出统计，下一次再读
    return null
  }
  const view: SessionUsageView = { requests: 0, inputTokens: 0, outputTokens: 0, lastInputTokens: 0, lastAt: 0 }
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue
    let row: { t?: unknown; i?: unknown; o?: unknown; sid?: unknown }
    try {
      row = JSON.parse(line) as typeof row
    } catch {
      continue // 半截行跳过（与宿主 readUsageRecords 同一套容错）
    }
    if (row.sid !== sessionId) continue
    if (typeof row.i !== 'number' || typeof row.o !== 'number') continue
    const at = typeof row.t === 'number' ? row.t : 0
    view.requests += 1
    view.inputTokens += row.i
    view.outputTokens += row.o
    // 「最后一次」按时间戳取，不靠文件顺序：追加写不保证同一毫秒里的先后
    if (at >= view.lastAt) {
      view.lastAt = at
      view.lastInputTokens = row.i
    }
  }
  return view.requests === 0 ? null : view
}
