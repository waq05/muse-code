/**
 * 二级网络管控的**一次性提权 setup**：生成 PowerShell 5.1 脚本（内嵌 C# 做 WFP 安装）+ 提权执行。
 *
 * 分工：TS 这边只负责「把要做的事写成一个可审计的 .ps1」（`buildSetupScript` 是纯函数，不碰盘），
 * 真正的提权动作全在那个脚本里（建账号、布防火墙、装 WFP filter）。`runSetupElevated` 负责落盘 + 拉起 UAC。
 *
 * 顺序即安全纪律（中断也不留「有账号没布防」的窗口）：
 *   建组 → 生成密码 → **-Disabled 建账号** → 进组 → 隐藏账号 → DPAPI 存密码 →
 *   5 条防火墙规则 → 12 条 WFP filter（单事务持久）→ 写 setup-state.json → **最后才 Enable-LocalUser**。
 *   任何一步抛错都 exit 1、账号停在禁用态；重跑脚本幂等。
 *
 * 与 codex 的两处刻意不同：
 *   1. 环回 TCP 的端口补集一步到位（不做「先全堵再收窄」两段式）——因为本脚本全程把账号钉在禁用态，
 *      不存在 codex 那种「账号已启用、规则还在装」的敞口；
 *   2. 账本（setup-state.json）写在 Enable-LocalUser **之前**：这份账本也是「布防」的一部分，
 *      这样「账号已启用」就一定意味着「账本已在」，doctor 不会读到半截状态。
 *
 * @module dsc/core/sandbox/win/setup
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DSC_WFP_FILTERS,
  DSC_WFP_PROVIDER_GUID,
  DSC_WFP_SUBLAYER_GUID,
  firewallRuleSpecs,
  type FirewallRuleSpec,
} from './net-abi.js'
import { sandboxDir, setupErrorPath, setupScriptPath, readSetupState } from './account.js'

/** 固定的离线沙箱账号名（普通本地账号，不是服务账号）。 */
export const DSC_SANDBOX_ACCOUNT = 'dsc-sandbox-offline'
/** 沙箱账号组的名字（便于以后整体清理/识别）。 */
export const DSC_SANDBOX_GROUP = 'DscSandboxUsers'
/** 默认代理端口：沙箱里唯一被放行的环回 TCP 出口。 */
export const DSC_SANDBOX_DEFAULT_PROXY_PORT = 3128
/** 账本版本号（改了脚本语义就加一，doctor 可以据此判新旧）。 */
export const DSC_SETUP_STATE_VERSION = 1

/** `buildSetupScript` 的入参。 */
export interface SetupScriptOptions {
  /** dsc 家目录（脚本里 `~/.dsc`，状态文件与 account.bin 都落在它下面的 sandbox/）。 */
  readonly dscHome: string
  /** WFP provider 的 GUID（由调用方给，默认用 net-abi 里那一个）。 */
  readonly guidProvider?: string
  /** WFP sublayer 的 GUID（同上）。 */
  readonly guidSublayer?: string
  /** 代理端口，默认 3128。 */
  readonly proxyPort?: number
}

/**
 * 生成完整的提权脚本（纯函数：同样的入参给同样的文本）。
 *
 * 输入有一处会被写进 PowerShell 单引号字符串（dscHome 与几个名字），所以这里先校一遍形状，
 * 不合法就直接抛——把「路径里带单引号导致脚本被改写」这种事挡在生成阶段。
 */
