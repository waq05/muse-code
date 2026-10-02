/**
 * 外部插件热挂载管理器（对应 dsh 的 HMR：启停即时生效，无需重启宿主）。
 *
 * 外部插件是 cordis object plugin（命名导出 inject/apply，可选 name/apiVersion/
 * description），经 `root.plugin(mod, config)` 挂载为独立 Fiber；卸载 =
 * `fiber.dispose()`（自动运行插件 apply 返回的 disposer）。文件变更后的重载
 * 通过 mtime 查询参数破坏 ESM 缓存。
 *
 * 版本管理：插件声明 `export const apiVersion = N` 时与内核 KERNEL_API_VERSION
 * 比对，高于内核 → 拒绝挂载并自动停用（回滚到可用状态），避免每次启动报错。
 *
 * @module dsc/core/plugin-loader
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { ensureResolveHook } from './dsh-compat/resolve-hook.js'
import { dshToolsFacade } from './dsh-compat/tools-facade.js'
import {
  checkApiVersion,
  getPluginConfig,
  getPluginMeta,
  isPluginEnabled,
  readPluginEntries,
  registerPluginMeta,
  writePluginEnabled,
  KERNEL_API_VERSION,
  type PluginMeta,
} from './plugin-registry.js'
import { errText as err } from './err-text.js'

/** 内核插件 API 版本（重导出，供宿主/文档引用）。 */
export { KERNEL_API_VERSION }

/**
 * dsc 自己的全部服务名（services/types.ts 的 Context 声明）。外部插件 inject 里
 * 出现这张表之外的名字，就认定是 dsh 风格的插件，走兼容层挂载路径。
 */
const DSC_SERVICE_NAMES = new Set([
  'llm', 'session', 'approval', 'mode', 'todo', 'plan', 'ask', 'goal', 'tools', 'transcript',
  'commands', 'compact', 'agent', 'prompt', 'guards', 'surfaces', 'waiting', 'skills', 'settings',
  'hooks', 'memory', 'dock', 'ui', 'team', 'mcp', 'sessionSearch', 'approvalFloor', 'interactive',
  'sandbox', 'logger',
])

/** 兼容层开着的判定与说明文案在挂载路径里；这里只留服务名清单。 */

/** 已挂载的外部插件：文件名 → cordis Fiber（dispose 即卸载）。 */
const mounted = new Map<string, Fiber>()

/**
 * 内置但可停用的官方插件（智能体团队、电脑操作）：这里登记它们的插件对象，
 * 于是「打开开关」不必去找 `~/.dsc/plugins/` 下的文件，热挂载直接挂内置对象。
 */
const builtinMounts = new Map<string, Plugin.Object>()

/**
 * 登记一个内置官方插件的挂载对象（宿主装配时调用一次）。
 * @param file - 开关键，与 `registerPluginMeta` 用的名字一致。
 */
export function registerBuiltinMount(file: string, plugin: Plugin.Object): void {
  builtinMounts.set(basename(file), plugin)
}

/** 初始化（宿主启动时调用一次，传入内核 root）。 */
let rootRef: Context | null = null
export function initPluginRuntime(root: Context): void {
  rootRef = root
}

/** 插件模块的最小形状（cordis object plugin + dsc 扩展导出）。 */
interface PluginModule {
  name?: unknown
  description?: unknown
  apiVersion?: unknown
  inject?: unknown
  apply?: unknown
  /** dsh 插件的 schemastery 配置 schema（可调用：传入原始 config，返回校验后的值）。 */
  Config?: unknown
}

/**
 * 读取插件模块（按 mtime 破坏 ESM 缓存，保证文件变更后重载新代码）。
 * @returns null = 模块不可用（错误已写入 meta.problem）。
 */
async function importPluginModule(file: string, meta: PluginMeta): Promise<PluginModule | null> {
  let mtime = 0
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    meta.problem = '文件不存在或不可读'
    return null
  }
  const url = `${pathToFileURL(file).href}?t=${mtime}`
  try {
    return (await import(url)) as PluginModule
  } catch (error) {
    meta.problem = `模块导入失败：${err(error)}`
    return null
  }
}

/**
 * 挂载一个外部插件（热；已挂载时先卸载旧 fiber）。
 * 失败路径：apiVersion 不兼容 / 模块损坏 / 缺 apply → 元数据记 problem，
 * 自动停用（写盘回滚到可用状态），返回 false。
 */
