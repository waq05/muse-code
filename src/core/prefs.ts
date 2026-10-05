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
import type { ApprovalPolicy, ArchivedFilter, EffortLevel, MarketSource, SessionGroupKey, SessionSortKey, ThemeMode, UiDensity, UiPrefsView, UiProcessFold } from '../contract.js'
import { isHttpUrl } from './remote/notify.js'
import { dscPath } from './path-policy.js'

export const DSC_SETTINGS_JSON = dscPath('settings.json')

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
  /**
   * 新会话默认用哪个模式（`~/.dsc/presets/<名字>.md`）。
   * 空串 = 出厂标准档；写了不存在的名字时启动也回落标准档（模式文件可能被删了）。
   */
  defaultPreset: string
  marketSources: MarketSource[]
  /** 点窗口右上角 X 时缩到系统托盘而不是退出（桌面端主进程读这个值）。 */
  closeToTray: boolean
  /** 侧栏界面偏好（会话排序、工作区顺序与显示名别名）。 */
  ui: UiPrefsView
  /** 远程控制偏好（手机浏览器接入；见 plugins/remote.ts）。 */
  remote: RemotePrefs
}

/** 远程控制的开关（设置 → 远程控制）。 */
export interface RemotePrefs {
  /** true = 本机起 HTTP+WS 服务；false = 一个字节都不监听。 */
  enabled: boolean
  /** 监听端口；1024 以下要管理员权限，所以下限从 1024 起。 */
  port: number
  /** true = 绑 0.0.0.0（同一个 Wi-Fi 的手机能连）；false = 只绑 127.0.0.1。 */
  lan: boolean
  /**
   * 浏览器推送（Web Push）总开关，默认关。
   * 关着时：WS hello 里的 pushPublicKey 报 null、订阅端点回 403、一条推送都不发，
   * 也不会为了它生成 VAPID 密钥。
   */
  push: boolean
  /**
   * 通知 Webhook 地址，默认空串 = 关。
   * 只认 http(s)；带 `{title}` / `{body}` / `{url}` 占位符时走 GET（Bark 风格），
   * 不带时 POST JSON（ntfy 风格）。读档时非 http(s) 的一律回落空串。
   */
  notifyWebhook: string
}

/** 远程控制端口范围与缺省值（17321 是随手挑的高位口，不与常见服务撞）。 */
export const REMOTE_PORT_MIN = 1024
export const REMOTE_PORT_MAX = 65535
export const REMOTE_PORT_DEFAULT = 17321

const POLICIES: readonly ApprovalPolicy[] = ['readonly', 'auto-edit', 'full-access', 'ai-review']
const EFFORTS: readonly EffortLevel[] = ['default', 'off', 'low', 'high', 'max']
const SESSION_SORTS: readonly SessionSortKey[] = ['manual', 'recent', 'created']
const SESSION_GROUPS: readonly SessionGroupKey[] = ['workspace', 'tree', 'flat']
const ARCHIVED_FILTERS: readonly ArchivedFilter[] = ['hide', 'show', 'only']
const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'system']
const DENSITIES: readonly UiDensity[] = ['compact', 'standard', 'roomy']
/**
 * 过程折叠程度四档（桌面端「通用 → 过程折叠程度」）。
 * 与桌面端 appearance.ts 的 normalizeProcessFold 同一张表，改这里要两边一起改。
 * satisfies 锁住拼写与类型：档位名写错当场编译报错，不会静默漏进白名单。
 */
const PROCESS_FOLDS = ['compact', 'standard', 'detailed', 'verbose'] as const satisfies readonly UiProcessFold[]
/** 读不出过程折叠程度时的默认档：标准档（整轮折叠 + 阶段分组 + 摘要 + 组头带实时详情）。 */
const PROCESS_FOLD_DEFAULT: UiProcessFold = 'standard'

/**
 * 旧存档里的三档字号：0.6 之前 `ui.fontSize` 存的是字符串，读到时按这张表
 * 换成倍率，之后的存档只存数字。
 */
const LEGACY_FONT_SCALES: Record<string, number> = { sm: 0.92, md: 1, lg: 1.12 }

/** 字号倍率的可调范围，与桌面端滑杆一致（desktop/src/renderer/appearance.ts）。 */
const FONT_SCALE_MIN = 0.85
const FONT_SCALE_MAX = 1.35
/** 读不出字号时的基准倍率：正文 13px 原样。 */
const FONT_SCALE_DEFAULT = 1

