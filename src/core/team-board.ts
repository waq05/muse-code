/**
 * 共享任务板与信箱：队友之间协调用的两个明文文件。
 *
 * dsh 把协调状态存在 Lead 的会话日志里（它有会话事件体系）；dsc 没有那套东西，
 * 所以这里直接落两个文件，你能用编辑器双击打开看：
 *
 * - `~/.dsc/team/board.json` —— 任务板：三态 + 单调 revision + CAS 抢单 + 依赖图 +
 *   写作用域告警。写作用域只是提醒，不是锁：两个任务的作用域重叠时照样允许开工，
 *   重叠会被记进 warnings，最后由 Lead 看 diff 裁决。
 * - `~/.dsc/team/inbox/<队友名>.jsonl` —— 传话台账：要给队友的话先追加一条文件，
 *   再交给它的循环。队友正在干活时，这条话排在它当前回合之后被看到。
 *
 * @module dsc/core/team-board
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 团队目录（任务板 + 信箱）。 */
export const TEAM_ROOT = join(homedir(), '.dsc', 'team')
/** 任务板文件。 */
export const BOARD_FILE = join(TEAM_ROOT, 'board.json')
/** 信箱目录（每个队友一个 jsonl）。 */
export const INBOX_DIR = join(TEAM_ROOT, 'inbox')

/** 任务状态机：pending → in_progress → completed，只有三态，没有中间态。 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']

/** 任务板上限，防一个模型一口气写 500 条把文件灌爆。 */
const MAX_TASKS = 256
/** 信箱单条消息长度上限。 */
const MAX_INBOX_CHARS = 8000

export interface TeamTask {
  id: string
  subject: string
  description: string
  status: TaskStatus
  /** 认领它的队友名；null = 没人认领。 */
  owner: string | null
  /** 依赖的任务 id；全部 completed 才算 ready。 */
  blockedBy: string[]
  /** 打算改的路径前缀（只用于重叠告警，不是锁）。 */
  writeScopes: string[]
  createdAt: number
  updatedAt: number
}

export interface TeamBoard {
  version: 1
  /** 每次成功变更 +1；变更方必须报出自己看到的版本，不匹配就拒绝（CAS）。 */
  revision: number
  tasks: TeamTask[]
}

function emptyBoard(): TeamBoard {
  return { version: 1, revision: 0, tasks: [] }
}

/** 读任务板（文件缺失或损坏都退回空板，绝不因为板子坏了起不来）。 */
export function readBoard(): TeamBoard {
  try {
    if (!existsSync(BOARD_FILE)) return emptyBoard()
    const doc = JSON.parse(readFileSync(BOARD_FILE, 'utf8')) as { revision?: unknown; tasks?: unknown }
    const revision = typeof doc.revision === 'number' && doc.revision >= 0 ? Math.floor(doc.revision) : 0
    const rawTasks = Array.isArray(doc.tasks) ? doc.tasks : []
    const tasks: TeamTask[] = []
    for (const raw of rawTasks) {
      if (raw === null || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const id = String(item.id ?? '')
      if (id === '') continue
      const status = STATUSES.includes(item.status as TaskStatus) ? (item.status as TaskStatus) : 'pending'
      tasks.push({
        id,
        subject: String(item.subject ?? ''),
        description: String(item.description ?? ''),
        status,
        owner: typeof item.owner === 'string' && item.owner !== '' ? item.owner : null,
        blockedBy: Array.isArray(item.blockedBy)
          ? [...new Set(item.blockedBy.filter((dep): dep is string => typeof dep === 'string' && dep !== ''))]
          : [],
        writeScopes: Array.isArray(item.writeScopes)
          ? item.writeScopes.filter((scope): scope is string => typeof scope === 'string' && scope !== '')
          : [],
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
      })
    }
    return { version: 1, revision, tasks }
  } catch {
    return emptyBoard()
  }
}

function writeBoard(board: TeamBoard): void {
  mkdirSync(TEAM_ROOT, { recursive: true })
  writeFileSync(BOARD_FILE, `${JSON.stringify(board, null, 2)}\n`, 'utf8')
}

/** 路径前缀规范化：统一成正斜杠、去掉首尾斜杠，空串表示「整个工作目录」。 */
export function normalizeScope(scope: string): string {
  return scope.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '')
}

/**
 * 这些作用域会不会碰到别人正在改的地方。
 * @param excludeId - 跟本任务自己比没有意义，跳过这个 id。
 */
