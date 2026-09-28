/**
 * MiniAgent：参考 dsh ReactLoopAgent 的 turn 语义的个人版 ReAct 循环。
 *
 * 一个 turn = `while(true){ streamChat → 定稿 assistant → 无 tool_calls 则
 * 结束；有则逐个 审批 → 执行 → append tool 消息 → 下一轮 }`。与 dsh 的
 * 差异（个人版取舍）：无 step/inbox/steer/子代理/checkpoint 修复——单
 * 队列串行 turn，打断用 AbortController 贯穿 fetch 与工具执行。
 *
 * 每个协议要求：assistant 带 tool_calls 时，后续必须为每个 call 补一条
 * tool 消息（包括被拒绝的调用——拒绝也 append "用户拒绝" 结果），
 * 否则下一轮请求会被服务端 400。
 *
 * @module dsc/core/loop
 */
import type { ChatMessage, StreamResult, ToolSchema } from './llm.js'
import { LlmError, streamChat } from './llm.js'
import type { CoreEvent } from './events.js'
import type { Session } from './session.js'
import type { ApprovalHandler } from './approval.js'
import type { ToolEntry } from './tools.js'

export interface AgentDeps {
  /** 每次请求时动态读取（支持 /model 热切换）。 */
  route(): { baseUrl: string; apiKey: string; model: string; maxTokens?: number; temperature?: number; thinking?: 'enabled' | 'disabled' }
  systemPrompt(): string
  tools(): ToolEntry[]
  approval: ApprovalHandler
  emit(event: CoreEvent): void
  /** 每轮请求前的自动压缩检查（估算超阈值时折叠历史）；缺省不启用。 */
  autoCompact?(): Promise<void>
  /**
   * 组装好「发给模型的那份消息」之后的改写钩子（只影响请求体，不改会话日志）。
   * 插件用它丢掉过期截图之类「留在历史里只会撑上下文、对下一轮没用」的内容。
   */
  transformMessages?(messages: ChatMessage[]): ChatMessage[]
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 单行摘要工具参数（审批卡/日志用）。 */
function summarizeArgs(argsText: string): string {
  const flat = argsText.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}

export class MiniAgent {
  private session: Session
  private abort: AbortController | null = null
  private running = false
  private pendingTurn = false

  constructor(
    private readonly deps: AgentDeps,
    session: Session,
  ) {
    this.session = session
  }

  get sessionId(): string {
    return this.session.meta.id
  }

  get cwd(): string {
    return this.session.meta.cwd
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 切换底层会话（/new、/resume）；当前 turn 会被打断。 */
  switchSession(session: Session): void {
    this.abort?.abort()
    this.session.close()
    this.session = session
  }

  followup(text: string): void {
    this.session.appendUser(text)
    this.deps.emit({ type: 'user', text })
    this.enqueueTurn()
  }

  cancel(): void {
    this.abort?.abort()
  }

  private enqueueTurn(): void {
    if (this.running) {
      this.pendingTurn = true
      return
    }
    this.running = true
    void this.runTurn()
      .catch(() => {})
      .finally(() => {
        this.running = false
        if (this.pendingTurn) {
          this.pendingTurn = false
          this.enqueueTurn()
        }
      })
  }

  private async runTurn(): Promise<void> {
    const abort = new AbortController()
    this.abort = abort
    this.deps.emit({ type: 'turn/start' })
    try {
      await this.deps.autoCompact?.()
      if (abort.signal.aborted) throw new Error('aborted')
      for (;;) {
        const result = await this.requestOnce(abort.signal)
        if (abort.signal.aborted) break
        if (result.toolCalls.length === 0) break
        await this.executeToolCalls(result, abort.signal)
      }
      this.deps.emit({ type: 'turn/end', reason: abort.signal.aborted ? 'aborted' : 'completed' })
    } catch (error) {
      if (abort.signal.aborted) {
        this.deps.emit({ type: 'turn/end', reason: 'aborted' })
      } else {
        this.deps.emit({ type: 'error', message: errText(error) })
        this.deps.emit({ type: 'turn/end', reason: 'error' })
      }
    } finally {
      this.abort = null
    }
  }

  /** 一轮模型请求：流式增量 → emit；定稿 → 落库 + emit message/usage。 */
  private async requestOnce(signal: AbortSignal): Promise<StreamResult> {
    const route = this.deps.route()
    const tools = this.deps.tools()
    const assembled: ChatMessage[] = [
      { role: 'system', content: this.deps.systemPrompt() },
      ...this.session.messages,
    ]
    const messages =
      this.deps.transformMessages === undefined ? assembled : this.deps.transformMessages(assembled)
    const result = await streamChat(
      {
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        model: route.model,
        messages,
        maxTokens: route.maxTokens,
        temperature: route.temperature,
        thinking: route.thinking,
        signal,
        ...(tools.length > 0
          ? {
              tools: tools.map(
                (tool): ToolSchema => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                }),
              ),
            }
          : {}),
      },
      {
        onDelta: (kind, text) => this.deps.emit({ type: 'delta', kind, text }),
      },
    )
    this.session.appendAssistant(result.text, result.reasoning, result.toolCalls)
    this.deps.emit({ type: 'message', text: result.text, reasoning: result.reasoning })
    if (result.usage !== null) {
      this.deps.emit({ type: 'usage', inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens })
    }
    return result
  }

  /** 执行（或拒绝）本轮全部工具调用，append 对应 tool 消息。 */
  private async executeToolCalls(result: StreamResult, signal: AbortSignal): Promise<void> {
    const registry = new Map(this.deps.tools().map((tool) => [tool.name, tool]))
    for (const call of result.toolCalls) {
      if (signal.aborted) return
      this.deps.emit({ type: 'tool/call', callId: call.id, name: call.name, args: call.arguments })
      const tool = registry.get(call.name)
      const fail = (text: string): void => {
        this.session.appendTool(call.id, call.name, text, 'tool-error')
        this.deps.emit({ type: 'tool/result', callId: call.id, text, error: 'tool-error' })
      }
      if (tool === undefined) {
        fail(`未知工具：${call.name}`)
        continue
      }
      let args: Record<string, unknown>
      try {
        args = JSON.parse(call.arguments) as Record<string, unknown>
      } catch {
        fail(`参数不是合法 JSON：${summarizeArgs(call.arguments)}`)
        continue
      }
      try {
        if (tool.risk !== 'read') {
          const decision = await this.deps.approval.decide(
            { toolName: call.name, argsSummary: summarizeArgs(call.arguments), args, cwd: this.cwd },
            signal,
          )
          if (decision === 'reject') {
            const text = '用户拒绝了这次工具调用。'
            this.session.appendTool(call.id, call.name, text, 'rejected')
            this.deps.emit({ type: 'tool/result', callId: call.id, text, error: 'rejected' })
            continue
          }
        }
        const output = await tool.run(args, { cwd: this.cwd, signal })
        const text = typeof output === 'string' ? output : output.text
        const imageNote =
          typeof output === 'object' && output.images !== undefined && output.images.length > 0
            ? `\n[附 ${output.images.length} 张截图]`
            : ''
        this.session.appendTool(call.id, call.name, output)
        this.deps.emit({ type: 'tool/result', callId: call.id, text: text + imageNote })
      } catch (error) {
        fail(errText(error))
      }
    }
  }
}

export { LlmError }