/** 按钮倍率的可调范围，与桌面端滑杆一致（desktop/src/renderer/appearance.ts）。 */
const BUTTON_SCALE_MIN = 0.9
const BUTTON_SCALE_MAX = 1.5
/** 读不出按钮倍率时的基准倍率：图标按钮静息 26px 原样。 */
const BUTTON_SCALE_DEFAULT = 1

/** 工作区别名的长度上限（侧栏一行放不下太长名字）。 */
const ALIAS_LIMIT = 40

/** 完成提示音的音色数量，与桌面端 renderer/turn-notify.ts 的夹取一致（改这里要两边一起改）。 */
const SOUND_VARIANT_COUNT = 14

/**
 * 把存档里的完成提示音音色编号读成 1–{@link SOUND_VARIANT_COUNT} 的整数。
 *
 * 手改坏的值（0、负数、小数、字符串、NaN）一律回落 1 号音色，绝不让存档把启动拦下来。
 * 夹取而不是拒绝：设置下拉只有 14 项，夹回范围的值至少还能正常出声。
 *
 * @param value settings.json 里 `ui.turnCompleteSoundVariant` 的原始值
 * @returns 可直接交给渲染层音色表的编号
 */
function readSoundVariant(value: unknown): number {
  const id = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 1
  return Math.min(SOUND_VARIANT_COUNT, Math.max(1, id))
}

/**
 * 把存档里的字号读成倍率。
 *
 * 数字直接夹到 0.85–1.35；旧的 `'sm' | 'md' | 'lg'` 迁移成 0.92 / 1 / 1.12；
 * 手改坏的值（`"大"`、NaN、null）一律回落 1，绝不让存档把启动拦下来。
 *
 * @param value settings.json 里 `ui.fontSize` 的原始值
 * @returns 可直接写进 `--dsc-font-scale` 的倍率
 */
function readFontScale(value: unknown): number {
  const legacy = typeof value === 'string' ? LEGACY_FONT_SCALES[value] : undefined
  const scale = legacy ?? (typeof value === 'number' && Number.isFinite(value) ? value : FONT_SCALE_DEFAULT)
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale))
}

/**
 * 把存档里的按钮倍率读成倍率。
 *
 * 数字直接夹到 0.9–1.5；手改坏的值（`"大"`、NaN、null）一律回落 1，绝不让存档
 * 把启动拦下来。范围与桌面端滑杆一致（desktop/src/renderer/appearance.ts），
 * 改这里要两边一起改。
 *
 * @param value settings.json 里 `ui.buttonScale` 的原始值
 * @returns 可直接写进 `--dsc-btn-scale` 的倍率
 */
function readButtonScale(value: unknown): number {
  const scale = typeof value === 'number' && Number.isFinite(value) ? value : BUTTON_SCALE_DEFAULT
  return Math.min(BUTTON_SCALE_MAX, Math.max(BUTTON_SCALE_MIN, scale))
}

/**
 * 把存档里的过程折叠程度读成四档之一。
 *
 * 认不出的值（手改坏的 `"简单"`、null、数字）一律回落标准档，绝不让存档把启动拦下来；
 * 老 settings.json 里没有这一项，走的也是这条回落。
 *
 * @param value settings.json 里 `ui.processFold` 的原始值
 * @returns 可直接交给渲染层的档位
 */
function readProcessFold(value: unknown): UiProcessFold {
  return typeof value === 'string' && PROCESS_FOLDS.includes(value as UiProcessFold)
    ? (value as UiProcessFold)
    : PROCESS_FOLD_DEFAULT
}

/**
 * 把存档里的监听端口读成合法端口。
 *
 * 数字直接夹到 1024–65535；手改坏的值（字符串、NaN、null、小数）一律回落缺省端口，
 * 绝不让存档把启动拦下来。这里用夹取而不是拒绝：改小 80 想「跑在 80 口」这种输入，
 * 夹成 1024 至少服务起得来，界面上还能看见真实生效的值。
 *
 * @param value settings.json 里 `remote.port` 的原始值
 * @returns 可直接 listen 的端口号
 */
