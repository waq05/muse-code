/**
 * 学习候选清单存储：`~/.dsc/learnings/<workspaceKey>/candidates.jsonl`。
 *
 * 为什么单独放一层：L1 的「纠正捕获」是零模型调用的动作，它记下来的东西**绝不进系统提示**
 * ——这是关键安全属性，被纠正的内容里可能夹着用户贴进来的外部文本，直接注入等于给外部
 * 文本开了一条进提示词的路。所以候选清单只是一份带状态的台账，
 * 只有用户显式 `/learnings promote <id>` 才可能变成记忆条目或技能草稿。
 *
 * 为什么用 jsonl 而不是一份整 JSON：状态迁移（candidate → promoted / dropped）写成追加一行，
 * 读取时按 id「最后一条生效」。整份仍然一律 tmp + rename 落盘，所以崩在中间不会留半行；
 * 坏行在读取时跳过，不因为一行坏了就把整份清单读废（用户的台账比行格式的洁癖重要）。
 *
 * 会话记录里那一格自己的状态（`learnings`：已复盘的轮次、本会话读过/建过的技能、「本轮由插件
 * 自己发起」的标记）由 `core/session.ts` 的 {@link SessionStateMap} 声明成 `unknown`——
 * core 层不该认识插件层的类型，依赖方向反过来就成环。所以这里**不做声明合并**：
 * 写回去的是 {@link LearningsState}，读回来一律过 {@link normalizeLearningsState} 收口，
 * 两边在类型上各自独立，改这一格不必动内核。
 *
 * @module dsc/core/learnings/store
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { dscPath } from '../path-policy.js'

/** 一条候选是从哪条闭环来的。 */
export type LearningKind = 'correction' | 'failure' | 'note' | 'skill-draft'

/** 候选的生命周期：只有用户显式 promote / drop 才会离开 candidate。 */
export type LearningState = 'candidate' | 'promoted' | 'dropped'

/** 候选清单里的一行（与插件文档里定的形状逐字段一致）。 */
export interface LearningCandidate {
  id: string
  ts: number
  kind: LearningKind
  /** 正文。`skill-draft` 这一种放的是技能草稿的 JSON 一行。 */
  text: string
  /** 这条候选来自哪一轮（会话 id 前 8 位 + 第几条用户消息）。 */
  turnRef: string
  /** 同一句话被重复捕获几次（去重时累加，说明这个纠正反复出现）。 */
  hits: number
  state: LearningState
}

/** 保留策略（设置分区里可调）。 */
export interface LearningStoreOptions {
  /** 保留天数：超过就裁掉。 */
  retentionDays: number
  /** 条数上限：超了先裁最老的。 */
  maxEntries: number
}

export const DEFAULT_STORE_OPTIONS: LearningStoreOptions = { retentionDays: 30, maxEntries: 200 }

/** 会话状态里 `learnings` 那一格的形状。 */
export interface LearningsState {
  /** 已经复盘过的用户轮次序号（0 起算），重启后读回来，同一轮不重复复盘。 */
  lastReviewedTurn: number
  /** 本轮是由插件自己发起的（L2 复盘轮、定时任务投递）：这种轮次里的写入一律拒。 */
  pluginInitiated: boolean
  /** 本会话用 `skill` 工具读过的技能名（read-before-write 的记账）。 */
  readSkills: string[]
  /** 本会话由本插件刚创建出来的技能名（刚建的算已读）。 */
  createdSkills: string[]
}

export const EMPTY_LEARNINGS_STATE: LearningsState = {
  lastReviewedTurn: -1,
  pluginInitiated: false,
  readSkills: [],
  createdSkills: [],
}

/** 从会话记录里读回来的负载可能是手改过的或老版本写的，这里挑出认识的字段。 */
export function normalizeLearningsState(raw: unknown): LearningsState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_LEARNINGS_STATE }
  const doc = raw as Record<string, unknown>
  const turn = Number(doc.lastReviewedTurn)
  const names = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
  return {
    lastReviewedTurn: Number.isFinite(turn) ? Math.trunc(turn) : -1,
    pluginInitiated: doc.pluginInitiated === true,
    readSkills: names(doc.readSkills),
    createdSkills: names(doc.createdSkills),
  }
}

/** 候选目录根（`~/.dsc/learnings`）。 */
export function learningsRoot(): string {
  return dscPath('learnings')
}

