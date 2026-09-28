/**
 * tools 插件：provide `tools` 服务（工具注册表）。
 * MiniAgent 每轮请求经 tools.list() 读取当前可用工具——外部插件在运行期
 * register/unregister 即可增删能力。
 *
 * @module dsc/plugins/tools
 */
import type { Plugin } from '@deepseek-ai/cordis'
import type { ToolEntry } from '../core/tools.js'
import type { ToolService } from '../services/types.js'

export const toolsPlugin: Plugin.Object = {
  name: 'tools',
  provide: 'tools',
  apply(ctx) {
    const entries = new Map<string, ToolEntry>()

    const service: ToolService = {
      register(entry) {
        entries.set(entry.name, entry)
        return () => {
          if (entries.get(entry.name) === entry) entries.delete(entry.name)
        }
      },
      list() {
        return [...entries.values()]
      },
    }

    ctx.provide('tools', service)
  },
}
