import { useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, PAIR_CODE_LENGTH, baseUrl, pair } from '../lib/api.js'
import { loadDeviceName, saveCreds, type DeviceCreds } from '../lib/storage.js'

/**
 * 登录页（配对页）：填配对码 + 设备名，换一个设备 token 存进 localStorage。
 *
 * 为什么不做账号密码：宿主那边只有「配对码 → 设备 token」这一条路，界面跟着它走，
 * 不自己发明概念。有 token 时根本不会走到这里（见 App 的第一层判断）。
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
        <p className="login-sub">在电脑端 Muse Code 的设置里生成配对码，然后在这里填上。</p>
        {notice !== undefined && notice !== null && notice !== '' ? (
          <p className="login-notice">{notice}</p>
        ) : null}

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
            // 只留字母数字并转大写：宿主发的码就是这个字符集，省得用户纠结大小写与空格。
            const next = event.target.value.replace(/[^0-9a-zA-Z]/g, '').toUpperCase()
            setCode(next.slice(0, PAIR_CODE_LENGTH))
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
