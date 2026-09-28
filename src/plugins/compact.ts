/**
 * compact 插件：provide `compact` 服务（自动压缩检查 + /compact 手动压缩）。
 * 逻辑迁自 v2 adapter/core-runtime 的 autoCompact 段与 /compact 命令分支；
 * 结果提示统一经 dsc/notice 事件，注册 /compact 命令进 commands 注册表。
 *
 * @module dsc/plugins/compact
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { compactSession, estimateTokens } from '../core/compact.js'
import { errText } from '../adapter/transcript.js'
import type { CompactService } from '../services/types.js'

export const compactPlugin: Plugin.Object = {
  name: 'compact',
  inject: ['llm', 'session', 'commands'],
  provide: 'compact',
  apply(ctx) {
    const service: CompactService = {
      /** 当前模型路由 + 自动压缩阈值（contextWindow 的 80%）。 */
      async check() {
        const threshold = ctx.llm.contextWindow * 0.8
        if (estimateTokens(ctx.session.current().messages) <= threshold) return
        await compactSession(ctx.session.current(), ctx.llm.route(), new AbortController().signal)
        ctx.emit('dsc/notice', '上下文接近模型上限，已自动压缩历史')
      },

      async run() {
        try {
          const outcome = await compactSession(
            ctx.session.current(),
            ctx.llm.route(),
            new AbortController().signal,
          )
          ctx.emit('dsc/notice', outcome === 'compacted' ? '上下文已压缩' : '历史不长，无需压缩')
        } catch (error) {
          ctx.emit('dsc/notice', `压缩失败：${errText(error)}`)
        }
        ctx.emit('dsc/changed')
      },
    }

    ctx.commands.register(
      { name: 'compact', args: '', description: '压缩上下文' },
      ({ runtime }) => void runtime.compact(),
    )
    ctx.provide('compact', service)
  },
}
