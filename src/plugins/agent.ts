/**
 * agent 插件：provide `agent` 服务——按会话常驻的 ReAct 循环注册表（0.6.48 对齐 dsh）。
 *
 * 0.6.47 之前全局只有一个 MiniAgent，切会话 = 换掉它底下的会话并 abort 当前轮
 * （中止收尾的工具结果还会误写进新会话的日志）。0.6.48 起改为**每个会话一个常驻
 * agent**：切换只换「当前查看」指向，正在跑的轮次留在后台继续跑完（dsh 的
 * AgentRegistry + UI 订阅语义）；完全闲下来又不是当前查看的 agent 就地收摊，
 * 释放写租约与内存——资源占用与旧模型相当，只是运行中的多留一份。
 *
 * 事件路由是这套模型的另一半：只有当前查看 agent 的事件进转录（后台 agent 的
 * delta/工具卡留在各自会话的 jsonl 里，切回去时按日志重放）；回合起止则以
 * dsc/turn-start / dsc/turn-end（带会话归属）与 dsc/agent-status（跨会话状态点）
 * 广播，消费方按 sessionId 自己认领。
 *
 * 另外干两件实事：把用量落一条到 `~/.dsc/usage/usage.jsonl`（设置「用量统计」的数据源，
 * 按发起回合的会话记账），以及把「一轮干净结束」广播成 `dsc/turn-end`。
 *
 * @module dsc/plugins/agent
 */
import { createHash } from 'node:crypto'
import type { Plugin } from '@deepseek-ai/cordis'
import { Session } from '../core/session.js'
import { MiniAgent } from '../core/loop.js'
import { appendToolRecord, appendUsageRecord } from '../core/usage-log.js'
import { clearReadLedger } from '../core/path-policy.js'
import { errText } from '../adapter/transcript.js'
import type { AgentService, TurnSignal } from '../services/types.js'

/**
 * 系统提示词落盘（Model-visible ⟺ logged 的提示词半边）：系统提示不进 user/assistant
 * 消息流，这里在每次请求组装时把用到的全文写进**这个 agent 自己的会话**的
 * `system-prompt` 状态条目——hash 变了才写（换模型、换模式、改 AGENTS.md 才会变；
 * 环境事实已搬出提示词，由 prompt 插件的 env-facts 投影附在请求末尾），重放会话时
 * 最后一条就是模型当前看到的提示词。
 */
function noteSystemPrompt(session: Session, text: string): void {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  if (session.state('system-prompt')?.hash === hash) return
  session.appendState('system-prompt', { hash, text })
}

