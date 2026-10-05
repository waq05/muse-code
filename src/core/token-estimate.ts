/**
 * 正文 token 粗估（全仓库唯一一份）。
 *
 * 为什么单独一个模块：这段口径此前在宿主 core/compact.ts 和渲染层 token-estimate.ts
 * 各抄了一份——界面上写的「约 N token」必须和宿主自动压缩用的阈值同源，不然会出现
 * 界面说 3 万、宿主按 5 万判断压缩这种对不上的情况。现在宿主与渲染层都从这里取
 * （渲染层经 `@dsc/runtime/core/token-estimate.js`，纯函数、零依赖，进得了渲染层）。
 *
 * 口径（2026-09-29 从 chars/3 改为 CJK 分开算）：中文一个字约 0.6~0.7 token，
 * chars/3 会把中文低估约一半——自动压缩要等真实用量冲到窗口 100% 以上才触发，直接爆窗。
 * 这里中文按 0.65、其余按 0.33（≈3 字符/token）估，整体宁可高估（早压一次很便宜）
 * 也不低估（报错结束回合）。
 *
 * 凡是用了这里数字的地方都要带「约」或「~」：它是估算，不是服务端真值。
 *
 * @module dsc/core/token-estimate
 */

/** 中日韩字符区间。 */
const CJK_CHAR = /[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uA4CF\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

/** 估一段正文的 token 数（不取整；取整是调用方按展示口径自己的事）。 */
export function estimateTextTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK_CHAR.test(char)) cjk += 1
    else other += 1
  }
  return cjk * 0.65 + other * 0.33
}

/** 结构够用的消息形状（与 core/llm 的 ChatMessage 同构；不 import，保住零依赖）。 */
export interface SegmentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | Array<{ type: string; text?: string }>
  reasoning_content?: string
  tool_calls?: { function: { name: string; arguments: string } }[]
}

/** 请求按内容类型的 token 估算分段（context 进度条占用段的组成，dsh 同款五段）。 */
export interface RequestSegments {
  system: number
  prompt: number
  assistant: number
  thinking: number
  tools: number
}

/** 全零分段（新会话 / 尚无请求记录）。 */
export function emptySegments(): RequestSegments {
  return { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }
}

/**
 * 对**组装完的整份请求**按内容类型现算分段（每次请求重算，天然带「历史被压缩 /
 * 消息滚出窗口」的重置语义，不用做增量抵账）。口径对齐 dsh projection：system 一段、
 * user 归 prompt、assistant 正文与工具调用参数归 assistant、思考归 thinking、
 * 工具结果归 tools。取整向上（宁可高估）。
 *
 * 为什么是估算不是真值：没有 tokenizer，角色标记与工具 JSON 信封也不在五段里——
 * 这些零头体现在权威读数（真实 prompt_tokens）与分段之和的差上，界面只拿分段画颜色，
 * 读数永远用服务端数字。
 */
export function estimateRequestSegments(messages: readonly SegmentMessage[]): RequestSegments {
  const textOf = (content: SegmentMessage['content']): string => {
    if (content === null) return ''
    if (typeof content === 'string') return content
    return content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('')
  }
  const segments = emptySegments()
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        segments.system += estimateTextTokens(textOf(message.content))
        break
      case 'user':
        segments.prompt += estimateTextTokens(textOf(message.content))
        break
      case 'assistant':
        segments.assistant += estimateTextTokens(textOf(message.content))
        segments.thinking += estimateTextTokens(message.reasoning_content ?? '')
        for (const call of message.tool_calls ?? []) {
          segments.assistant += estimateTextTokens(`${call.function.name}${call.function.arguments}`)
        }
        break
      case 'tool':
        segments.tools += estimateTextTokens(textOf(message.content))
        break
    }
  }
  return {
    system: Math.ceil(segments.system),
    prompt: Math.ceil(segments.prompt),
    assistant: Math.ceil(segments.assistant),
    thinking: Math.ceil(segments.thinking),
    tools: Math.ceil(segments.tools),
  }
}
