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
import type { Plugin } from '@deepseek-ai/cordis'
import type { ModelInfo, DscCoreConfig } from '../core/config.js'
import { DEFAULT_CAPS, clampEffort, effortToWire, hasEffortLevel, THINKING_LEVEL_LABELS, type ModelCaps } from '../core/model-caps.js'
import type { EffortLevel, ModelChoiceView, Modality } from '../contract.js'
import type { LlmRoute, LlmService } from '../services/types.js'

export const llmPlugin: Plugin.Object<DscCoreConfig> = {
  name: 'llm',
  provide: 'llm',
  apply(ctx, config) {
    let currentProvider = config.defaultProvider
    let currentModel = config.defaultModel
    // 'default' = 不发思考字段（跟随端点默认行为）
    let currentEffort: EffortLevel = 'default'

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
