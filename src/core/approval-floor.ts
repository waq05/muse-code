/**
 * 审批灾难地板：排在守卫链最前面（order 5）的一道硬闸，自己判、自己拒，不等任何人放行。
 *
 * 为什么必须在 order 5：守卫链是「第一位给出 deny 或 pass 的赢」（`core/tool-guards.ts:99-113`）。
 * 协作模式闸门挂在 order 10，计划档与免打扰档在若干情形直接返回 pass（`core/modes.ts:104`、`:135`），
 * 它一返回 pass，后面 order 20 的安全钩子与 order 30 的审批就再也拿不到发言权；
 * 权限模式的「完全访问」还会在审批层直接放行（`plugins/approval.ts:334-337`）。
 * 所以「灾难命令连满权限也不许跑」这件事只能由排在它们前面的一位自己完成。
 *
 * 求值顺序（每层都不依赖后面的层，fail-closed 的理由写在各分支上）：
 *   1. 结构不可验证      → deny
 *   2. 灾难地板          → deny
 *   3. 用户 deny 黑名单  → deny（先于完全访问生效）
 *   4. 危险模式          → 无人值守才 deny，否则 defer 交审批
 *   5. 命令白名单        → defer，并由 whitelist() 交给审批层免卡放行（不自己 pass）
 *   6. 无人值守兜底      → 白名单之外、需要确认的命令与工作区外的写 deny
 *   7. 其余              → defer
 *
 * 地板只判「拒」或「不拒」，「不拒」一律走 defer。自己 return pass 会把后面的安全钩子
 * 一起跳掉，那等于白名单连带免掉了用户自己的闸门。
 *
 * @module dsc/core/approval-floor
 */
import { audit } from './audit.js'
import { builtinDangerHit, classifyCommand, splitSegments, type PrefixRule } from './command-policy.js'
import { isInsideCwd } from './path-policy.js'
import { argsSummary } from './tools.js'
import type { ToolGuard, ToolGuardInput, ToolGuardVerdict } from './tool-guards.js'

/** 配置键：插件条目树里的 file，同时是设置分区 id。 */
export const FLOOR_CONFIG_KEY = 'approval-floor'

/** 可调值的合法区间（配置校验与设置页共用一份，两处不会写岔）。 */
export const FLOOR_LIMITS = {
  maxCommandLength: { min: 100, max: 100_000 },
  circuitBreakerThreshold: { min: 1, max: 100 },
  circuitBreakerCooldownMs: { min: 0, max: 3_600_000 },
} as const

/**
 * 默认白名单：这些前缀本来会被判成「要问」，但它们是常见工程命令，跑起来只读源码或只产出构建物。
 * 逗号与换行都可以用，设置页那个文本框按这两种分隔符切。
 */
const DEFAULT_ALLOW_PREFIXES: readonly string[] = [
  'pnpm run build',
  'pnpm run test',
  'pnpm run typecheck',
  'pnpm run lint',
  'npm run build',
  'npm run test',
  'npm test',
  'yarn build',
  'yarn test',
  'cargo build',
  'cargo test',
  'cargo check',
  'go build',
  'go test',
  'python -m pytest',
  'pytest',
]

/**
 * 默认 deny 黑名单：这些字符串出现在命令原文、命令词元或写目标路径里就拒。
 * glob 里的 `*` 配任意字符（含路径分隔符），`?` 配一个字符，其余按字面量。
 * 黑名单宁可多拦：写宽了要用户自己认，写窄了漏一次就收不回来。
 */
const DEFAULT_DENY_GLOBS: readonly string[] = [
  '*etc/passwd*',
  '*etc/shadow*',
  '*etc/sudoers*',
  '*.ssh/*',
  '*.aws/*',
  '*.gnupg/*',
  '*.env',
  '*.env.*',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '*credentials.yaml',
  '*credentials.yml',
  '*id_rsa*',
  '*id_ed25519*',
]

/** 生效的地板配置。字段全部来自 Config，判定逻辑里没有可调值。 */
export interface FloorConfig {
  /** 白名单前缀：每条是按序匹配的命令词，`*` 只许出现在末尾。 */
  allowPrefixes: readonly (readonly string[])[]
  /** deny 黑名单 glob，匹配命令原文、命令词元与写目标路径（不区分大小写）。 */
  denyGlobs: readonly string[]
  /** 命令最长字符数，更长的按「看不清要跑什么」拒。 */
  maxCommandLength: number
  /** 连续被地板拒多少次后熔断。 */
  circuitBreakerThreshold: number
  /** 熔断后冷却多久（毫秒）。 */
  circuitBreakerCooldownMs: number
  /** 是否启用熔断。 */
  circuitBreakerEnabled: boolean
  /** 无人值守：ask 级命令与工作区外的写一律拒。
   *  这是个显式开关而不是自动探测——dsc 没有可靠的宿主交互信号（桌面端的 `process.stdin.isTTY` 会误判）。 */
  unattended: boolean
}

