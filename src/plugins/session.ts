/**
 * session 插件：provide `session` 服务（当前会话 + 列表缓存 + 会话库操作）。
 * 逻辑迁自 v2 adapter/core-runtime 的初始会话/openSessionNow/refreshSessions 段。
 * 会话切换与错误提示走 dsc/session-open、dsc/notice 事件（避免与 transcript 循环依赖）。
 *
 * 列表操作（归档、恢复、永久删除、改名、置顶、分叉）只动磁盘文件与
 * `sessions/meta.json` sidecar，不碰 jsonl 本体，也不改当前会话的状态机。
 *
 * @module dsc/plugins/session
 */
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import {
  Session,
  archiveSession,
  archivedRoot,
  countTrashFiles,
  forkSession,
  listArchivedSessions,
  listSessions,
  loadLastSessionPath,
  purgeSession,
  readUserMessages,
  restoreSession,
  saveLastSession,
  trashRoot,
} from '../core/session.js'
import { patchSessionMeta } from '../core/session-meta.js'
import type { SessionListItem } from '../core/session.js'
import { errText } from '../adapter/transcript.js'
import type {
  ArchivedPage,
  SessionForkResult,
  SessionOpenPayload,
  SessionService,
  SessionSummary,
  SettingsMutation,
} from '../services/types.js'

export interface SessionPluginOptions {
  cwd?: string
  /** 'auto' = last-session 指针；路径 = 指定 jsonl；null = 新建。 */
  resumeSessionPath?: string | null
}

