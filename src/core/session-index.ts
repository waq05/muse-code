/**
 * 会话全文检索的旁路倒排索引：把 `~/.dsc/sessions` 下的会话 jsonl 逐行抽出来切词，
 * 建一张「词项 → 行」的倒排表，落在 `<索引目录>/session-index.json`（缺省 `~/.dsc/cache`）。
 *
 * 中文为什么用 bigram：中文里「内存」「压缩」这类一两个字组成的词大量存在，
 * trigram 要求词项至少 3 个字符，这些词一个都进不了索引，只能退化成逐行扫描。
 * 这里对汉字连续段同时记 1-gram 与 2-gram（照 Hermes 的 cjk_unicode61 做法），
 * 查询「内存」只查 2-gram `内存`（保住相邻语义），查询「泄」只查 1-gram，一级两级都命中。
 *
 * 索引与会话 jsonl 完全分离：jsonl 是 append-only 的主格式，索引是旁路缓存，
 * 版本对不上或内容读不懂就整表重建，会话历史一个字节都不受影响。
 *
 * @module dsc/core/session-index
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { archivedRoot, sessionsRoot, teammateRoot, trashRoot } from './session.js'

/** 索引文件格式版本：读到的版本对不上就整表重建（旁路缓存没有迁移价值）。 */
export const SESSION_INDEX_VERSION = 1

/** 索引文件名；实际路径是 `<索引目录>/session-index.json`。 */
export const SESSION_INDEX_FILE = 'session-index.json'

/**
 * 一个会话文件属于哪一区，决定检索时收不收它。
 * `active` = 活动会话，`archived` = 归档区，`hidden` = 回收站与队友日志。
 */
export type SessionZone = 'active' | 'archived' | 'hidden'

/** 索引与检索的可调值（插件从 Config 读出来，按 {@link SESSION_INDEX_BOUNDS} 夹取）。 */
export interface SessionIndexOptions {
  /** 索引文件所在目录。 */
  indexDir: string
  /** 是否把归档区 `sessions/.archived/` 收进索引。 */
  includeArchived: boolean
  /** 是否把点开头的目录（`.trash` 回收站、`.teammates` 队友日志）收进索引。 */
  includeHiddenDirs: boolean
  /** 单文件大小上限（字节）；超过就只记指纹，不解析它的正文。 */
  maxFileBytes: number
  /** 命中片段的目标长度（字符，含省略号）。 */
  snippetLength: number
  /** 回填时每一批处理多少个文件；批与批之间让出一次事件循环。 */
  backfillBatch: number
  /** `search` 不传 limit 时返回几条。 */
  defaultLimit: number
}

/** 可调值的合法区间，读配置的人按它夹取。 */
export const SESSION_INDEX_BOUNDS = {
  maxFileBytes: { min: 4096, max: 256 * 1024 * 1024 },
  snippetLength: { min: 40, max: 2000 },
  backfillBatch: { min: 1, max: 500 },
  defaultLimit: { min: 1, max: 200 },
} as const

/**
 * 缺省可调值。索引目录跟着 HOME 走，所以按调用取而不是做成常量对象
 * （自检在临时 HOME 上跑，常量会在模块加载时把真实家目录冻进去）。
 */
export function defaultSessionIndexOptions(): SessionIndexOptions {
  return {
    indexDir: join(homedir(), '.dsc', 'cache'),
    includeArchived: false,
    includeHiddenDirs: false,
    maxFileBytes: 8 * 1024 * 1024,
    snippetLength: 160,
    backfillBatch: 25,
    defaultLimit: 20,
  }
}

/** 一条命中：够调用方直接跳回那一行。 */
export interface SessionIndexHit {
  /** 会话 id（jsonl 里 meta 行的 id，缺 meta 时退回文件名）。 */
  sessionId: string
  /** 会话 jsonl 的绝对路径。 */
  file: string
  /** 会话的工作目录；meta 里没写就是空串。 */
  cwd: string
  /** 命中那一行的角色：user / assistant / tool / summary。 */
  role: string
  /** 命中行的时间戳（毫秒）；记录自己没带 ts 时用会话创建时间，什么都没有就是 0。 */
  ts: number
  /** 命中处前后各截一段的正文片段（空白已压成单个空格）。 */
  snippet: string
  /** 命中所在行号（从 1 数）。 */
  line: number
}

