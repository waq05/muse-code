/**
 * spill：工具输出超阈值时落盘，回给模型的只有头几行、文件路径与续读写法。
 *
 * 为什么要有这一层：bash 自己把结果腰斩在 8000 字符（core/tools/bash.ts:19），
 * read 与 grep 一次也能吐几千行；这些内容塞进上下文既贵，又把真正的对话挤出去。
 * 落盘之后尾巴还在盘上，模型想接着看就照预览里那行 read 去取——是「溢出到文件」，
 * 不是「腰斩丢掉」。落盘命名、目录 0700 / 文件 0600、按 mtime 与总量清理这三样
 * 照 dsh 的 `packages/spill/spill-local`。
 *
 * 落盘的是**已遮红**的文本：遮红观察者排在前（order 10），溢出观察者排在后（order 50），
 * 为什么必须这个次序写在 plugins/spill.ts 的模块注释里。
 *
 * @module dsc/core/spill
 */
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolvePluginConfig } from './plugin-registry.js'

/** 插件在条目树（`~/.dsc/plugins.json`）里的键。 */
const CONFIG_KEY = 'spill'

/**
 * 单文件截断时给说明文字留的字节预算。
 * 说明里有行号，长度随行号位数浮动，256 字节足够任何一位数行号写满。
 */
const TRUNCATION_RESERVE_BYTES = 256

/** 每个可调值的合法区间：设置页的 min/max 与这里的夹取共用一份，免得两处对不上。 */
export const SPILL_RANGES = {
  thresholdChars: { min: 200, max: 4_000_000 },
  keepLines: { min: 1, max: 500 },
  readChunkLines: { min: 1, max: 2000 },
  maxBytes: { min: 4_096, max: 268_435_456 },
  retentionDays: { min: 1, max: 3_650 },
  // 目录总量的下限给 64 KB：比这更小连一份普通输出都存不住，清理会一直在删刚写的文件
  maxTotalBytes: { min: 65_536, max: 8_589_934_592 },
} as const

/** 这个插件的可调值。存 `~/.dsc/plugins.json` 的条目 config 里，设置分区保存后立刻生效。 */
export interface SpillConfig {
  /** 超过这么多字符（含）就落盘。 */
  thresholdChars: number
  /** 预览给模型留前几行。 */
  keepLines: number
  /** 续读写法里一次读多少行（就是 read 的 limit）。 */
  readChunkLines: number
  /** 单个溢出文件的字节上限，超了按整行截断。 */
  maxBytes: number
  /** 按 mtime 保留多少天。 */
  retentionDays: number
  /** 整个溢出目录的字节上限，超了从最旧的开始删。 */
  maxTotalBytes: number
  /** 溢出文件落在哪个目录。 */
  dir: string
}

/**
 * 缺省值。放着让用户改，不是硬编码的裁决。
 *
 * 阈值取 4000 而不是 8000：bash 折在 8000 以内的输出里仍有 4000~8000 字符的整段，
 * read / grep 更是动辄几千行，这些一样该落盘；再小就会把普通的命令回显也送进文件。
 */
export const SPILL_DEFAULTS: SpillConfig = {
  thresholdChars: 4000,
  keepLines: 30,
  readChunkLines: 200,
  maxBytes: 1_048_576,
  retentionDays: 7,
  maxTotalBytes: 67_108_864,
  dir: join(homedir(), '.dsc', 'spill'),
}

/** 一次落盘的结果。 */
export interface SpillWriteResult {
  /** 落盘文件的绝对路径（预览里回给模型的就是它）。 */
  path: string
  /** 写进磁盘的字节数。 */
  bytes: number
  /** true = 原文超过单文件上限，尾部按整行截掉了。 */
  truncated: boolean
  /** 实际写进去多少行。 */
  keptLines: number
  /** 原文一共多少行（按 `\n` 数）。 */
  totalLines: number
}

/** 目录里一个已经落盘的溢出文件。 */
export interface SpillFile {
  path: string
  /** 最后修改时间（毫秒），清理按它排序。 */
  mtimeMs: number
  bytes: number
}

