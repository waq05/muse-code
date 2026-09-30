/**
 * 命令策略引擎：把一条 shell 命令切成独立段，逐段判 allow / ask / deny。
 *
 * 形状抄两家成熟做法：
 *   - Codex 把命令按 `| ; && || ()` 切段，每段单独判，带重定向/变量赋值的段不许走
 *     已授权规则（`prompts/templates/permissions/approval_policy/on_request.md:3-22`）；
 *     规则本身是前缀 DSL：`prefix_rule(pattern=[...], decision=allow|prompt|forbidden)`
 *     外加加载期自检的 `match/not_match` 例子（`execpolicy/README.md:5-24`）。
 *   - Hermes 的求值顺序是硬地板 → 用户 deny → 危险模式 → 允许清单，
 *     前面三层绕不过 yolo（`tools/approval_floors.py:5`、`approval_detection.py:52`）。
 *
 * dsc 的落地取舍：规则文件用 JSON（`~/.dsc/policy.rules`）而不是 Starlark，
 * 少一个解析器依赖；危险模式内置在代码里，用户只能加严不能放宽。
 *
 * @module dsc/core/command-policy
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 单条命令段的判定结果（从严到宽）。 */
export type CommandDecision = 'allow' | 'ask' | 'deny'

/** 用户规则文件路径（和 config.yaml 同级；能手改，也允许审批卡往里追加）。 */
export const POLICY_RULES_FILE = join(homedir(), '.dsc', 'policy.rules')

/** 一条前缀规则：`pattern` 是要按序匹配的命令词，末尾 `*` 表示「后面随便」。 */
export interface PrefixRule {
  pattern: string[]
  decision: CommandDecision
  /** 规则存在的原因（审批卡和审计日志会显示它）。 */
  justification?: string
  /** 加载期自检：这些命令必须命中本规则。 */
  match?: string[]
  /** 加载期自检：这些命令必须不命中本规则。 */
  notMatch?: string[]
}

export interface RulesFile {
  rules: PrefixRule[]
  /** 读文件时发现的问题（坏规则被跳过，但要说清楚是哪条为什么）。 */
  problems: string[]
}

/** 一次判定的完整结果。 */
export interface CommandVerdict {
  decision: CommandDecision
  /** 中文理由：审批卡标题下那行字，也是审计日志里的 reason。 */
  reason: string
  /** 命中的规则；null = 没命中任何用户规则。 */
  matchedRule: PrefixRule | null
  /**
   * 建议往规则文件里追加的前缀（审批卡上「永久允许」按它写）。
   * 破坏性动作、带重定向/变量赋值、heredoc 一律给 null——不给放宽的机会。
   */
  prefixRule: string[] | null
  /** 是否命中硬地板：true 时任何权限模式都不许放行。 */
  hardline: boolean
}

/** 命令切段后的产物。 */
export interface CommandSegment {
  /** 按序的词元（引号已剥）。 */
  tokens: string[]
  /** 这一段原文（审批卡展示用）。 */
  raw: string
  /** 这一段是否用了「不给走规则」的高级 shell 特性。 */
  ruleUnfriendly: boolean
  /**
   * 这一段把输出写进了文件（引号外的 `>`，不含 `2>&1` 这类指到文件描述符的重定向）。
   * 单看第一个词判只读会漏掉「`echo x > 任意文件`」——跑的程序是只读的，落盘不是。
   */
  redirect: boolean
  /**
   * 这一段里有命令替换（引号外的反引号，或任何位置的 `$(`）：替换内容会先执行一遍，
   * `echo $(node -e …)` 的头虽然是只读的 echo，真正干活的替换内容什么都能干。
   */
  subst: boolean
}

const DECISION_SEVERITY: Record<CommandDecision, number> = { allow: 0, ask: 1, deny: 2 }

/** 最严的那个决定就是整条命令的决定。 */
function strictest(a: CommandDecision, b: CommandDecision): CommandDecision {
  return DECISION_SEVERITY[b] > DECISION_SEVERITY[a] ? b : a
}

// ---------------------------------------------------------------- 命令切段

