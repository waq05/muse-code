/**
 * llm 插件：provide `llm` 服务（端点路由 + 模型热切换的唯一状态持有者）。
 * 逻辑迁自 v2 adapter/core-runtime 的 route/setModel 段；提示文本改由
 * runtime 插件经 transcript 呈现，本插件只做校验与状态。
 *
 * 思考档位怎么发、这个模型收不收图，都由 config.yaml 里那一行的能力声明决定
 * （见 core/model-caps.ts）；界面上选了模型不支持的档位会在这里被拦住。
 *
 * @module dsc/plugins/llm
 */
import type { Plugin, Context } from '@deepseek-ai/cordis'
import type { ModelInfo, DscCoreConfig } from '../core/config.js'
import { DEFAULT_CAPS, clampEffort, effortToWire, hasEffortLevel, THINKING_LEVEL_LABELS, type ModelCaps } from '../core/model-caps.js'
import { OPENAI_COMPLETIONS_API, streamChat, type LlmAdapter, type ToolOrphanReport } from '../core/llm.js'
import type { EffortLevel, ModelChoiceView, Modality } from '../contract.js'
import type { LlmRoute, LlmService } from '../services/types.js'

/** 请求侧清洗提醒的账：会话 id → 上次报过的报告形状（同形状不重复报，形状变了再报一次）。 */
const sanitizeNotices = new Map<string, string>()

/** 历史有协议残留、请求侧兜底清洗过：给用户说一声（同一个会话同一种残留只报一次）。 */
function noticeSanitize(ctx: Context, report: ToolOrphanReport): void {
  const sid = ctx.session.current().meta.id
  const shape = `${String(report.droppedResults)}/${String(report.droppedCalls)}/${String(report.droppedMessages)}/${String(report.reordered)}`
  if (sanitizeNotices.get(sid) === shape) return
  sanitizeNotices.set(sid, shape)
  const parts: string[] = []
  if (report.droppedResults > 0) parts.push(`丢弃重复/孤儿的工具结果 ${String(report.droppedResults)} 条`)
  if (report.droppedCalls > 0) parts.push(`剔掉没有回应的工具调用 ${String(report.droppedCalls)} 个`)
  if (report.droppedMessages > 0) parts.push(`整条删除已无内容的回复 ${String(report.droppedMessages)} 条`)
  if (report.reordered > 0) parts.push(`把 ${String(report.reordered)} 条插队的消息移回工具结果之后`)
  ctx.emit(
    'dsc/notice',
    `会话日志里有协议残留（多半来自上一次中断），这次请求已自动清洗：${parts.join('、')}。只影响发给模型的这一份，日志文件不动。`,
  )
}

