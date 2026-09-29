/**
 * 调度器：把「到点了」这件事变成一次投递。整个插件里只有这一个文件认识时间轮。
 *
 * 为什么这么设计：
 *   1. **单个自重排 setTimeout，不用 setInterval**。下一次该醒的时刻是能从任务表里现算出来的，
 *      用 setInterval 只会得到一个「不管有没有事都每分钟醒一次」的忙轮询；自重排则让空表时
 *      一次睡到下一次触发点。超长的延迟要**分段**（每次最多 6 小时）：`setTimeout` 的延迟是
 *      32 位有符号数，超过约 24.8 天会被当成 1 毫秒立即触发，那会变成死循环。`timer.unref()`
 *      是最后一道：只剩这一个定时器时，进程照样能退出，宿主关掉不该被定时任务拖住。
 *   2. **`.lock` 互斥**：同一份 tasks.json 被两个 dsc 进程一起推 `nextRunAt` 必然写坏一次排期。
 *      锁里存 `pid + 进程启动时刻指纹`（光靠 pid 会被回收骗过去），拿不到锁的进程只读——
 *      它照样能 list / create，但不推进、不投递，等锁空出来自然接管。
 *   3. **catch-up 只在启动后自然发生**：tick 本来就按「nextRunAt <= now」挑任务，
 *      睡了两小时醒来会一次看见错过的那些，所以关键是**决定跑几次**：至多一次。
 *      规则照 hermes `cron/jobs.py::_fast_forward_missed_recurring` 与
 *      `_retire_expired_oneshot`：宽限内正常补跑；超宽限则把积压合并成一次并快进排期；
 *      一次性任务超宽限直接退休（记录里写清跳过原因，绝不静默丢槽位）。
 *   4. **pre-dispatch 校验**照 hermes `cron/scheduler_preflight.py`：凭据解析不出来、
 *      投递目标不知道、沙箱不让写数据目录——这三种情况**一个模型请求都不发**，
 *      直接把任务标 blocked 并写下原因。自动化最贵的浪费是「明知会失败还去烧一次额度」。
 *   5. **投递前问 `waiting.any`**：界面上有审批卡、计划卡、提问卡挂着的时候不隔着一张卡硬推，
 *      整批推迟到下一 tick。人的决定排在机器前面。
 *   6. **不改 goal 的 rounds、不给 goal 上膛**（`src/core/goal.ts:230-242`、`:96-97`）。
 *      定时任务和会话目标是两码事：目标是「用户在场、说了一句就跑到完」，定时任务是
 *      「用户不在场、跑一次就收」。给 goal 上膛等于让无人值守的定时任务自己去点着一条
 *      可以无限续跑的链，那是把两个刹车一起拆掉——所以这个文件从头到尾不碰 `ctx.goal`。
 *
 * @module dsc/core/schedule/runner
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { formatDuration, formatInstant, graceMs, isOneShot, nextRunAt, type ScheduleRule } from './rule.js'
import { errorText, type ScheduleStatus, type ScheduleStore, type ScheduleTask } from './store.js'

/** 一次定时器最多睡多久：超长延迟分段，避开 setTimeout 的 32 位溢出。 */
export const TIMER_SLICE_MS = 6 * 3600_000

/** 「完全没到模型」的瞬时网络错重试阶梯：5 / 15 / 30 分钟（照 Claude Cowork 那三级）。 */
export const RETRY_LADDER_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 30 * 60_000]

/** 配额类错误拿不到 `retry after` 时的默认停靠时长。 */
export const DEFAULT_QUOTA_HOLD_MS = 15 * 60_000

/**
 * 调度锁内容。
 * `birth` 是「进程启动的墙钟时刻」（`now - process.uptime()`），pid 被系统回收时靠它分辨：
 * 光看 pid 存活会把一个恰好复用了老 pid 的无关进程当成「还在调度」。
 */
export interface ScheduleLockInfo {
  pid: number
  birth: number
}

/** 一次排期该不该跑、跑完排期落到哪。纯函数，自检直接调它。 */
export interface OccurrenceDecision {
  /** 这次要不要投递。 */
  fire: boolean
  /** 要投递的槽位（绝对时刻）。 */
  slot: number
  /** 处理完之后 `nextRunAt` 该落在哪里；null = 这条任务到此为止。 */
  next: number | null
  /** idle=还没到点；due=准点；late=宽限内补跑；catch-up=超宽限合并成一次；missed=一次性任务超宽限不跑。 */
  verdict: 'idle' | 'due' | 'late' | 'catch-up' | 'missed'
  /** 一句给人看的说明（进台账与提示条）。 */
  reason: string
}

