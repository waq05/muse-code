/**
 * 沙箱路径策略：把「这个路径能不能写」判成一串纯函数（不碰 ctx、不读设置服务）。
 *
 * 为什么独立成模块：沙箱的判定要能被单元自检直接 import 跑，
 * 不必装配整个内核；判定逻辑一旦和注册（守卫/设置/命令）混在一个文件里，
 * 「这条路径为什么被拒」就只能靠起宿主来验。
 *
 * 几处刻意的取舍，都写在对应函数上方：
 *   1. NT 命名空间前缀（`\\?\`、`\\.\`、`\??\`、`GLOBALROOT`）在**任何解析之前**判原始串——
 *      照 hermes `agent/file_safety.py` 的理由：把这种路径喂给 realpath/resolve 就可能
 *      触发一次 SMB 认证，NTLM 哈希在握手阶段就泄出去了，判定本身成了攻击面。
 *      所以这里的顺序是「先否认形状，再谈归属」。
 *   2. 解析用 `realpathSync.native`（Windows 上顺便把 8.3 短名换成长期名），
 *      文件还不存在时（write 工具建新文件是常态）逐级退到最近的存在祖先，再把剩下的段接回去；
 *      接回去的那几段 realpath 验不了，于是**短名形状与符号链接只能在存在段上验证**——
 *      验不了的形状（8.3 短名）保守拒掉，能验的（符号链接）按真实目标判。
 *   3. 解析彻底失败（盘符不存在、权限不足）保守拒绝：判不清就不放行。
 *
 * @module dsc/core/sandbox/policy
 */
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import type { SandboxMode } from '../../services/types.js'

/** 条目树里这个插件的键，同时是设置分区 id。 */
export const SANDBOX_CONFIG_KEY = 'sandbox'

/** 三档（形制照 codex 的 `sandbox_mode`）。 */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * 强制后端：进程内策略围栏 / 容器 / Windows 受限令牌。
 *
 * `windows-token`（2026-10-xx 起提供）推翻了「受限令牌那一路不做」的旧决定：
 * 当时拒绝它的理由是零 npm 依赖硬约束与「半可靠比明说 partial 更危险」。
 * 用户已拍板引入 koffi（预构建 N-API FFI，dsh 同款路线）换真隔离——
 * 文件系统效果由 ACL + 受限令牌强制，网络由「专用账号 + WFP + 白名单代理」强制，
 * 且 enforcement 与缺口清单如实上报，旧的「半可靠装可靠」顾虑由诚实上报解决。
 * 平台与依赖不可用时它不可选，不会悄悄回落成 policy。
 */
export const SANDBOX_BACKENDS = ['policy', 'docker', 'windows-token'] as const

export type SandboxBackend = (typeof SANDBOX_BACKENDS)[number]

/** 容器后端的默认镜像（小、带 sh，够跑构建与测试）。 */
export const DEFAULT_SANDBOX_IMAGE = 'alpine:3'

/** 插件可调值。 */
export interface SandboxConfig {
  mode: SandboxMode
  /** 网络开关：关时命中网络命令一律拒（策略后端只能拦「自己发起的」网络命令，见 describe）。 */
  networkAccess: boolean
  /**
   * 出网域名白名单（windows-token 后端的代理用）：networkAccess 开着时，
   * 只有清单里的域名能过代理，其余一律阻断（deny-by-default）。
   * 支持 `*.example.com` 通配；清单为空等于实际断网（如实上报，不静默放行）。
   */
  networkAllowlist: readonly string[]
  /** 附加可写根（在会话工作目录之外再放行几个目录）。 */
  extraWritableRoots: readonly string[]
  /** 可写根内的只读子路径（放进白名单里的例外）。 */
  readOnlySubpaths: readonly string[]
  backend: SandboxBackend
  image: string
}

/** 默认档就是 workspace-write：正常的工作区读写/bash 全部照常。 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  mode: 'workspace-write',
  networkAccess: false,
  networkAllowlist: [],
  extraWritableRoots: [],
  readOnlySubpaths: [],
  backend: 'policy',
  image: DEFAULT_SANDBOX_IMAGE,
}

/** 读配置的结果：`problems` 非空说明有控件值没通过校验（已回落默认值，不影响挂载）。 */
export interface SandboxConfigResult {
  config: SandboxConfig
  problems: string[]
}

