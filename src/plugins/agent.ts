/**
 * agent 插件：provide `agent` 服务（MiniAgent ReAct 循环的组装与操作面）。
 * 组装迁自 v2 adapter/core-runtime 的 new MiniAgent 段：依赖全部来自服务
 * （route=llm、tools=tools、approval、emit=transcript、autoCompact=compact），
 * 会话切换监听 dsc/session-open 事件。
 *
 * @module dsc/plugins/agent
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { MiniAgent } from '../core/loop.js'
import { buildSystemPrompt } from '../core/prompt.js'
import type { AgentService } from '../services/types.js'

export const agentPlugin: Plugin.Object = {
  name: 'agent',
  inject: ['session', 'transcript', 'approval', 'tools', 'llm', 'compact'],
  provide: 'agent',
  apply(ctx) {
    const agent = new MiniAgent(
      {
        route: () => ctx.llm.route(),
        systemPrompt: () => buildSystemPrompt(ctx.session.current().meta.cwd),
        tools: () => ctx.tools.list(),
        approval: ctx.approval,
        emit: (event) => ctx.transcript.emit(event),
        autoCompact: () => ctx.compact.check(),
      },
      ctx.session.current(),
    )

    ctx.on('dsc/session-open', ({ session }) => agent.switchSession(session))

    const service: AgentService = {
      followup(text: string) {
        agent.followup(text)
      },
      interrupt() {
        agent.cancel()
      },
    }
    ctx.provide('agent', service)
  },
}
