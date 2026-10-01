/**
 * 内核装配：cordis root Context + 内置 base 插件集（不含 UI）。
 * boot（终端）与 headless（桌面端宿主）共用；UI 插件由各自入口追加。
 *
 * 装配顺序即依赖顺序（cordis 也会按 inject 声明等待服务就绪）：
 *   llm → session → 三个扩展点（guards / surfaces / waiting）→ approval → tools
 *   → tools-default → transcript → commands → skills → prompt → mode → settings → hooks
 *   → compact → todo → plan → ask → agent → goal → runtime → [UI] → 外部插件
 *
 * 两处顺序是有原因的，不只是好看：
 *   - approval 早于 mode：模式换档广播 `dsc/mode-changed`，审批要听（审批卡上写当前档位）；
 *   - transcript 早于 plan：恢复会话时先把会话流清空，计划卡那条条目才不会被清掉。
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
import { guardsPlugin } from '../plugins/guards.js'
import { surfacesPlugin } from '../plugins/surfaces.js'
import { waitingPlugin } from '../plugins/waiting.js'
import { approvalPlugin } from '../plugins/approval.js'
import { hooksPlugin } from '../plugins/hooks.js'
import { promptPlugin } from '../plugins/prompt.js'
import { modePlugin } from '../plugins/mode.js'
import { todoPlugin } from '../plugins/todo.js'
import { planPlugin } from '../plugins/plan.js'
import { askPlugin } from '../plugins/ask.js'
import { goalPlugin } from '../plugins/goal.js'
import { memoryPlugin } from '../plugins/memory.js'
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
import { webSearchPlugin } from '../plugins/web-search.js'
import { approvalFloorPlugin } from '../plugins/approval-floor.js'
import { spillPlugin } from '../plugins/spill.js'
import { sessionSearchPlugin } from '../plugins/session-search.js'
import { lifecycleHooksPlugin } from '../plugins/lifecycle-hooks.js'
import { mcpPlugin } from '../plugins/mcp.js'
import { toolSearchPlugin } from '../plugins/tool-search.js'
import { sandboxPlugin } from '../plugins/sandbox.js'
import { schedulePlugin } from '../plugins/schedule.js'
import { lspPlugin } from '../plugins/lsp.js'
import { browserPlugin } from '../plugins/browser.js'
import { selfImprovePlugin } from '../plugins/self-improve.js'
import { fileReviewPlugin } from '../plugins/file-review.js'

const err = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 官方可开关插件（插件中心「官方可开关」那一档）：代码随包发布，但有开关，
 * 也能跳到自己的设置分区。`defaultDisabled` 为 true 的那些在用户主动打开前不挂载。
 */
