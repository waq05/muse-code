/**
 * 远程协议的帧流：**宿主级全局 seq** + 全量/增量 diff + 最近 120 帧环形缓冲。
 *
 * 协议 v3 定下的几条（remote-web 与宿主两批共用的契约）：
 *
 *   全量帧  `{type:'snapshot', seq, full:true, ...快照字段}`
 *   增量帧  `{type:'delta', seq, full:false, meta, added, updated, removedIds, liveEntries}`
 *
 * 条目按 `id` 认同（正数 id 的已定稿条目）：与上一帧相比新出现的进 `added`、
 * `JSON.stringify` 不同的进 `updated`、消失的进 `removedIds`。`liveEntries`（负 id 的直播尾）
 * 每帧全量带——它本来就每几十毫秒整段改写，做 diff 只会更贵。`meta`（除 entries 与
 * liveEntries 之外的所有快照字段）也每帧全量带：它很小，而且 status/surfaces 里的东西
 * 没有稳定身份可以拿来做 diff。
 *
 * 为什么要有全量锚：增量是可以无限长的。客户端一旦漏了一帧（进程被杀、缓冲被覆盖），
 * 靠增量永远补不回来。所以「连续 50 帧 delta」或「距上一全量 30 秒」必须重新发一帧全量，
 * 会话切换（sessionId 变号）立刻发全量——那时条目的 id 空间整体换了一套，diff 没有意义。
 *
 * 这个模块是纯逻辑（不碰 cordis、不碰网络），所以 `scripts/remote-host-test.mjs`
 * 能直接把 diff 规则与锚帧节奏逐格对掉。
 *
 * @module dsc/core/remote/frames
 */

/** 环形缓冲留多少帧（重连补帧能补多远）。 */
export const FRAME_BUFFER_SIZE = 120

/** 连续多少帧 delta 之后必须给一帧全量。 */
export const FULL_ANCHOR_FRAMES = 50

/** 距上一帧全量多久必须再给一帧全量。 */
export const FULL_ANCHOR_MS = 30_000

/** 造帧只要这三样：会话身份、已定稿条目、直播尾；其余字段原样进 meta。 */
export interface FrameInput {
  sessionId: string
  entries: readonly { id: number }[]
  liveEntries: readonly unknown[]
}

/** 造出来的一帧：seq 与「原样的 JSON 文本」（缓冲里存的就是这份文本，重发不重算）。 */
export interface BuiltFrame {
  seq: number
  full: boolean
  text: string
}

export interface FrameHubOptions {
  /** 取时刻（自检注入假钟，测 30 秒锚）。 */
  now?: () => number
  capacity?: number
  anchorFrames?: number
  anchorMs?: number
}

export class RemoteFrameHub {
  private readonly now: () => number
  private readonly capacity: number
  private readonly anchorFrames: number
  private readonly anchorMs: number
  /** 全局单调递增的帧号；跨连接、跨重连连续。 */
  private seq = 0
  /** 最近 capacity 帧（seq + 原样文本）。 */
  private readonly buffer: { seq: number; text: string }[] = []
  /** 上一帧的条目：id → JSON 文本（用来判「改了没有」）。 */
  private prevEntries = new Map<number, string>()
  /** 上一帧的 id 顺序（removedIds 按它出，顺序稳定好对账）。 */
  private prevOrder: number[] = []
  private deltasSinceFull = 0
  private lastFullAt = 0
  private lastSessionId: string | null = null
  private emitted = false

  constructor(options: FrameHubOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.capacity = options.capacity ?? FRAME_BUFFER_SIZE
    this.anchorFrames = options.anchorFrames ?? FULL_ANCHOR_FRAMES
    this.anchorMs = options.anchorMs ?? FULL_ANCHOR_MS
  }

  /** 到现在为止一共造过几帧（= 最新一帧的 seq）。 */
  get lastSeq(): number {
    return this.seq
  }

  /** 缓冲里最老那一帧的 seq；缓冲空时 null。 */
  get oldestSeq(): number | null {
    return this.buffer[0]?.seq ?? null
  }

