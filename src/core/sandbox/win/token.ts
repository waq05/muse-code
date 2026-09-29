/**
 * 受限令牌构造：从 dsc 自己的进程令牌派生一把「写受限」令牌。
 *
 * 机制照 dsh `sandbox-windows-acl`（2026-08-08 设计笔记）：
 *   - `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE|LUA_TOKEN|WRITE_RESTRICTED)`，
 *     禁用 SID 列表与删权限列表都为空——前两个标志已经合成「受限用户」效果；
 *   - restricting 列表 = [logon SID, Everyone, …可写根 SID]。
 *     **保活组 logon+Everyone 不能省**：CNG 密钥隔离文件与每登录会话的目录
 *     只授给登录会话 SID，缺了它们 DLL 初始化直接 0xC0000142（pwsh 则 0xE0434352）；
 *   - 完整性降到 Low（S-1-16-4096）。Untrusted 实测起不来 pwsh（BCrypt 0x8007045A），不用；
 *   - 顺手把新令牌的**默认 DACL** 塞一条能力 SID 的 FILE_ALL_ACCESS ACE：
 *     沙箱进程自己建匿名管道时 pass-2 交集检查要过这条，否则孙进程 stdio 全断。
 *
 * 刻意**不进** restricting 列表的 SID（dsh 实测结论）：Authenticated Users
 * （WMI 0x80041003 且关掉 C:\ 根建树逃逸）、INTERACTIVE/LOCAL（Public 树可写）、
 * S-1-2-1（同前）。
 *
 * WRITE_RESTRICTED 的语义边界（要背下来）：pass-2 交集**只对写生效**——
 * 读、网络、进程可见性跟普通用户一样，这不是 bug 是设计（读限制要换专用账号，
 * 属提权 setup 那一层的事）。
 *
 * 句柄口径：全模块句柄都是 uintptr_t 数值（见 ffi.ts 文件头），Buffer 入参由
 * koffi 取地址；被嵌进结构体的 Buffer 必须在调用期间被本模块的局部变量持有（防 GC）。
 *
 * @module dsc/core/sandbox/win/token
 */
import {
  CREATE_RESTRICTED_FLAGS,
  FILE_ALL_ACCESS,
  GRANT_ACCESS,
  PROCESS_QUERY_INFORMATION,
  SE_GROUP_INTEGRITY,
  SE_GROUP_LOGON_ID,
  SID_AND_ATTRIBUTES_SIZE,
  SID_MAX_BYTES,
  TokenDefaultDacl,
  TokenGroups,
  TokenIntegrityLevel,
  TOKEN_ACCESS,
  WinLowLabelSid,
  WinWorldSid,
  EA_OFFSETS,
  TRUSTEE_IS_SID,
  TRUSTEE_IS_UNKNOWN,
} from './abi.js'
import { type BoundWin32, slotUintPtr, slotUint32, byteArea, addressOf, readMemory, throwLastError, throwWin32 } from './ffi.js'

/** SID 串 → SID 字节副本（我们自己的 Buffer，地址可取、GC 可持）。 */
export function sidStringToBuffer(bound: BoundWin32, sid: string): Buffer {
  // str16 以 NUL 收尾：多留 2 字节写终止符
  const name = Buffer.alloc(sid.length * 2 + 2)
  name.write(sid, 0, 'utf16le')
  const out = slotUintPtr(bound)
  if (Number(bound.convertStringSidToSidW(name, out.slot)) === 0) throwLastError(bound, 'ConvertStringSidToSidW')
  const raw = out.get()
  try {
    const length = Number(bound.getLengthSid(raw))
    const area = byteArea(bound, length)
    if (Number(bound.copySid(length, area.ptr, raw)) === 0) throwLastError(bound, 'CopySid')
    return Buffer.from(area.bytes())
  } finally {
    bound.localFree(raw)
  }
}

