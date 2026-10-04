/**
 * TUI 输入历史的持久化：`~/.dsc/.tui-history`，一行一条（多行输入压平成空格存），
 * 上限 200 条，新的在前。启动读一次，提交后整表重写（200 行以内，写盘成本可忽略）。
 * 文件坏了当空历史处理，绝不因它起不来。遵守 DSC_HOME。
 *
 * @module dsc/app/history-store
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DSC_HOME } from '../core/path-policy.js'

const HISTORY_FILE = join(DSC_HOME, '.tui-history')
const HISTORY_LIMIT = 200

/** 读历史（新的在前）；没有文件或文件坏了给空表。 */
export function loadHistory(): string[] {
  try {
    return readFileSync(HISTORY_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .reverse()
  } catch {
    return []
  }
}

/** 记一条（去重置顶；多行压平）。 */
export function recordHistory(existing: string[], entry: string): string[] {
  const flat = entry.replace(/[\r\n]+/g, ' ').trim()
  if (flat === '') return existing
  const next = [flat, ...existing.filter((line) => line !== flat)].slice(0, HISTORY_LIMIT)
  try {
    mkdirSync(dirname(HISTORY_FILE), { recursive: true })
    // 文件里旧的在前、新的在后（追加习惯），读的时候 reverse 回来
    writeFileSync(HISTORY_FILE, `${[...next].reverse().join('\n')}\n`, 'utf8')
  } catch {
    // 写不进去就只在进程内有效，不影响输入
  }
  return next
}