export const agentPlugin: Plugin.Object = {
  name: 'agent',
  inject: ['session', 'transcript', 'tools', 'llm', 'compact', 'prompt', 'guards'],
  provide: 'agent',
  apply(ctx) {
    /** 常驻注册表：会话 id（meta.id）→ agent。含当前查看的那个。 */
    const agents = new Map<string, MiniAgent>()
    /** 收摊 agent 的墓碑：id → jsonl 路径。非常驻投递（followup 带 id）靠它找文件。 */
    const tombstones = new Map<string, string>()
    /** 当前查看的 agent。不变量：它的会话就是 ctx.session.current() 那个对象。 */
    let active: MiniAgent | null = null

    const turnSignal = (session: Session): TurnSignal => ({
      sessionId: session.meta.id,
      sessionPath: session.filePath,
    })

    const makeAgent = (session: Session): MiniAgent => {
      /** 工具名按 callId 记着：`tool/result` 事件只带 callId，工具行要写工具名。 */
      const toolNames = new Map<string, string>()
      return new MiniAgent(
        {
          route: () => ctx.llm.route(),
          // 系统提示每次请求重拼：切模式、改 AGENTS.md、换模型都不用重启。
          // 拼好的这份同时落进自己会话的 system-prompt 状态条目（hash 去重）。
          systemPrompt: () => {
            const text = ctx.prompt.systemPrompt(session.meta.cwd)
            noteSystemPrompt(session, text)
            return text
          },
          // 模型面前那份目录走 visible()：模式（预设）在这里做减法，极简档因此只看到 bash。
          // 队友不走这条路——它们按自己的工牌从全量注册表里挑（见 plugins/subagent.ts）。
          tools: () => ctx.tools.visible(),
          guards: ctx.guards,
          emit: (event) => {
            // 用量按发起回合的会话记账落一条到 ~/.dsc/usage/usage.jsonl；落盘失败
            // 已被 appendUsageRecord 自己吞掉，不能影响对话轮次。这一步的墙钟读数
            // （lm/ft/d）同一条出账：界面按整个会话累计算输出速度与首字延迟。
            if (event.type === 'usage') {
              appendUsageRecord({
                provider: ctx.llm.provider,
                model: ctx.llm.model,
                i: event.inputTokens,
                o: event.outputTokens,
                ...(event.cacheHitTokens === undefined ? {} : { ch: event.cacheHitTokens }),
                ...(event.cacheMissTokens === undefined ? {} : { cm: event.cacheMissTokens }),
                sid: session.meta.id,
                ...(event.llmMs === undefined ? {} : { lm: event.llmMs }),
                ...(event.ttftMs === undefined ? {} : { ft: event.ttftMs }),
                ...(event.decodeMs === undefined ? {} : { d: event.decodeMs }),
              })
            }
            // 工具调用也记一条（第二种行）：界面读同一个文件算「工具耗时」。
            // 没带 ms 的（打断时补的合成结果）不记——没有起点就没有耗时。
            if (event.type === 'tool/call') toolNames.set(event.callId, event.name)
            if (event.type === 'tool/result' && event.ms !== undefined) {
              appendToolRecord({ sid: session.meta.id, n: toolNames.get(event.callId) ?? '', ms: event.ms })
              toolNames.delete(event.callId)
            }
            // 回合起止广播出去（带会话归属）：目标续跑、压缩守卫、生命周期钩子这些
            // 「接着往下推/守着门」的行为自己听，按 sessionId 认领；循环不认识目标。
            if (event.type === 'turn/start') {
              ctx.emit('dsc/turn-start', turnSignal(session))
              ctx.emit('dsc/agent-status', { sessionId: session.meta.id, path: session.filePath, state: 'working' })
            }
            if (event.type === 'turn/end') {
              ctx.emit('dsc/turn-end', event.reason, turnSignal(session))
              ctx.emit('dsc/agent-status', { sessionId: session.meta.id, path: session.filePath, state: 'idle' })
            }
            // 只有当前查看 agent 的事件进转录：后台 agent 的流式增量与工具卡留在
            // 各自会话的 jsonl 里，切回去时由转录插件按日志重放。这正是「切走不打断」
            // 的显示面——旧模型里中止轮的残留事件污染新会话视图，这里从源头掐掉。
            if (active !== null && active.sessionId === session.meta.id) ctx.transcript.emit(event)
          },
          // 压缩的取消信号跟着回合走（T41）：用户打断时压到一半的模型调用跟着停；
          // 压缩目标永远是这个 agent 自己的会话（0.6.48 起显式传入）。
          beforeRequest: (signal) => ctx.compact.check(signal, session),
          // 请求因爆窗失败时压一次再重试（对齐 dsh 的溢出重试；压不出空间就把原错误抛回去）
          onContextOverflow: (signal) => ctx.compact.forceCompact(signal, session),
          rewrite: (messages) => ctx.prompt.rewrite(messages, session),
          // 发请求走 llm 服务的适配器表：端点声明什么协议就由谁的适配器去说
          stream: (api, request, handlers) => ctx.llm.stream(api, request, handlers),
          // 完全闲下来又不是当前查看的：就地收摊（释放写租约与内存）。正被查看的
          // 留着——用户下一句话还得靠它。
          onIdle: () => {
            if (active !== null && active.sessionId === session.meta.id) return
            const agent = agents.get(session.meta.id)
            if (agent === undefined) return
            agents.delete(session.meta.id)
            tombstones.set(session.meta.id, session.filePath)
            // 「先读过才许改」的台账跟着会话走，收摊时一起清，防长窗口无界增长
            clearReadLedger(session.meta.id)
            agent.dispose()
          },
        },
        session,
      )
    }

    const disposeAgent = (agent: MiniAgent): void => {
      agents.delete(agent.sessionId)
      tombstones.set(agent.sessionId, agent.session.filePath)
      // 「先读过才许改」的台账跟着会话走，收摊时一起清，防长窗口无界增长
      clearReadLedger(agent.sessionId)
      agent.dispose()
    }

    // ---- 初始 agent：内核启动恢复/新建的那个会话 ----
    active = makeAgent(ctx.session.current())
    agents.set(active.sessionId, active)

    ctx.on('dsc/session-open', ({ session }) => {
      const prev = active
      let next = agents.get(session.meta.id)
      if (next === undefined) {
        next = makeAgent(session)
        agents.set(session.meta.id, next)
      }
      active = next
      if (prev !== null && prev !== next) {
        if (prev.busy) {
          // 被切走且还有活的（回合在跑/排了下一轮）：留在后台继续——这正是 0.6.48
          // 的语义（旧模型在这里 abort）。重发一次状态：它被查看期间转录层清了
          // 状态点，回后台后侧栏的点要重新亮起来，收工才能翻成「已完成未读」。
          // 挂着审批卡的发 awaiting-approval（0.6.50）：以前一律发 working，会把
          // 「等你批准」盖成「还在跑」，侧栏两个状态点就此错位。
          const waitingApproval = ctx.get('approval')?.pendingFor(prev.session.filePath) === true
          ctx.emit('dsc/agent-status', {
            sessionId: prev.sessionId,
            path: prev.session.filePath,
            state: waitingApproval ? 'awaiting-approval' : 'working',
          })
        } else {
          disposeAgent(prev)
        }
      }
    })

    ctx.on('dsc/exit', () => {
      for (const agent of [...agents.values()]) agent.dispose()
      agents.clear()
    })

    /** 把一条输入写进没有常驻 agent 的休眠会话（等用户回去自己看到，不起回合）。 */
    const deliverToDormant = (sessionId: string, text: string, images?: string[]): void => {
      const path = tombstones.get(sessionId)
      if (path === undefined) {
        ctx.emit('dsc/notice', `一条通知没能投递：会话 ${sessionId.slice(0, 8)} 不在本窗口的名册里`)
        return
      }
      try {
        const dormant = Session.load(path, true)
        dormant.appendUser(text, images)
        dormant.close()
      } catch (error) {
        ctx.emit('dsc/notice', `一条通知没能写进会话 ${sessionId.slice(0, 8)}：${errText(error)}`)
      }
    }

    const service: AgentService = {
      followup(text: string, images?: string[], sessionId?: string) {
        if (sessionId === undefined) {
          if (active !== null) active.followup(text, images)
          return
        }
        const agent = agents.get(sessionId)
        if (agent !== undefined) {
          agent.followup(text, images)
          return
        }
        deliverToDormant(sessionId, text, images)
      },
      interrupt(filePath?: string) {
        if (filePath === undefined) {
          if (active !== null) active.cancel()
          return
        }
        // 后台可停（0.6.49）：侧栏行右键按路径停任意在跑的会话；找常驻 agent——
        // 收摊了的会话没有在跑的回合，天然是空操作。
        for (const agent of agents.values()) {
          if (agent.session.filePath === filePath) agent.cancel()
        }
      },
      hasAgent(sessionId: string) {
        return agents.has(sessionId)
      },
      // 排队输入的三个动作（0.6.67）：只作用于**当前查看**的那个 agent——队列条画在
      // 输入框下方，编辑 / 删除 / 插话的都是眼前这一队；后台会话的排队输入留在它自己的
      // 收件箱里，切回去时随快照一起出现。入箱与编辑删除都会发 `inbox` 事件，
      // 转录层收到即刷新快照，这里不必再补一次 touch。
      editQueued(index: number, text: string) {
        return active?.editQueued(index, text) ?? false
      },
      removeQueued(index: number) {
        return active?.removeQueued(index) ?? false
      },
      steerQueued(index?: number) {
        return active?.steerQueued(index) ?? false
      },
      sessionFor(filePath: string) {
        for (const agent of agents.values()) {
          if (agent.session.filePath === filePath) return agent.session
        }
        return undefined
      },
      isRunning(filePath: string) {
        for (const agent of agents.values()) {
          if (agent.session.filePath === filePath) return agent.isRunning
        }
        return false
      },
      async stop(filePath: string) {
        const agent = [...agents.values()].find((item) => item.session.filePath === filePath)
        if (agent === undefined) return
        // 排队输入先按归档语义丢弃（对齐 dsh 的归档停机）：cancel 本身不清箱，回合
        // 收尾的 drainInbox 会把排队消息落库再排下一轮——归档前不清，取消反而唤醒新回合。
        agent.session.takeAsyncInbox()
        agent.cancel()
        // 等完全收摊（onIdle 把它移出注册表、写租约释放）再放行，归档才挪得动文件；
        // 10s 兜底强制收（正常路径 busy 归零与收摊在同一段同步代码里，等不到兜底）。
        const deadline = Date.now() + 10_000
        while (agents.get(agent.sessionId) === agent && agent.busy && Date.now() <= deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        if (agents.get(agent.sessionId) === agent) disposeAgent(agent)
      },
    }
    ctx.provide('agent', service)
  },
}
