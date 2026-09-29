/**
 * guards 插件：provide `guards` 服务——工具执行前的守卫链与工具结果的观察者链。
 *
 * 这个插件是内核扩展点，自己不做任何判定：模式往这里注册 order 10 的那一位，
 * 审批注册 order 30 的那一位，遮红注册结果观察者链上唯一那一位。
 * 循环只问「这条链怎么说」，不认识链上的任何一位（形状照 dsh 的 guard/loop-tool-guards）。
 *
 * 注册表本体在 core/tool-guards.ts 的 ToolGuardRegistry（纯逻辑，自检脚本直接测它），
 * 这里只负责把它挂成服务、并在卸载时把注册全部撤掉。
 *
 * @module dsc/plugins/guards
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { ToolGuardRegistry } from '../core/tool-guards.js'
import type { GuardService } from '../services/types.js'

export const guardsPlugin: Plugin.Object = {
  name: 'guards',
  provide: 'guards',
  apply(ctx) {
    const registry = new ToolGuardRegistry()
    const service: GuardService = {
      register: (guard) => registry.register(guard),
      registerObserver: (observer) => registry.registerObserver(observer),
      get chain() {
        return registry.chain
      },
      gate: (input) => registry.gate(input),
      observe: (toolName, text) => registry.observe(toolName, text),
    }
    ctx.provide('guards', service)
  },
}