export function buildSetupScript(options: SetupScriptOptions): string {
  const dscHome = options.dscHome
  if (typeof dscHome !== 'string' || dscHome === '') {
    throw new Error('buildSetupScript：dscHome 必须是非空字符串')
  }
  if (dscHome.includes("'") || /[\r\n]/.test(dscHome)) {
    throw new Error(`buildSetupScript：dscHome 不能含单引号或换行（会破坏生成的 PowerShell 文本）：${JSON.stringify(dscHome)}`)
  }
  const proxyPort = options.proxyPort ?? DSC_SANDBOX_DEFAULT_PROXY_PORT
  const guidProvider = options.guidProvider ?? DSC_WFP_PROVIDER_GUID
  const guidSublayer = options.guidSublayer ?? DSC_WFP_SUBLAYER_GUID
  assertGuid(guidProvider, 'guidProvider')
  assertGuid(guidSublayer, 'guidSublayer')

  const rules = firewallRuleSpecs(proxyPort) // 顺带校验 proxyPort 合法（不合法会抛 RangeError）
  const ruleNameList = rules.map((rule) => `'${rule.name}'`).join(', ')
  const firewallBlock = rules
    .map((rule) => [`  Remove-NetFirewallRule -Name '${rule.name}' -ErrorAction SilentlyContinue`, `  ${renderFirewallRule(rule)}`].join('\n'))
    .join('\n')
  const filterBlock = DSC_WFP_FILTERS.map(
    (spec) => `  '${spec.key}|${spec.name}|${spec.layer}|${spec.protocol === null ? '' : String(spec.protocol)}|${spec.remotePort === null ? '' : String(spec.remotePort)}'`,
  ).join('\n')

  return `# dsc 沙箱「网络管控第二级」一次性提权 setup。
# 由 src/core/sandbox/win/setup.ts 的 buildSetupScript() 生成 —— 要看改了什么就看那个函数，别手改本文件。
#
# 纪律：账号先以 -Disabled 建出来 → 防火墙 5 条 + WFP 12 条全部布防成功 → 写账本 → 最后才 Enable-LocalUser。
# 任何一步失败都会写 ~/.dsc/sandbox/setup-error.txt 并 exit 1，账号停在禁用态；重跑本脚本即幂等重做。
\$ErrorActionPreference = 'Stop'
\$DscHome = '${dscHome}'
\$DscSandboxDir = Join-Path \$DscHome 'sandbox'
\$DscAccount = '${DSC_SANDBOX_ACCOUNT}'
\$DscGroup = '${DSC_SANDBOX_GROUP}'
\$DscProxyPort = ${String(proxyPort)}
\$DscAccountDescription = 'dsc 沙箱离线账号（网络管控第二级用，非交互登录）'
\$DscProviderGuid = '${guidProvider}'
\$DscSublayerGuid = '${guidSublayer}'
\$DscStatePath = Join-Path \$DscSandboxDir 'setup-state.json'
\$DscSecretPath = Join-Path \$DscSandboxDir 'account.bin'
\$DscErrorPath = Join-Path \$DscSandboxDir 'setup-error.txt'
\$DscRuleNames = @(${ruleNameList})
\$DscFilters = @(
${filterBlock}
)

function Write-DscSetupError([string]\$Message) {
  # 失败原因单独落一个文件：提权窗口一闪而过，控制台输出经常来不及看
  try {
    New-Item -ItemType Directory -Force -Path \$DscSandboxDir | Out-Null
    \$text = ('[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('o'), \$Message)
    [System.IO.File]::WriteAllText(\$DscErrorPath, \$text, (New-Object System.Text.UTF8Encoding(\$false)))
  } catch {
    # 连错误文件都写不进去就只能靠控制台了
  }
}

function Get-DscRandomIndex([int]\$Max) {
  # 用密码学 RNG，不用 Get-Random（后者是给测试用的可预测源）
  \$bytes = New-Object byte[] 4
  \$DscRng.GetBytes(\$bytes)
  return [int]([System.BitConverter]::ToUInt32(\$bytes, 0) % [uint32]\$Max)
}

function Get-DscRandomChar([char[]]\$Set) {
  return \$Set[(Get-DscRandomIndex \$Set.Length)]
}

try {
  New-Item -ItemType Directory -Force -Path \$DscSandboxDir | Out-Null

  # ── 1. 组：存在就跳过 ──
  if (\$null -eq (Get-LocalGroup -Name \$DscGroup -ErrorAction SilentlyContinue)) {
    New-LocalGroup -Name \$DscGroup -Description 'dsc 沙箱账号组（二级网络管控用）' | Out-Null
  }

  # ── 2. 随机 24 位密码：四类字符各至少 2 个，再洗牌 ──
  #      只用 RandomNumberGenerator + 自己拼的字符集，不依赖 .NET Framework 里那套已废弃的成员解析类
  \$DscRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  \$DscUpper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.ToCharArray()
  \$DscLower = 'abcdefghijkmnopqrstuvwxyz'.ToCharArray()
  \$DscDigit = '23456789'.ToCharArray()
  \$DscSymbol = '!@#%^&*()-_=+'.ToCharArray()
  \$DscAll = \$DscUpper + \$DscLower + \$DscDigit + \$DscSymbol
  \$DscChars = New-Object System.Collections.Generic.List[char]
  foreach (\$set in @(\$DscUpper, \$DscLower, \$DscDigit, \$DscSymbol)) {
    1..2 | ForEach-Object { \$DscChars.Add((Get-DscRandomChar \$set)) }
  }
  1..16 | ForEach-Object { \$DscChars.Add((Get-DscRandomChar \$DscAll)) }
  for (\$i = \$DscChars.Count - 1; \$i -gt 0; \$i--) {
    \$j = Get-DscRandomIndex (\$i + 1)
    \$tmp = \$DscChars[\$i]; \$DscChars[\$i] = \$DscChars[\$j]; \$DscChars[\$j] = \$tmp
  }
  \$DscPassword = -join \$DscChars
  \$DscSecure = ConvertTo-SecureString -String \$DscPassword -AsPlainText -Force

  # ── 3. 账号：新建立刻是禁用态；已存在则重置密码并强制回禁用（中断后重跑的关键）──
  \$DscExisting = Get-LocalUser -Name \$DscAccount -ErrorAction SilentlyContinue
  if (\$null -eq \$DscExisting) {
    New-LocalUser -Name \$DscAccount -Password \$DscSecure -Description \$DscAccountDescription -PasswordNeverExpires -UserMayNotChangePassword -Disabled | Out-Null
  } else {
    Set-LocalUser -Name \$DscAccount -Password \$DscSecure -PasswordNeverExpires \$true
    Disable-LocalUser -Name \$DscAccount
  }
  \$DscSid = (Get-LocalUser -Name \$DscAccount).Sid.Value
  if (\$DscSid -notlike 'S-1-5-21-*') {
    throw "沙箱账号 SID 形状不对（本地账号应以 S-1-5-21- 开头）：\$DscSid"
  }

  # ── 4. 进组：Users（按 SID 找，免得撞上本地化组名）+ dsc 自己的组；按 SID 比对成员，已在组里就跳过 ──
  \$DscGroupTargets = @(\$DscGroup)
  \$DscUsersGroup = Get-LocalGroup -SID 'S-1-5-32-545' -ErrorAction SilentlyContinue
  if (\$null -ne \$DscUsersGroup) { \$DscGroupTargets += \$DscUsersGroup.Name }
  foreach (\$g in \$DscGroupTargets) {
    \$DscMemberSids = @(Get-LocalGroupMember -Group \$g -ErrorAction SilentlyContinue | ForEach-Object { \$_.SID.Value })
    if (\$DscMemberSids -notcontains \$DscSid) {
      Add-LocalGroupMember -Group \$g -Member \$DscAccount | Out-Null
    }
  }

  # ── 5. 从登录界面藏起来（SpecialAccounts\\UserList；只影响登录界面列表，不禁用账号）──
  \$DscWinlogonKey = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList'
  if (-not (Test-Path \$DscWinlogonKey)) { New-Item -Path \$DscWinlogonKey -Force | Out-Null }
  New-ItemProperty -Path \$DscWinlogonKey -Name \$DscAccount -PropertyType DWord -Value 0 -Force | Out-Null

  # ── 6. 密码用 DPAPI（CurrentUser）加密后落盘：提权只是提升完整性，还是同一个用户的 DPAPI 密钥，
  #      所以之后免提权也能解开 ──
  try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
  } catch {
    Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop
  }
  \$DscPlain = [System.Text.Encoding]::UTF8.GetBytes(\$DscPassword)
  \$DscBlob = [System.Security.Cryptography.ProtectedData]::Protect(\$DscPlain, \$null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [System.IO.File]::WriteAllBytes(\$DscSecretPath, \$DscBlob)
  \$DscPassword = \$null

  # ── 7. 防火墙 5 条：全部按账号 SID 限定作用域（LocalUser 的 SDDL 掩码 CC 就是 0x1 = FWP_ACTRL_MATCH_FILTER 同款语义）──
  #      代理端口的放行靠「block 规则的端口补集」，不靠 allow 规则——Windows 防火墙里显式 block 优先于 allow。
${firewallBlock}
  \$DscRuleCount = @(Get-NetFirewallRule -Name \$DscRuleNames -ErrorAction SilentlyContinue).Count
  if (\$DscRuleCount -ne \$DscRuleNames.Count) {
    throw "防火墙规则只装上 \$DscRuleCount / \$(\$DscRuleNames.Count) 条"
  }

  # ── 8. WFP：持久 provider + sublayer + 12 条 BLOCK filter，单事务提交（内嵌 C#，见下面的 P/Invoke）──
  \$DscWfpSource = @'
${WFP_CSHARP_SOURCE}
'@
  Add-Type -TypeDefinition \$DscWfpSource -Language CSharp
  \$DscLayout = [DscWfp]::SelfTest()
  if (-not \$DscLayout.StartsWith('OK')) { throw "WFP 结构体布局自检没通过：\$DscLayout" }
  \$DscInstalled = [DscWfp]::Install(\$DscAccount, \$DscSid, \$DscProviderGuid, \$DscSublayerGuid, \$DscFilters)
  if (\$DscInstalled -ne \$DscFilters.Count) {
    throw "WFP filter 只装上 \$DscInstalled / \$(\$DscFilters.Count) 条"
  }

  # ── 9. 账本：写在这里而不是最后，是为了让「账号已启用」必然蕴含「账本已在」──
  \$DscState = [ordered]@{
    version = ${String(DSC_SETUP_STATE_VERSION)}
    account = \$DscAccount
    sid = \$DscSid
    proxyPort = \$DscProxyPort
    firewallRules = \$DscRuleNames
    wfpProviderGuid = \$DscProviderGuid
    wfpSublayerGuid = \$DscSublayerGuid
    wfpFilterCount = \$DscInstalled
    at = (Get-Date).ToUniversalTime().ToString('o')
  }
  \$DscJson = \$DscState | ConvertTo-Json -Depth 5
  \$DscStateTmp = (\$DscStatePath + '.tmp')
  # 不带 BOM 的 UTF-8：PowerShell 5.1 的 -Encoding UTF8 会写 BOM，node 侧 JSON.parse 会直接报错
  [System.IO.File]::WriteAllText(\$DscStateTmp, \$DscJson, (New-Object System.Text.UTF8Encoding(\$false)))
  Move-Item -Path \$DscStateTmp -Destination \$DscStatePath -Force

  # ── 10. 最后一步：解禁。走到这里说明布防全部成功了 ──
  Enable-LocalUser -Name \$DscAccount

  Write-Output ('dsc 沙箱二级网络管控布防完成：账号 {0}（{1}），防火墙 {2} 条，WFP filter {3} 条，代理端口 {4}，账本 {5}' -f \$DscAccount, \$DscSid, \$DscRuleCount, \$DscInstalled, \$DscProxyPort, \$DscStatePath)
  exit 0
} catch {
  \$message = ('setup 失败：{0} @ {1}' -f \$_.Exception.Message, \$_.InvocationInfo.PositionMessage)
  Write-DscSetupError \$message
  # 用 [Console]::Error 而不是 Write-Error：$ErrorActionPreference='Stop' 下 Write-Error 自己也会抛，
  # 那样就走不到 exit 1 了（虽然 PowerShell 最终也会以非零码退出，但把语义写明确更好）
  [Console]::Error.WriteLine(\$message)
  exit 1
}
`
}

