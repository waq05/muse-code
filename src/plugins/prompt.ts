/**
 * prompt 插件：provide `prompt` 服务——系统提示词的段落注册表与请求体改写链。
 *
 * 这个插件是内核扩展点，也是「这一轮到底发什么提示词」这件事的唯一归属：
 *   - 各功能点往这里登记自己那一段话（模式条款、外部插件的附加说明……），
 *     段落顺序由各段自己声明，稳定内容往前放、易变内容往后放（服务端提示缓存只认前缀）；
 *   - 需要改写发给模型那份消息的功能点（例如只保留最近一张截图）登记改写函数；
 *   - 本插件自己兜底两件事：当前模型没勾照片输入时把图像换成一句说明，
 *     以及指令文件的字符预算（`prompt.instructionBudget`）。
 *
 * 注册都返回退订函数，插件卸载后系统提示里不会留下半句话。
 *
 * @module dsc/plugins/prompt
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { dropImageParts, type ChatMessage } from '../core/llm.js'
import { buildSystemPrompt, DEFAULT_INSTRUCTION_BUDGET, type PromptContribution } from '../core/prompt.js'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import type { PromptService } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'prompt'

/** 图像没能随请求发送时留在正文里的那句话：模型看得见它，才知道自己手上没图。 */
const NO_IMAGE_NOTE = '（当前模型没有声明照片输入能力，图像没有随请求发送）'

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
    /** 请求体改写钩子，按注册顺序逐个应用。 */
    const transforms: Array<(messages: ChatMessage[]) => ChatMessage[]> = []

    const service: PromptService = {
      register(id, text, options) {
        sections.set(id, { order: options?.order ?? 60, text })
        return () => {
          if (sections.get(id)?.text === text) sections.delete(id)
        }
      },
      transformMessages(fn) {
        transforms.push(fn)
        return () => {
          const at = transforms.indexOf(fn)
          if (at >= 0) transforms.splice(at, 1)
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
        for (const fn of [...transforms]) out = fn(out)
        // 模型没勾照片输入：图像换成一句说明。留着图像会让端点整条请求报错，
        // 而电脑操作插件的截图、用户贴进来的图都可能落在这里，所以放在所有改写之后兜底。
        if (!ctx.llm.inputModalities.includes('image')) out = dropImageParts(out, NO_IMAGE_NOTE)
        return out
      },
    }
    ctx.provide('prompt', service)
  },
}
