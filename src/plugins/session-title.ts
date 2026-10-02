/**
 * session-title 插件（T16）：首个回合正常结束后，用一次独立的小模型请求给会话起标题。
 *
 * 为什么不进会话流：标题是纯展示属性（dsh session-title 的同位功能），走 agent.followup
 * 会把「起标题」变成一条模型看得到的轮次；这里直接经 llm 服务的适配器表发小请求，
 * 结果写 meta.json 的 `autoTitle` 字段。展示链是 用户改名 → 自动标题 → 首条消息截断，
 * 用户改过名（或已经生成过）的永不覆盖。
 *
 * 失败完全静默：首条消息截断的兜底标题永远在，起标题失败不值得打扰用户。
 *
 * @module dsc/plugins/session-title
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { patchSessionMeta, readSessionMeta } from '../core/session-meta.js'
import { contentText } from '../core/llm.js'

/** 标题请求的超时（毫秒）：起标题不值得让用户等太久，超了就用兜底。 */
const TITLE_TIMEOUT_MS = 20_000
/** 送给标题模型的用户消息条数与单条字符上限。 */
const MAX_PROMPTS = 3
const PROMPT_CHARS = 600
/** 清洗后的标题长度上限（展示层还会再截，这里先按住模型的手）。 */
const TITLE_CHARS = 40

const TITLE_PROMPT =
  '你是会话标题生成器。根据下面的对话开头，给这个会话起一个标题。'
  + '要求：中文，不超过 20 个字；直接输出标题本身——不要引号、不要句号、'
  + '不要「会话：」「关于」这类前缀；保留对话里的关键名词（文件名、功能名）。'

/** 洗掉模型手痒加的引号、前缀和换行；洗完是空的返回 undefined。 */
export function cleanTitle(raw: string): string | undefined {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ')
    .replace(/^["'「『《【（(]+|["'」』》】）)』]+$/g, '')
    .replace(/^(?:标题|会话|主题)[:：]\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_CHARS)
  return text === '' ? undefined : text
}

export const sessionTitlePlugin: Plugin.Object = {
  name: 'session-title',
  inject: ['session', 'llm'],
  apply(ctx) {
    /** 正在生成标题的会话 id：同会话并发只发一次请求（turn-end 可能连发）。 */
    const inFlight = new Set<string>()

    ctx.on('dsc/turn-end', (reason) => {
      if (reason !== 'completed') return
      void generate()
    })

    async function generate(): Promise<void> {
      const session = ctx.session.current()
      const id = session.meta.id
      if (inFlight.has(id)) return
      // 已有用户标题或自动标题的会话不再生成（生成过就定型；要改用户自己改名）
      const record = readSessionMeta()[id]
      if (record?.title !== undefined || record?.autoTitle !== undefined) return

      const prompts = session.messages
        .filter((message) => message.role === 'user')
        .map((message) => contentText(message.content).replace(/\s+/g, ' ').trim())
        .filter((text) => text !== '')
        .slice(0, MAX_PROMPTS)
      if (prompts.length === 0) return

      inFlight.add(id)
      const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
      const controller = new AbortController()
      try {
        const route = ctx.llm.route()
        const result = await ctx.llm.stream(
          route.api,
          {
            baseUrl: route.baseUrl,
            apiKey: route.apiKey,
            model: route.model,
            maxTokens: 300,
            temperature: 0.3,
            signal: controller.signal,
            messages: [
              { role: 'system', content: TITLE_PROMPT },
              {
                role: 'user',
                content: prompts.map((text, index) => `[第 ${index + 1} 条] ${text.slice(0, PROMPT_CHARS)}`).join('\n'),
              },
            ],
          },
          { onDelta() {} },
        )
        const title = cleanTitle(result.text)
        if (title === undefined) return
        // 写之前再查一次：等待期间用户可能自己改了名
        const latest = readSessionMeta()[id]
        if (latest?.title !== undefined || latest?.autoTitle !== undefined) return
        patchSessionMeta(id, { autoTitle: title })
        ctx.emit('dsc/changed')
      } catch {
        // 静默：截断标题兜底
      } finally {
        clearTimeout(timer)
        inFlight.delete(id)
      }
    }
  },
}
