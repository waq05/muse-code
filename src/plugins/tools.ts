/**
 * tools 插件：provide `tools` 服务（工具注册表）。
 * MiniAgent 每轮请求经 tools.visible() 读取当前可用工具——外部插件在运行期
 * register/unregister 即可增删能力。
 *
 * 注册表（`list()`）与「模型面前那份目录」（`visible()`）是两件事：
 *   - `list()` 是全量，队友按自己的工牌从它里面挑，界面、工具检索、守卫链也读它；
 *   - `visible()` 过一遍模式投影，只有主会话的循环读它——极简模式因此只把 bash 递给模型，
 *     而队友与界面看到的仍是完整注册表。
 * 投影只做减法（约定，不在类型里强制）：注册者返回的那份必须是入参的子集，
 * 别拿它凭空造一个工具出来——模型能调用的名字必须真的在注册表里。
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
    /** 主会话目录的投影表（按注册顺序应用）。 */
    const projections = new Map<string, (tools: readonly ToolEntry[]) => readonly ToolEntry[]>()

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
      project(id, fn) {
        projections.set(id, fn)
        return () => {
          if (projections.get(id) === fn) projections.delete(id)
        }
      },
      visible() {
        let out: readonly ToolEntry[] = [...entries.values()]
        for (const [id, fn] of projections) {
          try {
            out = fn(out)
          } catch (error) {
            // 一个投影崩了不该让这一轮请求整个失败：跳过它，模型这一轮看到的是未裁剪的
            // 目录（比看不到任何工具强），同时把话写进宿主日志，别让人对着怪现象猜。
            console.error(`工具目录投影 ${id} 这轮没跑成，已跳过：`, error)
          }
        }
        return [...out]
      },
    }

    ctx.provide('tools', service)
  },
}