/**
 * 切段点 = shell 真正的分隔符。`&&` `||` 是 2 字符操作符，要在单 `&` 之前认，否则切碎；
 * 单字符认 `;` `|` 与换行（`\n` `\r`）——PowerShell 与 sh 都把换行当命令分隔符，
 * 不切的话「第一行带已授权前缀、第二行干别的」的多行命令会被整段按前缀放行
 * （2026-09-29 审查发现）；孤立 `&` 在 POSIX 是后台执行，同样是分隔符，
 * PowerShell 里整条本就是语法错误，切开判只会更严不会更松。
 * `2>&1`（`&` 紧跟在 `>` 后）与 `&>文件`（`&` 后面是 `>`）是重定向，不是分隔符，不能切。
 */

/**
 * 把命令切成独立段。
 *
 * 不做完整 shell 语法解析（那是 shell 自己的事），只做「够判定」的切分：
 * 认引号（含 PS 的单双引号）、认括号里的子命令、认续行符。
 */
export function splitSegments(command: string): CommandSegment[] {
  const src = command.replace(/\\\r?\n/g, ' ')
  const segments: CommandSegment[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let depth = 0

  const push = (): void => {
    const raw = current.trim()
    current = ''
    if (raw !== '') segments.push(tokenize(raw))
  }

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!
    if (quote !== null) {
      current += ch
      // 单引号里的一切都是字面量（PowerShell 与 sh 一致）；双引号/反引号里 \ 可转义。
      if (quote !== "'" && ch === '\\' && i + 1 < src.length) {
        current += src[i + 1]
        i += 1
      } else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    // 反引号不进引号态：在 sh 里它是命令替换（内容照样执行），在 PowerShell 里行尾反引号是续行。
    // 当引号处理会让替换内容里的 `;`、`|`、换行躲过切段——替换内容必须单独成段受审。
    if (ch === '(' || ch === '$(') {
      // 子 shell：整段留在这里判，但一旦因此判不清就不许走已授权规则。
      depth += 1
      current += ch
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      current += ch
      continue
    }
    if (depth > 0) {
      current += ch
      continue
    }
    const two = src.slice(i, i + 2)
    let op: string | null = null
    if (two === '&&' || two === '||') {
      op = two
    } else if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
      op = ch
    } else if (ch === '&' && two !== '&>' && src[i - 1] !== '>') {
      // 孤立 `&`：POSIX 后台执行分隔符；`2>&1`（前面是 `>`）与 `&>`（后面是 `>`）是重定向，不切。
      op = ch
    }
    if (op !== null) {
      push()
      if (op.length === 2) i += 1
      continue
    }
    current += ch
  }
  push()
  if (segments.length === 0) segments.push(tokenize(command.trim()))
  return segments
}

/** 一段命令 → 词元（引号已剥）+ 是否带「不许走规则」的特性。 */
function tokenize(raw: string): CommandSegment {
  const tokens: string[] = []
  let buf = ''
  let quote: '"' | "'" | '`' | null = null
  let started = false
  let ruleUnfriendly = false
  let redirect = false
  let subst = false

  const flush = (): void => {
    if (started) tokens.push(buf)
    buf = ''
    started = false
  }

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        // sh 的双引号里 `$()` 与反引号照样执行（PowerShell 的 `$()` 也是），替换内容得拦下；
        // 单引号里两个 shell 都是字面量，不标记。
        if (quote === '"' && ((ch === '$' && raw[i + 1] === '(') || ch === '`')) {
          ruleUnfriendly = true
          subst = true
        }
        buf += ch
      }
      started = true
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      if (ch === '`') {
        // 引号外的反引号：sh 的命令替换（PowerShell 行尾是续行，从严处理不区分）。
        ruleUnfriendly = true
        subst = true
      }
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flush()
      continue
    }
    // 重定向 / 通配符 / 变量赋值 / 命令替换：规则匹配一律不看这类段（抄 Codex 那段话）。
    if (ch === '>' || ch === '<' || ch === '*' || ch === '?' || ch === '$') ruleUnfriendly = true
    if (ch === '$' && raw[i + 1] === '(') subst = true
    // `>文件` / `>>文件` 是往盘上写；`2>&1` 只是接文件描述符，不算写文件。
    if (ch === '>' && raw[i + 1] !== '&') redirect = true
    if (ch === '=' && buf.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(buf)) ruleUnfriendly = true
    buf += ch
    started = true
  }
  flush()
  return { tokens, raw, ruleUnfriendly, redirect, subst }
}