/** 生成一条 New-NetFirewallRule 调用（单行，避免 PowerShell 续行符那点麻烦）。 */
function renderFirewallRule(rule: FirewallRuleSpec): string {
  const parts = [
    'New-NetFirewallRule',
    `-Name '${rule.name}'`,
    `-DisplayName '${rule.displayName}'`,
    `-Description 'dsc 沙箱账号网络围栏（二级网络管控，由 dsc setup 生成）'`,
    `-Direction ${rule.direction}`,
    '-Action Block',
    '-Enabled True',
    '-Profile Any',
    `-Protocol ${rule.protocol}`,
    '-LocalUser "O:LSD:(A;;CC;;;$DscSid)"',
    `-RemoteAddresses '${rule.remoteAddresses}'`,
  ]
  if (rule.remotePorts !== null) parts.push(`-RemotePorts '${rule.remotePorts}'`)
  return parts.join(' ')
}

/** GUID 字面量校验（生成脚本前就挡掉，别让 PowerShell 那边报看不懂的错）。 */
function assertGuid(guid: string, label: string): void {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(guid)) {
    throw new Error(`buildSetupScript：${label} 不是合法 GUID 字面量：${JSON.stringify(guid)}`)
  }
}

/**
 * 落盘脚本并提权执行（会弹一次 UAC：`Start-Process -Verb RunAs`）。
 *
 * 结论取自三处：拉起进程的 exit code、`setup-state.json`（成功账本）、`setup-error.txt`（失败原因）。
 * 三处对不上时按「失败」报，并把能看到的信息都写进 detail —— 提权子进程崩了也不能只回一句「失败」。
 *
 * 注意：本任务里**不调用**它（会弹 UAC，且当前 shell 非管理员）；这里保证的是代码正确。
 */
export async function runSetupElevated(
  dscHome: string,
  options: { readonly proxyPort?: number; readonly timeoutMs?: number } = {},
): Promise<{ ok: boolean; detail: string }> {
  const scriptPath = setupScriptPath(dscHome)
  let script: string
  try {
    script = buildSetupScript({
      dscHome,
      guidProvider: DSC_WFP_PROVIDER_GUID,
      guidSublayer: DSC_WFP_SUBLAYER_GUID,
      ...(options.proxyPort === undefined ? {} : { proxyPort: options.proxyPort }),
    })
  } catch (error) {
    return { ok: false, detail: `生成 setup 脚本失败：${errorText(error)}` }
  }

  try {
    mkdirSync(sandboxDir(dscHome), { recursive: true })
    // 必须带 BOM：Windows PowerShell 5.1 只有在看到 BOM 时才按 UTF-8 读 .ps1，
    // 否则会按系统 ANSI 代码页解释，脚本里的中文（显示名、注释）会变乱码甚至解析失败。
    writeFileSync(scriptPath, `\uFEFF${script}`, { encoding: 'utf8' })
  } catch (error) {
    return { ok: false, detail: `写 setup 脚本失败（${scriptPath}）：${errorText(error)}` }
  }
  // 上一轮的失败记录必须先清掉，否则这一轮的结论会被旧文件带偏
  try {
    rmSync(setupErrorPath(dscHome), { force: true })
  } catch (error) {
    return { ok: false, detail: `清理旧 setup-error.txt 失败（${setupErrorPath(dscHome)}）：${errorText(error)}` }
  }

  let launcher: string
  try {
    launcher = buildElevationLauncher(scriptPath)
  } catch (error) {
    return { ok: false, detail: `拼提权命令失败：${errorText(error)}` }
  }
  const outcome = await runPowerShell(launcher, options.timeoutMs ?? 15 * 60 * 1000)
  const state = readSetupState(dscHome)
  const failureText = readSetupErrorText(dscHome)

  if (outcome.timedOut) {
    return { ok: false, detail: `提权 setup 超时未结束（可能在等 UAC 授权，或脚本卡住）：${outcome.stderr.trim()}` }
  }
  if (outcome.code === 0 && state !== null && state.ok) {
    return {
      ok: true,
      detail: `提权 setup 成功：账号 ${state.state.account}（${state.state.sid}）已启用，防火墙 ${String(state.state.firewallRules.length)} 条，WFP filter ${String(state.state.wfpFilterCount ?? -1)} 条`,
    }
  }
  const pieces = [`提权 setup 退出码 ${String(outcome.code)}`]
  if (failureText !== '') pieces.push(`脚本报错：${failureText}`)
  if (outcome.stderr.trim() !== '') pieces.push(`stderr：${outcome.stderr.trim().slice(0, 500)}`)
  if (state === null) {
    pieces.push('没有 setup-state.json（布防没走完）')
  } else if (!state.ok) {
    pieces.push(`账本读不动：${state.error}`)
  } else {
    pieces.push(`账本在（${state.state.at}）但退出码非 0，属半成品，请重跑 setup`)
  }
  return { ok: false, detail: pieces.join('；') }
}

