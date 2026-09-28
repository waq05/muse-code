/**
 * plugin-manager 插件：AI 参与插件管理（对应 dsh 的 plugin_manager 工具）。
 * 注册 `plugin_manager` 工具（list/enable/disable/install）与 `/plugins` 命令。
 *
 * 全部写操作走 core/plugin-loader 的热挂载（即时生效，写盘持久化）；工具
 * risk='write'，执行前经权限模式/审批卡把关。install 仅支持本地 .js 路径
 * （复制到 ~/.dsc/plugins/ 并热挂载）；npm/GitHub 分发不在此层。
 *
 * @module dsc/plugins/plugin-manager
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { Plugin } from '@deepseek-ai/cordis'
import { listPluginInfos } from '../core/plugin-registry.js'
import { mountExternalPlugin, setPluginEnabledHot } from '../core/plugin-loader.js'
import type { ToolEntry } from '../core/tools.js'

function pluginsDir(): string {
  return join(homedir(), '.dsc', 'plugins')
}

function renderList(): string {
  const infos = listPluginInfos()
  if (infos.length === 0) return '（无插件）'
  return infos
    .map((info) => {
      const state = info.enabled ? '启用' : '停用'
      const problem = info.problem !== undefined ? `  ⚠ ${info.problem}` : ''
      const desc = info.description !== '' ? `  ${info.description}` : ''
      return `[${state}] ${info.name} (${info.file})${desc}${problem}`
    })
    .join('\n')
}

export const pluginManagerPlugin: Plugin.Object = {
  name: 'plugin-manager',
  inject: ['tools', 'commands'],
  apply(ctx) {
    const tool: ToolEntry = {
      name: 'plugin_manager',
      description:
        '管理 dsc 插件：列出清单（list）、启用/停用（enable/disable，热生效）、' +
        '安装本地插件文件（install，绝对路径 .js）。写操作会请求用户批准。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'enable', 'disable', 'install'], description: '操作' },
          file: { type: 'string', description: 'enable/disable：插件文件名；install：待安装的 .js 绝对路径' },
        },
        required: ['action'],
      },
      risk: 'write',
      async run(args) {
        const action = String(args.action ?? '')
        switch (action) {
          case 'list':
            return renderList()
          case 'enable':
          case 'disable': {
            const file = String(args.file ?? '')
            if (file === '') return '错误：缺少 file 参数（插件文件名）'
            const outcome = await setPluginEnabledHot(file, action === 'enable')
            if (!outcome.ok) return `错误：${outcome.problem ?? '操作失败'}`
            return `已${action === 'enable' ? '启用' : '停用'}插件 ${file}（热生效，已写盘持久化）`
          }
          case 'install': {
            const source = String(args.file ?? '')
            if (source === '') return '错误：缺少 file 参数（.js 文件绝对路径）'
            const src = isAbsolute(source) ? source : resolve(process.cwd(), source)
            if (!src.endsWith('.js')) return '错误：仅支持 .js 插件文件'
            try {
              const dest = join(pluginsDir(), basename(src))
              mkdirSync(pluginsDir(), { recursive: true })
              copyFileSync(src, dest)
              const ok = await mountExternalPlugin(dest)
              if (!ok) {
                const meta = listPluginInfos().find((info) => info.file === basename(src))
                return `错误：${meta?.problem ?? '挂载失败'}（文件已复制，可修复后重新启用）`
              }
              return `已安装并热挂载 ${basename(src)}`
            } catch (error) {
              return `错误：${error instanceof Error ? error.message : String(error)}`
            }
          }
          default:
            return `错误：未知 action ${action}（可用：list / enable / disable / install）`
        }
      },
    }
    const offTool = ctx.tools.register(tool)

    const offCommand = ctx.commands.register(
      { name: 'plugins', args: '', description: '查看插件清单' },
      ({ ui }) => ui.notice(renderList()),
    )

    return () => {
      offTool()
      offCommand()
    }
  },
}