// ---------------------------------------------------------------- 内置危险模式

/** 一条内置模式：命中即至少 ask（deny 类例外，直接硬拒）。 */
interface Pattern {
  name: string
  re: RegExp
  decision: CommandDecision
  reason: string
  /** 命中后要不要建议一个可持久化的前缀（危险动作一律不给）。 */
  suggest?: boolean
}

/** 灾难性动作：任何权限模式都拒（抄 Hermes 的 hardline 层）。 */
const HARDLINE: Pattern[] = [
  { name: 'rm-root', re: /\brm\s+(-[a-z]+\s+)*(\/|\/\*|"\/"|'\/')\s*$/i, decision: 'deny', reason: '删掉文件系统根目录' },
  {
    name: 'rm-home',
    re: /\brm\s+-[a-z]*[rf][a-z]*\s+("?\$?\{?(HOME|USERPROFILE)\}?]?~?)"?\s*$/i,
    decision: 'deny',
    reason: '删掉整个用户主目录',
  },
  {
    name: 'ps-remove-volume-root',
    re: /remove-item\b[^|;]*-recur[a-z]*[^|;]*("?[a-z]:\\{1,2}"?|\\?\{1,2}[a-z]:\\)/i,
    decision: 'deny',
    reason: '递归删掉整个盘根目录',
  },
  {
    name: 'ps-remove-windows',
    re: /remove-item\b[^|;]*(windows|system32|program files)/i,
    decision: 'deny',
    reason: '递归删掉 Windows 系统目录或 Program Files',
  },
  {
    // 末尾原来多写了一个 `\b`：`format C:` 的 `:` 后面就是行尾，`\b` 永远不成立，
    // 于是这条 Windows 上最常见的毁盘命令一路漏到审批卡。驱动器号后面必须是空白或行尾，
    // 这样 `dotnet format c:\proj` 这类参数不会被误伤。
    name: 'mkfs',
    re: /(?<![\w-])(mkfs(\.\w+)?\b|format\.com\b|format\s+(\/[\w:-]+\s+)*[a-z]:(\s|$))/i,
    decision: 'deny',
    reason: '格式化磁盘',
  },
  {
    name: 'ps-wipe-disk',
    re: /(?<![\w-])(format-volume|clear-disk|initialize-disk|remove-partition)\b/i,
    decision: 'deny',
    reason: '清空或重排磁盘分区（数据不可恢复）',
  },
  { name: 'diskpart-clean', re: /\bdiskpart\b|\bclean\s+(all|disks?)\b/i, decision: 'deny', reason: '用 diskpart 清盘' },
  { name: 'dd-device', re: /\bdd\b[^\n|;]*of=\/dev\//i, decision: 'deny', reason: '把数据直接写进块设备' },
  { name: 'redirect-device', re: />\s*\/dev\/(sd|nvme|hd|disk)/i, decision: 'deny', reason: '把输出重定向到物理磁盘设备' },
  {
    name: 'shadow-copy-delete',
    re: /vssadmin\s+delete\s+shadows|wbadmin\s+delete\s+systemstate/i,
    decision: 'deny',
    reason: '删除卷影副本（等于关掉最后的回滚手段）',
  },
  { name: 'cipher-wipe', re: /\bcipher\s+\/w[:\s]/i, decision: 'deny', reason: '擦除空闲磁盘簇（不可恢复）' },
  { name: 'nt-device-namespace', re: /\b\\\\[?.]\\/, decision: 'deny', reason: '访问 Windows NT 设备命名空间（绕过路径校验）' },
]

/** 危险动作：弹审批卡，且不许建议持久化前缀。 */
const DANGEROUS: Pattern[] = [
  {
    name: 'recursive-delete',
    re: /\b(rm|rmdir|del|erase|rd|ri|remove-item)\b[^\n|;]*(\s-[a-z]*r[a-z]*\b|--recur[s]|-force)/i,
    decision: 'ask',
    reason: '递归删除（删错就是批量丢文件）',
  },
  { name: 'force-push', re: /\bgit\s+push\b[^\n|;]*(--force\b|-f\b(?!or))|(--force-with-lease)/i, decision: 'ask', reason: '强推会改写远端历史' },
  { name: 'git-reset-hard', re: /\bgit\s+reset\s+--hard\b/i, decision: 'ask', reason: '丢弃未提交改动' },
  { name: 'git-clean', re: /\bgit\s+clean\b[^\n|;]*-[a-z]*f/i, decision: 'ask', reason: '删掉未跟踪文件' },
  { name: 'git-branch-d', re: /\bgit\s+branch\s+-[dD]\b/i, decision: 'ask', reason: '删除分支' },
  {
    name: 'download-pipe-shell',
    re: /(\b(curl|wget|invoke-webrequest|iwr)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|pwsh|powershell|iex|invoke-expression))/i,
    decision: 'ask',
    reason: '把网上下载的东西直接当脚本执行',
  },
  {
    name: 'encoded-command',
    re: /(-enc(odedcommand)?\s+[a-z0-9+/=]{16,}|base64\s+(-d|--decode)\b[^\n|]*\|\s*(sh|bash|pwsh|python))/i,
    decision: 'ask',
    reason: '执行编码过的命令（看不清要跑什么）',
  },
  { name: 'powerShell-iex', re: /\b(iex|invoke-expression)\b\s*\(/i, decision: 'ask', reason: '把字符串当代码执行' },
  { name: 'defender-off', re: /set-mppreference[^\n|;]*disable|remove-mppreference|set-mppreference[^\n|;]*exclusionpath/i, decision: 'ask', reason: '关闭或绕过杀毒/实时防护' },
  { name: 'amsi-etw-bypass', re: /amsiutils|amsiscanresult|etw\s+disable|stop-etwtracelog/i, decision: 'ask', reason: '关掉安全监控通道' },
  { name: 'account-or-task', re: /\b(net\s+user|schtasks\s+\/create|register-scheduledtask|New-LocalUser|Add-LocalGroupMember)\b/i, decision: 'ask', reason: '建账号或计划任务（常驻后门）' },
  { name: 'registry-hklm', re: /(reg\s+(add|delete)\s+hklm|new-itemproperty\s+-path\s+.{0,12}hklm|remove-itemproperty\s+-path\s+.{0,12}hklm)/i, decision: 'ask', reason: '改机器级注册表' },
  { name: 'perm-wide-open', re: /(\bchmod\s+(-\w+\s+)*777\b|icacls\b[^\n|;]*\b(everyone|users):(f|gi)\b|set-aclregistry|grant-citf)/i, decision: 'ask', reason: '把权限放开给所有人' },
  { name: 'firewall-off', re: /(netsh\s+advfirewall\s+set[^\n|;]*state\s+off|set-netfirewallprofile[^\n|;]*disabledstate|disable-netfirewall)/i, decision: 'ask', reason: '关闭防火墙' },
  { name: 'terraform-destroy', re: /\b(terraform|pulumi|cdk)\b[^\n|;]*(destroy|destroy\s+-auto)/i, decision: 'ask', reason: '销毁基础设施' },
  { name: 'kubectl-delete', re: /\bkubectl\s+delete\b|\bhelm\s+delete\b|\bdocker\s+(system\s+prune|volume\s+prune|rm\s+-f|volume\s+rm)/i, decision: 'ask', reason: '删除集群资源或容器数据' },
  { name: 'db-drop', re: /\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from\s+\w+\s*;?\s*$)/i, decision: 'ask', reason: '删表/删库/全表清空' },
  { name: 'publish', re: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+publish\b|\bdocker\s+push\b/i, decision: 'ask', reason: '发布到公共仓库（撤回不了）' },
  { name: 'ssh-key-write', re: /(ssh-keygen[^\n|;]*-f\s*\S|authorized_keys)/i, decision: 'ask', reason: '生成或改动 SSH 授权密钥' },
  { name: 'self-runtime-delete', re: /(process\.execPath)/i, decision: 'ask', reason: '删正在跑的程序自己（下次就起不来了）' },
]

/** 内置危险模式的一条命中（{@link builtinDangerHit} 的返回值）。 */
export interface DangerHit {
  /** 模式的稳定名字（诊断与自检按它对号入座）。 */
  name: string
  /** 说给模型与用户听的中文理由。 */
  reason: string
}

/**
 * 一段命令原文命中了哪条内置危险模式。
 *
 * 判定引擎自己用它（{@link classifyCommand} 的第三个求值层：内置危险模式），
 * 审批灾难地板也用它：地板要在模式闸门与审批卡之前先把危险命令认出来，
 * 两边共用同一份清单，加一条危险模式不必改两处。
 *
 * @param segmentRaw - 一段命令的原文（`splitSegments` 的产物，未词元化）。
 * @returns 命中的模式名与理由；没命中返回 null。
 */
export function builtinDangerHit(segmentRaw: string): DangerHit | null {
  const hit = DANGEROUS.find((pattern) => pattern.re.test(segmentRaw))
  return hit === undefined ? null : { name: hit.name, reason: hit.reason }
}

/** 明确安全的只读动作：允许在计划/探索模式跑，也允许在无头场景自动放行。 */
const READONLY_HEADS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'pwd', 'get-location', 'echo', 'write-output',
  'which', 'where', 'whereis', 'file', 'stat', 'du', 'df', 'free', 'uname', 'ver', 'Get-ChildItem',
  'Get-Content', 'Get-Item', 'Test-Path', 'Get-Location', 'Get-Date', 'git', 'rg', 'grep', 'find',
  'node', 'python', 'python3', 'date', 'env', 'printenv', 'ps', 'tasklist', 'Get-Process', 'sort',
  'uniq', 'sed', 'awk', 'jq', 'Get-CimInstance', 'Resolve-Path', 'Get-Command', 'Select-String',
  // 纯展示 / 纯查询的 PowerShell cmdlet：它们只加工管道里已有的对象，自己不碰盘、不起进程。
  // 管道按段判定，右侧少一个名字就把整条只读命令判成 ask（用户看到的是「查看个目录也要审批」）。
  'Select-Object', 'Where-Object', 'Sort-Object', 'Measure-Object', 'Group-Object', 'Compare-Object',
  'Format-Table', 'Format-List', 'Format-Wide', 'Format-Custom', 'Out-String', 'Out-Host', 'Out-Null',
  'Get-Member', 'Get-Unique',
  // 上面这些的常见纯别名（select=Select-Object、measure=Measure-Object、ft/fl/fw=三种 Format-*）。
  'select', 'measure', 'ft', 'fl', 'fw',
])