/** Well-known SID → 字节副本（Everyone / 低完整性标签）。 */
export function wellKnownSidBuffer(bound: BoundWin32, kind: number): Buffer {
  const buffer = Buffer.alloc(SID_MAX_BYTES)
  // cbSid 是进出的 uint32：必须用真 Buffer 当 'void *'（API 的回写才能读回；
  // byteArea().bytes() 是 decode 出来的副本，写它到不了原生内存，API 会读到 0 报 122）
  const cbSid = Buffer.alloc(4)
  cbSid.writeUInt32LE(SID_MAX_BYTES, 0)
  if (Number(bound.createWellKnownSid(kind, 0, buffer, cbSid)) === 0) throwLastError(bound, 'CreateWellKnownSid')
  return buffer.subarray(0, cbSid.readUInt32LE(0))
}

/** 令牌组列表里把登录会话 SID 找出来（属性高位 = SE_GROUP_LOGON_ID）。 */
function logonSidBuffer(bound: BoundWin32, token: number): Buffer {
  const probe = slotUint32(bound)
  bound.getTokenInformation(token, TokenGroups, null, 0, probe.slot) // 第一叫只探长度，返回 0 也正常
  const needed = probe.get()
  if (needed === 0) throwLastError(bound, 'GetTokenInformation(TokenGroups 探长)')
  const area = byteArea(bound, needed)
  if (Number(bound.getTokenInformation(token, TokenGroups, area.ptr, needed, probe.slot)) === 0) {
    throwLastError(bound, 'GetTokenInformation(TokenGroups)')
  }
  // 组条目里的 SID 指针指向 koffi 分配块内部：基址必须是**原**块的地址
  const base = Number(bound.koffi.address(area.ptr))
  // 用 Buffer 自带方法读（内部算上 byteOffset）；new DataView(Buffer.from().buffer)
  // 会从共享池原点看，小块 byteOffset≠0 直接读歪（实测 RangeError）
  const bytes = Buffer.from(area.bytes())
  const count = bytes.readUInt32LE(0)
  for (let index = 0; index < count; index += 1) {
    const entry = 8 + index * SID_AND_ATTRIBUTES_SIZE
    const attributes = bytes.readUInt32LE(entry + 8) >>> 0
    // JS 位运算两侧转 int32：0xC0000007 & 0xC0000000 = 负数，必须 >>> 0 归一后再比
    const logonBits = (attributes & SE_GROUP_LOGON_ID) >>> 0
    if (logonBits !== SE_GROUP_LOGON_ID) continue
    const offset = Number(bytes.readBigUInt64LE(entry)) - base
    if (offset < 0 || offset >= needed) continue
    const subAuthorityCount = bytes[offset + 1]!
    const length = 8 + subAuthorityCount * 4
    if (offset + length > needed) continue
    return Buffer.from(area.bytes().subarray(offset, offset + length))
  }
  throw new Error('令牌组里找不到登录会话 SID（SE_GROUP_LOGON_ID）：没有保活组就没法构造受限令牌')
}

/** 往手工打包的缓冲区里写一个无符号 64 位指针。 */
function putU64(buffer: Buffer, offset: number, value: number): void {
  buffer.writeBigUInt64LE(BigInt(value), offset)
}

/** SID_AND_ATTRIBUTES 数组打包（16 字节步进，Attributes=0）。 */
function packRestrictingSids(bound: BoundWin32, sidBuffers: readonly Buffer[]): Buffer {
  const packed = Buffer.alloc(SID_AND_ATTRIBUTES_SIZE * sidBuffers.length)
  for (let index = 0; index < sidBuffers.length; index += 1) {
    putU64(packed, index * SID_AND_ATTRIBUTES_SIZE, addressOf(bound, sidBuffers[index]!))
    // Attributes 保持 0：受限 SID 不带 SE_GROUP 标志
  }
  return packed
}

