/**
 * 长期记忆存储：三格 Markdown 清单，写进磁盘，跨会话留下来。
 *
 * 布局（全部在 `~/.dsc/memory/` 下面）：
 *   global/MEMORY.md            跨项目都成立的事实（2200 字上限）
 *   global/USER.md              用户本人的偏好与习惯（1375 字上限）
 *   workspaces/<键>/MEMORY.md   只属于这个仓库的事实（2200 字上限）
 *
 * 一格就是一个文件，里面用单独一行的 `§` 隔开条目。为什么不用 JSON：用户会直接用
 * 编辑器改这些文件，纯文本改起来没有心智负担，模型也读得懂。
 *
 * 三条要紧的规矩（照 Hermes 的 `tools/memory_tool_store.py` 来，那套跑了很久）：
 *   1. 字数上限连分隔符一起算。超了就整次写入拒绝，并把当前条目回吐出去——不是悄悄截断。
 *      截断会让模型以为写进去了，下次读出来又是另一份，越改越乱。
 *   2. 一批 operations 要么全落盘要么全不落，额度只按最终状态算一次。
 *   3. 磁盘上的文件被外面改过（不是我们上次写的那份）时，先把现状备份成
 *      `.bak.<秒级时间戳>` 再拒绝这次写入。用户的编辑永远优先，工具不许闷头盖。
 *
 * @module dsc/core/memory
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { dscPath } from './path-policy.js'

/** 记忆分格。`global` 是跨项目的事实，`user` 是用户本人，`workspace` 只属于当前仓库。 */
export type MemoryTarget = 'global' | 'user' | 'workspace'

export const MEMORY_TARGETS: readonly MemoryTarget[] = ['global', 'user', 'workspace']

/** 分区中文名（错误信息与界面都用它，两处不会写岔）。 */
export const TARGET_LABELS: Record<MemoryTarget, string> = {
  global: '全局事实',
  user: '用户偏好',
  workspace: '本工作区',
}

/** 条目之间的分隔符：换行、`§`、换行。 */
export const ENTRY_DELIMITER = '\n§\n'

/** 各格的缺省字数上限（含分隔符），跟 Hermes 的默认值一致。 */
export const MEMORY_LIMIT_DEFAULTS: Record<MemoryTarget, number> = {
  global: 2200,
  user: 1375,
  workspace: 2200,
}

/** 一条写入操作。`replace` 与 `remove` 靠 `oldText` 定位条目。 */
export interface MemoryOperation {
  action: 'add' | 'replace' | 'remove'
  target: MemoryTarget
  /** `add` / `replace` 的新内容。 */
  content?: string
  /** `replace` / `remove` 要动的条目里的片段（只允许唯一匹配）。 */
  oldText?: string
}

/** 一格现在的样子。 */
export interface MemoryCell {
  target: MemoryTarget
  filePath: string
  /** 磁盘上已有的条目（原样，没过安检）。 */
  entries: string[]
  /** 已用字数（连分隔符一起算）。 */
  used: number
  /** 这一格的字数上限。 */
  limit: number
  /** 文件还不存在（第一次写入时才创建）。 */
  missing: boolean
  /** 读这份文件时发现的毛病（比如被外面改过，已备份）。 */
  problem: string
}

/** 长期记忆的全部可调值（插件配置 `memory` 那一节读出来的形状）。 */
export interface MemoryConfig {
  /** 总开关：关掉之后既不注入也不许写，文件原样留在盘上。 */
  enabled: boolean
  /** `user` 这一格参不参与（关掉等于不认识用户偏好）。 */
  userProfile: boolean
  /** `workspace` 这一格参不参与。 */
  workspace: boolean
  /** 三格各自的中文字数上限（含 `§` 分隔符）。 */
  limits: Record<MemoryTarget, number>
  /** 每次写入都要用户点头（默认关：点头点到模型懒得记，记忆就废了）。 */
  writeApproval: boolean
  /** 每隔多少轮用户发言做一次无人值守复盘。0 = 不做。 */
  reviewEveryTurns: number
  /** 复盘开关。 */
  reviewEnabled: boolean
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  userProfile: true,
  workspace: true,
  limits: { ...MEMORY_LIMIT_DEFAULTS },
  writeApproval: false,
  reviewEveryTurns: 10,
  reviewEnabled: true,
}