/** {@link SessionIndex.search} 的查询条件。 */
export interface SessionIndexSearchOptions {
  /** 最多返回几条；缺省用 {@link SessionIndexOptions.defaultLimit}。 */
  limit?: number
  /** 是否连归档会话一起看；缺省用 {@link SessionIndexOptions.includeArchived}。 */
  includeArchived?: boolean
  /** 只搜这个工作目录下的会话。 */
  cwd?: string
}

/** 索引现状。 */
export interface SessionIndexStats {
  /** 索引里记着多少个会话文件（含只记指纹的超大文件）。 */
  files: number
  /** 倒排表里有多少个词项。 */
  terms: number
  /** 索引最后一次成功落盘的时间（毫秒）；从没落盘过就是 0。 */
  updatedAt: number
}

/** 汉字及其近亲（假名、谚文）的码点区间：这些字符按 1-gram + 2-gram 切。 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3040, 0x30ff], // 平假名与片假名
  [0x3400, 0x4dbf], // 汉字扩展 A
  [0x4e00, 0x9fff], // 汉字基本区
  [0xac00, 0xd7af], // 谚文音节
  [0xf900, 0xfaff], // 汉字兼容表意文字
  [0x20000, 0x2fa1f], // 汉字扩展 B 及以后
]

/** 这个字符算不算中日韩文字（按码点判，代理对也算一个字符）。 */
export function isCjkChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return CJK_RANGES.some(([start, end]) => code >= start && code <= end)
}

/** 字母与数字（英文词按它成词；非中日韩的字母也算词字符）。 */
const WORD_CHAR = /[\p{L}\p{N}]/u

/**
 * 切词。中日韩连续段按 `cutCjk` 展开，其余语言按字母数字成词并统一小写。
 * @param text - 原文。
 * @param forQuery - true = 查询用切法（中文段两字以上只要 2-gram）；false = 建索引用切法（另加 1-gram）。
 * @returns 去重后的词项。
 */
function cut(text: string, forQuery: boolean): string[] {
  const out = new Set<string>()
  let run: string[] = []
  let word = ''
  const flushRun = (): void => {
    if (run.length > 0) {
      // 查询：单字段才要 1-gram；建索引：每个字都记 1-gram，查询单字才有得命中
      const withUnigrams = !forQuery || run.length === 1
      if (withUnigrams) for (const char of run) out.add(char)
      for (let at = 0; at + 1 < run.length; at += 1) out.add(run[at]! + run[at + 1]!)
    }
    run = []
  }
  const flushWord = (): void => {
    if (word !== '') out.add(word)
    word = ''
  }
  for (const char of text.toLowerCase()) {
    if (isCjkChar(char)) {
      flushWord()
      run.push(char)
      continue
    }
    if (WORD_CHAR.test(char)) {
      flushRun()
      word += char
      continue
    }
    flushRun()
    flushWord()
  }
  flushRun()
  flushWord()
  return [...out]
}

/** 一行正文切词（建索引用）：中文 1-gram + 2-gram，英文数字整词小写。 */
export function documentTerms(text: string): string[] {
  return cut(text, false)
}

/**
 * 查询切词：中文连续段两字以上只取相邻 2-gram，所以「内存」要求两字相邻，
 * 不会因为另一行同时出现「内」和「存」就误命中。
 */
export function queryTerms(query: string): string[] {
  return cut(query, true)
}

/** 两个升序行号数组求交集（倒排表里的行号天然升序）。 */
function intersectSorted(left: readonly number[], right: readonly number[]): number[] {
  const out: number[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const a = left[i]!
    const b = right[j]!
    if (a === b) {
      out.push(a)
      i += 1
      j += 1
    } else if (a < b) {
      i += 1
    } else {
      j += 1
    }
  }
  return out
}

/**
 * 截一段命中片段：尽量把第一个命中的词项摆在中间。
 * @param text - 命中行的正文。
 * @param terms - 这次查询的词项（用来找命中位置）。
 * @param length - 目标长度。
 */
