/**
 * agent 插件：provide `agent` 服务——把一轮对话跑起来的 ReAct 循环的组装与操作面。
 *
 * 这个插件只做装配：路由来自 llm，工具来自 tools，提示词交给 prompt 服务，
 * 动手之前的拦截交给守卫链，压缩检查挂在「每轮请求前」那个钩子上。
 * 它不认识模式、审批、任务清单这些具体功能点——那些都通过扩展点接进来。
 *
 * 另外干两件实事：把用量落一条到 `~/.dsc/usage/usage.jsonl`（设置「用量统计」的数据源），
 * 以及把「一轮干净结束」广播成 `dsc/turn-end`（谁想接着往下跑自己听，循环不认识目标这个功能）。
 *
 * @module dsc/plugins/agent
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { MiniAgent } from '../core/loop.js'
import { appendUsageRecord } from '../core/usage-log.js'
import type { AgentService } from '../services/types.js'

export const agentPlugin: Plugin.Object = {
  name: 'agent',
  inject: ['session', 'transcript', 'tools', 'llm', 'compact', 'prompt', 'guards'],
  provide: 'agent',
  apply(ctx) {
    const agent = new MiniAgent(
      {
        route: () => ctx.llm.route(),
        // 系统提示每次请求重拼：切模式、改 AGENTS.md、换模型都不用重启。
        systemPrompt: () => ctx.prompt.systemPrompt(ctx.session.current().meta.cwd),
        tools: () => ctx.tools.list(),
        guards: ctx.guards,
        emit: (event) => {
          // 用量落一条到 ~/.dsc/usage/usage.jsonl（设置「用量统计」的数据源）。
          // 请求刚结束，ctx.llm.provider/model 就是这次用的端点与模型；
          // 落盘失败已被 appendUsageRecord 自己吞掉，不能影响对话轮次。
          if (event.type === 'usage') {
            appendUsageRecord({
              provider: ctx.llm.provider,
              model: ctx.llm.model,
              i: event.inputTokens,
              o: event.outputTokens,
              sid: ctx.session.current().meta.id,
            })
          }
          // 一轮结束广播出去：目标续跑这类「接着往下推」的行为自己听，别在这里点名。
          if (event.type === 'turn/end') ctx.emit('dsc/turn-end', event.reason)
          ctx.transcript.emit(event)
        },
        beforeRequest: () => ctx.compact.check(),
        transformMessages: (messages) => ctx.prompt.rewrite(messages),
      },
      ctx.session.current(),
    )

    ctx.on('dsc/session-open', ({ session }) => agent.switchSession(session))

    const service: AgentService = {
      followup(text: string, images?: string[]) {
        agent.followup(text, images)
      },
      interrupt() {
        agent.cancel()
      },
    }
    ctx.provide('agent', service)
  },
}
