/**
 * 钩子引擎：用户在工具动手之前自己加的一道闸，用来挡住「模型这次手滑」。
 *
 * 两种钩子：
 *   1. 规则——界面里填的一行字：管哪个工具、看哪个字段、命中什么模式、是拦下来还是问人。
 *      不启动任何进程，日常够用。
 *   2. 脚本——一条外部命令。它的 stdin 收到这次调用的 JSON，用退出码或 stdout 的 JSON 回话。
 *      要跑自己那套检查逻辑（比如「本项目禁止碰 migrations 目录」）才需要它。
 *
 * 与 `~/.dsc/policy.rules` 的分工：那份文件管「这条命令算几危险」，只认 bash 的命令文本，
 * 结论是给审批环节参考的 allow/ask/deny；这里的规则管**所有**工具（读、写、改、执行都算），
 * 并且只有加严的本事——它没有「自动放行」这一档，要放宽请回 policy.rules 写前缀规则。
 *
 * 配置在 `~/.dsc/hooks.json`（读到哪算哪、每次写全量）。脚本第一次要执行时得用户批准一次，
 * 批准记在 `~/.dsc/hooks-trusted.json`，批准时记下脚本文件的修改时间，脚本改动后停止执行并要求重批。
 *
 * 失败方向刻意与 dsh / Hermes 相反：那两家遇到脚本超时、命令起不来、输出看不懂时一律放行
 * （`agent/shell_hooks.py:388-395` 的 fail open）。dsc 默认按「拦下来」处理，
 * 因为这道闸存在的意义就是挡意外，一扇坏了的门不该等于没有门；想退回放行有开关
 * （`settings.scriptFailClosed`）。
 *
 * @module dsc/core/hooks
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { redact, scrubChildEnv } from './secrets.js'
import type { ToolGuardInput } from './tool-guards.js'
import { dscPath } from './path-policy.js'

/** 钩子配置文件（与 settings.json、audit.jsonl 同级）。 */
export const HOOKS_FILE = dscPath('hooks.json')
/** 脚本钩子的批准名单（与配置文件分开存：批准是「人对某条命令表过态」，不该跟着配置一起被覆盖）。 */
export const HOOK_TRUST_FILE = dscPath('hooks-trusted.json')

/**
 * 钩子事件。只有 `pre-tool` 有裁决权，其余三个是观察者：
 * 它们的脚本照样跑、照样能把话留在会话里，但改不了已经发生或即将发生的事。
 */
export const HOOK_EVENTS = ['pre-tool', 'post-tool', 'session-start', 'turn-end'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** 规则拿去比对的字段：命令原文、写目标路径、参数 JSON，或者三者全看。 */
export const HOOK_RULE_FIELDS = ['command', 'target', 'args', 'any'] as const
export type HookRuleField = (typeof HOOK_RULE_FIELDS)[number]

/** 规则命中后的动作。刻意没有 allow：钩子只能加严，放宽归 `policy.rules` 管。 */
export const HOOK_RULE_ACTIONS = ['deny', 'ask'] as const
export type HookRuleAction = (typeof HOOK_RULE_ACTIONS)[number]

/** 脚本单次执行的缺省超时、下限、上限（毫秒）。脚本是闸门，不是后台任务。 */
export const HOOK_TIMEOUT_DEFAULT = 10_000
export const HOOK_TIMEOUT_MIN = 500
export const HOOK_TIMEOUT_MAX = 120_000
/** 规则与脚本的条数上限、正则与理由的字数上限。 */
export const HOOK_MAX_RULES = 200
export const HOOK_MAX_SCRIPTS = 50
export const HOOK_PATTERN_MAX = 300
export const HOOK_REASON_MAX = 200
/** 脚本的 stderr 有多少字可以当成阻断理由。 */
export const HOOK_STDERR_MAX = 400
/** 回到模型跟审批卡上的那句理由最长多少字（与 Hermes 进上下文的夹取一致）。 */
export const HOOK_MESSAGE_MAX = 2048
/** 脚本 stdout 最多读多少字（再多就是拿用户的内存换没用的输出）。 */
export const HOOK_STDOUT_MAX = 64 * 1024

/** 界面规则：工具名 + 字段 + 正则 + 动作 + 理由。 */
export interface HookRule {
  id: string
  enabled: boolean
  /** 管哪些工具：`*` 或空 = 全部；否则是 `|` 或 `,` 分隔的工具名，不区分大小写。 */
  tool: string
  field: HookRuleField
  /** 不区分大小写的正则；写成正解不开时退化成「整串当字面量找子串」。 */
  pattern: string
  action: HookRuleAction
  /** 命中后回给模型与用户的原因。留空就用内置文案。 */
  reason: string
}

/** 脚本钩子。 */
export interface HookScript {
  id: string
  enabled: boolean
  event: HookEvent
  /** 工具名过滤器，只在 `pre-tool` / `post-tool` 上有意义：`*` 或空 = 全部，否则是不锚定的正则。 */
  matcher: string
  /** 交给 shell 执行的命令原文（`node C:\hooks\guard.js` 这种）。 */
  command: string
  /** 这一次执行给多少时间；0 = 用全局缺省值。 */
  timeoutMs: number
  /** 这一条要不要「跑不成就拦」（覆盖全局开关）。 */
  failClosed: boolean
}

/** 钩子的全局可调项。 */
export interface HookSettings {
  /** 总开关：关掉时守卫直接不表态，脚本也不跑（留着配置，随时能开回来）。 */
  enabled: boolean
  /** 脚本没单独写超时时给多少毫秒。 */
  scriptTimeoutMs: number
  /** 脚本超时、起不来、输出看不懂时是否按「拦下来」处理。 */
  scriptFailClosed: boolean
  /** 新增脚本是否免批准直接执行（默认关：等于把任意代码执行入口交给一个 JSON 文件）。 */
  autoAccept: boolean
}

/** 配置文件读出来的完整内容（`problems` 是读的时候发现的毛病，界面原样显示）。 */
export interface HooksDoc {
  settings: HookSettings
  rules: HookRule[]
  scripts: HookScript[]
  problems: string[]
}

/** 一次工具调用摊开给规则比对的三个文本。 */
export interface HookFacts {
  toolName: string
  command: string
  target: string
  argsText: string
}

/** 钩子给出的四种结论。`note` = 不拦，但把这句话留在会话里。 */
export type HookAction = 'block' | 'ask' | 'note' | 'pass'

/** 一条规则或一个脚本给出的裁决。 */
export interface HookJudgement {
  action: HookAction
  /** 说给模型与人听的原因（`pass` 时可以为空）。 */
  message: string
  /** 谁给的结论（规则/脚本的展示名），进审计与界面。 */
  source: string
  /** 脚本执行耗时（规则没有，为 0）。 */
  ms: number
  /** 执行环节本身的问题（超时、起不来、输出看不懂），进审计与界面提示。 */
  problem: string
}

const DEFAULT_SETTINGS: HookSettings = {
  enabled: true,
  scriptTimeoutMs: HOOK_TIMEOUT_DEFAULT,
  scriptFailClosed: true,
  autoAccept: false,
}

const EMPTY_DOC: HooksDoc = { settings: { ...DEFAULT_SETTINGS }, rules: [], scripts: [], problems: [] }

// ── 读写配置文件 ─────────────────────────────────────────────────────────────

/** 配置文件的缓存（按 mtime + 大小判新，免得每次工具调用都重读重解析一遍磁盘）。 */
let cache: { mtime: number; size: number; doc: HooksDoc } | null = null

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), min), max) : fallback
}

