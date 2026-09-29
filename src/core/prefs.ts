/**
 * 用户偏好：`~/.dsc/settings.json`，存界面层的默认值、市场源清单，以及侧栏的
 * 排序方式与工作区排列。
 *
 * 模型端点不放这里（那是 config.yaml 的事，见 core/config-store.ts）；
 * 本文件的字段都是「下次启动时希望是什么」，运行期改动走各自服务。
 *
 * @module dsc/core/prefs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ApprovalPolicy, ArchivedFilter, EffortLevel, MarketSource, SessionGroupKey, SessionSortKey, ThemeMode, UiDensity, UiFontSize, UiPrefsView } from '../contract.js'

export const DSC_SETTINGS_JSON = join(homedir(), '.dsc', 'settings.json')

/** 预置市场源：Anthropic 官方技能库 + dsh 仓库自带的 .agents/skills。 */
export const DEFAULT_MARKET_SOURCES: readonly MarketSource[] = [
  { name: 'anthropics', url: 'https://github.com/anthropics/skills/tree/main/skills' },
  {
    name: 'dsh',
    url: 'https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents/skills',
  },
]

/** 界面层偏好。null = 未设置（保持内核默认，不覆盖）。 */
export interface DscPrefs {
  defaultPolicy: ApprovalPolicy | null
  defaultEffort: EffortLevel | null
  marketSources: MarketSource[]
  /** 点窗口右上角 X 时缩到系统托盘而不是退出（桌面端主进程读这个值）。 */
  closeToTray: boolean
  /** 侧栏界面偏好（会话排序、工作区顺序与显示名别名）。 */
  ui: UiPrefsView
}

const POLICIES: readonly ApprovalPolicy[] = ['readonly', 'auto-edit', 'full-access', 'ai-review']
const EFFORTS: readonly EffortLevel[] = ['default', 'off', 'low', 'high', 'max']
const SESSION_SORTS: readonly SessionSortKey[] = ['manual', 'recent', 'created']
const SESSION_GROUPS: readonly SessionGroupKey[] = ['workspace', 'tree', 'flat']
const ARCHIVED_FILTERS: readonly ArchivedFilter[] = ['hide', 'show', 'only']
const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'system']
const FONT_SIZES: readonly UiFontSize[] = ['sm', 'md', 'lg']
const DENSITIES: readonly UiDensity[] = ['compact', 'standard', 'roomy']

/** 工作区别名的长度上限（侧栏一行放不下太长名字）。 */
const ALIAS_LIMIT = 40

/** 读偏好（文件缺失或损坏按默认处理，绝不因为偏好坏掉起不来）。 */
export function readPrefs(): DscPrefs {
  const prefs: DscPrefs = {
    defaultPolicy: null,
    defaultEffort: null,
    marketSources: [...DEFAULT_MARKET_SOURCES],
    closeToTray: true,
    ui: {
      sessionSort: 'manual',
      sessionGroup: 'workspace',
      archivedFilter: 'hide',
      workspaceOrder: [],
      workspaceAliases: {},
      themeMode: 'dark',
      fontSize: 'md',
      density: 'standard',
    },
  }
  if (!existsSync(DSC_SETTINGS_JSON)) return prefs
  try {
    const doc = JSON.parse(readFileSync(DSC_SETTINGS_JSON, 'utf8')) as Record<string, unknown>
    if (typeof doc.closeToTray === 'boolean') {
      prefs.closeToTray = doc.closeToTray
    }
    if (typeof doc.ui === 'object' && doc.ui !== null) {
      const ui = doc.ui as Record<string, unknown>
      if (typeof ui.sessionSort === 'string' && SESSION_SORTS.includes(ui.sessionSort as SessionSortKey)) {
        prefs.ui.sessionSort = ui.sessionSort as SessionSortKey
      }
      if (typeof ui.sessionGroup === 'string' && SESSION_GROUPS.includes(ui.sessionGroup as SessionGroupKey)) {
        prefs.ui.sessionGroup = ui.sessionGroup as SessionGroupKey
      }
      if (typeof ui.archivedFilter === 'string' && ARCHIVED_FILTERS.includes(ui.archivedFilter as ArchivedFilter)) {
        prefs.ui.archivedFilter = ui.archivedFilter as ArchivedFilter
      }
      if (Array.isArray(ui.workspaceOrder)) {
        prefs.ui.workspaceOrder = [...new Set(ui.workspaceOrder.filter((entry): entry is string => typeof entry === 'string' && entry !== ''))]
      }
      if (typeof ui.workspaceAliases === 'object' && ui.workspaceAliases !== null) {
        for (const [cwd, alias] of Object.entries(ui.workspaceAliases as Record<string, unknown>)) {
          if (typeof alias !== 'string') continue
          const name = alias.replace(/\s+/g, ' ').trim().slice(0, ALIAS_LIMIT)
          if (name !== '') prefs.ui.workspaceAliases[cwd] = name
        }
      }
      // 外观三项：老 settings.json 里没有这几项，读不到就保持上面的默认值。
      if (typeof ui.themeMode === 'string' && THEME_MODES.includes(ui.themeMode as ThemeMode)) {
        prefs.ui.themeMode = ui.themeMode as ThemeMode
      }
      if (typeof ui.fontSize === 'string' && FONT_SIZES.includes(ui.fontSize as UiFontSize)) {
        prefs.ui.fontSize = ui.fontSize as UiFontSize
      }
      if (typeof ui.density === 'string' && DENSITIES.includes(ui.density as UiDensity)) {
        prefs.ui.density = ui.density as UiDensity
      }
    }
    if (typeof doc.defaultPolicy === 'string' && POLICIES.includes(doc.defaultPolicy as ApprovalPolicy)) {
      prefs.defaultPolicy = doc.defaultPolicy as ApprovalPolicy
    }
    if (typeof doc.defaultEffort === 'string' && EFFORTS.includes(doc.defaultEffort as EffortLevel)) {
      prefs.defaultEffort = doc.defaultEffort as EffortLevel
    }
    if (Array.isArray(doc.marketSources)) {
      const sources = doc.marketSources
        .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
        .map((entry) => ({ name: String(entry.name ?? ''), url: String(entry.url ?? '') }))
        .filter((entry) => entry.name !== '' && entry.url !== '')
      prefs.marketSources = sources
    }
    return prefs
  } catch {
    return prefs
  }
}

/**
 * 合并并写盘偏好。`ui` 是唯一的嵌套字段，所以深合并它：调用方只传自己要改的
 * 那几项（例如只改排序方式）也不会把顺序和别名抹掉。
 */
export function writePrefs(patch: Partial<DscPrefs>): DscPrefs {
  const current = readPrefs()
  const next: DscPrefs = { ...current, ...patch, ui: { ...current.ui, ...patch.ui } }
  mkdirSync(dirname(DSC_SETTINGS_JSON), { recursive: true })
  writeFileSync(DSC_SETTINGS_JSON, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}