function snippetOf(text: string, terms: readonly string[], length: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= length) return flat
  const lower = flat.toLowerCase()
  let at = -1
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  // 一个词项都没找到（英文大小写折叠出过长度的极端情况）：从头截一段
  if (at < 0) return `${flat.slice(0, length)}…`
  const start = Math.max(at - Math.floor((length - 1) / 2), 0)
  const end = Math.min(start + length, flat.length)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** 让出一次事件循环：回填大目录时宿主与界面不该被索引卡住。 */
function yieldToHost(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

/** 一行正文在索引里的样子。 */
interface DocEntry {
  line: number
  role: string
  ts: number
  text: string
}

/** 一个会话文件在索引里的样子。 */
interface FileEntry {
  path: string
  sessionId: string
  cwd: string
  zone: SessionZone
  mtimeMs: number
  size: number
  /** 这个文件上一次被解析的时间；没改过的文件保留旧值。 */
  parsedAt: number
  docs: DocEntry[]
  /** 行号 → 正文，检索时按倒排给的行号取片段。 */
  byLine: Map<number, DocEntry>
  /** 这个文件贡献的词项；重解析前按它把旧倒排清掉。 */
  terms: string[]
}

/** 扫描到的一个待对齐文件。 */
interface ScanTarget {
  path: string
  zone: SessionZone
  mtimeMs: number
  size: number
}

/** 落盘的一个会话文件。 */
interface StoredFile {
  path: string
  sessionId: string
  cwd: string
  mtimeMs: number
  size: number
  zone: SessionZone
  parsedAt: number
}

/** 落盘的一行正文；`file` 是它在 `files` 数组里的下标。 */
interface StoredDoc {
  file: number
  line: number
  role: string
  ts: number
  text: string
}

/** 落盘的整张索引。 */
interface StoredIndex {
  version: number
  updatedAt: number
  files: StoredFile[]
  docs: StoredDoc[]
  /** 词项 → （文件下标 → 行号数组）。 */
  terms: Record<string, Record<string, number[]>>
}

/** 取字符串字段（类型不对就用兜底值）。 */
function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** 取数字字段（NaN 与 Infinity 都不算数）。 */
function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 取区域字段，认不出来按活动区算。 */
function asZone(value: unknown): SessionZone {
  return value === 'archived' || value === 'hidden' ? value : 'active'
}

/**
 * 读磁盘上的索引。这是文件边界，字段一律当面验一遍：读不懂就返回 null，
 * 调用方当作还没有索引，下一次 sync 全量回填。
 * @param file - 索引文件绝对路径。
 */
function readStoredIndex(file: string): StoredIndex | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null // 还没建过索引（首次启用）
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null // 索引文件坏了：整表重建，会话历史不受影响
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record['version'] !== SESSION_INDEX_VERSION) return null
  if (!Array.isArray(record['files']) || !Array.isArray(record['docs'])) return null
  if (record['terms'] === null || typeof record['terms'] !== 'object') return null

  const files: StoredFile[] = []
  for (const item of record['files']) {
    if (item === null || typeof item !== 'object') continue
    const rawFile = item as Record<string, unknown>
    const path = asString(rawFile['path'])
    if (path === '') continue
    files.push({
      path,
      sessionId: asString(rawFile['sessionId'], basename(path, '.jsonl')),
      cwd: asString(rawFile['cwd']),
      mtimeMs: asNumber(rawFile['mtimeMs'], 0),
      size: asNumber(rawFile['size'], 0),
      zone: asZone(rawFile['zone']),
      parsedAt: asNumber(rawFile['parsedAt'], 0),
    })
  }
  const docs: StoredDoc[] = []
  for (const item of record['docs']) {
    if (item === null || typeof item !== 'object') continue
    const rawDoc = item as Record<string, unknown>
    const fileIndex = rawDoc['file']
    const line = rawDoc['line']
    if (typeof fileIndex !== 'number' || typeof line !== 'number') continue
    docs.push({ file: fileIndex, line, role: asString(rawDoc['role']), ts: asNumber(rawDoc['ts'], 0), text: asString(rawDoc['text']) })
  }
  // 键可能是 `__proto__` 这类名字（正文里的英文词），所以用无原型对象装，别让赋值改到原型上去
  const terms: Record<string, Record<string, number[]>> = Object.create(null) as Record<string, Record<string, number[]>>
  for (const [term, bucketRaw] of Object.entries(record['terms'] as Record<string, unknown>)) {
    if (bucketRaw === null || typeof bucketRaw !== 'object' || Array.isArray(bucketRaw)) continue
    const bucket: Record<string, number[]> = Object.create(null) as Record<string, number[]>
    for (const [fileIndex, linesRaw] of Object.entries(bucketRaw as Record<string, unknown>)) {
      if (!Array.isArray(linesRaw)) continue
      const lines = linesRaw.filter((line): line is number => typeof line === 'number' && Number.isInteger(line))
      if (lines.length > 0) bucket[fileIndex] = lines
    }
    if (Object.keys(bucket).length > 0) terms[term] = bucket
  }
  return { version: SESSION_INDEX_VERSION, updatedAt: asNumber(record['updatedAt'], 0), files, docs, terms }
}

