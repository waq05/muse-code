/**
 * WFP **只读探测**：koffi 绑 fwpuclnt.dll，查 dsc 的持久 sublayer 在不在。
 *
 * 这一层刻意只读、只免提权：装 filter 要走提权 PowerShell（见 setup.ts），
 * 平时（doctor）只想知道「布防还在不在」，所以只用 FwpmEngineOpen0 + FwpmSubLayerGetByKey0
 * 两个调用，任何一个都不抛异常——探测失败也要变成一句能读的 detail。
 *
 * 本机实测（非提权会话，很重要，决定了 detail 的写法）：
 *   - `FwpmEngineOpen0` 在标准用户下**能**成功（返回 0）；
 *   - 但标准用户会话**看不到任何内置 WFP 对象**：查内置层
 *     FWPM_LAYER_ALE_AUTH_CONNECT_V4 返回 FWP_E_LAYER_NOT_FOUND(0x80320004)，
 *     查一个不存在的子层返回 FWP_E_SUBLAYER_NOT_FOUND(0x80320007)；
 *   - `netsh wfp show state` 同样直接拒绝（ERROR_ACCESS_DENIED，要求提权）。
 * 所以「查不到子层」非提权时**不等于**「没布防」。这里的做法是再查一次内置层当哨兵：
 * 哨兵也查不到 → 老实说结论不可信；哨兵查得到 → 结论才可信。
 *
 * API 签名（注意与题面口径的差异）：`FwpmSubLayerGetByKey0` 是三个参数
 * `(engine, const GUID *key, FWPM_SUBLAYER0 **out)`，没有第四个参数，本文件按真实签名绑。
 *
 * @module dsc/core/sandbox/win/wfp
 */

import { bindAll, loadFfi, slotUintPtr, type BoundWin32 } from './ffi.js'
import {
  DSC_WFP_SUBLAYER_GUID,
  FWPM_LAYER_ALE_AUTH_CONNECT_V4,
  FWP_E_ALREADY_EXISTS,
  FWP_E_FILTER_NOT_FOUND,
  FWP_E_IN_USE,
  FWP_E_LAYER_NOT_FOUND,
  FWP_E_LOOKUP_MISSING,
  FWP_E_NOT_FOUND,
  FWP_E_PROVIDER_NOT_FOUND,
  FWP_E_SUBLAYER_NOT_FOUND,
  RPC_C_AUTHN_WINNT,
} from './net-abi.js'

/** 探测结论：`present` 只说「查到了没有」，`detail` 说清楚「这个结论可不可信」。 */
export interface WfpProbeResult {
  readonly present: boolean
  readonly detail: string
}

/** fwpuclnt.dll 的绑定表（懒加载一次，之后复用）。 */
interface WfpBindings {
  readonly bound: BoundWin32
  readonly engineOpen: (...args: unknown[]) => unknown
  readonly engineClose: (...args: unknown[]) => unknown
  readonly subLayerGetByKey: (...args: unknown[]) => unknown
  readonly layerGetByKey: (...args: unknown[]) => unknown
  readonly freeMemory: (...args: unknown[]) => unknown
}

let cachedBindings: WfpBindings | null = null

/** 装载绑定；失败返回 `{ok:false}`（探测路径不抛）。 */
function loadWfpBindings(): { ok: true; bindings: WfpBindings } | { ok: false; why: string } {
  if (cachedBindings !== null) return { ok: true, bindings: cachedBindings }
  try {
    const bound = bindAll(loadFfi())
    const fw = bound.koffi.load('fwpuclnt.dll')
    const bind = (name: string, result: string, args: string[]): ((...a: unknown[]) => unknown) =>
      fw.func('__stdcall', name, result, args)
    cachedBindings = {
      bound,
      // FwpmEngineOpen0(serverName, authnService, authIdentity, session, HANDLE *engine)
      engineOpen: bind('FwpmEngineOpen0', 'uint32', ['void *', 'uint32', 'void *', 'void *', 'void *']),
      engineClose: bind('FwpmEngineClose0', 'void', ['uintptr_t']),
      // FwpmSubLayerGetByKey0(engine, const GUID *key, FWPM_SUBLAYER0 **out)
      subLayerGetByKey: bind('FwpmSubLayerGetByKey0', 'uint32', ['uintptr_t', 'void *', 'void *']),
      // FwpmLayerGetByKey0(engine, const GUID *key, FWPM_LAYER0 **out)：只当可见性哨兵用
      layerGetByKey: bind('FwpmLayerGetByKey0', 'uint32', ['uintptr_t', 'void *', 'void *']),
      freeMemory: bind('FwpmFreeMemory0', 'void', ['void *']),
    }
    return { ok: true, bindings: cachedBindings }
  } catch (error) {
    return { ok: false, why: `fwpuclnt.dll 绑定失败：${errorText(error)}` }
  }
}