export const OFFICIAL_PLUGINS: readonly Omit<PluginMeta, 'source'>[] = [
  {
    file: 'subagent',
    name: '智能体团队',
    description: '将任务拆分给有明确授权的队友并行执行，提供 subagent 与 team_task 工具',
    toggleable: true,
    defaultDisabled: true,
    settingsSection: 'subagent',
  },
  {
    file: 'computer-use',
    name: '电脑操作',
    description: '控制 Windows 桌面：截屏、点击、输入，每次操作均需审批',
    toggleable: true,
    defaultDisabled: true,
    settingsSection: 'computer-use',
  },
  {
    file: 'web-search',
    name: '网页搜索',
    description: '提供 web_search 工具，经配置的搜索提供方检索网页，支持 Tavily、博查、Serper',
    toggleable: true,
    settingsSection: 'web-search',
  },
  // 下面这批默认开关按一条规矩定：会拉起外部进程、连外部服务器或改写每轮请求
  // 工具面的那几档默认关（`defaultDisabled: true`），使用者按需打开；
  // 提升安全与本地便利、且不配就完全无副作用的那几档默认开。
  {
    file: 'approval-floor',
    name: '审批灾难地板',
    description: '任何协作模式与权限模式下都不放行的灾难命令硬拒，外加白名单自动放行与黑名单拦截',
    toggleable: true,
    settingsSection: 'approval-floor',
  },
  {
    file: 'spill',
    name: '大输出溢出',
    description: '工具输出超长时落到临时文件，只把前几行与文件路径回给模型，防止上下文被长日志撑爆',
    toggleable: true,
    settingsSection: 'spill',
  },
  {
    file: 'session-search',
    name: '会话全文检索',
    description: '给历史会话建中文可用的全文索引，提供 session_search 工具与 /search 命令',
    toggleable: true,
    settingsSection: 'session-search',
  },
  {
    file: 'lifecycle-hooks',
    name: '生命周期钩子',
    description: '读 ~/.dsc/lifecycle-hooks.json，按 Codex 的十二个生命周期事件跑外部命令钩子',
    toggleable: true,
    defaultDisabled: true,
    settingsSection: 'lifecycle-hooks',
  },
  {
    file: 'mcp',
    name: 'MCP 客户端',
    description: '连接 MCP server（stdio / streamable-http），把它们的工具挂成 mcp__服务器__工具',
    toggleable: true,
    defaultDisabled: true,
    settingsSection: 'mcp',
  },
  {
    file: 'tool-search',
    name: '工具渐进披露',
    description: '用 tool_search / tool_describe / tool_call 三个检索型工具替代把全部工具 schema 塞进每轮请求',
    toggleable: true,
    defaultDisabled: true,
    settingsSection: 'tool-search',
  },
  // 第二批官方可开关插件。默认开关同一条规矩，沙箱是唯一例外：
  // 它默认开——不配就没有外部进程、没有外部服务器，开着的收益（越界写入当场拒）大于打扰，
  // 且默认档 workspace-write 不挡正常的工作区读写。
  {
    file: 'sandbox',
    name: '沙箱',
    description: '三档模式 + 可写根白名单 + 受保护路径 + 命令前缀策略 + 一次性升权，容器后端可换真隔离',
    toggleable: true,
    settingsSection: 'sandbox',
  },
  {
    file: 'file-review',
    name: '文件更改预览',
    description: 'edit / write 落盘前把 unified diff 摆进对话流，改哪几行看得见，超长按行截断',
    toggleable: true,
    settingsSection: 'file-review',
  },
  {
    file: 'schedule',
    name: '定时任务',
    description: 'after / at / every / daily / weekly / cron 六种选择器，到点把提醒投回原会话',
    toggleable: true,
    defaultDisabled: true,
    settingsSection: 'schedule',
  },
  {
    file: 'lsp',
    name: 'LSP 代码智能',
    description: '连语言服务器查定义与引用，并把本次编辑新引入的报错附在写入结果里',
    toggleable: true,
    defaultDisabled: true,
    settingsSection: 'lsp',
  },
  {
    file: 'browser',
    name: '浏览器自动化',
    description: 'DOM 级控制浏览器：无障碍快照 + ref 定位点击输入，不是截图比坐标',
    toggleable: true,
    defaultDisabled: true,
    settingsSection: 'browser',
  },
  {
    file: 'self-improve',
    name: '自我改进',
    description: '从纠正与复盘里沉淀经验：候选清单、技能草稿、技能自修与审计回滚',
    toggleable: true,
    defaultDisabled: true,
    settingsSection: 'self-improve',
  },
]

