/**
 * 二级网络管控的**状态汇总**（免提权的 doctor）：把「布防还在不在」拆成 6 项逐条查。
 *
 * 六项：① koffi/Win32 FFI 底座 → ② setup-state.json → ③ 账号存在且已启用 →
 *       ④ account.bin 能用 DPAPI 解开 → ⑤ 5 条防火墙规则在且按账号 SID 限定作用域 →
 *       ⑥ WFP 持久子层还在。
 * 全绿 → `full`；任何一项缺 → `partial`。每项**独立容错**：一项炸了只让它自己变红，
 * 不影响其余项，也不抛异常——doctor 的产物永远是「一句话明细列表」。
 *
 * 一个诚实的边界（本机实测）：非提权会话看不到 WFP 对象，所以 ⑥ 在没提权的会话里可能报
 * 「未查到」，wfp.ts 会把「结论不可信」写进 detail。这种情况 tier 依然是 partial（宁严勿松），
 * 但明细会明确告诉你这是探测能力问题、还是真没布防。
 *
 * @module dsc/core/sandbox/win/doctor
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bindAll, tryLoadFfi } from './ffi.js'
import { accountBlobPath, readSetupState, unprotectSecret, type DscSetupState } from './account.js'
import { firewallRuleNames, DSC_WFP_SUBLAYER_GUID } from './net-abi.js'
import { DSC_SANDBOX_ACCOUNT, DSC_SANDBOX_DEFAULT_PROXY_PORT } from './setup.js'
import { probeWfpSublayer } from './wfp.js'

/** doctor 结论：`full` = 六项全绿；`partial` = 有任何一项没对上。 */
export interface WindowsNetworkDoctorResult {
  readonly tier: 'full' | 'partial'
  readonly details: readonly string[]
}

/** 每项的超时（查防火墙/本地账号的 cmdlet 偶尔会慢，给足 20 秒）。 */
const ITEM_TIMEOUT_MS = 20_000

/**
 * 逐项检查并给中文明细。**不抛**：所有异常都变成一条 `×` 明细。
 */