function secondsText(ms: number): string {
  return formatDuration(Math.max(1, Math.round(ms / 1_000)))
}

/**
 * 决定一个已到点的槽位怎么处理。这就是 catch-up 策略的全部：**至多跑一次，绝不补积压**。
 *
 * - 一次性任务（after / at）：宽限 120 秒内照跑；超了不跑（`missed`），排期收尾。
 * - 周期任务：宽限内 = 补一次迟到的；超宽限 = 把积压合并成这一次跑掉，排期直接快进到现在之后。
 *
 * @param rule - 触发规则
 * @param timeZone - 任务时区（宽限与下一次都按时区算）
 * @param nextMs - 已经到点（或已错过）的那个槽位
 * @param nowMs - 现在
 */
export function decideOccurrence(
  rule: ScheduleRule,
  timeZone: string,
  nextMs: number | null,
  nowMs: number,
): OccurrenceDecision {
  if (nextMs === null) return { fire: false, slot: 0, next: null, verdict: 'idle', reason: '还没有排期' }
  if (nextMs > nowMs) return { fire: false, slot: nextMs, next: nextMs, verdict: 'idle', reason: '还没到点' }
  const lateMs = nowMs - nextMs
  const grace = graceMs(rule, timeZone, nextMs)
  if (isOneShot(rule)) {
    if (lateMs <= grace) {
      return { fire: true, slot: nextMs, next: null, verdict: 'due', reason: `一次性任务，迟到 ${secondsText(lateMs)}（宽限 ${secondsText(grace)} 内），照跑` }
    }
    return {
      fire: false,
      slot: nextMs,
      next: null,
      verdict: 'missed',
      reason: `一次性任务迟到 ${secondsText(lateMs)}，超过 ${secondsText(grace)} 宽限：不补跑，直接收尾`,
    }
  }
  const next = nextRunAt(rule, timeZone, nowMs)
  if (lateMs <= grace) {
    return lateMs <= 60_000
      ? { fire: true, slot: nextMs, next, verdict: 'due', reason: '到点' }
      : { fire: true, slot: nextMs, next, verdict: 'late', reason: `迟到 ${secondsText(lateMs)}（宽限 ${secondsText(grace)} 内），补跑一次` }
  }
  return {
    fire: true,
    slot: nextMs,
    next,
    verdict: 'catch-up',
    reason: `错过 ${secondsText(lateMs)}，超过 ${secondsText(grace)} 宽限：${secondsText(lateMs)} 里的积压合并成这一次，不逐次重放`,
  }
}

/** 失败分类：决定是走重试阶梯、停到恢复点，还是干等下一次排期。 */
export type FailureKind = 'quota' | 'transient' | 'other'

const QUOTA_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /quota/i,
  /insufficient[\s_-]?(quota|balance|credit)/i,
  /额度|配额|余额不足|欠费|限流/,
]

const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /econnrefused/i,
  /econnreset/i,
  /etimedout/i,
  /enotfound/i,
  /eai_again/i,
  /epipe/i,
  /fetch failed/i,
  /socket hang up/i,
  /network/i,
  /timed? ?out/i,
  /连接超时|网络|连不上|超时|连接被重置|拒绝连接/,
]

/**
 * 认一次失败是不是「完全没到模型」的瞬时网络错，或配额类。
 * 依赖错误原文是没办法的办法：`agent.followup` 是排队投递、不回传结果，
 * 只能从错误文本与「有没有等到回合结束」这两条弱信号里推断（见 noteTurnEnd）。
 */
export function classifyFailure(message: string): FailureKind {
  for (const pattern of QUOTA_PATTERNS) if (pattern.test(message)) return 'quota'
  for (const pattern of TRANSIENT_PATTERNS) if (pattern.test(message)) return 'transient'
  return 'other'
}

