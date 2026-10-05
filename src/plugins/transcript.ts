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
import { estimateSessionCostCny, isDeepseekProvider, isPeakHour } from '../core/pricing.js'
import { emptySegments } from '../core/token-estimate.js'
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

    /**
     * 跨会话运行状态面（0.6.48 常驻多 agent）：后台 agent 的状态点来源。
     * 键 = 会话 jsonl 路径。dsc/agent-status 事件驱动；当前查看会话的条目不进
     * 这张表——它的状态由 turnState/surfaces 推导（getSnapshot 合并时跳过）。
     * 「just-finished」是转录层自己造的值：后台会话收工时你没在看，侧栏亮
     * 「已完成」徽标，点开那个会话（session-open）就熄掉。
     */
    const backgroundStates = new Map<string, RuntimeSnapshot['sessionStates'][string]>()
    ctx.on('dsc/agent-status', ({ path, state }) => {
      if (state === 'idle') {
        const previous = backgroundStates.get(path)
        backgroundStates.delete(path)
        if (previous !== undefined && path !== ctx.session.current().filePath) {
          backgroundStates.set(path, 'just-finished')
        }
      } else {
        backgroundStates.set(path, state)
      }
      invalidate()
    })

    ctx.on('dsc/changed', () => invalidate())
    // 第二个参数是通知的类别：'compaction' = 「历史刚被压缩」的落点（compact 插件发）。
    // 本插件认这个类别给条目打压缩标记；不认识的类别按普通通知处理。
    // 事件可带会话归属（0.6.49）：后台会话发的通知/计划卡不进当前查看会话的转录，
    // 它们留在自己会话的 jsonl/状态里，切回去时由会话重放与 surface 恢复。缺省按当前会话。
    ctx.on('dsc/notice', (text, kind, sessionPath) => {
      if (sessionPath !== undefined && sessionPath !== ctx.session.current().filePath) return
      transcript.system(text, kind === 'compaction')
      invalidate()
    })
    ctx.on('dsc/plan', (plan, sessionPath) => {
      if (sessionPath !== undefined && sessionPath !== ctx.session.current().filePath) return
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
      probe.replayHistory(current.messages, current.toolErrors, current.fileChanges)
      return sameEntries(
        probe.entries.filter((entry) => entry.kind !== 'system' && entry.kind !== 'subagent'),
        transcript.entries.filter((entry) => entry.kind !== 'system' && entry.kind !== 'subagent'),
      )
    }

    ctx.on('dsc/session-open', ({ filePath }) => {
      const current = ctx.session.current()
      // 0.6.48：切回运行中的会话要把「回合中」状态种回来——那一轮的 turn/start
      // 发生在上次切走的期间，转录层没收到，重放日志也补不出这个纯内存状态。
      const seedTurn = (): void => {
        transcript.seedTurnState(ctx.get('agent')?.isRunning(current.filePath) ?? false)
      }
      /**
       * 0.6.60：把本会话还在干活的队友种回成子代理卡。卡片是纯内存条目（不落盘），
       * 重放补不出来；名册（team 服务）里有谁在干活，就先按名册数据铺一张头行卡，
       * 之后队友的事件流转发进来再原位刷新成瀑布。
       */
      const seedSubagents = (): void => {
        for (const mate of ctx.get('team')?.list() ?? []) {
          if (mate.state !== 'working' || mate.sessionId !== current.meta.id) continue
          transcript.reduce({
            type: 'subagent',
            row: {
              name: mate.name,
              role: mate.role,
              task: mate.task,
              state: 'working',
              rounds: mate.rounds,
              toolCalls: 0,
              startedAt: mate.startedAt,
              file: mate.file,
            },
          })
        }
      }
      // 「已完成未读」徽标看到即熄；同会话重复打开（内容没变）条目一个字都不动
      //（连「已恢复会话」那行提示也不重复写），否则这次重建会把渲染层重挂一遍。
      // 卡片不在这里种：redundant 意味着列表没重建，直播转发过的卡还在（带完整
      // 瀑布数据），拿名册的粗数据覆盖会倒退；缺卡的极端情形（切走期间队友才开工）
      // 由队友的下一次事件转发自动补上。
      const badgeCleared = backgroundStates.delete(current.filePath)
      if (filePath !== undefined && replayIsRedundant()) {
        seedTurn()
        if (badgeCleared) invalidate()
        return
      }
      transcript.clear()
      if (filePath !== undefined) {
        // 恢复会话：历史消息重放进条目（桌面端/TUI 点历史会话能回看内容）
        transcript.replayHistory(
          current.messages,
          current.toolErrors,
          current.fileChanges,
        )
        transcript.system(`已恢复会话 ${current.meta.id.slice(0, 8)}`)
      } else {
        transcript.system(
          `新会话 ${current.meta.id.slice(0, 8)}（模型 ${ctx.llm.provider}/${ctx.llm.model}）`,
        )
      }
      seedTurn()
      seedSubagents()
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
      replayHistory(messages, toolErrors, fileChanges) {
        const changed = transcript.replayHistory(messages, toolErrors, fileChanges)
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
        // T21 跨会话状态面：当前会话按 turnState，正干着活的常驻 agent 与队友按名册。
        // 0.6.48：后台 agent 的状态由 dsc/agent-status 事件喂进 backgroundStates
        //（含「已完成未读」徽标），当前查看会话的条目跳过——它的状态上面已经推导过。
        const sessionStates: RuntimeSnapshot['sessionStates'] = {}
        if (turnState === 'working' || turnState === 'thinking' || turnState === 'awaiting-approval') {
          sessionStates[ctx.session.current().filePath] =
            turnState === 'awaiting-approval' ? 'awaiting-approval' : 'working'
        }
        const currentPath = ctx.session.current().filePath
        for (const [path, state] of backgroundStates) {
          if (path !== currentPath) sessionStates[path] = state
        }
        const team = ctx.get('team')
        const currentSessionId = ctx.session.current().meta.id
        const subagents: RuntimeSnapshot['subagents'] = []
        if (team !== undefined) {
          for (const mate of team.list()) {
            if (mate.state !== 'working' || mate.file === '') continue
            sessionStates[mate.file] = 'working'
            // 状态栏 chip 只认当前查看会话派出去的队友（0.6.65）：收工即消失，
            // 切到别的会话也不再亮别人的——别人的活看 /resume 行内状态点或 /agents。
            if (mate.sessionId === currentSessionId) {
              subagents.push({ sessionPath: mate.file, state: 'working' })
            }
          }
        }
        // 费用估算：只有 DeepSeek 官方端点才计价（其它 provider / 未收录模型不显示
        // 金额）；估不出（一次用量都没有 / 模型不在价目表）就不带这个字段。
        const costEstimate = isDeepseekProvider(ctx.llm.provider)
          ? estimateSessionCostCny(
              [...transcript.costBuckets.entries()]
                .filter(([model]) => model !== '')
                .map(([model, buckets]) => ({ model, buckets })),
            )
          : undefined
        const built: RuntimeSnapshot = {
          entries: [...transcript.entries, ...transcript.liveEntries()],
          status: {
            sessionId: ctx.session.current().meta.id,
            model: ctx.llm.model,
            effort: ctx.llm.effort,
            turnState,
            usage: transcript.usage,
            contextWindow: ctx.llm.contextWindow,
            contextUsed: transcript.contextUsed,
            contextSegments: transcript.contextSegments ?? emptySegments(),
            ...(costEstimate === undefined
              ? {}
              : { cost: { total: costEstimate.total, peakNow: isPeakHour() } }),
            cwd: ctx.session.current().meta.cwd,
            // jsonl 绝对路径：sessionId 是 uuid，落盘类命令（/fork）得用这个
            sessionPath: ctx.session.current().filePath,
          },
          surfaces,
          sessions: ctx.session.sessions,
          sessionsLoading: ctx.session.loading,
          sessionStates,
          subagents,
        }
        snapshot = built
        return built
      },
    }

    ctx.provide('transcript', service)
  },
}

