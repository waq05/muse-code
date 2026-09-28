/**
 * llm 插件：provide `llm` 服务（端点路由 + 模型热切换的唯一状态持有者）。
 * 逻辑迁自 v2 adapter/core-runtime 的 route/setModel 段；提示文本改由
 * runtime 插件经 transcript 呈现，本插件只做校验与状态。
 *
 * @module dsc/plugins/llm
 */
import type { Plugin } from '@deepseek-ai/cordis'
import type { DscCoreConfig } from '../core/config.js'
import type { EffortLevel } from '../contract.js'
import type { LlmRoute, LlmService } from '../services/types.js'

export const llmPlugin: Plugin.Object<DscCoreConfig> = {
  name: 'llm',
  provide: 'llm',
  apply(ctx, config) {
    let currentProvider = config.defaultProvider
    let currentModel = config.defaultModel
    // 'default' = 不发 thinking 字段（跟随端点默认行为）
    let currentEffort: EffortLevel = 'default'

    /**
     * 按给定的端点/模型/档位组一份请求路由，不动当前选择。
     * 子智能体拿它跑角色自己指定的模型，父会话不受影响。
     */
    function routeFor(providerName: string, modelName: string, effort: EffortLevel): LlmRoute {
      const provider = config.providers[providerName]
      if (provider === undefined) {
        throw new Error(
          `没有名为 ${providerName} 的模型端点（检查 ~/.dsc/config.yaml 的 providers 段与对应 API key 环境变量）`,
        )
      }
      return {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: modelName,
        maxTokens: provider.models.find((model) => model.id === modelName)?.maxTokens,
        temperature: config.temperature,
        thinking: effort === 'default' ? undefined : effort === 'off' ? 'disabled' : 'enabled',
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
        return (
          config.providers[currentProvider]?.models.find((model) => model.id === currentModel)
            ?.contextWindow ?? 128_000
        )
      },
      route(): LlmRoute {
        return routeFor(currentProvider, currentModel, currentEffort)
      },
      routeTo(provider, model, effort): LlmRoute {
        return routeFor(provider, model, effort)
      },
      setEffort(effort) {
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
        ctx.emit('dsc/changed')
      },
      listModels() {
        const choices: ReturnType<LlmService['listModels']> = []
        for (const provider of Object.values(config.providers)) {
          for (const model of provider.models) {
            choices.push({
              value: `${provider.name}/${model.id}`,
              provider: provider.name,
              model: model.id,
              description: `${provider.displayName} · ${Math.round(model.contextWindow / 1000)}k 上下文`,
            })
          }
        }
        return choices
      },
    }

    ctx.provide('llm', service)
  },
}
