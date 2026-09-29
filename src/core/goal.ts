/**
 * 会话目标（goal）：让「说一句就自己跑到底」这件事有刹车。
 *
 * 形状抄 DSH 的 goal 包：
 *   - 目标是一个带 revision 的对象，改它要走比较再换（`packages/goal/goal/src/types.ts:20-25`）；
 *   - phase 只有 active/paused/blocked/complete 四种，轮次到上限自动转 blocked
 *     （`packages/goal/goal-round-driver/src/index.ts:164-172`）；
 *   - 另外还有一个只在进程里存在的开关 armed/disarmed：重启后默认不续跑，
 *     防止「上周没跑完的目标」今天自动点火（`goal/src/types.ts:72,97-99`）。
 *
 * dsc 上的取舍：改目标、暂停、恢复这三件事只允许用户当面发起（设置页或 /goal 命令），
 * 模型自己只能 create / complete / 报告阻塞——否则它会自己给自己续命。
 *
 * @module dsc/core/goal
 */
import type { GoalPhaseView } from '../contract.js'

/**
 * 目标阶段：就是 contract 的 GoalPhaseView，不在这里再写一遍四种阶段。
 * 会话日志里存的也是这几个字符串，改了会让老会话读不回来。
 */
export type GoalPhase = GoalPhaseView

export const GOAL_PHASES: readonly GoalPhase[] = ['active', 'paused', 'blocked', 'complete']

/** 默认轮次上限（一次自动续跑算一轮）：插件配置没给 `defaultMaxRounds` 时用它。 */
export const DEFAULT_MAX_GOAL_ROUNDS = 24

/** 轮次上限的硬顶：再想放开也不给超过这个数（挡住模型自己把上限改成一万轮）。 */
export const MAX_GOAL_ROUNDS_CAP = 256

/** 建目标、放宽上限时可选的档位（缺省值来自插件配置，见 plugins/goal.ts）。 */
export interface GoalStoreOptions {
  /** 取没显式给 maxRounds 时的缺省轮次上限；每次要用时现调，改了配置不用重启宿主。 */
  defaultMaxRounds?: () => number
}

/** 把配置给的轮次数收敛到 1~硬顶；不是数字就用缺省值。 */
function clampRounds(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(MAX_GOAL_ROUNDS_CAP, Math.floor(value))
    : DEFAULT_MAX_GOAL_ROUNDS
}

/** 目标快照（进会话日志，也进界面）。 */
export interface GoalSnapshot {
  id: string
  revision: number
  objective: string
  phase: GoalPhase
  /** phase=blocked 时必填：卡在哪。 */
  blockedReason?: string
  maxRounds: number
  rounds: number
}

/** 目标动作的结果（失败带原因，直接回给模型或界面）。 */
export type GoalResult = { ok: true; snapshot: GoalSnapshot } | { ok: false; error: string }

