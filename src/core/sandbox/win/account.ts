/**
 * 沙箱账号密码的 DPAPI 存取 + setup 状态文件的读写（外加这几个文件的路径口径）。
 *
 * 为什么用 DPAPI CurrentUser：提权 setup 是用**同一个真人用户**的令牌跑起来的（UAC 只是提升完整性），
 * 所以 `CurrentUser` 作用域下加密的 blob，之后免提权跑 doctor / 启动沙箱时也能解开——
 * 而沙箱账号自己的密码是随机 24 位、只存在这个 blob 里，落盘必须是密文。
 *
 * DPAPI 的 ABI 很朴素，但 DATA_BLOB 要手工打包（仓库统一口径：结构体一律手工，koffi struct 不用）：
 *   typedef struct _DATA_BLOB { DWORD cbData; BYTE *pbData; } DATA_BLOB;   // x64 = 16 字节
 * 偏移：cbData@0（u32），pbData@8（指针，8 字节对齐所以中间有 4 字节填充）。
 * 入参与出参都是同一个 16 字节布局，`CryptProtectData`/`CryptUnprotectData` 的最后一个参数是出参 blob，
 * 里头 `pbData` 指向的缓冲是 API 自己 LocalAlloc 的，读完必须 LocalFree（ffi.ts 已绑）。
 *
 * @module dsc/core/sandbox/win/account
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addressOf, throwLastError, type BoundWin32, type WinFfi } from './ffi.js'

/** DPAPI 标志：禁止弹任何 UI（后台无人值守路径必须给，否则可能静默失败或卡住）。 */
export const CRYPTPROTECT_UI_FORBIDDEN = 0x1
/** DATA_BLOB 的 x64 字节数：cbData(u32) + 4 字节填充 + pbData(指针)。 */
export const DATA_BLOB_SIZE = 16

/**
 * setup 状态文件的形状：它是「二级布防做了什么」的账本，doctor 全靠它对账。
 * `wfpFilterCount` 是 dsc 额外记的诊断字段（脚本实际装上几条），不在最小必需集里。
 */
export interface DscSetupState {
  readonly version: number
  readonly account: string
  readonly sid: string
  readonly proxyPort: number
  readonly firewallRules: readonly string[]
  readonly wfpProviderGuid: string
  readonly wfpSublayerGuid: string
  readonly at: string
  readonly wfpFilterCount?: number
}

/** 读 setup 状态文件的三态结果：没文件是 `null`，有文件但坏了是 `{ok:false}`。 */
export type SetupStateRead =
  | { readonly ok: true; readonly state: DscSetupState }
  | { readonly ok: false; readonly error: string }
  | null

// ── 路径口径（setup.ts 生成脚本、doctor.ts 检查都从这里取，别各自拼）─────────────

/** `~/.dsc/sandbox`。 */
export function sandboxDir(dscHome: string): string {
  return join(dscHome, 'sandbox')
}

/** `~/.dsc/sandbox/setup-state.json`：布防账本。 */
export function setupStatePath(dscHome: string): string {
  return join(sandboxDir(dscHome), 'setup-state.json')
}

/** `~/.dsc/sandbox/account.bin`：DPAPI 保护的账号密码。 */
export function accountBlobPath(dscHome: string): string {
  return join(sandboxDir(dscHome), 'account.bin')
}

/** `~/.dsc/sandbox/setup.ps1`：生成的提权脚本落盘位置（审计用，也是 UAC 那条命令的 -File）。 */
export function setupScriptPath(dscHome: string): string {
  return join(sandboxDir(dscHome), 'setup.ps1')
}

/** `~/.dsc/sandbox/setup-error.txt`：提权脚本失败时写的失败原因。 */
export function setupErrorPath(dscHome: string): string {
  return join(sandboxDir(dscHome), 'setup-error.txt')
}

// ── DPAPI ────────────────────────────────────────────────────────────────────

type KoffiLike = WinFfi['koffi']
type KoffiLibrary = ReturnType<KoffiLike['load']>

