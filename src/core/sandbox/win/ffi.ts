/**
 * koffi FFI 绑定层：kernel32（进程/管道/作业）+ advapi32（令牌/ACL/安全描述符）。
 *
 * 口径（全文件统一，勿混）：
 *   - **句柄与系统返回的指针（PSID/PACL/SD）一律 `uintptr_t`**，在 JS 侧就是 number；
 *     `koffi.decode(数值地址, 'uint8', n)` 可以直接读那块内存（已实测）；
 *   - **我们自己 Buffer 的入参指针用 `'void *'` 直接传 Buffer**（koffi 取其地址，
 *     且 API 的回写能从同一 Buffer 读回——已实测）；需要嵌进手工结构体的地址
 *     用 `koffi.address()` 取数值；
 *   - 结构体全部手工打包（见 abi.ts 偏移表），koffi struct 一概不用；
 *   - 每个 `int` 返回型调用失败都读 GetLastError 抛 `Win32Error{api, win32Code}`；
 *     「返回值即错误码」的调用走 `throwWin32`；
 *   - 加载失败要能被上层探测到而不是崩宿主：`tryLoadFfi()` 给 `{ok:false, why}`。
 *
 * @module dsc/core/sandbox/win/ffi
 */
import { createRequire } from 'node:module'
import { ERROR_BROKEN_PIPE, ERROR_NO_DATA } from './abi.js'

/** 带 API 名与 Win32 错误码的错误：上层给用户看的每句话都来自它。 */
export class Win32Error extends Error {
  readonly api: string
  readonly win32Code: number

  constructor(api: string, win32Code: number, detail: string) {
    super(`${api} 失败（Win32 错误码 ${String(win32Code)}）：${detail}`)
    this.name = 'Win32Error'
    this.api = api
    this.win32Code = win32Code
  }
}

/** koffi 模块的最小形状（只声明用到的那几个入口，避免整包类型依赖）。 */
interface KoffiLike {
  load(name: string): KoffiLibrary
  alloc(type: string, count: number): unknown
  decode(value: unknown, type: string, count?: number): unknown
  address(value: unknown): bigint
  errno(): number
}

interface KoffiLibrary {
  func(convention: string, name: string, result: string, args: string[]): (...args: unknown[]) => unknown
}

/** 绑定后的库对：进程侧（kernel32）与安全侧（advapi32）。 */
export interface WinFfi {
  readonly koffi: KoffiLike
  readonly k32: KoffiLibrary
  readonly adv: KoffiLibrary
}

let cached: WinFfi | null = null

/**
 * 尝试加载 FFI 底座。koffi 缺失/加载失败/非 Windows 都返回 `{ok:false}`，
 * 由调用方决定降级路径（插件照常挂载，强制后端不启用）。
 */
export function tryLoadFfi(): { ok: true; ffi: WinFfi } | { ok: false; why: string } {
  if (cached !== null) return { ok: true, ffi: cached }
  if (process.platform !== 'win32') return { ok: false, why: '非 Windows 平台' }
  try {
    const require = createRequire(import.meta.url)
    const koffi = require('koffi') as unknown as KoffiLike
    if (typeof koffi?.load !== 'function' || typeof koffi?.alloc !== 'function') {
      return { ok: false, why: 'koffi 模块形状不对（版本不匹配？）' }
    }
    cached = { koffi, k32: koffi.load('kernel32.dll'), adv: koffi.load('advapi32.dll') }
    return { ok: true, ffi: cached }
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) }
  }
}

/** 加载失败时直接抛（runner 子进程等「后端已确认可用」的路径用）。 */
export function loadFfi(): WinFfi {
  const result = tryLoadFfi()
  if (!result.ok) throw new Error(`Win32 FFI 底座不可用：${result.why}`)
  return result.ffi
}

/** 绑定一个 `__stdcall` 函数。 */
function bind(lib: KoffiLibrary, name: string, result: string, args: string[]): (...args: unknown[]) => unknown {
  return lib.func('__stdcall', name, result, args)
}

/** 绑定表形状（由 bindAll 推断；不写返回注解是为了避免 ReturnType 自引用）。 */
export type BoundWin32 = ReturnType<typeof bindAll>

