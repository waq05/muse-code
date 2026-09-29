/**
 * 沙箱命令策略（形制照 codex 的 execpolicy）：一条 shell 命令 → allow / prompt / forbidden。
 *
 * 与 `core/command-policy.ts` 的分工（两份东西长得像但判的不是一件事）：
 *   - `command-policy` 回答「这条命令危不危险、要不要问人」，它是**审批面**，
 *     结论是 allow/ask/deny，且 deny 是任何权限模式都翻不了的硬地板；
 *   - 本模块回答「这条命令会不会写到可写根之外 / 要不要联网」，它是**围栏面**，
 *     结论是 allow/prompt/forbidden，forbidden 只代表「沙箱不同意」。
 *   两边共用同一套切段结果（`splitSegments`），所以「一段一段判」这件事只有一份实现。
 *
 * 规则表是内置的：沙箱的策略值不值得让用户手写 DSL，先看有没有人真的想改；
 * 现在给的是 codex 那批机器级改动（计划任务、注册表、网络、ACL、引导）+
 * 一批明确只读的 allow 前缀。`allow` 不等于免审批卡——那是审批层的事（见插件注释）。
 *
 * 边界（老老实实写在这里）：这一层认得出**写在命令里的**写目标与网络命令，
 * 认不出「`node build.js` 里那行 fs.writeFile 写了哪」「子进程 curl 拉了哪个地址」。
 * 这就是 `enforcement: partial` 的准确含义。
 *
 * @module dsc/core/sandbox/execpolicy
 */
import { splitSegments, type CommandSegment } from '../command-policy.js'
import type { PathCheck } from './policy.js'

/** 一次命令判定的三种结论。 */
export type ExecDecision = 'allow' | 'prompt' | 'forbidden'

/** 一条命令前缀规则。 */
export interface ExecRule {
  /** 稳定名字（自检与诊断按它对号入座）。 */
  name: string
  decision: ExecDecision
  /** 词元前缀；末尾 `*` 吃掉剩余词元。 */
  pattern: readonly string[]
  /** 命中前缀之后还要满足的附加条件（表达「icacls 且带 /grant」这类）。 */
  requires?: (segment: CommandSegment) => boolean
  /** 给模型与用户看的中文理由。 */
  justification: string
}

/** 命中即 forbidden：机器级改动面（关掉它们等于关掉「改机器」这件事）。 */
const FORBIDDEN_RULES: readonly ExecRule[] = [
  {
    name: 'schtasks',
    decision: 'forbidden',
    pattern: ['schtasks'],
    justification: '计划任务能让任意命令常驻执行（后门面），沙箱里不做这件事',
  },
  {
    name: 'reg-write',
    decision: 'forbidden',
    pattern: ['reg', 'add'],
    justification: '写注册表是机器级改动，且常被用来做持久化',
  },
  {
    name: 'reg-delete',
    decision: 'forbidden',
    pattern: ['reg', 'delete'],
    justification: '删注册表键会破坏已装软件与系统设置',
  },
  {
    name: 'reg-import',
    decision: 'forbidden',
    pattern: ['reg', 'import'],
    justification: '导入注册表文件等于一次性写一批机器级配置，内容看不清',
  },
  {
    name: 'netsh',
    decision: 'forbidden',
    pattern: ['netsh'],
    justification: '改网络/防火墙配置属于机器级改动',
  },
  {
    name: 'bcdedit',
    decision: 'forbidden',
    pattern: ['bcdedit'],
    justification: '改引导配置，写错就开不了机',
  },
  {
    name: 'takeown',
    decision: 'forbidden',
    pattern: ['takeown'],
    justification: '抢占文件所有权是提权的前置动作',
  },
  {
    name: 'icacls-grant',
    decision: 'forbidden',
    pattern: ['icacls'],
    requires: (segment) => segment.tokens.some((token) => /^\/(grant|setowner|reset|inheritance)/i.test(token)),
    justification: '改文件 ACL / 把权限开给别的账号，等于把数据交出去（只读的 icacls 另说）',
  },
  {
    name: 'diskpart',
    decision: 'forbidden',
    pattern: ['diskpart'],
    justification: '分区级操作，数据不可恢复',
  },
  {
    name: 'vssadmin',
    decision: 'forbidden',
    pattern: ['vssadmin'],
    justification: '卷影副本是最后的回滚手段，删它等于把退路拆掉',
  },
  {
    name: 'wbadmin',
    decision: 'forbidden',
    pattern: ['wbadmin'],
    justification: '改备份与系统状态，写错就失去恢复能力',
  },
  {
    name: 'bootrec',
    decision: 'forbidden',
    pattern: ['bootrec'],
    justification: '改引导记录，写错就开不了机',
  },
]

