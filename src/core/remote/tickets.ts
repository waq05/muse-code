/**
 * 一次性 WS 票据：浏览器先拿设备 token 换一张票（HTTP），再用票升级 WebSocket。
 *
 * 为什么要多这一跳：浏览器的 WebSocket 构造函数发不了自定义头，token 只能塞在 URL 上，
 * 而 URL 会进各级日志。塞一次性的、30 秒就死的票据，泄了也换不到第二次连接。
 *
 * @module dsc/core/remote/tickets
 */
import { randomBytes } from 'node:crypto'

/** 票据有效期：够浏览器从 HTTP 响应走到 WebSocket 握手，不够被人捡去用。 */
export const TICKET_TTL_MS = 30_000

/** 一张票据换来的东西：这台设备是谁（升级 WS 时用它把连接和设备对上）。 */
export interface TicketGrant {
  deviceId: string
}

export class TicketStore {
  /** 票据 → 过期时刻与设备身份。 */
  private readonly tickets = new Map<string, { expiresAt: number; deviceId: string }>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(ttlMs: number = TICKET_TTL_MS, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs
    this.now = now
  }

  /** 发一张新票，挂上取票的那台设备。 */
  issue(deviceId = ''): string {
    this.prune()
    const ticket = randomBytes(24).toString('base64url')
    this.tickets.set(ticket, { expiresAt: this.now() + this.ttlMs, deviceId })
    return ticket
  }

  /** 用票：**取走即焚**，同一张票第二次来必然 null；过期也 null。 */
  redeem(ticket: string): TicketGrant | null {
    this.prune()
    const record = this.tickets.get(ticket)
    if (record === undefined) return null
    this.tickets.delete(ticket)
    return record.expiresAt > this.now() ? { deviceId: record.deviceId } : null
  }

  /** 现在还剩几张没用的票（自检用）。 */
  get size(): number {
    this.prune()
    return this.tickets.size
  }

  private prune(): void {
    const now = this.now()
    for (const [ticket, record] of this.tickets) {
      if (record.expiresAt <= now) this.tickets.delete(ticket)
    }
  }
}
