/**
 * plugin-manager 插件：AI 参与插件管理（对应 dsh 的 plugin_manager 工具）。
 * 注册 `plugin_manager` 工具（list/enable/disable/install/browse_remote/install_remote）
 * 与 `/plugins` 命令。
 *
 * 全部写操作走 core/plugin-loader 的热挂载（即时生效，写盘持久化）；工具
 * risk='write'，执行前经权限模式/审批卡把关。install 仅支持本地 .js 路径
 * （复制到 ~/.dsc/plugins/ 并热挂载）。T28：browse_remote / install_remote
 * 照技能市场的两类源（GitHub 目录 / 索引 JSON）远程安装——拉取走
 * core/market 的插件市场函数，源 URL 必须是 https；远程插件是任意代码，
 * 审批卡上写明来源，装不装由用户点头。
 *
 * @module dsc/plugins/plugin-manager
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { Plugin } from '@deepseek-ai/cordis'
import { browsePluginMarketSource, installPluginMarketEntry, type MarketEntry } from '../core/market.js'
import { listPluginInfos } from '../core/plugin-registry.js'
import { mountExternalPlugin, setPluginEnabledHot } from '../core/plugin-loader.js'
import type { ToolEntry } from '../core/tools.js'
import { dscPath } from '../core/path-policy.js'

function pluginsDir(): string {
  return dscPath('plugins')
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
        '安装本地插件文件（install，.js 绝对路径）、浏览远程插件源（browse_remote）、' +
        '从远程安装插件（install_remote，https 的 .js 直链）。写操作会请求用户批准。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'enable', 'disable', 'install', 'browse_remote', 'install_remote'],
            description: '操作',
          },
          file: {
            type: 'string',
            description:
              'enable/disable：插件文件名；install：待安装的 .js 绝对路径；' +
              'browse_remote：市场源地址（GitHub 目录链接或 .json 索引）；install_remote：插件 .js 的 https 直链',
          },
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
          case 'browse_remote': {
            const url = String(args.file ?? '')
            if (url === '') return '错误：缺少 file 参数（市场源地址：GitHub 目录链接或 .json 索引）'
            if (!url.startsWith('https://')) return '错误：远程源必须是 https 地址'
            try {
              const entries = await browsePluginMarketSource({ name: 'remote', url })
              if (entries.length === 0) return '这个源里没有可安装的 .js 插件'
              return entries
                .map((entry) => `- ${entry.name}${entry.version === undefined ? '' : `（${entry.version}）`}：${entry.description}`)
                .join('\n')
            } catch (error) {
              return `错误：${error instanceof Error ? error.message : String(error)}`
            }
          }
          case 'install_remote': {
            const url = String(args.file ?? '')
            if (url === '') return '错误：缺少 file 参数（插件 .js 的 https 直链）'
            if (!url.startsWith('https://')) return '错误：远程安装必须走 https 直链'
            const name = basename(new URL(url).pathname)
            if (!name.endsWith('.js')) return '错误：远程插件必须是 .js 文件（直链）'
            // 远程插件 = 任意代码：装前把来源完整摆进审批卡（risk=write 本来就会弹卡），
            // 用户点头才落盘、才挂载。
            try {
              const entry: MarketEntry = {
                name,
                description: `远程插件（来源：${url}）`,
                source: url,
                kind: 'flat',
                root: url.replace(/\/[^/]*$/, ''),
                mainFile: name,
                files: [],
              }
              const target = await installPluginMarketEntry(entry, pluginsDir())
              const ok = await mountExternalPlugin(target)
              if (!ok) {
                const meta = listPluginInfos().find((info) => info.file === name)
                return `错误：${meta?.problem ?? '挂载失败'}（文件已下载到 ${target}，可修复后重新启用）`
              }
              return `已从 ${url} 安装并热挂载 ${name}`
            } catch (error) {
              return `错误：${error instanceof Error ? error.message : String(error)}`
            }
          }
          default:
            return `错误：未知 action ${action}（可用：list / enable / disable / install / browse_remote / install_remote）`
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
