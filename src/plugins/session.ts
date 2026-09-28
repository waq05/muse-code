/**
 * session 插件：provide `session` 服务（当前会话 + 列表缓存）。
 * 逻辑迁自 v2 adapter/core-runtime 的初始会话/openSessionNow/refreshSessions 段。
 * 会话切换与错误提示走 dsc/session-open、dsc/notice 事件（避免与 transcript 循环依赖）。
 *
 * @module dsc/plugins/session
 */
import { join } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import { Session, listSessions, loadLastSessionPath, saveLastSession, sessionsRoot } from '../core/session.js'
import { errText } from '../adapter/transcript.js'
import type { SessionOpenPayload, SessionService, SessionSummary } from '../services/types.js'

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
    const resumePath = resume === 'auto' ? loadLastSessionPath() : resume
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
        try {
          const next = filePath === undefined ? Session.create(cwd) : Session.load(filePath)
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
          sessions = listSessions().map(
            (meta): SessionSummary => ({
              id: joinSessionPath(meta.cwd, meta.id),
              cwd: meta.cwd,
              createdAt: meta.createdAt,
              title: meta.title,
            }),
          )
        } catch (error) {
          ctx.emit('dsc/notice', `会话列表读取失败：${errText(error)}`)
        }
        loading = false
        ctx.emit('dsc/changed')
      },
    }

    ctx.on('dsc/exit', () => session.close())
    ctx.provide('session', service)
  },
}

/** 会话 cwd → jsonl 路径（sessions 列表的 id 即文件路径）。 */
function joinSessionPath(cwd: string, id: string): string {
  return join(sessionsRoot(), cwd.replace(/[\\/:]+/g, '-'), `${id}.jsonl`)
}