/** TOKEN_MANDATORY_LABEL 载荷：{ Sid 指针, SE_GROUP_INTEGRITY }。 */
function packIntegrityLabel(bound: BoundWin32, lowSid: Buffer): Buffer {
  const payload = Buffer.alloc(8 + lowSid.length)
  putU64(payload, 0, addressOf(bound, lowSid))
  payload.writeUInt32LE(SE_GROUP_INTEGRITY, 8)
  return payload
}

/** 单条 EXPLICIT_ACCESS_W（48 字节，偏移见 abi.EA_OFFSETS；SID 形式的 trustee）。 */
export function packExplicitAccessSid(bound: BoundWin32, options: {
  mask: number
  mode: number
  inheritance: number
  sid: Buffer
}): Buffer {
  const entry = Buffer.alloc(48)
  entry.writeUInt32LE(options.mask >>> 0, EA_OFFSETS.grfAccessPermissions)
  entry.writeUInt32LE(options.mode, EA_OFFSETS.grfAccessMode)
  entry.writeUInt32LE(options.inheritance, EA_OFFSETS.grfInheritance)
  // pMultipleTrustee=NULL、MultipleTrusteeOperation=NO_MULTIPLE_TRUSTEE(0)
  entry.writeUInt32LE(TRUSTEE_IS_SID, EA_OFFSETS.TrusteeForm)
  entry.writeUInt32LE(TRUSTEE_IS_UNKNOWN, EA_OFFSETS.TrusteeType)
  putU64(entry, EA_OFFSETS.ptstrName, addressOf(bound, options.sid))
  return entry
}

/** 构造入参：模式 + 已授权可写根的能力 SID（与 ACL 授权一一对应）。 */
export interface RestrictedTokenInput {
  mode: 'read-only' | 'workspace-write'
  /** 可写根（工作区/附加根/私用临时目录）的能力 SID 串；read-only 模式给空数组。 */
  rootSids: readonly string[]
}

export interface RestrictedToken {
  /** 传给 CreateProcessAsUserW 的新令牌句柄（uintptr_t 数值）。 */
  readonly handle: number
  /** 收尾：关受限令牌、原令牌与进程句柄。spawn 完成后必须调。 */
  dispose(): void
}

/**
 * 建一把受限令牌。全程 fail-closed：任何一步失败都抛错，
 * 调用方（runner）绝不回落成「未受限 spawn」。
 */
export function buildRestrictedToken(bound: BoundWin32, input: RestrictedTokenInput): RestrictedToken {
  // 1. 开自己进程的令牌（koffi 拿不到伪句柄地址，老实 OpenProcess）
  const processHandle = Number(bound.openProcess(PROCESS_QUERY_INFORMATION, 0, process.pid))
  if (processHandle === 0) throwLastError(bound, 'OpenProcess')
  const tokenSlot = slotUintPtr(bound)
  if (Number(bound.openProcessToken(processHandle, TOKEN_ACCESS, tokenSlot.slot)) === 0) {
    throwLastError(bound, 'OpenProcessToken')
  }
  const token = tokenSlot.get()

  // 2. 保活组与能力组（顺序照 dsh：保活组在前）
  const logon = logonSidBuffer(bound, token)
  const everyone = wellKnownSidBuffer(bound, WinWorldSid)
  const low = wellKnownSidBuffer(bound, WinLowLabelSid)
  const capabilityBuffers: Buffer[] = []
  if (input.mode === 'workspace-write') {
    for (const sid of input.rootSids) capabilityBuffers.push(sidStringToBuffer(bound, sid))
  }
  const restricting: Buffer[] = [logon, everyone, ...capabilityBuffers]
  const packed = packRestrictingSids(bound, restricting)

  // 3. CreateRestrictedToken（disable/delete 两组刻意为空）
  const newTokenSlot = slotUintPtr(bound)
  const created = Number(bound.createRestrictedToken(
    token, CREATE_RESTRICTED_FLAGS,
    0, 0, // 不禁用任何 SID
    0, 0, // 不删任何特权（DISABLE_MAX_PRIVILEGE 已等效）
    restricting.length, packed,
    newTokenSlot.slot,
  ))
  if (created === 0) throwLastError(bound, 'CreateRestrictedToken')
  const restricted = newTokenSlot.get()

  // 4. 完整性 → Low
  const labelPayload = packIntegrityLabel(bound, low)
  if (Number(bound.setTokenInformation(restricted, TokenIntegrityLevel, labelPayload, labelPayload.length)) === 0) {
    throwLastError(bound, 'SetTokenInformation(TokenIntegrityLevel)')
  }

  // 5. 默认 DACL 补一条能力 SID 全权 ACE（没有能力 SID 就用 Everyone：至少让管道建得出来）
  patchDefaultDacl(bound, restricted, capabilityBuffers[0] ?? everyone)

  return {
    handle: restricted,
    dispose(): void {
      try { bound.closeHandle(restricted) } catch { /* 收尾失败不遮真实结果 */ }
      try { bound.closeHandle(token) } catch { /* 同上 */ }
      try { bound.closeHandle(processHandle) } catch { /* 同上 */ }
    },
  }
}