export async function mountExternalPlugin(file: string): Promise<boolean> {
  const root = rootRef
  if (root === null) throw new Error('plugin runtime 未初始化')
  const base = basename(file)

  // 内置官方插件：对象已在宿主装配时登记，不必读文件；与内核同源，跳过 apiVersion 检查。
  const builtin = builtinMounts.get(base)
  if (builtin !== undefined) {
    await unmountExternalPlugin(base)
    try {
      const fiber = root.plugin(builtin, getPluginConfig(base))
      await fiber
      mounted.set(base, fiber)
      const own = getPluginMeta(base)
      if (own !== undefined) own.problem = undefined
      return true
    } catch (error) {
      const own = getPluginMeta(base)
      if (own !== undefined) own.problem = `挂载失败：${err(error)}`
      await disableSilently(base)
      return false
    }
  }

  const meta: PluginMeta = { file: base, name: base.replace(/\.js$/, ''), description: '', source: 'external' }
  registerPluginMeta(meta)

  const mod = await importPluginModule(file, meta)
  if (mod === null) {
    await disableSilently(base)
    return false
  }
  if (typeof mod.name === 'string' && mod.name !== '') meta.name = mod.name
  if (typeof mod.description === 'string' && mod.description !== '') meta.description = mod.description
  if (typeof mod.apiVersion === 'number') meta.apiVersion = mod.apiVersion

  // ---- 版本管理：不兼容自动回滚（停用并写盘） ----
  const problem = checkApiVersion(meta.apiVersion)
  if (problem !== null) {
    meta.problem = problem
    await disableSilently(base)
    return false
  }
  if (typeof mod.apply !== 'function') {
    meta.problem = '缺少 apply 导出（不是 cordis object plugin）'
    await disableSilently(base)
    return false
  }

  // ---- dsh 风格识别 ----
  // inject 里有 dsc 不认识的服务名 = dsh 生态的插件。兼容层没开就提示先开它；开了也
  // 垫不起的（sessionProjections、agents 这类要整个 dsh 会话语义的），话说明白再回滚。
  const injectNames = Array.isArray(mod.inject) ? mod.inject.filter((n): n is string => typeof n === 'string') : []
  const foreign = injectNames.filter((n) => !DSC_SERVICE_NAMES.has(n))
  if (foreign.length > 0) {
    if (!isPluginEnabled('dsh-compat')) {
      meta.problem =
        `插件需要 dsc 不认识的服务：${foreign.join('、')}。若这是 dsh（DeepSeek Harness）风格的插件，` +
        '请先在插件中心启用「dsh 兼容层」（dsh-compat）再打开本插件'
    } else {
      meta.problem =
        `这个 dsh 插件需要 ${foreign.join('、')} 服务，超出 dsc 兼容层的支持范围。` +
        '依赖 dsh 会话语义（投影、agent、目标）的插件个人版不兼容'
    }
    await disableSilently(base)
    return false
  }

  // ---- 配置校验（dsh 插件用 schemastery 导出 Config；有就调一次，失败响亮回滚） ----
  let configForApply = getPluginConfig(base)
  if (typeof (mod.Config as unknown) === 'function') {
    try {
      const validated = (mod.Config as (raw: unknown) => unknown)(configForApply)
      if (validated !== null && typeof validated === 'object') configForApply = validated as Record<string, unknown>
    } catch (error) {
      meta.problem = `插件配置校验失败：${err(error)}（检查 ~/.dsc/plugins.json 里这条目目的 config）`
      await disableSilently(base)
      return false
    }
  }

  // ---- 挂载 ----
  await unmountExternalPlugin(base)
  // 兼容层开着：外部插件的 ctx.tools 换成双形状兼容面（dsc ToolEntry 与 dsh
  // ToolDefinition 都收），dsh 插件 inject ['tools'] 时不再需要任何特判。
  // 解析钩子同步注册（registerHooks），这里先确保它在，插件导入 @deepseek-ai/* 才走得通。
  const needsCompat = isPluginEnabled('dsh-compat')
  if (needsCompat) ensureResolveHook([DSC_PLUGINS_DIR])
  try {
    const pluginObject = {
      name: meta.name,
      inject: mod.inject as string[] | undefined,
      apply: (innerCtx: Context, config: Record<string, unknown>): unknown =>
        (mod.apply as (ctx: Context, config: Record<string, unknown>) => unknown)(
          needsCompat ? compatCtx(innerCtx, base) : innerCtx,
          config,
        ),
    }
    const fiber = root.plugin(pluginObject, configForApply)
    await fiber
    mounted.set(base, fiber)
    meta.problem = undefined
    return true
  } catch (error) {
    meta.problem = `挂载失败：${err(error)}`
    await disableSilently(base)
    return false
  }
}