export const sessionPlugin: Plugin.Object<SessionPluginOptions> = {
  name: 'session',
  provide: 'session',
  apply(ctx, options) {
    const cwd = options.cwd ?? process.cwd()

    // ---- 初始会话（同步确定；resume 失败回退新会话并记 startupNote） ----
    let session: Session
    let startupNote: string | null = null
    const resume = options.resumeSessionPath ?? null
    const pointer = resume === 'auto' ? loadLastSessionPath() : resume
    // 指针可能指向一个从没发过消息、因此没在磁盘上留过文件的会话：这种情况安静地开新会话
    const resumePath = pointer !== null && existsSync(pointer) ? pointer : null
    try {
      session = resumePath !== null ? Session.load(resumePath) : Session.create(cwd)
    } catch (error) {
      session = Session.create(cwd)
      startupNote = `恢复会话失败（${errText(error)}），已开新会话`
    }
    saveLastSession(session)
    const resumedStartup = startupNote === null && resumePath !== null

    // ---- 会话列表缓存 ----
    let sessions: SessionSummary[] = []
    let loading = false

    const service: SessionService = {
      current() {
        return session
      },
      get sessions() {
        return sessions
      },
      get loading() {
        return loading
      },
      get resumedStartup() {
        return resumedStartup
      },
      get startupNote() {
        return startupNote
      },
      async open(filePath?: string) {
        // 已经在看这条会话：no-op（对齐 dsh 的会话实例常驻 + openState 短路）。
        // 重开一遍不是无害的刷新——它会重建 Session（加载时的中断修复给还在跑的回合
        // 补「结果未知」合成件），紧接着把正在跑的 agent 的会话顶掉，日志里同一 callId
        // 就可能留下两条结果。点击自己正在看的会话要老老实实什么都不做。
        if (filePath !== undefined && filePath === session.filePath) return
        try {
          let next: Session
          if (filePath === undefined) {
            next = Session.create(cwd)
          } else {
            // 常驻 agent 还攥着这条会话（后台回合在跑/刚切走没多久）：直接复用那个
            // 实例——再 Session.load 一遍既拿不到写租约（agent 正攥着），又会造出
            // 同一文件的两个内存副本。0.6.48 常驻多 agent 的关键接缝。
            const resident = ctx.get('agent')?.sessionFor(filePath)
            next = resident ?? Session.load(filePath)
          }
          session = next
          saveLastSession(session)
          ctx.emit('dsc/session-open', { session: next, filePath } satisfies SessionOpenPayload)
        } catch (error) {
          ctx.emit('dsc/notice', `会话打开失败：${errText(error)}`)
        }
        ctx.emit('dsc/changed')
      },
      async refresh() {
        loading = true
        ctx.emit('dsc/changed')
        try {
          // 归档区的会话也进这份缓存：侧栏的「筛选会话」要能原地在活动区与归档区之间切，
          // 由面板按 archivedAt 决定显示哪些。归档相关的写操作仍只认活动区路径。
          sessions = [
            ...listSessions().map((item) => toSummary(item)),
            ...listArchivedSessions().map((item) => toSummary(item, item.archivedAt ?? item.updatedAt)),
          ]
        } catch (error) {
          ctx.emit('dsc/notice', `会话列表读取失败：${errText(error)}`)
        }
        loading = false
        ctx.emit('dsc/changed')
      },

      // ── 会话库操作（归档 / 恢复 / 删除 / 改名 / 置顶 / 分叉） ──────────────
      async archive(paths) {
        const blocked = paths.filter((path) => path === session.filePath)
        if (blocked.length > 0) return { ok: false, error: '当前打开的会话不能归档，先切到别的会话' }
        const agent = ctx.get('agent')
        const done: string[] = []
        const failed: string[] = []
        for (const path of paths) {
          // 重试收敛：上次批量归档半途而废时，已归档的（在归档区里，或已从原位置挪走）
          // 跳过不算失败也不重复报错
          if (path.startsWith(archivedRoot() + '\\') || path.startsWith(archivedRoot() + '/')) continue
          if (!existsSync(path)) continue
          try {
            // 常驻 agent 先收摊再挪文件（对齐 dsh 的 stopActivity）：后台在跑的会话
            // 握着打开的写流，直接 rename 是原生 EPERM，整批跟着炸。
            await agent?.stop(path)
            archiveSession(path)
            done.push(path)
          } catch (error) {
            failed.push(`${basename(path)}（${errText(error)}）`)
          }
        }
        if (failed.length > 0) {
          return { ok: false, error: `已归档 ${done.length} 个，${failed.length} 个失败：${failed.join('；')}` }
        }
        if (done.length === 0) return { ok: true, notice: '没有要归档的会话（可能已经都在归档区）' }
        return { ok: true, notice: `已归档 ${done.length} 个会话（设置 → 归档 里可以恢复）` }
      },

      archived(): ArchivedPage {
        try {
          return {
            items: listArchivedSessions().map((item) => ({
              path: item.path,
              cwd: item.cwd,
              ...(item.title !== undefined ? { title: item.title } : {}),
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              archivedAt: item.archivedAt ?? item.updatedAt,
            })),
            trashDir: trashRoot(),
            trashCount: countTrashFiles(),
          }
        } catch (error) {
          ctx.emit('dsc/notice', `归档列表读取失败：${errText(error)}`)
          return { items: [], trashDir: trashRoot(), trashCount: 0 }
        }
      },

      restore(paths) {
        try {
          for (const path of paths) restoreSession(path)
          return { ok: true, notice: `已恢复 ${paths.length} 个会话` }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      },

      purge(paths) {
        if (paths.some((path) => path === session.filePath)) {
          return { ok: false, error: '当前打开的会话不能删除，先切到别的会话' }
        }
        try {
          for (const path of paths) purgeSession(path)
          return { ok: true, notice: `已删除 ${paths.length} 个会话（进了回收站，30 天后自动清空）` }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      },

      rename(path, title) {
        const name = title.replace(/\s+/g, ' ').trim().slice(0, 60)
        if (name === '') return { ok: false, error: '会话名字不能是空的' }
        try {
          patchSessionMeta(uuidOf(path), { title: name })
          return { ok: true, notice: `已改名为「${name}」` }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      },

      setPinned(path, pinned) {
        try {
          patchSessionMeta(uuidOf(path), { pinnedAt: pinned ? Date.now() : null })
          return { ok: true, notice: pinned ? '已置顶这个会话' : '已取消置顶' }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      },

      userMessages(path) {
        try {
          return readUserMessages(path)
        } catch (error) {
          ctx.emit('dsc/notice', `读取会话消息失败：${errText(error)}`)
          return []
        }
      },

      fork(path, index): SessionForkResult {
        try {
          return { ok: true, path: forkSession(path, index) }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      },
    }

    ctx.on('dsc/exit', () => session.close())
    ctx.provide('session', service)
  },
}

/** 会话 jsonl 的 `<uuid>.jsonl` 文件名 → uuid（sidecar 的键）。 */
function uuidOf(filePath: string): string {
  return basename(filePath, '.jsonl')
}

/** 会话库扫描结果 → 侧栏与选择器用的一行；传 archivedAt 表示它来自归档区。 */
function toSummary(item: SessionListItem, archivedAt?: number): SessionSummary {
  return {
    id: item.path,
    cwd: item.cwd,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.pinnedAt !== undefined ? { pinnedAt: item.pinnedAt } : {}),
    ...(archivedAt !== undefined ? { archivedAt } : {}),
  }
}
