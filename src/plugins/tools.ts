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

/**
 * 注册表的形状关：拦住形状不对的条目（最常见的是 dsh 风格的 ToolDefinition——
 * 有 execute 没有 run），别等循环真调它的时候才炸。dsh 风格的定义要走兼容层。
 */
function assertToolEntryShape(entry: ToolEntry): void {
  if (entry === null || typeof entry !== 'object') throw new Error('工具条目必须是对象')
  if (typeof entry.name !== 'string' || entry.name === '') throw new Error('工具要有非空的 name')
  if (typeof entry.run !== 'function') {
    const record = entry as unknown as Record<string, unknown>
    if (typeof record.execute === 'function') {
      throw new Error(
        `工具 ${entry.name} 是 dsh 风格的定义（有 execute 没有 run）。` +
          '请在插件中心启用「dsh 兼容层」（dsh-compat），然后停用再启用这个插件重新挂载',
      )
    }
    throw new Error(`工具 ${entry.name} 缺 run 函数`)
  }
}

export const toolsPlugin: Plugin.Object = {
  name: 'tools',
  provide: 'tools',
  apply(ctx) {
    const entries = new Map<string, ToolEntry>()

    const service: ToolService = {
      register(entry) {
        assertToolEntryShape(entry)
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