/** 读一次配置的结果。`problems` 非空时守卫一律拒，见 {@link createApprovalFloor}。 */
export interface FloorConfigResult {
  config: FloorConfig
  /** 配置里读不通的地方（中文，会原样进 `/floor` 与那条启动提示）。 */
  problems: string[]
}

/** 用户没写过的字段用这里的值。 */
export const DEFAULT_FLOOR_CONFIG: FloorConfig = {
  allowPrefixes: DEFAULT_ALLOW_PREFIXES.map((entry) => entry.split(/\s+/)),
  denyGlobs: [...DEFAULT_DENY_GLOBS],
  maxCommandLength: 4000,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 60_000,
  circuitBreakerEnabled: true,
  unattended: false,
}

// ---------------------------------------------------------------- 配置解析

/** 一条前缀的解析结果。 */
export type PrefixParse = { ok: true; pattern: string[] } | { ok: false; error: string }

/** 一条 glob 的解析结果。 */
export type GlobParse = { ok: true; glob: string } | { ok: false; error: string }

/** 一份前缀清单的解析结果。 */
export type ListParse = { ok: true; values: string[] } | { ok: false; error: string }

/** 词元里出现这些字符的前缀不许写进白名单：它们是 shell 的语法，不是命令的词。 */
const PREFIX_FORBIDDEN = /[*?`$;&|<>()\\\n\r!'{}^%"']/

/**
 * 把设置页里的一行字解析成白名单前缀。
 *
 * @param text - 一行前缀，例如 `pnpm run build` 或 `git diff *`。
 * @returns 解析好的词元数组，或一句说明哪里不能用。
 */
export function parsePrefixEntry(text: string): PrefixParse {
  const tokens = text.trim().split(/\s+/).filter((token) => token !== '')
  if (tokens.length === 0) return { ok: false, error: '空的一行' }
  const starAt = tokens.indexOf('*')
  if (starAt >= 0 && starAt !== tokens.length - 1) return { ok: false, error: '`*` 只能放在末尾' }
  for (const token of tokens) {
    if (token === '*') continue
    if (PREFIX_FORBIDDEN.test(token)) return { ok: false, error: `词元「${token}」里有 shell 特殊字符` }
  }
  return { ok: true, pattern: tokens }
}

/**
 * 检查一条 deny glob 能不能用。
 *
 * @param text - 一行 glob，例如 `*etc/passwd*`。
 * @returns 去掉首尾空白后的 glob，或一句说明哪里不能用。
 */
export function parseGlobEntry(text: string): GlobParse {
  const glob = text.trim()
  if (glob === '') return { ok: false, error: '空的一行' }
  if (compiledGlob(glob) === null) return { ok: false, error: '这条 glob 编译不成正则' }
  return { ok: true, glob }
}

/** 把设置页那个文本框切成一条条规则：换行或逗号分隔，空行丢掉。 */
export function splitListText(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * 解析设置页里的一整份前缀清单。
 * @param text - 多行文本（换行或逗号分隔）。
 * @returns 规范化后的前缀清单，或第一处错误。
 */
export function parsePrefixListText(text: string): ListParse {
  const values: string[] = []
  for (const entry of splitListText(text)) {
    const parsed = parsePrefixEntry(entry)
    if (!parsed.ok) return { ok: false, error: `前缀「${entry}」用不了：${parsed.error}` }
    values.push(parsed.pattern.join(' '))
  }
  if (values.length === 0) return { ok: false, error: '白名单不能是空的：要恢复默认值，请在插件配置里删掉 allowPrefixes 这一项' }
  return { ok: true, values }
}

/**
 * 解析设置页里的一整份 deny 黑名单。
 * @param text - 多行文本（换行或逗号分隔）。
 * @returns 规范化后的 glob 清单，或第一处错误。
 */
export function parseGlobListText(text: string): ListParse {
  const values: string[] = []
  for (const entry of splitListText(text)) {
    const parsed = parseGlobEntry(entry)
    if (!parsed.ok) return { ok: false, error: `黑名单「${entry}」用不了：${parsed.error}` }
    values.push(parsed.glob)
  }
  if (values.length === 0) return { ok: false, error: '黑名单不能是空的：要恢复默认值，请在插件配置里删掉 denyGlobs 这一项' }
  return { ok: true, values }
}

/**
 * 把一份原始配置（`resolvePluginConfig` 的返回值）解析成生效配置。
 *
 * 坏值一律回落到默认值并把原因写进 `problems`；调用方据此一律拒，
 * 绝不静默采用半份配置——地板的配置读错了就是 fail-open。
 *
 * @param raw - 原始配置对象，可以是任何东西（磁盘上的东西不受类型系统保证）。
 * @returns 生效配置与配置问题清单。
 */
export function resolveFloorConfig(raw: unknown): FloorConfigResult {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { config: DEFAULT_FLOOR_CONFIG, problems: ['配置不是一个对象'] }
  }
  const doc = raw === null || raw === undefined ? {} : (raw as Record<string, unknown>)
  const problems: string[] = []
  const allowPrefixes = readPrefixes(doc.allowPrefixes, problems)
  const denyGlobs = readGlobs(doc.denyGlobs, problems)
  const maxCommandLength = readInt(doc.maxCommandLength, FLOOR_LIMITS.maxCommandLength, DEFAULT_FLOOR_CONFIG.maxCommandLength, 'maxCommandLength', problems)
  const circuitBreakerThreshold = readInt(
    doc.circuitBreakerThreshold,
    FLOOR_LIMITS.circuitBreakerThreshold,
    DEFAULT_FLOOR_CONFIG.circuitBreakerThreshold,
    'circuitBreakerThreshold',
    problems,
  )
  const circuitBreakerCooldownMs = readInt(
    doc.circuitBreakerCooldownMs,
    FLOOR_LIMITS.circuitBreakerCooldownMs,
    DEFAULT_FLOOR_CONFIG.circuitBreakerCooldownMs,
    'circuitBreakerCooldownMs',
    problems,
  )
  const circuitBreakerEnabled = readBool(doc.circuitBreakerEnabled, DEFAULT_FLOOR_CONFIG.circuitBreakerEnabled, 'circuitBreakerEnabled', problems)
  const unattended = readBool(doc.unattended, DEFAULT_FLOOR_CONFIG.unattended, 'unattended', problems)
  return {
    config: { allowPrefixes, denyGlobs, maxCommandLength, circuitBreakerThreshold, circuitBreakerCooldownMs, circuitBreakerEnabled, unattended },
    problems,
  }
}

function readPrefixes(value: unknown, problems: string[]): readonly (readonly string[])[] {
  if (value === undefined) return DEFAULT_FLOOR_CONFIG.allowPrefixes
  if (!Array.isArray(value)) {
    problems.push('allowPrefixes 要是一串字符串（每条形如 `pnpm run build`）')
    return DEFAULT_FLOOR_CONFIG.allowPrefixes
  }
  const out: string[][] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      problems.push(`allowPrefixes 里混进了非字符串：${JSON.stringify(item)}`)
      continue
    }
    const parsed = parsePrefixEntry(item)
    if (!parsed.ok) {
      problems.push(`allowPrefixes 里的「${item}」用不了：${parsed.error}`)
      continue
    }
    out.push(parsed.pattern)
  }
  return out
}

function readGlobs(value: unknown, problems: string[]): readonly string[] {
  if (value === undefined) return DEFAULT_FLOOR_CONFIG.denyGlobs
  if (!Array.isArray(value)) {
    problems.push('denyGlobs 要是一串字符串（每条形如 `*etc/passwd*`）')
    return DEFAULT_FLOOR_CONFIG.denyGlobs
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      problems.push(`denyGlobs 里混进了非字符串：${JSON.stringify(item)}`)
      continue
    }
    const parsed = parseGlobEntry(item)
    if (!parsed.ok) {
      problems.push(`denyGlobs 里的「${item}」用不了：${parsed.error}`)
      continue
    }
    out.push(parsed.glob)
  }
  return out
}

function readInt(value: unknown, limits: { min: number; max: number }, fallback: number, name: string, problems: string[]): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    problems.push(`${name} 要是一个整数`)
    return fallback
  }
  if (value < limits.min || value > limits.max) {
    problems.push(`${name} 要在 ${limits.min}~${limits.max} 之间，收到 ${value}`)
    return fallback
  }
  return value
}

function readBool(value: unknown, fallback: boolean, name: string, problems: string[]): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    problems.push(`${name} 要是 true 或 false`)
    return fallback
  }
  return value
}

// ---------------------------------------------------------------- 结构可验证性

/** 结构检查的结论。 */
interface StructureReport {
  /** 非 null = 结构没法静态判定，直接拒的理由。 */
  fatal: string | null
  /** `$(...)` 与反引号里的片段（拿去递归再判一次）。 */
  substitutions: string[]
}

/** 命令替换最多往下看几层；再深就按「看不清」拒。 */
const MAX_SUBSTITUTION_DEPTH = 6

/**
 * 扫一遍命令的结构：引号与括号闭合没有、命令替换里是什么。
 *
 * 这些构造只做「括号配对 + 摘出内层片段」，不做完整 shell 语法解析：
 * 判不出来的地方一律让调用方按拒处理。
 */
function inspectStructure(command: string): StructureReport {
  const substitutions: string[] = []
  const stack: Array<{ kind: 'sub' | 'paren'; start: number }> = []
  let quote: '"' | "'" | '`' | null = null
  let tickStart = -1

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!
    if (quote !== null) {
      // 单引号里的一切都是字面量；双引号与反引号里 `\` 可以转义（与 splitSegments 同一套规则）。
      if (quote !== "'" && ch === '\\' && i + 1 < command.length) {
        i += 1
        continue
      }
      if (ch === quote) {
        if (quote === '`' && tickStart >= 0) {
          substitutions.push(command.slice(tickStart + 1, i))
          tickStart = -1
        }
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      if (ch === '`') tickStart = i
      continue
    }
    if (ch === '$' && command[i + 1] === '(') {
      stack.push({ kind: 'sub', start: i + 2 })
      i += 1
      continue
    }
    if (ch === '(') {
      stack.push({ kind: 'paren', start: i })
      continue
    }
    if (ch === ')') {
      const top = stack.pop()
      if (top === undefined) return { fatal: '命令里有一个多余的右括号，配不成对', substitutions }
      if (top.kind === 'sub') substitutions.push(command.slice(top.start, i))
      continue
    }
  }
  if (quote !== null) {
    return { fatal: `命令里的 ${quote === '`' ? '反引号' : `${quote} 引号`}没闭合，没法判定它到底要跑什么`, substitutions }
  }
  if (stack.length > 0) return { fatal: '命令里的括号没闭合，没法判定它到底要跑什么', substitutions }
  return { fatal: null, substitutions }
}

/** 关掉整台机器的命令：只在「命令位置」上认，`grep shutdown` 因此不会被误伤。 */
const POWER_HEADS: Readonly<Record<string, (args: readonly string[]) => string | null>> = {
  shutdown: () => '关机命令会让这台机器停掉',
  reboot: () => '重启命令会让这台机器停掉',
  halt: () => '停机命令会让这台机器停掉',
  poweroff: () => '关机命令会让这台机器停掉',
  init: (args) => (args[0] === '0' || args[0] === '6' ? 'init 切到停机或重启档' : null),
  systemctl: (args) => (['poweroff', 'reboot', 'halt'].includes(args[0] ?? '') ? `systemctl ${args[0]} 会停掉这台机器` : null),
  kill: (args) => (args.includes('-1') ? 'kill -1 会把信号发给一大批进程' : null),
}

/** 命令位置上的这些词只是包装，真正的命令在它们后面（`sudo shutdown now` 也是关机）。 */
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'exec', 'nohup', 'time'])