/**
 * 两份条目表的「内容」是否一致：`id`（每次重建都从 1 重新发号）、`ts`（同一份历史
 * 重放两次时刻会差几毫秒）与 `usage`（本轮累计 token，重放历史时造不出来——会话日志
 * 只存消息、不存每次请求的用量）都不算内容，其余字段逐个比。
 *
 * 工具卡里的 `startedAt` / `durationMs` 同样剔掉，理由比 usage 还硬：实时路径记的是
 * 「事件到达宿主那一刻」，重放路径记的是「消息落盘那一刻」，同一件事两边差几毫秒，
 * 留着比必然不等——`replayIsRedundant` 于是永远判 false，重复打开同一条会话每次都
 * 整表重建、条目 id 从头重发，渲染层按 key 对账就会把折叠态与直播尾一起抹掉。
 *
 * 压缩标记 `compaction` 不剔：它由条目正文推出来（摘要的 SUMMARY_BANNER 前缀、通知的
 * 类别），两条路径算出的值必然相同，属于「内容」而不是「现场测出来的量」。
 *
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
      // 用删字段而不是解构：条目是联合类型，`usage` 只有 text/tool 两种成员有，
      // 直接写 `const { usage, ...rest } = entry` 编译器不认（TS2339）。
      const rest: Record<string, unknown> = { ...entry }
      delete rest['id']
      delete rest['ts']
      delete rest['usage']
      // 思考卡里的耗时是现场测出来的（直播首口 delta → 定稿），重放造不出来，
      // 与 ts 同理剔除——否则恢复会话永远判「内容变了」整表重建。
      delete rest['durationMs']
      // startedAt / durationMs 嵌在工具卡的 call 里而不是条目顶层，所以得进 call 再删
      if (entry.kind === 'tool') {
        const call: Record<string, unknown> = { ...(rest['call'] as Record<string, unknown>) }
        delete call['startedAt']
        delete call['durationMs']
        rest['call'] = call
      }
      return rest
    }),
  )
}