/**
 * 校验一份配置。
 *
 * 与审批灾难地板的「坏配置一律拒」刻意不同：那里坏掉是安全边界不清，
 * 这里坏掉只是**少了一层围栏**，所以照 codex 的姿态回落默认值 + 把问题说出来
 * （设置分区里能看到、挂载时也会提示一次），而不是把用户的工作区写全禁掉。
 */
export function resolveSandboxConfig(raw: unknown): SandboxConfigResult {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: { ...DEFAULT_SANDBOX_CONFIG }, problems: [] }
  }
  const doc = raw as Record<string, unknown>
  const problems: string[] = []
  const config: {
    mode: SandboxMode
    networkAccess: boolean
    networkAllowlist: readonly string[]
    extraWritableRoots: readonly string[]
    readOnlySubpaths: readonly string[]
    backend: SandboxBackend
    image: string
  } = { ...DEFAULT_SANDBOX_CONFIG }

  if (doc.mode !== undefined) {
    const mode = String(doc.mode)
    if ((SANDBOX_MODES as readonly string[]).includes(mode)) config.mode = mode as SandboxMode
    else problems.push(`档位只能是 ${SANDBOX_MODES.join(' / ')}，收到「${mode}」，已按默认 workspace-write 走`)
  }
  if (doc.networkAccess !== undefined) {
    if (typeof doc.networkAccess === 'boolean') config.networkAccess = doc.networkAccess
    else problems.push(`网络开关要 true/false，收到「${String(doc.networkAccess)}」，已按关处理`)
  }
  for (const [key, target] of [
    ['extraWritableRoots', 'extraWritableRoots'],
    ['readOnlySubpaths', 'readOnlySubpaths'],
  ] as const) {
    const value = doc[key]
    if (value === undefined) continue
    if (Array.isArray(value)) config[target] = value.map((item) => String(item)).filter((item) => item.trim() !== '')
    else if (typeof value === 'string') config[target] = parsePathListText(value)
    else problems.push(`${key} 要一个字符串数组（设置页里是分号分隔的文本），已忽略`)
  }
  if (doc.networkAllowlist !== undefined) {
    const value = doc.networkAllowlist
    if (Array.isArray(value)) {
      const { domains, bad } = parseAllowlist(value.map((item) => String(item)))
      config.networkAllowlist = domains
      if (bad.length > 0) problems.push(`出网白名单里有不像域名的项，已忽略：${bad.join('、')}`)
    } else if (typeof value === 'string') {
      const { domains, bad } = parseAllowlistText(value)
      config.networkAllowlist = domains
      if (bad.length > 0) problems.push(`出网白名单里有不像域名的项，已忽略：${bad.join('、')}`)
    } else problems.push('networkAllowlist 要字符串数组或分号分隔的文本，已忽略')
  }
  if (doc.backend !== undefined) {
    const backend = String(doc.backend)
    if ((SANDBOX_BACKENDS as readonly string[]).includes(backend)) config.backend = backend as SandboxBackend
    else problems.push(`后端只能是 ${SANDBOX_BACKENDS.join(' / ')}，收到「${backend}」，已按 policy 走`)
  }
  if (doc.image !== undefined) {
    const image = String(doc.image).trim()
    if (image === '' || /\s/.test(image)) problems.push(`容器镜像名不能为空也不能带空格，收到「${image}」，已按 ${DEFAULT_SANDBOX_IMAGE} 走`)
    else config.image = image
  }
  return { config, problems }
}