export const llmPlugin: Plugin.Object<DscCoreConfig> = {
  name: 'llm',
  inject: ['session'],
  provide: 'llm',
  apply(ctx, config) {
    let currentProvider = config.defaultProvider
    let currentModel = config.defaultModel
    // 'default' = 不发思考字段（跟随端点默认行为）
    let currentEffort: EffortLevel = 'default'
    // T39：会话里记过模型选择就先恢复它（/model 切过的不丢）；没记过才用配置默认。
    const remembered = ctx.session.current().state('model')
    if (remembered !== undefined && findModel(remembered.provider, remembered.model) !== undefined) {
      currentProvider = remembered.provider
      currentModel = remembered.model
    }
    // 切会话跟着切模型：新会话记过谁就用谁，没记过保持当前选择（与 /model 的
    // 进程级热切换同一手感）。配置里已经没有的模型不恢复，静默留在当前选择上。
    ctx.on('dsc/session-open', ({ session }) => {
      const recalled = session.state('model')
      if (recalled === undefined || findModel(recalled.provider, recalled.model) === undefined) return
      if (recalled.provider === currentProvider && recalled.model === currentModel) return
      currentProvider = recalled.provider
      currentModel = recalled.model
      // 原来选的档位在新模型上未必存在，退回「默认」比留着发不出去的值强
      currentEffort = clampEffort(capsFor(currentProvider, currentModel), currentEffort)
      ctx.emit('dsc/changed')
    })
    /** 协议适配器表：id → 适配器。内置 openai-completions 预注册，插件可补新的协议。 */
    const adapters = new Map<string, LlmAdapter>([
      [OPENAI_COMPLETIONS_API, { id: OPENAI_COMPLETIONS_API, stream: streamChat }],
    ])

    function findModel(providerName: string, modelName: string): ModelInfo | undefined {
      return config.providers[providerName]?.models.find((model) => model.id === modelName)
    }

    /** 这个模型声明了什么能力；查不到（老配置、临时路由）按旧行为算。 */
    function capsFor(providerName: string, modelName: string): ModelCaps {
      return findModel(providerName, modelName) ?? DEFAULT_CAPS
    }

    /**
     * 按给定的端点/模型/档位组一份请求路由，不动当前选择。
     * 子智能体拿它跑角色自己指定的模型，父会话不受影响。
     * 档位在这个模型上不存在时退回「默认」（不发字段），而不是把端点不认识的值发出去。
     */
    function routeFor(providerName: string, modelName: string, effort: EffortLevel): LlmRoute {
      const provider = config.providers[providerName]
      if (provider === undefined) {
        throw new Error(
          `没有名为 ${providerName} 的模型端点（检查 ~/.dsc/config.yaml 的 providers 段与对应 API key 环境变量）`,
        )
      }
      const model = findModel(providerName, modelName)
      const wire = effortToWire(capsFor(providerName, modelName), clampEffort(capsFor(providerName, modelName), effort))
      return {
        api: provider.api ?? OPENAI_COMPLETIONS_API,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: modelName,
        maxTokens: model?.maxTokens,
        temperature: config.temperature,
        thinking: wire.thinking,
        reasoningEffort: wire.reasoningEffort,
      }
    }

    const service: LlmService = {
      get provider() {
        return currentProvider
      },
      get model() {
        return currentModel
      },
      get effort() {
        return currentEffort
      },
      get contextWindow() {
        return findModel(currentProvider, currentModel)?.contextWindow ?? 128_000
      },
      get inputModalities(): Modality[] {
        return capsFor(currentProvider, currentModel).modalities
      },
      route(): LlmRoute {
        return routeFor(currentProvider, currentModel, currentEffort)
      },
      routeTo(provider, model, effort): LlmRoute {
        return routeFor(provider, model, effort)
      },
      registerAdapter(adapter) {
        if (adapters.has(adapter.id)) {
          throw new Error(`协议适配器 ${adapter.id} 已经注册过（内置与插件不允许重名，换个 id）`)
        }
        adapters.set(adapter.id, adapter)
        return () => {
          if (adapters.get(adapter.id) === adapter) adapters.delete(adapter.id)
        }
      },
      stream(api, request, handlers) {
        const adapter = adapters.get(api)
        if (adapter === undefined) {
          const known = [...adapters.keys()].map((id) => (id === api ? `「${id}」` : id)).join('、')
          throw new Error(
            `端点声明的协议 ${api} 没有对应的适配器（已注册：${known}）。\n` +
              '检查 config.yaml 里这个端点的 api 字段，或启用提供该协议的插件。',
          )
        }
        return adapter.stream(request, { ...handlers, onSanitize: (report) => noticeSanitize(ctx, report) })
      },
      setEffort(effort) {
        const caps = capsFor(currentProvider, currentModel)
        if (!hasEffortLevel(caps, effort)) {
          const declared =
            caps.thinkingLevels.length === 0
              ? '这个模型没声明思考能力，只有「默认」可选'
              : `这个模型只支持：${caps.thinkingLevels.map((level) => THINKING_LEVEL_LABELS[level]).join('、')}`
          const wanted = effort === 'default' ? '默认' : THINKING_LEVEL_LABELS[effort]
          throw new Error(`思考档位「${wanted}」用不了 —— ${declared}（在设置 → 模型里给它勾上）`)
        }
        currentEffort = effort
        ctx.emit('dsc/changed')
      },
      setModel(provider, model) {
        const target = config.providers[provider]
        if (target === undefined) {
          throw new Error(
            `没有名为 ${provider} 的端点；可用：${Object.keys(config.providers).join('、') || '（无）'}`,
          )
        }
        if (!target.models.some((entry) => entry.id === model)) {
          throw new Error(
            `端点 ${provider} 没有模型 ${model}；可用：${target.models.map((entry) => entry.id).join('、')}`,
          )
        }
        currentProvider = provider
        currentModel = model
        // 原来选的档位在新模型上未必存在，退回「默认」比留着发不出去的值强
        currentEffort = clampEffort(capsFor(provider, model), currentEffort)
        // T39：记进当前会话——恢复会话时优先用它，重启/重开不再回落配置默认
        ctx.session.current().appendState('model', { provider, model })
        ctx.emit('dsc/changed')
      },
      listModels(): ModelChoiceView[] {
        const choices: ModelChoiceView[] = []
        for (const provider of Object.values(config.providers)) {
          for (const model of provider.models) {
            const extra = model.modalities.filter((modality: Modality) => modality !== 'text')
            choices.push({
              value: `${provider.name}/${model.id}`,
              provider: provider.name,
              model: model.id,
              description: [
                provider.displayName,
                `${Math.round(model.contextWindow / 1000)}k 上下文`,
                extra.length > 0 ? extra.map((modality) => (modality === 'image' ? '照片' : '视频')).join('·') : '',
                model.thinkingLevels.length > 0 ? `思考 ${model.thinkingLevels.length} 档` : '无思考档位',
              ]
                .filter((part: string) => part !== '')
                .join(' · '),
              contextWindow: model.contextWindow,
              thinkingLevels: model.thinkingLevels,
              modalities: model.modalities,
            })
          }
        }
        return choices
      },
    }

    ctx.provide('llm', service)
  },
}