/** crypt32 的绑定表（懒加载一次）。 */
interface CryptBindings {
  readonly protect: (...args: unknown[]) => unknown
  readonly unprotect: (...args: unknown[]) => unknown
}

let cachedCrypt: CryptBindings | null = null

/** 绑 crypt32.dll；失败抛（调用方都是「要用密码」的路径，静默降级没意义）。 */
function loadCrypt32(bound: BoundWin32): CryptBindings {
  if (cachedCrypt !== null) return cachedCrypt
  try {
    const crypt32: KoffiLibrary = bound.koffi.load('crypt32.dll')
    const bind = (name: string, args: string[]): ((...a: unknown[]) => unknown) =>
      crypt32.func('__stdcall', name, 'int', args)
    cachedCrypt = {
      // BOOL CryptProtectData(DATA_BLOB *in, LPCWSTR descr, DATA_BLOB *entropy, PVOID reserved,
      //                       CRYPTPROTECT_PROMPTSTRUCT *prompt, DWORD flags, DATA_BLOB *out)
      protect: bind('CryptProtectData', ['void *', 'void *', 'void *', 'void *', 'void *', 'uint32', 'void *']),
      // BOOL CryptUnprotectData(DATA_BLOB *in, LPWSTR *descr, DATA_BLOB *entropy, PVOID reserved,
      //                         CRYPTPROTECT_PROMPTSTRUCT *prompt, DWORD flags, DATA_BLOB *out)
      unprotect: bind('CryptUnprotectData', ['void *', 'void *', 'void *', 'void *', 'void *', 'uint32', 'void *']),
    }
    return cachedCrypt
  } catch (error) {
    throw new Error(`crypt32.dll 绑定失败（DPAPI 不可用）：${errorText(error)}`)
  }
}

/**
 * 用 DPAPI CurrentUser 加密一段文本，返回可以直接落盘的密文。
 *
 * `bound` 是 ffi.ts 的绑定表（借它拿 koffi 与 LocalFree）；`plaintext` 是账号密码。
 */
export function protectSecret(bound: BoundWin32, plaintext: string): Buffer {
  const crypt = loadCrypt32(bound)
  const input = Buffer.from(plaintext, 'utf8')
  const inputBlob = packDataBlob(bound, input)
  const outputBlob = Buffer.alloc(DATA_BLOB_SIZE)
  const ok = Number(crypt.protect(inputBlob, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, outputBlob))
  if (ok === 0) throwLastError(bound, 'CryptProtectData')
  return readAndFreeBlob(bound, outputBlob, 'CryptProtectData')
}

/** 解开 `protectSecret` 的产物。密文被截断/换过用户/换过机器都会在这里抛，带系统错误码。 */
export function unprotectSecret(bound: BoundWin32, blob: Buffer): string {
  if (blob.length === 0) throw new Error('CryptUnprotectData 拒绝空密文（account.bin 是 0 字节？）')
  const crypt = loadCrypt32(bound)
  const inputBlob = packDataBlob(bound, blob)
  const outputBlob = Buffer.alloc(DATA_BLOB_SIZE)
  const ok = Number(crypt.unprotect(inputBlob, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, outputBlob))
  if (ok === 0) throwLastError(bound, 'CryptUnprotectData')
  return readAndFreeBlob(bound, outputBlob, 'CryptUnprotectData').toString('utf8')
}

/**
 * 打包 16 字节 DATA_BLOB：cbData 写在 0，pbData 指向 `data` 的首字节。
 * 注意 `data` 必须在 API 调用期间活着（blob 里存的是裸地址）。
 */
function packDataBlob(bound: BoundWin32, data: Buffer): Buffer {
  const blob = Buffer.alloc(DATA_BLOB_SIZE)
  blob.writeUInt32LE(data.length, 0)
  blob.writeBigUInt64LE(BigInt(addressOf(bound, data)), 8)
  return blob
}