/** 设置页那个框（分号或换行分隔）→ 路径数组；去重保序。 */
export function parsePathListText(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const piece of text.split(/[;\n\r]+/)) {
    const value = piece.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** 路径数组 → 设置页那个框的文本。 */
export function formatPathList(paths: readonly string[]): string {
  return paths.join('; ')
}

/**
 * 单个出网白名单条目的校验与归一：小写、去末尾点，接受 `example.com` 与
 * `*.example.com`（通配只能整段，`*x.example.com` 这类不收）。
 * 返回归一后的串；不像域名就给拒因。
 */
export function normalizeAllowlistEntry(raw: string): { ok: true; domain: string } | { ok: false; why: string } {
  const domain = raw.trim().toLowerCase().replace(/\.+$/, '')
  if (domain === '') return { ok: false, why: '空条目' }
  if (/\s/.test(domain)) return { ok: false, why: `「${raw}」带了空格` }
  if (domain.includes('/')) return { ok: false, why: `「${raw}」是路径不是域名（白名单按域匹配，不带路径）` }
  const host = domain.startsWith('*.') ? domain.slice(2) : domain
  if (host === '' || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
    return { ok: false, why: `「${raw}」域名形状不对` }
  }
  // 逐段校验：字母数字与连字符，IDN 直接拒（让用户用 punycode 写，判定里少一层归一化歧义）
  const label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
  for (const part of host.split('.')) {
    if (part === '' || !label.test(part)) return { ok: false, why: `「${raw}」里的「${part}」不是合法的域名字段（中文域名请用 punycode）` }
  }
  return { ok: true, domain }
}

/** 已拆好的条目数组 → 归一域名列表 + 拒因列表（保序去重）。 */
export function parseAllowlist(entries: readonly string[]): { domains: string[]; bad: string[] } {
  const domains: string[] = []
  const bad: string[] = []
  const seen = new Set<string>()
  for (const raw of entries) {
    const one = normalizeAllowlistEntry(raw)
    if (!one.ok) {
      bad.push(one.why)
      continue
    }
    if (seen.has(one.domain)) continue
    seen.add(one.domain)
    domains.push(one.domain)
  }
  return { domains, bad }
}

/** 设置页那个框（分号或换行分隔）→ 白名单（带逐项拒因）。 */
export function parseAllowlistText(text: string): { domains: string[]; bad: string[] } {
  return parseAllowlist(text.split(/[;\n\r]+/))
}

/**
 * host 是否被白名单放行：全等，或通配域（`*.example.com`）匹配「任意段后缀但至少一段」。
 * 精确域不放行子域——`example.com` 不含 `api.example.com`；要连子域一起放就写 `*.example.com`。
 */
export function allowlistMatches(host: string, list: readonly string[]): boolean {
  const name = host.trim().toLowerCase().replace(/\.+$/, '')
  if (name === '') return false
  for (const entry of list) {
    if (entry === name) return true
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1) // '.example.com'
      if (name.endsWith(suffix) && name.length > suffix.length && !name.slice(0, -suffix.length).includes('.')) {
        return true
      }
    }
  }
  return false
}

/** 沙箱私有临时目录：`<dscHome>/sandbox/tmp/<会话 id 或 cwd 哈希>`。 */
export function sandboxTmpDir(dscHome: string, cwd: string, sessionId?: string): string {
  const safe = (sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  const slug = safe !== '' ? safe : createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(dscHome, 'sandbox', 'tmp', slug)
}

// ---------------------------------------------------------------- 形状守卫（解析之前）

/** NT 命名空间前缀：命中就拒，且必须在任何 resolve/realpath 之前判。 */
const NT_NAMESPACE = /\\\\[?.]\\|\\\?\?\\/i

/**
 * 原始字符串是不是 NT 命名空间路径。
 *
 * 为什么判「出现在任意位置」而不是只看开头：`C:\x\\?\C:\Windows` 这类拼接串同样会被
 * 解析器当成设备路径。代价是 POSIX 上文件名里含反斜杠的极少数情况会被误拒——
 * 这是有意的：安全侧宁可误拒一次让人换普通路径。
 */
export function ntNamespaceReason(raw: string): string | null {
  if (NT_NAMESPACE.test(raw)) {
    return '路径里出现 Windows NT 命名空间前缀（\\\\?\\ / \\\\.\\ / \\??\\）：光解析它就可能触发一次 SMB 认证并泄漏 NTLM 凭据，因此直接拒'
  }
  if (/globalroot/i.test(raw)) return '路径里出现 GLOBALROOT（NT 设备命名空间）：绕过所有路径校验，直接拒'
  return null
}

/** 8.3 短名形状（只在其所在段无法用 realpath 验证时才拒）。 */
const SHORT_NAME = /^[^\\/]{1,6}~\d{1,3}(\.[^\\/]{1,3})?$/

/**
 * NTFS 备选数据流（ADS）：`f.txt:stream` 会写到另一个「看不见的」文件里，
 * `C:\ws\ok.txt:hidden` 的可见部分仍在可写根内，判定必须看真实落点。
 * 我们不做流级判定，直接拒（Windows 上正常文件名不许带冒号）。
 */
export function adsStreamReason(raw: string, win32: boolean): string | null {
  if (!win32) return null
  const withoutDrive = raw.replace(/^[A-Za-z]:/, '')
  if (withoutDrive.includes(':')) {
    return '路径里带 NTFS 备选数据流（`文件:流名`）：真实落点不是这个文件名，直接拒'
  }
  return null
}

// ---------------------------------------------------------------- 规范化

/** 去掉末尾分隔符，但盘根（`C:\`、`/`）保留原样。 */
function stripTrailingSep(path: string): string {
  if (path === '' || path === '/' || path === '\\') return path
  if (/^[A-Za-z]:[\\/]$/.test(path)) return path
  return path.replace(/[\\/]+$/, '')
}

/** realpath 两套都试一遍（native 在 Windows 上会把 8.3 短名换成长期名）。 */
function tryRealpath(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return null
    }
  }
}

