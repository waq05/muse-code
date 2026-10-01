/**
 * 配对：桌面端给一张 8 位码，手机输码换一个设备 token，之后凭 token 换 WS 票据。
 *
 * 三条硬规矩：
 *   1. **明文码永不落盘、不进日志**。落盘的是 `sha256(盐 + 码)` 与随机盐；界面上那张卡
 *      是码唯一的出口（action 的返回值，只显示在电脑那块屏幕上）。所以 transcript /
 *      dsc/notice 里也绝不能出现码——那些会写进会话 jsonl。
 *   2. **一次性**。配对成功那张码当场作废，同一个码再输进来不会又发一个 token。
 *   3. **错码限速**。同一张码连错 5 次锁 1 小时；锁住期间连对的码也不放行。
 *      没有这一条，8 位码（32 字符表）在局域网里是可以被暴力试出来的。
 *
 * 设备侧只存 token 的 sha256，不存 token 本身：拿到 devices.json 也连不上。
 *
 * @module dsc/core/remote/pairing
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { readJsonFile, remoteFiles, writeJsonFile, type RemoteFiles } from './store.js'

/**
 * 配对码字母表：32 个字符，去掉 O/0/I/1/l 这些「看截图分不清」的。
 * 大写 A–Z 去掉 I、O 剩 24 个，数字 2–9 八个，正好 32——所以每位的熵是 5 bit。
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 码长度（与 remote-web 的输入框长度一致，改这里要两边一起改）。 */
export const CODE_LENGTH = 8

/** 码有效期 1 小时。 */
export const CODE_TTL_MS = 3_600_000

/** 同一张码允许连错几次。 */
export const MAX_CODE_ATTEMPTS = 5

/** 连错超限后锁多久。 */
export const CODE_LOCK_MS = 3_600_000

/** pending.json 里最多留几条记录（过期的会被清掉，正常只有一张活的）。 */
export const MAX_PENDING_RECORDS = 5

/** 一张还没被用掉的配对码（只有哈希，没有明文）。 */
interface PendingCode {
  salt: string
  hash: string
  createdAt: number
  expiresAt: number
  attempts: number
  /** 有值且大于当前时刻 = 这张码被锁着。 */
  lockedUntil?: number
}

/** 一台已配对的设备。 */
export interface DeviceRecord {
  deviceId: string
  /** `sha256(token)` 的十六进制；token 本体不落盘。 */
  tokenHash: string
  name: string
  createdAt: number
  lastSeenAt: number
}

/** 配对结果：成功给 token，失败给 HTTP 状态码与给用户看的一句话。 */
export type PairOutcome =
  | { ok: true; token: string; deviceId: string; name: string }
  | { ok: false; status: number; error: string }

export interface PairingOptions {
  /** 数据目录（默认 `~/.dsc/remote`；自检脚本换成临时目录）。 */
  dir?: string
  /** 取时刻（自检注入假钟，测过期）。 */
  now?: () => number
}

/** 发一张码：`sha256(盐 + 码)` 落盘，明文只经返回值回到设置页。 */
function hashCode(salt: string, code: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex')
}

/** 用户输进来的码先洗一遍：去掉空格与连字符、转大写（界面也做了，这里兜底）。 */
export function normalizeCode(input: string): string {
  return input.replace(/[^0-9a-zA-Z]/g, '').toUpperCase()
}

function tokenHashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 定长十六进制摘要的比较：长度不等直接 false，相等时用 timingSafeEqual。 */
function digestEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

export class RemotePairing {
  private readonly files: RemoteFiles
  private readonly now: () => number
  /** 上次给某台设备刷 lastSeenAt 的时刻（每台一分钟最多写一次盘，别为每次重连都写文件）。 */
  private readonly lastSeenWritten = new Map<string, number>()

  constructor(options: PairingOptions = {}) {
    this.files = remoteFiles(options.dir)
    this.now = options.now ?? (() => Date.now())
  }

  // ── 配对码 ────────────────────────────────────────────────────────────────