/** 这条命中该不该给调用方看：活动区总有；归档区与隐藏区看开关。 */
function zoneVisible(zone: SessionZone, includeArchived: boolean, includeHiddenDirs: boolean): boolean {
  if (zone === 'archived') return includeArchived
  if (zone === 'hidden') return includeHiddenDirs
  return true
}

/** 命中排序：时间新的在前，同一时间按文件与行号排，保证同样的查询给同样的顺序。 */
function compareHits(left: SessionIndexHit, right: SessionIndexHit): number {
  if (left.ts !== right.ts) return right.ts - left.ts
  if (left.file !== right.file) return left.file < right.file ? -1 : 1
  return left.line - right.line
}

/**
 * 会话倒排索引。生命周期：构造 → {@link SessionIndex.load} 读一次磁盘 →
 * 每次 {@link SessionIndex.search} 前做一次增量对齐（{@link SessionIndex.sync}）。
 *
 * 索引只在内存里改，改完（有文件真的变了）才落盘；落盘是「先写 .tmp 再改名」，
 * 宿主半路被杀也不会留下半截索引。
 */
export class SessionIndex {
  private readonly options: SessionIndexOptions
  private readonly files = new Map<string, FileEntry>()
  /** 词项 → （文件路径 → 升序行号数组）。 */
  private readonly postings = new Map<string, Map<string, number[]>>()
  private updatedAt = 0
  /** 正在跑的那次对齐；并发的 search 共用它，免得同一时刻重复扫目录。 */
  private inflight: Promise<number> | null = null

  constructor(options: SessionIndexOptions) {
    this.options = options
  }

  /** 索引文件绝对路径。 */
  indexPath(): string {
    return join(this.options.indexDir, SESSION_INDEX_FILE)
  }

  /**
   * 从磁盘读一份索引进内存。文件不存在、版本不符、内容读不懂都当「还没有索引」，
   * 下一次 {@link SessionIndex.sync} 会全量回填。
   */
  load(): void {
    const stored = readStoredIndex(this.indexPath())
    if (stored === null) return
    // 先在局部变量里整表建好再换上去：中途任何一步读不懂都不会把现有索引留成半截
    const files = new Map<string, FileEntry>()
    const entries: FileEntry[] = []
    for (const item of stored.files) {
      const entry: FileEntry = {
        path: item.path,
        sessionId: item.sessionId,
        cwd: item.cwd,
        zone: item.zone,
        mtimeMs: item.mtimeMs,
        size: item.size,
        parsedAt: item.parsedAt,
        docs: [],
        byLine: new Map(),
        terms: [],
      }
      entries.push(entry)
      files.set(entry.path, entry)
    }
    for (const doc of stored.docs) {
      const entry = entries[doc.file]
      if (entry === undefined) continue
      const body: DocEntry = { line: doc.line, role: doc.role, ts: doc.ts, text: doc.text }
      entry.docs.push(body)
      entry.byLine.set(body.line, body)
    }
    const postings = new Map<string, Map<string, number[]>>()
    for (const [term, bucket] of Object.entries(stored.terms)) {
      const table = new Map<string, number[]>()
      for (const [fileIndex, lines] of Object.entries(bucket)) {
        const entry = entries[Number(fileIndex)]
        if (entry === undefined || lines.length === 0) continue
        table.set(entry.path, lines)
      }
      if (table.size === 0) continue
      postings.set(term, table)
      // 重解析时要按词项清旧倒排，所以每个文件得记着自己贡献过哪些词项
      for (const path of table.keys()) files.get(path)?.terms.push(term)
    }
    this.files.clear()
    this.postings.clear()
    for (const [path, entry] of files) this.files.set(path, entry)
    for (const [term, table] of postings) this.postings.set(term, table)
    this.updatedAt = stored.updatedAt
  }