/** 从配额错误原文里抠出「恢复点还有多久」：`retry after 300s` / `300 秒后重试`，抠不到就用默认值。 */
export function quotaHoldMs(message: string): number {
  const english = /retry[\s_-]*after[\s:]*(\d+)\s*s/i.exec(message)
  if (english !== null) return Number(english[1]) * 1_000 + 60_000
  const chinese = /(\d+)\s*秒后/.exec(message)
  if (chinese !== null) return Number(chinese[1]) * 1_000 + 60_000
  const millis = /retry[\s_-]*after[\s:]*(\d+)\s*ms/i.exec(message)
  if (millis !== null) return Number(millis[1]) + 60_000
  return DEFAULT_QUOTA_HOLD_MS
}

/** 投递失败原因的分类结果（给提示条与台账用）。 */
export interface FailurePlan {
  kind: FailureKind
  /** 下一次该落在哪（null = 不动，等自然排期）。 */
  next: number | null
  /** 连续失败次数。 */
  failureStreak: number
  status: ScheduleStatus
  detail: string
}

/**
 * 算一次失败该怎么记账。纯函数，自检直接调它。
 *
 * - 配额类：`nextRunAt` 停到恢复点（原文给了 `retry after` 就用它，否则 15 分钟）。
 * - 瞬时网络错：走 5/15/30 分钟阶梯，且**只在整个阶梯还没用完、且比自然排期更早**时才插队。
 * - 其它：不动排期，只记失败——到过模型的失败不该被自动重发（可能已经有副作用了）。
 */
export function planFailure(
  rule: ScheduleRule,
  timeZone: string,
  nextRunAtMs: number | null,
  nowMs: number,
  message: string,
  usedRungs: number,
): FailurePlan {
  const kind = classifyFailure(message)
  if (kind === 'quota') {
    const holdUntil = nowMs + quotaHoldMs(message)
    return {
      kind,
      next: nextRunAtMs !== null && nextRunAtMs >= holdUntil ? nextRunAtMs : holdUntil,
      failureStreak: 1,
      status: 'blocked',
      detail: `配额/限流：停到 ${formatInstant(holdUntil, timeZone)}（${timeZone}）再试`,
    }
  }
  if (isOneShot(rule)) {
    // 一次性任务的这次派发已经用掉了（beginSlot 把 nextRunAt 推成了 null），重跑就是重发一遍。
    return {
      kind,
      next: nextRunAtMs,
      failureStreak: 0,
      status: 'failed',
      detail: '一次性任务不自动重跑：这次派发已经用掉了，要再跑就重新建一个',
    }
  }
  if (kind === 'transient' && usedRungs < RETRY_LADDER_MS.length) {
    const at = nowMs + RETRY_LADDER_MS[usedRungs]!
    if (nextRunAtMs !== null && nextRunAtMs <= at) {
      return { kind, next: nextRunAtMs, failureStreak: usedRungs + 1, status: 'failed', detail: '自然排期比重试阶梯更早，等它自己到点' }
    }
    return {
      kind,
      next: at,
      failureStreak: usedRungs + 1,
      status: 'failed',
      detail: `没到模型（瞬时网络错），第 ${usedRungs + 1}/${RETRY_LADDER_MS.length} 档重试：${secondsText(RETRY_LADDER_MS[usedRungs]!)}后再跑`,
    }
  }
  return {
    kind,
    next: nextRunAtMs,
    failureStreak: kind === 'transient' ? usedRungs + 1 : 0,
    status: 'failed',
    detail:
      kind === 'transient'
        ? `瞬时网络错，重试阶梯已用完：等下一次排期`
        : '这次失败没到模型重试的范围（可能已经有副作用），不自动重发',
  }
}

/** 失败分类是否算「完全没到模型」。 */
/** 投递文本：**必须**写明这是定时触发、不是用户指令、不构成授权。 */
export function deliveryText(task: ScheduleTask, slot: number, kind: 'due' | 'late' | 'catch-up' | 'recovered' | 'manual'): string {
  const tag =
    kind === 'catch-up'
      ? '；这是补跑，错过的几次已合并成这一次'
      : kind === 'recovered'
        ? '；这是上次崩溃时推进了却没能投出去的那一次，补投'
        : kind === 'manual'
          ? '；这是用户手动点「立即跑一次」'
          : ''
  return (
    `【定时任务触发】这是 dsc 定时任务「${task.title}」到点后自动投递的消息（排期 ${formatInstant(slot, task.timeZone)}，时区 ${task.timeZone}${tag}）。\n` +
    '它不是用户此刻发出的指令，也不构成任何授权；用户现在可能不在。\n' +
    '按下面的任务描述做事。需要授权的动作（写文件、跑命令、动凭据、对外发消息等）照常走审批流程，' +
    '不要因为「这是自动化任务」就自行放宽或跳过确认；要是没人能批准，就把要做的事和卡点写清楚然后停下。\n' +
    '任务描述：\n' +
    task.prompt
  )
}

