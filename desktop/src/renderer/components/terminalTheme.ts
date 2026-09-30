/**
 * 终端配色与字号向设计令牌对齐。
 *
 * xterm 的 theme 只认 `#rrggbb` / `rgb()` 这类具体色值（见 xterm 的 common/Color
 * 里的 css.toColor），而 tokens.css 里的令牌大多是 `color-mix(...)` 表达式：
 * `getComputedStyle(root).getPropertyValue('--dsc-green')` 拿回来的是没求值的原文，
 * 直接塞给 xterm 会被当成非法色丢弃。因此颜色一律分两步取：
 *
 * 1. 借一个隐藏元素把令牌写成 `color: var(--dsc-…)`，读它求过值的计算色，
 *    Chromium 会给出 `rgb(...)` / `rgba(...)` / `color(srgb ...)` / `oklab(...)`；
 * 2. 用离屏 canvas 把那个色画进 1×1 像素再读回来，得到 srgb 的 rgba 分量。
 *
 * 转不出 srgb 的色值不改写成黑，而是回落到兜底色并就地 console.warn 一次，
 * 免得「令牌读不到」在界面上表现为一片安静的黑。
 *
 * @module desktop/renderer/components/terminalTheme
 */
import type { ITheme } from '@xterm/xterm'

/** 终端字号基准（改动前写死的 12.5px）；设置里的字号百分比按 --dsc-font-scale 连续缩放它。 */
const TERM_FONT_BASE = 12.5

/** 兜底色：改动前写死的那几个值，只在令牌读不到或转不出 srgb 时使用。 */
const FALLBACK = {
  background: '#101013',
  foreground: '#cfd3d6',
  accent: '#8ea1ff',
  onAccent: '#fcfcfc',
} as const

/** 探色时先落的哨兵：非法色值会被 Chromium 忽略、fillStyle 原样保留，据此识别「画不出来」。 */
const CANVAS_SENTINEL = '#010203'

/** rgba 四分量，alpha 取 0~255。 */
type Rgba = [number, number, number, number]

/** 同一份「原因|色值」只警告一次：切主题会把同一个坏值反复送到这里。 */
const warned = new Set<string>()

let probe: HTMLDivElement | null = null
let canvas: HTMLCanvasElement | null = null

/** 兜底底色（hex 解析，不碰 DOM）：背景令牌自己转不出来时，半透明令牌就压在这个色上。 */
const FALLBACK_BACKGROUND: Rgba = cssColorToRgba(FALLBACK.background) ?? [16, 16, 19, 255]

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message)
}

/**
 * 取（并懒建）挂在文档里的零尺寸隐藏元素。
 *
 * 用 visibility:hidden 而不是 display:none：元素照样进排版，计算样式必然求过值，
 * 不会把 color-mix 原文吐回来。
 */
function probeElement(): HTMLDivElement {
  if (probe === null) {
    const element = document.createElement('div')
    element.setAttribute('aria-hidden', 'true')
    element.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none'
    document.body.appendChild(element)
    probe = element
  }
  return probe
}

/**
 * 把一个 `--dsc-*` 令牌读成求过值的颜色原文。
 *
 * 借 `color` 这条属性求值：它同样会把 color-mix 算成具体色值，又不用像 border-color
 * 那样把简写展开成四条边。
 *
 * @param token 令牌名，如 `--dsc-bg-card`
 * @returns 形如 `rgb(22, 22, 24)` / `color(srgb ... / 0.94)` 的已求值色
 */
function resolvedTokenColor(token: string): string {
  const element = probeElement()
  element.style.setProperty('color', `var(${token})`)
  const value = getComputedStyle(element).color
  element.style.removeProperty('color')
  return value
}

/** 把 0~255 的分量写成两位十六进制（越界先夹住）。 */
function hex2(component: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(component)))
  return clamped.toString(16).padStart(2, '0')
}

function toHex(rgba: Rgba): string {
  return `#${hex2(rgba[0])}${hex2(rgba[1])}${hex2(rgba[2])}`
}

