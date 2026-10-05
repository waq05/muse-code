/**
 * 外观偏好：主题模式、字号、密度、按钮大小四项如何落到 DOM 上。
 *
 * 真源在宿主侧 ~/.dsc/settings.json（走 UiPrefsView）。这里另存一份
 * localStorage 镜像，只为了首帧不要闪：主进程还没连上时就能按上次的
 * 设置画出颜色，等 prefs 到了再用真值覆盖一次。
 * 主题色还要额外报给主进程一次：原生窗口控件区不归样式表管，见 pushWindowChrome。
 */
import { normalizeStatusBarPrefs } from '@dsc/runtime/contract.js'
import type { ThemeMode, UiDensity, UiFontSize, UiPrefsView, UiProcessFold } from '@dsc/runtime/contract.js'
import { dsc } from './bridge.js'
import { normalizeSoundVariant } from './turn-notify.js'

export type { ThemeMode, UiDensity, UiFontSize, UiProcessFold }

/** 字号倍率的可调范围；与 src/core/prefs.ts 读档时的夹取范围一致，改这里要两边一起改。 */
export const FONT_SCALE_MIN = 0.85
export const FONT_SCALE_MAX = 1.35
/** 基准倍率：正文 13px 原样。 */
export const FONT_SCALE_DEFAULT = 1

/** 按钮缩放倍率的可调范围；与 src/core/prefs.ts 读档时的夹取范围一致，改这里要两边一起改。 */
export const BUTTON_SCALE_MIN = 0.9
export const BUTTON_SCALE_MAX = 1.5
/** 基准倍率：图标按钮静息 26px 原样。 */
export const BUTTON_SCALE_DEFAULT = 1

/** 旧存档里的三档字号（0.6 之前存的是字符串），迁移成倍率。 */
const LEGACY_FONT_SCALES: Record<string, number> = { sm: 0.92, md: 1, lg: 1.12 }

/** 一项外观设置：主题模式、字号、密度，以及按钮缩放。 */
export interface Appearance {
  themeMode: ThemeMode
  fontSize: UiFontSize
  density: UiDensity
  buttonScale: number
}

/** 出厂默认：深色、标准字号、标准密度、按钮原样。真源是 core/prefs.ts 的 readPrefs 默认值。 */
export const DEFAULT_APPEARANCE: Appearance = {
  themeMode: 'dark',
  fontSize: FONT_SCALE_DEFAULT,
  density: 'standard',
  buttonScale: BUTTON_SCALE_DEFAULT
}

/**
 * 把外部来的字号值归一成能用的倍率。
 *
 * 数字夹到 0.85–1.35 并保留两位小数；旧的 'sm' / 'md' / 'lg' 按 0.92 / 1 / 1.12
 * 迁移；其余（认不出的字符串、NaN、null）回落 1。宿主存档、localStorage 镜像、
 * 滑杆的值都先过这里，所以旧存档最多是字号不对，不会把界面带崩。
 *
 * @param value 任意来源的字号值（数字或旧版三档字符串）
 * @returns 可以直接写进 `--dsc-font-scale` 的倍率
 */
export function normalizeFontScale(value: unknown): number {
  const legacy = typeof value === 'string' ? LEGACY_FONT_SCALES[value] : undefined
  const scale = legacy ?? (typeof value === 'number' && Number.isFinite(value) ? value : FONT_SCALE_DEFAULT)
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(scale * 100) / 100))
}

/**
 * 只改字号时用：把倍率写到 `<html>` 的内联 `--dsc-font-scale` 上。
 *
 * 设置页滑杆在拖动过程中走这里做即时预览（松手才落盘），正式生效仍走
 * {@link applyAppearance}；写入点只有本文件，样式表与终端都只跟着读。
 *
 * @param scale 字号倍率，越界会被归一
 */
export function applyFontScale(scale: number): void {
  document.documentElement.style.setProperty('--dsc-font-scale', String(normalizeFontScale(scale)))
}

/**
 * 把外部来的按钮缩放值归一成能用的倍率。
 *
 * 数字夹到 0.9–1.5 并保留两位小数；NaN、null、认不出的字符串（手改坏了的存档）
 * 一律回落 1。宿主存档、localStorage 镜像、滑杆的值都先过这里，所以最多是按钮
 * 大小不对，不会把界面带崩。
 *
 * @param value 任意来源的按钮缩放值
 * @returns 可以直接写进 `--dsc-btn-scale` 的倍率
 */
export function normalizeButtonScale(value: unknown): number {
  const scale = typeof value === 'number' && Number.isFinite(value) ? value : BUTTON_SCALE_DEFAULT
  return Math.min(BUTTON_SCALE_MAX, Math.max(BUTTON_SCALE_MIN, Math.round(scale * 100) / 100))
}