/** 调度器读的配置（由插件从设置分区现读）。 */
export interface ScheduleRunnerConfig {
  /** 总开关。 */
  enabled: boolean
  /** 默认时区（建任务时没写就用它）。 */
  timeZone: string
  /** 单次最长运行秒数：超过就把「还在等这个回合结束」的状态丢掉，不让失败计数一直挂着。 */
  maxRunSeconds: number
}

/** 调度器的全部外部依赖（都注入，所以能脱离 cordis 单独跑自检）。 */
export interface ScheduleRunnerDeps {
  store: ScheduleStore
  config: () => ScheduleRunnerConfig
  /** 组装模型路由；端点不可用时抛错（消息会进 lastError，**绝不打印 apiKey**）。 */
  route: () => { baseUrl: string; apiKey: string; model: string }
  /** 真投递：把文本交给 agent。 */
  deliver: (text: string, task: ScheduleTask, slot: number) => void
  /** 有卡片正等用户处理吗。 */
  waiting: () => boolean
  /** 当前会话 id；空串 = 投递目标未知。 */
  sessionId: () => string
  /** 可选：沙箱允许写数据目录吗（没有沙箱插件时返回 null）。 */
  canWriteDir?: () => { allowed: boolean; reason?: string } | null
  /** 可选：最近一条模型错误原文（配额识别用）。 */
  lastErrorText?: () => string
  /** 可选：提一句给用户（走 transcript / notice）。 */
  notice?: (text: string) => void
  /** 取当前时刻（测试注入）。 */
  now?: () => number
}