/** 明确只读/构建类：允许在沙箱内直接跑（真正免不免审批卡由审批层决定）。 */
const ALLOW_RULES: readonly ExecRule[] = [
  { name: 'git-status', decision: 'allow', pattern: ['git', 'status'], justification: '看仓库状态，只读' },
  { name: 'git-diff', decision: 'allow', pattern: ['git', 'diff'], justification: '看改动内容，只读' },
  { name: 'git-log', decision: 'allow', pattern: ['git', 'log'], justification: '看提交历史，只读' },
  { name: 'list-posix', decision: 'allow', pattern: ['ls'], justification: '列目录，只读' },
  { name: 'list-win', decision: 'allow', pattern: ['dir'], justification: '列目录，只读' },
  { name: 'pnpm-build', decision: 'allow', pattern: ['pnpm', 'run', 'build'], justification: '构建工作区，产物落在工作区内' },
  { name: 'pnpm-test', decision: 'allow', pattern: ['pnpm', 'test'], justification: '跑测试' },
]

/** 内置规则表（forbidden 在前，匹配时先看它们）。 */
export const BUILTIN_EXEC_RULES: readonly ExecRule[] = [...FORBIDDEN_RULES, ...ALLOW_RULES]

// ---------------------------------------------------------------- 词元工具

/** `sudo rm -rf /` 真正跑的是 rm；这些包装词要剥掉。 */
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'env', 'nohup'])

/** 取这一段真正要跑的程序名（小写、去 `.exe`、去目录前缀、剥包装词）。 */
function headOf(tokens: readonly string[]): string {
  const index = headIndex(tokens)
  return index < 0 ? '' : tokenName(tokens[index]!)
}

/** 程序名在词元里的下标（-1 = 认不出）：操作数循环要跳过它，不然命令名自己会被当成路径。 */
function headIndex(tokens: readonly string[]): number {
  let index = 0
  while (index < tokens.length && WRAPPERS.has(tokenName(tokens[index]!))) index += 1
  // `env FOO=bar cmd`：跳过环境变量赋值
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1
  return index < tokens.length ? index : -1
}

/** 词元 → 程序名（去路径、去 `.exe`、小写）。 */
function tokenName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token
  return base.toLowerCase().replace(/\.exe$/, '')
}

/** 前缀匹配：`pattern` 是段词元的前缀，末尾 `*` 表示后面随便。 */
function matchExecRule(rule: ExecRule, segment: CommandSegment): boolean {
  if (segment.tokens.length === 0) return false
  for (let i = 0; i < rule.pattern.length; i += 1) {
    const want = rule.pattern[i]!
    if (want === '*') break
    const got = segment.tokens[i]
    if (got === undefined) return false
    if (tokenName(got) !== want.toLowerCase()) return false
  }
  return rule.requires === undefined ? true : rule.requires(segment)
}

// ---------------------------------------------------------------- 写目标

/** 所有非开关词元都是「被改动的路径」（删/建/截断/写内容：源自己就动手了）。 */
const FULL_WRITE_HEADS = new Set([
  'rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri',
  'mkdir', 'md', 'new-item', 'ni', 'touch', 'truncate', 'tee', 'clear-content',
])

/** 只有**最后一个**非开关词元是写目标（源可能在可写根之外，只是读它）。 */
const COPY_HEADS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy'])

/** 源同样被改动（移走就是删掉），所以所有词元都算目标。 */
const MOVE_HEADS = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rn'])

/** 写目标是 `-Path` 一类的值，没有就给第一个非开关词元。 */
const CONTENT_HEADS = new Set(['set-content', 'add-content', 'out-file', 'export-csv', 'export-clixml'])

/** `-Path` 这一族（写目标用的）。 */
const PATH_FLAGS = new Set(['-path', '-filepath', '-literalpath', '-file'])
/** `-Destination` 这一族。 */
const DEST_FLAGS = new Set(['-destination', '-dest'])