function asString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max).trim() : ''
}

function newId(): string {
  return randomUUID().slice(0, 8)
}

/** 把磁盘上的任意内容读成一份能用的配置；坏掉的条目跳过并把原因记进 `problems`。 */
function normalize(raw: unknown): HooksDoc {
  const doc: HooksDoc = { settings: { ...DEFAULT_SETTINGS }, rules: [], scripts: [], problems: [] }
  if (raw === null || typeof raw !== 'object') return doc
  const source = raw as Record<string, unknown>
  const settings = (source.settings ?? {}) as Record<string, unknown>
  doc.settings.enabled = settings.enabled !== false
  doc.settings.scriptTimeoutMs = clamp(settings.scriptTimeoutMs, HOOK_TIMEOUT_MIN, HOOK_TIMEOUT_MAX, HOOK_TIMEOUT_DEFAULT)
  doc.settings.scriptFailClosed = settings.scriptFailClosed !== false
  doc.settings.autoAccept = settings.autoAccept === true

  if (Array.isArray(source.rules)) {
    for (const item of source.rules as unknown[]) {
      const rule = normalizeRule(item)
      if (rule === null) doc.problems.push('有一条规则不是可识别的样子，已跳过（缺 pattern 或动作不认）')
      else if (rule.pattern !== '') doc.rules.push(rule)
      else doc.problems.push(`规则 ${rule.id} 没有填模式，已跳过（空模式会命中一切，太危险）`)
    }
    if (doc.rules.length > HOOK_MAX_RULES) {
      doc.problems.push(`规则条数超过 ${HOOK_MAX_RULES} 条，多出来的已忽略`)
      doc.rules = doc.rules.slice(0, HOOK_MAX_RULES)
    }
  }

  if (Array.isArray(source.scripts)) {
    for (const item of source.scripts as unknown[]) {
      const script = normalizeScript(item)
      if (script === null) doc.problems.push('有一条脚本钩子不是可识别的样子，已跳过（缺 command 或事件名不认）')
      else doc.scripts.push(script)
    }
    if (doc.scripts.length > HOOK_MAX_SCRIPTS) {
      doc.problems.push(`脚本条数超过 ${HOOK_MAX_SCRIPTS} 条，多出来的已忽略`)
      doc.scripts = doc.scripts.slice(0, HOOK_MAX_SCRIPTS)
    }
  }
  return doc
}