/**
 * 明确不许进上面那份名单的 PowerShell 动作，写在这里存档，免得下次有人「顺手补全」：
 *   - `ForEach-Object` / `%` / `foreach`：它们的 scriptblock 能执行任意代码，
 *     `Get-ChildItem | ForEach-Object { Remove-Item $_ }` 头是只读的，刀在花括号里；
 *   - `Tee-Object` 与 `Out-File`：把输出落到盘上，落盘就是动手；重定向那道防线对它们不生效
 *     （写法里没有 `>`，`segment.redirect` 是 false），只能靠不进名单来拦；
 *   - 一切 `Set-*` / `Remove-*` / `Invoke-*` / `Start-*` / `Stop-*` / `New-*`：改状态、删东西、起进程，
 *     它们落在「不在名单里 = 默认要问」这条路上，保持现状即可。
 */

/** 这些一级子命令即便是 git/node 也算写操作。 */
const WRITING_SUBCOMMANDS = new Set([
  'commit', 'push', 'pull', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'restore', 'clean',
  'stash', 'apply', 'am', 'tag', 'branch', 'remote', 'config', 'gc', 'filter-branch', 'worktree',
  'install', 'add', 'remove', 'uninstall', 'update', 'publish', 'link', 'prune', 'cache', 'run', 'exec', 'init',
])

