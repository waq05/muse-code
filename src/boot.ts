/**
 * dsc harness 的终端入口：cordis 内核装配 + ink TUI 插件。
 * 由 bin/dsc.js spawn（bin 键 msc）；编译产物 lib/boot.js。
 *
 * 万物皆插件：本文件只负责装配——base 服务集见 host/kernel.ts，
 * UI 由 spawn 哪个入口决定（本文件 = TUI；headless.ts = stdio 协议桥），
 * 外部插件经 ~/.dsc/plugins/*.js 与 config.yaml plugins 段加载。
 *
 * @module dsc/boot
 */
import { readConfig } from './core/config.js'
import { migrateFromDsh } from './core/migrate.js'
import { getPluginConfig } from './core/plugin-registry.js'
import { createKernel, emitStartupNotes, loadExternalPlugins, readUiConfig } from './host/kernel.js'
import { remotePlugin } from './plugins/remote.js'
import { tuiPlugin } from './plugins/tui.js'

async function main(): Promise<void> {
  // 首次运行：把 dsh 的模型配置迁移到 dsc 自己的文件（幂等，只读 dsh）
  const migration = migrateFromDsh()
  const config = readConfig()
  const ui = readUiConfig()

  const resumeEnv = process.env.DSC_RESUME_SESSION
  const resumeSessionPath =
    resumeEnv === undefined || resumeEnv === '' ? null : resumeEnv === '1' ? 'auto' : resumeEnv

  const root = await createKernel({ config, resumeSessionPath })
  await root.plugin(tuiPlugin)
  // 远程控制：开关在设置里（默认关），插件自己决定活不活
  await root.plugin(remotePlugin, getPluginConfig('remote'))
  await loadExternalPlugins(root, ui.plugins)
  emitStartupNotes(root, migration, config)
}

main().catch((error) => {
  console.error('[msc] 启动失败：', error)
  process.exit(1)
})