/**
 * 这些 head 加 `-c` / `/c` / `-Command` 就是把脚本塞在参数里，静态判不出它要干什么。
 * `cmd` 必须在内：Windows 上 `cmd /c 任意命令` 是最常见的包装，漏了它地板就把
 * `cmd /c format C:` 当明文命令审，`/c` 明明已经在 {@link INLINE_FLAGS} 里。
 */
const SHELL_HEADS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd'])

/** 上面那类 shell 的「脚本在参数里」开关。 */
const INLINE_FLAGS = new Set(['-c', '/c', '-command', '--command', '-encodedcommand', '-enc'])

/** 命中这些内置危险模式时，命令内容根本不是明文命令（编码过、或者下载下来直接喂给 shell）。 */
const OPAQUE_DANGER_NAMES = new Set(['encoded-command', 'download-pipe-shell', 'powerShell-iex'])

/** fork 炸弹：`:(){ :|:& };:` 这类自复制函数会把进程表撑爆。 */
const FORK_BOMB = /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}/

/** 取词元的命令名：去掉目录部分与 `.exe`，再转小写。 */
function baseName(token: string): string {
  return token.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '')
}

/** 跳过 `sudo` 这类包装器之后的命令名与它的参数。 */
function effectiveHead(tokens: readonly string[]): { name: string; args: readonly string[] } | null {
  let index = 0
  while (index < tokens.length && WRAPPERS.has(baseName(tokens[index]!))) index += 1
  const head = tokens[index]
  if (head === undefined) return null
  return { name: baseName(head), args: tokens.slice(index + 1) }
}