/** 读出参 blob 的内容并 LocalFree 掉 API 分配的缓冲。 */
function readAndFreeBlob(bound: BoundWin32, outputBlob: Buffer, api: string): Buffer {
  const size = outputBlob.readUInt32LE(0)
  const pointer = Number(outputBlob.readBigUInt64LE(8))
  if (pointer === 0 || size === 0) {
    throw new Error(`${api} 报成功但给出空 blob（size=${String(size)}，pointer=${String(pointer)}）`)
  }
  try {
    const decoded = bound.koffi.decode(pointer, 'uint8', size) as ArrayBufferLike | Uint8Array
    const view = decoded instanceof Uint8Array ? decoded : new Uint8Array(decoded)
    return Buffer.from(view) // 拷贝一份，随后就能安全 LocalFree
  } finally {
    bound.localFree(pointer)
  }
}

// ── setup 状态文件 ───────────────────────────────────────────────────────────

/**
 * 读 `~/.dsc/sandbox/setup-state.json`。
 *
 * 返回：文件不存在 → `null`；解析/形状不对或读不动 → `{ok:false, error}`（带文件路径与原因）；
 * 正常 → `{ok:true, state}`。**不抛**——doctor 要的是一条明细，不是异常。
 *
 * PowerShell 5.1 的 `-Encoding UTF8` 会带 BOM，所以这里先剥 BOM 再 `JSON.parse`
 * （不剥的话 node 的 JSON.parse 会直接报错，是个很容易踩的假故障）。
 */
export function readSetupState(dscHome: string): SetupStateRead {
  const file = setupStatePath(dscHome)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { ok: false, error: `读 setup 状态文件失败（${file}）：${errorText(error)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(text))
  } catch (error) {
    return { ok: false, error: `setup 状态文件不是合法 JSON（${file}）：${errorText(error)}` }
  }
  const shape = coerceSetupState(parsed)
  if (!shape.ok) return { ok: false, error: `setup 状态文件字段不对（${file}）：${shape.error}` }
  return { ok: true, state: shape.state }
}

/** 逐字段核对状态文件；坏在哪一条要说清楚（doctor 会把这句原样打给用户）。 */
function coerceSetupState(value: unknown): { ok: true; state: DscSetupState } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, error: '顶层不是对象' }
  const record = value as Record<string, unknown>
  const version = record.version
  if (typeof version !== 'number' || !Number.isInteger(version)) return { ok: false, error: 'version 不是整数' }
  const account = record.account
  if (typeof account !== 'string' || account === '') return { ok: false, error: 'account 不是非空字符串' }
  const sid = record.sid
  if (typeof sid !== 'string' || sid === '') return { ok: false, error: 'sid 不是非空字符串' }
  const proxyPort = record.proxyPort
  if (typeof proxyPort !== 'number' || !Number.isInteger(proxyPort) || proxyPort < 0 || proxyPort > 65535) {
    return { ok: false, error: 'proxyPort 不是 0-65535 的整数' }
  }
  const rawRules = record.firewallRules
  if (!Array.isArray(rawRules) || rawRules.some((item) => typeof item !== 'string')) {
    return { ok: false, error: 'firewallRules 不是字符串数组' }
  }
  const provider = record.wfpProviderGuid
  if (typeof provider !== 'string' || provider === '') return { ok: false, error: 'wfpProviderGuid 不是非空字符串' }
  const sublayer = record.wfpSublayerGuid
  if (typeof sublayer !== 'string' || sublayer === '') return { ok: false, error: 'wfpSublayerGuid 不是非空字符串' }
  const at = record.at
  if (typeof at !== 'string' || at === '') return { ok: false, error: 'at 不是非空字符串' }
  const rawCount = record.wfpFilterCount
  if (rawCount !== undefined && typeof rawCount !== 'number') return { ok: false, error: 'wfpFilterCount 不是数字' }

  const state: DscSetupState = {
    version,
    account,
    sid,
    proxyPort,
    firewallRules: rawRules as string[],
    wfpProviderGuid: provider,
    wfpSublayerGuid: sublayer,
    at,
    ...(typeof rawCount === 'number' ? { wfpFilterCount: rawCount } : {}),
  }
  return { ok: true, state }
}

/** 去掉 UTF-8 BOM（PowerShell 5.1 的 `-Encoding UTF8` 会写）。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 异常转一句话。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
