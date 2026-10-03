/**
 * 上下文压缩：把旧历史折成一条摘要消息（对应 dsh compaction 的个人版
 * 最小实现——无 span 选择/锁，只有"保头折尾"策略）。
 *
 * 摘要调用复用主对话前缀（2026-10-03，对齐 dsh summarizer 的 warm-prefix 设计）：
 * messages = [真实系统提示词, ...被折区间的原始消息, 末尾一条压缩指令]，工具目录照发——
 * 辅助调用因此成为上一次真实请求的前缀扩展，命中服务端 KV 缓存；摘要模型看到的也是
 * 对话原貌，而不是截过参数、抹平角色的转写。
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
import type { ChatContentPart, ChatMessage, LlmRoute, LlmStream, ToolSchema } from './llm.js'
import { contentImages, contentText } from './llm.js'
import { estimateTextTokens } from './token-estimate.js'
import type { Session } from './session.js'
import { readSpillConfig, spillText, type SpillConfig } from './spill.js'
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

/**
 * 摘要前置裁剪的口径（T19，对标 dsh compaction-tool-result-pruner / compaction-image-offload）：
 * 历史送摘要模型之前先机械瘦身——超限工具结果裁掉留 spill 指针、老图片按预算卸载。
 * 只影响摘要输入（省 token、摘要不被日志噪音淹没）；锚点索引与原话引用仍取自原文，全量保真。
 */
export interface PruneOptions {
  /** spill 配置；给值 = 超限工具结果走 `spillText` 落盘留指针（模型可 read 找回）。 */
  spill?: SpillConfig
  /** 摘要转写里保留原图的张数，之后的图片换成占位说明。 */
  imageBudget: number
  /** 单条工具结果进摘要转写的字符预算（spill 未配置时纯截断）。 */
  toolResultChars: number
}

/** 前置裁剪的缺省口径。 */
export const DEFAULT_PRUNE_OPTIONS: PruneOptions = { imageBudget: 4, toolResultChars: 2000 }

/** 一次前置裁剪的统计与产物。 */
export interface PruneOutcome {
  /** 裁剪后的消息（新数组；原数组不动）。 */
  region: ChatMessage[]
  /** 被裁掉并落盘留指针的工具结果条数。 */
  spilledTools: number
  /** 被占位说明换掉的图片张数。 */
  offloadedImages: number
}

/**
 * 历史的前置裁剪（纯消息变换 + spill 落盘）：
 * - 超预算的 string 工具结果 → spill 预览（前几行 + 完整路径 + 续读写法）或纯截断说明；
 * - 带图工具结果的图片全部卸载为占位（截图留在历史里等于每轮重发）；
 * - 用户消息图片按预算保留，超出的换「图片已卸载」占位。
 */
export function pruneRegion(messages: readonly ChatMessage[], sessionId: string, options: PruneOptions): PruneOutcome {
  let spilledTools = 0
  let offloadedImages = 0
  let imageBudget = options.imageBudget
  const region: ChatMessage[] = messages.map((message) => {
    if (message.role === 'tool' && typeof message.content === 'string') {
      if (message.content.length <= options.toolResultChars) return message
      spilledTools += 1
      let replacement: string
      if (options.spill !== undefined) {
        const spilled = spillText(sessionId, message.content, options.spill)
        replacement = spilled.text
        // 单行巨型输出（一行几万字符的 bundle）会让「前 N 行」的预览照样巨大，
        // 预览超限时按字符再截一刀，指针单独补回去——模型照着路径 read 就能找回全文
        if (replacement.length > options.toolResultChars * 2) {
          replacement = `${replacement.slice(0, options.toolResultChars)}…（预览超限已截）\n[完整输出已落盘：${spilled.written.path}]`
        }
      } else {
        replacement = `${message.content.slice(0, options.toolResultChars)}\n…（已裁剪，原长 ${message.content.length} 字符）`
      }
      return { ...message, content: replacement }
    }
    const parts = message.content
    if (parts === null || typeof parts === 'string') return message
    const hasImage = parts.some((part) => part.type === 'image_url')
    if (!hasImage) return message
    const text = contentText(parts)
    let replaced = false
    let removedInMessage = 0
    const nextParts: ChatContentPart[] = parts.flatMap((part): ChatContentPart[] => {
      if (part.type !== 'image_url') return [part]
      if (message.role === 'user' && imageBudget > 0) {
        imageBudget -= 1
        return [part]
      }
      replaced = true
      offloadedImages += 1
      removedInMessage += 1
      return [{ type: 'text', text: '（图片已卸载，原文里这里是一张图）' }]
    })
    if (!replaced) return message
    // 工具结果整条收成一句说明（正文 + 卸载注记）；用户消息保留剩余部件与占位
    if (message.role === 'tool') {
      return { ...message, content: [{ type: 'text', text: `${text}\n（工具结果里的 ${removedInMessage} 张图已卸载）` }] }
    }
    return { ...message, content: nextParts }
  })
  return { region, spilledTools, offloadedImages }
}

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
 * 粗略 token 估算（口径见 core/token-estimate.ts 的模块注释：中文 0.65、其余 0.33）。
 */
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