/** 拼「非提权 PowerShell 拉起提权 PowerShell」的那一行（-Wait -PassThru 后把退出码透传出来）。 */
function buildElevationLauncher(scriptPath: string): string {
  if (/[\r\n]/.test(scriptPath)) throw new Error(`setup 脚本路径不能含换行：${JSON.stringify(scriptPath)}`)
  const quoted = `'${scriptPath.replace(/'/g, "''")}'`
  return [
    '$ErrorActionPreference = "Stop"',
    `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${quoted})`,
    'exit $p.ExitCode',
  ].join('; ')
}

/** 系统自带的 Windows PowerShell 5.1（Get-LocalUser / Get-NetFirewallRule / Add-Type 都在它这儿）。 */
function systemPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** 跑一次 powershell -Command，收退出码与输出（带超时，超时就杀）。 */
function runPowerShell(
  command: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(
      systemPowerShellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill()
        settled = true
        resolve({ code: -1, stdout, stderr, timedOut: true })
      }
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}${errorText(error)}`, timedOut: false })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut: false })
    })
  })
}

/** 读 setup-error.txt（没有就空串；顺手剥掉 BOM）。 */
function readSetupErrorText(dscHome: string): string {
  try {
    const text = readFileSync(setupErrorPath(dscHome), 'utf8')
    return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim()
  } catch {
    return ''
  }
}

/** 异常转一句话。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── 内嵌 C#：WFP 安装器 ──────────────────────────────────────────────────────
//
// 为什么用 C#（而不是 koffi 直接装）：装持久 filter 要管理员 + 单事务 + 一堆手写结构体，
// 这些在提权 PowerShell 里跑最省事（Add-Type 自带 C# 编译器，不用额外分发原生模块），
// 而 koffi 只留着做免提权读（见 wfp.ts）。
//
// **结构体布局是本文件最难的部分**，全部按 Windows SDK 头（fwpmtypes.h/fwptypes.h）逐字段写，
// 并逐条核对过 windows-sys 0.61.2 的 Rust 定义（同一份 Win32 元数据生成，字段序与 C 头一致）。
// x64 下的 sizeof 推算如下（MSVC 默认 Pack=8；含指针/uint64 的 union 对齐 8）：
//
//   FWP_BYTE_BLOB             = 4(cbData) + 4(补) + 8(pbData)                          = 16
//   FWPM_DISPLAY_DATA0        = 8(name) + 8(description)                               = 16
//   FWP_VALUE0                = 4(type) + 4(补，union 里含 UINT64* 故对齐 8) + 8(union) = 16
//   FWPM_FILTER_CONDITION0    = 16(fieldKey) + 4(matchType) + 4(补) + 16(conditionValue)= 40
//   FWPM_ACTION0              = 4(type) + 4(补) + 16(union{GUID|UINT64})               = 24
//   FWPM_FILTER0              = 见下面逐行偏移注释                                     = 200
//   FWPM_PROVIDER0            = 16+16(displayData)+4+4(补)+16(providerData)+8(service)  = 64
//   FWPM_SUBLAYER0            = 16+16+4+4(补)+8(providerKey)+16(providerData)+2(weight)
//                               + 6(补到 8 的倍数)                                      = 72
//   EXPLICIT_ACCESS_W         = 4+4+4 + 4(补) + 32(TRUSTEE_W)                          = 48
//     （与仓库已有的 abi.ts 里 EA_OFFSETS 完全一致：ptstrName@40、TrusteeForm@28）
//
// 这些数字不是「算得差不多」就行的：C# 里 union 用 Explicit 布局单独声明，外层结构体用
// Sequential + Pack=8 并把「C 里靠对齐自然出现」的 4 字节补洞写成显式的 pad 字段，
// 这样 CLR 的打点不会因为自己对齐规则不同而跑偏。SelfTest() 会在装之前把
// 每个 sizeof 与关键字段偏移都验一遍，对不上就抛（宁可不装，也不装一份条件错位的 filter）。

const WFP_CSHARP_SOURCE = `using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

// dsc 沙箱网络管控第二级：WFP 持久 provider + sublayer + 12 条 BLOCK filter 的安装器。
// 全部条件都以 ALE_USER_ID（SD 主体 = 沙箱账号 SID）限定，只影响沙箱账号。
public static class DscWfp
{
    // ── 常量（与 net-abi.ts 同源；值取自 Windows SDK，已与 windows-sys 0.61.2 逐条核对）──
    // FWP_ACTION_BLOCK 是 0x1001 而不是 0x1：0x1000 是 FWP_ACTION_FLAG_TERMINATING。
    private const uint FWP_ACTION_BLOCK = 0x1001;
    private const int FWP_MATCH_EQUAL = 0;
    private const int FWP_EMPTY = 0;
    private const int FWP_UINT8 = 1;
    private const int FWP_UINT16 = 2;
    private const int FWP_SECURITY_DESCRIPTOR_TYPE = 14;
    private const uint FWPM_FILTER_FLAG_PERSISTENT = 0x1;
    private const uint FWPM_PROVIDER_FLAG_PERSISTENT = 0x1;
    private const uint FWPM_SUBLAYER_FLAG_PERSISTENT = 0x1;
    private const uint FWP_ACTRL_MATCH_FILTER = 0x1;
    private const uint GRANT_ACCESS = 2;
    private const uint RPC_C_AUTHN_WINNT = 10;
    private const ushort DSC_SUBLAYER_WEIGHT = 0x8000;
    private const uint FWP_E_FILTER_NOT_FOUND = 0x80320003;
    private const uint FWP_E_NOT_FOUND = 0x80320008;
    private const uint FWP_E_ALREADY_EXISTS = 0x80320009;
    private const int AclSizeInformation = 2;
    private const string ProviderName = "dsc Windows Sandbox WFP";
    private const string SublayerName = "dsc Windows Sandbox WFP";
    private const string ProviderDescription = "dsc 沙箱网络管控的持久 WFP provider";
    private const string SublayerDescription = "dsc 沙箱网络管控的持久 WFP sublayer（12 条 BLOCK filter 挂这里）";

    // 条件 GUID（Windows 官方常量，fwpmu.h）
    private static readonly Guid CondAleUserId = new Guid("af043a0a-b34d-4f86-979c-c90371af6e66");
    private static readonly Guid CondIpProtocol = new Guid("3971ef2b-623e-4f9a-8cb1-6e79b806b9a7");
    private static readonly Guid CondIpRemotePort = new Guid("c35a604d-d22b-4e1a-91b4-68f674ee674b");

