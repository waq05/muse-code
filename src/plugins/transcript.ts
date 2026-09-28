/**
 * transcript 插件：provide `transcript` 服务（core 事件折叠 + RuntimeSnapshot 快照源）。
 * 快照组装迁自 v2 adapter/core-runtime 的 getSnapshot/invalidate 段——turnState 全部
 * 由 transcript 自身事件驱动状态 + approval 挂起视图推导，sessions/模型名读服务。
 *
 * 事件职责：监听 dsc/changed（失效缓存）、dsc/notice（写 system 条目）、
 * dsc/session-open（清空条目并写会话切换提示）。
 *
 * @module dsc/plugins/transcript
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { Transcript } from '../adapter/transcript.js'
import type { RuntimeSnapshot, StatusView } from '../contract.js'
import type { TranscriptService } from '../services/types.js'

export const transcriptPlugin: Plugin.Object = {
  name: 'transcript',
  inject: ['session', 'approval', 'llm'],
  provide: 'transcript',
  apply(ctx) {
    const transcript = new Transcript()

    // ---- 快照缓存（引用在两次 notify 之间稳定，遵循 useSyncExternalStore 语义） ----
    const listeners = new Set<() => void>()
    let snapshot: RuntimeSnapshot | null = null
    const invalidate = (): void => {
      snapshot = null
      for (const listener of [...listeners]) listener()
    }

    ctx.on('dsc/changed', () => invalidate())
    ctx.on('dsc/notice', (text) => {
      transcript.system(text)
      invalidate()
    })
    ctx.on('dsc/session-open', ({ filePath }) => {
      transcript.clear()
      if (filePath !== undefined) {
        // 恢复会话：历史消息重放进条目（桌面端/TUI 点历史会话要能回看内容）
        transcript.replayHistory(ctx.session.current().messages, ctx.session.current().toolErrors)
        transcript.system(`已恢复会话 ${ctx.session.current().meta.id.slice(0, 8)}`)
      } else {
        transcript.system(
          `新会话 ${ctx.session.current().meta.id.slice(0, 8)}（模型 ${ctx.llm.provider}/${ctx.llm.model}）`,
        )
      }
      invalidate()
    })

    const service: TranscriptService = {
      emit(event) {
        if (transcript.reduce(event)) invalidate()
      },
      system(text) {
        transcript.system(text)
        invalidate()
      },
      replayHistory(messages, toolErrors) {
        const changed = transcript.replayHistory(messages, toolErrors)
        if (changed) invalidate()
        return changed
      },
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      touch() {
        invalidate()
      },
      getSnapshot() {
        if (snapshot === null) {
          const turnState: StatusView['turnState'] =
            ctx.approval.pendingView() !== null
              ? 'awaiting-approval'
              : transcript.inTurn
                ? transcript.working
                  ? 'working'
                  : 'thinking'
                : 'idle'
          snapshot = {
            entries: [...transcript.entries, ...transcript.liveEntries()],
            status: {
              sessionId: ctx.session.current().meta.id,
              model: ctx.llm.model,
              effort: ctx.llm.effort,
              policy: ctx.approval.policy,
              turnState,
              usage: transcript.usage,
            },
            pendingApproval: ctx.approval.pendingView(),
            sessions: ctx.session.sessions,
            sessionsLoading: ctx.session.loading,
          }
        }
        return snapshot
      },
    }

    ctx.provide('transcript', service)
  },
}