/**
 * 这些程序自己就能执行任意代码：只看第一个词就判只读，等于把审批面整个绕开。
 * `node` 早就被单独排除（它的注释写着「什么都可能干」），同一个理由对其余解释器一样成立。
 */
const CODE_EXEC_HEADS = new Set([
  'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'osascript', 'wscript', 'cscript', 'mshta',
])

/** python 解释器（单独有一份子命令判定，见 {@link isReadOnlyPython}）。 */
const PYTHON_HEADS = new Set(['python', 'python2', 'python3', 'py'])

/**
 * python 只有跑「明确安全的测试模块」才算只读：`-c`、脚本文件、`-`、裸解释器全不算。
 * `pytest` 会执行仓库里的 conftest.py，属于「跑测试」这个明确意图，跟着白名单一起放行。
 */
const READONLY_PYTHON_MODULES = new Set(['pytest', 'unittest', 'json.tool'])

/** `find` 带这些开关就会执行命令、删文件或写文件（`-fprint` 系列会落盘）。 */
const FIND_WRITES = /-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/

/**
 * `sed` 的 `e` 命令会执行外部命令、`w`/`-i` 会写文件；`awk` 的 `system()`/`popen()` 同理，
 * `print > file` 也能落盘。命中这些就不再当只读。
 */