/**
 * 一个词元是不是开关。
 *
 * Windows 上 `/f`、`/grant`、`/r` 是开关，但 `/tmp/x` 是路径——只把「一个斜杠 +
 * 1~3 个字母且后面没有别的斜杠」当开关。POSIX 上 `/` 开头的都不是开关。
 */
function isFlag(token: string, win32: boolean): boolean {
  if (token === '-') return true
  if (token.startsWith('-')) return true
  if (win32 && /^\/[A-Za-z]{1,3}$/.test(token)) return true
  return false
}

/** 重定向词元 → 写目标（`''` = 目标在下一个词元；null = 不是文件重定向）。 */
function redirectTarget(token: string): string | null {
  const match = /^(\d?>>?)(.*)$/.exec(token)
  if (match === null) return null
  const rest = match[2] ?? ''
  // `2>&1`、`>&2` 只是接文件描述符，不落盘
  if (rest.startsWith('&')) return null
  return rest
}

/**
 * 从一段命令里认出所有「会被写到的路径」。
 *
 * 认的是形状，不是语义：`rm`/`mv`/`Set-Content`/`>`/`dd of=` 这些齐了，
 * 但 `bash -c "rm x"`、`node -e "fs.unlinkSync(...)"` 这类藏在参数里的写认不出来——
 * 这正是策略围栏「拦得住工具调用、拦不住命令内部」的那一半。
 *
 * `cp`/`copy` 只算**最后一个**词元（源在可写根之外只是读它，算成写会误拒）；
 * `mv`/`rm` 算全部（源被移走或被删，同样是动手）。
 */
export function writeTargetsOf(segment: CommandSegment, win32: boolean): string[] {
  const tokens = segment.tokens
  const out: string[] = []
  const push = (value: string | undefined): void => {
    if (value === undefined) return
    const trimmed = value.trim()
    if (trimmed === '') return
    out.push(trimmed)
  }

  // 1) 重定向：`> x`、`>>x`、`1> x`；`2>&1` 不算
  for (let i = 0; i < tokens.length; i += 1) {
    const target = redirectTarget(tokens[i]!)
    if (target === null) continue
    push(target === '' ? tokens[i + 1] : target)
  }

  // 2) `dd` 的 `of=`（`if=` 是读）
  for (const token of tokens) {
    const match = /^of=(.+)$/i.exec(token)
    if (match !== null) push(match[1])
  }

  const head = headOf(tokens)
  if (head === '') return [...new Set(out)]

  // 3) 命令自身的词元（跳过程序名自己）
  const command = headIndex(tokens)
  const operands: string[] = []
  /** 已经用 `-Path`/`-Destination` 指名道姓说过目标了：位置参数不再当路径。 */
  let explicit = false
  for (let i = 0; i < tokens.length; i += 1) {
    if (i === command) continue
    const token = tokens[i]!
    const redirect = redirectTarget(token)
    if (redirect !== null) {
      // 目标已在第 1 步收过：下一个词元别再当操作数
      if (redirect === '') i += 1
      continue
    }
    if (/^of=/i.test(token)) continue
    if (isFlag(token, win32)) {
      const lowered = token.toLowerCase()
      const value = tokens[i + 1]
      if (value !== undefined && !isFlag(value, win32)) {
        if (DEST_FLAGS.has(lowered)) {
          push(value)
          explicit = true
          i += 1
          continue
        }
        if (PATH_FLAGS.has(lowered)) {
          // `cp -Path a -Destination b`：a 是源，不算写
          if (!COPY_HEADS.has(head)) {
            push(value)
            explicit = true
          }
          i += 1
          continue
        }
      }
      continue
    }
    operands.push(token)
  }

  // 开关已经指明了目标时，剩下的位置参数多半是别的东西的值（`-Value hello`、`-ItemType Directory`），
  // 一律不再当路径——宁可漏算一个写目标（还有审批卡兜底），也别凭空造出一个越界判断。
  if (explicit) return [...new Set(out)]

  if (COPY_HEADS.has(head)) {
    push(operands[operands.length - 1])
  } else if (MOVE_HEADS.has(head) || FULL_WRITE_HEADS.has(head)) {
    for (const operand of operands) push(operand)
  } else if (CONTENT_HEADS.has(head)) {
    // 只认位置参数里的第一个（`Set-Content x.txt -Value hello` 的 hello 不是路径）
    push(operands[0])
  }
  return [...new Set(out)]
}

