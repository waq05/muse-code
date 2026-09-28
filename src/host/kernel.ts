/**
 * 内核装配：cordis root Context + 内置 base 插件集（不含 UI）。
 * boot（终端）与 headless（桌面端宿主）共用；UI 插件由各自入口追加。
 *
 * 装配顺序即依赖顺序（cordis 也会按 inject 声明等待服务就绪）：
 *   llm → session → approval → tools → tools-default → transcript
 *   → commands → skills → settings → compact → agent → runtime → [UI] → 外部插件
 *
 * @module dsc/host/kernel
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import type { DscCoreConfig } from '../core/config.js'
import { DSC_CONFIG_YAML, parseTolerantYaml, type MigrationReport } from '../core/migrate.js'
import { getPluginConfig, isPluginEnabled, registerPluginMeta, type PluginMeta } from '../core/plugin-registry.js'
import { mountAllExternalPlugins, registerBuiltinMount } from '../core/plugin-loader.js'
import { pluginManagerPlugin } from '../plugins/plugin-manager.js'
import { desktopDockPlugin } from '../plugins/desktop-dock.js'
import { llmPlugin } from '../plugins/llm.js'
import { sessionPlugin } from '../plugins/session.js'
import { approvalPlugin } from '../plugins/approval.js'
import { toolsPlugin } from '../plugins/tools.js'
import { toolsDefaultPlugin } from '../plugins/tools-default.js'
import { transcriptPlugin } from '../plugins/transcript.js'
import { commandsPlugin } from '../plugins/commands.js'
import { skillsPlugin } from '../plugins/skills.js'
import { settingsPlugin } from '../plugins/settings.js'
import { compactPlugin } from '../plugins/compact.js'
import { agentPlugin } from '../plugins/agent.js'
import { runtimePlugin } from '../plugins/runtime.js'
import { subagentPlugin } from '../plugins/subagent.js'
import { computerUsePlugin } from '../plugins/computer-use.js'

const err = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 官方可开关插件（插件中心「官方可开关」那一档）：代码随包发布，但有开关，
 * 也能跳到自己的设置分区。`defaultDisabled` 为 true 的那些在用户主动打开前不挂载。
 */
export const OFFICIAL_PLUGINS: readonly Omit<PluginMeta, 'source'>[] = [
  {
    file: 'subagent',
    name: '子智能体团队',
    description: '把活拆给几个有明确授权的队友并行干（subagent / team_task 两个工具）',
    toggleable: true,
    defaultDisabled: true,
    settingsSection: 'subagent',
  },
  {
    file: 'computer-use',
    name: '电脑操作',
    description: '截屏、点击、输入这台 Windows 桌面（每次动手都要审批）',
    toggleable: true,
    defaultDisabled: true,
    settingsSection: 'computer-use',
  },
]

/** 官方可开关插件的插件对象（开关键 → 对象）。 */
const OFFICIAL_OBJECTS: Readonly<Record<string, Plugin.Object>> = {
  subagent: subagentPlugin,
  'computer-use': computerUsePlugin,
}

export interface KernelOptions {
  config: DscCoreConfig
  /** 'auto' = last-session 指针；路径 = 指定 jsonl；null = 新建。 */
  resumeSessionPath?: string | null
}

/** 内置 base 插件清单（插件管理页的「内置」分组；不可停用）。 */
export const BUILTIN_PLUGINS: readonly Omit<PluginMeta, 'source'>[] = [
  { file: 'llm', name: '模型路由', description: '配置端点间切换模型与思考强度' },
  { file: 'session', name: '会话', description: '会话存储、恢复与列表' },
  { file: 'approval', name: '审批', description: '工具执行前的人工授权' },
  { file: 'tools', name: '工具注册表', description: '工具的注册与查找' },
  { file: 'tools-default', name: '内置工具', description: 'bash / read / write / edit / glob / grep' },
  { file: 'transcript', name: '会话流', description: '事件折叠成对话条目与快照' },
  { file: 'commands', name: '斜杠命令', description: '/ 命令注册与补全' },
  { file: 'skills', name: '技能', description: 'SKILL.md 发现、开关、市场与 skill 工具' },
  { file: 'settings', name: '设置', description: '设置分区注册表、模型配置与偏好' },
  { file: 'compact', name: '压缩', description: '上下文超阈值自动压缩' },
  { file: 'agent', name: 'Agent 循环', description: 'ReAct 推理与工具调用循环' },
  { file: 'runtime', name: '运行时适配器', description: '把服务织成 UI 消费的 DscRuntime' },
]