/** 命令段里的所有文本（原文 + 词元），黑名单 glob 拿去逐条比。 */
function segmentTexts(command: string): string[] {
  const out: string[] = []
  for (const segment of splitSegments(command)) out.push(segment.raw, ...segment.tokens)
  return out
}

/** 内置危险模式的全部命中（整条命令与每一段都看一遍；管道类模式要整条才认得出）。 */
function dangerHits(command: string): Array<{ name: string; reason: string }> {
  const hits = new Map<string, { name: string; reason: string }>()
  const whole = builtinDangerHit(command)
  if (whole !== null) hits.set(whole.name, whole)
  for (const segment of splitSegments(command)) {
    const hit = builtinDangerHit(segment.raw)
    if (hit !== null) hits.set(hit.name, hit)
  }
  return [...hits.values()]
}

/** 命令内容不是明文的那种构造：编码执行、下载下来直接喂 shell、`sh -c`、`eval`。 */
function opaqueShellReason(command: string): string | null {
  for (const hit of dangerHits(command)) {
    if (OPAQUE_DANGER_NAMES.has(hit.name)) return `命令里有「${hit.reason}」这类构造，内容不是明文命令`
  }
  for (const segment of splitSegments(command)) {
    const head = effectiveHead(segment.tokens)
    if (head === null) continue
    if (head.name === 'eval') return 'eval 会把字符串当命令跑，静态判不出它要干什么'
    if (!SHELL_HEADS.has(head.name)) continue
    // `sh -c'rm -rf /'` 这种写法在词元化之后 `-c` 会和脚本粘成一个词元，所以还要按前缀认一次。
    for (const token of head.args) {
      const lowered = token.toLowerCase()
      if (INLINE_FLAGS.has(lowered)) return `${head.name} ${lowered} 把脚本塞在参数里，静态判不出它要干什么`
      if (lowered.startsWith('-c') && lowered.length > 2 && !/^-[a-z]+$/.test(lowered)) {
        return `${head.name} -c 把脚本塞在参数里，静态判不出它要干什么`
      }
    }
  }
  return null
}