// ---------------------------------------------------------------- 网络命令

/** 一级词元就是网络工具的。 */
const NETWORK_HEADS = new Set([
  'curl', 'wget', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod',
  'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'ssh', 'scp', 'sftp', 'rsync',
  'test-netconnection', 'resolve-dnsname', 'gh',
])

/** 「程序 + 子命令」形态的网络动作。 */
const NETWORK_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['install', 'i', 'ci', 'add', 'create', 'update', 'publish', 'dlx', 'exec', 'x']),
  npx: new Set(['*']),
  pnpm: new Set(['install', 'i', 'add', 'update', 'publish', 'dlx', 'create', 'exec']),
  yarn: new Set(['install', 'add', 'upgrade', 'publish', 'dlx', 'create']),
  git: new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule', 'archive']),
  pip: new Set(['install', 'download']),
  pip3: new Set(['install', 'download']),
  cargo: new Set(['install', 'add', 'update', 'publish', 'login']),
  go: new Set(['get', 'install']),
  docker: new Set(['pull', 'push', 'login', 'run', 'build']),
  dotnet: new Set(['restore', 'add', 'nuget', 'tool']),
  apt: new Set(['install', 'update', 'upgrade']),
  'apt-get': new Set(['install', 'update', 'upgrade']),
  yum: new Set(['install', 'update']),
  dnf: new Set(['install', 'update']),
  apk: new Set(['add', 'update']),
  brew: new Set(['install', 'update', 'upgrade']),
  choco: new Set(['install', 'upgrade']),
  winget: new Set(['install', 'upgrade', 'search']),
  scoop: new Set(['install', 'update']),
  nuget: new Set(['install', 'restore']),
}

/** 这一段要不要联网。 */
export function isNetworkSegment(segment: CommandSegment, win32 = process.platform === 'win32'): boolean {
  const head = headOf(segment.tokens)
  if (head === '') return false
  if (NETWORK_HEADS.has(head)) return true
  const subs = NETWORK_SUBCOMMANDS[head]
  if (subs === undefined) return false
  if (subs.has('*')) return true
  // 子命令可能被开关夹在中间（`npm --silent install`）：取第一个非开关词元
  const sub = segment.tokens.slice(1).find((token) => !isFlag(token, win32))
  if (sub === undefined) return false
  return subs.has(tokenName(sub))
}

// ---------------------------------------------------------------- 判定入口

/** 认得出的「把命令写在参数里」的 shell：它们后面那段要再拆一次判。 */
const INLINE_SHELL_HEADS = new Set(['powershell', 'pwsh', 'cmd', 'sh', 'bash', 'zsh', 'dash', 'ksh'])

/** 内层命令的开关名（按平台各自习惯，两边都认，宽进严出）。 */
const INLINE_SHELL_FLAGS = new Set(['-command', '-c', '/c', '/k'])

/**
 * 这一段是不是「跑一段写在参数里的脚本」：是的话把那段脚本原文交出来。
 *
 * 为什么必须拆：`powershell -Command "Set-Content -Path C:\outside\x -Value y"` 的写目标
 * 藏在引号里，只看外层这一个词元（`powershell`）什么都看不出来——这是最常见的绕过写法。
 * 只认开关后面的那段（`sh -c rm x` 这种没加引号的按空格拼回去），认不出就不猜。
 *
 * @returns 内层命令原文；不是这种形态返回 null。
 */
export function innerShellCommand(segment: CommandSegment, win32: boolean): string | null {
  const head = headOf(segment.tokens)
  if (!INLINE_SHELL_HEADS.has(head)) return null
  const start = headIndex(segment.tokens)
  for (let i = start + 1; i < segment.tokens.length; i += 1) {
    if (!INLINE_SHELL_FLAGS.has(segment.tokens[i]!.toLowerCase())) continue
    const rest = segment.tokens.slice(i + 1)
    return rest.length === 0 ? null : rest.join(' ')
  }
  return null
}

