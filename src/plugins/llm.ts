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
        const provider = config.providers[currentProvider]
        if (provider === undefined) {
          throw new Error(
            `没有可用的模型端点（检查 ~/.dsc/config.yaml 的 providers 段与对应 API key 环境变量）`,
          )
        }
        return {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: currentModel,
          maxTokens: provider.models.find((model) => model.id === currentModel)?.maxTokens,
          temperature: config.temperature,
          thinking:
            currentEffort === 'default'
              ? undefined
              : currentEffort === 'off'
                ? 'disabled'
                : 'enabled',
        }
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
