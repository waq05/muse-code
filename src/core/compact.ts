/**
 * 上下文压缩：把旧历史折成一条摘要消息（对应 dsh compaction 的个人版
 * 最小实现——无 span 选择/锁，只有"保头折尾"策略）。
 *
 * 触发：/compact 手动，或 loop 每轮开始前的自动阈值检查
 * （估算 tokens > 80% × 模型 contextWindow）。磁盘上写 summary 记录，
 * 重放时等价折叠。
 *
 * @module dsc/core/compact
 */
import type { ChatMessage } from './llm.js'
import { contentChars, contentText, streamChat } from './llm.js'
import type { Session } from './session.js'

/** 压缩后保留的最近消息条数。 */
const KEEP_RECENT = 20

/** 粗略 token 估算（中文场景 chars/3 够用；图像按 4000 字符/张估算）。 */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let chars = 0
  for (const message of messages) {
    chars += contentChars(message.content)
    for (const call of message.tool_calls ?? []) {
      chars += call.function.name.length + call.function.arguments.length
    }
  }
  return Math.ceil(chars / 3)
}

export type CompactOutcome = 'compacted' | 'noop'

/** 压缩一次；历史太短返回 'noop'（不写任何记录）。 */
export async function compactSession(
  session: Session,
  route: { baseUrl: string; apiKey: string; model: string; maxTokens?: number; temperature?: number },
  signal: AbortSignal,
): Promise<CompactOutcome> {
  const messages = session.messages
  if (messages.length <= KEEP_RECENT + 2) return 'noop'
  const cut = messages.length - KEEP_RECENT
  const transcript = messages
    .slice(0, cut)
    .map((message) => {
      const text = contentText(message.content)
      const calls =
        message.tool_calls
          ?.map((call) => `[工具调用 ${call.function.name}(${call.function.arguments.slice(0, 120)})]`)
          .join(' ') ?? ''
      return `${message.role}: ${text}${calls}`
    })
    .join('\n\n')

  const result = await streamChat(
    {
      ...route,
      messages: [
        {
          role: 'system',
          content:
            '你是对话摘要器。把用户与助手的历史压缩成要点摘要：保留用户的目标与约束、已完成的关键操作及其结果、重要文件路径/命令/结论。中文输出，500 字以内，直接输出摘要正文。',
        },
        { role: 'user', content: `以下是历史对话，请输出摘要：\n\n${transcript}` },
      ],
    },
    { onDelta() {} },
  )
  if (result.text.trim() === '') throw new Error('摘要模型返回为空')

  const summary = `[先前对话的摘要（原文已压缩）]\n${result.text.trim()}`
  const kept: ChatMessage[] = [{ role: 'user', content: summary }, ...messages.slice(cut)]
  session.replaceWithSummary(summary, kept)
  return 'compacted'
}