/** 一次清理的结果。 */
export interface SpillSweepResult {
  /** 删掉的文件（按删除顺序）。 */
  removed: string[]
  /** 删掉的字节数合计。 */
  removedBytes: number
  /** 扫完还剩几个文件、多少字节。 */
  keptFiles: number
  keptBytes: number
  /** 没删掉的文件与原因（权限不够、被别的进程占着）。 */
  failed: Array<{ path: string; reason: string }>
}

/** 夹到区间内的整数；认不出的值退回缺省。 */
function clampInt(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), range.min), range.max) : fallback
}

/** `~` 开头换成用户目录；其余原样返回（相对路径交给后面的文件操作按 cwd 解析）。 */
function expandHome(text: string): string {
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/**
 * 逐项夹到 {@link SPILL_RANGES} 的范围里，写错类型就用缺省值。
 * 单个值越界不该让整条工具链停下，所以这里不抛错；真有问题在设置页上看得见。
 *
 * @param raw - 磁盘上那份配置（`resolvePluginConfig` 的返回值）。
 * @returns 可以直接用的配置。
 */
export function parseSpillConfig(raw: Record<string, unknown>): SpillConfig {
  return {
    thresholdChars: clampInt(raw.thresholdChars, SPILL_RANGES.thresholdChars, SPILL_DEFAULTS.thresholdChars),
    keepLines: clampInt(raw.keepLines, SPILL_RANGES.keepLines, SPILL_DEFAULTS.keepLines),
    readChunkLines: clampInt(raw.readChunkLines, SPILL_RANGES.readChunkLines, SPILL_DEFAULTS.readChunkLines),
    maxBytes: clampInt(raw.maxBytes, SPILL_RANGES.maxBytes, SPILL_DEFAULTS.maxBytes),
    retentionDays: clampInt(raw.retentionDays, SPILL_RANGES.retentionDays, SPILL_DEFAULTS.retentionDays),
    maxTotalBytes: clampInt(raw.maxTotalBytes, SPILL_RANGES.maxTotalBytes, SPILL_DEFAULTS.maxTotalBytes),
    dir: expandHome(typeof raw.dir === 'string' && raw.dir.trim() !== '' ? raw.dir.trim() : SPILL_DEFAULTS.dir),
  }
}

/**
 * 取这个插件此刻该用的配置：装配时传进来的那份作底，`~/.dsc/plugins.json` 上那份覆盖它。
 * 每次用值都现调（不是挂载时读一次），所以设置里改完不必重启宿主。
 *
 * @param passed - 插件 `apply(ctx, passed)` 的第二参数；不是对象就当没给。
 * @returns 当前配置。
 */
export function readSpillConfig(passed?: unknown): SpillConfig {
  return parseSpillConfig(resolvePluginConfig(CONFIG_KEY, passed))
}

/** 会话 id 当不可信文本处理：只留文件系统安全的字符再截断，免得路径穿越或撞上文件名长度上限。 */
function safeSegment(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_')
  return safe === '' ? 'session' : safe.slice(0, 64)
}

/** 文件名 = 会话 id + ISO 时刻 + 随机尾；冒号与点在 Windows 上是非法字符，换成短横。 */
function spillFileName(sessionId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${safeSegment(sessionId)}-${stamp}-${randomBytes(4).toString('hex')}.log`
}

/** 按 UTF-8 字节切一段字符串，切点落在码点边界上（不产生半个字符）。 */
function sliceUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}

/**
 * 按整行取前几行，让正文落在字节预算内。
 * 第一行本身就超预算时退一步切这一行——总比写一个空文件强。
 */
function headWithinBudget(lines: readonly string[], budget: number): { body: string; keptLines: number } {
  const first = lines[0]
  if (first === undefined) return { body: '', keptLines: 0 }
  if (Buffer.byteLength(first, 'utf8') > budget) return { body: sliceUtf8(first, budget), keptLines: 1 }
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1
    if (used + bytes > budget) break
    kept.push(line)
    used += bytes
  }
  return { body: kept.join('\n'), keptLines: kept.length }
}

/** 截断位置写在文件末尾：模型读到这儿就知道后面还有多少行没落盘。 */
function truncationNote(kept: number, total: number, maxBytes: number): string {
  return `\n…（超过单文件上限 ${String(maxBytes)} 字节，只写了前 ${String(kept)} 行，原文共 ${String(total)} 行；第 ${String(kept + 1)} 行起的 ${String(total - kept)} 行没有落盘）`
}

/** 建新文件并把正文写进去：目录 0700、文件 0600（同机其他用户读不到）。 */
function createSpillFile(sessionId: string, config: SpillConfig, body: string): { path: string; bytes: number } {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const path = join(config.dir, spillFileName(sessionId))
    let handle: number
    try {
      handle = openSync(path, 'wx', 0o600)
    } catch (error) {
      // 同一毫秒里连写两次会撞名（随机尾把概率压到极低），重掷一次即可；其余 IO 错误照抛。
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      writeSync(handle, body)
    } finally {
      closeSync(handle)
    }
    return { path, bytes: Buffer.byteLength(body, 'utf8') }
  }
  throw new Error(`连续三次都没能建出溢出文件（目录 ${config.dir}）`)
}

/**
 * 把一次工具输出写到溢出目录，返回落盘结果。
 *
 * 超过单文件上限时按**整行**截断，并在末尾写明截断位置（第几行起没写）；
 * 单行就超上限那种极端情况切这一行本身，保证文件里至少有开头。
 *
 * @param sessionId - 会话 id，进文件名。取不到也照写，用 `session` 兜底。
 * @param text - 要落盘的文本（调用方保证它已经过遮红）。
 * @param config - 当前配置。
 * @returns 文件路径、字节数与截断情况。
 * @throws 目录建不出来或文件写不进去时抛错（调用方退回原文，别把工具结果弄丢）。
 */
export function writeSpill(sessionId: string, text: string, config: SpillConfig): SpillWriteResult {
  mkdirSync(config.dir, { recursive: true, mode: 0o700 })
  const lines = text.split('\n')
  let body = text
  let keptLines = lines.length
  let truncated = false
  if (Buffer.byteLength(text, 'utf8') > config.maxBytes) {
    const head = headWithinBudget(lines, Math.max(1, config.maxBytes - TRUNCATION_RESERVE_BYTES))
    body = `${head.body}${truncationNote(head.keptLines, lines.length, config.maxBytes)}`
    keptLines = head.keptLines
    truncated = true
  }
  const written = createSpillFile(sessionId, config, body)
  return { ...written, truncated, keptLines, totalLines: lines.length }
}

/**
 * 回给模型的那段：前几行 + 完整路径 + 一句可以直接照抄的续读写法。
 *
 * @param path - 落盘文件的绝对路径。
 * @param text - 溢出的原文；这里只取前几行，尾巴绝不出现。
 * @param config - 当前配置（决定显示几行、续读一次读几行）。
 * @param written - {@link writeSpill} 的结果；文件本身也被截断过时把这件事一并说明。
 * @returns 替换原文的那段文本。
 */
export function spillPreview(path: string, text: string, config: SpillConfig, written?: SpillWriteResult): string {
  const lines = text.split('\n')
  // 文件只写了一部分（截断）时，预览也别显示文件里没有的行
  const available = written !== undefined && written.truncated ? Math.min(lines.length, written.keptLines) : lines.length
  const head = lines.slice(0, Math.min(config.keepLines, available))
  const shown = head.length
  const missing = lines.length - shown
  const more = missing > 0 ? `\n…（这里只显示前 ${String(shown)} 行，还有 ${String(missing)} 行）` : ''
  const cut =
    written !== undefined && written.truncated
      ? `\n（文件本身按 ${String(config.maxBytes)} 字节上限截断，只写了前 ${String(written.keptLines)} 行）`
      : ''
  const pointer = `[完整输出已落盘：${path}\n接着读：read(path="${path}", offset=${String(shown + 1)}, limit=${String(config.readChunkLines)})]`
  return `${head.join('\n')}${more}${cut}\n\n${pointer}`
}

/**
 * 一次完整的溢出：先落盘，再生成回给模型的那段预览。
 * 插件与自检脚本共用这一条路径，所以「先遮红后落盘」验的是顺序，不是两份实现的差别。
 *
 * @param sessionId - 会话 id，进文件名。
 * @param text - 要溢出的文本。
 * @param config - 当前配置。
 * @returns 预览文本与落盘结果。
 */
export function spillText(sessionId: string, text: string, config: SpillConfig): { text: string; written: SpillWriteResult } {
  const written = writeSpill(sessionId, text, config)
  return { text: spillPreview(written.path, text, config, written), written }
}

/**
 * 列目录里已经落盘的溢出文件。
 * 用 lstat 看一眼：符号链接与子目录一律不算（既不跟过去，也不当成溢出文件删）。
 *
 * @param dir - 溢出目录。
 * @returns 普通文件的路径、mtime 与字节数；目录不存在返回空数组。
 */
export function listSpillFiles(dir: string): SpillFile[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    // 目录还不存在 = 从来没溢出过（也可能刚被别的进程删掉）：这不是错误
    return []
  }
  const files: SpillFile[] = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const stats = lstatSync(path)
      if (!stats.isFile()) continue
      files.push({ path, mtimeMs: stats.mtimeMs, bytes: stats.size })
    } catch {
      // 目录边扫边变（这一项刚被删掉）或权限不够：跳过这一项，别让整次清理失败
      continue
    }
  }
  return files
}

/** 比路径时统一大小写与分隔符（Windows 上大小写不敏感，`\` 与 `/` 混着写很常见）。 */
function normalizePath(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

/** 删一个文件并记账；删不掉就记下原因，返回 false（调用方据此别减错总量）。 */
function removeOne(file: SpillFile, result: SpillSweepResult): boolean {
  try {
    unlinkSync(file.path)
  } catch (error) {
    // 权限不够、被杀毒软件占着：记下来继续扫，一个文件卡住不该让整次清理停下
    result.failed.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) })
    return false
  }
  result.removed.push(file.path)
  result.removedBytes += file.bytes
  return true
}

/**
 * 扫一遍溢出目录：先删 mtime 超过保留天数的，再从最旧的开始删到总字节数落回上限内。
 *
 * 三条边界：只碰普通文件（符号链接与子目录不跟、不删），
 * 刚写的那个文件（keepPath）怎么都不删，目录不存在就当已经清干净。
 *
 * @param config - 当前配置（目录、保留天数、总量上限）。
 * @param keepPath - 这次要保住的文件（一般是刚落盘的那份）；不传就没有例外。
 * @returns 删了什么、还剩多少、哪些没删掉。
 */
export function sweepSpillDir(config: SpillConfig, keepPath?: string): SpillSweepResult {
  const result: SpillSweepResult = { removed: [], removedBytes: 0, keptFiles: 0, keptBytes: 0, failed: [] }
  const protectedPath = keepPath === undefined ? undefined : normalizePath(keepPath)
  const cutoff = Date.now() - config.retentionDays * 86_400_000
  const survivors: Array<SpillFile & { protect: boolean }> = []
  for (const file of listSpillFiles(config.dir)) {
    const protect = protectedPath !== undefined && normalizePath(file.path) === protectedPath
    // 刚写的那份不按年龄删：模型手上可能正拿着它的路径在续读
    if (!protect && file.mtimeMs < cutoff) removeOne(file, result)
    else survivors.push({ ...file, protect })
  }
  survivors.sort((left, right) => left.mtimeMs - right.mtimeMs)
  let total = survivors.reduce((sum, file) => sum + file.bytes, 0)
  let kept = 0
  for (const file of survivors) {
    if (file.protect || total <= config.maxTotalBytes) {
      kept += 1
      continue
    }
    if (removeOne(file, result)) total -= file.bytes
    else kept += 1
  }
  result.keptFiles = kept
  result.keptBytes = total
  return result
}

/** 字节数换成人看的写法（设置页与清理结果里用）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} 字节`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`
}
