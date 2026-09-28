/**
 * 外观偏好：主题模式、字号、密度三项如何落到 DOM 上。
 *
 * 真源在宿主侧 ~/.dsc/settings.json（走 UiPrefsView）。这里另存一份
 * localStorage 镜像，只为了首帧不要闪：主进程还没连上时就能按上次的
 * 设置画出颜色，等 prefs 到了再用真值覆盖一次。
 */
import type { ThemeMode, UiDensity, UiFontSize } from '@dsc/runtime/contract.js'

export type { ThemeMode, UiDensity, UiFontSize }

/** 一项外观设置，与 UiPrefsView 里的三个字段同名。 */
export interface Appearance {
  themeMode: ThemeMode
  fontSize: UiFontSize
  density: UiDensity
}

/** 出厂默认：深色、标准字号、标准密度。真源是 core/prefs.ts 的 readPrefs 默认值。 */
export const DEFAULT_APPEARANCE: Appearance = {
  themeMode: 'dark',
  fontSize: 'md',
  density: 'standard'
}

/** 字号档位到缩放倍率的映射。 */
const FONT_SCALE: Record<UiFontSize, number> = {
  sm: 0.92,
  md: 1,
  lg: 1.12
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
  root.style.setProperty('--dsc-font-scale', String(FONT_SCALE[appearance.fontSize] ?? 1))

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
      fontSize: parsed.fontSize === 'sm' || parsed.fontSize === 'lg' ? parsed.fontSize : 'md',
      density: parsed.density === 'compact' || parsed.density === 'roomy' ? parsed.density : 'standard'
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