function newId(): string {
  return `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 一个会话一个目标存储。 */
export class GoalStore {
  private current: GoalSnapshot | null = null
  /** 进程本地开关：重启或切会话后为 disarmed，用户点「继续」才 armed。 */
  private armedFlag = false
  /** 没显式给 maxRounds 时用的轮次上限：每次现问插件配置，配置改了下一条目标就生效。 */
  private readonly defaultRounds: () => number

  constructor(options: GoalStoreOptions = {}) {
    const configured = options.defaultMaxRounds
    this.defaultRounds = typeof configured === 'function' ? () => clampRounds(configured()) : () => DEFAULT_MAX_GOAL_ROUNDS
  }

  get snapshot(): GoalSnapshot | null {
    return this.current === null ? null : { ...this.current }
  }

  /** 驱动器该不该继续塞续跑消息（phase=active 且已上膛）。 */
  get shouldContinue(): boolean {
    return this.armedFlag && this.current !== null && this.current.phase === 'active'
  }

  get armed(): boolean {
    return this.armedFlag
  }

  /** 上膛 / 卸膛（切会话、进程重启一律卸膛）。 */
  setArmed(value: boolean): void {
    this.armedFlag = value
  }

  /** 从会话日志恢复目标本体（阶段照原样恢复，但绝不上膛）。 */
  restore(snapshot: Partial<GoalSnapshot> | null): void {
    this.armedFlag = false
    if (snapshot === null || typeof snapshot.objective !== 'string' || snapshot.objective.trim() === '') {
      this.current = null
      return
    }
    const phase = GOAL_PHASES.includes(snapshot.phase as GoalPhase) ? (snapshot.phase as GoalPhase) : 'active'
    this.current = {
      id: typeof snapshot.id === 'string' ? snapshot.id : newId(),
      revision: typeof snapshot.revision === 'number' ? snapshot.revision : 1,
      objective: snapshot.objective.trim(),
      phase,
      ...(typeof snapshot.blockedReason === 'string' && snapshot.blockedReason !== ''
        ? { blockedReason: snapshot.blockedReason }
        : {}),
      maxRounds:
        typeof snapshot.maxRounds === 'number' && snapshot.maxRounds > 0
          ? Math.min(MAX_GOAL_ROUNDS_CAP, Math.floor(snapshot.maxRounds))
          : this.defaultRounds(),
      rounds: typeof snapshot.rounds === 'number' && snapshot.rounds >= 0 ? Math.floor(snapshot.rounds) : 0,
    }
  }

  /** 建新目标（模型可调用）。同会话已有未完成目标时拒，避免套娃。 */
  create(objective: string, maxRounds?: number): GoalResult {
    const text = objective.trim()
    if (text === '') return { ok: false, error: '目标不能是空话：一句话说清要交付什么。' }
    if (this.current !== null && (this.current.phase === 'active' || this.current.phase === 'paused')) {
      return {
        ok: false,
        error: `本会话已经有目标在跑（${this.current.objective.slice(0, 40)}…）。先完成它，或让用户 /goal clear。`,
      }
    }
    const cap =
      typeof maxRounds === 'number' && maxRounds > 0
        ? Math.min(MAX_GOAL_ROUNDS_CAP, Math.floor(maxRounds))
        : this.defaultRounds()
    this.current = {
      id: newId(),
      revision: 1,
      objective: text,
      phase: 'active',
      maxRounds: cap,
      rounds: 0,
    }
    this.armedFlag = true
    return { ok: true, snapshot: this.snapshot! }
  }

  /** 标完成（模型可调用，前提是它确实做完了）。 */
  complete(): GoalResult {
    if (this.current === null) return { ok: false, error: '当前没有目标。' }
    this.current = { ...this.snapshot!, phase: 'complete', revision: this.current.revision + 1 }
    delete this.current.blockedReason
    this.armedFlag = false
    return { ok: true, snapshot: this.snapshot! }
  }

  /** 报告阻塞（模型可调用；要说清卡在哪，且连续阻塞不自动续跑）。 */
  block(reason: string): GoalResult {
    if (this.current === null) return { ok: false, error: '当前没有目标。' }
    const text = reason.trim()
    if (text === '') return { ok: false, error: 'blocked 必须写清卡在哪里，不能只说「卡住了」。' }
    this.current = {
      ...this.current,
      phase: 'blocked',
      blockedReason: text,
      revision: this.current.revision + 1,
    }
    this.armedFlag = false
    return { ok: true, snapshot: this.snapshot! }
  }

  /** 用户暂停（界面或 /goal pause）。 */
  pauseByUser(): GoalResult {
    if (this.current === null) return { ok: false, error: '当前没有目标。' }
    this.current = { ...this.current, phase: 'paused', revision: this.current.revision + 1 }
    this.armedFlag = false
    return { ok: true, snapshot: this.snapshot! }
  }

  /** 用户恢复/上膛（界面或 /goal resume）。blocked 的目标恢复前要用户当面确认。 */
  resumeByUser(): GoalResult {
    if (this.current === null) return { ok: false, error: '当前没有目标：先用 /goal <目标> 建一个。' }
    if (this.current.phase === 'complete') return { ok: false, error: '这个目标已经完成了。' }
    if (this.current.rounds >= this.current.maxRounds) {
      return {
        ok: false,
        error: `已经跑满 ${this.current.maxRounds} 轮上限。要接着跑请用 /goal rounds <更大的数> 放宽上限。`,
      }
    }
    const resumed: GoalSnapshot = { ...this.snapshot!, phase: 'active', revision: this.current.revision + 1 }
    delete resumed.blockedReason
    this.current = resumed
    this.armedFlag = true
    return { ok: true, snapshot: this.snapshot! }
  }

  /** 用户改目标文本或轮次上限。 */
  editByUser(patch: { objective?: string; maxRounds?: number }): GoalResult {
    if (this.current === null) return { ok: false, error: '当前没有目标。' }
    const objective = patch.objective?.trim()
    if (patch.objective !== undefined && objective === '') return { ok: false, error: '目标不能改成空话。' }
    let maxRounds = this.current.maxRounds
    if (patch.maxRounds !== undefined) {
      if (!(patch.maxRounds > 0) || patch.maxRounds > MAX_GOAL_ROUNDS_CAP) {
        return { ok: false, error: `轮次上限要在 1 到 ${MAX_GOAL_ROUNDS_CAP} 之间。` }
      }
      maxRounds = Math.floor(patch.maxRounds)
    }
    this.current = {
      ...this.current,
      objective: objective !== undefined && objective !== '' ? objective : this.current.objective,
      maxRounds,
      revision: this.current.revision + 1,
    }
    if (this.current.rounds >= this.current.maxRounds && this.current.phase === 'active') {
      this.current = { ...this.current, phase: 'blocked', blockedReason: '轮次已达上限', revision: this.current.revision + 1 }
      this.armedFlag = false
    }
    return { ok: true, snapshot: this.snapshot! }
  }

  /** 用户清掉目标。 */
  clearByUser(): GoalResult {
    this.current = null
    this.armedFlag = false
    return { ok: true, snapshot: { id: '', revision: 0, objective: '', phase: 'complete', maxRounds: 0, rounds: 0 } }
  }

  /**
   * 跑完一轮后记账：到上限自动转 blocked（并卸膛）。
   * @returns 记账后的快照
   */
  countRound(): GoalSnapshot | null {
    if (this.current === null) return null
    const rounds = this.current.rounds + 1
    const overCap = rounds >= this.current.maxRounds
    this.current = {
      ...this.current,
      rounds,
      revision: this.current.revision + 1,
      ...(overCap ? { phase: 'blocked' as GoalPhase, blockedReason: `轮次已达上限 ${this.current.maxRounds}` } : {}),
    }
    if (overCap) this.armedFlag = false
    return this.snapshot
  }
}