  /**
   * 增量对齐：新增、mtime 或 size 变了的文件重新解析，盘上已经没有的文件撤下它的行。
   * @param onProgress - 每批（以及最后一批）回调一次已处理文件数与总数，供回填时报进度。
   * @returns 这一次真正重新解析了几个文件。
   */
  sync(onProgress?: (done: number, total: number) => void): Promise<number> {
    if (this.inflight !== null) return this.inflight
    const run = this.runSync(onProgress)
    const guarded = run.finally(() => {
      this.inflight = null
    })
    this.inflight = guarded
    return guarded
  }

  /**
   * 丢掉整张索引并从磁盘重来（设置页的「重建索引」与回填用）。
   * @param onProgress - 每批回调一次已处理文件数与总数。
   */
  async rebuild(onProgress?: (done: number, total: number) => void): Promise<void> {
    this.files.clear()
    this.postings.clear()
    this.updatedAt = 0
    await this.sync(onProgress)
  }

  /**
   * 检索。先做一次增量对齐，所以刚写完的会话当场就能搜到。
   * @param query - 关键词；中英文混写都行。
   * @param options - 条数、是否含归档、按工作目录过滤。
   * @returns 命中列表，时间新的在前。
   */
  async search(query: string, options: SessionIndexSearchOptions = {}): Promise<SessionIndexHit[]> {
    await this.sync()
    const terms = queryTerms(query)
    if (terms.length === 0) return []
    const tables: Array<Map<string, number[]>> = []
    for (const term of terms) {
      const table = this.postings.get(term)
      // 有一个词项全库都没出现过，这次 AND 的结果必然为空
      if (table === undefined) return []
      tables.push(table)
    }
    // 从最小的倒排表开始走，能少看几个文件
    tables.sort((left, right) => left.size - right.size)
    const includeArchived = options.includeArchived ?? this.options.includeArchived
    const hits: SessionIndexHit[] = []
    for (const [path, lines] of tables[0]!) {
      const file = this.files.get(path)
      if (file === undefined) continue
      if (!zoneVisible(file.zone, includeArchived, this.options.includeHiddenDirs)) continue
      if (options.cwd !== undefined && file.cwd !== options.cwd) continue
      let matched = lines
      for (let at = 1; at < tables.length && matched.length > 0; at += 1) {
        const other = tables[at]!.get(path)
        matched = other === undefined ? [] : intersectSorted(matched, other)
      }
      for (const line of matched) {
        const doc = file.byLine.get(line)
        if (doc === undefined) continue
        hits.push({
          sessionId: file.sessionId,
          file: file.path,
          cwd: file.cwd,
          role: doc.role,
          ts: doc.ts,
          snippet: snippetOf(doc.text, terms, this.options.snippetLength),
          line: doc.line,
        })
      }
    }
    hits.sort(compareHits)
    return hits.slice(0, Math.max(options.limit ?? this.options.defaultLimit, 0))
  }

  /** 索引现状（设置页与自检读它）。 */
  stats(): SessionIndexStats {
    return { files: this.files.size, terms: this.postings.size, updatedAt: this.updatedAt }
  }