/** 规范化产物：`ok:false` 时 `rule` 说明是形状问题还是解析失败。 */
export interface CanonicalPath {
  ok: boolean
  /** 规范化后的绝对路径（失败时给绝对化后的原始串，便于在理由里显示）。 */
  path: string
  /** 只有失败时给：`short-name` / `unresolvable`。 */
  rule?: 'short-name' | 'unresolvable'
  reason?: string
  /** 无法用 realpath 验证的尾段（真实路径里不存在的那几段，深→浅）。 */
  tail: readonly string[]
}

/**
 * 把一个路径规范化成可以互相比对的形式。
 *
 * 步骤：绝对化 → 逐级往上找到最近的存在祖先并 realpath 它 → 把不存在的尾段接回去。
 * 尾段里的 8.3 短名无法验证（`PROGRA~1` 到底是哪个目录只有文件系统知道），一律拒；
 * 尾段里的符号链接同样验证不了，但它的**父目录**已经 realpath 过，
 * 所以「建个软链指到工作区外再写进去」这条最常用的绕法在存在段上就被拦住了。
 */
export function canonicalizePath(raw: string, options: { win32: boolean; cwd: string }): CanonicalPath {
  const absolute = stripTrailingSep(isAbsolute(raw) ? normalize(raw) : resolve(options.cwd, raw))
  let candidate = absolute
  const tail: string[] = []
  for (;;) {
    const real = tryRealpath(candidate)
    if (real !== null) {
      const base = stripTrailingSep(real)
      const withTail = tail.length === 0 ? base : join(base, ...[...tail].reverse())
      if (options.win32) {
        const bad = [...tail].reverse().find((segment) => SHORT_NAME.test(segment))
        if (bad !== undefined) {
          return {
            ok: false,
            path: stripTrailingSep(withTail),
            rule: 'short-name',
            reason: `路径段「${bad}」像 8.3 短名（真实目录名只有文件系统知道）：这个目标还不存在，无法验证它落在哪个目录里，保守拒绝`,
            tail,
          }
        }
      }
      return { ok: true, path: stripTrailingSep(withTail), tail }
    }
    const parent = dirname(candidate)
    if (parent === candidate) {
      return {
        ok: false,
        path: absolute,
        rule: 'unresolvable',
        reason: `路径无法解析（盘符不存在、权限不足或被拒绝访问）：判不清落点就不放行 → ${absolute}`,
        tail,
      }
    }
    tail.push(basename(candidate))
    candidate = parent
  }
}

// ---------------------------------------------------------------- 受保护名

/** 命中即拒写的凭据/密钥文件名（不看扩展名）。 */
const CREDENTIAL_BASENAMES = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'authorized_keys',
  'known_hosts',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  'auth.json',
  'google_credentials.json',
])

/** 命中即拒写的扩展名（私钥/证书/密钥库）。 */
const CREDENTIAL_EXTENSIONS = ['.pem', '.key', '.pfx', '.p12', '.ppk', '.kdbx', '.keystore', '.jks', '.p8']

