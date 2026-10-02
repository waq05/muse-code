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
import { createHash } from 'node:crypto'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { MiniAgent } from '../core/loop.js'
import { appendUsageRecord } from '../core/usage-log.js'
import type { AgentService } from '../services/types.js'

/**
 * 系统提示词落盘（Model-visible ⟺ logged 的提示词半边）：系统提示不进 user/assistant
 * 消息流，这里在每次请求组装时把用到的全文写进会话的 `system-prompt` 状态条目——
 * hash 变了才写（换模型、换模式、改 AGENTS.md、跨天都会变），重放会话时最后一条
 * 就是模型当前看到的提示词。
 */
function noteSystemPrompt(ctx: Context, text: string): void {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  const current = ctx.session.current()
  if (current.state('system-prompt')?.hash === hash) return
  current.appendState('system-prompt', { hash, text })
}

export const agentPlugin: Plugin.Object = {
  name: 'agent',
  inject: ['session', 'transcript', 'tools', 'llm', 'compact', 'prompt', 'guards'],
  provide: 'agent',
  apply(ctx) {
    const agent = new MiniAgent(
      {
        route: () => ctx.llm.route(),
        // 系统提示每次请求重拼：切模式、改 AGENTS.md、换模型都不用重启。
        // 拼好的这份同时落进 system-prompt 状态条目（hash 去重）。
        systemPrompt: () => {
          const text = ctx.prompt.systemPrompt(ctx.session.current().meta.cwd)
          noteSystemPrompt(ctx, text)
          return text
        },
        // 模型面前那份目录走 visible()：模式（预设）在这里做减法，极简档因此只看到 bash。
        // 队友不走这条路——它们按自己的工牌从全量注册表里挑（见 plugins/subagent.ts）。
        tools: () => ctx.tools.visible(),
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
          // 一轮开始也广播一声（T41）：压缩插件数着它做 /compact 的运行中守卫。
          if (event.type === 'turn/start') ctx.emit('dsc/turn-start')
          if (event.type === 'turn/end') ctx.emit('dsc/turn-end', event.reason)
          ctx.transcript.emit(event)
        },
        // 压缩的取消信号跟着回合走（T41）：用户打断时压到一半的模型调用跟着停
        beforeRequest: (signal) => ctx.compact.check(signal),
        // 请求因爆窗失败时压一次再重试（对齐 dsh 的溢出重试；压不出空间就把原错误抛回去）
        onContextOverflow: (signal) => ctx.compact.forceCompact(signal),
        rewrite: (messages) => ctx.prompt.rewrite(messages),
        // 发请求走 llm 服务的适配器表：端点声明什么协议就由谁的适配器去说
        stream: (api, request, handlers) => ctx.llm.stream(api, request, handlers),
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
