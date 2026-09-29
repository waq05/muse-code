/**
 * 上下文压缩：把旧历史折成一条摘要消息（对应 dsh compaction 的个人版
 * 最小实现——无 span 选择/锁，只有"保头折尾"策略）。
 *
 * 摘要之外还附三样机械产物（见 ./compact-anchors.js）：正则抽的锚点索引、
 * 真实用户原话逐字引用、细节找回指针。模型写的叙述会漏掉 SHA 与报错原文，这三样不走模型。
 *
 * 触发：/compact 手动，或 loop 每轮开始前的自动阈值检查
 * （估算 tokens > 80% × 模型 contextWindow）。磁盘上写 summary 记录，
 * 重放时等价折叠。
 *
 * @module dsc/core/compact
 */
import type { ChatMessage } from './llm.js'
import { contentText, streamChat } from './llm.js'
import type { Session } from './session.js'
import {
  buildAnchorIndex,
  buildRecoveryFooter,
  collectVerbatimUserMessages,
  DEFAULT_ANCHOR_BUDGET_CHARS,
  DEFAULT_USER_QUOTE_BUDGET_CHARS,
  SUMMARY_BANNER,
} from './compact-anchors.js'

/** 压缩后保留的最近消息条数的缺省值（compact 插件配置没给 `keepRecent` 时用它）。 */
export const DEFAULT_KEEP_RECENT = 20

/** 一次压缩的三个上限。前两个是字符预算，由 compact 插件的配置给值。 */
export interface CompactLimits {
  /** 摘要之外原样保留的最近消息条数。 */
  keepRecent: number
  /** 锚点索引的字符预算。 */
  anchorChars: number
  /** 摘要里逐字引用的用户原话的字符预算。 */
  userQuoteChars: number
}

/** 三个上限的缺省值（compact 插件配置没给时用它）。 */
export const DEFAULT_COMPACT_LIMITS: CompactLimits = {
  keepRecent: DEFAULT_KEEP_RECENT,
  anchorChars: DEFAULT_ANCHOR_BUDGET_CHARS,
  userQuoteChars: DEFAULT_USER_QUOTE_BUDGET_CHARS,
}

/**
 * 粗略 token 估算（2026-09-29 从 chars/3 改为 CJK 分开算）：
 * 中文一个字约 0.6~0.7 token，chars/3 会把中文低估约一半——自动压缩要等真实用量
 * 冲到窗口 100% 以上才触发，直接爆窗。这里中文按 0.65、其余按 0.33（≈3 字符/token）
 * 估，整体宁可高估（早压一次很便宜）也不低估（报错结束回合）。
 */
const CJK_CHAR = /[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uA4CF\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

function estimateTextTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK_CHAR.test(char)) cjk += 1
    else other += 1
  }
  return cjk * 0.65 + other * 0.33
}

export function estimateTokens(messages: readonly ChatMessage[]): number {
  let tokens = 0
  for (const message of messages) {
    const content = message.content
    if (typeof content === 'string') {
      tokens += estimateTextTokens(content)
    } else if (content !== null) {
      for (const part of content) {
        // 图像每张按 1000 token 估（与原 chars/3 时代的 4000 字符/张同口径）。
        tokens += part.type === 'text' ? estimateTextTokens(part.text) : 1_000
      }
    }
    for (const call of message.tool_calls ?? []) {
      tokens += estimateTextTokens(call.function.name + call.function.arguments)
    }
  }
  return Math.ceil(tokens)
}

export type CompactOutcome = 'compacted' | 'noop'

/** 交接摘要的写法（照 Codex 压缩提示的思路：写给「下一个接手的自己」看）。 */
const COMPACT_PROMPT = `你是上下文压缩器。把下面的对话历史压缩成一份交接摘要，让接手的人（就是下一轮的你）在不看原文的情况下能接着干活。
按这些小标题写，一条都不能少：
## 用户要什么（原话里的目标与约束，一条都别丢）
## 已经做完什么（带文件路径、命令、结果）
## 现在是什么状态（改过哪些文件、跑到哪一步、什么已经验证过）
## 下一步做什么（按顺序写，具体到文件与操作）
## 还缺什么（没确认的假设、等用户拍板的事）
规则：中文，600 字以内；专有名词、文件路径、命令、数字、报错原文一律照抄保留；
PR 号、issue 号、commit SHA、报错代号（ENOENT 这类）也要照抄，不要凭印象重写；
直接陈述事实，不要写「助手随后又」「用户然后说」这种叙述句；历史里没有的东西不要编。`