/** dsc 自己家目录下的控制文件：它们决定沙箱与审批怎么跑，模型不该能写。 */
const DSC_CONTROL_FILES = new Set(['config.yaml', 'config.yml', 'credentials.yaml', 'credentials.yml', 'policy.rules', 'plugins.json'])

/** `.env` 家族（`.env.production` 这类都算）；`.env.example` 一类模板放行。 */
function isEnvFamily(name: string): boolean {
  const base = name.toLowerCase()
  return base.startsWith('.env') && !base.includes('example') && !base.includes('sample') && !base.includes('template')
}

/** 路径按比较口径归一：Windows 下大小写不敏感，分隔符统一成 `\`。 */
function compareKey(path: string, win32: boolean): string {
  const unified = path.replace(/[\\/]+/g, '\\')
  return win32 ? unified.toLowerCase() : unified
}

/**
 * 这个路径是不是「即使在可写根内也拒写」的受保护名。
 *
 * 覆盖范围比规格列的多两处，都是有理由的补充：
 *   - `.git` **整棵树**（不只是 hooks/config/objects）：`.git/config` 里放 core.hooksPath、
 *     `git` 自己写 `index`/`refs`，任何一处被改都能让「读一下仓库」变成执行任意代码；
 *   - `~/.dsc` 下的 `plugins.json` 与 `policy.rules`：它们分别是插件配置与命令规则，
 *     能写这两个文件就能把沙箱自己关掉（config.yaml 与 credentials.yaml 在规格里已列）。
 */
export function protectedWriteReason(absPath: string, dscHome: string, win32: boolean): string | null {
  const segments = compareKey(absPath, win32).split('\\').filter((segment) => segment !== '')
  const name = basename(absPath)
  const lowered = name.toLowerCase()

  if (segments.includes('.git')) {
    return 'Git 元数据目录（hooks/config/objects 都在里面）：改它等于让之后的 git 命令随时执行你的代码'
  }
  if (segments.includes('.ssh')) return 'SSH 凭据目录（私钥与 known_hosts）'
  if (isEnvFamily(lowered)) {
    return `${name} 是环境变量密钥文件（.env 家族；.env.example 一类模板除外）`
  }
  if (CREDENTIAL_BASENAMES.has(lowered)) return `${name} 是凭据/私钥文件`
  if (CREDENTIAL_EXTENSIONS.some((ext) => lowered.endsWith(ext))) return `${name} 是密钥/证书类文件`
  if (lowered === 'credentials.json' || lowered === 'secrets.yaml' || lowered === 'secrets.yml') {
    return `${name} 是凭据文件`
  }
  const home = compareKey(stripTrailingSep(dscHome), win32)
  if (compareKey(absPath, win32).startsWith(`${home}\\`) && DSC_CONTROL_FILES.has(lowered)) {
    return `dsc 自己的配置（${name}）：改它等于改沙箱与审批自己的规则`
  }
  return null
}

// ---------------------------------------------------------------- 策略对象

/** 构造策略的入参（由插件从设置与会话状态里现取）。 */
export interface PolicyInput {
  mode: SandboxMode
  /** 会话工作目录。 */
  cwd: string
  /** 沙箱私有临时目录。 */
  tmpDir: string
  extraWritableRoots: readonly string[]
  readOnlySubpaths: readonly string[]
  /** `~/.dsc`。 */
  dscHome: string
  networkAccess: boolean
  /** Windows 口径（默认取当前平台；自检里可显式指定）。 */
  win32?: boolean
}

/** 判定用的策略快照：路径都规范化过，比较是纯字符串运算。 */
export interface SandboxPolicy {
  mode: SandboxMode
  win32: boolean
  cwd: string
  tmpDir: string
  dscHome: string
  networkAccess: boolean
  /** 生效的可写根；read-only 档恒为空数组（那一档什么都不许写）。 */
  roots: readonly string[]
  /** 不设围栏时看到的「本该可写」的根，给设置页与 describe 显示用。 */
  candidateRoots: readonly string[]
  readOnlySubpaths: readonly string[]
  /** 规范化期间发现的问题（附加根解析不了之类），非空要报给用户。 */
  problems: readonly string[]
}

