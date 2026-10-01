/**
 * 设备凭据的本地存放：localStorage。
 *
 * 存的是配对换来的 token（等价于「这台手机是全权客户端」的凭据），所以：
 *   - 只存这一处，不进 URL、不进 cookie（避免顺手被分享出去）；
 *   - localStorage 不可用（隐私模式、被策略禁掉）时全部降级成「内存态」，
 *     界面照常能用，只是刷新后要重新配对——不抛异常。
 *
 * 除凭据外还存两样本机状态（都不敏感）：收到的最大帧序号（协议 v3 断线补帧的位点），
 * 以及推送端点（决定推送按钮显示「开启」还是「关闭」）。
 */

const TOKEN_KEY = 'dsc.remote.deviceToken'
const DEVICE_ID_KEY = 'dsc.remote.deviceId'
const DEVICE_NAME_KEY = 'dsc.remote.deviceName'
/** 已经收到过的最大帧序号（协议 v3 的断线补帧要用它）。 */
const LAST_SEQ_KEY = 'dsc.remote.lastSeq'
/** 本机已登记的推送端点（用来把按钮显示成「关闭推送」）。 */
const PUSH_ENDPOINT_KEY = 'dsc.remote.pushEndpoint'

export interface DeviceCreds {
  token: string
  deviceId: string
  deviceName: string
}

function read(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key)
    return value === null || value === '' ? null : value
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 存不下就算了：本次会话内存里还留着（App 的 state 是主拷贝）。
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // 同上。
  }
}

/** 读已配对凭据；没有 token 就返回 null（→ 登录页）。 */
export function loadCreds(): DeviceCreds | null {
  const token = read(TOKEN_KEY)
  if (token === null) return null
  return {
    token,
    deviceId: read(DEVICE_ID_KEY) ?? '',
    deviceName: read(DEVICE_NAME_KEY) ?? '我的设备',
  }
}

export function saveCreds(creds: DeviceCreds): void {
  write(TOKEN_KEY, creds.token)
  write(DEVICE_ID_KEY, creds.deviceId)
  write(DEVICE_NAME_KEY, creds.deviceName)
}

/** 设备名单独存一份：重新配对之前先记住用户上次填的名字，登录页预填。 */
export function loadDeviceName(): string {
  return read(DEVICE_NAME_KEY) ?? ''
}

export function clearCreds(): void {
  remove(TOKEN_KEY)
  remove(DEVICE_ID_KEY)
}

// ── 帧序号（协议 v3 的补帧位点） ────────────────────────────────────────────

/**
 * 读本地记的最大 seq；没有或读不出（被改坏、负数、小数）就返回 null。
 *
 * 为什么按「最大」而不是「最后一个」记：重连时把这个值当 `&lastSeq=` 发给宿主，
 * 宿主补发「比它大的帧」；一旦它比真实值大，就会漏帧。
 * 所以客户端只在确认应用了一帧之后才写它（见 client.ts 的 handleFrame）。
 */
export function loadLastSeq(): number | null {
  const raw = read(LAST_SEQ_KEY)
  if (raw === null) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) return null
  return value
}

export function saveLastSeq(seq: number): void {
  if (!Number.isInteger(seq) || seq < 0) return
  write(LAST_SEQ_KEY, String(seq))
}

/** 配对成功后清零（换了一台宿主，旧的帧序号没有意义）。 */
export function clearLastSeq(): void {
  remove(LAST_SEQ_KEY)
}

// ── 推送端点 ───────────────────────────────────────────────────────────────

export function loadPushEndpoint(): string | null {
  return read(PUSH_ENDPOINT_KEY)
}

export function savePushEndpoint(endpoint: string): void {
  write(PUSH_ENDPOINT_KEY, endpoint)
}

export function clearPushEndpoint(): void {
  remove(PUSH_ENDPOINT_KEY)
}