/** 官方可开关插件的插件对象（开关键 → 对象）。 */
const OFFICIAL_OBJECTS: Readonly<Record<string, Plugin.Object>> = {
  subagent: subagentPlugin,
  'computer-use': computerUsePlugin,
  'web-search': webSearchPlugin,
  'approval-floor': approvalFloorPlugin,
  spill: spillPlugin,
  'session-search': sessionSearchPlugin,
  'lifecycle-hooks': lifecycleHooksPlugin,
  mcp: mcpPlugin,
  'tool-search': toolSearchPlugin,
  sandbox: sandboxPlugin,
  'file-review': fileReviewPlugin,
  schedule: schedulePlugin,
  lsp: lspPlugin,
  browser: browserPlugin,
  'self-improve': selfImprovePlugin,
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
  { file: 'guards', name: '工具守卫链', description: '工具动手之前该问谁：模式闸门与审批卡各占一环' },
  { file: 'surfaces', name: '快照片段注册表', description: '界面快照里每块状态投影由那个功能点自己登记' },
  { file: 'waiting', name: '等人登记表', description: '哪张卡片正挂着等用户做决定，一问就知道' },
  { file: 'approval', name: '审批', description: '工具执行前的人工授权' },
  {
    file: 'hooks',
    name: '安全钩子',
    description: '工具动手之前按用户自己登记的规则与脚本拦一道，能直接拦下或强制问人',
    settingsSection: 'hooks',
  },
  { file: 'tools', name: '工具注册表', description: '工具的注册与查找' },
  { file: 'tools-default', name: '内置工具', description: 'bash / read / write / edit / glob / grep' },
  { file: 'transcript', name: '会话流', description: '事件折叠成对话条目与快照' },
  { file: 'commands', name: '斜杠命令', description: '/ 命令注册与补全' },
  { file: 'skills', name: '技能', description: 'SKILL.md 发现、开关、市场与 skill 工具' },
  { file: 'prompt', name: '提示词组装', description: '系统提示词分段注册表与请求体改写链' },
  { file: 'mode', name: '协作模式', description: '执行 / 计划 / 探索 / 免打扰四档与工具闸门' },
  { file: 'settings', name: '设置', description: '设置分区注册表、模型配置与偏好' },
  { file: 'compact', name: '压缩', description: '上下文超阈值自动压缩', settingsSection: 'compact' },
  { file: 'todo', name: '任务清单', description: '模型自己维护的清单与实时进度条' },
  { file: 'plan', name: '计划交付', description: '写计划文件并弹评审卡等用户批' },
  { file: 'ask', name: '模型提问', description: 'ask_user 工具与它的选项卡' },
  { file: 'agent', name: 'Agent 循环', description: 'ReAct 推理与工具调用循环' },
  { file: 'goal', name: '会话目标', description: '跨轮自动续跑与它的刹车', settingsSection: 'goal' },
  {
    file: 'memory',
    name: '长期记忆',
    description: '跨会话留下的事实：全局事实、用户偏好、当前工作区各一格，注入给模型的就是这些',
    settingsSection: 'memory',
  },
  { file: 'runtime', name: '运行时适配器', description: '把服务织成 UI 消费的 DscRuntime' },
]

/** 创建内核并装好 base 插件集（服务全部就绪；UI 与外部插件未装）。 */
export async function createKernel(options: KernelOptions): Promise<Context> {
  const root = new Context()
  for (const meta of BUILTIN_PLUGINS) registerPluginMeta({ ...meta, source: 'builtin' })
  for (const meta of OFFICIAL_PLUGINS) registerPluginMeta({ ...meta, source: 'builtin' })
  await root.plugin(llmPlugin, options.config)
  await root.plugin(sessionPlugin, { resumeSessionPath: options.resumeSessionPath })
  // 三个内核扩展点先挂：后面每个功能点都要往它们上面登记自己那一块。
  await root.plugin(guardsPlugin)
  await root.plugin(surfacesPlugin)
  await root.plugin(waitingPlugin)
  await root.plugin(approvalPlugin, getPluginConfig('approval'))
  await root.plugin(toolsPlugin)
  await root.plugin(toolsDefaultPlugin)
  await root.plugin(transcriptPlugin)
  await root.plugin(commandsPlugin)
  await root.plugin(skillsPlugin)
  await root.plugin(promptPlugin, getPluginConfig('prompt'))
  await root.plugin(modePlugin)
  await root.plugin(settingsPlugin, options.config)
  // 安全钩子排在设置之后：它既要往设置里挂自己的分区，又要把闸门挂到守卫链上。
  await root.plugin(hooksPlugin)
  await root.plugin(compactPlugin)
  await root.plugin(todoPlugin)
  await root.plugin(planPlugin)
  await root.plugin(askPlugin, getPluginConfig('ask'))
  await root.plugin(agentPlugin)
  await root.plugin(goalPlugin, getPluginConfig('goal'))
  // 长期记忆排在 agent 之后：轮次结束时它要用 agent.followup 启动一次记忆复盘。
  await root.plugin(memoryPlugin, getPluginConfig('memory'))
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
      'Muse Code：没有可用的模型端点。\n' +
        '请编辑 ~/.dsc/config.yaml 配置 providers（api: openai-completions 风格），\n' +
        'key 放到 apiKeyEnv 指向的环境变量或 ~/.dsc/credentials.yaml。\n' +
        '若本机有 dsh 配置，可运行 `msc config migrate --force` 迁移。',
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
    root.transcript.replayHistory(root.session.current().messages, root.session.current().toolErrors)
  }
  root.transcript.system(
    `会话 ${root.session.current().meta.id.slice(0, 8)} · 模型 ${root.llm.provider}/${root.llm.model}`,
  )
  root.transcript.touch()
}