/** 一份现成的绑定表。只在这里写签名，别处不碰 koffi 原生对象。 */
export function bindAll(ffi: WinFfi) {
  const { koffi, k32, adv } = ffi
  return {
    koffi,
    // ── kernel32：句柄/管道/作业/等待/锁（句柄一律 uintptr_t）──
    closeHandle: bind(k32, 'CloseHandle', 'int', ['uintptr_t']),
    getLastLastError: bind(k32, 'GetLastError', 'uint32', []),
    formatMessageW: bind(k32, 'FormatMessageW', 'uint32', ['uint32', 'void *', 'uint32', 'uint32', 'void *', 'uint32', 'void *']),
    createPipe: bind(k32, 'CreatePipe', 'int', ['void *', 'void *', 'void *', 'uint32']),
    setHandleInformation: bind(k32, 'SetHandleInformation', 'int', ['uintptr_t', 'uint32', 'uint32']),
    readFile: bind(k32, 'ReadFile', 'int', ['uintptr_t', 'void *', 'uint32', 'void *', 'void *']),
    peekNamedPipe: bind(k32, 'PeekNamedPipe', 'int', ['uintptr_t', 'void *', 'uint32', 'void *', 'void *', 'void *']),
    waitForSingleObject: bind(k32, 'WaitForSingleObject', 'uint32', ['uintptr_t', 'uint32']),
    getExitCodeProcess: bind(k32, 'GetExitCodeProcess', 'int', ['uintptr_t', 'void *']),
    createJobObjectW: bind(k32, 'CreateJobObjectW', 'uintptr_t', ['void *', 'void *']),
    setInformationJobObject: bind(k32, 'SetInformationJobObject', 'int', ['uintptr_t', 'uint32', 'void *', 'uint32']),
    assignProcessToJobObject: bind(k32, 'AssignProcessToJobObject', 'int', ['uintptr_t', 'uintptr_t']),
    resumeThread: bind(k32, 'ResumeThread', 'uint32', ['uintptr_t']),
    terminateProcess: bind(k32, 'TerminateProcess', 'int', ['uintptr_t', 'uint32']),
    terminateJobObject: bind(k32, 'TerminateJobObject', 'int', ['uintptr_t', 'uint32']),
    setConsoleCtrlHandler: bind(k32, 'SetConsoleCtrlHandler', 'int', ['void *', 'int']),
    setEnvironmentVariableW: bind(k32, 'SetEnvironmentVariableW', 'int', ['void *', 'void *']),
    createFileW: bind(k32, 'CreateFileW', 'uintptr_t', ['void *', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *']),
    lockFileEx: bind(k32, 'LockFileEx', 'int', ['uintptr_t', 'uint32', 'uint32', 'uint32', 'uint32', 'void *']),
    unlockFileEx: bind(k32, 'UnlockFileEx', 'int', ['uintptr_t', 'uint32', 'uint32', 'uint32', 'void *']),
    openProcess: bind(k32, 'OpenProcess', 'uintptr_t', ['uint32', 'int', 'uint32']),
    localAlloc: bind(k32, 'LocalAlloc', 'uintptr_t', ['uint32', 'uintptr_t']),
    localFree: bind(k32, 'LocalFree', 'uintptr_t', ['uintptr_t']),
    // ── advapi32：CreateProcessAsUserW 活在这家（令牌那一家），不在 kernel32 ──
    createProcessAsUserW: bind(adv, 'CreateProcessAsUserW', 'int', ['uintptr_t', 'void *', 'void *', 'void *', 'void *', 'int', 'uint32', 'void *', 'void *', 'void *', 'void *']),
    openProcessToken: bind(adv, 'OpenProcessToken', 'int', ['uintptr_t', 'uint32', 'void *']),
    convertStringSidToSidW: bind(adv, 'ConvertStringSidToSidW', 'int', ['void *', 'void *']),
    createWellKnownSid: bind(adv, 'CreateWellKnownSid', 'int', ['uint32', 'uintptr_t', 'void *', 'void *']),
    isValidSid: bind(adv, 'IsValidSid', 'int', ['uintptr_t']),
    getLengthSid: bind(adv, 'GetLengthSid', 'uint32', ['uintptr_t']),
    copySid: bind(adv, 'CopySid', 'int', ['uint32', 'void *', 'uintptr_t']),
    getTokenInformation: bind(adv, 'GetTokenInformation', 'int', ['uintptr_t', 'uint32', 'void *', 'uint32', 'void *']),
    setTokenInformation: bind(adv, 'SetTokenInformation', 'int', ['uintptr_t', 'uint32', 'void *', 'uint32']),
    createRestrictedToken: bind(adv, 'CreateRestrictedToken', 'int', ['uintptr_t', 'uint32', 'uint32', 'uintptr_t', 'uint32', 'uintptr_t', 'uint32', 'void *', 'void *']),
    setEntriesInAclW: bind(adv, 'SetEntriesInAclW', 'uint32', ['uint32', 'void *', 'uintptr_t', 'void *']),
    logonUserW: bind(adv, 'LogonUserW', 'int', ['void *', 'void *', 'void *', 'uint32', 'uint32', 'void *']),
    initializeAcl: bind(adv, 'InitializeAcl', 'int', ['void *', 'uint32', 'uint32']),
    addMandatoryAce: bind(adv, 'AddMandatoryAce', 'int', ['void *', 'uint32', 'uint32', 'uint32', 'void *']),
    setNamedSecurityInfoW: bind(adv, 'SetNamedSecurityInfoW', 'uint32', ['void *', 'uint32', 'uint32', 'uintptr_t', 'uintptr_t', 'uintptr_t', 'uintptr_t']),
    getNamedSecurityInfoW: bind(adv, 'GetNamedSecurityInfoW', 'uint32', ['void *', 'uint32', 'uint32', 'void *', 'void *', 'void *', 'void *', 'void *']),
  }
}

/** 系统错误文本（本地化），拿不到就空串。 */
function systemErrorText(bound: BoundWin32, code: number): string {
  try {
    const buffer = bound.koffi.alloc('uint16', 512)
    const written = Number(bound.formatMessageW(0x00001000, null, code, 0, buffer, 512, null))
    if (written <= 0) return ''
    const bytes = new Uint8Array(bound.koffi.decode(buffer, 'uint8', written * 2) as ArrayBufferLike)
    return Buffer.from(bytes.buffer, bytes.byteOffset, written * 2).toString('utf16le').trim()
  } catch {
    return ''
  }
}

/** 把最近一次 Win32 错误转成 `Win32Error` 抛出。 */
export function throwLastError(bound: BoundWin32, api: string): never {
  const code = Number(bound.getLastLastError()) >>> 0
  const detail = systemErrorText(bound, code)
  throw new Win32Error(api, code, detail !== '' ? detail : '（无系统描述）')
}

/** 「返回值即错误码」的调用（SetEntriesInAclW / Set·GetNamedSecurityInfoW）用这个抛。 */
export function throwWin32(bound: BoundWin32, api: string, code: number): never {
  const normalized = Number(code) >>> 0
  const detail = systemErrorText(bound, normalized)
  throw new Win32Error(api, normalized, detail !== '' ? detail : '（无系统描述）')
}

/** 这个管道错误意味着对端已关闭：读循环的正常终点，不算失败。 */
export function isBrokenPipe(code: number): boolean {
  const normalized = Number(code) >>> 0
  return normalized === ERROR_BROKEN_PIPE || normalized === ERROR_NO_DATA
}

// ── 槽位与内存小工具 ─────────────────────────────────────────────────────────

/** 开一个 `uintptr_t` 出参槽（句柄/系统指针回填），`get()` 直接给 number。 */
export function slotUintPtr(bound: BoundWin32): { slot: unknown; get: () => number } {
  const slot = bound.koffi.alloc('uintptr_t', 1)
  return { slot, get: () => Number(bound.koffi.decode(slot, 'uintptr_t')) }
}

/** 开一个 `uint32` 出参槽。 */
export function slotUint32(bound: BoundWin32): { slot: unknown; get: () => number } {
  const slot = bound.koffi.alloc('uint32', 1)
  return { slot, get: () => Number(bound.koffi.decode(slot, 'uint32')) }
}

/** 开一块 n 字节的读写内存（GetTokenInformation 的载荷、ReadFile 的落点）。 */
export function byteArea(bound: BoundWin32, n: number): { ptr: unknown; bytes: () => Uint8Array } {
  const ptr = bound.koffi.alloc('uint8', n)
  return { ptr, bytes: () => new Uint8Array(bound.koffi.decode(ptr, 'uint8', n) as ArrayBufferLike) }
}

/** Buffer 的数值地址（手工打包结构体时往里塞指针用；Buffer 必须活着别被 GC）。 */
export function addressOf(bound: BoundWin32, buffer: Buffer | Uint8Array): number {
  return Number(bound.koffi.address(buffer))
}

/** 读系统指针指向的内存（PSID/PACL/SD 都是数值地址，decode 直读）。 */
export function readMemory(bound: BoundWin32, address: number, n: number): Uint8Array {
  return new Uint8Array(bound.koffi.decode(address, 'uint8', n) as ArrayBufferLike)
}