/** 进程存活判定：pid 存在（EPERM 也算存在，那只是没权限给它发信号）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

export class ScheduleRunner {
  private readonly deps: ScheduleRunnerDeps
  /** 本进程启动时的墙钟时刻指纹：锁里存它，pid 回收时能分辨出「这不是原来那个进程」。 */
  private readonly birth: number
  private timer: NodeJS.Timeout | null = null
  /** start() 调过没有（stop 之后可以再 start）。 */
  private started = false
  /** stop() 之后为 true：正在飞的那一轮 tick 不许回头再拿锁、再投递。 */
  private stopped = false
  private ticking = false
  private lock: ScheduleLockInfo | null = null
  private lockNoticed = false
  /** 已经投出去、还在等 `dsc/turn-end` 的那些投递（先进先出）。 */
  private readonly deliveries: Array<{ id: string; at: number }> = []
  /** 每条任务已经用掉几档重试。 */
  private readonly retryRungs = new Map<string, number>()

  constructor(deps: ScheduleRunnerDeps) {
    this.deps = deps
    this.birth = Math.round(this.now() - process.uptime() * 1_000)
  }

  /** 现在握着调度锁吗（false = 本进程只读，不推进、不投递）。 */
  get hasLock(): boolean {
    return this.lock !== null
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private note(text: string): void {
    this.deps.notice?.(text)
  }

  /** 启动：拿锁 → 先跑一次（宿主启动时的 catch-up 就在这一次里）→ 排下一次唤醒。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.stopped = false
    this.refreshLock()
    // 启动那一次 catch-up 走同一条 tick，所以「错过最近一次」的判定只有一处实现。
    void this.tick().catch((error: unknown) => this.note(`定时任务启动检查失败：${errorText(error)}`))
    this.arm()
  }

  /** 停用 / 宿主退出：清定时器、放锁。**必须**在 apply 的 disposer 里调。 */
  stop(): void {
    this.stopped = true
    this.started = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.releaseLock()
  }

  /** 立刻检查一遍（设置分区那个按钮），返回一句结果文案。 */
  async checkNow(): Promise<string> {
    this.refreshLock()
    if (this.lock === null) return '另一个 Muse Code 进程正握着调度锁，本进程只读：等它退出后再试'
    const config = this.deps.config()
    if (!config.enabled) return '定时任务总开关是关着的：先在设置里打开'
    await this.tick()
    this.arm()
    return this.describeState()
  }

  /** 立即跑一次某条任务（不占它的排期）。 */
  async fireNow(id: string): Promise<string> {
    this.refreshLock()
    if (this.lock === null) return '另一个 Muse Code 进程正握着调度锁，本进程只读，不能手动跑'
    const config = this.deps.config()
    if (!config.enabled) return '定时任务总开关是关着的：先在设置里打开'
    this.deps.store.reload()
    const found = this.deps.store.findByPrefix(id)
    if (!found.ok) throw new Error(found.error)
    const task = found.task
    if (this.deps.waiting()) return '现在有卡片在等用户处理：先处理完卡片，或者直接在会话里说一句'
    const blocked = this.preflight(task)
    if (blocked !== null) return `投不出去：${blocked}`
    // 手动跑不动周期任务的排期；但一次性任务的意义就是「那一刻跑一次」，手动跑掉就算用过了。
    const keepNext = isOneShot(task.rule) ? null : task.nextRunAt
    await this.deliver(task, this.now(), 'manual', keepNext)
    return `已把「${task.title}」立即投给模型${keepNext === null ? '' : `（定时排期不动，仍在 ${formatInstant(keepNext, task.timeZone)}）`}`
  }

  /**
   * 一轮 tick。做的事按顺序：拿锁 → 读总开关 → 重新读盘 → 补投悬空槽位 → 处理到点任务 → 修剪等待表。
   * @returns 这一轮有没有真的做过事（自检与诊断用）
   */
  async tick(): Promise<boolean> {
    // 已经 stop 过就不再动手：卸载是热卸载，正在飞的那一轮 tick 不许回头再拿锁 / 再投递。
    if (this.stopped) return false
    if (this.ticking) return false
    this.ticking = true
    let worked = false
    try {
      this.refreshLock()
      if (this.lock === null) return false
      if (!this.deps.config().enabled) return false
      this.deps.store.reload()
      this.forgetExpiredDeliveries()
      worked = (await this.recoverPending()) || worked
      worked = (await this.processDue()) || worked
    } catch (error) {
      this.note(`定时任务检查时出错：${errorText(error)}`)
    } finally {
      this.ticking = false
    }
    return worked
  }

  /**
   * 一轮对话结束时的对账。`agent.followup` 只管排队、不回传结果，所以这是唯一能看到的信号：
   *   completed → 到过模型，重试阶梯清零；
   *   error     → 按错误原文分类，配额停到恢复点、瞬时错走阶梯；
   *   aborted   → 用户中断，既不清零也不升级。
   */
  noteTurnEnd(reason: 'completed' | 'aborted' | 'error'): void {
    const delivery = this.deliveries.shift()
    if (delivery === undefined) return
    const task = this.deps.store.get(delivery.id)
    if (task === undefined) return
    if (reason === 'aborted') return
    if (reason === 'completed') {
      this.retryRungs.delete(task.id)
      if (task.lastStatus === 'failed' || task.failureStreak !== 0) {
        void this.deps.store.endSlot(task.id, { status: 'ok', failureStreak: 0, error: null })
      }
      return
    }
    const message = this.deps.lastErrorText?.() ?? ''
    void this.handleFailure(task, message === '' ? '这一轮以错误结束（模型端点报错）' : message)
  }

  /** 一句现状（设置分区、命令页脚共用）。 */
  describeState(): string {
    const tasks = this.deps.store.list()
    const enabled = tasks.filter((task) => task.enabled).length
    const pending = tasks.filter((task) => task.pendingSlot !== null).length
    const nearest = tasks
      .filter((task) => task.enabled && task.nextRunAt !== null)
      .reduce<number | null>((best, task) => (best === null || task.nextRunAt! < best ? task.nextRunAt! : best), null)
    const lockText = this.lock === null ? '本进程只读（另一个进程在调度）' : `本进程在调度（pid ${process.pid}）`
    const nextText =
      nearest === null ? '没有排到将来的任务' : `下一次唤醒 ${formatInstant(nearest, this.deps.config().timeZone)}`
    return `${tasks.length} 条任务（${enabled} 条启用）｜${nextText}｜${lockText}${pending > 0 ? `｜${pending} 个槽位待补投` : ''}`
  }

  // ── 排期处理 ────────────────────────────────────────────────────────────────

  /** 悬空槽位补投：推进了却没投出去的那一次，只补一次。 */
  private async recoverPending(): Promise<boolean> {
    const pending = this.deps.store.pendingTasks()
    if (pending.length === 0) return false
    if (this.deps.waiting()) {
      this.note('有卡片正等用户处理：定时任务的补投推迟到下一轮')
      return false
    }
    for (const task of pending) {
      const slot = task.pendingSlot
      if (slot === null) continue
      this.note(`任务「${task.title}」的槽位（${formatInstant(slot, task.timeZone)}）推进了却没投出去，补投一次`)
      // 先清 pendingSlot 再投不行（崩了又丢），所以投递路径里 endSlot 一定会清掉它——
      // 无论成功、失败还是阻塞，都不会留着让下一轮再投一次。
      await this.deliver(task, slot, 'recovered', nextRunAt(task.rule, task.timeZone, this.now()))
    }
    return true
  }

  /** 到点的任务：先算要不要跑（catch-up 策略），再决定投不投。 */
  private async processDue(): Promise<boolean> {
    const now = this.now()
    let worked = false
    interface Due {
      task: ScheduleTask
      slot: number
      next: number | null
      kind: 'due' | 'late' | 'catch-up'
      reason: string
    }
    const due: Due[] = []
    for (const task of this.deps.store.list()) {
      if (!task.enabled) continue
      if (task.pendingSlot !== null) continue // 上面补投过了
      let next = task.nextRunAt
      if (next === null) {
        next = nextRunAt(task.rule, task.timeZone, now)
        if (next === null) {
          // 算不出下一次：一次性任务已经过期，或规则永远不匹配。停用它，别每轮重算。
          const reason = isOneShot(task.rule) ? '这条一次性任务已经过期，自动停用' : '这条规则算不出下一次触发时刻，自动停用'
          // 保留已有的结论（上次失败 / 被阻塞的原因要给人看），只有从没跑过的才标成 done。
          const status: ScheduleStatus = task.lastStatus === 'never' || task.lastStatus === 'running' ? 'done' : task.lastStatus
          await this.deps.store.update(task.id, { enabled: false })
          await this.deps.store.endSlot(task.id, { status, error: task.lastError })
          await this.deps.store.appendRun({ at: now, id: task.id, title: task.title, slot: 0, status: 'skipped', detail: reason })
          this.note(`定时任务「${task.title}」：${reason}`)
          worked = true
          continue
        }
        await this.deps.store.setNextRunAt(task.id, next)
        worked = true
      }
      if (next > now) continue
      const decision = decideOccurrence(task.rule, task.timeZone, next, now)
      if (decision.verdict === 'idle') continue
      if (!decision.fire) {
        // 一次性任务超宽限：不静默丢槽位，写一条「跳过」再收尾。
        await this.deps.store.endSlot(task.id, { status: 'skipped', error: null, nextRunAt: null })
        await this.deps.store.update(task.id, { enabled: false })
        await this.deps.store.appendRun({ at: now, id: task.id, title: task.title, slot: decision.slot, status: 'skipped', detail: decision.reason })
        this.note(`定时任务「${task.title}」：${decision.reason}`)
        worked = true
        continue
      }
      due.push({
        task,
        slot: decision.slot,
        next: decision.next,
        kind: decision.verdict === 'due' ? 'due' : decision.verdict === 'late' ? 'late' : 'catch-up',
        reason: decision.reason,
      })
    }
    if (due.length === 0) return worked
    // 有卡片挂着就把整批推迟：不隔着一张卡硬推。排期一律没动，下一 tick 会重新看见它们。
    if (this.deps.waiting()) {
      this.note(`有 ${due.length} 条定时任务到点，但界面有卡片在等用户处理：推迟到下一轮`)
      return worked
    }
    for (const item of due) {
      if (item.kind === 'catch-up') this.note(`定时任务「${item.task.title}」：${item.reason}`)
      await this.deliver(item.task, item.slot, item.kind, item.next)
      worked = true
    }
    return worked
  }

  // ── 投递 ────────────────────────────────────────────────────────────────────

  /** pre-dispatch 校验：返回非 null 就是**不能投**的原因（一次模型请求都不会发）。 */
  private preflight(task: ScheduleTask): string | null {
    let sessionId = ''
    try {
      sessionId = this.deps.sessionId()
    } catch (error) {
      return `投递目标未知：读不到当前会话（${errorText(error)}）`
    }
    if (sessionId === '') return '投递目标未知：当前没有打开的会话，定时任务没有地方投'
    let route: { baseUrl: string; apiKey: string; model: string }
    try {
      route = this.deps.route()
    } catch (error) {
      return `模型端点不可用：${errorText(error)}`
    }
    if (route.baseUrl === '' || route.model === '') return '模型端点不可用：baseUrl 或 model 是空的'
    // 只判空，绝不把 key 写进任何提示或落盘内容。
    if (route.apiKey === '') return '模型端点没有可解析的凭据（key 是空的）：先去设置「模型」分区配好'
    const sandbox = this.deps.canWriteDir?.() ?? null
    if (sandbox !== null && !sandbox.allowed) {
      return `沙箱不允许写定时任务的数据目录（${this.deps.store.dir}）：${sandbox.reason ?? '越界'}`
    }
    return null
  }

  /**
   * 投一次。**至多一次**的顺序是死的：先把 `nextRunAt` 推进并落 `pendingSlot`，再调 `deliver`。
   * 反过来的话，崩在「投出去了但排期没推进」之间，重启就会再投一遍。
   */
  private async deliver(
    task: ScheduleTask,
    slot: number,
    kind: 'due' | 'late' | 'catch-up' | 'recovered' | 'manual',
    next: number | null,
  ): Promise<void> {
    const now = this.now()
    const blocked = this.preflight(task)
    if (blocked !== null) {
      // 校验没过：照样把槽位推走（否则每一 tick 都重判一次），但一次模型请求都不发。
      await this.deps.store.beginSlot(task.id, slot, next)
      await this.deps.store.endSlot(task.id, { status: 'blocked', error: blocked })
      await this.retireFinishedOneShot(task, next)
      await this.deps.store.appendRun({ at: now, id: task.id, title: task.title, slot, status: 'blocked', detail: blocked })
      if (task.lastStatus !== 'blocked' || task.lastError !== blocked) {
        this.note(`定时任务「${task.title}」暂时投不出去：${blocked}`)
      }
      return
    }
    await this.deps.store.beginSlot(task.id, slot, next)
    try {
      this.deps.deliver(deliveryText(task, slot, kind), task, slot)
    } catch (error) {
      const message = errorText(error)
      const plan = planFailure(task.rule, task.timeZone, next, now, message, this.retryRungs.get(task.id) ?? 0)
      await this.deps.store.endSlot(task.id, { status: plan.status, error: message, nextRunAt: plan.next, failureStreak: plan.failureStreak })
      await this.retireFinishedOneShot(task, plan.next)
      await this.deps.store.appendRun({ at: now, id: task.id, title: task.title, slot, status: plan.status, detail: `投递失败：${message}；${plan.detail}` })
      this.note(`定时任务「${task.title}」投递失败：${message}；${plan.detail}`)
      return
    }
    this.deliveries.push({ id: task.id, at: now })
    await this.deps.store.endSlot(task.id, { status: 'ok', error: null, delivered: true })
    await this.retireFinishedOneShot(task, next)
    await this.deps.store.appendRun({ at: now, id: task.id, title: task.title, slot, status: kind === 'manual' ? 'manual' : 'ok', detail: kind })
  }

  /**
   * 一次性任务投完 / 投不出去之后排期就是 null 了，顺手停用它：
   * 不停用的话每一轮 tick 都要重新算一次「算不出下一次」，还会让「下次唤醒」永远退化成 1 秒。
   */
  private async retireFinishedOneShot(task: ScheduleTask, next: number | null): Promise<void> {
    if (next !== null || !isOneShot(task.rule)) return
    await this.deps.store.update(task.id, { enabled: false })
  }

  /** 回合以错误结束：分类、记账、必要时排重试。 */
  private async handleFailure(task: ScheduleTask, message: string): Promise<void> {
    const now = this.now()
    const rung = this.retryRungs.get(task.id) ?? 0
    const plan = planFailure(task.rule, task.timeZone, task.nextRunAt, now, message, rung)
    if (plan.kind === 'transient' && !isOneShot(task.rule) && rung < RETRY_LADDER_MS.length) {
      this.retryRungs.set(task.id, rung + 1)
    } else {
      this.retryRungs.delete(task.id)
    }
    await this.deps.store.endSlot(task.id, {
      status: plan.status,
      error: message,
      nextRunAt: plan.next,
      failureStreak: plan.failureStreak,
    })
    await this.deps.store.appendRun({
      at: now,
      id: task.id,
      title: task.title,
      slot: task.lastRunAt ?? 0,
      status: plan.status,
      detail: `${plan.detail}｜${message}`,
    })
    this.note(`定时任务「${task.title}」这一轮没跑成：${message}；${plan.detail}`)
  }

  /** 等太久的投递配对（宿主忙、回合被吞）：丢掉，免得失败计数一直挂在一条老记录上。 */
  private forgetExpiredDeliveries(): void {
    const limit = Math.max(60_000, this.deps.config().maxRunSeconds * 1_000)
    const now = this.now()
    while (this.deliveries.length > 0 && now - this.deliveries[0]!.at > limit) this.deliveries.shift()
  }

  // ── 定时器 ──────────────────────────────────────────────────────────────────

  /** 算出最近该醒的时刻，排一个定时器（超长分段）。 */
  private arm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.stopped) return
    const now = this.now()
    let wakeAt = now + TIMER_SLICE_MS
    for (const task of this.deps.store.list()) {
      if (!task.enabled) continue
      // 排期没算过的（刚建的 / 规则刚改的）马上醒来算一次。
      if (task.nextRunAt === null || task.pendingSlot !== null) wakeAt = Math.min(wakeAt, now + 1_000)
      else wakeAt = Math.min(wakeAt, Math.max(task.nextRunAt, now + 500))
    }
    const delay = Math.max(0, wakeAt - now)
    const sliced = delay >= TIMER_SLICE_MS
    const timer = setTimeout(() => {
      this.timer = null
      if (this.stopped) return
      // 只是分段到点：重排一次即可，不必惊动任务表。
      if (sliced) {
        this.arm()
        return
      }
      void this.tick()
        .catch((error: unknown) => this.note(`定时任务检查失败：${errorText(error)}`))
        .finally(() => this.arm())
    }, delay)
    // 只剩它一个定时器时别挡住进程退出。
    timer.unref?.()
    this.timer = timer
  }

  // ── 调度锁 ──────────────────────────────────────────────────────────────────

  private readLock(): ScheduleLockInfo | null {
    if (!existsSync(this.deps.store.lockFile)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.deps.store.lockFile, 'utf8')) as Partial<ScheduleLockInfo>
      if (typeof parsed.pid !== 'number' || typeof parsed.birth !== 'number') return null
      return { pid: Math.round(parsed.pid), birth: Math.round(parsed.birth) }
    } catch {
      return null
    }
  }

  private writeLock(): void {
    const info: ScheduleLockInfo = { pid: process.pid, birth: this.birth }
    try {
      mkdirSync(this.deps.store.dir, { recursive: true })
      const tmp = `${this.deps.store.lockFile}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(info)}\n`, 'utf8')
      renameSync(tmp, this.deps.store.lockFile)
      this.lock = info
    } catch (error) {
      this.lock = null
      this.note(`写调度锁失败（${errorText(error)}）：本进程这轮不调度`)
    }
  }

  /** 拿锁：内容还是自己的就继续；别人活着就让；主人死了就接管（pid + 启动指纹一起看）。 */
  private refreshLock(): void {
    if (this.stopped) return
    const info = this.readLock()
    if (info === null) {
      this.writeLock()
      return
    }
    if (info.pid === process.pid && info.birth === this.birth) {
      this.lock = info
      return
    }
    if (isProcessAlive(info.pid)) {
      this.lock = null
      if (!this.lockNoticed) {
        this.lockNoticed = true
        this.note(`另一个 Muse Code 进程（pid ${info.pid}）正握着调度锁：本进程只读，不推进也不投递`)
      }
      return
    }
    if (this.lockNoticed) this.lockNoticed = false
    this.note(`上一个调度进程（pid ${info.pid}）已经不在了：本进程接管调度`)
    this.writeLock()
  }

  private releaseLock(): void {
    if (this.lock === null) return
    const info = this.readLock()
    if (info !== null && info.pid === process.pid && info.birth === this.birth) {
      try {
        unlinkSync(this.deps.store.lockFile)
      } catch {
        // 删不掉就算了：下一个进程会按「主人已死」接管
      }
    }
    this.lock = null
  }
}

/** 给提示条用的一句话摘要（含「宿主不常驻就不触发」这句必须说清的限制）。 */
export function scheduleLimitsNote(): string {
  return (
    '宿主不常驻就不触发：dsc 桌面端或终端关着的时候，定时任务不会醒（本插件不做系统计划任务兜底，' +
    '那是后门高危动作）。醒来后错过的排期按「至多补一次、不补积压」处理。'
  )
}