const STREAM_EDITOR_WRITES =
  /(?:^|[\s'";|])(?:-i\b|--in-place)|(?:^|[\s;'"])(?:e|w|r|R|W)(?=[\s;'"]|$)|system\s*\(|popen\s*\(|\|\s*"|>\s*\S/

// ---------------------------------------------------------------- 规则文件

/** 读规则文件；文件不存在 = 空规则集（正常情况，不是错误）。 */
export function readRules(file: string = POLICY_RULES_FILE): RulesFile {
  if (!existsSync(file)) return { rules: [], problems: [] }
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { rules: [], problems: [`规则文件不是合法 JSON，整份忽略：${(error as Error).message}`] }
  }
  const list = Array.isArray((raw as { rules?: unknown }).rules) ? (raw as { rules: unknown[] }).rules : []
  const rules: PrefixRule[] = []
  for (const item of list) {
    const rule = parseRule(item, problems, rules.length)
    if (rule !== null) rules.push(rule)
  }
  return { rules, problems }
}

function parseRule(item: unknown, problems: string[], index: number): PrefixRule | null {
  if (item === null || typeof item !== 'object') {
    problems.push(`第 ${index + 1} 条规则不是对象，已跳过`)
    return null
  }
  const doc = item as Record<string, unknown>
  const pattern = Array.isArray(doc.pattern)
    ? doc.pattern.map((token) => (Array.isArray(token) ? token.map(String) : String(token)))
    : null
  if (pattern === null || pattern.length === 0) {
    problems.push(`第 ${index + 1} 条规则缺 pattern（要一个非空的词元数组），已跳过`)
    return null
  }
  const decision = doc.decision
  if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') {
    problems.push(`第 ${index + 1} 条规则的 decision 只能是 allow/ask/deny，已跳过`)
    return null
  }
  const rule: PrefixRule = {
    pattern: pattern as string[],
    decision,
    ...(typeof doc.justification === 'string' ? { justification: doc.justification } : {}),
    ...(Array.isArray(doc.match) ? { match: doc.match.map(String) } : {}),
    ...(Array.isArray(doc.notMatch) ? { notMatch: doc.notMatch.map(String) } : {}),
  }
  // 加载期自检（Codex 的 match/not_match 就是规则自带的单元测试）。
  for (const example of rule.match ?? []) {
    if (matchRule(rule, splitSegments(example)[0] ?? { tokens: [], raw: example, ruleUnfriendly: true }) === null) {
      problems.push(`规则 ${rule.pattern.join(' ')} 的 match 例子没命中：${example}`)
    }
  }
  for (const example of rule.notMatch ?? []) {
    if (matchRule(rule, splitSegments(example)[0] ?? { tokens: [], raw: example, ruleUnfriendly: true }) !== null) {
      problems.push(`规则 ${rule.pattern.join(' ')} 的 notMatch 例子却命中了：${example}`)
    }
  }
  return rule
}