/** 灾难地板自己补的那部分：fork 炸弹与关机/重启类命令；`rm -rf /`、`dd of=/dev/sd*` 由硬地板规则负责。 */
function doomReason(command: string): string | null {
  if (FORK_BOMB.test(command)) return 'fork 炸弹会把机器的进程表撑爆，机器直接卡死'
  for (const segment of splitSegments(command)) {
    const head = effectiveHead(segment.tokens)
    if (head === null) continue
    const reason = POWER_HEADS[head.name]?.(head.args) ?? null
    if (reason !== null) return reason
  }
  return null
}

// ---------------------------------------------------------------- 黑名单 glob

/** 编译过的 glob（同一份配置每次判定都要用，没必要每回重编）。 */
const GLOB_CACHE = new Map<string, RegExp>()

/** 正则里要按字面量处理的字符。 */
const REGEXP_SPECIAL = /[\\^$.[\]{}()|+*?/]/

/** glob → 正则：`*` 配任意字符（含路径分隔符），`?` 配一个字符，其余按字面量。 */
function compiledGlob(glob: string): RegExp | null {
  const cached = GLOB_CACHE.get(glob)
  if (cached !== undefined) return cached
  let out = ''
  for (const ch of glob) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += REGEXP_SPECIAL.test(ch) ? `\\${ch}` : ch
  }
  let re: RegExp
  try {
    re = new RegExp(`^${out}$`, 'i')
  } catch (error) {
    // 吞掉的是正则编译错误本身：转义已覆盖全部特殊字符，正常到不了这里；真到了就返回 null，
    // 由 parseGlobEntry 当成配置问题报出来——判不了的黑名单不许静默失效。
    void error
    return null
  }
  GLOB_CACHE.set(glob, re)
  return re
}

/** 这些文本里有没有命中黑名单；命中返回那条 glob（说给模型听）。 */
function globHit(texts: readonly string[], globs: readonly string[]): string | null {
  for (const glob of globs) {
    const re = compiledGlob(glob)
    if (re === null) continue
    if (texts.some((text) => re.test(text))) return glob
  }
  return null
}

// ---------------------------------------------------------------- 判定

/** 是哪一层给出的结论（诊断与自检按它对号入座）。 */
export type FloorLayer =
  /** 配置读不通，按最严处理。 */
  | 'config'
  /** 熔断冷却中。 */
  | 'circuit'
  /** 结构不可验证：引号括号、超长命令、编码执行、`sh -c`、命令替换。 */
  | 'opaque'
  /** 灾难地板：fork 炸弹、关机重启、硬地板规则。 */
  | 'disaster'
  /** 用户 deny 黑名单或 deny 前缀规则。 */
  | 'deny-list'
  /** 内置危险模式，交给审批问人。 */
  | 'dangerous'
  /** 无人值守：ask 级命令与工作区外的写。 */
  | 'unattended'
  /** 命中白名单，不弹卡。 */
  | 'allowlist'
  /** 地板没意见。 */
  | 'none'