  /** 增量对齐的主体。IO 失败一律吞在这一层，绝不让一个坏文件把整张索引带崩。 */
  private async runSync(onProgress?: (done: number, total: number) => void): Promise<number> {
    const targets = this.scanTargets()
    const present = new Set(targets.map((target) => target.path))
    for (const path of [...this.files.keys()]) {
      if (!present.has(path)) this.dropFile(path)
    }
    // 会话 jsonl 是 append-only：内容变了必然动到 mtime 或 size 之一，两个都没动就不重解析
    const changed = targets.filter((target) => {
      const known = this.files.get(target.path)
      return known === undefined || known.mtimeMs !== target.mtimeMs || known.size !== target.size
    })
    const batch = Math.max(this.options.backfillBatch, 1)
    for (let at = 0; at < changed.length; at += batch) {
      const slice = changed.slice(at, at + batch)
      for (const target of slice) this.parseFile(target)
      const done = at + slice.length
      onProgress?.(done, changed.length)
      if (done < changed.length) await yieldToHost()
    }
    if (changed.length > 0) this.save()
    return changed.length
  }

  /** 这一轮该收哪些文件：活动区总有，归档区与隐藏区看开关。 */
  private scanTargets(): ScanTarget[] {
    const targets: ScanTarget[] = []
    this.addRoot(sessionsRoot(), 'active', true, targets)
    if (this.options.includeArchived) this.addRoot(archivedRoot(), 'archived', false, targets)
    if (this.options.includeHiddenDirs) {
      this.addRoot(trashRoot(), 'hidden', false, targets)
      this.addRoot(teammateRoot(), 'hidden', false, targets)
    }
    return targets
  }