export function scopeWarnings(board: TeamBoard, scopes: readonly string[], excludeId: string): string[] {
  const mine = scopes.map(normalizeScope)
  if (mine.length === 0) return []
  const warnings: string[] = []
  for (const other of board.tasks) {
    if (other.id === excludeId || other.status === 'completed') continue
    for (const raw of other.writeScopes) {
      const theirs = normalizeScope(raw)
      for (const ours of mine) {
        const overlaps = ours === theirs || ours === '' || theirs === '' || ours.startsWith(`${theirs}/`) || theirs.startsWith(`${ours}/`)
        if (overlaps) {
          warnings.push(`${other.id}（${other.owner ?? '未认领'}，${other.status}）的作用域 ${theirs || '<整个工作目录>'} 与本次的 ${ours || '<整个工作目录>'} 重叠`)
        }
      }
    }
  }
  return [...new Set(warnings)]
}

/** 依赖图检查：禁自环、禁指向不存在的任务、禁成环。 */
function assertDependencies(board: TeamBoard, id: string, deps: readonly string[]): void {
  for (const dep of deps) {
    if (dep === id) throw new Error(`任务 ${id} 不能依赖自己`)
    if (!board.tasks.some((task) => task.id === dep)) {
      throw new Error(`依赖的任务 ${dep} 不存在（先 team_task list 确认 id）`)
    }
  }
  // 沿依赖链往下走，回到自己就是环
  const seen = new Set<string>()
  const walk = (at: string): void => {
    if (at === id) throw new Error(`依赖会成环：${id} → … → ${id}`)
    if (seen.has(at)) return
    seen.add(at)
    const task = board.tasks.find((candidate) => candidate.id === at)
    for (const dep of task?.blockedBy ?? []) walk(dep)
  }
  for (const dep of deps) walk(dep)
}

/** 一个任务现在能不能开工（pending 且所有依赖都已 completed）。 */
export function isReady(board: TeamBoard, task: TeamTask): boolean {
  if (task.status !== 'pending' || task.owner !== null) return false
  return task.blockedBy.every((dep) => board.tasks.find((task2) => task2.id === dep)?.status === 'completed')
}

/** 下一个任务 id（t1、t2…单调递增，删过的号不回收）。 */
function nextTaskId(board: TeamBoard): string {
  let max = 0
  for (const task of board.tasks) {
    const digits = Number.parseInt(task.id.replace(/^t/i, ''), 10)
    if (Number.isFinite(digits) && digits > max) max = digits
  }
  return `t${max + 1}`
}

/** 新建任务（不需要 CAS：新增不会覆盖别人的改动）。带上写回后的板，紧接着要认领它才不用再读一遍。 */
export function boardCreate(input: {
  subject: string
  description?: string
  owner?: string
  blockedBy?: readonly string[]
  writeScopes?: readonly string[]
}): { task: TeamTask; warnings: string[]; board: TeamBoard } {
  const board = readBoard()
  if (board.tasks.length >= MAX_TASKS) {
    throw new Error(`任务板已有 ${board.tasks.length} 条，达到上限 ${MAX_TASKS}；先清掉已完成的任务`)
  }
  const subject = input.subject.replace(/\s+/g, ' ').trim()
  if (subject === '') throw new Error('任务标题不能为空')
  const now = Date.now()
  const task: TeamTask = {
    id: nextTaskId(board),
    subject: subject.slice(0, 120),
    description: (input.description ?? '').trim().slice(0, 2000),
    status: 'pending',
    owner: input.owner !== undefined && input.owner !== '' ? input.owner : null,
    blockedBy: [...new Set(input.blockedBy ?? [])].filter((dep) => dep !== ''),
    writeScopes: [...new Set((input.writeScopes ?? []).map(normalizeScope))].filter((scope) => scope !== ''),
    createdAt: now,
    updatedAt: now,
  }
  assertDependencies(board, task.id, task.blockedBy)
  const warnings = scopeWarnings(board, task.writeScopes, task.id)
  board.tasks.push(task)
  board.revision += 1
  writeBoard(board)
  return { task, warnings, board }
}

/** 任务板变更动作。 */
export type BoardAction = 'claim' | 'release' | 'complete' | 'reopen' | 'set_dependencies' | 'delete'

/**
 * 改一条任务。调用方必须带上自己看到的 board revision，
 * 不匹配就抛错——两个队友同时抢同一个任务是常态，先到先得靠的就是这一条。
 * @param payload.owner - claim 时填认领者名字。
 * @param payload.blockedBy - set_dependencies 时填新的依赖清单。
 */