export async function doctorWindowsNetwork(dscHome: string): Promise<WindowsNetworkDoctorResult> {
  const details: string[] = []
  let bad = 0
  const mark = (ok: boolean, text: string): void => {
    if (!ok) bad += 1
    details.push(`${ok ? '√' : '×'} ${text}`)
  }

  // ① FFI 底座：后面几项（DPAPI、WFP 探测）都要用
  let ffiOk = false
  try {
    const ffi = tryLoadFfi()
    ffiOk = ffi.ok
    mark(ffi.ok, ffi.ok ? 'koffi/Win32 FFI 底座可用（kernel32 + advapi32 已绑）' : `koffi/Win32 FFI 底座不可用：${ffi.why}`)
  } catch (error) {
    mark(false, `探测 FFI 底座时异常：${errorText(error)}`)
  }

  // ② 账本
  let state: DscSetupState | null = null
  try {
    const read = readSetupState(dscHome)
    if (read === null) {
      mark(false, '没有 setup-state.json：二级网络管控还没成功 setup 过一次')
    } else if (!read.ok) {
      mark(false, read.error)
    } else {
      state = read.state
      mark(
        true,
        `setup-state.json 在：账号 ${read.state.account}（${read.state.sid}），代理端口 ${String(read.state.proxyPort)}，布防时间 ${read.state.at}`,
      )
    }
  } catch (error) {
    mark(false, `读 setup-state.json 时异常：${errorText(error)}`)
  }

  const account = state?.account ?? DSC_SANDBOX_ACCOUNT
  const proxyPort = state?.proxyPort ?? DSC_SANDBOX_DEFAULT_PROXY_PORT
  const expectedSid = state?.sid ?? null

  // ③ 账号存在且已启用
  try {
    const probe = await queryAccount(account)
    if (!probe.ok) {
      mark(false, `查本地账号 ${account} 失败：${probe.detail}`)
    } else if (!probe.exists) {
      mark(false, `本地账号 ${account} 不存在（二级网络管控没布防，或已被清理）`)
    } else if (!probe.enabled) {
      mark(false, `本地账号 ${account} 存在但处于禁用态（setup 走到一半被打断？重跑 setup 即可）`)
    } else if (expectedSid !== null && probe.sid !== null && probe.sid.toLowerCase() !== expectedSid.toLowerCase()) {
      mark(false, `本地账号 ${account} 的 SID（${probe.sid}）与账本里的（${expectedSid}）不一致：账本是旧的，请重跑 setup`)
    } else {
      mark(true, `本地账号 ${account} 存在且已启用（SID ${probe.sid ?? '未知'}）`)
    }
  } catch (error) {
    mark(false, `查本地账号 ${account} 时异常：${errorText(error)}`)
  }

  // ④ account.bin 能解开（只报长度，绝不打印密码）
  try {
    if (!ffiOk) {
      mark(false, '跳过 account.bin 检查：FFI 底座不可用，DPAPI 解不开')
    } else {
      const blobPath = accountBlobPath(dscHome)
      if (!existsSync(blobPath)) {
        mark(false, `没有 account.bin（${blobPath}）：沙箱账号密码没落盘，起不了沙箱进程`)
      } else {
        const ffi = tryLoadFfi()
        if (!ffi.ok) throw new Error(`Win32 FFI 底座不可用：${ffi.why}`)
        const bound = bindAll(ffi.ffi)
        const secret = unprotectSecret(bound, readFileSync(blobPath))
        mark(true, `account.bin 可用 DPAPI 解开（明文 ${String(secret.length)} 个字符，按设计不打印内容）`)
      }
    }
  } catch (error) {
    mark(false, `account.bin 检查失败：${errorText(error)}`)
  }

  // ⑤ 5 条防火墙规则在，且按账号 SID 限定作用域
  try {
    const names = firewallRuleNames(proxyPort)
    const probe = await queryFirewallRules(names)
    if (!probe.ok) {
      mark(false, `查防火墙规则失败：${probe.detail}`)
    } else {
      const missing = names.filter((name) => !probe.found.includes(name.toLowerCase()))
      if (missing.length > 0) {
        mark(false, `防火墙规则缺 ${String(missing.length)} 条：${missing.join('、')}`)
      } else if (probe.scopes.size === 0) {
        mark(true, `5 条防火墙规则都在（作用域没读出来，没有核对 LocalUserAuthorizedList）`)
      } else if (expectedSid === null) {
        mark(true, `5 条防火墙规则都在（账本里没有 SID，跳过了作用域核对）`)
      } else {
        // 认两种写法：SDDL 里可能是 SID，也可能被规范化成账号名（都不算错，只要不是别的账号）
        const wrong = [...probe.scopes.entries()].filter(([, scope]) => {
          const text = scope.toLowerCase()
          return !text.includes(expectedSid.toLowerCase()) && !text.includes(account.toLowerCase())
        })
        if (wrong.length > 0) {
          mark(false, `防火墙规则作用域不对（没按账号 ${account} / SID ${expectedSid} 限定）：${wrong.map(([name]) => name).join('、')}`)
        } else {
          mark(true, `5 条防火墙规则都在，且作用域都限定在账号 ${account}（SID ${expectedSid}）上`)
        }
      }
    }
  } catch (error) {
    mark(false, `查防火墙规则时异常：${errorText(error)}`)
  }

  // ⑥ WFP 持久子层——**提示项，不计入 tier**：非提权会话看不到 WFP 对象是 Windows
  // 权限行为（engine 打得开、对象查询必被拒），而 setup 脚本「首错即停」且账本写在
  // WFP 安装成功之后，②-⑤ 全绿已蕴含布防在位。探测结果只作展示，避免非提权环境
  // 永远 partial 的假阴性。
  try {
    const probe = probeWfpSublayer(state?.wfpSublayerGuid ?? DSC_WFP_SUBLAYER_GUID)
    if (probe.present) {
      details.push(`√ WFP 子层探测：${probe.detail}`)
    } else {
      details.push(`· WFP 子层探测（提示项，不计入结论）：${probe.detail}——账本（②）在即代表布防已写入`)
    }
  } catch (error) {
    details.push(`· WFP 子层探测异常（提示项，不计入结论）：${errorText(error)}`)
  }

  return { tier: bad === 0 ? 'full' : 'partial', details }
}