/** 创建内核并装好 base 插件集（服务全部就绪；UI 与外部插件未装）。 */
export async function createKernel(options: KernelOptions): Promise<Context> {
  const root = new Context()
  for (const meta of BUILTIN_PLUGINS) registerPluginMeta({ ...meta, source: 'builtin' })
  for (const meta of OFFICIAL_PLUGINS) registerPluginMeta({ ...meta, source: 'builtin' })
  await root.plugin(llmPlugin, options.config)
  await root.plugin(sessionPlugin, { resumeSessionPath: options.resumeSessionPath })
  await root.plugin(approvalPlugin)
  await root.plugin(toolsPlugin)
  await root.plugin(toolsDefaultPlugin)
  await root.plugin(transcriptPlugin)
  await root.plugin(commandsPlugin)
  await root.plugin(skillsPlugin)
  await root.plugin(settingsPlugin, options.config)
  await root.plugin(compactPlugin)
  await root.plugin(agentPlugin)
  await root.plugin(runtimePlugin)
  await root.plugin(desktopDockPlugin, { cwd: process.cwd() })
  await root.plugin(pluginManagerPlugin)
  // 官方可开关插件：先把插件对象登记进热挂载表（拨开关时不必找磁盘文件），
  // 再按条目树决定这次启动挂不挂（没被用户打开过的默认不挂）。
  for (const meta of OFFICIAL_PLUGINS) {
    const plugin = OFFICIAL_OBJECTS[meta.file]
    if (plugin === undefined) continue
    registerBuiltinMount(meta.file, plugin)
    if (isPluginEnabled(meta.file)) await root.plugin(plugin, getPluginConfig(meta.file))
  }
  return root
}

/**
 * 外部插件发现与挂载：`~/.dsc/plugins/*.js` 自动发现（按文件名排序）
 * + config.yaml `plugins` 段显式声明（相对路径基于 cwd 解析）。
 * 走 core/plugin-loader 的热挂载：启停即时生效；条目树
 * （~/.dsc/plugins.json）驱动 disabled/config；apiVersion 不兼容自动停用回滚。
 * 单个插件失败不影响其余插件，失败原因写 system 条目。
 */
export async function loadExternalPlugins(root: Context, configured: string[]): Promise<void> {
  const extraPaths = configured.map((entry) => (isAbsolute(entry) ? entry : resolve(process.cwd(), entry)))
  const failures = await mountAllExternalPlugins(root, extraPaths)
  for (const failure of failures) {
    root.transcript.system(`外部插件 ${failure.name}（${failure.file}）未能加载：${failure.problem}，已自动停用`)
  }
}

// ── config.yaml 的 ui/plugins 段（向后兼容：缺省 tui、无外部插件） ────────────

export interface UiConfig {
  /** 'tui' = 终端 ink；'headless' = stdio 协议桥（桌面端宿主）。 */
  ui: 'tui' | 'headless'
  plugins: string[]
}

export function readUiConfig(): UiConfig {
  try {
    if (!existsSync(DSC_CONFIG_YAML)) return { ui: 'tui', plugins: [] }
    const doc = parseTolerantYaml(readFileSync(DSC_CONFIG_YAML, 'utf8')) as {
      ui?: unknown
      plugins?: unknown
    }
    return {
      ui: doc.ui === 'headless' ? 'headless' : 'tui',
      plugins: Array.isArray(doc.plugins)
        ? doc.plugins.filter((entry): entry is string => typeof entry === 'string')
        : [],
    }
  } catch {
    return { ui: 'tui', plugins: [] }
  }
}

// ── 启动提示（boot 与 headless 共享；全部插件就绪后一次性写入 transcript） ────

export function emitStartupNotes(
  root: Context,
  migration: MigrationReport | null,
  config: DscCoreConfig,
): void {
  if (Object.keys(config.providers).length === 0) {
    root.transcript.system(
      'dsc: 没有可用的模型端点。\n' +
        '请编辑 ~/.dsc/config.yaml 配置 providers（api: openai-completions 风格），\n' +
        'key 放到 apiKeyEnv 指向的环境变量或 ~/.dsc/credentials.yaml。\n' +
        '若本机有 dsh 配置，可运行 `dsc config migrate --force` 迁移。',
    )
  }
  if (migration !== null) {
    root.transcript.system(
      `已从 dsh 迁移模型配置到 ${migration.configPath}（端点 ${migration.providers.join('、')}` +
        `${migration.credentialsPath === null ? '；凭据仍读 dsh 凭据库' : `；凭据已复制到 ${migration.credentialsPath}`}）`,
    )
  }
  if (root.session.startupNote !== null) root.transcript.system(root.session.startupNote)
  if (root.session.resumedStartup) {
    // 启动恢复了历史会话：重放历史到条目（与 dsc/session-open 的行为一致）
    root.transcript.replayHistory(root.session.current().messages)
  }
  root.transcript.system(
    `会话 ${root.session.current().meta.id.slice(0, 8)} · 模型 ${root.llm.provider}/${root.llm.model}`,
  )
  root.transcript.touch()
}