/**
 * 把工作目录折成一个安全的目录名：可读前缀 + 规范化路径的短哈希。
 *
 * 为什么要哈希：路径里的中文、冒号、空格在 Windows 上都能当目录名，但换到别的机器或
 * 备份工具上就会出乱子；同一目录不同写法（`D:\a\b` 与 `D:/a/b/`）还必须折成同一个键，
 * 所以先 `resolve` 再小写，最后拿哈希兜住「两个不同路径压出同一个前缀」这种撞车。
 */
export function workspaceKeyOf(cwd: string): string {
  const full = resolve(cwd)
  const slug = full
    .replace(/[:\\/_\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 24)
  const stamp = createHash('sha1').update(full.toLowerCase()).digest('hex').slice(0, 8)
  return `${slug === '' ? 'root' : slug}-${stamp}`
}

/** 某个工作目录的候选目录。 */
export function workspaceDir(cwd: string): string {
  return join(learningsRoot(), workspaceKeyOf(cwd))
}

/** 某个工作目录的候选清单文件。 */
export function candidatesFile(cwd: string): string {
  return join(workspaceDir(cwd), 'candidates.jsonl')
}

/** 一行是不是一条合法候选（坏行、手改坏的都在这拦掉）。 */
function parseCandidate(line: string): LearningCandidate | null {
  let doc: unknown
  try {
    doc = JSON.parse(line)
  } catch {
    return null
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
  const raw = doc as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : ''
  const text = typeof raw.text === 'string' ? raw.text : ''
  const kind = raw.kind
  const state = raw.state
  if (id === '' || text === '') return null
  if (kind !== 'correction' && kind !== 'failure' && kind !== 'note' && kind !== 'skill-draft') return null
  if (state !== 'candidate' && state !== 'promoted' && state !== 'dropped') return null
  const ts = Number(raw.ts)
  const hits = Number(raw.hits)
  return {
    id,
    ts: Number.isFinite(ts) ? Math.trunc(ts) : 0,
    kind,
    text,
    turnRef: typeof raw.turnRef === 'string' ? raw.turnRef : '',
    hits: Number.isFinite(hits) && hits >= 0 ? Math.trunc(hits) : 0,
    state,
  }
}

/** 读候选清单：坏行跳过，同一个 id 以最后一行生效（状态迁移就是靠追加实现的）。 */
export function readCandidates(cwd: string): LearningCandidate[] {
  const file = candidatesFile(cwd)
  if (!existsSync(file)) return []
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const byId = new Map<string, LearningCandidate>()
  const order: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const parsed = parseCandidate(line)
    if (parsed === null) continue
    if (!byId.has(parsed.id)) order.push(parsed.id)
    byId.set(parsed.id, parsed)
  }
  return order.map((id) => byId.get(id)).filter((item): item is LearningCandidate => item !== undefined)
}

/** 原子追加若干行：整份读出来 + 追加 + 写临时文件 + rename，不产生半行。 */
function appendLines(cwd: string, records: readonly LearningCandidate[]): void {
  const dir = workspaceDir(cwd)
  const file = candidatesFile(cwd)
  mkdirSync(dir, { recursive: true })
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const head = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
  const body = records.map((record) => `${JSON.stringify(record)}\n`).join('')
  const tmp = `${file}.tmp`
  writeFileSync(tmp, head + body, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    // rename 不成就把临时文件收拾掉，别在用户目录里留垃圾
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件本来就没了：忽略
    }
    throw error
  }
}

/** 裁剪结果（`removed` 是裁掉的条数）。 */
export interface PruneResult {
  removed: number
  kept: number
}

function optionsOf(options?: Partial<LearningStoreOptions>): LearningStoreOptions {
  const days = Number(options?.retentionDays ?? DEFAULT_STORE_OPTIONS.retentionDays)
  const max = Number(options?.maxEntries ?? DEFAULT_STORE_OPTIONS.maxEntries)
  return {
    // 0 天保留等于「记完就扔」，没有意义；上限至少留 1 条
    retentionDays: Number.isFinite(days) ? Math.max(1, Math.trunc(days)) : DEFAULT_STORE_OPTIONS.retentionDays,
    maxEntries: Number.isFinite(max) ? Math.max(1, Math.trunc(max)) : DEFAULT_STORE_OPTIONS.maxEntries,
  }
}

/**
 * 一次裁剪：先按保留天数裁过期的，再按条数上限裁最老的。
 *
 * 命令与自检都要一个「裁剪后清单」的返回值，所以这里顺带把结果读回来，省一次读盘。
 */