  /** 缓冲里最新那一帧的 seq；缓冲空时 null。 */
  get newestSeq(): number | null {
    const last = this.buffer[this.buffer.length - 1]
    return last === undefined ? null : last.seq
  }

  /** 缓冲里有几帧。 */
  get buffered(): number {
    return this.buffer.length
  }

  /**
   * 造下一帧：决定全量还是增量、算 diff、递增 seq、写环形缓冲。
   *
   * @param snapshot - 当前快照（会话身份 + 条目 + 其余字段）
   * @param forceFull - 强制全量（新连接接不上缓冲、断线期间漏了变化时用）
   */
  build<T extends FrameInput>(snapshot: T, forceFull = false): BuiltFrame {
    const record = snapshot as unknown as Record<string, unknown>
    this.seq += 1
    const seq = this.seq
    const sessionChanged = this.emitted && this.lastSessionId !== snapshot.sessionId
    const full =
      forceFull ||
      !this.emitted ||
      sessionChanged ||
      this.deltasSinceFull >= this.anchorFrames ||
      this.now() - this.lastFullAt >= this.anchorMs

    let text: string
    if (full) {
      text = JSON.stringify({ type: 'snapshot', seq, full: true, ...record })
      this.deltasSinceFull = 0
      this.lastFullAt = this.now()
    } else {
      const added: unknown[] = []
      const updated: unknown[] = []
      const next = new Map<number, string>()
      const nextOrder: number[] = []
      for (const entry of snapshot.entries ?? []) {
        const json = JSON.stringify(entry)
        const before = this.prevEntries.get(entry.id)
        if (before === undefined) added.push(entry)
        else if (before !== json) updated.push(entry)
        next.set(entry.id, json)
        nextOrder.push(entry.id)
      }
      const removedIds: number[] = []
      for (const id of this.prevOrder) {
        if (!next.has(id)) removedIds.push(id)
      }
      const meta: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(record)) {
        if (key === 'entries' || key === 'liveEntries') continue
        meta[key] = value
      }
      text = JSON.stringify({
        type: 'delta',
        seq,
        full: false,
        meta,
        added,
        updated,
        removedIds,
        liveEntries: snapshot.liveEntries ?? [],
      })
      this.deltasSinceFull += 1
      this.prevEntries = next
      this.prevOrder = nextOrder
    }

    if (full) {
      // 全量帧之后 diff 基准重挂：下一帧的「上一帧」就是这一帧的条目
      const next = new Map<number, string>()
      const nextOrder: number[] = []
      for (const entry of snapshot.entries) {
        next.set(entry.id, JSON.stringify(entry))
        nextOrder.push(entry.id)
      }
      this.prevEntries = next
      this.prevOrder = nextOrder
    }

    this.lastSessionId = snapshot.sessionId
    this.emitted = true
    this.buffer.push({ seq, text })
    while (this.buffer.length > this.capacity) this.buffer.shift()
    return { seq, full, text }
  }

  /**
   * 重连补帧。
   *
   * @param after - 客户端已经收到的最后一帧 seq（0 或负数 = 要全量）
   * @returns 该补发的帧文本（按 seq 升序，原样）；接不上（要全量）时返回 null
   */
  resume(after: number): string[] | null {
    if (!Number.isFinite(after) || after <= 0) return null
    const oldest = this.oldestSeq
    const newest = this.newestSeq
    // 客户端手上的 seq 落在缓冲窗口之外就没法补：比最老还旧 = 已经滚出去了；
    // 比最新还新 = 宿主这一进程重启过（seq 从头来过），客户端的号是上一世的。
    // 两种都退回「hello + 全量帧」——协议里给接不上的客户端准备的就是这条路。
    if (oldest === null || newest === null || after < oldest || after > newest) return null
    const out: string[] = []
    for (const frame of this.buffer) {
      if (frame.seq > after) out.push(frame.text)
    }
    return out
  }
}