/** 追加一条规则（审批卡「永久允许」走这里）；已有等价前缀就不重复写。 */
export function appendRule(rule: PrefixRule, file: string = POLICY_RULES_FILE): void {
  const current = readRules(file)
  const sameIndex = current.rules.findIndex(
    (existing) => existing.pattern.join(' ') === rule.pattern.join(' ') && existing.decision === rule.decision,
  )
  const next = [...current.rules]
  if (sameIndex >= 0) next[sameIndex] = rule
  else next.push(rule)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ rules: next }, null, 2)}\n`, 'utf8')
  if (file === POLICY_RULES_FILE) cached = null
}

/** 进程内缓存的生效规则：审批与模式闸门共用同一份，避免两处判定不一致。 */
let cached: PrefixRule[] | null = null

/** 取生效规则（第一次调用时读盘）。 */
export function activeRules(): readonly PrefixRule[] {
  if (cached === null) cached = readRules().rules
  return cached
}

/** 规则文件被改过之后重新读一次。 */
export function reloadActiveRules(): RulesFile {
  const loaded = readRules()
  cached = loaded.rules
  return loaded
}

/** 规则匹配：pattern 是段词元的前缀；末尾 `*` 吃掉剩余；数组元素表示多选一。 */
function matchRule(rule: PrefixRule, segment: CommandSegment): string[] | null {
  if (segment.tokens.length === 0) return null
  const matched: string[] = []
  for (let i = 0; i < rule.pattern.length; i += 1) {
    const want = rule.pattern[i]!
    if (want === '*') return [...matched, '*']
    const got = segment.tokens[i]
    if (got === undefined) return null
    const lowered = got.toLowerCase().replace(/\.exe$/, '')
    const ok = Array.isArray(want) ? want.some((alt) => alt.toLowerCase() === lowered) : want.toLowerCase() === lowered
    if (!ok) return null
    matched.push(got)
  }
  return matched
}

// ---------------------------------------------------------------- 判定入口

export interface ClassifyOptions {
  /** 用户规则（调用方缓存一份，别每次都读盘）。 */
  rules?: readonly PrefixRule[]
  /** 正在跑的程序路径：命令里出现它就算自毁（计划模式外的强提示）。 */
  selfPaths?: readonly string[]
}

/**
 * 判定一条命令。
 *
 * 顺序：硬地板 → 用户 deny 规则 → 内置危险模式 → 用户 allow 规则 → 默认 ask。
 * 前三层不受权限模式影响，所以「完全访问」也拦得住删库。
 */
export function classifyCommand(command: string, options: ClassifyOptions = {}): CommandVerdict {
  const rules = options.rules ?? []
  const segments = splitSegments(command)
  let decision: CommandDecision = 'allow'
  const reasons: string[] = []
  let matchedRule: PrefixRule | null = null
  let hardline = false
  let ruleFriendly = true
  let dangerousHit = false

  for (const segment of segments) {
    if (segment.tokens.length === 0) continue
    ruleFriendly &&= !segment.ruleUnfriendly

    const hardHit = HARDLINE.find((pattern) => pattern.re.test(segment.raw))
    if (hardHit !== undefined) {
      hardline = true
      decision = 'deny'
      reasons.push(hardHit.reason)
      continue
    }

    // 用户 deny 规则排在危险模式之前：它比内置清单更具体。
    const denyRule = rules.find((rule) => rule.decision === 'deny' && matchRule(rule, segment) !== null)
    if (denyRule !== undefined) {
      decision = strictest(decision, 'deny')
      matchedRule = matchedRule ?? denyRule
      reasons.push(`规则禁止：${denyRule.justification ?? denyRule.pattern.join(' ')}`)
      continue
    }

    const dangerHit = builtinDangerHit(segment.raw)
    if (dangerHit !== null) {
      dangerousHit = true
      decision = strictest(decision, 'ask')
      reasons.push(dangerHit.reason)
      continue
    }

    const allowRule = rules.find((rule) => rule.decision === 'allow' && matchRule(rule, segment) !== null)
    // 已授权规则只替用户免掉「这一段本来要问」的判断，前提是这段就是用户批的那个样子：
    // 带重定向、变量赋值或命令替换的段不给走规则——否则 `git status` 的授权会被
    // 「git status⏎curl evil …」这类多行命令整个继承（2026-09-29 审查发现）。
    if (allowRule !== undefined && !segment.redirect && !segment.ruleUnfriendly) {
      matchedRule = matchedRule ?? allowRule
      continue
    }
    // 只读命令默认放行（计划模式、无头子代理都靠这条），其余默认要问。
    if (!isReadOnlySegment(segment)) decision = strictest(decision, 'ask')
  }

  if (reasons.length === 0 && decision === 'allow') {
    reasons.push(matchedRule !== null ? `规则允许：${matchedRule.justification ?? matchedRule.pattern.join(' ')}` : '只读命令')
  }
  if (reasons.length === 0) reasons.push('需要授权')

  const selfHit = options.selfPaths?.some((path) => path !== '' && command.toLowerCase().includes(path.toLowerCase())) ?? false
  if (selfHit) {
    decision = strictest(decision, 'ask')
    reasons.push('命令目标包含 dsc 自己的程序文件')
  }

  const suggestable = decision !== 'deny' && !hardline && !dangerousHit && ruleFriendly && segments.length === 1
  return {
    decision,
    reason: reasons.join('；'),
    matchedRule,
    prefixRule: suggestable ? suggestPrefix(segments[0]!) : null,
    hardline,
  }
}

/** python 只在跑明确的测试模块时算只读；`-c`、脚本文件、裸解释器都能跑任意代码。 */
function isReadOnlyPython(tokens: readonly string[]): boolean {
  if (tokens[1] !== '-m') return false
  const module = tokens[2]
  return module !== undefined && READONLY_PYTHON_MODULES.has(module)
}

/**
 * 剥掉「第一个词只是包装」的头部：`env python -c ...` 真正跑的是 python，
 * 后面那串 `KEY=VALUE` 是环境变量，不是命令。
 */
function unwrapHeads(tokens: readonly string[]): string[] {
  let index = 0
  while (index < tokens.length && tokens[index]!.toLowerCase().replace(/\.exe$/, '') === 'env') index += 1
  const wrapped = index > 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1
  // 裸 `env`（后面没有命令）就是打印环境变量，仍然只读。
  if (wrapped && index >= tokens.length) return ['env']
  return tokens.slice(index)
}

/**
 * 这一段是不是只读动作。
 *
 * 判据不止「第一个词在只读名单里」：还要排除把输出写进文件的重定向，排除自己能跑代码的
 * 解释器，排除 `find -delete`、`sed` 的 `e`/`w` 这类会把只读程序变成写操作的参数。
 */
function isReadOnlySegment(segment: CommandSegment): boolean {
  // 往盘上写东西的段一律不算只读：跑的程序再安全，落盘也是动手。
  if (segment.redirect) return false
  // 命令替换（$() 与反引号）会先把替换内容跑一遍再交给外面的命令：头是 echo 也拦不住替换里那把刀。
  if (segment.subst) return false
  const tokens = unwrapHeads(segment.tokens)
  const head = tokens[0]?.toLowerCase().replace(/\.exe$/, '')
  if (head === undefined) return false
  if (!READONLY_HEADS.has(head)) {
    // 大小写混排的命令名（Get-ChildItem）在 Set 里按原样存过，这里再比一次小写。
    const known = [...READONLY_HEADS].some((name) => name.toLowerCase() === head)
    if (!known) return false
  }
  if (CODE_EXEC_HEADS.has(head)) return false // 解释器直接执行脚本 = 什么都可能干
  if (PYTHON_HEADS.has(head)) return isReadOnlyPython(tokens)
  if (head === 'find' && FIND_WRITES.test(segment.raw)) return false
  if (head === 'sed' || head === 'awk') return !STREAM_EDITOR_WRITES.test(segment.raw)
  if (head === 'git') {
    const sub = tokens[1]?.toLowerCase()
    if (sub !== undefined && WRITING_SUBCOMMANDS.has(sub)) return false
  }
  return true
}

/** 建议一个可持久化的前缀：取前 2-3 个词，别把整条命令塞进去（抄 Codex 的告诫）。 */
function suggestPrefix(segment: CommandSegment): string[] | null {
  const head = segment.tokens[0]
  if (head === undefined) return null
  const sub = segment.tokens[1]
  if (sub === undefined || sub.startsWith('-')) return [head]
  if (sub === 'run' || sub === 'test' || sub === 'check') return [head, sub, segment.tokens[2] ?? '*']
  return [head, sub]
}

/** 无头/自动场景的一句话解释（给 tool 结果与审计看）。 */
export function verdictLine(verdict: CommandVerdict): string {
  return `${verdict.decision}：${verdict.reason}`
}