/** 一次判定的完整结论（比守卫裁决多带一层与一句理由，便于审计与 `/floor`）。 */
export type FloorOutcome =
  | { action: 'deny'; layer: FloorLayer; reason: string }
  | { action: 'defer'; layer: FloorLayer; reason: string }

/** 首次出现这些字符的 prepend 命令不再走白名单：管道、分号、子 shell、变量、重定向都在里面。 */
const WHITELIST_FORBIDDEN = ['`', '$', ';', '&', '|', '<', '>', '(', ')', '\\', '\n', '\r', '!', '{', '}', '^', '%', '"', "'"]

/** 白名单前缀匹配（照 codex `execpolicy/src/rule.rs` 的前缀匹配：按序匹配词元）。 */
function whitelistHit(command: string, config: FloorConfig): string[] | null {
  const segments = splitSegments(command)
  // 多段命令不给白名单：段与段之间怎么组合不在前缀的射程里。
  if (segments.length !== 1) return null
  const segment = segments[0]!
  // 带重定向 / 通配符 / 变量赋值的段不许走规则（codex 的同一条告诫，这里复用判定引擎自己的标记）。
  if (segment.ruleUnfriendly) return null
  for (const ch of WHITELIST_FORBIDDEN) {
    if (command.includes(ch)) return null
  }
  for (const pattern of config.allowPrefixes) {
    const probe: PrefixRule = { pattern: [...pattern], decision: 'allow', justification: 'approval-floor 白名单' }
    const verdict = classifyCommand(command, { rules: [probe] })
    // 按对象身份比对：决定必须是我们这条临时规则给出的，
    // 不能因为「这条命令恰好是只读的」就冒充白名单放行。
    if (verdict.decision === 'allow' && verdict.matchedRule === probe) return [...pattern]
  }
  return null
}

