/**
 * transcript 插件：provide `transcript` 服务（core 事件折叠 + RuntimeSnapshot 快照源）。
 * 快照组装迁自 v2 adapter/core-runtime 的 getSnapshot/invalidate 段——turnState 全部
 * 由 transcript 自身事件驱动状态 + 各界面片段推导，sessions/模型名读服务。
 *
 * 事件职责：监听 dsc/changed（失效缓存）、dsc/notice（写 system 条目）、
 * dsc/session-open（清空条目并写会话切换提示）。
 *
 * 快照里各功能点那块状态（模式、清单、计划、目标、卡片）不在这个文件里点名：
 * 它们由各功能点自己登记进 `surfaces` 注册表，这里只问注册表要全部片段。
 *
 * @module dsc/plugins/transcript
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { Transcript } from '../adapter/transcript.js'
import type { PlanView, RuntimeSnapshot, StatusView, TranscriptEntry } from '../contract.js'
import type { TranscriptService } from '../services/types.js'

export const transcriptPlugin: Plugin.Object = {
  name: 'transcript',
  inject: ['session', 'llm', 'surfaces'],
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
    ctx.on('dsc/plan', (plan) => {
      transcript.plan(plan)
      invalidate()
    })
    /**
     * 这次重放会不会得到与当前条目一模一样的条目表。
     *
     * 为什么要这个判断：`clear()` + `replayHistory()` 是整表重建，条目 id 从 1 重新发号；
     * 渲染层按 `key` 对账，同一个 key 上换成了别的条目类型就卸载重挂，于是折叠态回默认、
     * 正在流式的直播尾被抹掉。同一条会话被重复打开（桌面端启动、点击已在看的会话、
     * 宿主补发一次事件）时内容本来没变，重建纯属白做。
     *
     * 比对口径：只看重放会产出的那些条目。当前条目里还夹着 session-open 写的
     * 「已恢复会话」等 system 行（重放不产出 system 行），先摘掉再逐条对，
     * 顺带忽略 id 与时间戳——这两样每次重建都不一样，不能算内容变了。
     */
    const replayIsRedundant = (): boolean => {
      const current = ctx.session.current()
      if (current.messages.length === 0) return false
      const probe = new Transcript()
      probe.replayHistory(current.messages, current.toolErrors)
      return sameEntries(
        probe.entries.filter((entry) => entry.kind !== 'system'),
        transcript.entries.filter((entry) => entry.kind !== 'system'),
      )
    }

    ctx.on('dsc/session-open', ({ filePath }) => {
      // 重复打开同一条会话：条目一个字都不动（连「已恢复会话」那行提示也不重复写），
      // 否则这次重建会把渲染层重挂一遍。
      if (filePath !== undefined && replayIsRedundant()) return
      transcript.clear()
      if (filePath !== undefined) {
        // 恢复会话：历史消息重放进条目（桌面端/TUI 点历史会话能回看内容）
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
      plan(view: PlanView) {
        transcript.plan(view)
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
      getSnapshot(): RuntimeSnapshot {
        const cached = snapshot
        if (cached !== null) return cached
        const surfaces = ctx.surfaces.build()
        const turnState: StatusView['turnState'] =
          surfaces.pendingApproval !== null
            ? 'awaiting-approval'
            : transcript.inTurn
              ? transcript.working
                ? 'working'
                : 'thinking'
              : 'idle'
        const built: RuntimeSnapshot = {
          entries: [...transcript.entries, ...transcript.liveEntries()],
          status: {
            sessionId: ctx.session.current().meta.id,
            model: ctx.llm.model,
            effort: ctx.llm.effort,
            turnState,
            usage: transcript.usage,
          },
          surfaces,
          sessions: ctx.session.sessions,
          sessionsLoading: ctx.session.loading,
        }
        snapshot = built
        return built
      },
    }

    ctx.provide('transcript', service)
  },
}

/**
 * 两份条目表的「内容」是否一致：`id`（每次重建都从 1 重新发号）与 `ts`（同一份历史
 * 重放两次时刻会差几毫秒）不算内容，其余字段逐个比。
 * 为什么用 JSON 字符串比而不是逐字段写：条目是纯数据、没有函数与循环引用，
 * 序列化顺序由同一段代码产出，键序天然一致；逐字段写要跟着 contract 的六种条目改，
 * 加一个字段就会静静漏比。
 */
function sameEntries(left: readonly TranscriptEntry[], right: readonly TranscriptEntry[]): boolean {
  if (left.length !== right.length) return false
  return shape(left) === shape(right)
}

function shape(entries: readonly TranscriptEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => {
      const { id, ts, ...rest } = entry
      return rest
    }),
  )
}