function normalizeRule(item: unknown): HookRule | null {
  if (item === null || typeof item !== 'object') return null
  const raw = item as Record<string, unknown>
  const pattern = asString(raw.pattern, HOOK_PATTERN_MAX)
  const action = asString(raw.action, 16).toLowerCase()
  if (pattern === '' || (action !== 'deny' && action !== 'ask')) return null
  return {
    id: asString(raw.id, 32) === '' ? newId() : asString(raw.id, 32),
    enabled: raw.enabled !== false,
    tool: asString(raw.tool, 120) === '' ? '*' : asString(raw.tool, 120),
    field: (HOOK_RULE_FIELDS as readonly string[]).includes(asString(raw.field, 16))
      ? (asString(raw.field, 16) as HookRuleField)
      : 'any',
    pattern,
    action: action as HookRuleAction,
    reason: asString(raw.reason, HOOK_REASON_MAX),
  }
}

function normalizeScript(item: unknown): HookScript | null {
  if (item === null || typeof item !== 'object') return null
  const raw = item as Record<string, unknown>
  const command = asString(raw.command, 1000)
  const event = asString(raw.event, 24)
  if (command === '' || !(HOOK_EVENTS as readonly string[]).includes(event)) return null
  return {
    id: asString(raw.id, 32) === '' ? newId() : asString(raw.id, 32),
    enabled: raw.enabled !== false,
    event: event as HookEvent,
    matcher: asString(raw.matcher, 120) === '' ? '*' : asString(raw.matcher, 120),
    command,
    timeoutMs: clamp(raw.timeoutMs, 0, HOOK_TIMEOUT_MAX, 0),
    failClosed: raw.failClosed !== false,
  }
}

/**
 * 读钩子配置（缓存命中就直接返回旧份）。
 *
 * 文件读不出来或不是合法 JSON 时返回空配置并把原因带回去：
 * 配置文件写坏不该让工具调用崩掉，但必须看得见为什么没生效。
 */
export function readHooks(): HooksDoc {
  let stat: ReturnType<typeof statSync> | null = null
  try {
    stat = existsSync(HOOKS_FILE) ? statSync(HOOKS_FILE) : null
  } catch (error) {
    const doc: HooksDoc = { ...EMPTY_DOC, settings: { ...DEFAULT_SETTINGS }, problems: [] }
    doc.problems.push(`钩子配置读不到：${error instanceof Error ? error.message : String(error)}`)
    return doc
  }
  if (stat === null) return { ...EMPTY_DOC, settings: { ...DEFAULT_SETTINGS }, rules: [], scripts: [], problems: [] }
  if (cache !== null && cache.mtime === stat.mtimeMs && cache.size === stat.size) return cache.doc
  let doc: HooksDoc
  try {
    doc = normalize(JSON.parse(readFileSync(HOOKS_FILE, 'utf8')))
  } catch (error) {
    doc = { ...EMPTY_DOC, settings: { ...DEFAULT_SETTINGS }, rules: [], scripts: [] }
    doc.problems.push(`钩子配置不是合法 JSON，这一份没生效：${error instanceof Error ? error.message : String(error)}`)
  }
  cache = { mtime: stat.mtimeMs, size: stat.size, doc }
  return doc
}