  private loadCodes(): PendingCode[] {
    const doc = readJsonFile(this.files.pending)
    const list = doc?.['codes']
    if (!Array.isArray(list)) return []
    const out: PendingCode[] = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (typeof record['salt'] !== 'string' || typeof record['hash'] !== 'string') continue
      if (typeof record['createdAt'] !== 'number' || typeof record['expiresAt'] !== 'number') continue
      out.push({
        salt: record['salt'],
        hash: record['hash'],
        createdAt: record['createdAt'],
        expiresAt: record['expiresAt'],
        attempts: typeof record['attempts'] === 'number' ? record['attempts'] : 0,
        ...(typeof record['lockedUntil'] === 'number' ? { lockedUntil: record['lockedUntil'] } : {}),
      })
    }
    return out
  }

  private saveCodes(codes: PendingCode[]): void {
    writeJsonFile(this.files.pending, { version: 1, codes: codes.slice(-MAX_PENDING_RECORDS) })
  }

  /** 还没过期、也没被锁的码有几张（设置页显示状态用）。 */
  liveCodeCount(): number {
    const now = this.now()
    return this.loadCodes().filter((code) => code.expiresAt > now && (code.lockedUntil ?? 0) <= now).length
  }

  /**
   * 发一张新码。
   * @returns 新码与过期时刻；已经有一张没用过且没被锁的码时返回 null
   *          ——同一个屏幕上同时飘着两张有效码只会让人输错，节奏上就该一次一张。
   *          被锁的码不算「没用过」：它已经废了，用户当然可以再要一张。
   */
  issueCode(): { code: string; expiresAt: number } | null {
    const now = this.now()
    // 顺手清掉过期与锁上的记录（锁上的永远用不了了，留着只会让状态显示看不懂）
    const kept = this.loadCodes().filter((code) => code.expiresAt > now && (code.lockedUntil ?? 0) <= now)
    if (kept.length > 0) return null
    const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)] ?? 'A').join('')
    const salt = randomBytes(16).toString('hex')
    const expiresAt = now + CODE_TTL_MS
    kept.push({ salt, hash: hashCode(salt, code), createdAt: now, expiresAt, attempts: 0 })
    this.saveCodes(kept)
    return { code, expiresAt }
  }

  /**
   * 用码换 token。失败按状态码分三类：
   *   401 没有可用的码 / 码不对（不区分是哪张，免得探测出「这个码存在但错了」）
   *   429 这张码被锁着（输错太多次）
   */
  verifyCode(input: string, name: string): PairOutcome {
    const now = this.now()
    const code = normalizeCode(input)
    const all = this.loadCodes()
    const live = all.filter((record) => record.expiresAt > now)
    if (live.length === 0) {
      return { ok: false, status: 401, error: '没有可用的配对码，请在电脑端「设置 → 远程控制」里生成一张' }
    }
    const locked = live.find((record) => (record.lockedUntil ?? 0) > now)
    if (locked !== undefined) {
      return { ok: false, status: 429, error: '这张配对码输错次数太多，已锁 1 小时；请在电脑端重新生成一张' }
    }
    const hit = live.find((record) => digestEquals(record.hash, hashCode(record.salt, code)))
    if (hit === undefined) {
      // 记一次失败：活着的码一起记（正常只有一张）。够 5 次就锁 1 小时。
      for (const record of all) {
        if (record.expiresAt <= now) continue
        record.attempts += 1
        if (record.attempts >= MAX_CODE_ATTEMPTS) record.lockedUntil = now + CODE_LOCK_MS
      }
      this.saveCodes(all)
      return { ok: false, status: 401, error: '配对码不对' }
    }
    // 成功：这张码当场作废，发一个 32 字节的设备 token
    const token = randomBytes(32).toString('base64url')
    const device: DeviceRecord = {
      deviceId: randomUUID(),
      tokenHash: tokenHashOf(token),
      name: (name.trim() === '' ? '未命名设备' : name.trim()).slice(0, 32),
      createdAt: now,
      lastSeenAt: now,
    }
    this.saveCodes(all.filter((record) => record !== hit))
    const devices = this.loadDevices()
    // 同名设备再配一次：旧的顶掉，免得设置页里堆一排「我的手机」
    this.saveDevices([...devices.filter((entry) => entry.name !== device.name), device])
    return { ok: true, token, deviceId: device.deviceId, name: device.name }
  }

  // ── 设备 token ────────────────────────────────────────────────────────────

  private loadDevices(): DeviceRecord[] {
    const doc = readJsonFile(this.files.devices)
    const list = doc?.['devices']
    if (!Array.isArray(list)) return []
    const out: DeviceRecord[] = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (typeof record['tokenHash'] !== 'string') continue
      out.push({
        deviceId: typeof record['deviceId'] === 'string' ? record['deviceId'] : randomUUID(),
        tokenHash: record['tokenHash'],
        name: typeof record['name'] === 'string' ? record['name'] : '未命名设备',
        createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : 0,
        lastSeenAt: typeof record['lastSeenAt'] === 'number' ? record['lastSeenAt'] : 0,
      })
    }
    return out
  }

  private saveDevices(devices: DeviceRecord[]): void {
    writeJsonFile(this.files.devices, { version: 1, devices })
  }

  /** 验设备 token；认不出返回 null。认得出就顺手刷一次 lastSeenAt（每台一分钟最多写一次盘）。 */
  verifyToken(token: string): DeviceRecord | null {
    if (token === '') return null
    const hash = tokenHashOf(token)
    const devices = this.loadDevices()
    const index = devices.findIndex((device) => digestEquals(device.tokenHash, hash))
    if (index < 0) return null
    const device = devices[index]
    if (device === undefined) return null
    const now = this.now()
    const written = this.lastSeenWritten.get(device.deviceId) ?? 0
    if (now - written > 60_000) {
      devices[index] = { ...device, lastSeenAt: now }
      this.saveDevices(devices)
      this.lastSeenWritten.set(device.deviceId, now)
    }
    return { ...device, lastSeenAt: now }
  }

  /**
   * 吊销一个 token。
   * @returns 被吊销的那台设备（调用方拿 deviceId 去断开它已经建好的连接）；
   *          本来就不认这个 token 时返回 null。
   */
  revoke(token: string): DeviceRecord | null {
    const hash = tokenHashOf(token)
    const devices = this.loadDevices()
    const hit = devices.find((device) => digestEquals(device.tokenHash, hash))
    if (hit === undefined) return null
    this.saveDevices(devices.filter((device) => device !== hit))
    this.lastSeenWritten.delete(hit.deviceId)
    return hit
  }

  /** 吊销全部设备，返回吊销了几台。 */
  revokeAll(): number {
    const devices = this.loadDevices()
    this.saveDevices([])
    this.lastSeenWritten.clear()
    return devices.length
  }

  /**
   * 按 deviceId 吊销一台设备（设置页里每台设备一个「吊销」按钮走这条）。
   *
   * 为什么不是只留 `revoke(token)`：设置页手上只有 deviceId（token 本体从不落盘，
   * 界面上也看不到），所以「逐台吊销」必须能按 identity 定位，而不是按凭据定位。
   *
   * @returns 被吊销的那台设备；本来就不在清单里时 null
   */
  revokeDevice(deviceId: string): DeviceRecord | null {
    if (deviceId === '') return null
    const devices = this.loadDevices()
    const hit = devices.find((device) => device.deviceId === deviceId)
    if (hit === undefined) return null
    this.saveDevices(devices.filter((device) => device !== hit))
    this.lastSeenWritten.delete(hit.deviceId)
    return hit
  }

  /** 已配对设备清单（给设置分区显示；不含 token 哈希）。 */
  devices(): Array<{ deviceId: string; name: string; createdAt: number; lastSeenAt: number }> {
    return this.loadDevices().map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
    }))
  }
}
