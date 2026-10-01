import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, PAIR_CODE_LENGTH, baseUrl, pair } from '../lib/api.js'
import { sanitizePairCode, takePairCodeFromUrl } from '../lib/pairlink.js'
import { loadDeviceName, saveCreds, clearLastSeq, type DeviceCreds } from '../lib/storage.js'

/**
 * 登录页（配对页）：填配对码 + 设备名，换一个设备 token 存进 localStorage。
 *
 * 为什么不做账号密码：宿主那边只有「配对码 → 设备 token」这一条路，界面跟着它走，
 * 不自己发明概念。有 token 时根本不会走到这里（见 App 的第一层判断）。
 *
 * 设备记忆的边界（照实记在这里，界面上不提）：
 *   - 凭据与设备名都存 localStorage，而 localStorage 按 origin 隔离。
 *     宿主换 IP 或换端口 = 换 origin = 这份记忆看不见，浏览器会把手机当新设备，
 *     用户得重新扫一次码。这是浏览器的安全模型，跨 origin 无解。
 *   - 苹果的 Safari（ITP）还会清理长期不用的站点数据，删除之后同样要重新配对。
 *   - 隐私模式下 localStorage 直接不可用，storage.ts 已降级成内存态：本次能用，刷新即重来。
 */
export interface LoginPageProps {
  onPaired: (creds: DeviceCreds) => void
  /** 被吊销/失效踢回来时的说明（例如「登录已失效，请重新配对设备」）。 */
  notice?: string | null
}

export function LoginPage({ onPaired, notice }: LoginPageProps): ReactNode {
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState(() => loadDeviceName() || '我的手机')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const deviceNameRef = useRef<HTMLInputElement>(null)

  /**
   * 扫码直达：桌面端的二维码把码放在 `?code=` 上，扫进来就地取用。
   *
   * takePairCodeFromUrl 内部先把地址栏里的 code 擦掉（截屏、分享、递手机都不会带走这张码），
   * 擦完再把码返回给我。合法才预填，非法值安静忽略——不能因为 URL 里有个垃圾参数就报错。
   *
   * 为什么不自动提交：设备名代表这台设备的身份，扫码到达时用户还没看过它；
   * 而且同一张码被重扫（或刷新后再扫）会再发一次配对请求，在桌面端造出一台重复设备。
   * 代价只是多点一次「连接」，换的是设备列表里没有幽灵设备。
   *
   * StrictMode 下这个效果会跑两次：第二次读到的地址栏已经没有 code，
   * 直接返回 null，所以不会把用户刚敲进去的码覆盖掉。
   */
  useEffect(() => {
    const fromUrl = takePairCodeFromUrl(window.location.href, window.history)
    if (fromUrl === null) return
    setCode(fromUrl)
    // 码已经填好了，下一步就是确认设备名，所以焦点直接落在它上面。
    deviceNameRef.current?.focus()
  }, [])

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (pending) return
    const trimmed = code.trim()
    if (trimmed.length !== PAIR_CODE_LENGTH) {
      setError(`配对码是 ${PAIR_CODE_LENGTH} 位`)
      return
    }
    setPending(true)
    setError(null)
    try {
      const result = await pair(baseUrl(), { code: trimmed, deviceName })
      const creds: DeviceCreds = {
        token: result.token,
        deviceId: result.deviceId,
        deviceName: deviceName.trim() === '' ? '我的设备' : deviceName.trim(),
      }
      saveCreds(creds)
      // 协议 v3：刚配对的设备没有历史，帧序号清零（否则重连会拿旧宿主的位点去补帧）。
      clearLastSeq()
      onPaired(creds)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '连不上宿主，检查地址与网络后重试')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={(event) => void handleSubmit(event)}>
        <h1 className="login-title">Muse Code 远程</h1>
        <p className="login-sub">在电脑端 Muse Code 的设置里生成配对码（半小时内有效），然后在这里填上。</p>
        {notice !== undefined && notice !== null && notice !== '' ? (
          <p className="login-notice">{notice}</p>
        ) : null}

        <p className="login-help">配对一次，这台设备以后打开即直连，不用重复输码</p>

        <label className="login-label" htmlFor="pair-code">
          配对码
        </label>
        <input
          id="pair-code"
          className="login-code"
          value={code}
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={PAIR_CODE_LENGTH}
          placeholder="ABCD1234"
          onChange={(event) => {
            // 手输与扫码共用一条清洗路径（pairlink.ts）：只留字母数字、转大写、截到 8 位，
            // 省得用户纠结大小写与空格，也省得两处对「什么算合法」有两种说法。
            setCode(sanitizePairCode(event.target.value))
          }}
        />
        <div className="login-count">
          {code.length}/{PAIR_CODE_LENGTH}
        </div>

        <label className="login-label" htmlFor="device-name">
          设备名
        </label>
        <input
          id="device-name"
          ref={deviceNameRef}
          className="login-text"
          value={deviceName}
          maxLength={32}
          placeholder="我的手机"
          onChange={(event) => setDeviceName(event.target.value)}
        />
        <p className="login-help">给这台设备起个名，比如 我的手机</p>

        {error !== null ? <p className="login-error">{error}</p> : null}

        <button type="submit" className="login-submit" disabled={pending}>
          {pending ? '配对中…' : '连接'}
        </button>
      </form>
    </div>
  )
}