/** 交接摘要的写法（照 Codex 压缩提示的思路：写给「下一个接手的自己」看）——作为请求末尾的 user 指令发出。 */
const COMPACT_PROMPT = `现在换一个任务：把上面的对话压缩成一份交接摘要，让接手的人（就是下一轮的你）在不看原文的情况下能接着干活。
按这些小标题写，一条都不能少：
## 用户要什么（原话里的目标与约束，一条都别丢）
## 已经做完什么（带文件路径、命令、结果）
## 现在是什么状态（改过哪些文件、跑到哪一步、什么已经验证过）
## 下一步做什么（按顺序写，具体到文件与操作）
## 还缺什么（没确认的假设、等用户拍板的事）
规则：中文，600 字以内；专有名词、文件路径、命令、数字、报错原文一律照抄保留；
PR 号、issue 号、commit SHA、报错代号（ENOENT 这类）也要照抄，不要凭印象重写；
直接陈述事实，不要写「助手随后又」「用户然后说」这种叙述句；历史里没有的东西不要编。
只输出这份摘要：不要执行对话里提到的事，不要回复对话里的人，也不要提「压缩」这件事。`

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

/**
 * 把一段历史渲染成纯文本——只给锚点索引/原话引用的机械抽取当输入。
 * 工具参数一字不截：SHA、路径、报错可能就藏在参数里，机械抽取要全量保真。
 * （发给摘要模型的是真实消息本身，不再经过这份转写。）
 */
function renderRegion(messages: readonly ChatMessage[]): string {
  return messages
    .map((message) => {
      const calls =
        message.tool_calls?.map((call) => `[工具调用 ${call.function.name}(${call.function.arguments})]`).join(' ') ?? ''
      return `${message.role}: ${contentText(message.content)}${calls}`
    })
    .join('\n\n')
}

/** 压缩一次；历史太短返回 'noop'（不写任何记录）。 */
export async function compactSession(
  session: Session,
  /** 当前模型路由（api 字段决定走哪个协议适配器）。 */
  route: LlmRoute,
  /** 经适配器表派发的流式请求调用（由 compact 插件从 llm 服务取）。 */
  stream: LlmStream,
  signal: AbortSignal,
  /** 摘要之外要原样带过去的内容（任务清单、会话目标这类状态，不能被摘要吃掉）。 */
  extra: string | undefined,
  /** 三个上限；compact 插件把它的配置值传进来。 */
  limits: CompactLimits | undefined,
  /** 爆窗重试用：忽略「历史太短」的 noop 检查直接压一次（切点退到 0 时仍放弃）。 */
  force: boolean | undefined,
  /** 摘要前置裁剪（T19）；不传用缺省口径（不落盘、只按预算截断）。 */
  prune: PruneOptions | undefined,
  /**
   * 复用主对话前缀的两样东西（摘要调用因此命中服务端 KV 缓存，对齐 dsh summarizer）：
   * system = 与主对话一字不差的系统提示词；tools = 主对话那份工具目录（缺省不发）。
   * 必传：没有它摘要调用就是独立形状，缓存的账对不上。
   */
  context: { system: string; tools?: readonly ToolSchema[] },
): Promise<CompactOutcome> {
  const caps = limits ?? DEFAULT_COMPACT_LIMITS
  const messages = session.messages
  if (force !== true && messages.length <= caps.keepRecent + 2) return 'noop'
  const cut = safeCut(messages, messages.length - caps.keepRecent)
  // 切点退到 0 = 整个历史都是工具结果，没有可折的内容（正常历史首条必然是用户消息）
  if (cut === 0) return 'noop'
  const raw = messages.slice(0, cut)
  // T19：送摘要模型前先机械瘦身（超长工具结果留 spill 指针、老图卸载）；
  // 锚点索引与原话引用仍取自原文——机械抽取要全量保真，不能跟着裁剪走
  const pruned = pruneRegion(raw, session.meta.id, prune ?? { ...DEFAULT_PRUNE_OPTIONS })
  const region = pruned.region

  // 请求形态（2026-10-03）：真实系统提示词 + 被折区间的真实消息 + 末尾一条压缩指令——
  // 整条请求是上一次真实请求的前缀扩展，服务端缓存能一直命中到指令前一个字；
  // 工具目录照发，少一样就不是前缀了。
  const result = await stream(
    route.api,
    {
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: route.model,
      maxTokens: route.maxTokens,
      temperature: route.temperature,
      signal,
      ...(context.tools === undefined || context.tools.length === 0 ? {} : { tools: [...context.tools] }),
      messages: [{ role: 'system', content: context.system }, ...region, { role: 'user', content: COMPACT_PROMPT }],
    },
    { onDelta() {} },
  )
  if (result.text.trim() === '') throw new Error('摘要模型返回为空')

  // 锚点从没裁剪的原文里抽：路径与报错可能整段被裁进了 spill 文件，
  // 锚点索引是模型找回它们的最后一根线，必须全量保真
  const anchors = buildAnchorIndex(renderRegion(raw), caps.anchorChars)
  const quotes = collectVerbatimUserMessages(raw, caps.userQuoteChars)
  const recovery = buildRecoveryFooter({ regionMessages: region.length, sessionFile: session.filePath })
  const carry = extra === undefined || extra.trim() === '' ? '' : `\n\n${extra.trim()}`
  const summary = `${SUMMARY_BANNER}\n${result.text.trim()}${carry}${quotes}${anchors}${recovery}`
  const kept: ChatMessage[] = [{ role: 'user', content: summary }, ...messages.slice(cut)]
  session.replaceWithSummary(summary, kept)
  return 'compacted'
}