/**
 * 把外部来的过程折叠程度归一成四档之一。
 *
 * 认不出的值（老宿主没这一项、手改坏的字符串、null）一律回落 `standard`——与宿主
 * core/prefs.ts 的 readProcessFold 同一张表、同一个默认值，改这里要两边一起改。
 * 首帧的 localStorage 镜像与宿主回读值都先过这里，所以最多是档位不对，不会画出空屏。
 *
 * @param value 任意来源的过程折叠程度
 * @returns 可以直接交给 ChatView 的档位
 */
export function normalizeProcessFold(value: unknown): UiProcessFold {
  return value === 'compact' || value === 'detailed' || value === 'verbose' ? value : 'standard'
}

/**
 * 一个档位开启哪几项能力，见 {@link ./fold-policy.ts}（那张表挪到零依赖模块里，
 * 好让行为单测直接跑源码）。这里只 re-export，调用方沿用 `appearance.js` 这个入口。
 */
export {
  PROCESS_FOLD_POLICIES,
  processFoldPolicy,
  type ProcessFoldPolicy,
} from './fold-policy.js'

/**
 * 只改按钮大小时用：把倍率写到 `<html>` 的内联 `--dsc-btn-scale` 上。
 *
 * 设置页滑杆在拖动过程中走这里做即时预览（松手才落盘），正式生效仍走
 * {@link applyAppearance}；写入点只有本文件，样式表只跟着读。
 *
 * @param scale 按钮缩放倍率，越界会被归一
 */
export function applyButtonScale(scale: number): void {
  document.documentElement.style.setProperty('--dsc-btn-scale', String(normalizeButtonScale(scale)))
}

/**
 * 把宿主 `getUiPrefs` 的返回值归一成渲染层能直接用的偏好。
 *
 * 字号先过 {@link normalizeFontScale}（旧存档存的是三档字符串），按钮缩放过
 * {@link normalizeButtonScale}（手改坏的存档回落 100%）。宿主的读档白名单里
 * 现在有这两项，所以回读回来的值就是存档里的真值。
 *
 * @param prefs 宿主原样返回的界面偏好
 */
export function normalizeUiPrefs(prefs: UiPrefsView): UiPrefsView {
  return {
    ...prefs,
    fontSize: normalizeFontScale(prefs.fontSize),
    buttonScale: normalizeButtonScale(prefs.buttonScale),
    processFold: normalizeProcessFold(prefs.processFold),
    // 两个默认态开关只有 true 才算开：老宿主回读里没有这两项（undefined），
    // 判 `=== true` 让「缺项」与「明确的 false」落到同一个结果上。
    reasoningDefaultOpen: prefs.reasoningDefaultOpen === true,
    toolDefaultOpen: prefs.toolDefaultOpen === true,
    // 任务完成提醒三件套默认全开：口径与上面相反——只有明确的 false 才算关，
    // 缺项（undefined）回落开，与 App 首帧 state 的出厂默认一致；音色过一遍夹取。
    turnCompleteSound: prefs.turnCompleteSound !== false,
    turnCompleteSoundVariant: normalizeSoundVariant(prefs.turnCompleteSoundVariant),
    turnCompleteNotify: prefs.turnCompleteNotify !== false,
    // TUI 状态栏段显隐（0.6.62）：桌面端自己不画状态栏，归一只为透传不丢键；
    // 老宿主回读缺项时回落出厂默认（contract 同一份 normalize）。
    statusBar: normalizeStatusBarPrefs(prefs.statusBar),
    // 分组展开态与会话手动顺序：老宿主回读里没有就给空表，别让侧栏读 undefined。
    sessionExpansion: prefs.sessionExpansion ?? {},
    sessionOrder: prefs.sessionOrder ?? {}
  }
}

const STORAGE_KEY = 'dsc.appearance'
const media = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: light)') : undefined
let systemWatcher: ((event: MediaQueryListEvent) => void) | undefined
/** 最近一次生效的外观。系统偏好监听读它，而不是读挂载当时的那份快照，
 *  否则「先选跟随系统、后改字号」会丢：切换时重画的是老字号。 */
let current: Appearance = DEFAULT_APPEARANCE

/**
 * 把一份外观设置写到 document 根元素上。
 *
 * @param appearance 要生效的外观
 */
export function applyAppearance(appearance: Appearance): void {
  current = appearance
  const root = document.documentElement
  const requested = appearance.themeMode
  const mode: 'dark' | 'light' = requested === 'system' ? (media?.matches ? 'light' : 'dark') : requested

  // data-theme 是 tokens.css 里浅色主题的开关；这里永远不会写出 'system'，
  // 免得样式表去猜系统偏好、和 JS 的判断各说一套。
  root.dataset.theme = mode
  root.dataset.density = appearance.density
  applyFontScale(appearance.fontSize)
  applyButtonScale(appearance.buttonScale)

  // 窗口底色和原生窗口控件区跟着这次的主题一起换，否则浅色主题下顶栏右端
  // 会留一块深色的控件条。
  pushWindowChrome()

  // 原生弹出层（select 的下拉选项列表、右键菜单）不吃页面 CSS，只认主进程的
  // nativeTheme.themeSource——不报的话 OS 是浅色时这些弹层就画成白底，深色主题
  // 里的白色选项文字直接隐形。传「请求的」模式：跟随系统时让主进程也跟着系统翻。
  dsc?.setThemeSource?.(requested)

  // 只有跟随系统时才需要挂监听；系统翻脸就按 current 重画一次。
  if (!media) return
  if (requested === 'system' && !systemWatcher) {
    systemWatcher = () => applyAppearance(current)
    media.addEventListener('change', systemWatcher)
  } else if (requested !== 'system' && systemWatcher) {
    media.removeEventListener('change', systemWatcher)
    systemWatcher = undefined
  }
}