/** 一批操作的结果。 */export interface MemoryWriteResult {
  ok: boolean
  /** 失败原因（给人看的话）。 */
  error: string
  /** 每条操作各自的结果说明，长度与入参一致；失败时是空数组。 */
  notes: string[]
  /** 涉及的格子现在的样子（失败时也回吐，让模型当场看到该合并什么）。 */
  cells: MemoryCell[]
}

/** 记忆目录根（`~/.dsc/memory`）。 */
export function memoryRoot(): string {
  return dscPath('memory')
}

/** 把工作目录折成一个能当目录名的键：`D:\dsc` → `d-dsc`；过长的补一段哈希。 */
export function workspaceKey(cwd: string): string {
  const full = resolve(cwd)
  const flat = full
    .replace(/[:\\/_\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  if (flat.length <= 48) return flat === '' ? 'root' : flat
  return `${flat.slice(0, 48)}-${createHash('sha1').update(full.toLowerCase()).digest('hex').slice(0, 8)}`
}

/** 某一格对应的文件路径。 */
export function memoryFileOf(target: MemoryTarget, cwd: string): string {
  if (target === 'user') return join(memoryRoot(), 'global', 'USER.md')
  if (target === 'global') return join(memoryRoot(), 'global', 'MEMORY.md')
  return join(memoryRoot(), 'workspaces', workspaceKey(cwd), 'MEMORY.md')
}

/** 把文件正文折成条目：按分隔符切、去空、去掉每条首尾空白。 */
export function splitEntries(text: string): string[] {
  return text
    .split(/\n?§\n?/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** 把条目拼回文件正文（结尾留一个换行，编辑器里不难看）。 */
export function joinEntries(entries: readonly string[]): string {
  if (entries.length === 0) return ''
  return entries.join(ENTRY_DELIMITER) + '\n'
}

/** 连分隔符一起算的字数。 */
export function usedChars(entries: readonly string[]): number {
  if (entries.length === 0) return 0
  return entries.reduce((sum, entry) => sum + entry.length, 0) + ENTRY_DELIMITER.length * (entries.length - 1)
}

/** 我们上次读过或写过的内容指纹，用来发现「外面改过了」。键是文件路径。 */
const lastKnown = new Map<string, string>()

/** 文件不存在时的指纹，用来跟「存在但内容为空」区分开。 */
const MISSING = ' missing'

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 读一格。
 *
 * 外部改动在这里发现：磁盘指纹跟我们上次写进去（或上次读到）的不一样，就把现状复制一份
 * 备份，并在 `problem` 里说清楚。本次读取照常返回，要不要写由于调用方决定。
 *
 * @param target - 哪一格。
 * @param cwd - 当前会话的工作目录（决定 workspace 那一格）。
 * @param limits - 各格上限（设置里可改）。
 */
export function readCell(
  target: MemoryTarget,
  cwd: string,
  limits: Record<MemoryTarget, number> = MEMORY_LIMIT_DEFAULTS,
): MemoryCell {
  const filePath = memoryFileOf(target, cwd)
  const limit = Math.max(20, Math.floor(limits[target] ?? MEMORY_LIMIT_DEFAULTS[target]))
  let text = ''
  let missing = false
  try {
    if (!existsSync(filePath)) missing = true
    else text = readFileSync(filePath, 'utf8')
  } catch (error) {
    return {
      target,
      filePath,
      entries: [],
      used: 0,
      limit,
      missing: true,
      problem: `这份记忆文件读不出来：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const disk = missing ? MISSING : fingerprint(text)
  const known = lastKnown.get(filePath)
  let problem = ''
  if (known !== undefined && known !== disk) {
    const backup = backupFile(filePath, text)
    problem =
      known === MISSING
        ? `${TARGET_LABELS[target]}那格记忆文件被外面新建了${backup === '' ? '' : `，我们把它原样留了一份副本 ${backup}`}，这一轮先只读不写`
        : `${TARGET_LABELS[target]}那格记忆文件被外面改动过${backup === '' ? '' : `，改动后的内容留了一份副本 ${backup}`}，这一轮先只读不写`
    // 外面这份内容我们现在认了：下一轮以它为基准，不然每次读都报一遍
    lastKnown.set(filePath, disk)
  } else if (known === undefined) {
    lastKnown.set(filePath, disk)
  }
  const entries = splitEntries(text)
  return { target, filePath, entries, used: usedChars(entries), limit, missing, problem }
}

/** 读三格（快照与界面用）。`enabled` 决定哪几格参与。 */
export function readAllCells(
  cwd: string,
  limits: Record<MemoryTarget, number> = MEMORY_LIMIT_DEFAULTS,
  enabled: Record<MemoryTarget, boolean> = { global: true, user: true, workspace: true },
): MemoryCell[] {
  return MEMORY_TARGETS.filter((target) => enabled[target]).map((target) => readCell(target, cwd, limits))
}

/**
 * 把磁盘现状复制一份，返回副本文件名。
 *
 * 只复制不搬走：用户正在编辑的那个文件必须留在原地，工具没有资格替他把文件挪掉。
 *
 * @param filePath - 要留副本的文件。
 * @param text - 调用方已经读到的内容；文件读不出来时用它当副本内容。
 */
function backupFile(filePath: string, text: string): string {
  const backup = `${filePath}.bak.${String(Math.floor(Date.now() / 1000))}`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    if (existsSync(filePath)) copyFileSync(filePath, backup)
    else writeFileSync(backup, text, 'utf8')
    return basename(backup)
  } catch {
    // 留不下副本也得继续往下走：副本是保险，不是这条规矩的全部
    return ''
  }
}

// ── 写入前的安检 ───────────────────────────────────────────────────────────────

/** 不可见字符（零宽空格、方向控制符、BOM 这类）。全用转义写：源码里不该出现看不见的内容。 */
const INVISIBLE = new RegExp('[\\u00AD\\u200B-\\u200F\\u2028\\u2029\\u2060-\\u2064\\uFEFF]', 'gu')

interface ThreatRule {
  /** 给人说的中文，会原样回给模型。 */
  label: string
  pattern: RegExp
}

/**
 * 写进长期记忆的内容，下次会话会被当成事实重新喂给模型，所以这里要拦的不是脏话，
 * 而是「一条能让下一次的我去做不该做的事」的载体。对照 Hermes 的 `tools/threat_patterns.py`。
 */
const THREAT_RULES: readonly ThreatRule[] = [
  { label: '藏着不可见字符（零宽空格、方向控制符这类）', pattern: INVISIBLE },
  {
    label: '叫模型别把看到的东西告诉用户',
    pattern: /(不要|别)(告诉|提醒|通知|提及)[^。\n]{0,8}(用户|使用者)|do\s+not\s+(?:tell|inform|mention)[\s,]+(?:the\s+)?user/iu,
  },
  {
    label: '叫模型忽略它自己收到的指令',
    pattern:
      /(忽略|无视|忘掉)[^。\n]{0,10}(指令|规则|约束|限制|系统提示)|ignore\s+(?:all\s+|the\s+)?(?:previous|prior|above|system)\s+(?:instruction|rule|prompt)/iu,
  },
  { label: '要批量删文件或整棵树', pattern: /rm\s+-[a-z]*rf|del\s+\/[sq]|Remove-Item[^\n]{0,40}-Recurse[^\n]{0,20}-Force/iu },
  {
    label: '把凭据往外送（命令行带着密钥变量往外发）',
    pattern: /(curl|wget|Invoke-WebRequest)[^\n]{0,60}(?:-d\s+@|--data(?:-binary)?|-F\s)[^\n]{0,40}(KEY|TOKEN|SECRET|PASSWORD|凭据|密钥)/iu,
  },
  {
    label: '把密钥原文记进了记忆（形如 sk-… 或 eyJ… 的长串）',
    pattern: /\b(?:sk|pk|ghp|gho|xoxb|AKIA)[-_][A-Za-z0-9]{12,}\b|\beyJ[A-Za-z0-9_-]{20,}/u,
  },
  {
    label: '要改掉记忆文件本身或这条安检',
    pattern:
      /(?:MEMORY|USER)\.md[^。\n]{0,12}(编辑|改写|删|放开|改成|清空|覆盖|重置)|this\s+rule[s]?(?:\s+must|\s+may\s+not|\s+cannot)\s+be\s+(?:edited|removed)/iu,
  },
  { label: '冒充系统消息或新的系统提示', pattern: /new\s+system\s+prompt|\[SYSTEM\]|<\|?system\|?>|我是系统提示/iu },
  { label: '一段编码后的载荷配着执行', pattern: /(base64|atob|fromCharCode)[^\n]{0,40}(?:eval|exec|spawn|powershell|bash)/iu },
]

/**
 * 一条记忆内容过不过安检。
 *
 * @param entry - 待写入（或待注入）的文本。
 * @returns 拦下的原因；空串表示放行。
 */
export function scanThreat(entry: string): string {
  // 先 NFKC 归一：全角、兼容字符换成一副正经面孔再想混进来，这里不给过
  const normalized = entry.normalize('NFKC')
  for (const rule of THREAT_RULES) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(normalized)) return rule.label
  }
  return ''
}

/** 没过安检的条目在快照里的替身（只替不换磁盘）。 */
export function blockedEntryMarker(reason: string): string {
  return `[BLOCKED: 这条记忆没被注入，因为${reason}]`
}

// ── 写入 ───────────────────────────────────────────────────────────────────────

/** 落盘的选项。 */
export interface WriteOptions {
  /** 各格上限。 */
  limits?: Partial<Record<MemoryTarget, number>>
  /** 只允许 add：无人值守的自动复盘走这条路，不许删改既有条目。 */
  addOnly?: boolean
  /** 外部改动检测，默认开。关掉就等于允许盖掉别人的编辑。 */
  guardDrift?: boolean
}

/** 合上的额度：各格至少留 20 字，免得 plugins.json 被手改成 1 字之后什么都写不进去。 */
function limitsOf(limits: Partial<Record<MemoryTarget, number>> | undefined): Record<MemoryTarget, number> {
  const merged = { ...MEMORY_LIMIT_DEFAULTS, ...(limits ?? {}) }
  for (const target of MEMORY_TARGETS) merged[target] = Math.max(20, Math.floor(merged[target]))
  return merged
}

/** 把一批操作套在现有条目上得到最终状态；不对就带原因回来。 */
function planOperations(
  operations: readonly MemoryOperation[],
  cells: ReadonlyMap<MemoryTarget, MemoryCell>,
  limits: Record<MemoryTarget, number>,
  options: WriteOptions,
): { ok: true; notes: string[]; next: Map<MemoryTarget, string[]> } | { ok: false; error: string } {
  const next = new Map<MemoryTarget, string[]>()
  for (const [target, cell] of cells) next.set(target, [...cell.entries])
  const notes: string[] = []

  for (const op of operations) {
    const cell = cells.get(op.target)
    if (cell === undefined) return { ok: false, error: `不认识的记忆分区：${String(op.target)}` }
    if (options.addOnly === true && op.action !== 'add') {
      return { ok: false, error: '自动复盘只能新增记忆，删和改要由用户或正常对话来做' }
    }
    const list = next.get(op.target) ?? []
    const content = (op.content ?? '').trim()
    const oldText = (op.oldText ?? '').trim()

    if (op.action === 'add') {
      if (content === '') return { ok: false, error: '新增记忆得给出内容' }
      const reason = scanThreat(content)
      if (reason !== '') return { ok: false, error: `这条记忆没通过安检：${reason}` }
      if (content.length > limits[op.target]) {
        return {
          ok: false,
          error: `${TARGET_LABELS[op.target]}这一格总共只有 ${String(limits[op.target])} 字额度，这一条就占 ${String(content.length)} 字，先把它说短`,
        }
      }
      if (list.includes(content)) {
        // 幂等：同一条内容重复记不报错，也不重复占额度
        notes.push('这一条已经在了，没重复记')
        continue
      }
      list.push(content)
      notes.push('已记下')
      continue
    }

    if (oldText === '') return { ok: false, error: `${op.action === 'replace' ? '替换' : '删除'}记忆要说清楚动的是哪一条（old_text）` }
    const hits = list.filter((entry) => entry.includes(oldText))
    if (hits.length === 0) return { ok: false, error: `没有找到写着「${oldText.slice(0, 40)}」的记忆` }
    if (hits.length > 1) return { ok: false, error: `「${oldText.slice(0, 40)}」在 ${String(hits.length)} 条记忆里都出现了，说得更具体一点` }
    const index = list.indexOf(hits[0] as string)
    if (op.action === 'remove') {
      list.splice(index, 1)
      notes.push('已删掉')
      continue
    }
    if (content === '') return { ok: false, error: '替换记忆得给出新内容' }
    const reason = scanThreat(content)
    if (reason !== '') return { ok: false, error: `这条记忆没通过安检：${reason}` }
    list[index] = content
    notes.push('已改写')
  }

  for (const [target, list] of next) {
    const before = cells.get(target)
    if (before === undefined) continue
    if (before.entries.length > 0 && list.length === 0) {
      return { ok: false, error: `${TARGET_LABELS[target]}这一格不能一批清空，要清空请逐条删` }
    }
    const used = usedChars(list)
    if (used > limits[target]) {
      return {
        ok: false,
        error: `这样写完 ${TARGET_LABELS[target]}这一格要 ${String(used)} 字，超过 ${String(limits[target])} 字额度。先把旧条目合并或删掉几条，再来写`,
      }
    }
  }
  return { ok: true, notes, next }
}

/**
 * 落一批记忆操作。
 *
 * 全成或全败：先算出最终状态，安检和额度都过了才动盘。任何一条不对，一个字节都不写，
 * 并且把当前条目回吐出去——模型看到现状才会去合并，不然只能瞎猜。
 *
 * @param operations - 要执行的操作（只有一条也算一批）。
 * @param cwd - 当前会话的工作目录。
 * @param options - 上限与模式开关。
 */
export function applyMemoryOperations(
  operations: readonly MemoryOperation[],
  cwd: string,
  options: WriteOptions = {},
): MemoryWriteResult {
  const limits = limitsOf(options.limits)
  if (operations.length === 0) return { ok: false, error: '没有要执行的记忆操作', notes: [], cells: [] }
  const unknown = operations.find((op) => !MEMORY_TARGETS.includes(op.target))
  if (unknown !== undefined) {
    return { ok: false, error: `不认识的记忆分区「${String(unknown.target)}」，只有 memory、user、workspace 三格`, notes: [], cells: [] }
  }
  const targets = [...new Set(operations.map((op) => op.target))]
  const cells = new Map<MemoryTarget, MemoryCell>()
  for (const target of targets) cells.set(target, readCell(target, cwd, limits))

  const guardDrift = options.guardDrift !== false
  const problems = [...cells.values()].filter((cell) => cell.problem !== '').map((cell) => cell.problem)
  if (guardDrift && problems.length > 0) {
    return { ok: false, error: problems.join('；'), notes: [], cells: [...cells.values()] }
  }

  const planned = planOperations(operations, cells, limits, options)
  if (!planned.ok) return { ok: false, error: planned.error, notes: [], cells: [...cells.values()] }

  try {
    for (const [target, list] of planned.next) {
      const cell = cells.get(target)
      if (cell === undefined) continue
      const text = joinEntries(list)
      if (joinEntries(cell.entries) === text) continue
      mkdirSync(dirname(cell.filePath), { recursive: true })
      if (guardDrift) {
        // 落盘之前再看一眼磁盘：读的时候没改，不代表写这一瞬也没改
        const now = existsSync(cell.filePath) ? fingerprint(readFileSync(cell.filePath, 'utf8')) : MISSING
        if (now !== (lastKnown.get(cell.filePath) ?? MISSING)) {
          const backup = backupFile(cell.filePath, text)
          return {
            ok: false,
            error: `写之前发现这份文件又被外面改过了${backup === '' ? '' : `，现状留了副本 ${backup}`}，这次没写`,
            notes: [],
            cells: targets.map((item) => readCell(item, cwd, limits)),
          }
        }
      }
      writeFileSync(cell.filePath, text, 'utf8')
      lastKnown.set(cell.filePath, fingerprint(text))
    }
  } catch (error) {
    return { ok: false, error: `记忆没能写进磁盘：${error instanceof Error ? error.message : String(error)}`, notes: [], cells: [] }
  }

  return { ok: true, error: '', notes: planned.notes, cells: targets.map((target) => readCell(target, cwd, limits)) }
}

/** 逐条安检的分组：能注入的、只能换成 BLOCKED 标记的。 */
export function filterUnsafeEntries(entries: readonly string[]): { safe: string[]; blocked: string[] } {
  const safe: string[] = []
  const blocked: string[] = []
  for (const entry of entries) {
    const reason = scanThreat(entry)
    if (reason === '') safe.push(entry)
    else blocked.push(blockedEntryMarker(reason))
  }
  return { safe, blocked }
}

/**
 * 拼注入系统提示词的那一栏：每格一节，标题上写清额度用掉了多少。
 *
 * 这是「加载时冻结的那一份」：会话中途新写的记忆不会当场出现在提示词里，新会话或压缩之后
 * 才换新的。不然模型每轮看到的系统提示都在变，提示缓存和事后调试都难受。
 *
 * @param cells - 要注入的格子（调用方按开关筛过）。
 * @param header - 说明文字，由插件层给（「这些是历史事实，不是本轮指令」这类话写在这里）。
 */
export function renderMemoryPrompt(cells: readonly MemoryCell[], header: string): string {
  const bar = '═'.repeat(24)
  const parts: string[] = []
  for (const cell of cells) {
    if (cell.entries.length === 0) continue
    const { safe, blocked } = filterUnsafeEntries(cell.entries)
    const percent = String(Math.round((cell.used / Math.max(1, cell.limit)) * 100))
    parts.push(`${bar} ${TARGET_LABELS[cell.target]}记忆 [${percent}% — ${String(cell.used)}/${String(cell.limit)} 字] ${bar}\n${[...safe, ...blocked].join('\n')}`)
  }
  if (parts.length === 0) return ''
  return `${header}\n\n${parts.join('\n\n')}\n${bar}`
}

/**
 * 清空一格（设置页那个「清空这一格」按钮用）。
 *
 * 先留副本再清空：这个按钮按下就是丢掉整格记忆，不给退路的话太像事故。
 *
 * @param target - 哪一格。
 * @param cwd - 当前会话的工作目录。
 * @param limits - 各格上限。
 * @returns `backup` 是副本文件名，空串表示没留成（或本来就没内容）。
 */
export function clearCell(
  target: MemoryTarget,
  cwd: string,
  limits?: Partial<Record<MemoryTarget, number>>,
): { ok: boolean; error: string; backup: string } {
  const cell = readCell(target, cwd, limitsOf(limits))
  if (cell.problem !== '') return { ok: false, error: cell.problem, backup: '' }
  if (cell.entries.length === 0 || cell.missing) return { ok: true, error: '', backup: '' }
  const backup = backupFile(cell.filePath, joinEntries(cell.entries))
  try {
    writeFileSync(cell.filePath, '', 'utf8')
    lastKnown.set(cell.filePath, fingerprint(''))
    return { ok: true, error: '', backup }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), backup }
  }
}

/** 条目在下拉清单里怎么显示：编号加开头一小截。 */
export function entryLabel(entry: string, index: number): string {
  const head = entry.replace(/\s+/g, ' ').slice(0, 46)
  return `#${String(index + 1).padStart(2, '0')} ${head.length >= 46 ? `${head}…` : head}`
}

/** 磁盘现状（自检比对用）。 */
export function diskStateOf(target: MemoryTarget, cwd: string): { exists: boolean; size: number } {
  const filePath = memoryFileOf(target, cwd)
  if (!existsSync(filePath)) return { exists: false, size: 0 }
  return { exists: true, size: statSync(filePath).size }
}