function readRemotePort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return REMOTE_PORT_DEFAULT
  return Math.min(REMOTE_PORT_MAX, Math.max(REMOTE_PORT_MIN, Math.round(value)))
}

/**
 * 把存档里的通知 Webhook 读成合法地址。
 *
 * 只认 http(s)；手改坏的值（`javascript:`、`ftp://`、域名缺协议、数字、null）一律回落空串
 * （空串 = 关）。这里用回落而不是夹取：一个发不出去的地址留着只会每次推送都失败一次。
 *
 * @param value settings.json 里 `remote.notifyWebhook` 的原始值
 * @returns 可直接发请求的地址，或空串
 */
function readNotifyWebhook(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return isHttpUrl(trimmed) ? trimmed : ''
}

/** 模式名形状，与 core/presets.ts 的 PRESET_NAME 同一张表（改这里要两边一起改）。 */
const PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 读偏好（文件缺失或损坏按默认处理，绝不因为偏好坏掉起不来）。 */
export function readPrefs(): DscPrefs {
  const prefs: DscPrefs = {
    defaultPolicy: null,
    defaultEffort: null,
    defaultPreset: '',
    marketSources: [...DEFAULT_MARKET_SOURCES],
    closeToTray: true,
    ui: {
      sessionSort: 'manual',
      sessionGroup: 'workspace',
      archivedFilter: 'hide',
      workspaceOrder: [],
      workspaceAliases: {},
      themeMode: 'dark',
      fontSize: FONT_SCALE_DEFAULT,
      buttonScale: BUTTON_SCALE_DEFAULT,
      density: 'standard',
      processFold: PROCESS_FOLD_DEFAULT,
      // 两个「默认态」开关：出厂都是折叠（与 0.6.3 的实际观感一致，升级不改变现状）。
      reasoningDefaultOpen: false,
      toolDefaultOpen: false,
      // 侧栏分组展开态与会话手动顺序：出厂都是空表（全部用默认行为）。
      sessionExpansion: {},
      sessionOrder: {},
      // 任务完成提醒三项：提示音默认开（合成音，音量压得很低），后台系统通知默认开。
      turnCompleteSound: true,
      turnCompleteSoundVariant: 1,
      turnCompleteNotify: true,
    },
    remote: { enabled: false, port: REMOTE_PORT_DEFAULT, lan: false, push: false, notifyWebhook: '' },
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
      // 外观四项 + 过程折叠程度：老 settings.json 里没有这几项，读不到就保持上面的默认值。
      if (typeof ui.themeMode === 'string' && THEME_MODES.includes(ui.themeMode as ThemeMode)) {
        prefs.ui.themeMode = ui.themeMode as ThemeMode
      }
      if (typeof ui.fontSize === 'string' || typeof ui.fontSize === 'number') {
        prefs.ui.fontSize = readFontScale(ui.fontSize)
      }
      // 按钮缩放只有桌面端这一个写入方，存的是数字；NaN/Infinity 由 readButtonScale 回落 1。
      if (typeof ui.buttonScale === 'number') {
        prefs.ui.buttonScale = readButtonScale(ui.buttonScale)
      }
      if (typeof ui.density === 'string' && DENSITIES.includes(ui.density as UiDensity)) {
        prefs.ui.density = ui.density as UiDensity
      }
      // 过程折叠程度也只有桌面端这一个写入方，存的是四个字符串之一；
      // 认不出的值由 readProcessFold 回落 standard（老档里没这一项也是这条路）。
      if (ui.processFold !== undefined) {
        prefs.ui.processFold = readProcessFold(ui.processFold)
      }
      // 两个默认态开关：老 settings.json 里没有，读不到就保持上面的 false。
      if (typeof ui.reasoningDefaultOpen === 'boolean') {
        prefs.ui.reasoningDefaultOpen = ui.reasoningDefaultOpen
      }
      if (typeof ui.toolDefaultOpen === 'boolean') {
        prefs.ui.toolDefaultOpen = ui.toolDefaultOpen
      }
      // 分组展开态：cwd → 布尔。只认这两种值，行数封顶 500（防手改坏档撑爆 settings.json）。
      if (typeof ui.sessionExpansion === 'object' && ui.sessionExpansion !== null) {
        const expansion: Record<string, boolean> = {}
        for (const [key, value] of Object.entries(ui.sessionExpansion)) {
          if (typeof value === 'boolean') expansion[key] = value
          if (Object.keys(expansion).length >= 500) break
        }
        prefs.ui.sessionExpansion = expansion
      }
      // 会话手动顺序：cwd → 路径序列。只留非空字符串，每表封顶 500 条。
      if (typeof ui.sessionOrder === 'object' && ui.sessionOrder !== null) {
        const order: Record<string, string[]> = {}
        for (const [key, value] of Object.entries(ui.sessionOrder)) {
          if (!Array.isArray(value)) continue
          const ids = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
          if (ids.length > 0) order[key] = ids.slice(0, 500)
          if (Object.keys(order).length >= 500) break
        }
        prefs.ui.sessionOrder = order
      }
      // 任务完成提醒三项：老 settings.json 里没有，读不到就保持上面的默认值（都开、1 号音色）；
      // 音色编号由 readSoundVariant 夹回 1–14，坏值回落 1。
      if (typeof ui.turnCompleteSound === 'boolean') {
        prefs.ui.turnCompleteSound = ui.turnCompleteSound
      }
      if (ui.turnCompleteSoundVariant !== undefined) {
        prefs.ui.turnCompleteSoundVariant = readSoundVariant(ui.turnCompleteSoundVariant)
      }
      if (typeof ui.turnCompleteNotify === 'boolean') {
        prefs.ui.turnCompleteNotify = ui.turnCompleteNotify
      }
    }
    if (typeof doc.defaultPolicy === 'string' && POLICIES.includes(doc.defaultPolicy as ApprovalPolicy)) {
      prefs.defaultPolicy = doc.defaultPolicy as ApprovalPolicy
    }
    if (typeof doc.defaultEffort === 'string' && EFFORTS.includes(doc.defaultEffort as EffortLevel)) {
      prefs.defaultEffort = doc.defaultEffort as EffortLevel
    }
    // 默认模式：认不出的值（手改坏的中文、超长、带斜杠）一律回落出厂标准档，
    // 名字合法但文件不在了也由 presets 插件在启动时回落，不让一个坏偏好把会话卡住。
    if (typeof doc.defaultPreset === 'string' && PRESET_NAME.test(doc.defaultPreset.trim())) {
      prefs.defaultPreset = doc.defaultPreset.trim()
    }
    if (Array.isArray(doc.marketSources)) {
      const sources = doc.marketSources
        .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
        .map((entry) => ({ name: String(entry.name ?? ''), url: String(entry.url ?? '') }))
        .filter((entry) => entry.name !== '' && entry.url !== '')
      prefs.marketSources = sources
    }
    // 远程控制：老 settings.json 里没有这一段，读不到就保持上面的默认值（关着）；
    // 认不出的键一律不认（不往 prefs 里搬），坏值由 readRemotePort 夹回范围。
    if (typeof doc.remote === 'object' && doc.remote !== null) {
      const remote = doc.remote as Record<string, unknown>
      if (typeof remote.enabled === 'boolean') prefs.remote.enabled = remote.enabled
      if (typeof remote.lan === 'boolean') prefs.remote.lan = remote.lan
      if (remote.port !== undefined) prefs.remote.port = readRemotePort(remote.port)
      // 浏览器推送默认关：只认真正的布尔
      if (typeof remote.push === 'boolean') prefs.remote.push = remote.push
      // 通知 Webhook 默认空串：非 http(s) 的坏值回落空串（关掉），不让它每次推送都失败一次
      if (remote.notifyWebhook !== undefined) prefs.remote.notifyWebhook = readNotifyWebhook(remote.notifyWebhook)
    }
    return prefs
  } catch {
    return prefs
  }
}

/**
 * 合并并写盘偏好。`ui` 与 `remote` 是仅有的两个嵌套字段，所以深合并它们：调用方只传
 * 自己要改的那几项（例如只改端口）也不会把 enabled/lan 抹掉。
 */
export function writePrefs(patch: Partial<DscPrefs>): DscPrefs {
  const current = readPrefs()
  const next: DscPrefs = {
    ...current,
    ...patch,
    ui: { ...current.ui, ...patch.ui },
    remote: { ...current.remote, ...patch.remote },
  }
  mkdirSync(dirname(DSC_SETTINGS_JSON), { recursive: true })
  writeFileSync(DSC_SETTINGS_JSON, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}
