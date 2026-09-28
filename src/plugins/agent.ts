/**
 * agent 插件：provide `agent` 服务（MiniAgent ReAct 循环的组装与操作面）
 * 与 `prompt` 服务（插件贡献的附加系统提示 + 发给模型的消息改写钩子）。
 *
 * 组装迁自 v2 adapter/core-runtime 的 new MiniAgent 段：依赖全部来自服务
 * （route=llm、tools=tools、approval、transcript、compact、skills），
 * 会话切换监听 dsc/session-open 事件。
 *
 * prompt 服务是内核 API v3 的扩展点：插件注册一段提示文本或一个改写函数，
 * 卸载时 disposer 自动撤销，所以关掉一个插件不会在系统提示里留下半句话。
 *
 * @module dsc/plugins/agent
 */
import type { Plugin } from '@deepseek-ai/cordis'
import type { ChatMessage } from '../core/llm.js'
import { MiniAgent } from '../core/loop.js'
import { buildSystemPrompt } from '../core/prompt.js'
import type { AgentService, PromptService } from '../services/types.js'

export const agentPlugin: Plugin.Object = {
  name: 'agent',
  inject: ['session', 'transcript', 'approval', 'tools', 'llm', 'compact', 'skills'],
  provide: 'agent',
  apply(ctx) {
    /** 附加提示段：id → 取文本。同名后注册者顶掉先注册的，disposer 只撤自己那一份。 */
    const sections = new Map<string, () => string>()
    /** 请求体改写钩子，按注册顺序逐个应用。 */
    const transforms: Array<(messages: ChatMessage[]) => ChatMessage[]> = []

    const prompt: PromptService = {
      register(id, text) {
        sections.set(id, text)
        return () => {
          if (sections.get(id) === text) sections.delete(id)
        }
      },
      transformMessages(fn) {
        transforms.push(fn)
        return () => {
          const at = transforms.indexOf(fn)
          if (at >= 0) transforms.splice(at, 1)
        }
      },
      extraText() {
        const parts: string[] = []
        for (const [id, make] of sections) {
          try {
            const text = make().trim()
            if (text !== '') parts.push(text)
          } catch {
            // 一个插件把提示词生成崩了，不该让这一轮请求整个失败：这段本轮跳过。
            void id
          }
        }
        return parts.join('\n\n')
      },
    }

    const agent = new MiniAgent(
      {
        route: () => ctx.llm.route(),
        // 技能目录每次请求重取：启停技能或改了 SKILL.md，下一轮就生效
        systemPrompt: () => {
          const base = buildSystemPrompt(ctx.session.current().meta.cwd, ctx.skills.catalogText())
          const extra = prompt.extraText()
          return extra === '' ? base : `${base}\n\n${extra}`
        },
        tools: () => ctx.tools.list(),
        approval: ctx.approval,
        emit: (event) => ctx.transcript.emit(event),
        autoCompact: () => ctx.compact.check(),
        transformMessages: (messages) => {
          let out = messages
          for (const fn of [...transforms]) out = fn(out)
          return out
        },
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
    ctx.provide('prompt', prompt)
  },
}