/**
 * 把命令摊平成待判定的段：外层照旧保留（它的重定向还得看），
 * 认得出的内层脚本再拆一次（最多两层，够覆盖 `powershell -Command "sh -c ..."` 这种叠法）。
 */
function expandSegments(command: string, win32: boolean, depth = 0): CommandSegment[] {
  const out: CommandSegment[] = []
  for (const segment of splitSegments(command)) {
    if (depth < 2) {
      const inner = innerShellCommand(segment, win32)
      if (inner !== null && inner.trim() !== '') out.push(...expandSegments(inner, win32, depth + 1))
    }
    out.push(segment)
  }
  return out
}

export interface ExecOptions {
  /** 网络开关：关时命中网络命令 → forbidden。 */
  networkAccess: boolean
  /** 写目标判定（由路径策略提供，认不出来时保守拒）。 */
  checkWrite: (raw: string) => PathCheck
  /** 规则表（默认内置；自检里可换一份）。 */
  rules?: readonly ExecRule[]
  /** Windows 口径（默认取当前平台）。 */
  win32?: boolean
}

/** 一次命令判定的完整结果。 */
export interface ExecVerdict {
  decision: ExecDecision
  /** 定案的那条：内置规则名 / `network-off` / `write-target` / `default`。 */
  rule: string
  reason: string
  /** 认出来的写目标（原文，未绝对化）。 */
  writeTargets: readonly string[]
  /** 这条命令里有没有网络动作。 */
  network: boolean
}

/**
 * 判一条命令。
 *
 * 逐段判（`|`、`;`、`&&` 切开），任何一段 forbidden 就是整条 forbidden；
 * 全部只读放行才是 allow；其余是 prompt（交审批卡）。
 * 顺序：内置 forbidden 规则 → 网络开关 → 写目标归属 → allow 规则。
 * 带重定向/变量/子 shell 的段不给走 allow 规则（照 codex 那条「结构不可验证就不放行」）。
 * 内层脚本（`powershell -Command "..."`、`sh -c ...`）会再拆一层一起判——
 * 不拆的话写目标藏在引号里，等于没有围栏。
 */
export function evaluateCommand(command: string, options: ExecOptions): ExecVerdict {
  const rules = options.rules ?? BUILTIN_EXEC_RULES
  const win32 = options.win32 ?? process.platform === 'win32'
  const segments = expandSegments(command, win32)
  const writeTargets: string[] = []
  let network = false
  let decision: ExecDecision = 'allow'
  const loose: string[] = []

  for (const segment of segments) {
    if (segment.tokens.length === 0) continue

    const forbidden = rules.find((rule) => rule.decision === 'forbidden' && matchExecRule(rule, segment))
    if (forbidden !== undefined) {
      return {
        decision: 'forbidden',
        rule: forbidden.name,
        reason: `命令规则「${forbidden.name}」禁止这一段：${forbidden.justification}`,
        writeTargets,
        network,
      }
    }

    if (isNetworkSegment(segment, win32)) {
      network = true
      if (!options.networkAccess) {
        return {
          decision: 'forbidden',
          rule: 'network-off',
          reason: `这一段要联网（${segment.raw.trim()}），而沙箱的网络开关是关的`,
          writeTargets,
          network,
        }
      }
    }

    for (const target of writeTargetsOf(segment, win32)) {
      writeTargets.push(target)
      const check = options.checkWrite(target)
      if (!check.allowed) {
        return {
          decision: 'forbidden',
          rule: `write-target:${check.rule}`,
          reason: `命令里的写目标落不住：${check.reason}`,
          writeTargets,
          network,
        }
      }
    }

    const allowed = !segment.ruleUnfriendly && rules.some((rule) => rule.decision === 'allow' && matchExecRule(rule, segment))
    if (!allowed) {
      decision = 'prompt'
      loose.push(segment.raw.trim())
    }
  }

  if (decision === 'allow') {
    return { decision: 'allow', rule: 'allow-rule', reason: '各段都命中放行规则（只读/构建）', writeTargets, network }
  }
  const shown = loose.slice(0, 3).join('；')
  return {
    decision: 'prompt',
    rule: 'default',
    reason: `没命中沙箱的放行规则，按默认交给审批卡：${shown}`,
    writeTargets,
    network,
  }
}
