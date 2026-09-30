/**
 * 设备凭据的本地存放：localStorage。
 *
 * 存的是配对换来的 token（等价于「这台手机是全权客户端」的凭据），所以：
 *   - 只存这一处，不进 URL、不进 cookie（避免顺手被分享出去）；
 *   - localStorage 不可用（隐私模式、被策略禁掉）时全部降级成「内存态」，
 *     界面照常能用，只是刷新后要重新配对——不抛异常。
 */

const TOKEN_KEY = 'dsc.remote.deviceToken'
const DEVICE_ID_KEY = 'dsc.remote.deviceId'
const DEVICE_NAME_KEY = 'dsc.remote.deviceName'

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
