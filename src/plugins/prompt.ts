/**
 * prompt 插件：provide `prompt` 服务——系统提示词的段落注册表与「模型可见投影」链。
 *
 * 这个插件是内核扩展点，也是「这一轮到底发什么提示词」这件事的唯一归属：
 *   - 各功能点往这里登记自己那一段话（模式条款、外部插件的附加说明……），
 *     段落顺序由各段自己声明，稳定内容往前放、易变内容往后放（服务端提示缓存只认前缀）；
 *   - 要改写发给模型那份消息的功能点登记**命名纯投影**（registerProjection），
 *     内核的 fold-system / drop-images 两条护栏与插件投影走同一条按次序的管道；
 *   - 本插件自己兜底一件事：指令文件的字符预算（`prompt.instructionBudget`）。
 *
 * 「模型看见什么」可以从会话日志完整重建：日志存原文，投影链是命名且可复算的
 * （dsh 的 Model-visible ⟺ logged，个人版达成方式见 registerProjection 的注释）。
 *
 * 注册都返回退订函数，插件卸载后系统提示里不会留下半句话。
 *
 * @module dsc/plugins/prompt
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { errText } from '../adapter/transcript.js'
import { dropImageParts, foldSystemMessages, type ChatMessage } from '../core/llm.js'
import { buildSystemPrompt, DEFAULT_INSTRUCTION_BUDGET, type PromptContribution } from '../core/prompt.js'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import type { PromptService } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'prompt'

/** 图像没能随请求发送时留在正文里的那句话：模型看得见它，才知道自己手上没图。 */
const NO_IMAGE_NOTE = '（当前模型没有声明照片输入能力，图像没有随请求发送）'

/** 一条「模型可见投影」：对发给模型的消息做一次纯函数改写。 */
type Projection = { order: number; fn: (messages: ChatMessage[]) => ChatMessage[] }

/** 内置投影占用的名字：协议护栏不许被外部插件顶掉，同名注册直接报错。 */
const RESERVED_PROJECTIONS = new Set(['fold-system', 'drop-images'])

/**
 * 取指令文件的字符预算：夹在 4k 到 200k 之间。
 * @param passed - 装配时直接传进来的配置（内核挂载时的第二参数）。
 */
function readBudget(passed: unknown): number {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const num = Number(raw.instructionBudget)
  if (!Number.isFinite(num)) return DEFAULT_INSTRUCTION_BUDGET
  return Math.min(Math.max(Math.round(num), 4_000), 200_000)
}

export const promptPlugin: Plugin.Object = {
  name: 'prompt',
  inject: ['llm', 'skills'],
  provide: 'prompt',
  apply(ctx, passed) {
    let budget = readBudget(passed)
    /** 附加提示段：id → {顺序, 取文本}。同名后注册者顶掉先注册的，退订只撤自己那一份。 */
    const sections = new Map<string, { order: number; text: () => string }>()
    /**
     * 命名投影表：id → {次序, 改写函数}。内核两条内置投影也在表里，与插件投影
     * 走同一条按次序应用的管道——「日志原文 + 这条链」就是模型看见的内容
     * （dsh Model-visible ⟺ logged 的个人版）。
     */
    const projections = new Map<string, Projection>()

    /** 按次序排好（同次序按 id，稳定），返回投影链。 */
    const projectionChain = (): Array<[string, Projection]> =>
      [...projections.entries()].sort(([aId, a], [bId, b]) =>
        a.order === b.order ? aId.localeCompare(bId) : a.order - b.order,
      )

    // 内置投影一：多条 system 并进头部一条。不少 OpenAI 兼容网关只认「第一条可以是
    // system」，历史中间再冒一条就 400。放在插件投影之后（500）：插件往末尾补的
    // system 话术在这里被并进头部。
    projections.set('fold-system', { order: 500, fn: foldSystemMessages })
    // 内置投影二（永远最后）：模型没勾照片输入时把图像换成一句说明。留着图像会让
    // 端点整条请求报错，而电脑操作插件的截图、用户贴进来的图都可能落在这里。
    projections.set('drop-images', {
      order: 900,
      fn: (messages) => (ctx.llm.inputModalities.includes('image') ? messages : dropImageParts(messages, NO_IMAGE_NOTE)),
    })

    const service: PromptService = {
      register(id, text, options) {
        sections.set(id, { order: options?.order ?? 60, text })
        return () => {
          if (sections.get(id)?.text === text) sections.delete(id)
        }
      },
      registerProjection(id, fn, options) {
        if (RESERVED_PROJECTIONS.has(id)) {
          throw new Error(`投影名 ${id} 是内核保留的（协议护栏），换个名字`)
        }
        projections.set(id, { order: options?.order ?? 60, fn })
        return () => {
          if (projections.get(id)?.fn === fn) projections.delete(id)
        }
      },
      sections() {
        const out: PromptContribution[] = []
        for (const [id, entry] of sections) {
          try {
            out.push({ id, order: entry.order, text: entry.text() })
          } catch {
            // 一个插件把提示词生成崩了，不该让这一轮请求整个失败：这段本轮跳过。
            void id
          }
        }
        return out
      },
      systemPrompt(cwd) {
        budget = readBudget(passed)
        return buildSystemPrompt(cwd, {
          skills: ctx.skills.catalogText(),
          instructionBudget: budget,
          contributions: [
            ...service.sections(),
            { id: 'model', order: 890, text: `当前模型：${ctx.llm.model}（provider ${ctx.llm.provider}）` },
          ],
        })
      },
      rewrite(messages) {
        let out = messages
        for (const [id, projection] of projectionChain()) {
          try {
            out = projection.fn(out)
          } catch (error) {
            // 一个投影崩了不该让这一轮请求整个失败：跳过它（模型本轮看到未投影的
            // 原文），但要把话说出来，别让用户对着莫名其妙的端点报错猜。
            ctx.emit('dsc/notice', `投影 ${id} 这轮没跑成，已跳过：${errText(error)}`)
          }
        }
        return out
      },
    }
    ctx.provide('prompt', service)
  },
}