/** 摘要模型看的转写：工具参数截到 120 字符。 */
const TRANSCRIPT_ARG_CHARS = 120

/**
 * 把切点往前退到安全边界：切出来的尾部不能以孤儿 tool 消息开头。
 *
 * 为什么必须退：协议要求每条 `tool` 消息紧跟在带同 id `tool_calls` 的 assistant 消息后面。
 * 从中间切开会让下一轮请求直接 HTTP 400（工具结果找不到对应的调用）。
 * 退到那条 assistant 消息上，工具调用与它的结果就一起留在尾部。
 *
 * @param messages - 当前会话消息。
 * @param cut - 按条数算出来的原始切点。
 * @returns 安全切点；前面全是工具结果时可能退到 0（调用方按无法压缩处理）。
 */
export function safeCut(messages: readonly ChatMessage[], cut: number): number {
  let at = cut
  while (at > 0 && messages[at]?.role === 'tool') at -= 1
  return at
}

/** 渲染一段历史：`argLimit` 为 null 时工具参数一字不截。 */
function renderRegion(messages: readonly ChatMessage[], argLimit: number | null): string {
  return messages
    .map((message) => {
      const calls =
        message.tool_calls
          ?.map((call) => {
            const args = argLimit === null ? call.function.arguments : call.function.arguments.slice(0, argLimit)
            return `[工具调用 ${call.function.name}(${args})]`
          })
          .join(' ') ?? ''
      return `${message.role}: ${contentText(message.content)}${calls}`
    })
    .join('\n\n')
}

/** 压缩一次；历史太短返回 'noop'（不写任何记录）。 */
export async function compactSession(
  session: Session,
  route: { baseUrl: string; apiKey: string; model: string; maxTokens?: number; temperature?: number },
  signal: AbortSignal,
  /** 摘要之外要原样带过去的内容（任务清单、会话目标这类状态，不能被摘要吃掉）。 */
  extra?: string,
  /** 三个上限；compact 插件把它的配置值传进来。 */
  limits: CompactLimits = DEFAULT_COMPACT_LIMITS,
  /** 爆窗重试用：忽略「历史太短」的 noop 检查直接压一次（切点退到 0 时仍放弃）。 */
  force = false,
): Promise<CompactOutcome> {
  const messages = session.messages
  if (!force && messages.length <= limits.keepRecent + 2) return 'noop'
  const cut = safeCut(messages, messages.length - limits.keepRecent)
  // 切点退到 0 = 整个历史都是工具结果，没有可折的内容（正常历史首条必然是用户消息）
  if (cut === 0) return 'noop'
  const region = messages.slice(0, cut)

  const result = await streamChat(
    {
      ...route,
      messages: [
        {
          role: 'system',
          content: COMPACT_PROMPT,
        },
        { role: 'user', content: `以下是对话历史，按上面的要求输出交接摘要：\n\n${renderRegion(region, TRANSCRIPT_ARG_CHARS)}` },
      ],
    },
    { onDelta() {} },
  )
  if (result.text.trim() === '') throw new Error('摘要模型返回为空')

  // 锚点从没截断的原文里抽：转写里的工具参数截到 120 字符，路径与报错会断在半截上
  const anchors = buildAnchorIndex(renderRegion(region, null), limits.anchorChars)
  const quotes = collectVerbatimUserMessages(region, limits.userQuoteChars)
  const recovery = buildRecoveryFooter({ regionMessages: region.length, sessionFile: session.filePath })
  const carry = extra === undefined || extra.trim() === '' ? '' : `\n\n${extra.trim()}`
  const summary = `${SUMMARY_BANNER}\n${result.text.trim()}${carry}${quotes}${anchors}${recovery}`
  const kept: ChatMessage[] = [{ role: 'user', content: summary }, ...messages.slice(cut)]
  session.replaceWithSummary(summary, kept)
  return 'compacted'
}
