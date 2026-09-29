/**
 * OpenAI chat-completions 流式客户端（协议事实已对齐 dsh llm-deepseek 的
 * chat-completions 实现）：SSE 手写解析；`delta.reasoning_content` → 思考流、
 * `delta.content` → 正文、`delta.tool_calls` 按 index 聚合、
 * `stream_options.include_usage` 末块 usage；assistant 重放时回传
 * `reasoning_content`。
 *
 * 重试策略：连接/HTTP 失败在**尚未收到任何流数据**前指数退避重试 2 次；
 * 流已开始则不重试（半截回复交给上层当错误处理）。可重试的两类：fetch 抛出的
 * 连接失败（`LlmError.retryable`）、以及带 429 或 5xx 状态码的 HTTP 响应。
 * 用户取消（signal 已 abort）不重试。
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
  /** OpenAI 系 `reasoning_effort` 的线上值；undefined = 不注入。与 thinking 二选一，由模型声明决定。 */
  reasoningEffort?: string
  signal?: AbortSignal
}

/** 取消息的纯文本（content 为数组时拼接 text 片段，图像不计入）。 */
export function contentText(content: string | null | ChatContentPart[]): string {
  if (content === null) return ''
  if (typeof content === 'string') return content
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

/** 取消息里的图像清单（data URL；给界面渲染缩略图用）。 */
export function contentImages(content: string | null | ChatContentPart[]): string[] {
  if (typeof content === 'string' || content === null) return []
  return content.flatMap((part) => (part.type === 'image_url' ? [part.image_url.url] : []))
}

/** 粗估消息的字符量（图像每张按 4000 字符 ≈ 1000 token 估算，供压缩阈值用）。 */
export function contentChars(content: string | null | ChatContentPart[]): number {
  if (content === null) return 0
  if (typeof content === 'string') return content.length
  return content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 4000), 0)
}

/**
 * 把散落在历史里的 system 消息全部并进开头那条系统提示。
 *
 * 为什么要合并：不少 OpenAI 兼容网关（litellm 系的 hy3-a 就是）只认「第一条可以是
 * system」，历史中间再冒一条 system 就直接 HTTP 400 `System message must be at the
 * beginning`。外部插件（例如装进 ~/.dsc/plugins 的长期记忆插件）习惯用
 * `transformMessages` 往末尾补一条 system，内容本身是有用的，所以不能丢——
 * 并进头部既保住内容，也让任何插件都没法再把请求结构弄坏。
 *
 * @param messages - 组装好的请求消息；原数组不动。
 * @returns 至多一条 system、且它排在最前的消息数组。
 */
export function foldSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  let head: ChatMessage | undefined
  const rest: ChatMessage[] = []
  for (const message of messages) {
    if (message.role !== 'system') {
      rest.push(message)
      continue
    }
    const text = contentText(message.content)
    if (head === undefined) {
      head = text === '' ? { ...message, content: '' } : message
      continue
    }
    if (text === '') continue
    head = { ...head, content: `${contentText(head.content)}\n\n${text}` }
  }
  return head === undefined ? messages : [head, ...rest]
}

/**
 * 把消息里的图像全部换成一句说明（当前模型没声明照片输入时用）。
 * 整条删掉会让工具结果读起来缺一块，所以把原因留在正文里，模型知道自己是"没看到图"。
 * @param messages - 组装好的请求消息；原数组不动。
 * @param note - 替换进去的说明文字。
 */
export function dropImageParts(messages: ChatMessage[], note: string): ChatMessage[] {
  return messages.map((message) => {
    if (typeof message.content !== 'object' || message.content === null) return message
    if (!message.content.some((part) => part.type === 'image_url')) return message
    const text = contentText(message.content)
    return { ...message, content: [{ type: 'text' as const, text: text === '' ? note : `${text}\n${note}` }] }
  })
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
  /** HTTP 状态码；fetch 自己抛的异常（连不上、DNS 失败、连接被切断）没有这个值。 */
  readonly status?: number
  /**
   * 是否值得重试。true 只有一种情况：请求还没连上就失败（`streamOnce` 里 fetch 的 catch），
   * 此时一个字节都没收到，重发是安全的。HTTP 429 / 5xx 由 `status` 判定，不看这个标记。
   */
  readonly retryable: boolean
  constructor(message: string, status?: number, retryable = false) {
    super(message)
    this.name = 'LlmError'
    this.status = status
    this.retryable = retryable
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
        request.signal?.aborted !== true &&
        error instanceof LlmError &&
        (error.retryable || (error.status !== undefined && (error.status === 429 || error.status >= 500)))
      if (!retryable) throw error
      await delay(500 * 2 ** (attempt - 1), request.signal)
    }
  }
}

async function streamOnce(request: StreamRequest, handlers: StreamHandlers): Promise<StreamResult> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: serializeMessages(foldSystemMessages(request.messages)),
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
  if (request.reasoningEffort !== undefined) body.reasoning_effort = request.reasoningEffort

  const response = await fetch(`${request.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: request.signal,
  }).catch((error: unknown) => {
    throw new LlmError(
      `连接失败：${error instanceof Error ? error.message : String(error)}`,
      undefined,
      true,
    )
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