export function boardUpdate(
  id: string,
  expectedRevision: number,
  action: BoardAction,
  payload?: { owner?: string; blockedBy?: readonly string[] },
): { board: TeamBoard; task: TeamTask } {
  const board = readBoard()
  if (expectedRevision !== board.revision) {
    throw new Error(
      `任务板在你读它之后被别人改过了（你报的是第 ${expectedRevision} 版，现在第 ${board.revision} 版）。先 team_task list 再决定`,
    )
  }
  const index = board.tasks.findIndex((task) => task.id === id)
  if (index < 0) throw new Error(`任务板上没有 ${id}`)
  const task = { ...board.tasks[index]! }

  switch (action) {
    case 'claim': {
      const owner = (payload?.owner ?? '').trim()
      if (owner === '') throw new Error('claim 要带上认领人（队友名）')
      if (task.status === 'completed') throw new Error(`${id} 已经完成了，不用再认领`)
      if (task.owner !== null && task.owner !== owner) {
        throw new Error(`${id} 已经被 ${task.owner} 认领了，换一个任务或先 team_task list`)
      }
      const pendingDeps = task.blockedBy.filter(
        (dep) => board.tasks.find((candidate) => candidate.id === dep)?.status !== 'completed',
      )
      if (pendingDeps.length > 0) {
        throw new Error(`${id} 还在等这些依赖完成：${pendingDeps.join('、')}`)
      }
      task.owner = owner
      task.status = 'in_progress'
      break
    }
    case 'release':
      if (task.status === 'completed') throw new Error(`${id} 已经完成了，release 没有意义`)
      task.owner = null
      task.status = 'pending'
      break
    case 'complete':
      if (task.status === 'pending') throw new Error(`${id} 还没人认领，先 claim 再 complete`)
      task.status = 'completed'
      break
    case 'reopen':
      task.status = 'pending'
      task.owner = null
      break
    case 'set_dependencies': {
      const deps = [...new Set(payload?.blockedBy ?? [])].filter((dep) => dep !== '')
      assertDependencies(board, id, deps)
      task.blockedBy = deps
      break
    }
    case 'delete': {
      const dependents = board.tasks.filter((candidate) => candidate.id !== id && candidate.blockedBy.includes(id))
      if (dependents.length > 0) {
        throw new Error(`${dependents.map((entry) => entry.id).join('、')} 还依赖 ${id}，先改掉它们的依赖`)
      }
      board.tasks.splice(index, 1)
      board.revision += 1
      writeBoard(board)
      return { board, task }
    }
    default:
      throw new Error(`未知动作 ${action satisfies never}`)
  }

  task.updatedAt = Date.now()
  board.tasks[index] = task
  board.revision += 1
  writeBoard(board)
  return { board, task }
}

/** 把任务板清空（设置页「清空任务板」按钮用；不动队友的运行记录）。 */
export function resetBoard(): number {
  const board = readBoard()
  const count = board.tasks.length
  board.tasks = []
  board.revision += 1
  writeBoard(board)
  return count
}

/** 一个队友的信箱文件路径。 */
function inboxFile(teammate: string): string {
  return join(INBOX_DIR, `${teammate.replace(/[^\w-]/g, '_')}.jsonl`)
}

/**
 * 往传话台账追加一条（调用方负责紧接着把它投给那个队友的循环）。
 * @throws 内容为空，或超过单条长度上限时抛错。
 */
export function inboxAppend(teammate: string, text: string): void {
  const body = text.trim()
  if (body === '') throw new Error('要传的话不能是空的')
  if (body.length > MAX_INBOX_CHARS) throw new Error(`一条消息最长 ${MAX_INBOX_CHARS} 字，这条有 ${body.length} 字`)
  mkdirSync(INBOX_DIR, { recursive: true })
  appendFileSync(inboxFile(teammate), `${JSON.stringify({ at: Date.now(), text: body })}\n`, 'utf8')
}

/** 读一个队友信箱里的全部消息（按写入顺序）。 */
export function inboxRead(teammate: string): string[] {
  try {
    if (!existsSync(inboxFile(teammate))) return []
    return readFileSync(inboxFile(teammate), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .map((line) => {
        try {
          return String((JSON.parse(line) as { text?: string }).text ?? '')
        } catch {
          return line
        }
      })
      .filter((text) => text !== '')
  } catch {
    return []
  }
}

/** 列出现有信箱（队友名 → 消息条数），设置页展示用。 */
export function inboxSummary(): Record<string, number> {
  const out: Record<string, number> = {}
  try {
    if (!existsSync(INBOX_DIR)) return out
    for (const entry of readdirSync(INBOX_DIR)) {
      if (!entry.endsWith('.jsonl')) continue
      out[entry.replace(/\.jsonl$/, '')] = inboxRead(entry.replace(/\.jsonl$/, '')).length
    }
  } catch {
    // 目录读不到就交空表，不因为展示而失败
  }
  return out
}
