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
import type { Context, Fiber } from '@deepseek-ai/cordis'
import {
  checkApiVersion,
  getPluginConfig,
  getPluginMeta,
  readPluginEntries,
  registerPluginMeta,
  writePluginEnabled,
  KERNEL_API_VERSION,
  type PluginMeta,
} from './plugin-registry.js'

const err = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 内核插件 API 版本（重导出，供宿主/文档引用）。 */
export { KERNEL_API_VERSION }

/** 已挂载的外部插件：文件名 → cordis Fiber（dispose 即卸载）。 */
const mounted = new Map<string, Fiber>()

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

  // ---- 挂载 ----
  await unmountExternalPlugin(base)
  try {
    const pluginObject = {
      name: meta.name,
      inject: mod.inject as string[] | undefined,
      apply: mod.apply as (ctx: Context, config: Record<string, unknown>) => unknown,
    }
    const fiber = root.plugin(pluginObject, getPluginConfig(base))
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
    const entryFile = resolveEntryPath(file)
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

/** 加载全部外部插件（宿主启动时调用）：条目树驱动，含热挂载与回滚语义。 */
export async function mountAllExternalPlugins(
  root: Context,
  extraPaths: string[],
): Promise<PluginMountFailure[]> {
  initPluginRuntime(root)
  const dir = join(homedir(), '.dsc', 'plugins')
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
