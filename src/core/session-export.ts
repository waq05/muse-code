/**
 * 会话导出（T22）：把会话消息序列化成 markdown。
 *
 * 数据源是 `session.messages`（协议消息本尊，内核侧就有），不是 UI 的折叠条目——
 * 这样 /export 在桌面、TUI、远端三个面都走同一条命令注册表（T44 派发闸），
 * 导出的也是「模型真实看到的」完整消息流。UI 的过程分组/折叠不进导出（披露）。
 *
 * 工具结果按字符预算截断：导出物是给人读的归档，一条 200KB 的构建日志会把
 * markdown 撑爆；截断处注明原长。
 *
 * @module dsc/core/session-export
 */
import { contentText } from './llm.js'
import type { ChatMessage } from './llm.js'

/** 单条工具结果进导出的字符预算（超过截断并注明原长）。 */
export const DEFAULT_TOOL_CHAR_BUDGET = 2000

/** 导出输入：会话元数据 + 消息列表（session.messages 直传）。 */
export interface SessionExportInput {
  id: string
  cwd: string
  createdAt: number
  messages: readonly ChatMessage[]
}

function fence(text: string): string {
  // 内容里出现 ``` 时换更长的围栏，保证块不被内容截断；没有时用标准三连
  const longest = text.match(/`{3,}/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0
  const marker = '`'.repeat(Math.max(3, longest + 1))
  return `${marker}\n${text}\n${marker}`
}

function formatDate(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 截断工具结果：预算内原样，超了留头去尾并注明原长。 */
export function truncateToolOutput(text: string, budget = DEFAULT_TOOL_CHAR_BUDGET): string {
  if (text.length <= budget) return text
  const head = text.slice(0, Math.floor(budget * 0.7))
  const tail = text.slice(-Math.floor(budget * 0.2))
  return `${head}\n…（中间截断，原长 ${text.length} 字符）…\n${tail}`
}

/**
 * 序列化一份会话为 markdown。纯函数：不读盘、不写盘，落盘由命令层负责。
 * 工具调用与结果按协议形状保留（调用在 assistant 段、结果独立段），
 * 人类可读优先于机器可重放。
 */
export function exportSessionMarkdown(input: SessionExportInput, toolCharBudget = DEFAULT_TOOL_CHAR_BUDGET): string {
  const lines: string[] = [
    `# 会话导出 ${input.id.slice(0, 8)}`,
    '',
    `- 工作目录：${input.cwd || '（未知）'}`,
    `- 创建时间：${formatDate(input.createdAt)}`,
    `- 导出时间：${formatDate(Date.now())}`,
    `- 消息数：${input.messages.length}`,
    '',
    '---',
    '',
  ]
  for (const message of input.messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') {
      lines.push('## 用户', '', contentText(message.content), '')
      continue
    }
    if (message.role === 'assistant') {
      const text = contentText(message.content)
      if (text !== '') lines.push('## 助手', '', text, '')
      for (const call of message.tool_calls ?? []) {
        lines.push('## 助手 · 工具调用', '', fence(`${call.function.name}(${call.function.arguments})`), '')
      }
      continue
    }
    // tool 结果
    const id = message.tool_call_id === '' ? '' : `（${message.tool_call_id}）`
    lines.push(`## 工具结果${id}`, '', fence(truncateToolOutput(contentText(message.content), toolCharBudget)), '')
  }
  return lines.join('\n')
}