    // ── 结构体（x64，Pack=8；sizeof 推算见 setup.ts 顶部注释）──

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct FWP_BYTE_BLOB                 // 16：size@0，data@8
    {
        public uint size;
        public IntPtr data;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct FWPM_DISPLAY_DATA0            // 16：name@0，description@8
    {
        public IntPtr name;
        public IntPtr description;
    }

    // FWP_VALUE0 / FWP_CONDITION_VALUE0 的匿名 union：x64 上取最大成员（指针）＝ 8 字节。
    // 数值型条件（UINT8/UINT16）也走这里：小端下低地址就是最低字节，所以写 sd 这个指针槽
    // 等于把协议号/端口号写进了 union 的低位，读法一致。
    [StructLayout(LayoutKind.Explicit, Pack = 8)]
    internal struct FWP_VALUE0_UNION              // 8
    {
        [FieldOffset(0)] public byte uint8;
        [FieldOffset(0)] public ushort uint16;
        [FieldOffset(0)] public uint uint32;
        [FieldOffset(0)] public IntPtr sd;
        [FieldOffset(0)] public IntPtr uint64;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct FWP_VALUE0                    // 16：type@0，补 4，union@8
    {
        public int type;
        private int pad0;
        public FWP_VALUE0_UNION value;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct FWPM_FILTER_CONDITION0        // 40：fieldKey@0，matchType@16，补 4，conditionValue@24
    {
        public Guid fieldKey;
        public int matchType;
        private int pad0;
        public FWP_VALUE0 conditionValue;         // FWP_CONDITION_VALUE0 与 FWP_VALUE0 同布局
    }

    [StructLayout(LayoutKind.Explicit, Pack = 8)]
    internal struct FWPM_ACTION0_UNION            // 16：filterType(GUID) / calloutKey(UINT64) 叠在一起
    {
        [FieldOffset(0)] public Guid filterType;
        [FieldOffset(0)] public ulong calloutKey;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct FWPM_ACTION0                  // 24：type@0，补 4，union@8
    {
        public uint type;
        private uint pad0;
        public FWPM_ACTION0_UNION action;
    }

    [StructLayout(LayoutKind.Explicit, Pack = 8)]
    internal struct FWPM_FILTER0_UNION            // 16：rawContext(UINT64) / providerContextKey(GUID)
    {
        [FieldOffset(0)] public ulong rawContext;
        [FieldOffset(0)] public Guid providerContextKey;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct FWPM_FILTER0                  // 200
    {
        public Guid filterKey;                    //   0 .. 16
        public FWPM_DISPLAY_DATA0 displayData;    //  16 .. 32
        public uint flags;                        //  32 .. 36
        private uint pad0;                        //  36 .. 40（providerKey 是指针，C 里自然补 4）
        public IntPtr providerKey;                //  40 .. 48
        public FWP_BYTE_BLOB providerData;        //  48 .. 64
        public Guid layerKey;                     //  64 .. 80
        public Guid subLayerKey;                  //  80 .. 96
        public FWP_VALUE0 weight;                 //  96 .. 112（对齐 8）
        public uint numFilterConditions;          // 112 .. 116
        private uint pad1;                        // 116 .. 120（filterCondition 是指针）
        public IntPtr filterCondition;            // 120 .. 128
        public FWPM_ACTION0 action;               // 128 .. 152
        public FWPM_FILTER0_UNION anon;           // 152 .. 168
        public IntPtr reserved;                   // 168 .. 176
        public ulong filterId;                    // 176 .. 184
        public FWP_VALUE0 effectiveWeight;        // 184 .. 200
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct FWPM_PROVIDER0                // 64
    {
        public Guid providerKey;                  //  0 .. 16
        public FWPM_DISPLAY_DATA0 displayData;    // 16 .. 32
        public uint flags;                        // 32 .. 36
        private uint pad0;                        // 36 .. 40
        public FWP_BYTE_BLOB providerData;        // 40 .. 56
        public IntPtr serviceName;                // 56 .. 64
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct FWPM_SUBLAYER0                // 72（weight 之后补 6 字节到 8 的倍数，CLR 自动补）
    {
        public Guid subLayerKey;                  //  0 .. 16
        public FWPM_DISPLAY_DATA0 displayData;    // 16 .. 32
        public uint flags;                        // 32 .. 36
        private uint pad0;                        // 36 .. 40
        public IntPtr providerKey;                // 40 .. 48
        public FWP_BYTE_BLOB providerData;        // 48 .. 64
        public ushort weight;                     // 64 .. 66
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct TRUSTEE_W                     // 32
    {
        public IntPtr pMultipleTrustee;           //  0 .. 8
        public int MultipleTrusteeOperation;      //  8 .. 12
        public int TrusteeForm;                   // 12 .. 16
        public int TrusteeType;                   // 16 .. 20
        private int pad0;                         // 20 .. 24
        public IntPtr ptstrName;                  // 24 .. 32
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct EXPLICIT_ACCESS_W             // 48（与 abi.ts 的 EA_OFFSETS 一致）
    {
        public uint grfAccessPermissions;         //  0 .. 4
        public uint grfAccessMode;                //  4 .. 8
        public uint grfInheritance;               //  8 .. 12
        private uint pad0;                        // 12 .. 16
        public TRUSTEE_W Trustee;                 // 16 .. 48
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct ACL_SIZE_INFORMATION          // 12
    {
        public uint AceCount;
        public uint AclBytesInUse;
        public uint AclBytesFree;
    }

    // ── P/Invoke ──
    //
    // 全部写 ExactSpelling = true：带 W 后缀的入口名已经写全了，不要让运行时再去猜
    // 「名字 + W」「名字 + A」那套探测（探测不到才回落，容易埋下莫名其妙的 EntryPointNotFound）。

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmEngineOpen0(IntPtr serverName, uint authnService, IntPtr authIdentity, IntPtr session, out IntPtr engineHandle);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmEngineClose0(IntPtr engineHandle);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmTransactionBegin0(IntPtr engineHandle, uint flags);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmTransactionCommit0(IntPtr engineHandle);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmTransactionAbort0(IntPtr engineHandle);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmProviderAdd0(IntPtr engineHandle, ref FWPM_PROVIDER0 provider, IntPtr sd);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmSubLayerAdd0(IntPtr engineHandle, ref FWPM_SUBLAYER0 subLayer, IntPtr sd);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmFilterAdd0(IntPtr engineHandle, ref FWPM_FILTER0 filter, IntPtr sd, out ulong id);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    private static extern uint FwpmFilterDeleteByKey0(IntPtr engineHandle, ref Guid key);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern void BuildExplicitAccessWithNameW(ref EXPLICIT_ACCESS_W pExplicitAccess, IntPtr pTrusteeName, uint accessPermissions, uint accessMode, uint inheritance);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint BuildSecurityDescriptorW(IntPtr pOwner, IntPtr pGroup, uint cCountOfAccessEntries, ref EXPLICIT_ACCESS_W pListOfAccessEntries, uint cCountOfAuditEntries, IntPtr pListOfAuditEntries, IntPtr pOldSD, out uint pSizeNewSD, out IntPtr pNewSD);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool ConvertStringSidToSidW(string stringSid, out IntPtr sid);

    // LocalFree 在 kernel32（winbase.h），不在 advapi32：写错 DLL 名要到运行时才炸
    // （EntryPointNotFoundException），而且是炸在 finally 的释放路径上，最难查。
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool GetSecurityDescriptorDacl(IntPtr pSecurityDescriptor, out bool bDaclPresent, out IntPtr pDacl, out bool bDaclDefaulted);

    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool GetAclInformation(IntPtr pAcl, out ACL_SIZE_INFORMATION pAclInformation, uint nAclInformationLength, int dwAclInformationClass);

    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool GetAce(IntPtr pAcl, uint dwAceIndex, out IntPtr pAce);

    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern bool EqualSid(IntPtr pSid1, IntPtr pSid2);

    // ── 布局自检：装之前先把「我对 C 布局的理解」验一遍 ──

    private static void ExpectSize(StringBuilder report, string name, int actual, int expected)
    {
        report.Append(name).Append('=').Append(actual.ToString(CultureInfo.InvariantCulture)).Append(' ');
        if (actual != expected)
        {
            throw new InvalidOperationException("结构体布局与 C 头不一致：" + name + " CLR=" + actual.ToString(CultureInfo.InvariantCulture) + " 期望=" + expected.ToString(CultureInfo.InvariantCulture));
        }
    }

    private static void ExpectOffset(StringBuilder report, string label, int actual, int expected)
    {
        report.Append(label).Append(actual.ToString(CultureInfo.InvariantCulture)).Append(' ');
        if (actual != expected)
        {
            throw new InvalidOperationException("结构体字段偏移与 C 头不一致：" + label + " CLR=" + actual.ToString(CultureInfo.InvariantCulture) + " 期望=" + expected.ToString(CultureInfo.InvariantCulture));
        }
    }

    public static string SelfTest()
    {
        StringBuilder report = new StringBuilder();
        ExpectSize(report, "FWP_BYTE_BLOB", Marshal.SizeOf(typeof(FWP_BYTE_BLOB)), 16);
        ExpectSize(report, "FWPM_DISPLAY_DATA0", Marshal.SizeOf(typeof(FWPM_DISPLAY_DATA0)), 16);
        ExpectSize(report, "FWP_VALUE0", Marshal.SizeOf(typeof(FWP_VALUE0)), 16);
        ExpectSize(report, "FWPM_FILTER_CONDITION0", Marshal.SizeOf(typeof(FWPM_FILTER_CONDITION0)), 40);
        ExpectSize(report, "FWPM_ACTION0", Marshal.SizeOf(typeof(FWPM_ACTION0)), 24);
        ExpectSize(report, "FWPM_FILTER0", Marshal.SizeOf(typeof(FWPM_FILTER0)), 200);
        ExpectSize(report, "FWPM_PROVIDER0", Marshal.SizeOf(typeof(FWPM_PROVIDER0)), 64);
        ExpectSize(report, "FWPM_SUBLAYER0", Marshal.SizeOf(typeof(FWPM_SUBLAYER0)), 72);
        ExpectSize(report, "EXPLICIT_ACCESS_W", Marshal.SizeOf(typeof(EXPLICIT_ACCESS_W)), 48);
        // sizeof 对得上也可能是把两个字段的位置互换了，所以关键偏移也钉住
        ExpectOffset(report, "FWPM_FILTER0.action@", (int)Marshal.OffsetOf(typeof(FWPM_FILTER0), "action"), 128);
        ExpectOffset(report, "FWPM_FILTER0.effectiveWeight@", (int)Marshal.OffsetOf(typeof(FWPM_FILTER0), "effectiveWeight"), 184);
        ExpectOffset(report, "FWP_VALUE0.value@", (int)Marshal.OffsetOf(typeof(FWP_VALUE0), "value"), 8);
        ExpectOffset(report, "FWPM_ACTION0.action@", (int)Marshal.OffsetOf(typeof(FWPM_ACTION0), "action"), 8);
        ExpectOffset(report, "FWPM_FILTER_CONDITION0.conditionValue@", (int)Marshal.OffsetOf(typeof(FWPM_FILTER_CONDITION0), "conditionValue"), 24);
        ExpectOffset(report, "EXPLICIT_ACCESS_W.Trustee@", (int)Marshal.OffsetOf(typeof(EXPLICIT_ACCESS_W), "Trustee"), 16);
        return "OK " + report.ToString().Trim();
    }

    // ── 安装 ──

    /// <summary>
    /// 装持久 provider + sublayer + 每条 filter（单事务，persistent）。
    /// filters 每行形如 filterKey|name|layerKey|protocol|remotePort（后两个字段可空）。
    /// </summary>
    public static int Install(string account, string expectedSid, string providerGuid, string sublayerGuid, string[] filters)
    {
        if (String.IsNullOrEmpty(account)) throw new ArgumentException("沙箱账号名为空");
        if (filters == null || filters.Length == 0) throw new ArgumentException("filter 规格为空");
        Guid providerKey = Guid.Parse(providerGuid);
        Guid sublayerKey = Guid.Parse(sublayerGuid);

        IntPtr engine = IntPtr.Zero;
        IntPtr securityDescriptor = IntPtr.Zero;
        IntPtr expectedSidPtr = IntPtr.Zero;
        IntPtr accountNamePtr = IntPtr.Zero;
        IntPtr conditionBlobPtr = IntPtr.Zero;
        List<IntPtr> owned = new List<IntPtr>();
        uint sizeNewSd = 0;
        bool inTransaction = false;
        try
        {
            // 引擎：serverName=null、认证 RPC_C_AUTHN_WINNT、session=null。装持久对象要求管理员令牌。
            uint rc = FwpmEngineOpen0(IntPtr.Zero, RPC_C_AUTHN_WINNT, IntPtr.Zero, IntPtr.Zero, out engine);
            Fail(rc, "FwpmEngineOpen0（装 WFP 需要管理员权限）");

            // ALE_USER_ID 的条件值是一个自相对 SD，主体 = 沙箱账号 SID，ACE 掩码 = FWP_ACTRL_MATCH_FILTER(1)。
            // 用 BuildExplicitAccessWithNameW 按名字解析（提权会话下账号已存在），再让 BuildSecurityDescriptorW 造 SD。
            accountNamePtr = Marshal.StringToHGlobalUni(account);
            EXPLICIT_ACCESS_W access = new EXPLICIT_ACCESS_W();
            BuildExplicitAccessWithNameW(ref access, accountNamePtr, FWP_ACTRL_MATCH_FILTER, GRANT_ACCESS, 0);
            rc = BuildSecurityDescriptorW(IntPtr.Zero, IntPtr.Zero, 1, ref access, 0, IntPtr.Zero, IntPtr.Zero, out sizeNewSd, out securityDescriptor);
            Fail(rc, "BuildSecurityDescriptorW");
            if (securityDescriptor == IntPtr.Zero) throw new InvalidOperationException("BuildSecurityDescriptorW 给出空 SD");
            if (!ConvertStringSidToSidW(expectedSid, out expectedSidPtr)) throw Win32("ConvertStringSidToSidW");
            // 读回校验：SD 里的 SID 必须是 Get-LocalUser 报的那个，否则 filter 会挂在别人身上（fail-closed）
            VerifyUserSid(securityDescriptor, expectedSidPtr);

            // FWP_BYTE_BLOB{size, data} 自己也要住在非托管内存里，直到所有 FwpmFilterAdd0 都返回
            FWP_BYTE_BLOB conditionBlob = new FWP_BYTE_BLOB();
            conditionBlob.size = sizeNewSd;
            conditionBlob.data = securityDescriptor;
            conditionBlobPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FWP_BYTE_BLOB)));
            Marshal.StructureToPtr(conditionBlob, conditionBlobPtr, false);

            rc = FwpmTransactionBegin0(engine, 0);
            Fail(rc, "FwpmTransactionBegin0");
            inTransaction = true;

            AddProvider(engine, providerKey);
            AddSublayer(engine, sublayerKey, providerKey);

            int installed = 0;
            for (int i = 0; i < filters.Length; i++)
            {
                AddOneFilter(engine, filters[i], sublayerKey, providerKey, conditionBlobPtr, owned);
                installed++;
            }

            rc = FwpmTransactionCommit0(engine);
            Fail(rc, "FwpmTransactionCommit0");
            inTransaction = false;
            return installed;
        }
        catch
        {
            if (inTransaction)
            {
                try { FwpmTransactionAbort0(engine); } catch { }
            }
            throw;
        }
        finally
        {
            if (securityDescriptor != IntPtr.Zero) LocalFree(securityDescriptor);
            if (expectedSidPtr != IntPtr.Zero) LocalFree(expectedSidPtr);
            if (conditionBlobPtr != IntPtr.Zero) Marshal.FreeHGlobal(conditionBlobPtr);
            if (accountNamePtr != IntPtr.Zero) Marshal.FreeHGlobal(accountNamePtr);
            for (int i = 0; i < owned.Count; i++) Marshal.FreeHGlobal(owned[i]);
            if (engine != IntPtr.Zero) FwpmEngineClose0(engine);
        }
    }

    /// <summary>
    /// 免提权自检：按账号名造一份 ALE_USER_ID 用的 SD，再把 SID 与 ACE 掩码读回来核对。
    /// 这段逻辑（BuildExplicitAccessWithNameW + BuildSecurityDescriptorW + DACL 读回）不碰 WFP、
    /// 不改系统，所以普通权限就能验——它是整套条件里最容易出错、代价最大的一环（SID 挂错账号
    /// 等于围栏形同虚设），值得留一个能在装机前单独跑的验法。
    /// </summary>
    public static string SelfTestUserSd(string accountName, string expectedSid)
    {
        IntPtr securityDescriptor = IntPtr.Zero;
        IntPtr expectedSidPtr = IntPtr.Zero;
        IntPtr accountNamePtr = IntPtr.Zero;
        try
        {
            accountNamePtr = Marshal.StringToHGlobalUni(accountName);
            EXPLICIT_ACCESS_W access = new EXPLICIT_ACCESS_W();
            BuildExplicitAccessWithNameW(ref access, accountNamePtr, FWP_ACTRL_MATCH_FILTER, GRANT_ACCESS, 0);
            uint sizeNewSd = 0;
            uint rc = BuildSecurityDescriptorW(IntPtr.Zero, IntPtr.Zero, 1, ref access, 0, IntPtr.Zero, IntPtr.Zero, out sizeNewSd, out securityDescriptor);
            Fail(rc, "BuildSecurityDescriptorW");
            if (securityDescriptor == IntPtr.Zero) throw new InvalidOperationException("BuildSecurityDescriptorW 给出空 SD");
            if (!ConvertStringSidToSidW(expectedSid, out expectedSidPtr)) throw Win32("ConvertStringSidToSidW");
            VerifyUserSid(securityDescriptor, expectedSidPtr);
            return "OK sdSize=" + sizeNewSd.ToString(CultureInfo.InvariantCulture);
        }
        finally
        {
            if (securityDescriptor != IntPtr.Zero) LocalFree(securityDescriptor);
            if (expectedSidPtr != IntPtr.Zero) LocalFree(expectedSidPtr);
            if (accountNamePtr != IntPtr.Zero) Marshal.FreeHGlobal(accountNamePtr);
        }
    }

    private static void AddProvider(IntPtr engine, Guid providerKey)
    {
        IntPtr namePtr = Marshal.StringToHGlobalUni(ProviderName);
        IntPtr descPtr = Marshal.StringToHGlobalUni(ProviderDescription);
        try
        {
            FWPM_PROVIDER0 provider = new FWPM_PROVIDER0();
            provider.providerKey = providerKey;
            provider.displayData.name = namePtr;
            provider.displayData.description = descPtr;
            provider.flags = FWPM_PROVIDER_FLAG_PERSISTENT;
            provider.providerData.size = 0;
            provider.providerData.data = IntPtr.Zero;
            provider.serviceName = IntPtr.Zero;
            uint rc = FwpmProviderAdd0(engine, ref provider, IntPtr.Zero);
            // 已存在就是上一次装过（持久对象不会随进程消失），照常往下走
            if (rc != 0 && rc != FWP_E_ALREADY_EXISTS) Fail(rc, "FwpmProviderAdd0");
        }
        finally
        {
            Marshal.FreeHGlobal(namePtr);
            Marshal.FreeHGlobal(descPtr);
        }
    }

    private static void AddSublayer(IntPtr engine, Guid sublayerKey, Guid providerKey)
    {
        IntPtr providerKeyPtr = Marshal.AllocHGlobal(16);
        Marshal.StructureToPtr(providerKey, providerKeyPtr, false);
        IntPtr namePtr = Marshal.StringToHGlobalUni(SublayerName);
        IntPtr descPtr = Marshal.StringToHGlobalUni(SublayerDescription);
        try
        {
            FWPM_SUBLAYER0 sublayer = new FWPM_SUBLAYER0();
            sublayer.subLayerKey = sublayerKey;
            sublayer.displayData.name = namePtr;
            sublayer.displayData.description = descPtr;
            sublayer.flags = FWPM_SUBLAYER_FLAG_PERSISTENT;
            sublayer.providerKey = providerKeyPtr;
            sublayer.providerData.size = 0;
            sublayer.providerData.data = IntPtr.Zero;
            sublayer.weight = DSC_SUBLAYER_WEIGHT;
            uint rc = FwpmSubLayerAdd0(engine, ref sublayer, IntPtr.Zero);
            if (rc != 0 && rc != FWP_E_ALREADY_EXISTS) Fail(rc, "FwpmSubLayerAdd0");
        }
        finally
        {
            Marshal.FreeHGlobal(providerKeyPtr);
            Marshal.FreeHGlobal(namePtr);
            Marshal.FreeHGlobal(descPtr);
        }
    }

    private static void AddOneFilter(IntPtr engine, string line, Guid sublayerKey, Guid providerKey, IntPtr conditionBlobPtr, List<IntPtr> owned)
    {
        string[] parts = line.Split('|');
        if (parts.Length != 5) throw new ArgumentException("filter 规格行字段数应为 5：" + line);
        Guid filterKey = Guid.Parse(parts[0]);
        string name = parts[1];
        Guid layerKey = Guid.Parse(parts[2]);
        string protocolText = parts[3];
        string portText = parts[4];

        IntPtr namePtr = Marshal.StringToHGlobalUni(name);
        owned.Add(namePtr);
        IntPtr descPtr = Marshal.StringToHGlobalUni(name + " —— dsc 沙箱账号网络围栏");
        owned.Add(descPtr);
        IntPtr providerKeyPtr = Marshal.AllocHGlobal(16);
        Marshal.StructureToPtr(providerKey, providerKeyPtr, false);
        owned.Add(providerKeyPtr);

        int conditionCount = 1 + (protocolText.Length > 0 ? 1 : 0) + (portText.Length > 0 ? 1 : 0);
        int conditionSize = Marshal.SizeOf(typeof(FWPM_FILTER_CONDITION0));
        IntPtr conditions = Marshal.AllocHGlobal(conditionSize * conditionCount);
        owned.Add(conditions);
        int index = 0;
        WriteCondition(conditions, conditionSize, index, CondAleUserId, FWP_SECURITY_DESCRIPTOR_TYPE, conditionBlobPtr);
        index++;
        if (protocolText.Length > 0)
        {
            int protocol = Int32.Parse(protocolText, CultureInfo.InvariantCulture);
            WriteCondition(conditions, conditionSize, index, CondIpProtocol, FWP_UINT8, new IntPtr(protocol));
            index++;
        }
        if (portText.Length > 0)
        {
            int port = Int32.Parse(portText, CultureInfo.InvariantCulture);
            WriteCondition(conditions, conditionSize, index, CondIpRemotePort, FWP_UINT16, new IntPtr(port));
            index++;
        }

        // delete-if-present：同 key 的老 filter 先删（不存在就容忍），保证重跑幂等
        uint del = FwpmFilterDeleteByKey0(engine, ref filterKey);
        if (del != 0 && del != FWP_E_FILTER_NOT_FOUND && del != FWP_E_NOT_FOUND) Fail(del, "FwpmFilterDeleteByKey0(" + name + ")");

        FWPM_FILTER0 filter = new FWPM_FILTER0();
        filter.filterKey = filterKey;
        filter.displayData.name = namePtr;
        filter.displayData.description = descPtr;
        filter.flags = FWPM_FILTER_FLAG_PERSISTENT;
        filter.providerKey = providerKeyPtr;
        filter.providerData.size = 0;
        filter.providerData.data = IntPtr.Zero;
        filter.layerKey = layerKey;
        filter.subLayerKey = sublayerKey;
        filter.weight.type = FWP_EMPTY;          // 不指定权重：由 sublayer 权重 0x8000 决定先于防火墙默认子层被评估
        filter.numFilterConditions = (uint)conditionCount;
        filter.filterCondition = conditions;
        filter.action.type = FWP_ACTION_BLOCK;
        filter.action.action.filterType = Guid.Empty;
        filter.anon.rawContext = 0;
        filter.reserved = IntPtr.Zero;
        filter.filterId = 0;
        filter.effectiveWeight.type = FWP_EMPTY;

        ulong filterId;
        uint rc = FwpmFilterAdd0(engine, ref filter, IntPtr.Zero, out filterId);
        Fail(rc, "FwpmFilterAdd0(" + name + ")");
    }

    /// <summary>写一条 FWPM_FILTER_CONDITION0：小数/端口与 SD 指针都落在 union 的同一处。</summary>
    private static void WriteCondition(IntPtr basePtr, int size, int index, Guid fieldKey, int valueType, IntPtr value)
    {
        FWPM_FILTER_CONDITION0 condition = new FWPM_FILTER_CONDITION0();
        condition.fieldKey = fieldKey;
        condition.matchType = FWP_MATCH_EQUAL;
        condition.conditionValue.type = valueType;
        condition.conditionValue.value.sd = value;
        Marshal.StructureToPtr(condition, new IntPtr(basePtr.ToInt64() + (long)index * size), false);
    }

    /// <summary>读回 SD 的 DACL：ACE 条数 1、掩码 = FWP_ACTRL_MATCH_FILTER、SID = 期望的那个。</summary>
    private static void VerifyUserSid(IntPtr securityDescriptor, IntPtr expectedSid)
    {
        bool daclPresent;
        bool daclDefaulted;
        IntPtr dacl;
        if (!GetSecurityDescriptorDacl(securityDescriptor, out daclPresent, out dacl, out daclDefaulted) || !daclPresent || dacl == IntPtr.Zero)
        {
            throw new InvalidOperationException("构造出的账号 SD 没有 DACL，拒绝继续装 WFP filter");
        }
        ACL_SIZE_INFORMATION aclInfo = new ACL_SIZE_INFORMATION();
        if (!GetAclInformation(dacl, out aclInfo, (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)), AclSizeInformation)) throw Win32("GetAclInformation");
        if (aclInfo.AceCount != 1)
        {
            throw new InvalidOperationException("账号 SD 的 ACE 条数应为 1，实际 " + aclInfo.AceCount.ToString(CultureInfo.InvariantCulture));
        }
        IntPtr ace;
        if (!GetAce(dacl, 0, out ace)) throw Win32("GetAce");
        // ACCESS_ALLOWED_ACE：AceType@0(u8)、AceFlags@1(u8)、AceSize@2(u16)、Mask@4(u32)、SidStart@8
        int mask = Marshal.ReadInt32(ace, 4);
        if (mask != (int)FWP_ACTRL_MATCH_FILTER)
        {
            throw new InvalidOperationException("账号 SD 的 ACE 掩码应为 FWP_ACTRL_MATCH_FILTER(1)，实际 " + mask.ToString(CultureInfo.InvariantCulture));
        }
        IntPtr aceSid = new IntPtr(ace.ToInt64() + 8);
        if (!EqualSid(aceSid, expectedSid))
        {
            throw new InvalidOperationException("账号 SD 里的 SID 与 Get-LocalUser 报的 SID 不一致：ALE_USER_ID 会指向别的账号，拒绝继续");
        }
    }

    private static void Fail(uint code, string operation)
    {
        if (code != 0)
        {
            throw new InvalidOperationException(operation + " 失败：0x" + code.ToString("X8", CultureInfo.InvariantCulture));
        }
    }

    private static Exception Win32(string api)
    {
        return new InvalidOperationException(api + " 失败：Win32 错误码 " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
    }
}
`