/** 半透明的色压到不透明底上，返回压完的色（alpha 归 255）。 */
function composite(source: Rgba, base: Rgba): Rgba {
  const alpha = source[3] / 255
  return [
    source[0] * alpha + base[0] * (1 - alpha),
    source[1] * alpha + base[1] * (1 - alpha),
    source[2] * alpha + base[2] * (1 - alpha),
    255,
  ]
}

/** 把 `none`（CSS 允许分量缺省写成 none）与百分数归一到 0~255 的数字。 */
function colorComponent(raw: string): number | null {
  if (raw === 'none') return 0
  const value = Number.parseFloat(raw)
  if (Number.isNaN(value)) return null
  return raw.includes('%') ? (value / 100) * 255 : value
}

/** alpha 分量：百分数或 0~1 的小数都归到 0~255。 */
function alphaComponent(raw: string): number | null {
  if (raw === 'none') return 255
  const value = Number.parseFloat(raw)
  if (Number.isNaN(value)) return null
  const ratio = raw.includes('%') ? value / 100 : value
  return Math.max(0, Math.min(1, ratio)) * 255
}

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` → rgba 分量。 */
function fromHex(input: string): Rgba | null {
  const match = /^#([0-9a-f]+)$/i.exec(input)
  if (match === null) return null
  const digits = match[1]!
  // 3/4 位是每位重复一次的简写，6/8 位是每分量两位；其余长度一律不当色值看
  const single = digits.length === 3 || digits.length === 4
  const group = single ? 1 : 2
  const base = single ? 3 : 6
  if (digits.length !== base && digits.length !== base + 1) return null
  const parts: number[] = []
  for (let i = 0; i < digits.length; i += group) {
    const chunk = digits.slice(i, i + group)
    parts.push(single ? parseInt(chunk, 16) * 17 : parseInt(chunk, 16))
  }
  return [parts[0]!, parts[1]!, parts[2]!, parts.length === 4 ? parts[3]! : 255]
}

/** `rgb(1, 2, 3)` / `rgb(1 2 3 / .5)` / `rgba(...)`（含百分数与 none）→ rgba 分量。 */
function fromRgbFunction(input: string): Rgba | null {
  const match = /^rgba?\(([^)]*)\)$/i.exec(input)
  if (match === null) return null
  const parts = match[1]!.trim().split(/[\s,/]+/).filter((part) => part !== '')
  if (parts.length !== 3 && parts.length !== 4) return null
  const channels: number[] = []
  for (let i = 0; i < 3; i++) {
    const value = colorComponent(parts[i]!)
    if (value === null) return null
    channels.push(value)
  }
  const alpha = parts.length === 4 ? alphaComponent(parts[3]!) : 255
  if (alpha === null) return null
  return [channels[0]!, channels[1]!, channels[2]!, alpha]
}

/**
 * 离屏 canvas 落色：`color(srgb ...)`、`oklab(...)`、`oklch(...)`、具名色都走这条路。
 *
 * Chromium 保证 canvas 能把这些色画进像素，因此只要读回 rgba，就不必自己实现色彩空间转换。
 */
function fromCanvas(input: string): Rgba | null {
  if (canvas === null) canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return null
  // copy 合成：像素就是填充色本身，不与底色混、也不做预乘
  context.globalCompositeOperation = 'copy'
  context.fillStyle = CANVAS_SENTINEL
  context.fillRect(0, 0, 1, 1)
  context.fillStyle = input
  if (context.fillStyle.toLowerCase() === CANVAS_SENTINEL) return null
  context.fillRect(0, 0, 1, 1)
  const pixel = context.getImageData(0, 0, 1, 1).data
  return [pixel[0]!, pixel[1]!, pixel[2]!, pixel[3]!]
}

/**
 * 任意 CSS 色值 → srgb 的 rgba 分量。
 *
 * `#hex` 与 `rgb()/rgba()` 直接解析，其余（含 `color(srgb ...)`、`oklab(...)`）交给 canvas。
 *
 * @param input 已求值或没求值的色值原文
 * @returns 转得出来是 rgba 分量，转不出来是 null
 */