/**
 * 把 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` 写成 16 字节的 Windows GUID 内存布局：
 * Data1 小端 4 字节、Data2 小端 2 字节、Data3 小端 2 字节、Data4 原样 8 字节。
 *
 * 例：`c38d57d1-05a7-4c33-904f-7fbceee60e82` → `d1578dc3a705334c904f7fbceee60e82`。
 * （WFP 的所有 key 都是这个二进制形态，写成大端字符串字节序会查不到任何东西。）
 */
export function guidStringToBuffer(guid: string): Buffer {
  const match = /^\{?([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{12})\}?$/.exec(
    guid.trim(),
  )
  if (match === null) throw new Error(`GUID 字面量不合法（期望 8-4-4-4-12）：${JSON.stringify(guid)}`)
  const [, data1, data2, data3, data4a, data4b] = match
  const buffer = Buffer.alloc(16)
  buffer.writeUInt32LE(Number.parseInt(data1, 16), 0)
  buffer.writeUInt16LE(Number.parseInt(data2, 16), 4)
  buffer.writeUInt16LE(Number.parseInt(data3, 16), 6)
  buffer.write(`${data4a}${data4b}`, 8, 'hex')
  return buffer
}

/**
 * 探测 dsc 的持久 WFP 子层在不在（免提权、只读、不抛）。
 *
 * 传 `sublayerGuid` 而不是写死常量，是为了让调用方拿 setup-state.json 里记录的那个 GUID 来查
 * （万一以后要换命名空间，探测跟着状态文件走）。默认值就是 dsc 自己的子层。
 */
export function probeWfpSublayer(sublayerGuid: string = DSC_WFP_SUBLAYER_GUID): WfpProbeResult {
  let key: Buffer
  try {
    key = guidStringToBuffer(sublayerGuid)
  } catch (error) {
    return { present: false, detail: `子层 GUID 无法解析：${errorText(error)}` }
  }

  const loaded = loadWfpBindings()
  if (!loaded.ok) return { present: false, detail: `${loaded.why}（探测不了 WFP 子层）` }

  const { bound, engineOpen, engineClose, subLayerGetByKey, layerGetByKey, freeMemory } = loaded.bindings
  const engineSlot = slotUintPtr(bound)
  let engine = 0
  try {
    const openCode = Number(engineOpen(null, RPC_C_AUTHN_WINNT, null, null, engineSlot.slot)) >>> 0
    if (openCode !== 0) {
      return {
        present: false,
        detail: `FwpmEngineOpen0 失败（${describeCode(bound, openCode)}）：本进程打不开 WFP 引擎，查不到子层`,
      }
    }
    engine = engineSlot.get()
    if (engine === 0) {
      return { present: false, detail: 'FwpmEngineOpen0 报成功但给出空句柄：探测无法继续' }
    }

    const outSlot = slotUintPtr(bound)
    const code = Number(subLayerGetByKey(engine, key, outSlot.slot)) >>> 0
    if (code === 0) {
      freeMemory(outSlot.slot)
      return { present: true, detail: `查到 GUID ${sublayerGuid} 的持久子层，二级 WFP 布防在位` }
    }

    if (FWP_E_LOOKUP_MISSING.includes(code)) {
      if (wfpNamespaceVisible(bound, layerGetByKey, freeMemory, engine)) {
        return {
          present: false,
          detail: `未查到 GUID ${sublayerGuid} 的子层（同会话能查到内置 WFP 层，结论可信）：二级 WFP 未布防或已被清理`,
        }
      }
      return {
        present: false,
        detail:
          `未查到 GUID ${sublayerGuid} 的子层；但本会话连内置 WFP 层都查不到` +
          `（非提权会话看不到 WFP 对象，本机实测如此），这条结论不可信，请以 setup-state.json 与提权 setup 的汇总输出为准`,
      }
    }

    return {
      present: false,
      detail: `FwpmSubLayerGetByKey0 返回 ${describeCode(bound, code)}（不是「不存在」，属探测失败，不代表未布防）`,
    }
  } catch (error) {
    return { present: false, detail: `WFP 探测过程出错：${errorText(error)}` }
  } finally {
    if (engine !== 0) {
      try {
        engineClose(engine)
      } catch {
        // 句柄关不掉不影响已经算出来的结论；强杀进程也会回收。
      }
    }
  }
}

/**
 * 可见性哨兵：查一个**必然存在**的内置层（ALE_AUTH_CONNECT_V4）。
 * 查到 → 这个会话有 WFP 读权限，子层查不到就是真没有；查不到 → 没读权限，结论不可信。
 */
function wfpNamespaceVisible(
  bound: BoundWin32,
  layerGetByKey: (...args: unknown[]) => unknown,
  freeMemory: (...args: unknown[]) => unknown,
  engine: number,
): boolean {
  try {
    const outSlot = slotUintPtr(bound)
    const code = Number(layerGetByKey(engine, guidStringToBuffer(FWPM_LAYER_ALE_AUTH_CONNECT_V4), outSlot.slot)) >>> 0
    if (code === 0) {
      freeMemory(outSlot.slot)
      return true
    }
    return false
  } catch {
    return false
  }
}

/** WFP 返回码的名字表（只收己方核实过的那些；Probe 路径不抛，所以不走 ffi 的抛错口）。 */
const FWP_ERROR_NAMES: Readonly<Record<number, string>> = {
  [FWP_E_FILTER_NOT_FOUND]: 'FWP_E_FILTER_NOT_FOUND',
  [FWP_E_LAYER_NOT_FOUND]: 'FWP_E_LAYER_NOT_FOUND',
  [FWP_E_PROVIDER_NOT_FOUND]: 'FWP_E_PROVIDER_NOT_FOUND',
  [FWP_E_SUBLAYER_NOT_FOUND]: 'FWP_E_SUBLAYER_NOT_FOUND',
  [FWP_E_NOT_FOUND]: 'FWP_E_NOT_FOUND',
  [FWP_E_ALREADY_EXISTS]: 'FWP_E_ALREADY_EXISTS',
  [FWP_E_IN_USE]: 'FWP_E_IN_USE',
}

/**
 * 把返回码写成「0x80320007（FWP_E_SUBLAYER_NOT_FOUND）」这种能直接读的形状。
 * FWP_E_* 是 HRESULT，FormatMessageW 解不出文本；Win32 错误码（如拒绝访问）能解出来，
 * 所以两边都试：名字表命中就带名字，系统消息拿得到就再带一句。
 */
function describeCode(bound: BoundWin32, code: number): string {
  const hex = `0x${code.toString(16).padStart(8, '0')}`
  const name = FWP_ERROR_NAMES[code]
  const systemText = win32ErrorText(bound, code)
  const parts = [hex]
  if (name !== undefined) parts.push(name)
  if (systemText !== '') parts.push(systemText)
  return parts.join('，')
}

/** 系统错误文本（拿不到就空串）。ffi.ts 里那份是私有的，这里只重写这一小段，不改 ffi.ts。 */
function win32ErrorText(bound: BoundWin32, code: number): string {
  try {
    const buffer = bound.koffi.alloc('uint16', 512)
    const written = Number(bound.formatMessageW(0x00001000, null, code, 0, buffer, 512, null))
    if (written <= 0) return ''
    const bytes = new Uint8Array(bound.koffi.decode(buffer, 'uint8', written * 2) as ArrayBufferLike)
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf16le').trim()
  } catch {
    return ''
  }
}

/** 异常转一句话。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
