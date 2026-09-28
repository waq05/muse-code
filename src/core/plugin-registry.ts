/**
 * 插件注册表：目录快照 + 条目树持久化 + 热挂载（runtime 插件与 host 装配层共享）。
 *
 * - 目录（catalog）：宿主装配时注册——内置插件集 + 外部插件扫描结果；
 * - 条目树（~/.dsc/plugins.json）：`{ version, entries: [{ file, disabled, config }] }`，
 *   参照 dsh 的声明式装配（dsh 为 cordis.patch.yml）。兼容旧版
 *   `{ disabled: string[] }` 格式（读取时自动转换）；
 * - 热挂载：外部插件经 cordis `root.plugin(mod, config)` 挂载为独立 Fiber，
 *   启停 = Fiber.dispose() / 重新挂载，无需重启宿主（详见 core/plugin-loader.ts）。
 *
 * @module dsc/core/plugin-registry
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PluginInfoView } from '../contract.js'

/** 目录里的一项（不含运行时 enabled——它由条目树决定）。 */
export interface PluginMeta {
  /** 开关键：外部插件为文件名，内置为插件名。 */
  file: string
  name: string
  description: string
  source: 'builtin' | 'external'
  /** 插件声明的内核 API 版本；未声明时 undefined。 */
  apiVersion?: number
  /** 加载失败/被自动停用的原因（回滚说明），正常时 undefined。 */
  problem?: string
}

const catalog = new Map<string, PluginMeta>()

/** 注册（或覆盖）一条插件元数据。 */
export function registerPluginMeta(meta: PluginMeta): void {
  catalog.set(meta.file, meta)
}

/** 读取某文件的元数据（无则 undefined）。 */
export function getPluginMeta(file: string): PluginMeta | undefined {
  return catalog.get(file)
}

/** 内核插件 API 版本：外部插件用 `export const apiVersion` 声明兼容的目标版本。 */
export const KERNEL_API_VERSION = 1

/** 条目树的一项。 */
export interface PluginEntry {
  file: string
  disabled: boolean
  /** 透传给插件 apply(ctx, config) 的配置对象。 */
  config: Record<string, unknown>
}

const PLUGINS_JSON = join(homedir(), '.dsc', 'plugins.json')

/** 读取条目树（文件缺失/损坏按空处理；兼容旧版 disabled 数组格式）。 */
export function readPluginEntries(): PluginEntry[] {
  try {
    if (!existsSync(PLUGINS_JSON)) return []
    const doc = JSON.parse(readFileSync(PLUGINS_JSON, 'utf8')) as {
      version?: unknown
      entries?: unknown
      disabled?: unknown
    }
    if (Array.isArray(doc.entries)) {
      return doc.entries
        .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
        .map((entry) => ({
          file: String(entry.file ?? ''),
          disabled: entry.disabled === true,
          config: entry.config !== null && typeof entry.config === 'object' && !Array.isArray(entry.config)
            ? (entry.config as Record<string, unknown>)
            : {},
        }))
        .filter((entry) => entry.file !== '')
    }
    // 旧版：{ disabled: string[] } → 全部条目 disabled=false，仅按列表标记
    if (Array.isArray(doc.disabled)) {
      const disabled = new Set(doc.disabled.filter((entry): entry is string => typeof entry === 'string'))
      return [...disabled].sort().map((file) => ({ file, disabled: true, config: {} }))
    }
    return []
  } catch {
    return []
  }
}

/** 写入条目树（原子性不追求——个人版单写者）。 */
export function writePluginEntries(entries: PluginEntry[]): void {
  mkdirSync(join(homedir(), '.dsc'), { recursive: true })
  writeFileSync(
    PLUGINS_JSON,
    `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
    'utf8',
  )
}

export function isPluginDisabled(file: string): boolean {
  const entry = readPluginEntries().find((candidate) => candidate.file === file)
  return entry?.disabled ?? false
}

export function getPluginConfig(file: string): Record<string, unknown> {
  const entry = readPluginEntries().find((candidate) => candidate.file === file)
  return entry?.config ?? {}
}

/**
 * 更新条目树的 disabled 标记并写盘。
 * @returns false = 该插件不可停用（内置）。
 */
export function writePluginEnabled(file: string, enabled: boolean): boolean {
  const meta = catalog.get(file)
  if (meta !== undefined && meta.source === 'builtin') return false
  const entries = readPluginEntries()
  const index = entries.findIndex((entry) => entry.file === file)
  if (index >= 0) {
    entries[index] = { ...entries[index]!, disabled: !enabled }
  } else {
    entries.push({ file, disabled: !enabled, config: {} })
  }
  writePluginEntries(entries)
  return true
}

/**
 * 版本管理：检查插件声明的 apiVersion 与内核是否兼容。
 * @returns null = 兼容（或插件未声明）；字符串 = 不兼容的原因。
 */
export function checkApiVersion(apiVersion: number | undefined): string | null {
  if (apiVersion === undefined) return null
  if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion)) {
    return `apiVersion 非法（${String(apiVersion)}），应为整数`
  }
  if (apiVersion > KERNEL_API_VERSION) {
    return `插件要求内核 API v${apiVersion}，当前内核 v${KERNEL_API_VERSION}（请升级 dsc）`
  }
  if (apiVersion < 1) {
    return `apiVersion 必须为正整数，收到 ${apiVersion}`
  }
  return null
}

/** 目录快照 + 条目树合并成 UI 投影（内置插件恒启用）。 */
export function listPluginInfos(): PluginInfoView[] {
  const entries = new Map(readPluginEntries().map((entry) => [entry.file, entry]))
  return [...catalog.values()].map((meta) => {
    const entry = entries.get(meta.file)
    const disabled = meta.source === 'external' ? (entry?.disabled ?? false) : false
    return {
      file: meta.file,
      name: meta.name,
      description: meta.description,
      enabled: !disabled,
      source: meta.source,
      apiVersion: meta.apiVersion,
      problem: meta.problem,
    }
  })
}