function cssColorToRgba(input: string): Rgba | null {
  const value = input.trim()
  if (value === '') return null
  return fromHex(value) ?? fromRgbFunction(value) ?? fromCanvas(value)
}

/**
 * 读一个令牌并压成不透明的终端用色。
 *
 * @param token 令牌名
 * @param fallback 读不出、转不出时用的兜底色
 * @param over 半透明令牌要压在哪个色上（通常是已经解出来的终端底色）
 * @returns rgba 分量，一定不透明
 */
function tokenRgba(token: string, fallback: string, over: Rgba): Rgba {
  const raw = resolvedTokenColor(token)
  const rgba = cssColorToRgba(raw)
  if (rgba === null) {
    warnOnce(
      `${token}|${raw}`,
      `[terminalTheme] 令牌 ${token} 求值为「${raw || '空'}」，转不出 srgb，终端该项改用兜底色 ${fallback}`,
    )
    return cssColorToRgba(fallback) ?? [0, 0, 0, 255]
  }
  return composite(rgba, over)
}

/**
 * 按当前令牌算出 xterm 的 theme。
 *
 * 底色取卡片那一档（终端是 dock 里的内容面），前景取正文档，光标与选区取品牌色档。
 * 选区传的是不透明品牌色：xterm 对不透明选区会自动按 30% 压到底色上，
 * 与改动前写死的 `rgba(77,107,254,.3)` 同一个观感。
 * ansi 16 色一律不填，沿用 xterm 自带调色板。
 *
 * @returns 可以直接赋给 `terminal.options.theme` 的对象（每次都是新对象，xterm 按引用比较）
 */
export function readTerminalTheme(): ITheme {
  const background = tokenRgba('--dsc-bg-card', FALLBACK.background, FALLBACK_BACKGROUND)
  const foreground = tokenRgba('--dsc-text-primary', FALLBACK.foreground, background)
  const accent = tokenRgba('--dsc-accent', FALLBACK.accent, background)
  const onAccent = tokenRgba('--dsc-text-on-accent', FALLBACK.onAccent, background)
  const accentHex = toHex(accent)
  return {
    background: toHex(background),
    foreground: toHex(foreground),
    cursor: accentHex,
    cursorAccent: toHex(onAccent),
    selectionBackground: accentHex,
  }
}

/**
 * 终端字号 = 基准 12.5px × `--dsc-font-scale`。
 *
 * 这个令牌是纯数字变量，不需要探针求值；`appearance.ts` 把字号设置写成
 * 0.85–1.35 的连续倍率（默认 1），于是终端字号跟着 10.63–16.88px 连续走，
 * 这里不做分档也不夹取，读到什么就乘什么。
 *
 * @returns 可以直接赋给 `terminal.options.fontSize` 的像素值
 */
export function readTerminalFontSize(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsc-font-scale').trim()
  const scale = Number.parseFloat(raw)
  if (!Number.isFinite(scale) || scale <= 0) {
    warnOnce('font-scale', `[terminalTheme] --dsc-font-scale 读到「${raw || '空'}」，终端字号按 1 倍基准 ${TERM_FONT_BASE}px`)
    return TERM_FONT_BASE
  }
  return Math.round(TERM_FONT_BASE * scale * 100) / 100
}

/**
 * 跟着现有外观机制走：`appearance.ts` 把主题、密度写在 `<html>` 的 data-theme /
 * data-density 上，把字号写成 `<html>` 内联的 --dsc-font-scale，这里就盯这三处。
 *
 * @param onChange 属性变化后调用；同一批微任务内的多次改动合并成一次
 * @returns 停止监听的清理函数
 */
export function watchAppearance(onChange: () => void): () => void {
  let queued = false
  const observer = new MutationObserver(() => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      onChange()
    })
  })
  observer.observe(document.documentElement, {
    attributeFilter: ['data-theme', 'data-density', 'style'],
  })
  return () => observer.disconnect()
}
