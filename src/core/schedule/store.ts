/**
 * 定时任务的落盘层：任务定义 `~/.dsc/schedule/tasks.json` + 执行台账 `~/.dsc/schedule/runs.jsonl`。
 *
 * 为什么这么设计：
 *   1. **只写 `~/.dsc/schedule/` 一个目录**（没设 `DSC_HOME` 时就是它）。定时任务是插件，
 *      插件不该往会话目录、技能目录里伸手；要清理就删这一个目录。
 *   2. **写文件一律 tmp + rename**。JSON 整份重写，直接覆盖的话，写到一半断电会留下
 *      半截 JSON；先写同目录的临时文件再 rename，读到的东西要么是旧的完整版、要么是新的完整版。
 *   3. **所有写走一条 FIFO**。一个 tick 里可能连着推进好几条任务的 `nextRunAt`，
 *      交织执行会各写一份旧内存快照、把别的改动吃掉。FIFO 把「读-改-写」串成一条链。
 *   4. **至多一次靠 `pendingSlot`**：先把 `nextRunAt` 推到槽位之后并记下槽位，再去投递。
 *      崩在中间时，重启能看见「推进了但没投」这个窗口，补投一次而不是每次重启都重投。
 *      （思路照 hermes `cron/occurrences.py:57-102`。）
 *   5. **损坏兜底不抛错**：`tasks.json` 被手改坏、被别的进程写坏时，备份成 .corrupt、
 *      按空清单继续跑，问题以一句话交给调用方去提示用户——一个坏文件不该让插件整个挂掉。
 *
 * @module dsc/core/schedule/store
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isValidTimeZone, normalizeRule, type ScheduleRule } from './rule.js'
import { dscPath } from '../path-policy.js'

/** 任务最近一次执行的结果。`never` = 从没跑过；`running` = 槽位已推进、投递还没落定。 */
export type ScheduleStatus = 'never' | 'running' | 'ok' | 'failed' | 'blocked' | 'skipped' | 'done'

/** 一条定时任务。这就是 tasks.json 里的一项，字段名改了老文件就读不回来。 */
export interface ScheduleTask {
  id: string
  title: string
  /** 到点后交给模型的那段任务描述。 */
  prompt: string
  rule: ScheduleRule
  /** 显式 IANA 时区（`daily:09:30` 这类墙上时刻靠它换算）。 */
  timeZone: string
  enabled: boolean
  /** 下一次该跑的绝对时刻；null = 不再跑（一次性任务已经跑过）。 */
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: ScheduleStatus
  /** 最近一次失败 / 阻塞的原因原文，给用户看。 */
  lastError: string | null
  /** 连续失败次数；「到过模型」就清零（见 runner 的失败重试阶梯）。 */
  failureStreak: number
  /** 已经推进、但还没投递完的那个槽位（绝对时刻）；null = 没有悬空的槽位。 */
  pendingSlot: number | null
  /** 谁建的：`user`（命令/设置页）/ `model`（工具）/ `system`。 */
  createdBy: string
  /** 最近的投递时刻（毫秒），按 30 天或 200 条裁剪。 */
  deliveryHistory: number[]
  /** 建任务时的会话 id（记录来源；投递只能投当前会话，见 runner 的说明）。 */
  sessionId: string
  createdAt: number
  updatedAt: number
}

/** 执行台账里的一条（runs.jsonl 的一行）。 */
export interface ScheduleRun {
  /** 记账时刻（毫秒）。 */
  at: number
  id: string
  title: string
  /** 这次对应哪个排期槽位（绝对时刻）。 */
  slot: number
  /** ok / failed / blocked / skipped / recovered / manual。 */
  status: string
  detail: string
}

/** 台账默认保留条数。再多也没人看，还会把文件撑到几兆。 */
export const DEFAULT_RUN_LIMIT = 1_000

/** 投递历史默认保留条数。 */
export const DEFAULT_HISTORY_LIMIT = 200

/** 投递历史默认保留天数。 */
export const DEFAULT_HISTORY_WINDOW_MS = 30 * 86_400_000

/** 存储层的可调项（测试时把 dir 指到临时目录）。 */
export interface ScheduleStoreOptions {
  /** 数据目录；缺省 `~/.dsc/schedule`。 */
  dir?: string
  /** 台账保留条数。 */
  runLimit?: number
  /** 投递历史保留条数。 */
  historyLimit?: number
  /** 投递历史保留时长。 */
  historyWindowMs?: number
  /** 取当前时刻（测试注入用）。 */
  now?: () => number
}