/** 逐层判定一次调用。每一层的理由写在分支旁边。 */
function evaluate(input: ToolGuardInput, config: FloorConfig, rules: readonly PrefixRule[]): FloorOutcome {
  const command = input.command?.trim() ?? ''
  const target = input.target

  // 只读工具不归地板管：读文件越界由路径护栏负责，地板只关心「跑什么」与「写哪里」。
  if (input.risk === 'read') return { action: 'defer', layer: 'none', reason: '只读工具不归地板管' }

  if (command === '') {
    if (target === undefined) return { action: 'defer', layer: 'none', reason: '既没有命令也没有写目标，交给后面的守卫' }
    const hit = globHit([target], config.denyGlobs)
    if (hit !== null) return { action: 'deny', layer: 'deny-list', reason: `写目标命中用户 deny 黑名单（${hit}）` }
    if (config.unattended && !isInsideCwd(input.cwd, target)) {
      return { action: 'deny', layer: 'unattended', reason: `无人值守场景只放行工作区内的写入，这次是 ${target}` }
    }
    return { action: 'defer', layer: 'none', reason: '写目标没命中黑名单，交给审批' }
  }

  // 第 1 层：结构不可验证。判不出它到底要跑什么，就没人能保证它安全，因此直接拒。
  if (command.length > config.maxCommandLength) {
    return { action: 'deny', layer: 'opaque', reason: `命令有 ${command.length} 个字符，超过上限 ${config.maxCommandLength}，看不清要跑什么` }
  }
  const structure = inspectStructure(command)
  if (structure.fatal !== null) return { action: 'deny', layer: 'opaque', reason: structure.fatal }
  const opaque = opaqueShellReason(command)
  if (opaque !== null) return { action: 'deny', layer: 'opaque', reason: opaque }

  const verdict = classifyCommand(command, { rules })

  // 第 2 层：灾难地板。硬地板规则（`rm -rf /`、`dd of=/dev/sd*` 这类）由策略引擎给，
  // fork 炸弹与关机重启命令由这里补——它们在命令位置上认，不会误伤 `grep shutdown`。
  if (verdict.hardline) return { action: 'deny', layer: 'disaster', reason: `${verdict.reason}（灾难性动作，任何权限模式都不放行）` }
  const doom = doomReason(command)
  if (doom !== null) return { action: 'deny', layer: 'disaster', reason: `${doom}（任何权限模式都不放行）` }

  // 命令替换与反引号里的片段递归再判一次：`echo $(rm -rf /)` 外层看不出灾难，内层看得出。
  for (const fragment of structure.substitutions) {
    const inner = innerDenyReason(fragment, config, rules, 1)
    if (inner !== null) return { action: 'deny', layer: 'disaster', reason: `命令替换里的片段被判为灾难性动作：${inner}` }
  }
  // 内层干净也不放行：外层的实际效果是两段拼出来的，静态判不出，只能拒（fail-closed）。
  if (structure.substitutions.length > 0) {
    return { action: 'deny', layer: 'opaque', reason: '命令里有 $(...) 或反引号，里外两层拼起来的实际效果判不出来' }
  }

  // 第 3 层：用户 deny 黑名单与 deny 前缀规则。排在权限模式与审批之前，
  // 「完全访问」因此在审批层放行不了它（`plugins/approval.ts:334-337` 那条路径直接被抄掉）。
  const hit = globHit([command, ...segmentTexts(command)], config.denyGlobs)
  if (hit !== null) return { action: 'deny', layer: 'deny-list', reason: `命令命中用户 deny 黑名单（${hit}）` }
  if (verdict.matchedRule !== null && verdict.matchedRule.decision === 'deny') {
    return {
      action: 'deny',
      layer: 'deny-list',
      reason: `用户规则禁止：${verdict.matchedRule.justification ?? verdict.matchedRule.pattern.join(' ')}`,
    }
  }

  // 第 4 层：内置危险模式。有人看着就交给审批卡（defer），无人值守时没有卡可弹，只能拒。
  const dangers = dangerHits(command)
  if (dangers.length > 0) {
    const reason = dangers.map((danger) => danger.reason).join('；')
    if (config.unattended) return { action: 'deny', layer: 'unattended', reason: `无人值守场景不放行危险命令：${reason}` }
    return { action: 'defer', layer: 'dangerous', reason: `危险命令（${reason}），交给审批卡问人` }
  }

  // 第 5 层：命令白名单。命中不等于「链条到此为止」——地板只把结论交出去，
  // 由审批层按 {@link ApprovalFloor} 的 whitelist() 免卡放行。地板自己 return pass 会连同
  // 后面的安全钩子（order 20）与生命周期钩子（order 25）一起跳掉，那不是白名单的本意。
  if (whitelistHit(command, config) !== null) {
    return { action: 'defer', layer: 'allowlist', reason: '命中白名单前缀，交给审批层免卡放行' }
  }

  // 无人值守没有卡可弹：白名单之外、需要确认的命令一律拒（ask 等于拒，与免打扰档同一条道理）。
  if (config.unattended && verdict.decision !== 'allow') {
    return { action: 'deny', layer: 'unattended', reason: `无人值守场景不弹审批卡，需要确认的命令一律拒：${verdict.reason}` }
  }

  return { action: 'defer', layer: 'none', reason: '地板没意见，交给后面的守卫' }
}

/** 命令替换片段里的灾难性判定：只看「判不了」与「灾难」两类，理由里不带前缀。 */
function innerDenyReason(command: string, config: FloorConfig, rules: readonly PrefixRule[], depth: number): string | null {
  const text = command.trim()
  if (text === '') return null
  if (depth > MAX_SUBSTITUTION_DEPTH) return `命令替换嵌套超过 ${MAX_SUBSTITUTION_DEPTH} 层`
  if (text.length > config.maxCommandLength) return `命令替换里的片段太长（${text.length} 个字符）`
  const structure = inspectStructure(text)
  if (structure.fatal !== null) return structure.fatal
  const opaque = opaqueShellReason(text)
  if (opaque !== null) return opaque
  const verdict = classifyCommand(text, { rules })
  if (verdict.hardline) return verdict.reason
  const doom = doomReason(text)
  if (doom !== null) return doom
  for (const fragment of structure.substitutions) {
    const inner = innerDenyReason(fragment, config, rules, depth + 1)
    if (inner !== null) return inner
  }
  if (structure.substitutions.length > 0) return '片段里还套着命令替换，拼不出实际效果'
  const hit = globHit([text, ...segmentTexts(text)], config.denyGlobs)
  if (hit !== null) return `命中用户 deny 黑名单（${hit}）`
  if (verdict.matchedRule !== null && verdict.matchedRule.decision === 'deny') {
    return `用户规则禁止：${verdict.matchedRule.justification ?? verdict.matchedRule.pattern.join(' ')}`
  }
  return null
}

// ---------------------------------------------------------------- 守卫

