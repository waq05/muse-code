/**
 * OpenAI chat-completions 流式客户端（协议事实已对齐 dsh llm-deepseek 的
 * chat-completions 实现）：SSE 手写解析；`delta.reasoning_content` → 思考流、
 * `delta.content` → 正文、`delta.tool_calls` 按 index 聚合、
 * `stream_options.include_usage` 末块 usage；assistant 重放时回传
 * `reasoning_content`。
 *
 * 重试策略：连接/HTTP 失败在**尚未收到任何流数据**前指数退避重试 2 次；
 * 流已开始则不重试（半截回复交给上层当错误处理）。
 *
 * @module dsc/core/llm
 */

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 多模态消息片段（content 数组形态；工具结果带图时使用）。 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** OpenAI 协议消息（session 直接存这个形状，零转换）。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | ChatContentPart[]
  reasoning_content?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export interface StreamRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  tools?: ToolSchema[]
  maxTokens?: number
  temperature?: number
  /** 思考开关（DeepSeek/GLM 系 `thinking` 参数）；undefined = 不注入，走端点默认。 */
  thinking?: 'enabled' | 'disabled'
  signal?: AbortSignal
}

/** 取消息的纯文本（content 为数组时拼接 text 片段，图像不计入）。 */
export function contentText(content: string | null | ChatContentPart[]): string {
  if (content === null) return ''
  if (typeof content === 'string') return content
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

/** 粗估消息的字符量（图像每张按 4000 字符 ≈ 1000 token 估算，供压缩阈值用）。 */
export function contentChars(content: string | null | ChatContentPart[]): number {
  if (content === null) return 0
  if (typeof content === 'string') return content.length
  return content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 4000), 0)
}

export interface StreamHandlers {
  /** 增量回调（思考/正文二选一到达）。 */
  onDelta(kind: 'text' | 'reasoning', text: string): void
}

export interface StreamResult {
  text: string
  reasoning: string
  toolCalls: ToolCall[]
  usage: { inputTokens: number; outputTokens: number } | null
  finishReason: string | null
}

export class LlmError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.status = status
  }
}

const MAX_ATTEMPTS = 3

/** 发起一次流式对话。 */
export async function streamChat(request: StreamRequest, handlers: StreamHandlers): Promise<StreamResult> {
  let attempt = 0
  for (;;) {
    attempt += 1
    try {
      return await streamOnce(request, handlers)
    } catch (error) {
      const retryable =
        attempt < MAX_ATTEMPTS &&
        error instanceof LlmError &&
        error.status !== undefined &&
        (error.status === 429 || error.status >= 500)
      if (!retryable) throw error
      await delay(500 * 2 ** (attempt - 1), request.signal)
    }
  }
}

async function streamOnce(request: StreamRequest, handlers: StreamHandlers): Promise<StreamResult> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: serializeMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.thinking !== undefined) body.thinking = { type: request.thinking }

  const response = await fetch(`${request.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: request.signal,
  }).catch((error: unknown) => {
    throw new LlmError(`连接失败：${error instanceof Error ? error.message : String(error)}`)
  })

  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => '')
    throw new LlmError(
      `HTTP ${response.status}${detail === '' ? '' : `：${detail.slice(0, 300)}`}`,
      response.status,
    )
  }

  const result: StreamResult = {
    text: '',
    reasoning: '',
    toolCalls: [],
    usage: null,
    finishReason: null,
  }
  const callsByIndex = new Map<number, ToolCall>()

  // 打断时保留已收到的部分内容（半截回复对"取消后接着看"有价值）；
  // 一字节未得的中途取消则照常抛错。
  try {
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') break
      let chunk: {
        choices?: {
          delta?: {
            content?: string | null
            reasoning_content?: string | null
            tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
          }
          finish_reason?: string | null
        }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null
      }
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }
      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      if (delta?.reasoning_content) {
        result.reasoning += delta.reasoning_content
        handlers.onDelta('reasoning', delta.reasoning_content)
      }
      if (delta?.content) {
        result.text += delta.content
        handlers.onDelta('text', delta.content)
      }
      for (const call of delta?.tool_calls ?? []) {
        const existing = callsByIndex.get(call.index)
        if (existing === undefined) {
          callsByIndex.set(call.index, {
            id: call.id ?? '',
            name: call.function?.name ?? '',
            arguments: call.function?.arguments ?? '',
          })
        } else {
          if (call.id !== undefined && call.id !== '') existing.id = call.id
          if (call.function?.name !== undefined && call.function.name !== '') existing.name = call.function.name
          if (call.function?.arguments !== undefined) existing.arguments += call.function.arguments
        }
      }
      if (choice?.finish_reason != null) result.finishReason = choice.finish_reason
      if (chunk.usage != null) {
        result.usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        }
      }
    }
  } catch (error: unknown) {
    const partial =
      result.text !== '' || result.reasoning !== '' || callsByIndex.size > 0
    if (!(request.signal?.aborted === true && partial)) throw error
    result.finishReason = 'aborted'
  }

  result.toolCalls = [...callsByIndex.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
  return result
}

/** assistant 消息重放：reasoning_content 回传保持模型思路连贯（dsh 同款）。 */
function serializeMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message
    return {
      role: message.role,
      content: message.content,
      ...(message.reasoning_content !== undefined && message.reasoning_content !== ''
        ? { reasoning_content: message.reasoning_content }
        : {}),
      ...(message.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {}),
    }
  })
}

/** 把 SSE 字节流切成 data 行。 */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) yield line.slice(5).trim()
        newline = buffer.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