/**
 * 把**受限令牌**的默认 DACL 换成「原 ACL + 能力 SID 全权 ACE」。
 *
 * 为什么 trustee 选能力 SID 而不是 Everyone：默认 DACL 决定沙箱进程**新建对象**
 * 的落点，授 Everyone 等于把「pass-2 只认能力 SID」这道墙自己拆了；授能力 SID
 * 则只有打算进本沙箱的孙进程能对上新 ACL，外部进程照旧拿不到。
 */
function patchDefaultDacl(bound: BoundWin32, restricted: number, capability: Buffer): void {
  const probe = slotUint32(bound)
  bound.getTokenInformation(restricted, TokenDefaultDacl, null, 0, probe.slot)
  const needed = probe.get()
  if (needed === 0) throwLastError(bound, 'GetTokenInformation(TokenDefaultDacl 探长)')
  const area = byteArea(bound, needed)
  if (Number(bound.getTokenInformation(restricted, TokenDefaultDacl, area.ptr, needed, probe.slot)) === 0) {
    throwLastError(bound, 'GetTokenInformation(TokenDefaultDacl)')
  }
  // 载荷 = TOKEN_DEFAULT_DACL { PACL }：可能为 NULL（空 DACL），NULL 时让
  // SetEntriesInAclW 从零建（oldAcl 传 0）
  const aclPointer = Number(Buffer.from(area.bytes()).readBigUInt64LE(0))
  let oldAclPointer = 0
  if (aclPointer !== 0) {
    const header = readMemory(bound, aclPointer, 8)
    const size = header[2]! | (header[3]! << 8)
    if (size < 8) throw new Error('令牌默认 DACL 的 ACL 头尺寸不合法')
    // oldAcl 直接把系统指针传回去（同一进程内存，Koffi 分配块活着就有效）
    oldAclPointer = aclPointer
    void readMemory(bound, aclPointer, size)
  }

  const entry = packExplicitAccessSid(bound, { mask: FILE_ALL_ACCESS, mode: GRANT_ACCESS, inheritance: 0, sid: capability })
  const newAclSlot = slotUintPtr(bound)
  const code = Number(bound.setEntriesInAclW(1, entry, oldAclPointer, newAclSlot.slot))
  if (code !== 0) throwWin32(bound, 'SetEntriesInAclW(默认 DACL)', code)

  // SetTokenInformation 要「指向 PACL 的指针」：把新 ACL 的数值地址打进 8 字节
  const pointerBox = Buffer.alloc(8)
  pointerBox.writeBigUInt64LE(BigInt(newAclSlot.get()), 0)
  if (Number(bound.setTokenInformation(restricted, TokenDefaultDacl, pointerBox, 8)) === 0) {
    throwLastError(bound, 'SetTokenInformation(TokenDefaultDacl)')
  }
  // 刻意不 LocalFree 新 ACL：令牌内核侧持有它的引用窗口（runner 是短命进程，
  // 泄漏几百字节换掉一类 use-after-free，值）
}
