/**
 * 手机连接弹窗（PairModal）：把宿主给的结构化配对码画全，而不是让它在一句 Toast 里一闪就没。
 *
 * 数据从哪来：设置分区动作 `regenerate-code` 的成功回执里带 `data: PairShareData`
 * （契约见 src/contract.ts；url 形如 `http://192.168.1.7:17321/?code=ABCD2345`）。
 * 这里只管画，五件事各占一块：
 *   - 二维码：内容就是 `data.url`，手机扫一下直接带着码进登录页；
 *   - 配对码：8 位明文 + 复制（复制通路与设置页 info 行同一个写法）；
 *   - 可扫地址：`data.url` 用等宽字展示，也带一个复制；
 *   - 倒计时：到 `data.expiresAt` 归零，归零后二维码与码一起变灰禁用；
 *   - 重新生成：原地换一份新数据（不关弹窗），失败原因写在弹窗里。
 *
 * 为什么用 createPortal 挂到 document.body：设置面板那串祖先里既有 `overflow: hidden`
 * （.settings），又有 `backdrop-filter`（.settings-mask——它会把 fixed 定位的包含块从
 * 视口改成自己）。挂进面板，弹窗就得陪这两条规矩玩；挂到 body 上，则与确认框那一档
 * 浮层完全一致：`.dsc-overlay` 走 `--dsc-z-modal`，压在设置面板的 `--dsc-z-backdrop` 之上。
 *
 * @module desktop/renderer/PairModal
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
import type { PairShareData } from '@dsc/runtime/contract.js'
import { toastErr, toastOk } from './components/toast.js'
import { IconClose } from './icons.js'

/** 重新生成的结果：要么一张新码，要么一句能直接显示在弹窗里的原因。 */
export type PairRegenerateResult = { ok: true; data: PairShareData } | { ok: false; error: string }

/** 二维码边长（px）：够手机在三十公分外对上焦，又不至于把弹窗撑成一张海报。 */
const QR_SIZE = 220

/** 倒计时的取样间隔：比一秒密一档，秒数才不会偶尔跳两格或停一拍。 */
const TICK_MS = 500

/** 弹窗里所有能聚焦的东西（按 DOM 顺序，也就是 Tab 顺序）。禁用的键不进焦点环。 */
function focusables(root: HTMLElement): HTMLElement[] {
  const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (item) => item.hasAttribute('disabled') === false,
  )
}

/** 借浏览器把一条 CSS 令牌算成具体颜色值；读完就把探针摘掉。 */
function probeColor(property: 'color' | 'background-color', token: string): string {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;pointer-events:none'
  probe.style.setProperty(property, `var(${token})`)
  document.body.appendChild(probe)
  const value = getComputedStyle(probe).getPropertyValue(property)
  probe.remove()
  return value
}

/** 颜色分量（0–255 + 0–1 的 alpha）。 */
interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/**
 * 把 getComputedStyle 读来的颜色压成四个分量。
 *
 * 同一个 `color-mix()` 令牌在不同内核版本里可能算成 `rgb(230, 230, 230)`，
 * 也可能算成 `color(srgb 0.9 0.9 0.9 / 0.94)`（Chromium 对 color-mix 就用后者），
 * 两种写法都要认——认不出返回 null，由调用方决定退路。
 *
 * @param value getComputedStyle 读到的颜色串
 * @returns 四个分量；写法不认识时返回 null
 */
function parseColor(value: string): Rgba | null {
  const match = /^(rgb|color)\((.+)\)$/i.exec(value.trim())
  if (match === null) return null
  const isSrgbFunction = (match[1] ?? '').toLowerCase() === 'color'
  const body = isSrgbFunction ? (match[2] ?? '').replace(/^\s*srgb\s+/i, '') : (match[2] ?? '')
  const parts = body
    .split(/[,/\s]+/)
    .filter((piece) => piece !== '')
    .map(Number)
  if (parts.length < 3 || parts.slice(0, 4).some((piece) => Number.isFinite(piece) === false)) return null
  // color(srgb …) 的分量是 0~1 的浮点数，rgb() 的是 0~255
  const scale = isSrgbFunction ? 255 : 1
  const channel = (piece: number): number => Math.min(255, Math.max(0, piece * scale))
  return {
    r: channel(parts[0] ?? 0),
    g: channel(parts[1] ?? 0),
    b: channel(parts[2] ?? 0),
    a: parts.length > 3 ? Math.min(1, Math.max(0, parts[3] ?? 1)) : 1,
  }
}