/** 熔断状态（`/floor` 与自检读它）。 */
export interface BreakerState {
  /** 目前连续被地板拒了几次。 */
  consecutiveDenies: number
  /** 熔断解除的时间戳（毫秒）；0 = 没在熔断。 */
  openUntil: number
  /** 此刻是否处于熔断中。 */
  tripped: boolean
}

/** {@link createApprovalFloor} 的入参。 */
export interface ApprovalFloorOptions {
  /** 每次判定现读配置：磁盘上的改动能立刻生效，坏配置由 `problems` 报出来。 */
  readConfig: () => FloorConfigResult
  /** 当前生效的用户前缀规则（与审批读同一份，避免两处判定不一致）。 */
  rules: () => readonly PrefixRule[]
  /** 当前时间（自检可以把时钟说快一点）。 */
  now?: () => number
}

/** 灾难地板：一位守卫 + 它的熔断状态。 */
export interface ApprovalFloor {
  /** 挂到守卫链上的那一位（order 5）。 */
  readonly guard: ToolGuard
  /**
   * 这条命令在不在白名单里（命中就返回那串词元）。
   *
   * 地板自己不放行、只交出结论：审批层拿它免掉审批卡，而排在两者之间的安全钩子照常被问到。
   */
  whitelist(command: string): readonly string[] | null
  /** 当前熔断状态。 */
  breaker(): BreakerState
  /** 清掉连续拒绝计数与熔断（切会话或用户改完配置时用）。 */
  reset(): void
}

/**
 * 组装灾难地板。
 *
 * 配置读不通时守卫照样挂载、却一律拒：挂载失败等于链上根本没有地板，
 * 那是 fail-open——比「全部拒掉、让用户看见问题去改」危险得多。
 *
 * 熔断只统计地板自己的 deny：地板排在审批前面，看不到审批最终怎么裁，
 * 所以「连续被拒」不是「用户连续拒绝」，只是「同一条路反复撞在同一个坑里」。
 *
 * @param options - 见 {@link ApprovalFloorOptions}。
 * @returns 守卫与它的状态读写。
 */
export function createApprovalFloor(options: ApprovalFloorOptions): ApprovalFloor {
  const now = options.now ?? (() => Date.now())
  let consecutiveDenies = 0
  let openUntil = 0

  /** 结论落定之后更新熔断计数并落审计，最后转成守卫裁决。 */
  const settle = (outcome: FloorOutcome, input: ToolGuardInput, config: FloorConfig, countIt: boolean): ToolGuardVerdict => {
    if (countIt) {
      if (outcome.action === 'deny') {
        consecutiveDenies += 1
        if (config.circuitBreakerEnabled && consecutiveDenies >= config.circuitBreakerThreshold) {
          openUntil = now() + config.circuitBreakerCooldownMs
          consecutiveDenies = 0
        }
      } else {
        consecutiveDenies = 0
      }
    }
    if (outcome.action === 'defer') return { action: 'defer' }
    audit({
      ts: Date.now(),
      kind: 'auto-deny',
      tool: input.toolName,
      summary: argsSummary(input.args ?? {}).slice(0, 200),
      reason: outcome.reason,
      decision: 'blocked',
      cwd: input.cwd,
    })
    return { action: 'deny', reason: `灾难地板拒绝：${outcome.reason}` }
  }

  const guard: ToolGuard = {
    id: 'approval-floor',
    order: 5,
    decide(input) {
      const { config, problems } = options.readConfig()
      // 配置坏掉：一律拒，且不计入熔断（否则理由会被熔断盖住，用户看不到真正的问题）。
      if (problems.length > 0) {
        return settle(
          { action: 'deny', layer: 'config', reason: `配置读不通，按最严处理一律拒：${problems.join('；')}` },
          input,
          config,
          false,
        )
      }
      const at = now()
      if (openUntil !== 0 && at >= openUntil) {
        openUntil = 0
        consecutiveDenies = 0
      }
      if (openUntil !== 0) {
        const seconds = Math.max(1, Math.ceil((openUntil - at) / 1000))
        return settle(
          { action: 'deny', layer: 'circuit', reason: `连续被拒 ${config.circuitBreakerThreshold} 次，熔断冷却中（还有约 ${seconds} 秒），这段时间一律拒` },
          input,
          config,
          // 熔断期间的拒不再计数：否则模型每重试一次就续一次冷却，永远恢复不了。
          false,
        )
      }
      return settle(evaluate(input, config, options.rules()), input, config, true)
    },
  }

  return {
    guard,
    whitelist: (command) => whitelistHit(command, options.readConfig().config),
    breaker: () => ({ consecutiveDenies, openUntil, tripped: openUntil !== 0 && now() < openUntil }),
    reset: () => {
      consecutiveDenies = 0
      openUntil = 0
    },
  }
}