/** 数据目录：`DSC_HOME` 优先（和仓库其他模块同一套约定），否则 `~/.dsc/schedule`。 */
export function scheduleDir(): string {
  const home = process.env.DSC_HOME ?? dscPath()
  return join(home, 'schedule')
}

/** 读盘结果：任务清单 + 一句「文件有问题」的说明（没问题时为 null）。 */
export interface ScheduleLoadResult {
  tasks: ScheduleTask[]
  problem: string | null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 建一个新任务 id：时间有序（列表好读）+ 4 位随机（同一毫秒也不会撞）。 */
function newTaskId(): string {
  return `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 把磁盘上的一项收敛成合法任务；认不出返回 null（调用方跳过并记账）。
 * 磁盘文件是用户能手改的，属于不可信输入。
 */
export function normalizeTask(value: unknown): ScheduleTask | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : ''
  const timeZone = typeof raw.timeZone === 'string' && isValidTimeZone(raw.timeZone) ? raw.timeZone : null
  const rule = normalizeRule(raw.rule)
  if (id === null || title === '' || prompt === '' || timeZone === null || rule === null) return null
  const status = raw.lastStatus
  return {
    id,
    title,
    prompt,
    rule,
    timeZone,
    enabled: raw.enabled !== false,
    nextRunAt: isFiniteNumber(raw.nextRunAt) ? Math.round(raw.nextRunAt) : null,
    lastRunAt: isFiniteNumber(raw.lastRunAt) ? Math.round(raw.lastRunAt) : null,
    lastStatus:
      status === 'never' || status === 'running' || status === 'ok' || status === 'failed' ||
      status === 'blocked' || status === 'skipped' || status === 'done'
        ? status
        : 'never',
    lastError: typeof raw.lastError === 'string' && raw.lastError !== '' ? raw.lastError : null,
    failureStreak: isFiniteNumber(raw.failureStreak) && raw.failureStreak > 0 ? Math.floor(raw.failureStreak) : 0,
    pendingSlot: isFiniteNumber(raw.pendingSlot) ? Math.round(raw.pendingSlot) : null,
    createdBy: typeof raw.createdBy === 'string' && raw.createdBy !== '' ? raw.createdBy : 'user',
    deliveryHistory: Array.isArray(raw.deliveryHistory)
      ? raw.deliveryHistory.filter(isFiniteNumber).map((entry) => Math.round(entry))
      : [],
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    createdAt: isFiniteNumber(raw.createdAt) ? Math.round(raw.createdAt) : 0,
    updatedAt: isFiniteNumber(raw.updatedAt) ? Math.round(raw.updatedAt) : 0,
  }
}

/** 复制一份任务再交出去：调用方改了不该影响 store 里的那份。 */
function cloneTask(task: ScheduleTask): ScheduleTask {
  return { ...task, deliveryHistory: [...task.deliveryHistory] }
}

/** 建任务时要给的字段。 */
export interface ScheduleTaskInput {
  title: string
  prompt: string
  rule: ScheduleRule
  timeZone: string
  createdBy?: string
  sessionId?: string
  enabled?: boolean
}

/** 任务里可以被改的字段（其余字段只有 runner 会动）。 */
export interface ScheduleTaskPatch {
  title?: string
  prompt?: string
  rule?: ScheduleRule
  timeZone?: string
  enabled?: boolean
}

/** 一次投递结束后的记账。 */
export interface SlotOutcome {
  status: ScheduleStatus
  error?: string | null
  /** 成功投递时记一条投递历史。 */
  delivered?: boolean
  /** 投递之后 nextRunAt 要落在哪里；不传 = 不动（beginSlot 已经推过了）。 */
  nextRunAt?: number | null
  /** 连续失败次数；不传 = 按 status 自己推。 */
  failureStreak?: number
}

export class ScheduleStore {
  readonly dir: string
  readonly tasksFile: string
  readonly runsFile: string
  readonly lockFile: string
  private runLimit: number
  private historyLimit: number
  private readonly historyWindowMs: number
  private readonly clock: () => number
  private tasks: ScheduleTask[] = []
  private runLines = -1
  /** 写操作串行链：上一个无论如何结束，下一个才开始。 */
  private chain: Promise<unknown> = Promise.resolve()
  /** 最近一次读盘发现的问题，交给设置分区与命令显示。 */
  private lastProblem: string | null = null

  constructor(options: ScheduleStoreOptions = {}) {
    this.dir = options.dir ?? scheduleDir()
    this.tasksFile = join(this.dir, 'tasks.json')
    this.runsFile = join(this.dir, 'runs.jsonl')
    this.lockFile = join(this.dir, '.lock')
    this.runLimit = options.runLimit ?? DEFAULT_RUN_LIMIT
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
    this.historyWindowMs = options.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS
    this.clock = options.now ?? (() => Date.now())
  }

  /** 读盘时发现的问题（损坏兜底、跳过的坏条目）。 */
  get problem(): string | null {
    return this.lastProblem
  }

  /**
   * 改保留额度（设置分区里改了「历史保留条数」立刻生效，不必重启宿主）。
   * @param limits - 台账条数与投递历史条数，都是 1 以上的整数
   */
  setLimits(limits: { runLimit?: number; historyLimit?: number }): void {
    if (limits.runLimit !== undefined && Number.isFinite(limits.runLimit) && limits.runLimit > 0) {
      this.runLimit = Math.floor(limits.runLimit)
    }
    if (limits.historyLimit !== undefined && Number.isFinite(limits.historyLimit) && limits.historyLimit > 0) {
      this.historyLimit = Math.floor(limits.historyLimit)
    }
  }

  /** 从磁盘读一遍任务清单（同步；文件很小，属于启动与 tick 前的必备动作）。 */
  load(): ScheduleLoadResult {
    this.tasks = []
    this.lastProblem = null
    if (!existsSync(this.tasksFile)) return { tasks: [], problem: null }
    let text = ''
    try {
      text = readFileSync(this.tasksFile, 'utf8')
    } catch (error) {
      this.lastProblem = `任务文件读不动（${errorText(error)}），本次按空清单处理`
      return { tasks: [], problem: this.lastProblem }
    }
    let doc: unknown
    try {
      doc = text.trim() === '' ? { tasks: [] } : JSON.parse(text)
    } catch (error) {
      // 损坏兜底：先留一份副本（下一次写盘会覆盖原文件），再按空清单继续。
      try {
        if (!existsSync(`${this.tasksFile}.corrupt`)) copyFileSync(this.tasksFile, `${this.tasksFile}.corrupt`)
      } catch {
        // 备份失败也要继续：能跑起来比留副本重要
      }
      this.lastProblem = `任务文件不是合法 JSON（${errorText(error)}），已备份为 tasks.json.corrupt，本次按空清单处理`
      return { tasks: [], problem: this.lastProblem }
    }
    let list: unknown[] | null = null
    if (Array.isArray(doc)) list = doc as unknown[]
    else if (doc !== null && typeof doc === 'object' && Array.isArray((doc as { tasks?: unknown }).tasks)) {
      list = (doc as { tasks: unknown[] }).tasks
    }
    if (list === null) {
      this.lastProblem = '任务文件结构不认识（既不是数组，也没有 tasks 数组），本次按空清单处理'
      return { tasks: [], problem: this.lastProblem }
    }
    const dropped: string[] = []
    const seen = new Set<string>()
    for (const entry of list) {
      const task = normalizeTask(entry)
      if (task === null) {
        dropped.push(String((entry as { id?: unknown } | null)?.id ?? '（没有 id 的项）'))
        continue
      }
      // 同 id 只留最后一条：手改文件复制粘贴很容易撞 id。
      if (seen.has(task.id)) this.tasks = this.tasks.filter((candidate) => candidate.id !== task.id)
      seen.add(task.id)
      this.tasks.push(this.trimHistory(task))
    }
    if (dropped.length > 0) {
      this.lastProblem = `跳过了 ${dropped.length} 条认不出来的任务：${dropped.slice(0, 3).join('、')}${dropped.length > 3 ? ' …' : ''}`
    }
    return { tasks: this.list(), problem: this.lastProblem }
  }

  /** 重新读盘（tick 前调用：别的进程刚写的改动要能看见）。 */
  reload(): ScheduleLoadResult {
    return this.load()
  }

  /** 当前清单（复制出来的，改它不影响 store）。 */
  list(): ScheduleTask[] {
    return this.tasks.map(cloneTask)
  }

  get(id: string): ScheduleTask | undefined {
    const found = this.tasks.find((task) => task.id === id)
    return found === undefined ? undefined : cloneTask(found)
  }

  /** 按 id 前缀找一条（命令里打 `a1b2` 比打全 id 顺手）；命中多条返回 `ambiguous`。 */
  findByPrefix(prefix: string): { ok: true; task: ScheduleTask } | { ok: false; error: string } {
    const key = prefix.trim()
    if (key === '') return { ok: false, error: '要给的：任务 id 或它的前缀' }
    const exact = this.tasks.find((task) => task.id === key)
    if (exact !== undefined) return { ok: true, task: cloneTask(exact) }
    const hits = this.tasks.filter((task) => task.id.startsWith(key) || task.title === key)
    if (hits.length === 0) return { ok: false, error: `没有匹配「${key}」的任务（用 /schedule list 看 id）` }
    if (hits.length > 1) return { ok: false, error: `「${key}」匹配到 ${hits.length} 条任务，请多给几位 id` }
    return { ok: true, task: cloneTask(hits[0]!) }
  }

  /** 新建一条任务并落盘。 */
  create(input: ScheduleTaskInput): Promise<ScheduleTask> {
    return this.enqueue(() => {
      const now = this.clock()
      const task: ScheduleTask = {
        id: newTaskId(),
        title: input.title.trim(),
        prompt: input.prompt,
        rule: input.rule,
        timeZone: input.timeZone,
        enabled: input.enabled !== false,
        // 排期由 runner 按规则算；这里先留 null，第一次 tick 会补上。
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: 'never',
        lastError: null,
        failureStreak: 0,
        pendingSlot: null,
        createdBy: input.createdBy ?? 'user',
        deliveryHistory: [],
        sessionId: input.sessionId ?? '',
        createdAt: now,
        updatedAt: now,
      }
      this.tasks.push(task)
      this.persist()
      return cloneTask(task)
    })
  }

  /** 改一条任务（标题 / 描述 / 规则 / 时区 / 启停）；改了规则或时区就把排期清空让 runner 重算。 */
  update(id: string, patch: ScheduleTaskPatch): Promise<ScheduleTask | null> {
    return this.enqueue(() => {
      const index = this.tasks.findIndex((task) => task.id === id)
      if (index < 0) return null
      const current = this.tasks[index]!
      const next: ScheduleTask = { ...current, updatedAt: this.clock() }
      if (patch.title !== undefined) next.title = patch.title.trim()
      if (patch.prompt !== undefined) next.prompt = patch.prompt
      if (patch.timeZone !== undefined) next.timeZone = patch.timeZone
      if (patch.enabled !== undefined) next.enabled = patch.enabled
      if (patch.rule !== undefined) {
        next.rule = patch.rule
        next.nextRunAt = null
        next.pendingSlot = null
      }
      if (patch.timeZone !== undefined && patch.rule === undefined) {
        next.nextRunAt = null
        next.pendingSlot = null
      }
      this.tasks[index] = next
      this.persist()
      return cloneTask(next)
    })
  }

  /** 删一条任务；返回是否真的删掉了。 */
  remove(id: string): Promise<boolean> {
    return this.enqueue(() => {
      const before = this.tasks.length
      this.tasks = this.tasks.filter((task) => task.id !== id)
      if (this.tasks.length === before) return false
      this.persist()
      return true
    })
  }

  /**
   * 至多一次的第一步：把 `nextRunAt` 推到 `next`（null = 到此为止）、记下 `pendingSlot`，落盘。
   * 这一步落盘之后才允许投递——崩在投递中途也不会在重启后重投（靠 pendingSlot 补一次）。
   */
  beginSlot(id: string, slot: number, next: number | null): Promise<ScheduleTask | null> {
    return this.enqueue(() => {
      const index = this.tasks.findIndex((task) => task.id === id)
      if (index < 0) return null
      const now = this.clock()
      const next2: ScheduleTask = {
        ...this.tasks[index]!,
        nextRunAt: next,
        pendingSlot: slot,
        lastRunAt: slot,
        lastStatus: 'running',
        updatedAt: now,
      }
      this.tasks[index] = next2
      this.persist()
      return cloneTask(next2)
    })
  }

  /** 投递结束（成功、定性失败、被跳过都算）后清 `pendingSlot` 并记账。 */
  endSlot(id: string, outcome: SlotOutcome): Promise<ScheduleTask | null> {
    return this.enqueue(() => {
      const index = this.tasks.findIndex((task) => task.id === id)
      if (index < 0) return null
      const current = this.tasks[index]!
      const now = this.clock()
      const streak =
        outcome.failureStreak ??
        (outcome.status === 'failed' ? current.failureStreak + 1 : outcome.status === 'ok' ? 0 : current.failureStreak)
      const next: ScheduleTask = {
        ...current,
        pendingSlot: null,
        lastStatus: outcome.status,
        lastError: outcome.error === undefined || outcome.error === null || outcome.error === '' ? null : outcome.error,
        failureStreak: streak,
        updatedAt: now,
      }
      if (outcome.nextRunAt !== undefined) next.nextRunAt = outcome.nextRunAt
      if (outcome.delivered === true) next.deliveryHistory = this.appendHistory(current.deliveryHistory, now)
      this.tasks[index] = this.trimHistory(next)
      this.persist()
      return cloneTask(next)
    })
  }

  /** 只改排期（tick 里给没到点的任务补算 nextRunAt 用）。 */
  setNextRunAt(id: string, next: number | null): Promise<ScheduleTask | null> {
    return this.enqueue(() => {
      const index = this.tasks.findIndex((task) => task.id === id)
      if (index < 0) return null
      const next2: ScheduleTask = { ...this.tasks[index]!, nextRunAt: next, updatedAt: this.clock() }
      this.tasks[index] = next2
      this.persist()
      return cloneTask(next2)
    })
  }

  /** 已经推进、还没投递完的任务（进程崩在投递中途的现场）。 */
  pendingTasks(): ScheduleTask[] {
    return this.tasks.filter((task) => task.pendingSlot !== null).map(cloneTask)
  }

  /** 追加一条执行台账；超过上限就裁到最近 runLimit 条。 */
  appendRun(run: ScheduleRun): Promise<void> {
    return this.enqueue(() => {
      this.appendRunSync(run)
    })
  }

  /** 读最近若干条台账（新的在前）。文件不存在或整行坏掉都不抛错。 */
  recentRuns(limit = 20): ScheduleRun[] {
    if (!existsSync(this.runsFile)) return []
    let lines: string[]
    try {
      lines = readFileSync(this.runsFile, 'utf8').split('\n')
    } catch {
      return []
    }
    const out: ScheduleRun[] = []
    for (let index = lines.length - 1; index >= 0 && out.length < limit; index -= 1) {
      const line = lines[index]!.trim()
      if (line === '') continue
      try {
        const parsed = JSON.parse(line) as ScheduleRun
        if (parsed !== null && typeof parsed === 'object') out.push(parsed)
      } catch {
        // 半截行（进程被杀）跳过就行，不值得为它报错
      }
    }
    return out
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /** FIFO：把一次读-改-写挂到链尾。前一个失败不阻塞后一个。 */
  private enqueue<T>(operation: () => T): Promise<T> {
    const run = this.chain.then(operation, operation)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 整份重写 tasks.json（tmp + rename 原子替换）。 */
  private persist(): void {
    mkdirSync(this.dir, { recursive: true })
    const text = `${JSON.stringify({ version: 1, tasks: this.tasks }, null, 2)}\n`
    const tmp = `${this.tasksFile}.${process.pid}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, this.tasksFile)
  }

  private appendRunSync(run: ScheduleRun): void {
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.runsFile, `${JSON.stringify(run)}\n`, 'utf8')
    const lines = this.countRunLines() + 1
    this.runLines = lines
    if (lines > this.runLimit) this.compactRuns()
  }

  /** 数台账行数（数一次记下来；只有本进程会写它，因为有 .lock 互斥）。 */
  private countRunLines(): number {
    if (this.runLines >= 0) return this.runLines
    if (!existsSync(this.runsFile)) {
      this.runLines = 0
      return 0
    }
    try {
      const text = readFileSync(this.runsFile, 'utf8')
      this.runLines = text.split('\n').filter((line) => line.trim() !== '').length
    } catch {
      this.runLines = 0
    }
    return this.runLines
  }

  /** 把台账裁到最近 runLimit 条（同样 tmp + rename）。 */
  private compactRuns(): void {
    let lines: string[] = []
    try {
      lines = readFileSync(this.runsFile, 'utf8').split('\n').filter((line) => line.trim() !== '')
    } catch {
      return
    }
    const kept = lines.slice(Math.max(0, lines.length - this.runLimit))
    const tmp = `${this.runsFile}.${process.pid}.tmp`
    writeFileSync(tmp, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8')
    renameSync(tmp, this.runsFile)
    this.runLines = kept.length
  }

  /** 投递历史：先按 30 天砍，再按 200 条砍。 */
  private appendHistory(history: readonly number[], at: number): number[] {
    const cutoff = at - this.historyWindowMs
    const kept = [...history.filter((entry) => entry >= cutoff), at]
    return kept.slice(Math.max(0, kept.length - this.historyLimit))
  }

  /** 读盘 / 落盘时顺手裁一下历史（老文件里可能积了很多）。 */
  private trimHistory(task: ScheduleTask): ScheduleTask {
    const cutoff = this.clock() - this.historyWindowMs
    const kept = task.deliveryHistory.filter((entry) => entry >= cutoff)
    return { ...task, deliveryHistory: kept.slice(Math.max(0, kept.length - this.historyLimit)) }
  }
}

/** 把 catch 到的东西变成一句话（`useUnknownInCatchVariables` 下不能直接当 Error 用）。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