/**
 * dsh 兼容的 ctx 视图：`ctx.tools` 换成双形状的兼容面（risk 的映射每次 register
 * 时现读插件条目配置），其余服务原样透传。logger 是 cordis 内置服务，不用垫。
 */
function compatCtx(innerCtx: Context, file: string): Context {
  return new Proxy(innerCtx, {
    get(target, prop, receiver) {
      if (prop === 'tools') {
        return dshToolsFacade((entry) => target.tools.register(entry), () => resolveRiskConfig(file))
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/** 从条目树现读 risk 映射：`risk` 是这份插件全部工具的缺省，`risks` 按工具名覆盖。 */
function resolveRiskConfig(file: string): { risk?: unknown; risks?: Record<string, unknown> } {
  const raw = getPluginConfig(file)
  return { risk: raw.risk, risks: raw.risks as Record<string, unknown> | undefined }
}

/** 卸载外部插件（未挂载时静默）。 */
export async function unmountExternalPlugin(file: string): Promise<void> {
  const fiber = mounted.get(file)
  if (fiber === undefined) return
  mounted.delete(file)
  try {
    await fiber.dispose()
  } catch {
    // 卸载失败不阻塞流程（插件 disposer 的错误由 cordis 记录）
  }
}

/** 自动停用：卸载 + 写盘（保留原 config），宿主下次启动也不再加载。 */
async function disableSilently(file: string): Promise<void> {
  await unmountExternalPlugin(file)
  writePluginEnabled(file, false)
}

/**
 * 热启停：enabled = 挂载，否则卸载；结果写盘持久化。
 * @returns ok=false 时 problem 说明原因（UI / system 条目展示）。
 */
export async function setPluginEnabledHot(file: string, enabled: boolean): Promise<{ ok: boolean; problem?: string }> {
  if (enabled) {
    // 内置官方插件没有磁盘文件，登记过的对象直接挂；其余仍按 ~/.dsc/plugins/ 里的文件找。
    const entryFile = builtinMounts.has(basename(file)) ? file : resolveEntryPath(file)
    if (entryFile === null) return { ok: false, problem: `找不到插件文件 ${file}（检查 ~/.dsc/plugins/）` }
    const ok = await mountExternalPlugin(entryFile)
    if (!ok) return { ok: false, problem: getPluginMeta(file)?.problem ?? '挂载失败' }
    // 挂载成功后确保条目树里是启用状态
    writePluginEnabled(file, true)
    return { ok: true }
  }
  await unmountExternalPlugin(file)
  writePluginEnabled(file, false)
  return { ok: true }
}

/** 加载失败信息（宿主启动后写 system 条目展示）。 */
export interface PluginMountFailure {
  file: string
  name: string
  problem: string
}

/** 外部插件目录（桌面端「添加插件」的复制目标，也是这里发现 `.js` 的地方）。 */
export const DSC_PLUGINS_DIR = join(homedir(), '.dsc', 'plugins')

/** 加载全部外部插件（宿主启动时调用）：条目树驱动，含热挂载与回滚语义。 */
export async function mountAllExternalPlugins(
  root: Context,
  extraPaths: string[],
): Promise<PluginMountFailure[]> {
  initPluginRuntime(root)
  const dir = DSC_PLUGINS_DIR
  const files = new Map<string, string>()
  try {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.js')) files.set(name, join(dir, name))
    }
  } catch {
    // 目录不存在：只有 extraPaths
  }
  for (const extra of extraPaths) files.set(basename(extra), extra)

  const failures: PluginMountFailure[] = []
  for (const [base, file] of files) {
    if (isDisabledByEntry(base)) continue
    const ok = await mountExternalPlugin(file)
    if (!ok) {
      const meta = getPluginMeta(base)
      if (meta?.problem !== undefined) failures.push({ file: base, name: meta.name, problem: meta.problem })
    }
  }
  return failures
}

function isDisabledByEntry(file: string): boolean {
  return readPluginEntries().find((entry) => entry.file === file)?.disabled ?? false
}

/** 解析条目树里的文件名 → 绝对路径（仅 ~/.dsc/plugins/ 下的外部插件）。 */
function resolveEntryPath(file: string): string | null {
  const candidate = join(homedir(), '.dsc', 'plugins', file)
  try {
    if (statSync(candidate).isFile()) return candidate
  } catch {
    // fallthrough
  }
  return null
}
