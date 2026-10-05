/**
 * 启动提示只展示一次（0.6.64）：沙箱已就绪、会话索引就绪、远程待命、会话横幅
 * 这类「开机事实」每次启动都无条件重发进转录，用户嫌刷屏——这里给它们一个
 * 「同文不再说第二遍」的闸：key + 文本都和上次一致就跳过，文本变了（档位调整、
 * 索引增长、换了个进程接管）自动再说一次。
 *
 * 状态落在 `~/.dsc/boot-notices.json`（key → 上次文本），进程内再缓存一份；
 * 读写任何失败都按「没见过」处理（best-effort，绝不因为记录文件坏了挡启动）。
 *
 * @module dsc/core/boot-notices
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dscPath } from './path-policy.js'

/** 进程内缓存：key → 上次展示的文本。 */
const shown = new Map<string, string>()
/** 缓存是否已从磁盘装载过（首次调用时装载，之后只写不读）。 */
let loaded = false

function stateFile(): string {
  return dscPath('boot-notices.json')
}

function load(): void {
  loaded = true
  try {
    if (!existsSync(stateFile())) return
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') shown.set(key, value)
    }
  } catch {
    // 记录坏了就当全新开始：顶多多说一遍，不挡启动
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true })
    writeFileSync(stateFile(), `${JSON.stringify(Object.fromEntries(shown), null, 2)}\n`, 'utf8')
  } catch {
    // 写不进去（只读盘等）就本次生效、下次重启再说一遍——可接受
  }
}

/**
 * 这条启动提示要不要展示。返回 true = 展示（并记下）；同 key 同文本返回 false。
 * 注意：无论调用方是否真的把文本画了出来，这里都会记——发射点都是启动早期
 * 的无条件路径，「记了没画」只在转录被清的极端时序下发生，可接受。
 */
export function bootNoticeOnce(key: string, text: string): boolean {
  if (!loaded) load()
  if (shown.get(key) === text) return false
  shown.set(key, text)
  persist()
  return true
}