  /**
   * 收一个根目录下的 `<工作目录名>/<uuid>.jsonl`（根目录下直接放的 jsonl 也收）。
   * @param root - 根目录。
   * @param zone - 这个区的归类。
   * @param skipHiddenDirs - 是否跳点子目录；活动区要跳过 `.archived` 与 `.teammates`，
   *                          而归档区、回收站、队友区自己就是点开头的，由调用方直接当根传进来。
   * @param out - 收集结果。
   */
  private addRoot(root: string, zone: SessionZone, skipHiddenDirs: boolean, out: ScanTarget[]): void {
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      return // 这个区还不存在（没归档过、没跑过队友）：不是错误，也没什么可收
    }
    for (const name of names) {
      if (skipHiddenDirs && name.startsWith('.')) continue
      const path = join(root, name)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(path)
      } catch {
        continue // 扫的这一瞬间被删掉：跳过它，下一轮对齐再说
      }
      if (stat.isDirectory()) {
        let files: string[]
        try {
          files = readdirSync(path)
        } catch {
          continue // 目录读不动：跳过，不影响同区其它会话
        }
        for (const file of files) {
          if (file.endsWith('.jsonl')) this.pushTarget(join(path, file), zone, out)
        }
        continue
      }
      if (name.endsWith('.jsonl')) this.pushTarget(path, zone, out)
    }
  }

  /** 记一个待对齐文件（拿不到 mtime/size 就跳过它）。 */
  private pushTarget(file: string, zone: SessionZone, out: ScanTarget[]): void {
    try {
      const stat = statSync(file)
      out.push({ path: file, zone, mtimeMs: stat.mtimeMs, size: stat.size })
    } catch {
      // 文件在这一瞬间被删掉：这一轮不收它，下一轮增量对齐会发现它没了
    }
  }

  /** 重新解析一个文件：先撤下它的旧版本，再按行建新的。 */
  private parseFile(target: ScanTarget): void {
    const known = this.files.get(target.path)
    if (known !== undefined) this.dropFile(target.path)
    const entry: FileEntry = {
      path: target.path,
      sessionId: basename(target.path, '.jsonl'),
      cwd: '',
      zone: target.zone,
      mtimeMs: target.mtimeMs,
      size: target.size,
      parsedAt: Date.now(),
      docs: [],
      byLine: new Map(),
      terms: [],
    }
    this.files.set(target.path, entry)
    // 超大文件只留指纹：把几个 GB 的会话读进内存建索引，代价比用户翻文件大得多
    if (target.size > this.options.maxFileBytes) return
    let text: string
    try {
      text = readFileSync(target.path, 'utf8')
    } catch {
      return // 读不动（被删、被独占）：先留着指纹，等它下次变化再试
    }
    const termLines = new Map<string, number[]>()
    let createdAt = 0
    const lines = text.split(/\r?\n/)
    for (let at = 0; at < lines.length; at += 1) {
      const raw = lines[at]!
      if (raw === '') continue
      let record: unknown
      try {
        record = JSON.parse(raw)
      } catch {
        continue // 坏行（写到一半、手工改坏）：跳过这一行，同一文件其余行照样能搜
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
      const item = record as Record<string, unknown>
      if (item['type'] === 'meta') {
        if (typeof item['id'] === 'string') entry.sessionId = item['id']
        if (typeof item['cwd'] === 'string') entry.cwd = item['cwd']
        if (typeof item['createdAt'] === 'number') createdAt = item['createdAt']
        continue
      }
      const role = recordRole(item['type'])
      if (role === null) continue
      const body = typeof item['text'] === 'string' ? item['text'] : ''
      if (body === '') continue
      // 记录自己带 ts 就用它；老日志没有，用 meta 的创建时间，至少让排序有意义
      const ts = typeof item['ts'] === 'number' ? item['ts'] : createdAt
      const doc: DocEntry = { line: at + 1, role, ts, text: body }
      entry.docs.push(doc)
      entry.byLine.set(doc.line, doc)
      for (const term of documentTerms(body)) {
        const lines = termLines.get(term)
        if (lines === undefined) termLines.set(term, [doc.line])
        else lines.push(doc.line)
      }
    }
    entry.terms = [...termLines.keys()]
    for (const [term, lines] of termLines) {
      let table = this.postings.get(term)
      if (table === undefined) {
        table = new Map()
        this.postings.set(term, table)
      }
      table.set(entry.path, lines)
    }
  }

  /** 撤下一个文件：它的每一行从相关词项的倒排表里去掉，空掉的词项整条删掉。 */
  private dropFile(path: string): void {
    const entry = this.files.get(path)
    if (entry === undefined) return
    for (const term of entry.terms) {
      const table = this.postings.get(term)
      if (table === undefined) continue
      table.delete(path)
      if (table.size === 0) this.postings.delete(term)
    }
    this.files.delete(path)
  }

  /** 整张索引落盘（先写 .tmp 再改名）。写不进去只影响下次启动要重建，检索本身不受影响。 */
  private save(): void {
    const files = [...this.files.values()]
    const indexOf = new Map<string, number>()
    files.forEach((file, at) => indexOf.set(file.path, at))
    const docs: StoredDoc[] = []
    for (const file of files) {
      const fileIndex = indexOf.get(file.path) ?? 0
      for (const doc of file.docs) {
        docs.push({ file: fileIndex, line: doc.line, role: doc.role, ts: doc.ts, text: doc.text })
      }
    }
    // 无原型对象：英文词项可能正好叫 `__proto__`，普通对象会被它改掉原型
    const terms: Record<string, Record<string, number[]>> = Object.create(null) as Record<string, Record<string, number[]>>
    for (const [term, table] of this.postings) {
      const bucket: Record<string, number[]> = Object.create(null) as Record<string, number[]>
      for (const [path, lines] of table) {
        const fileIndex = indexOf.get(path)
        if (fileIndex !== undefined) bucket[String(fileIndex)] = lines
      }
      terms[term] = bucket
    }
    const stored: StoredIndex = {
      version: SESSION_INDEX_VERSION,
      updatedAt: Date.now(),
      files: files.map((file) => ({
        path: file.path,
        sessionId: file.sessionId,
        cwd: file.cwd,
        mtimeMs: file.mtimeMs,
        size: file.size,
        zone: file.zone,
        parsedAt: file.parsedAt,
      })),
      docs,
      terms,
    }
    try {
      mkdirSync(this.options.indexDir, { recursive: true })
      const file = this.indexPath()
      const temp = `${file}.tmp`
      writeFileSync(temp, JSON.stringify(stored), 'utf8')
      renameSync(temp, file)
    } catch {
      return // 磁盘满或目录只读：这一次检索照常，下次 sync 再试落盘
    }
    this.updatedAt = stored.updatedAt
  }
}

/** 会话记录里进正文检索的四种记录类型；别的一律不看。 */
function recordRole(type: unknown): string | null {
  return type === 'user' || type === 'assistant' || type === 'tool' || type === 'summary' ? type : null
}