/** 全量写配置（写完让缓存失效，下一次判定立刻用新内容）。 */
function writeHooks(doc: HooksDoc): void {
  const body = { version: 1, settings: doc.settings, rules: doc.rules, scripts: doc.scripts }
  mkdirSync(dscPath(), { recursive: true })
  writeFileSync(HOOKS_FILE, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  cache = null
}

/** 带着新内容重写配置的公共入口（增删改都从这里过，避免多处各自拼 JSON）。 */
function mutate(fn: (draft: HooksDoc) => string | void): string | void {
  const doc = readHooks()
  const draft: HooksDoc = {
    settings: { ...doc.settings },
    rules: doc.rules.map((rule) => ({ ...rule })),
    scripts: doc.scripts.map((script) => ({ ...script })),
    problems: [...doc.problems],
  }
  const problem = fn(draft)
  if (problem !== undefined && problem !== null) return problem
  writeHooks(draft)
  return undefined
}

/**
 * 加一条规则。
 * @param input - 规则内容（`id` 由这里生成）。
 * @returns 成功给新 id，失败给用户看得懂的原因。
 */
export function addRule(input: {
  tool: string
  field: HookRuleField
  pattern: string
  action: HookRuleAction
  reason: string
}): { ok: true; id: string } | { ok: false; error: string } {
  const pattern = input.pattern.trim()
  if (pattern === '') return { ok: false, error: '模式不能空着：空模式会命中所有工具' }
  if (pattern.length > HOOK_PATTERN_MAX) return { ok: false, error: `模式最长 ${HOOK_PATTERN_MAX} 字` }
  try {
    new RegExp(pattern, 'i')
  } catch (error) {
    return { ok: false, error: `这个正则用不了：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!(HOOK_RULE_ACTIONS as readonly string[]).includes(input.action)) {
    return { ok: false, error: '动作只认「拦下来」或「问人」' }
  }
  const rule: HookRule = {
    id: newId(),
    enabled: true,
    tool: input.tool.trim() === '' ? '*' : input.tool.trim(),
    field: (HOOK_RULE_FIELDS as readonly string[]).includes(input.field) ? input.field : 'any',
    pattern,
    action: input.action,
    reason: input.reason.trim().slice(0, HOOK_REASON_MAX),
  }
  const failure = mutate((draft) => {
    if (draft.rules.length >= HOOK_MAX_RULES) return `规则最多 ${HOOK_MAX_RULES} 条，先删几条`
    draft.rules.push(rule)
  })
  return failure === undefined || failure === null ? { ok: true, id: rule.id } : { ok: false, error: failure }
}

/** 删一条规则（不存在时静默返回，界面上的选择会自动跟上）。 */
export function removeRule(id: string): void {
  mutate((draft) => {
    draft.rules = draft.rules.filter((rule) => rule.id !== id)
  })
}

/** 启停一条规则。 */
export function setRuleEnabled(id: string, enabled: boolean): void {
  mutate((draft) => {
    const rule = draft.rules.find((item) => item.id === id)
    if (rule !== undefined) rule.enabled = enabled
  })
}

/**
 * 加一条脚本钩子。
 *
 * 新加的脚本默认不执行：要么它已经在批准名单里，要么 `settings.autoAccept` 开着，
 * 否则得在界面上点一次「批准」。
 *
 * @param input - 脚本内容。
 * @returns 成功给新 id，失败给原因。
 */
export function addScript(input: {
  event: HookEvent
  matcher: string
  command: string
  timeoutMs?: number
  failClosed?: boolean
}): { ok: true; id: string } | { ok: false; error: string } {
  const command = input.command.trim()
  if (command === '') return { ok: false, error: '命令不能空着' }
  if (command.length > 1000) return { ok: false, error: '命令最长 1000 字' }
  if (!(HOOK_EVENTS as readonly string[]).includes(input.event)) return { ok: false, error: '事件名不认' }
  const script: HookScript = {
    id: newId(),
    enabled: true,
    event: input.event,
    matcher: input.matcher.trim() === '' ? '*' : input.matcher.trim().slice(0, 120),
    command,
    timeoutMs: input.timeoutMs === undefined ? 0 : clamp(input.timeoutMs, 0, HOOK_TIMEOUT_MAX, 0),
    failClosed: input.failClosed === undefined ? true : input.failClosed,
  }
  const failure = mutate((draft) => {
    if (draft.scripts.length >= HOOK_MAX_SCRIPTS) return `脚本钩子最多 ${HOOK_MAX_SCRIPTS} 条，先删几条`
    draft.scripts.push(script)
  })
  return failure === undefined || failure === null ? { ok: true, id: script.id } : { ok: false, error: failure }
}

/** 删一条脚本钩子。 */
export function removeScript(id: string): void {
  mutate((draft) => {
    draft.scripts = draft.scripts.filter((script) => script.id !== id)
  })
}

/** 启停一条脚本钩子。 */
export function setScriptEnabled(id: string, enabled: boolean): void {
  mutate((draft) => {
    const script = draft.scripts.find((item) => item.id === id)
    if (script !== undefined) script.enabled = enabled
  })
}

/** 改全局可调项，返回改完之后的值（非法数字会被夹回区间）。 */
export function patchHookSettings(patch: Partial<HookSettings>): HookSettings {
  let current = readHooks().settings
  mutate((draft) => {
    if (patch.enabled !== undefined) draft.settings.enabled = patch.enabled
    if (patch.scriptTimeoutMs !== undefined) {
      draft.settings.scriptTimeoutMs = clamp(patch.scriptTimeoutMs, HOOK_TIMEOUT_MIN, HOOK_TIMEOUT_MAX, current.scriptTimeoutMs)
    }
    if (patch.scriptFailClosed !== undefined) draft.settings.scriptFailClosed = patch.scriptFailClosed
    if (patch.autoAccept !== undefined) draft.settings.autoAccept = patch.autoAccept
    current = draft.settings
  })
  return current
}

// ── 脚本批准名单 ─────────────────────────────────────────────────────────────

/** 一次批准：哪个事件上的哪条命令、批准时间、脚本文件与当时的修改时间。 */
interface TrustEntry {
  event: HookEvent
  command: string
  trustedAt: number
  /** 从命令里认出来的脚本文件；认不出来（纯命令行内联）就是空。 */
  scriptPath: string
  /** 批准那一刻脚本文件的修改时间（毫秒）；没有脚本文件时为 0。 */
  scriptMtime: number
}

/** 批准名单文件的内容。 */
interface TrustDoc {
  trusted: TrustEntry[]
}

/** 带扩展名才算「可能是脚本」的后缀（批准时只对这些文件盯修改时间）。 */
const SCRIPT_SUFFIXES = ['.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.bash', '.ps1', '.cmd', '.bat', '.exe', '.rb', '.pl']

/** 把命令串按空格切开，尊重双引号与单引号（够用了：钩子命令都是「解释器 脚本 参数」这一类）。 */
function tokenize(command: string): string[] {
  const out: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(command)) !== null) out.push((match[1] ?? match[2] ?? match[3] ?? '').trim())
  return out.filter((token) => token !== '')
}

/**
 * 从命令里认出被执行的脚本文件。
 *
 * 取第一个「带脚本后缀且真的存在」的词；认不出来返回空串（表示没有可盯的文件，改不了就不算漂移）。
 *
 * @param command - 命令原文。
 */
export function scriptFileOf(command: string): string {
  for (const token of tokenize(command)) {
    const lower = token.toLowerCase()
    if (!SCRIPT_SUFFIXES.some((suffix) => lower.endsWith(suffix))) continue
    try {
      if (existsSync(token) && statSync(token).isFile()) return token
    } catch {
      // 路径里有非法字符就跳过这个词，认不出脚本文件顶多是少了漂移检查
    }
  }
  return ''
}

function readTrust(): TrustDoc {
  try {
    if (!existsSync(HOOK_TRUST_FILE)) return { trusted: [] }
    const raw = JSON.parse(readFileSync(HOOK_TRUST_FILE, 'utf8')) as Record<string, unknown>
    const list = Array.isArray(raw.trusted) ? (raw.trusted as unknown[]) : []
    const trusted: TrustEntry[] = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      const event = typeof entry.event === 'string' ? entry.event : ''
      const command = typeof entry.command === 'string' ? entry.command : ''
      if (!(HOOK_EVENTS as readonly string[]).includes(event) || command === '') continue
      trusted.push({
        event: event as HookEvent,
        command,
        trustedAt: Number(entry.trustedAt) || 0,
        scriptPath: typeof entry.scriptPath === 'string' ? entry.scriptPath : '',
        scriptMtime: Number(entry.scriptMtime) || 0,
      })
    }
    return { trusted }
  } catch {
    // 名单读坏就当没批准过：宁可多问一次，也不要在读不出来的名单上放行任意脚本
    return { trusted: [] }
  }
}

function writeTrust(doc: TrustDoc): void {
  mkdirSync(dscPath(), { recursive: true })
  writeFileSync(HOOK_TRUST_FILE, `${JSON.stringify({ version: 1, trusted: doc.trusted }, null, 2)}\n`, 'utf8')
}

/** 一条脚本的批准状态。 */
export type HookTrustState = 'trusted' | 'untrusted' | 'changed'

/** 批准状态的投影（界面上那一行字由它出）。 */
export interface HookTrust {
  state: HookTrustState
  /** 说给人听的一句话。 */
  detail: string
  /** 认出来的脚本文件（没有就空）。 */
  scriptPath: string
  /** 批准时间（毫秒，0 = 没批准过）。 */
  trustedAt: number
  /** 这条脚本现在到底能不能跑（批准过、且脚本没改动，或者免批准开关开着）。 */
  runnable: boolean
}

/**
 * 查一条脚本钩子现在能不能执行。
 *
 * Hermes 只提示「脚本自批准后被改过」照样跑（`hooks.md:1911`）；dsc 选择停跑并要求重批——
 * 批准的对象是那一份脚本内容，内容换了就是另一件事。
 *
 * @param script - 要查的脚本钩子。
 * @param autoAccept - 设置里的「新脚本不询问」是否开着：开着就不拦执行，但状态仍然照实报，
 *                     界面上看得见这条还没被人点过头。
 */
export function trustOf(script: HookScript, autoAccept = false): HookTrust {
  const scriptPath = scriptFileOf(script.command)
  const entry = readTrust().trusted.find((item) => item.event === script.event && item.command === script.command)
  if (entry === undefined) {
    return {
      state: 'untrusted',
      detail: autoAccept
        ? '没人批准过，但设置里开了「新脚本不询问」，会直接执行'
        : '没批准过，不会执行（在详情里点「批准这条脚本」）',
      scriptPath,
      trustedAt: 0,
      runnable: autoAccept,
    }
  }
  let mtime = entry.scriptMtime
  if (scriptPath !== '') {
    try {
      mtime = statSync(scriptPath).mtimeMs
    } catch {
      // 脚本文件不见了：按漂移处理（脚本被换掉或删掉都不该继续当成批准过的那份）
      mtime = Number.POSITIVE_INFINITY
    }
  }
  if (mtime > entry.scriptMtime) {
    return {
      state: 'changed',
      detail: `脚本自 ${new Date(entry.trustedAt).toLocaleString()} 批准之后被改动过，已停止执行，请重新批准`,
      scriptPath,
      trustedAt: entry.trustedAt,
      runnable: false,
    }
  }
  return { state: 'trusted', detail: '已批准', scriptPath, trustedAt: entry.trustedAt, runnable: true }
}

/**
 * 批准一条脚本（记当前脚本文件的修改时间）。
 * @param id - 脚本 id。
 * @returns 成功给空，失败给原因（找不到这条脚本时）。
 */
export function trustScript(id: string): string | void {
  const doc = readHooks()
  const script = doc.scripts.find((item) => item.id === id)
  if (script === undefined) return '没有这条脚本钩子（可能刚被删掉）'
  const trust = readTrust()
  const scriptPath = scriptFileOf(script.command)
  let scriptMtime = 0
  if (scriptPath !== '') {
    try {
      scriptMtime = statSync(scriptPath).mtimeMs
    } catch (error) {
      return `脚本文件读不到：${error instanceof Error ? error.message : String(error)}`
    }
  }
  trust.trusted = trust.trusted.filter((item) => !(item.event === script.event && item.command === script.command))
  trust.trusted.push({ event: script.event, command: script.command, trustedAt: Date.now(), scriptPath, scriptMtime })
  writeTrust(trust)
}

/** 撤销一条脚本的批准（下一次执行前得重新批准）。 */
export function untrustScript(id: string): void {
  const doc = readHooks()
  const script = doc.scripts.find((item) => item.id === id)
  if (script === undefined) return
  const trust = readTrust()
  trust.trusted = trust.trusted.filter((item) => !(item.event === script.event && item.command === script.command))
  writeTrust(trust)
}

// ── 规则匹配 ─────────────────────────────────────────────────────────────────

/** 正则缓存（同一条规则每次工具调用都重新编译正则是白费的）。 */
const patternCache = new Map<string, RegExp | null>()

/** 工具名是否落在这份清单里：`*`/空 = 全部，否则 `|` 或 `,` 分隔的字面量，不区分大小写。 */
function toolListHit(list: string, toolName: string): boolean {
  const trimmed = list.trim()
  if (trimmed === '' || trimmed === '*') return true
  const wanted = toolName.toLowerCase()
  return trimmed
    .split(/[|,]/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
    .includes(wanted)
}

/** 拿到规则用的正则；正则写坏了就退化成字面量子串（记一条毛病，不让整条链崩掉）。 */
function ruleRegex(pattern: string): { regex: RegExp | null; literal: string } {
  if (patternCache.has(pattern)) {
    const cached = patternCache.get(pattern)
    return { regex: cached ?? null, literal: pattern }
  }
  let regex: RegExp | null = null
  try {
    regex = new RegExp(pattern, 'i')
  } catch {
    regex = null
  }
  patternCache.set(pattern, regex)
  return { regex, literal: pattern }
}

/** 把一次守卫入参摊开成规则要比对的三个文本。 */
export function hookFacts(input: ToolGuardInput): HookFacts {
  return {
    toolName: input.toolName,
    command: input.command ?? '',
    target: input.target ?? '',
    argsText: JSON.stringify(input.args ?? {}),
  }
}

/** 一条规则是否命中这次调用。 */
export function ruleHits(rule: HookRule, facts: HookFacts): boolean {
  if (!toolListHit(rule.tool, facts.toolName)) return false
  const { regex, literal } = ruleRegex(rule.pattern)
  const fields: HookRuleField[] = rule.field === 'any' ? ['command', 'target', 'args'] : [rule.field]
  for (const field of fields) {
    const text = field === 'command' ? facts.command : field === 'target' ? facts.target : facts.argsText
    if (text === '') continue
    if (regex !== null ? regex.test(text) : text.toLowerCase().includes(literal.toLowerCase())) return true
  }
  return false
}

/** 工具名是否被脚本的 matcher 命中（不锚定的正则；写坏了退化成字面量）。 */
export function matcherHits(matcher: string, toolName: string): boolean {
  const trimmed = matcher.trim()
  if (trimmed === '' || trimmed === '*') return true
  const { regex, literal } = ruleRegex(trimmed)
  return regex !== null ? regex.test(toolName) : toolName.toLowerCase().includes(literal.toLowerCase())
}

// ── 脚本执行 ─────────────────────────────────────────────────────────────────

/** 递给脚本的 stdin 载荷（唯一事实来源；环境变量只是便利取用）。 */
export interface HookPayload {
  hook_event_name: HookEvent
  tool_name: string
  tool_input: Record<string, unknown>
  args_summary: string
  session_id: string
  cwd: string
  /** 当时的权限模式与协作模式，脚本可以据此决定要不要拦。 */
  policy: string
  mode: string
  /** 工具这次要动的命令与写目标（认不出来为空串）。 */
  command: string
  target: string
  /** 除工具之外的补充信息（比如 turn-end 的结束原因、工具结果文本）。 */
  extra: Record<string, unknown>
}

/** 一次脚本执行的结果。 */
export interface HookRun {
  exitCode: number
  stdout: string
  stderr: string
  ms: number
  timedOut: boolean
  /** 进程压根没起来的原因（命令不存在、没权限）。 */
  spawnError: string
  /** stdout 是否因为过长被截断。 */
  truncated: boolean
}

function shellOf(): { file: string; args: string[] } {
  return process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c'] }
    : { file: '/bin/sh', args: ['-c'] }
}

/**
 * 跑一条脚本钩子。
 *
 * 命令交给 shell 执行（`cmd.exe /c` 或 `sh -c`），这样「`node guard.js --strict`」这种
 * 带参数、带管道的命令都能照原样写。子进程环境剥过凭据（同 bash 工具），
 * stdin 是唯一事实来源，超时就直接杀进程。
 *
 * @param script - 要跑的脚本钩子。
 * @param payload - 递给 stdin 的载荷（一行 JSON）。
 * @param cwd - 用哪个目录当工作目录（会话目录，不是 dsc 自己的目录）。
 * @param signal - 这一轮的取消信号：用户按打断时杀掉脚本。
 * @param defaultTimeoutMs - 这条脚本没写超时时给多少毫秒。
 * @returns 执行结果（不抛错：脚本怎么坏都体现在返回值里，交给裁决去判）。
 */
export function runHookScript(
  script: HookScript,
  payload: HookPayload,
  cwd: string,
  signal: AbortSignal,
  defaultTimeoutMs: number,
): Promise<HookRun> {
  const timeout = script.timeoutMs > 0 ? script.timeoutMs : defaultTimeoutMs
  const shell = shellOf()
  const started = Date.now()
  return new Promise<HookRun>((resolveDone) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let spawnError = ''
    let done = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell.file, [...shell.args, script.command], {
        cwd,
        env: scrubChildEnv(process.env).env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolveDone({
        exitCode: -1,
        stdout: '',
        stderr: '',
        ms: Date.now() - started,
        timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error),
        truncated: false,
      })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程已经自己退了，杀不掉就不用管
      }
      // Windows 上 `cmd.exe /c` 被杀掉之后，它启动的那个脚本还占着管道，等 'close'
      // 就把一个已经判死的脚本等成了好几秒。超时的输出本来就不该信，直接结清。
      for (const stream of [child.stdout, child.stderr, child.stdin]) {
        try {
          stream?.destroy()
        } catch {
          // 管道已经断了， destroy 二次调用无所谓
        }
      }
      if (process.platform === 'win32' && child.pid !== undefined) {
        // shell 启的那个脚本不归 cmd.exe 的死管，得连整棵进程树一起点名杀
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } catch {
          // 杀不掉也已经有上面的 SIGKILL 兜着
        }
      }
      finish(-1)
    }, timeout)
    const abort = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 同上
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    const finish = (exitCode: number): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolveDone({
        exitCode,
        stdout: redact(stdout),
        stderr: redact(stderr),
        ms: Date.now() - started,
        timedOut,
        spawnError,
        truncated,
      })
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length >= HOOK_STDOUT_MAX) {
        truncated = true
        return
      }
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < HOOK_STDOUT_MAX) stderr += chunk
    })
    child.on('error', (error: Error) => {
      spawnError = error.message
    })
    child.on('close', (code, closeSignal) => {
      finish(spawnError !== '' ? -1 : (code ?? (closeSignal === null ? -1 : 128)))
    })
    try {
      child.stdin?.write(`${JSON.stringify(payload)}\n`)
      child.stdin?.end()
    } catch (error) {
      // 脚本自己没读 stdin 就退出了：不影响裁决，写不进去记一笔
      spawnError = spawnError === '' ? `stdin 写不进去：${error instanceof Error ? error.message : String(error)}` : spawnError
    }
  })
}

/**
 * 把脚本的 stdout 解析成结论。
 *
 * 三套写法都认，因为要让用户手上的现成钩子脚本直接能用：
 *   1. dsc 自己的写法：`{"action":"deny","message":"..."}`，动作认 `deny|block|ask|note|pass`。
 *   2. Claude Code 的写法：`{"decision":"block","reason":"..."}` 或
 *      `{"hookSpecificOutput":{"permissionDecision":"deny"}}`。它的 `approve` 是「自动放行」，
 *      在 dsc 里按「不表态」处理（想表达「交给人确认」请写 `ask`）。
 *   3. Hermes 的写法：`{"action":"approve"}` 表示**交给人确认**，与上面第 2 条意思相反，
 *      所以按用了哪个键来区分（`action` 走 Hermes 语义，`decision` 走 Claude 语义）。
 *
 * @param stdout - 脚本的标准输出。
 * @returns 结论；解析不出来返回 null（由退出码与 failClosed 兜底）。
 */
export function parseScriptVerdict(stdout: string): { action: HookAction; message: string } | null {
  const text = stdout.trim()
  if (!text.startsWith('{')) return null
  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    raw = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const messageOf = (...keys: string[]): string => {
    for (const key of keys) {
      const value = raw[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, HOOK_MESSAGE_MAX)
    }
    return ''
  }
  const map = (action: string, message: string): { action: HookAction; message: string } => {
    const lower = action.toLowerCase()
    if (lower === 'deny' || lower === 'block' || lower === 'prevent' || lower === 'reject') return { action: 'block', message }
    if (lower === 'ask' || lower === 'approve_hermes') return { action: 'ask', message }
    if (lower === 'note' || lower === 'context') return { action: 'note', message }
    return { action: 'pass', message }
  }
  const action = typeof raw.action === 'string' ? raw.action : typeof raw.decision === 'string' ? raw.decision : ''
  if (action !== '') {
    // 同一个词在两家意思相反：`action` 键按 Hermes 读（approve = 交给人批），
    // `decision` 键按 Claude 读（approve = 自动放行）。写清楚，别拿用户的脚本猜。
    const key = typeof raw.action === 'string' ? 'action' : 'decision'
    const normalized = key === 'action' && action.toLowerCase() === 'approve' ? 'approve_hermes' : action
    return map(normalized, messageOf('message', 'reason', 'reasonMessage'))
  }
  const specific = raw.hookSpecificOutput
  if (specific !== null && typeof specific === 'object') {
    const inner = specific as Record<string, unknown>
    const permission = inner.permissionDecision
    if (typeof permission === 'string') {
      const reasonOf = (): string => {
        const value = inner.permissionDecisionReason
        return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, HOOK_MESSAGE_MAX) : ''
      }
      const lower = permission.toLowerCase()
      if (lower === 'deny') return { action: 'block', message: reasonOf() }
      if (lower === 'ask') return { action: 'ask', message: reasonOf() }
      if (lower === 'allow') return { action: 'pass', message: '' }
    }
  }
  return { action: 'pass', message: '' }
}

/** 把一次执行结果折成结论（这里决定 fail-closed 的三种失败形态）。 */
export function judgeScriptRun(run: HookRun, script: HookScript, settings: HookSettings): HookJudgement {
  const source = `脚本 ${script.command.slice(0, 40)}`
  const failClosed = script.failClosed && settings.scriptFailClosed
  const verdict = parseScriptVerdict(run.stdout)
  const note = (problem: string, action: HookAction = 'pass', message = ''): HookJudgement => ({
    action,
    message,
    source,
    ms: run.ms,
    problem,
  })

  if (run.spawnError !== '') {
    const problem = `脚本没能启动：${run.spawnError}`
    return failClosed
      ? note(problem, 'block', `钩子脚本没能启动（${run.spawnError}）。按「脚本没跑成就算拦」处理；不想要这条规矩就把这条脚本停掉或关掉那个开关。`)
      : note(problem)
  }
  if (run.timedOut) {
    const problem = `脚本超时被杀（${run.ms}ms）`
    return failClosed
      ? note(problem, 'block', `钩子脚本没在期限内给出结论，按「脚本没跑成就算拦」处理。`)
      : note(problem)
  }
  if (run.exitCode === 2) {
    if (verdict !== null && verdict.action === 'block') return note('', 'block', verdict.message)
    const reason = run.stderr.trim().slice(0, HOOK_STDERR_MAX)
    return note('', 'block', reason === '' ? '被钩子拦下（脚本以 2 退出，没给原因）' : reason)
  }
  if (verdict !== null) {
    if (verdict.action === 'block') return note('', 'block', verdict.message)
    if (verdict.action === 'ask') return note('', 'ask', verdict.message)
    if (verdict.action === 'note') return note('', 'note', verdict.message)
    if (run.exitCode === 0) return note('')
    return failClosed
      ? note(`脚本以 ${run.exitCode} 退出但给出了放行结论`, 'block', `钩子脚本退出码是 ${run.exitCode}，按「脚本没跑成就算拦」处理。`)
      : note(`脚本以 ${run.exitCode} 退出，仍按它的结论放行`)
  }
  if (run.exitCode === 0) {
    if (run.stdout.trim() === '') return note('')
    const problem = '脚本输出不是能看懂的 JSON'
    return failClosed
      ? note(problem, 'block', '钩子脚本的输出读不懂（既不是 JSON 也没用退出码 2 表达阻断）。按「脚本没跑成就算拦」处理。')
      : note(problem)
  }
  const problem = `脚本以 ${run.exitCode} 退出，没有给出结论`
  return failClosed
    ? note(problem, 'block', `钩子脚本失败（退出码 ${run.exitCode}）。按「脚本没跑成就算拦」处理。`)
    : note(problem)
}

/** 结论的优先次序：拦 > 问人 > 只留话 > 不表态（与注册顺序无关，多条命中全部跑完再比）。 */
const ACTION_RANK: Record<HookAction, number> = { block: 3, ask: 2, note: 1, pass: 0 }

/** 从多条结论里挑最终结论（并列时保留先给出的那条原因）。 */
export function strongestJudgement(list: HookJudgement[]): HookJudgement | null {
  let best: HookJudgement | null = null
  for (const item of list) {
    if (best === null || ACTION_RANK[item.action] > ACTION_RANK[best.action]) best = item
  }
  return best
}

/** 拼出回给模型的那句话（规则与脚本的原因都会原样到模型眼前，模型才知道该改道）。 */
export function hookReasonForModel(judgement: HookJudgement, what: string): string {
  const body = judgement.message === '' ? '安全钩子拦下了这次操作，没有给出更具体的原因。' : judgement.message
  return `【安全钩子】${what}：${body}（钩子来源：${judgement.source}。请换一个不做这件事的做法，或者把要用户确认的话说给用户，不要重试同一件事。）`
}

/** 规则命中时给的那条结论。 */
export function ruleJudgement(rule: HookRule): HookJudgement {
  const source = `规则 /${rule.pattern}/（${rule.tool}）`
  const message = rule.reason === '' ? (rule.action === 'deny' ? '这条操作被用户登记的规则禁止' : '用户登记的规则要求这次必须有人确认') : rule.reason
  return { action: rule.action === 'deny' ? 'block' : 'ask', message, source, ms: 0, problem: '' }
}