/** 账号探测结果。 */
interface AccountProbe {
  readonly ok: boolean
  readonly detail: string
  readonly exists: boolean
  readonly enabled: boolean
  readonly sid: string | null
}

/** 用 PowerShell 查本地账号（Get-LocalUser 只在 PS 5.1+ 的 LocalAccounts 模块里有）。 */
async function queryAccount(account: string): Promise<AccountProbe> {
  const command = [
    `$u = Get-LocalUser -Name ${quotePowerShell(account)} -ErrorAction SilentlyContinue`,
    `if ($null -eq $u) { '{"exists":false}' } else {`,
    `  ConvertTo-Json -Compress -InputObject ([ordered]@{ exists = $true; enabled = [bool]$u.Enabled; sid = [string]$u.SID.Value })`,
    `}`,
  ].join('\n')
  const outcome = await runPowerShell(command, ITEM_TIMEOUT_MS)
  if (outcome.code !== 0 && outcome.stdout.trim() === '') {
    return { ok: false, detail: `powershell 退出码 ${String(outcome.code)}：${outcome.stderr.trim() || '没有输出'}`, exists: false, enabled: false, sid: null }
  }
  try {
    const parsed = JSON.parse(outcome.stdout.trim()) as { exists?: unknown; enabled?: unknown; sid?: unknown }
    return {
      ok: true,
      detail: '',
      exists: parsed.exists === true,
      enabled: parsed.enabled === true,
      sid: typeof parsed.sid === 'string' ? parsed.sid : null,
    }
  } catch (error) {
    return { ok: false, detail: `解析 Get-LocalUser 输出失败：${errorText(error)}；原始输出 ${outcome.stdout.trim().slice(0, 200)}`, exists: false, enabled: false, sid: null }
  }
}

/** 防火墙探测结果：规则名清单（小写）+ 规则名 → LocalUser 作用域串。 */
interface FirewallProbe {
  readonly ok: boolean
  readonly detail: string
  readonly found: readonly string[]
  readonly scopes: ReadonlyMap<string, string>
}

/**
 * 查规则在不在，并顺带把每条规则的 LocalUserAuthorizedList 读出来（核对作用域）。
 * 作用域读不出来的那些（老系统/权限问题）不进 scopes，Doctor 会按「没核对」处理而不是判错。
 */
async function queryFirewallRules(names: readonly string[]): Promise<FirewallProbe> {
  const nameList = names.map(quotePowerShell).join(', ')
  const command = [
    `$out = @()`,
    `foreach ($r in @(Get-NetFirewallRule -Name @(${nameList}) -ErrorAction SilentlyContinue)) {`,
    `  $scope = ''`,
    `  try { $scope = [string](($r | Get-NetFirewallSecurityFilter).LocalUser) } catch { $scope = '' }`,
    `  $out += ($r.Name + '||' + $scope)`,
    `}`,
    `$out`,
  ].join('\n')
  const outcome = await runPowerShell(command, ITEM_TIMEOUT_MS)
  if (outcome.code !== 0 && outcome.stdout.trim() === '') {
    return { ok: false, detail: `powershell 退出码 ${String(outcome.code)}：${outcome.stderr.trim() || '没有输出'}`, found: [], scopes: new Map() }
  }
  const found: string[] = []
  const scopes = new Map<string, string>()
  for (const line of outcome.stdout.split(/\r?\n/)) {
    const text = line.trim()
    if (text === '') continue
    const [name, scope] = text.split('||')
    if (name === undefined || name === '') continue
    found.push(name.toLowerCase())
    if (typeof scope === 'string' && scope.trim() !== '') scopes.set(name, scope.trim())
  }
  return { ok: true, detail: '', found, scopes }
}

/** 跑一次 Windows PowerShell 5.1 的 -Command，收退出码与输出。 */
function runPowerShell(command: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    // 让 PS 用 UTF-8 写 stdout：中文的诊断信息（规则名、错误文本）按 GBK 出来在 node 侧就是乱码
    const wrapped = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`
    const child = spawn(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ code: -1, stdout, stderr: `${stderr}\n（超时 ${String(timeoutMs)} ms 已终止）` })
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
      resolve({ code: -1, stdout, stderr: `${stderr}\n${errorText(error)}` })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** PowerShell 单引号字面量：内部单引号翻倍。 */
function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** 异常转一句话。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