/** 一次路径判定的结果（`SandboxCheck` 的超集，多带一条稳定规则名）。 */
export interface PathCheck {
  allowed: boolean
  /** 稳定短名：自检与诊断按它对号入座。 */
  rule:
    | 'allowed'
    | 'nt-namespace'
    | 'ads-stream'
    | 'short-name'
    | 'unresolvable'
    | 'protected-metadata'
    | 'mode-read-only'
    | 'read-only-subpath'
    | 'outside-writable-roots'
  /** 中文理由（被拒时原样进给模型的说明）。 */
  reason: string
  /** 判定时用的绝对化路径。 */
  resolved: string
  /** 放行时命中哪个可写根。 */
  root?: string
}

/** 组一份策略快照。规范化失败的附加根会被丢掉并记进 `problems`。 */
export function createPolicy(input: PolicyInput): SandboxPolicy {
  const win32 = input.win32 ?? process.platform === 'win32'
  const problems: string[] = []
  const opts = { win32, cwd: input.cwd }

  const cwdPath = canonicalizePath(input.cwd, opts)
  if (!cwdPath.ok) problems.push(`工作目录用不了，本次一律不放行写：${cwdPath.reason ?? ''}`)
  const cwd = cwdPath.ok ? cwdPath.path : resolve(input.cwd)

  const tmpPath = canonicalizePath(input.tmpDir, opts)
  const tmpDir = tmpPath.ok ? tmpPath.path : resolve(input.tmpDir)

  const candidate: string[] = [cwd, tmpDir]
  for (const raw of input.extraWritableRoots) {
    const value = raw.trim()
    if (value === '') continue
    const one = canonicalizePath(value, { win32, cwd })
    if (!one.ok) {
      problems.push(`附加可写根「${raw}」用不了，已忽略：${one.reason ?? ''}`)
      continue
    }
    candidate.push(one.path)
  }

  const readOnlySubpaths: string[] = []
  for (const raw of input.readOnlySubpaths) {
    const value = raw.trim()
    if (value === '') continue
    const one = canonicalizePath(value, { win32, cwd })
    if (!one.ok) {
      problems.push(`只读子路径「${raw}」用不了，已忽略：${one.reason ?? ''}`)
      continue
    }
    readOnlySubpaths.push(one.path)
  }

  return {
    mode: input.mode,
    win32,
    cwd,
    tmpDir,
    dscHome: input.dscHome,
    networkAccess: input.networkAccess,
    // read-only 档没有可写根：判定的第一道就把它拦下，理由也更直白。
    // danger-full-access 档保留候选根，只为显示与诊断——真正判定在 checkWrite 里直接放行。
    roots: input.mode === 'read-only' ? [] : candidate,
    candidateRoots: candidate,
    readOnlySubpaths,
    problems,
  }
}

/** 目标是否落在某个根之内（Windows 下大小写不敏感，UNC 与盘符都按同一套算）。 */
export function insideRoot(child: string, root: string, win32: boolean): boolean {
  const a = win32 ? stripTrailingSep(root).toLowerCase() : stripTrailingSep(root)
  const b = win32 ? stripTrailingSep(child).toLowerCase() : stripTrailingSep(child)
  if (a === b) return true
  const rel = relative(a, b)
  if (rel === '') return true
  // 跨盘符时 relative 会返回绝对路径；`..` 开头就是在外面
  return !isAbsolute(rel) && !rel.startsWith('..')
}

/** 「怎么合法地做」的一句人话：拒因最后带上它，模型才有自救路径。 */
export function legalWay(rule: PathCheck['rule']): string {
  switch (rule) {
    case 'outside-writable-roots':
      return '把目标改到可写根内，或在「设置 → 沙箱」里把这个目录加进附加可写根；确实必须写到范围外时，在这一次调用里同时带上 sandbox_permissions 与 justification 重试（会照常弹审批卡让人点）'
    case 'protected-metadata':
      return '这类文件即便落在可写根内也拒写；确需改动请让用户手工执行，或换一个不受保护的路径'
    case 'mode-read-only':
      return '当前档位禁止一切写盘：在「设置 → 沙箱」把档位切到 workspace-write（工作区可写）或 danger-full-access，或改做只读的动作'
    case 'read-only-subpath':
      return '这条子路径被用户在「设置 → 沙箱」的只读清单里标了只读：改到别的路径，或请用户把它从清单里去掉'
    case 'nt-namespace':
      return '改用普通绝对路径（例如 C:\\Users\\me\\proj\\a.txt），不要带 \\\\?\\、\\\\.\\、\\??\\ 或 GLOBALROOT'
    case 'ads-stream':
      return '去掉文件名里的冒号：NTFS 备选数据流写不了，普通文件名照常'
    case 'short-name':
      return '把这个目标先建出来（或让用户确认它的长期名），再用完整的长名路径写一次'
    case 'unresolvable':
      return '先确认这个路径的父目录存在且当前用户有权访问，再用绝对路径写一次'
    default:
      return '换一个落在可写根内的目标'
  }
}

