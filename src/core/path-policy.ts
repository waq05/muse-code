/**
 * 路径护栏：哪些路径不许读、哪些路径不许写、哪些路径的写永远要人点一次。
 *
 * 分三档（照 Hermes `agent/file_safety.py` 与 `tools/file_tools_write_guards.py`）：
 *   读禁   —— 读到就等于丢凭据（.env 家族、私钥、ssh 目录、dsc 自己的凭据文件）；
 *   写硬拒 —— 写下去就把系统或 dsc 自己搞坏（Windows 设备命名空间、系统配置 hive、docker.sock）；
 *   写必问 —— 「给 agent 用的说明书」：AGENTS.md / CLAUDE.md / .cursorrules / dsc 的 config.yaml，
 *             任何权限模式都要弹一次卡，没有人在就是拒（Silence is not consent）。
 *
 * 另外记一份「本次会话读过哪些文件、读的时候文件的修改时间」，
 * 用来拦住「没读过就整写覆盖」——写坏别人正在改的文件是这类工具最常见的事故。
 *
 * @module dsc/core/path-policy
 */
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** dsc 自己的配置目录（config.yaml / credentials.yaml 住这里）。 */
export const DSC_HOME = process.env.DSC_HOME ?? join(homedir(), '.dsc')

/** 主目录下的路径（凭据文件、设置文件的绝对坐标）。 */
function joinHomeAbsolute(...parts: string[]): string {
  return join(homedir(), ...parts)
}

/** 命中即拒读的文件名（不看扩展名，`_` 前缀的本地覆盖也算）。 */
const READ_DENIED_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  'credentials.yaml',
  'credentials.yml',
  'auth.json',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'authorized_keys',
  'known_hosts',
  'google_credentials.json',
])

/** 命中即拒读的扩展名（私钥/证书/密钥环/浏览器 profile 数据库）。 */
const READ_DENIED_EXTENSIONS = [
  '.pem', '.key', '.pfx', '.p12', '.ppk', '.kdbx', '.enc', '.p8', '.mobileprovision',
]

/** 命中即拒读的目录片段（路径里出现这一截就整条拒）。 */
const READ_DENIED_DIR_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.docker', 'credentials', 'vault']

/** `.env.xxx` 这一族（.env.production、.env.staging…）也拒读，只放行 .env.example。 */
function isEnvFamily(name: string): boolean {
  const base = name.toLowerCase()
  return base.startsWith('.env') && !base.includes('example') && !base.includes('sample') && !base.includes('template')
}

/** Windows 设备命名空间前缀：`\?\`、`\.\`、`\\?\`、`\\.\`。它们绕过常规路径校验，还会引出 SMB 认证泄露。 */
const NT_NAMESPACE = /^(\\\\[?.]\\|\\[?.]\\)/

/** 写硬拒：这些路径写下去就是不可逆的系统级破坏。 */
const WRITE_DENIED_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: NT_NAMESPACE, why: 'Windows 设备命名空间路径会绕过所有路径校验' },
  { re: /^[a-z]:\\windows\\system32\\(config|drivers|winevt|catroot)\\/i, why: 'Windows 系统配置目录' },
  { re: /^[a-z]:\\(boot|bootmgr|efi\\)|boot\.bcd$/i, why: '启动分区文件，写坏就开不了机' },
  { re: /(^|\/)etc\/(passwd|shadow|sudoers|hosts$)/i, why: '系统账号与解析配置' },
  { re: /docker\.sock$/, why: 'Docker 控制套接字（写它等于拿到宿主 root）' },
  { re: /(^|\/)boot\/grub\//i, why: '引导加载器配置' },
]

/** 「说明书」类文件：改动它们永远要人确认一次，因为模型改自己的规则是最省事的作弊路径。 */
const PROTECTED_INSTRUCTION_BASENAMES = new Set([
  'agents.md',
  'claude.md',
  'cursorrules',
  '.cursorrules',
  'soul.md',
  'geminiprocessor',
  'config.yaml',
  'config.yml',
  'settings.json',
  'policy.rules',
  // dsc 自己的控制文件：插件注册表（LSP/MCP/browser 的可执行配置都在里面）、
  // 钩子配置与钩子脚本的批准名单——改批准名单等于自己给自己盖章（2026-09-29 审查补）。
  'plugins.json',
  'hooks.json',
  'hooks-trusted.json',
])

/** 判定结果：null = 允许；字符串 = 拒绝原因（会原样进工具结果，模型看得见）。 */
export type PathVerdict = string | null

/** 把路径按大小写不敏感正规化（Windows 的路径比较都得走这个）。 */
function normalizeKey(path: string): string {
  return resolve(path).replace(/[\\/]+/g, '\\').toLowerCase()
}

/** 跟踪「谁读过什么」：key = 正规化路径，value = 读到了哪个修改时间。 */
const readLedger = new Map<string, number>()

/** 文件是否跟着真实路径走（symlink 会改变越界判定的结果，所以判之前先跟一遍）。 */
function realPath(path: string): string {
  try {
    return realpathSync.native ? realpathSync.native(path) : realpathSync(path)
  } catch {
    // 文件还不存在（新建文件）：拿父目录的真实路径再拼回来。
    try {
      const parent = resolve(path, '..')
      const real = realpathSync.native ? realpathSync.native(parent) : realpathSync(parent)
      const name = basename(path)
      return real + sep + name
    } catch {
      return resolve(path)
    }
  }
}

