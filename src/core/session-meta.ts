/**
 * 会话展示属性（sidecar）：标题改名、置顶、归档时间、分叉来源，按会话 uuid
 * 存进 `~/.dsc/sessions/meta.json`。
 *
 * 为什么不写进 jsonl：会话日志是 append-only 重放格式，改历史行或追加展示行
 * 都会让「模型看到的」与「日志记的」对不上。展示属性只在列表投影时用，
 * 单独一个文件最省事，而且归档移动文件也不影响（键是 uuid 不是路径）。
 *
 * @module dsc/core/session-meta
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { withExclusiveLock } from './lockfile.js'

/** 单个会话的展示属性；全部字段可选，缺省即「没有该属性」。 */
export interface SessionMetaRecord {
  /** 用户改过的标题；没有就用日志里首条用户消息推导。 */
  title?: string
  /** 置顶时间（毫秒）；有值即置顶，值用于组内置顶之间的排序。 */
  pinnedAt?: number
  /** 归档时间（毫秒）；归档列表按它倒序。 */
  archivedAt?: number
  /** 分叉来源会话的 uuid。 */
  forkedFrom?: string
}

/** meta.json 磁盘结构（带版本号，方便以后加字段时判断旧文件）。 */
interface SessionMetaFile {
  version: number
  sessions: Record<string, SessionMetaRecord>
}

const META_VERSION = 1

/**
 * sidecar 路径。这里不复用 `session.ts` 的 `sessionsRoot()`：那个文件本身要
 * 读写这份 sidecar，互相 import 会绕成环；目录布局与 `core/prefs.ts` 等
 * 模块一样，各自从 `~/.dsc` 起算。
 */
export function sessionMetaPath(): string {
  return join(homedir(), '.dsc', 'sessions', 'meta.json')
}

/**
 * 读全部展示属性。文件损坏或不存在都当空表（不致命：列表还能照常投影），
 * 但下一次写入会把坏文件覆盖掉。
 */
export function readSessionMeta(): Record<string, SessionMetaRecord> {
  const file = sessionMetaPath()
  if (!existsSync(file)) return {}
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionMetaFile>
    if (doc.version !== META_VERSION || typeof doc.sessions !== 'object' || doc.sessions === null) return {}
    const out: Record<string, SessionMetaRecord> = {}
    for (const [id, record] of Object.entries(doc.sessions)) {
      if (typeof record !== 'object' || record === null) continue
      const entry: SessionMetaRecord = {}
      if (typeof record.title === 'string' && record.title !== '') entry.title = record.title
      if (typeof record.pinnedAt === 'number') entry.pinnedAt = record.pinnedAt
      if (typeof record.archivedAt === 'number') entry.archivedAt = record.archivedAt
      if (typeof record.forkedFrom === 'string') entry.forkedFrom = record.forkedFrom
      out[id] = entry
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 改一个会话的展示属性：传 null 表示删掉该字段（例如取消置顶）。
 * 整表重写（文件很小），返回写完后的全表。
 *
 * T30：读改写包在同一把跨进程锁里（两个窗口同时改名/归档会互相抹掉对方的字段），
 * 写盘改成「临时文件 + 原子替换」——并发读者永远看到完整的旧表或新表，而不是半截 JSON。
 *
 * @param id 会话 uuid（不是 jsonl 路径，归档移动文件后仍然认得）
 * @param patch 要改的字段；值为 null 的字段被删除
 */
export function patchSessionMeta(id: string, patch: Partial<Record<keyof SessionMetaRecord, string | number | null>>): Record<string, SessionMetaRecord> {
  return withExclusiveLock(sessionMetaPath(), '会话属性正被另一个 Muse Code 进程修改，稍后再试', () => {
    const all = readSessionMeta()
    const record: SessionMetaRecord = { ...(all[id] ?? {}) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete record[key as keyof SessionMetaRecord]
      else if (key === 'title') record.title = String(value)
      else if (key === 'pinnedAt' || key === 'archivedAt') record[key] = Number(value)
      else if (key === 'forkedFrom') record.forkedFrom = String(value)
    }
    if (Object.keys(record).length === 0) delete all[id]
    else all[id] = record
    mkdirSync(join(homedir(), '.dsc', 'sessions'), { recursive: true })
    const target = sessionMetaPath()
    const temp = `${target}.tmp`
    writeFileSync(temp, JSON.stringify({ version: META_VERSION, sessions: all } satisfies SessionMetaFile, null, 2), 'utf8')
    renameSync(temp, target)
    return all
  })
}

/** 会话彻底删掉时清掉它的展示属性，避免 meta.json 无限膨胀。 */
export function dropSessionMeta(id: string): Record<string, SessionMetaRecord> {
  return patchSessionMeta(id, { title: null, pinnedAt: null, archivedAt: null, forkedFrom: null })
}