export function pruneCandidates(
  cwd: string,
  options?: Partial<LearningStoreOptions>,
  now = Date.now(),
): { result: PruneResult; candidates: LearningCandidate[] } {
  const opts = optionsOf(options)
  const all = readCandidates(cwd)
  const deadline = now - opts.retentionDays * 24 * 60 * 60 * 1000
  let kept = all.filter((item) => item.ts >= deadline)
  if (kept.length > opts.maxEntries) {
    // 新的在前；同一毫秒按 id 稳定排序，免得两次裁剪结果不一样
    const sorted = [...kept].sort((a, b) => (b.ts === a.ts ? a.id.localeCompare(b.id) : b.ts - a.ts))
    kept = sorted.slice(0, opts.maxEntries)
  }
  const removed = all.length - kept.length
  if (removed > 0) writeAll(cwd, kept)
  return { result: { removed, kept: kept.length }, candidates: kept }
}

/** 整份覆盖写（裁剪用）：仍然 tmp + rename。 */
function writeAll(cwd: string, records: readonly LearningCandidate[]): void {
  const file = candidatesFile(cwd)
  mkdirSync(workspaceDir(cwd), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 同上：临时文件已经不在了
    }
    throw error
  }
}

/** 新候选的入参。 */
export interface CandidateInput {
  kind: LearningKind
  text: string
  turnRef: string
}

/** 记一条候选的结果。 */
export interface RecordResult {
  /** 记下来的那条（命中去重时是 hits+1 之后的状态）。 */
  candidate: LearningCandidate | null
  /** true = 同样内容已经在了，只把 hits 加了一。 */
  deduped: boolean
  /** 空内容这类不入账的情况，这里说明原因。 */
  error: string
}

/** 新的短 id：8 位十六进制，够 `/learnings promote <id>` 手打，也不至于跟已有的撞。 */
function newId(existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomUUID().replace(/-/g, '').slice(0, 8)
    if (!existing.has(id)) return id
  }
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/**
 * 记一条候选。
 *
 * 去重按「同 kind + 同正文」算：用户连着两轮说同一句「不对，用 pnpm 不是 npm」，
 * 该看到的是 hits 从 1 变 2（说明这条纠正戳得深），而不是两条一模一样的候选。
 * 命中去重时只把 hits 加一，不重排时间戳，免得一条老候选因为复现就永远不过期。
 */
export function recordCandidate(
  cwd: string,
  input: CandidateInput,
  options?: Partial<LearningStoreOptions>,
  now = Date.now(),
): RecordResult {
  const text = input.text.replace(/\s+/g, ' ').trim()
  if (text === '') return { candidate: null, deduped: false, error: '候选正文是空的，没什么可记' }
  const clipped = text.length > 2000 ? `${text.slice(0, 2000)}…` : text
  const candidates = readCandidates(cwd)
  const existing = candidates.find((item) => item.kind === input.kind && item.text === clipped && item.state === 'candidate')
  if (existing !== undefined) {
    const bumped: LearningCandidate = { ...existing, hits: existing.hits + 1 }
    appendLines(cwd, [bumped])
    return { candidate: bumped, deduped: true, error: '' }
  }
  const candidate: LearningCandidate = {
    id: newId(new Set(candidates.map((item) => item.id))),
    ts: now,
    kind: input.kind,
    text: clipped,
    turnRef: input.turnRef,
    hits: 0,
    state: 'candidate',
  }
  appendLines(cwd, [candidate])
  pruneCandidates(cwd, options, now)
  return { candidate, deduped: false, error: '' }
}

/** 状态迁移的结果。 */
export interface StateResult {
  ok: boolean
  error: string
  candidate: LearningCandidate | null
}

/** 改一条候选的状态（promote / drop 都走这里，写的是追加一行）。 */
export function setCandidateState(cwd: string, id: string, state: LearningState): StateResult {
  const candidates = readCandidates(cwd)
  const found = candidates.find((item) => item.id === id)
  if (found === undefined) return { ok: false, error: `没有 id 为 ${id} 的候选（/learnings list 看清单）`, candidate: null }
  if (found.state === state) return { ok: true, error: '', candidate: found }
  const next: LearningCandidate = { ...found, state }
  appendLines(cwd, [next])
  return { ok: true, error: '', candidate: next }
}

/** 候选清单在会话里的显示文案（命令与工具共用，两处不会写岔）。 */
export function formatCandidate(candidate: LearningCandidate, index?: number): string {
  const head = candidate.text.replace(/\s+/g, ' ').slice(0, 58)
  const more = candidate.text.length > 58 ? '…' : ''
  const serial = index === undefined ? '' : `#${String(index + 1).padStart(2, '0')} `
  return `${serial}[${candidate.id}] ${candidate.kind} · ${candidate.state} · 命中${String(candidate.hits)} · ${head}${more}`
}