/** 半透明前景压到背景上，算出不透明的实际颜色（前 3 位，alpha 一律当 1）。 */
function over(foreground: Rgba, background: Rgba): Rgba {
  const mix = (front: number, back: number): number => front * foreground.a + back * (1 - foreground.a)
  return { r: mix(foreground.r, background.r), g: mix(foreground.g, background.g), b: mix(foreground.b, background.b), a: 1 }
}

/**
 * `#rrggbb`：qrcode 的 `color.dark` 只吃十六进制（见 @types/qrcode：“Value must
 * be in hex format (RGBA)”），`rgb()` / `color(srgb …)` / 带 alpha 的写法它都认不出。
 */
function toHex(color: Rgba): string {
  const part = (value: number): string =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

/**
 * 二维码深色块的颜色 = 当前主题的正文色。
 *
 * 为什么不能直接把令牌交给 qrcode：`--dsc-text-primary` 是
 * `color-mix(in srgb, var(--dsc-base) 94%, transparent)`，它带 4% 透明，
 * 而 qrcode 要的是具体的十六进制色值。所以先让浏览器把令牌算成 rgb，
 * 再与卡片底色合成一次，得到不透明色：深色主题下就是近白块（浅色主题下是近黑块）。
 * 合成基准取 `--dsc-bg-card`，因为二维码自己不铺底色（light 传透明，
 * 见下面的 `#00000000`），露出的是卡片本身。
 *
 * 读不到任何一步（老内核给的写法认不出、样式表还没上）就退回纯黑——
 * 这是契约里写明的退路，宁可深色主题下看不清，也不要抛错把弹窗卡死。
 *
 * @returns 可以直接交给 QRCode.toDataURL 的 `#rrggbb`
 */
function qrDarkColor(): string {
  const text = parseColor(probeColor('color', '--dsc-text-primary'))
  if (text === null) return '#000000'
  if (text.a >= 0.999) return toHex(text)
  const card = parseColor(probeColor('background-color', '--dsc-bg-card'))
  // 卡片底色也读不到时，就当它是全透明的：直接用正文色，总比退回纯黑强
  return toHex(card === null ? text : over(text, card))
}

/** 剩余毫秒 → `mm:ss`（向上取整，免得最后 0.4 秒就提前跳到 00:00）。 */
function clockText(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/**
 * 手机连接弹窗。
 *
 * @param props.data 宿主给的配对数据（码 / 可扫地址 / 过期时刻）
 * @param props.onRegenerate 再调一次同一个宿主动作，拿到新数据就原地替换
 * @param props.onClose 关闭（X、Esc、点遮罩三条路都走它）
 */
export function PairModal(props: {
  data: PairShareData
  onRegenerate(): Promise<PairRegenerateResult>
  onClose(): void
}): JSX.Element {
  const [share, setShare] = useState<PairShareData>(props.data)
  const [qr, setQr] = useState<string | null>(null)
  const [qrFailed, setQrFailed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const card = useRef<HTMLDivElement>(null)
  // 关闭回调每次渲染都是新的箭头函数，事件监听只挂一次，所以走 ref 取最新那个
  const closing = useRef(props.onClose)
  closing.current = props.onClose

  // 宿主（或设置面板）换了一份数据就跟上：重新生成走的就是这条路
  useEffect(() => setShare(props.data), [props.data])

  // 每秒跳一次倒计时。0.5 秒取一次样，秒数才不会偶尔停一拍或跳两格。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  const remaining = Math.max(0, share.expiresAt - now)
  const expired = remaining <= 0

  // 画二维码。生成失败（地址长到库算不过来之类）只把这一格换成一句说明，
  // 配对码、地址、倒计时、重新生成照旧可用——弹窗不该因为一张图卡住。
  useEffect(() => {
    let alive = true
    setQr(null)
    setQrFailed(false)
    void QRCode.toDataURL(share.url, {
      width: QR_SIZE,
      margin: 1,
      // light 传全透明：露出卡片底色，深浅两套主题都不用各配一张图
      color: { dark: qrDarkColor(), light: '#00000000' },
    }).then(
      (dataUrl) => {
        if (alive) setQr(dataUrl)
      },
      () => {
        if (alive) setQrFailed(true)
      },
    )
    return () => {
      alive = false
    }
  }, [share.url])

  // 焦点初落在弹窗内（落在卡本身而不是某颗按钮上，于是第一个 Tab 就去关闭钮），
  // 关掉时还给触发它的那颗按钮——与 components/confirm.ts 同一套。
  useEffect(() => {
    const last = document.activeElement instanceof HTMLElement ? document.activeElement : null
    card.current?.focus()
    return () => {
      if (last !== null && last.isConnected) last.focus()
    }
  }, [])

  // Esc 关闭 + Tab 在弹窗里绕圈。都挂在捕获阶段：压在弹窗下面的设置面板同样在
  // window 上听 Esc，不掐断传播的话关弹窗会连带把设置面板一起关掉。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closing.current()
        return
      }
      if (event.key !== 'Tab') return
      const box = card.current
      if (box === null) return
      const items = focusables(box)
      const first = items[0]
      const last = items[items.length - 1]
      if (first === undefined || last === undefined) {
        event.preventDefault()
        box.focus()
        return
      }
      const active = document.activeElement
      const inside = active instanceof HTMLElement && box.contains(active)
      // 到头就绕回另一头；焦点跑到背景页面上时也拽回来
      if (event.shiftKey === false && (inside === false || active === last)) {
        event.preventDefault()
        first.focus()
        return
      }
      if (event.shiftKey && (inside === false || active === first)) {
        event.preventDefault()
        last.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  /** 复制一段文本；回执与设置页 info 行的复制按钮同一套。 */
  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => toastOk('已复制'),
      () => toastErr('复制失败，请手动选中'),
    )
  }

  /** 重新生成：新数据原地替换，失败原因留在弹窗里（不关窗，用户还能再试一次）。 */
  const regenerate = (): void => {
    if (busy) return
    setBusy(true)
    setError('')
    void props.onRegenerate().then((result) => {
      setBusy(false)
      if (result.ok === false) {
        setError(result.error)
        return
      }
      setShare(result.data)
      setNow(Date.now())
    })
  }

  return createPortal(
    <div
      className="dsc-overlay pair-modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div
        className="dsc-overlay__card pair-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pair-title"
        aria-describedby="pair-sub"
        tabIndex={-1}
        ref={card}
      >
        <div className="pair-head">
          <div className="pair-head-text">
            <h3 className="pair-title" id="pair-title">
              手机连接
            </h3>
            <p className="pair-sub" id="pair-sub">
              同一 Wi-Fi 下，手机扫这个码（或输下面的配对码）即可连接
            </p>
          </div>
          <button className="icon-btn" data-tip="关闭，快捷键 Esc" aria-label="关闭" onClick={props.onClose}>
            <IconClose size={16} />
          </button>
        </div>

        <div className={`pair-qr${expired ? ' expired' : ''}`}>
          {qr !== null && <img className="pair-qr-img" src={qr} alt={`配对二维码，指向 ${share.url}`} />}
          {qr === null && qrFailed === false && <div className="pair-qr-hold">正在生成二维码…</div>}
          {qrFailed && (
            <div className="pair-qr-hold">二维码没画出来（地址太长），照下面的配对码手动输入即可。</div>
          )}
        </div>

        <div className={`pair-code-row${expired ? ' expired' : ''}`}>
          <span className="pair-code mono">{share.code}</span>
          <button className="text-btn" disabled={expired} onClick={() => copy(share.code)}>
            复制
          </button>
        </div>

        {/* 与设置页 info 行同一个长相：值在左、动作靠右、长了就地省略 */}
        <div className="setting-info pair-url">
          <span className="mono">{share.url}</span>
          <span className="setting-info-actions">
            <button className="text-btn" disabled={expired} onClick={() => copy(share.url)}>
              复制
            </button>
          </span>
        </div>

        <div className={`pair-count${expired ? ' expired' : ''}`} role="status">
          {expired ? '配对码已过期，请重新生成' : `剩余有效时间 ${clockText(remaining)}`}
        </div>

        {error !== '' && <div className="settings-note error pair-error">{error}</div>}

        <div className="pair-actions">
          <button className="btn-primary" disabled={busy} onClick={regenerate}>
            {busy ? '正在生成…' : '重新生成'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