/** 上一轮报给主进程的窗口颜色；字号、密度改动也会走 applyAppearance，靠它吃掉重复推送。 */
let lastChrome = ''
/** 隐藏探针：借浏览器把 var(--dsc-chrome-*) 算成具体颜色，再从这里读走。 */
let chromeProbe: HTMLDivElement | undefined

/**
 * 把当前主题下的窗口底色与原生控件区图标色报给主进程。
 *
 * 原生控件区（最小化/最大化/关闭）由系统画，拿不到 CSS 变量，因此用探针把
 * tokens.css 里那两个压平过的令牌算成 rgb，再转成主进程要的 #rrggbb。
 * 任一值转不出不透明颜色就整轮跳过，主进程留着深色默认值，不会画出错色。
 */
function pushWindowChrome(): void {
  if (!chromeProbe) {
    chromeProbe = document.createElement('div')
    chromeProbe.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none'
    document.documentElement.append(chromeProbe)
  }
  const probe = chromeProbe
  const read = (token: string): string | null => {
    probe.style.backgroundColor = `var(${token})`
    return toHexColor(getComputedStyle(probe).backgroundColor)
  }
  const bar = read('--dsc-chrome-bar')
  const symbol = read('--dsc-chrome-symbol')
  if (bar === null || symbol === null) return
  const next = `${bar} ${symbol}`
  if (next === lastChrome) return
  lastChrome = next
  dsc?.setWindowChrome?.(bar, symbol)
}

/**
 * 把浏览器算出来的颜色转成 #rrggbb。
 *
 * 颜色是从 getComputedStyle 读来的，同一个 color-mix() 令牌在不同内核版本里
 * 可能被写成 `rgb(13, 13, 15)` 或 `color(srgb 0.051 0.051 0.059)`，两种都要认。
 *
 * @param color getComputedStyle 读到的 background-color
 * @returns 不透明颜色的十六进制写法；带 alpha 或不是 sRGB 时返回 null
 */
function toHexColor(color: string): string | null {
  const parts = /^(rgb|color)\((.+)\)$/i.exec(color.trim())
  if (!parts) return null
  // color(srgb …) 的分量是 0~1 的浮点数，rgb() 是 0~255；两种都可能在末位带 alpha。
  const srgb = parts[1].toLowerCase() === 'color'
  const body = srgb ? parts[2].replace(/^\s*srgb\s+/i, '') : parts[2]
  const nums = body.split(/[,/\s]+/).filter((piece) => piece !== '').map(Number)
  if (nums.length < 3 || nums.slice(0, 4).some((n) => !Number.isFinite(n))) return null
  if (nums.length > 3 && nums[3] < 0.999) return null
  const scale = srgb ? 255 : 1
  const hex = (n: number): string =>
    Math.min(255, Math.max(0, Math.round(n * scale)))
      .toString(16)
      .padStart(2, '0')
  return `#${hex(nums[0])}${hex(nums[1])}${hex(nums[2])}`
}

/**
 * 读取上次落盘的外观镜像。第一次运行或存坏了就返回默认值。
 *
 * @returns 缓存的外观，或默认值
 */
export function loadCachedAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_APPEARANCE
    const parsed = JSON.parse(raw) as Partial<Appearance>
    return {
      themeMode: parsed.themeMode === 'light' || parsed.themeMode === 'system' ? parsed.themeMode : 'dark',
      // 镜像里既可能是倍率（现版本），也可能是旧的 'sm' / 'md' / 'lg'。
      fontSize: normalizeFontScale(parsed.fontSize),
      density: parsed.density === 'compact' || parsed.density === 'roomy' ? parsed.density : 'standard',
      buttonScale: normalizeButtonScale(parsed.buttonScale)
    }
  } catch (error) {
    // 镜像只是加速手段，读不出来直接用默认值，不该把启动卡住。
    console.warn('[renderer] 外观缓存读取失败，回退默认外观', error)
    return DEFAULT_APPEARANCE
  }
}

/**
 * 把外观写进 localStorage 镜像，供下次启动的首帧使用。
 *
 * @param appearance 刚落盘到 settings.json 的外观
 */
export function saveCachedAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance))
  } catch (error) {
    // 隐私模式或配额满都会抛；下一次冷启动闪一下默认主题，不影响功能。
    console.warn('[renderer] 外观缓存写入失败', error)
  }
}
