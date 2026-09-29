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
  /**
   * true = 内置但可停用（官方插件，例如子智能体团队、电脑操作）。
   * 缺省 false 且 source='builtin' 的就是运行内核，不提供开关。
   */
  toggleable?: boolean
  /**
   * 这个插件贡献的设置分区 id；插件中心据此在详情页渲染它的配置表单。
   * 内置插件在 kernel 清单里声明；外部插件用 `export const settingsSection` 声明。
   */
  settingsSection?: string
  /**
   * true = 条目树还没有这条记录时，默认按「停用」处理。
   * 危险一点的官方插件（电脑操作）用它，装完不主动拿到桌面控制权。
   */
  defaultDisabled?: boolean
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

/**
 * 内核插件 API 版本：外部插件用 `export const apiVersion` 声明兼容的目标版本。
 * 2 = 增加设置分区（`ctx.settings.registerSection`）与技能来源
 * （`ctx.skills.registerProvider` / `registerMarket`）两个扩展点；
 * 3 = 增加请求组装扩展点（`ctx.prompt.register` 附加系统提示、
 * `ctx.prompt.transformMessages` 改写发给模型的消息），并允许外部插件用
 * `export const settingsSection` 声明自己的设置分区 id（插件中心据此在详情页画它的配置表单）；
 * 4 = 增加三个内核扩展点：工具守卫链（`ctx.guards.register` / `registerObserver`，
 * 工具动手之前的闸门与工具输出的改写）、快照片段（`ctx.surfaces.register`，界面每块状态
 * 由那个功能点自己登记）、等人登记（`ctx.waiting.register`，哪张卡片正挂着等用户）；
 * 会话记录也在此版多了按 id 存取状态这一对（`ctx.session.appendState` / `session.state`）。
 * 5 = 新增一个可选服务 `sandbox`（当前档位、强制执行等级、可写根与路径判定；
 * 插件关着时不存在，读它要用 `ctx.get('sandbox')`），并把「命令执行器缝」开给随包发布的
 * 内置插件（`src/core/tools/command-runner.ts`：沙箱的容器后端靠它把本机 shell 换成容器）。
 * 1 到 4 的插件照常挂载（版本检查只拦「高于内核」的声明）。
 */
export const KERNEL_API_VERSION = 5

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
 * 合并写一个插件的配置对象（插件中心「配置」分区与插件自己共用这一个入口，
 * 落 `~/.dsc/plugins.json` 的条目树）。值传 null 表示删掉这个键，回到插件默认值。
 */
export function writePluginConfig(
  file: string,
  patch: Record<string, unknown | null>,
): Record<string, unknown> {
  const entries = readPluginEntries()
  const index = entries.findIndex((entry) => entry.file === file)
  const config: Record<string, unknown> = index >= 0 ? { ...entries[index]!.config } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === '') continue
    if (value === null) delete config[key]
    else config[key] = value
  }
  if (index >= 0) entries[index] = { ...entries[index]!, config }
  // 新建条目时沿用元数据声明的默认开关：只改配置值不该顺手把插件点亮
  else entries.push({ file, disabled: catalog.get(file)?.defaultDisabled === true, config })
  writePluginEntries(entries)
  return config
}

/**
 * 取一个插件此刻该用的配置：装配时传进来的那份作底，磁盘上那份覆盖它。
 * 为什么要覆盖——设置分区保存走 {@link writePluginConfig} 改的是磁盘，
 * 插件每次用值时现调这个函数，改完配置就不必重启宿主。
 * @param file - 条目树里的插件 file（内置插件就是插件名，例如 `goal`）。
 * @param passed - 装配时传进来的第二参数；不是对象就当没给。
 */
export function resolvePluginConfig(file: string, passed?: unknown): Record<string, unknown> {
  const fromDisk = getPluginConfig(file)
  if (passed === null || typeof passed !== 'object' || Array.isArray(passed)) return fromDisk
  return { ...(passed as Record<string, unknown>), ...fromDisk }
}

/**
 * 这个插件该不该挂载。条目树没记录时回落到元数据声明的默认值
 * （`defaultDisabled` 为 true 的官方插件在用户主动打开之前不挂载）。
 */
export function isPluginEnabled(file: string): boolean {
  const entry = readPluginEntries().find((candidate) => candidate.file === file)
  if (entry === undefined) return catalog.get(file)?.defaultDisabled !== true
  return !entry.disabled
}

/**
 * 更新条目树的 disabled 标记并写盘。
 * @returns false = 该插件不可停用（属于运行内核，即 source='builtin' 且没标 toggleable）。
 */
export function writePluginEnabled(file: string, enabled: boolean): boolean {
  const meta = catalog.get(file)
  const canToggle = meta === undefined || meta.source === 'external' || meta.toggleable === true
  if (!canToggle) return false
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
    return `插件要求内核 API v${apiVersion}，当前内核 v${KERNEL_API_VERSION}（请升级 Muse Code）`
  }
  if (apiVersion < 1) {
    return `apiVersion 必须为正整数，收到 ${apiVersion}`
  }
  return null
}

/** 目录快照 + 条目树合并成 UI 投影（运行内核那一档恒启用）。 */
export function listPluginInfos(): PluginInfoView[] {
  const entries = new Map(readPluginEntries().map((entry) => [entry.file, entry]))
  return [...catalog.values()].map((meta) => {
    const entry = entries.get(meta.file)
    const canToggle = meta.source === 'external' || meta.toggleable === true
    const disabled = canToggle ? (entry?.disabled ?? meta.defaultDisabled === true) : false
    return {
      file: meta.file,
      name: meta.name,
      description: meta.description,
      enabled: !disabled,
      source: meta.source,
      toggleable: canToggle,
      settingsSection: meta.settingsSection,
      apiVersion: meta.apiVersion,
      problem: meta.problem,
    }
  })
}