/** 目标是不是在工作目录内（跟着 symlink 判，堵住「建个软链指到工作区外」这条路）。 */
export function isInsideCwd(cwd: string, target: string): boolean {
  const base = realPath(cwd)
  const child = realPath(target)
  const rel = relative(base, child)
  return rel === '' || (rel !== undefined && !rel.startsWith('..') && !isAbsolute(rel))
}

/** 读这个路径要不要拒。 */
export function readBlockReason(target: string): PathVerdict {
  const name = basename(target)
  const lowered = name.toLowerCase()
  if (isEnvFamily(lowered)) {
    return `禁止读取 ${name}：这是本地密钥文件。要看格式请读 ${lowered.replace(/^\.env/, '.env.example')}，或直接问用户。`
  }
  if (READ_DENIED_BASENAMES.has(lowered)) {
    return `禁止读取 ${name}：这是凭据或私钥文件，读进对话就等于把它交出去了。`
  }
  if (READ_DENIED_EXTENSIONS.some((ext) => lowered.endsWith(ext))) {
    return `禁止读取 ${name}：密钥/证书类文件不进对话。`
  }
  if (NT_NAMESPACE.test(target)) return '禁止访问 Windows 设备命名空间路径（\\\\?\\ 或 \\\\.\\）。'
  const segments = normalizeKey(target).split('\\')
  const hit = segments.find((segment) => READ_DENIED_DIR_SEGMENTS.includes(segment))
  if (hit !== undefined) return `禁止读取路径中的 ${hit} 目录（凭据存放区）。`
  if (lowered === 'config.yaml' || lowered === 'config.yml') {
    if (normalizeKey(target).startsWith(normalizeKey(DSC_HOME))) {
      return '禁止直接读取 dsc 自己的配置：端点清单从设置页看，密钥一律不返回。'
    }
  }
  return null
}

/** 写这个路径要不要硬拒（硬拒 = 任何模式都不放行，包括审批）。 */
export function writeHardBlockReason(target: string): PathVerdict {
  const candidate = target.replace(/[\\/]+$/, '')
  for (const { re, why } of WRITE_DENIED_PATTERNS) {
    if (re.test(candidate) || re.test(candidate.replace(/\\/g, '/'))) return `禁止写入：${why}。`
  }
  const key = normalizeKey(candidate)
  if (key === normalizeKey(joinHomeAbsolute('.dsc', 'credentials.yaml'))) {
    return '禁止写入 dsc 的凭据文件：API key 只能从设置页写入。'
  }
  return null
}

/** 这个写操作是不是「说明书」类改动（永远要弹一次卡，不受权限模式影响）。 */
export function isProtectedInstruction(target: string, cwd: string): PathVerdict {
  const name = basename(target).toLowerCase()
  if (PROTECTED_INSTRUCTION_BASENAMES.has(name)) {
    // dsc 自己目录下的控制文件不豁免：它们就是权限体系本身，模型改它们等于自己给自己改权限
    // （2026-09-29 审查发现原来的豁免让 ~/.dsc/settings.json 与 plugins.json 免卡可写）。
    if (normalizeKey(target).startsWith(normalizeKey(DSC_HOME))) {
      return `${name} 是 dsc 的控制文件，改动它必须用户当面确认一次。`
    }
    // 工作区外的 settings.json 多半是别的软件的（VS Code 用户设置这类），不归这层管。
    if (name === 'settings.json' && !isInsideCwd(cwd, target)) return null
    return `${name} 是给 agent 看的说明书或 dsc 的配置，改动它必须用户当面确认一次。`
  }
  return null
}

/** 记录一次读取（read 工具执行后调用），带上当时的修改时间。 */
export function noteRead(target: string): void {
  try {
    readLedger.set(normalizeKey(target), statSync(target).mtimeMs)
  } catch {
    readLedger.delete(normalizeKey(target))
  }
}

/** 记录一次写入（write/edit 成功后调用），免得刚写完的文件被自己拦成「已变」。 */
export function noteWrite(target: string): void {
  noteRead(target)
}

/**
 * 整写覆盖前的检查：没读过 / 读之后文件又变了，都不许整写。
 * 只针对已存在的文件；新建文件直接放行。
 */
export function staleOverwriteReason(target: string): PathVerdict {
  let mtime: number
  try {
    mtime = statSync(target).mtimeMs
  } catch {
    return null // 文件不存在 = 新建，没有覆盖问题
  }
  const seen = readLedger.get(normalizeKey(target))
  if (seen === undefined) {
    return `${basename(target)} 已存在但本次会话没读过它。先读一遍再整写，不然会把别人改过的内容整片抹掉。`
  }
  if (Math.abs(seen - mtime) > 1) {
    return `${basename(target)} 在你上次读它之后又被改动了。重新读一遍再写。`
  }
  return null
}

/** 清掉读取台账（切会话时调用，避免上一个会话的读数误用于新会话）。 */
export function clearReadLedger(): void {
  readLedger.clear()
}

/** 工作目录本身是不是可疑路径（启动时兜一次，异常配置直接说明）。 */
export function suspiciousCwd(cwd: string): PathVerdict {
  if (NT_NAMESPACE.test(cwd)) return '当前工作目录是 Windows 设备命名空间路径，路径校验无法保证有效。'
  if (!isAbsolute(cwd)) return `当前工作目录不是绝对路径：${cwd}`
  return null
}

/** 主目录（测试与提示词用）。 */
export function userHome(): string {
  return homedir()
}
