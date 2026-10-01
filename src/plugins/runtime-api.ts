/**
 * runtime-api 插件：注册只读工具 `runtime_api`——把运行期的真状态报给模型。
 *
 * 为什么需要它：创造模式要让模型「给自己加模式、给 dsc 写插件」，而它看不见自己跑在
 * 什么运行时里——内核 API 是第几版、现在挂了哪些插件、手上到底有哪些工具、系统提示是
 * 哪些段拼的、守卫链上坐着谁。这些答案在文档里会过时，在这里永远是真的。
 *
 * 只属于创造模式（工具条目上的 `presets: ['maker']`）：标准模式里它不露头——
 * 日常干活用不上这些，白占一段 schema。
 *
 * 只读：它不改任何状态，风险档是 read（不进审批卡）。
 *
 * @module dsc/plugins/runtime-api
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { KERNEL_API_VERSION, listPluginInfos } from '../core/plugin-registry.js'
import { DROPPABLE_SECTIONS, DSC_PRESETS_DIR } from '../core/presets.js'

/** 能单独问的主题（省略 = 全都要）。 */
const TOPICS = ['plugins', 'tools', 'prompt', 'guards', 'surfaces', 'presets'] as const

/** 创造模式的模式名（与 core/presets.ts 的 MAKER_PRESET 同一个值）。 */
const MAKER_PRESET = 'maker'

export const runtimeApiPlugin: Plugin.Object = {
  name: 'runtime-api',
  inject: ['tools', 'guards', 'prompt', 'surfaces', 'presets'],
  apply(ctx) {
    const describeTools = (): string => {
      const rows = ctx.tools.list().map((entry) => {
        const where = entry.presets === undefined ? '' : `（只在 ${entry.presets.join('/')} 模式露面）`
        const head = entry.description.replace(/\s+/g, ' ').slice(0, 90)
        return `- ${entry.name} [${entry.risk}]${where} ${head}`
      })
      return `工具 ${rows.length} 个（模型看见的是当前模式过滤之后的那份）：\n${rows.join('\n')}`
    }

    const describePlugins = (): string => {
      const rows = listPluginInfos().map(
        (item) => `- ${item.file}｜${item.name}｜${item.enabled ? '启用' : '停用'}｜${item.source}${item.toggleable ? '' : '（内核）'}`,
      )
      return `插件 ${rows.length} 个：\n${rows.join('\n')}`
    }

    const describePrompt = (): string => {
      const rows = [...ctx.prompt.sections()]
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        .map((section) => `- ${String(section.order).padStart(4)} ${section.id}｜${section.text.split('\n')[0].slice(0, 60)}`)
      return [
        `当前注册的提示段 ${rows.length} 个（order 小的排前面）：\n${rows.join('\n')}`,
        '内置骨架段（不在上面这张表里，由 core/prompt.ts 拼）：0 identity、10 behavior、20 tool-rules、200 指令文件、210 技能目录、890 模型信息、900 环境事实。',
        `模式能去掉的段：${DROPPABLE_SECTIONS.join('、')}。`,
      ].join('\n')
    }

    const describeGuards = (): string => {
      const rows = ctx.guards.chain.map((guard) => `- order ${guard.order}｜${guard.id}`)
      return `守卫链 ${rows.length} 位（工具动手之前按 order 依次问）：\n${rows.join('\n')}`
    }

    const describeSurfaces = (): string => {
      return `界面快照片段 ${ctx.surfaces.ids.length} 个：${ctx.surfaces.ids.join('、')}\n（每个功能点自己往快照里登记一块，界面按这个键读）`
    }

    const describePresets = (): string => {
      const surface = ctx.presets.surface()
      const rows = surface.options.map((item) => {
        const tools = item.tools === null ? '全量' : item.tools.length === 0 ? '无' : item.tools.join('、')
        return `- ${item.name}｜${item.label}｜工具：${tools}${item.drop.length > 0 ? `｜去掉：${item.drop.join('、')}` : ''}${item.problem === undefined ? '' : `｜有问题：${item.problem}`}`
      })
      return [
        `模式 ${surface.options.length} 个（当前 ${surface.current}，新会话默认 ${surface.defaultName}）：\n${rows.join('\n')}`,
        `模式文件目录：${DSC_PRESETS_DIR}（一个模式一个 .md，frontmatter 认 name/label/description/tools/drop，正文就是提示词）`,
      ].join('\n')
    }

    const BUILDERS: Record<(typeof TOPICS)[number], () => string> = {
      plugins: describePlugins,
      tools: describeTools,
      prompt: describePrompt,
      guards: describeGuards,
      surfaces: describeSurfaces,
      presets: describePresets,
    }

    ctx.tools.register({
      name: 'runtime_api',
      description: `只读查询当前运行时的真状态：内核 API 版本、已挂插件、工具目录、系统提示段、守卫链、快照片段、模式清单。

写插件或加模式之前先问这里，别照文档里的旧说法猜：
- topic=plugins 看挂了哪些插件（file 名就是插件中心里的标识）；
- topic=tools 看模型手上有哪些工具（含名字、风险档、参数说明的开头）；
- topic=prompt 看系统提示是哪些段拼的、模式能去掉哪几段；
- topic=guards 看守卫链上坐着谁、谁先说话；
- topic=surfaces 看界面快照有哪些片段；
- topic=presets 看现有的模式与模式文件目录。

省略 topic = 全套都报（内容较长，只在需要通盘了解时用）。`,
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: [...TOPICS],
            description: '只报哪一块；省略 = 全套。',
          },
        },
        additionalProperties: false,
      },
      risk: 'read',
      // 只属于创造模式：日常干活用不上这些，别白占一段 schema
      presets: [MAKER_PRESET],
      run: async (args) => {
        const topic = typeof args.topic === 'string' ? (args.topic as (typeof TOPICS)[number]) : undefined
        const header = [
          `内核 API 版本：${KERNEL_API_VERSION}（外部插件声明的 apiVersion 高于它会被自动停用）`,
          `已挂插件 ${listPluginInfos().filter((item) => item.enabled).length} 个、工具 ${ctx.tools.list().length} 个、模式 ${ctx.presets.surface().options.length} 个`,
        ].join('\n')
        const body =
          topic !== undefined && topic in BUILDERS
            ? BUILDERS[topic]()
            : TOPICS.map((name) => `## ${name}\n${BUILDERS[name]()}`).join('\n\n')
        return `${header}\n\n${body}`
      },
    })
  },
}