/**
 * 判一个路径能不能写。
 *
 * 顺序是刻意的：形状守卫 → 档位（不设围栏就直接放行）→ 受保护名 → 档位（只读）→
 * 只读子路径 → 可写根归属。
 * 形状守卫（NT 命名空间、ADS）排在档位之前：它们防的是「解析这个字符串」这件事本身的
 * 副作用（SMB 认证泄漏、真实落点不是看到的那个文件），与档位无关。
 * 受保护名放在只读判定之前，是为了让「为什么拒」一次说到最具体的那层；
 * 只读档放在归属之前，是为了给出「档位不许写」这句话，而不是含糊的「不在可写根内」
 * （那一档根本没有可写根）。
 */
export function checkWrite(policy: SandboxPolicy, raw: string): PathCheck {
  const nt = ntNamespaceReason(raw)
  if (nt !== null) return { allowed: false, rule: 'nt-namespace', reason: nt, resolved: raw }

  const ads = adsStreamReason(raw, policy.win32)
  if (ads !== null) return { allowed: false, rule: 'ads-stream', reason: ads, resolved: raw }

  const canon = canonicalizePath(raw, { win32: policy.win32, cwd: policy.cwd })
  if (!canon.ok) {
    return {
      allowed: false,
      rule: canon.rule === 'short-name' ? 'short-name' : 'unresolvable',
      reason: canon.reason ?? '路径无法解析，保守拒绝',
      resolved: canon.path,
    }
  }
  const abs = canon.path

  if (policy.mode === 'danger-full-access') {
    return { allowed: true, rule: 'allowed', reason: `档位 danger-full-access：沙箱不设围栏 → ${abs}`, resolved: abs }
  }

  const protectedWhy = protectedWriteReason(abs, policy.dscHome, policy.win32)
  if (protectedWhy !== null) return { allowed: false, rule: 'protected-metadata', reason: protectedWhy, resolved: abs }

  if (policy.mode === 'read-only') {
    return {
      allowed: false,
      rule: 'mode-read-only',
      reason: `当前档位是 read-only（只读）：只允许读，任何写盘都拒 → ${abs}`,
      resolved: abs,
    }
  }

  const readonly = policy.readOnlySubpaths.find((sub) => insideRoot(abs, sub, policy.win32))
  if (readonly !== undefined) {
    return {
      allowed: false,
      rule: 'read-only-subpath',
      reason: `${readonly} 在只读清单里（可写根内的例外） → ${abs}`,
      resolved: abs,
    }
  }

  const root = policy.roots.find((one) => insideRoot(abs, one, policy.win32))
  if (root === undefined) {
    const list = policy.roots.length === 0 ? '（无）' : policy.roots.join('、')
    return {
      allowed: false,
      rule: 'outside-writable-roots',
      reason: `${abs} 不在任何可写根之内。可写根：${list}`,
      resolved: abs,
    }
  }
  return { allowed: true, rule: 'allowed', reason: `${abs} 落在可写根 ${root} 内`, resolved: abs, root }
}

/** 策略的一句话摘要（`SandboxService.describe()` 与设置页共用）。 */
export function describePolicy(policy: SandboxPolicy): string {
  const roots = policy.mode === 'danger-full-access'
    ? '围栏关闭（不限制）'
    : policy.roots.length === 0
      ? '（无，只读档不许写盘）'
      : policy.roots.join('、')
  const readonly = policy.readOnlySubpaths.length === 0 ? '（无）' : policy.readOnlySubpaths.join('、')
  return `档位 ${policy.mode}；可写根：${roots}；只读子路径：${readonly}；网络：${policy.networkAccess ? '开' : '关'}`
}
