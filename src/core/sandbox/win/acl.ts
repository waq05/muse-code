/**
 * 可写根的 ACL 授权与回收：给目标目录打「能力 SID 三件套」，并把同目录的读-并-写串行化。
 *
 * 三件套（照 dsh `sandbox-windows-acl/src/acl.ts` 的实证取舍）：
 *   1. Allow ACE：能力 SID，掩码 GRANT_MASK，OI|CI 继承——这是 WRITE_RESTRICTED
 *      的 pass-2 交集检查里唯一放行写的凭据；
 *   2. Deny ACE：Everyone 的 FILE_DELETE_CHILD，**只挂 CONTAINER_INHERIT**。
 *      原因：0x40 ∈ FILE_ALL_ACCESS，若 OI|CI 落到每个文件上会拒掉所有 FullControl
 *      打开；只挂目录则既拦「借父目录句柄删子项」的逃逸，又不伤文件打开；
 *   3. 强制标签：S-1-16-4096（Low）+ NO_WRITE_UP，OI|CI——低完整性令牌不许改写
 *      中完整性创建的文件，把「继承授权」这条暗道也封上。
 *
 * 前提（不满足就响亮失败，绝不静默）：目录归调用者所有。写强制标签要 WRITE_OWNER，
 * 而对象所有者天然持有 READ_CONTROL|WRITE_DAC，所以自己建的目录一定打得上去；
 * 只有 Modify 权限的目录会失败，这是设计不是 bug。
 *
 * 幂等：三件套全部精确命中（逐字节比 SID）就跳过整树重传播——
 * SetNamedSecurityInfoW 的授权是急切传播，大树首次要几十秒，幂等跳过是唯一缓解。
 *
 * 并发：同一目录的读-并-写用阻塞的 LockFileEx 独占锁串行化（锁文件放 dsc 家目录；
 * 阻塞而非 fail-immediately：我们要的是「等前一位做完」，同进程重入被后端的授权缓存挡住，
 * 不会自锁）。
 *
 * 句柄口径：句柄与系统指针一律 number（见 ffi.ts 文件头）。系统 ACL 里的 SID 是
 * **内联在 ACE 里的字节**而不是指针，比对只能按 walkAces 逐字节走。
 *
 * @module dsc/core/sandbox/win/acl
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  ACCESS_ALLOWED_ACE_TYPE,
  ACCESS_DENIED_ACE_TYPE,
  ACL_ACE_COUNT_OFFSET,
  ACL_FIRST_ACE_OFFSET,
  ACL_REVISION,
  ACE_MASK_OFFSET,
  ACE_SID_OFFSET,
  CONTAINER_INHERIT_ACE,
  DACL_SECURITY_INFORMATION,
  DENY_ACCESS,
  EXPLICIT_ACCESS_SIZE,
  FILE_ATTRIBUTE_NORMAL,
  FILE_DELETE_CHILD,
  FILE_GENERIC_EXECUTE,
  FILE_GENERIC_READ,
  FILE_SHARE_READ,
  FILE_SHARE_WRITE,
  GENERIC_READ,
  GENERIC_WRITE,
  GRANT_ACCESS,
  GRANT_MASK,
  LABEL_SECURITY_INFORMATION,
  LOCKFILE_EXCLUSIVE_LOCK,
  OBJECT_INHERIT_ACE,
  OPEN_ALWAYS,
  OVERLAPPED_SIZE,
  REVOKE_ACCESS,
  SE_FILE_OBJECT,
  SID_MAX_BYTES,
  SYSTEM_MANDATORY_LABEL_ACE_TYPE,
  SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
  WinLowLabelSid,
  WinWorldSid,
} from './abi.js'
import { type BoundWin32, addressOf, readMemory, slotUintPtr, throwLastError, throwWin32 } from './ffi.js'
import { packExplicitAccessSid, sidStringToBuffer, wellKnownSidBuffer } from './token.js'

/** 任意字符串 → NUL 结尾的 UTF-16 缓冲（Win32 的 str16 入参口径）。 */
function utf16Buffer(text: string): Buffer {
  const buffer = Buffer.alloc(text.length * 2 + 2)
  buffer.write(text, 0, 'utf16le')
  return buffer
}

/** `(HANDLE)-1`：CreateFileW 的失败哨兵值。 */
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn

/** 锁文件名：小写路径的 sha256 前 16 位 hex（避开路径里不合法的文件名字符）。 */
function lockFilePath(lockDir: string, path: string): string {
  return join(lockDir, createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16) + '.lock')
}

/**
 * 拿住路径锁再干活（阻塞式独占；见文件头并发说明）。
 *
 * 两处刻意的写法：
 *   - 不加 LOCKFILE_FAIL_IMMEDIATELY：同目录的第二次授权要**等**第一次写完 ACL 再读，
 *     失败即返会让幂等判定看到中间态；
 *   - OVERLAPPED 给一块零化内存：koffi 3.1.1 给 LockFileEx/UnlockFileEx 传 NULL 会崩（已实测）。
 */
function withPathLock<T>(bound: BoundWin32, lockDir: string, path: string, work: () => T): T {
  const raw = bound.createFileW(
    utf16Buffer(lockFilePath(lockDir, path)),
    (GENERIC_READ | GENERIC_WRITE) >>> 0,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    null,
    OPEN_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    null,
  )
  // 失败形态有两种：NULL(0) 与 INVALID_HANDLE_VALUE(-1)。koffi 对超出安全整数范围的
  // uintptr_t 回 BigInt（实测 CreateFileW 失败给 18446744073709551615n），只判 === 0
  // 会漏掉后者，下一步就会拿着假句柄去加锁
  const handle = typeof raw === 'bigint' ? raw : BigInt(Number(raw))
  if (handle === 0n || handle === INVALID_HANDLE_VALUE) throwLastError(bound, 'CreateFileW(锁文件)')
  const lockHandle = Number(handle)
  const overlapped = Buffer.alloc(OVERLAPPED_SIZE)
  try {
    if (Number(bound.lockFileEx(lockHandle, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped)) === 0) {
      throwLastError(bound, 'LockFileEx')
    }
    return work()
  } finally {
    // 解锁与关句柄失败都吞：锁会随句柄关闭由内核释放，这里的失败不改变上面的真实结果
    try {
      bound.unlockFileEx(lockHandle, 0, 1, 0, overlapped)
    } catch {
      /* 同上 */
    }
    try {
      bound.closeHandle(lockHandle)
    } catch {
      /* 同上 */
    }
  }
}

/** ACL 里一条 ACE 的切片视图（`sid` 指向 ACL 内部的字节，别留着跨调用用）。 */
export interface AceView {
  /** ACE 类型：0 Allow / 1 Deny / 0x11 强制标签。 */
  type: number
  /** AceFlags：继承位等。 */
  flags: number
  /** 访问掩码。 */
  mask: number
  /** 内联 SID 的字节副本（视图，长度 = 8 + 子授权数*4）。 */
  sid: Uint8Array
}

/**
 * 把一段 ACL 字节解开成 ACE 列表。
 *
 * SID **内联在 ACE+8** 处（不是指针），长度 = 8 + count*4，count 字节在 sid+1；
 * 按 AceSize 步进。size 出现非法值（小于最小 ACE、越过 ACL 尾、装不下声明的 SID）
 * 就停下——后面的字节已经不可信，继续步进只会走到别人的数据上。
 */
export function walkAces(aclBytes: Uint8Array): AceView[] {
  if (aclBytes.length < ACL_FIRST_ACE_OFFSET) return []
  const view = new DataView(aclBytes.buffer, aclBytes.byteOffset, aclBytes.byteLength)
  const count = view.getUint16(ACL_ACE_COUNT_OFFSET, true)
  const out: AceView[] = []
  let offset = ACL_FIRST_ACE_OFFSET
  for (let index = 0; index < count; index += 1) {
    if (offset + ACE_SID_OFFSET > aclBytes.length) break
    const size = view.getUint16(offset + 2, true)
    // 最小合法 ACE = 头 8 字节 + 最短 SID 8 字节
    if (size < ACE_SID_OFFSET + 8 || offset + size > aclBytes.length) break
    const subAuthorityCount = aclBytes[offset + ACE_SID_OFFSET + 1]!
    const sidLength = 8 + subAuthorityCount * 4
    if (ACE_SID_OFFSET + sidLength > size) break
    out.push({
      type: aclBytes[offset]!,
      flags: aclBytes[offset + 1]!,
      mask: view.getUint32(offset + ACE_MASK_OFFSET, true),
      sid: aclBytes.subarray(offset + ACE_SID_OFFSET, offset + ACE_SID_OFFSET + sidLength),
    })
    offset += size
  }
  return out
}

/** SID 逐字节相等（长度不同直接不等）。 */
function sameSid(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

/**
 * 三件套是否都已**精确**命中（命中则整树重传播可以整段跳过）。
 *
 * 三条都要，且 flags 也要精确：
 *   - Allow：type 0，flags 恰好 OI|CI，mask 恰好 GRANT_MASK，SID == 能力 SID；
 *   - Deny：type 1，flags 恰好 CI（**不许**带 OI），mask 恰好 FILE_DELETE_CHILD，SID == Everyone；
 *   - 标签：type 0x11，flags 恰好 OI|CI，mask 恰好 NO_WRITE_UP，SID == Low 标签。
 * 带上别的 flags 说明这条 ACE 不是我们打的（可能来自继承或别人），不能当命中。
 */
function hasExactTrio(
  dacl: Uint8Array | null,
  sacl: Uint8Array | null,
  capability: Uint8Array,
  everyone: Uint8Array,
  low: Uint8Array,
): boolean {
  if (dacl === null || sacl === null) return false
  const daclAces = walkAces(dacl)
  const allow = daclAces.some((ace) =>
    ace.type === ACCESS_ALLOWED_ACE_TYPE &&
    ace.flags === (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) &&
    ace.mask === (GRANT_MASK >>> 0) &&
    sameSid(ace.sid, capability))
  const deny = daclAces.some((ace) =>
    ace.type === ACCESS_DENIED_ACE_TYPE &&
    ace.flags === CONTAINER_INHERIT_ACE &&
    ace.mask === FILE_DELETE_CHILD &&
    sameSid(ace.sid, everyone))
  const label = walkAces(sacl).some((ace) =>
    ace.type === SYSTEM_MANDATORY_LABEL_ACE_TYPE &&
    ace.flags === (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) &&
    ace.mask === SYSTEM_MANDATORY_LABEL_NO_WRITE_UP &&
    sameSid(ace.sid, low))
  return allow && deny && label
}

/**
 * 读系统指针指向的 ACL 字节：0 = 该 ACL 不存在（NULL DACL），返回 null。
 * 先读 8 字节头拿 AclSize（u16@2），再整块读——头里的 AclSize 不合法就抛，
 * 因为后面按它取字节，错一点就是读别人的内存。
 */
function readAclBytes(bound: BoundWin32, aclPointer: number): Uint8Array | null {
  if (aclPointer === 0) return null
  const header = readMemory(bound, aclPointer, 8)
  const size = header[2]! | (header[3]! << 8)
  if (size < 8) throw new Error(`ACL 头的 AclSize 不合法（${String(size)}）：安全描述符已经不可信`)
  return readMemory(bound, aclPointer, size)
}

/** 授权/回收的结果。 */
export interface GrantOutcome {
  /** 是否真的动了 ACL（false = 幂等跳过，没写盘）。 */
  applied: boolean
  /** 给用户与日志的一句话。 */
  detail: string
}

/**
 * 给目录授权（幂等）：三件套一次 SetNamedSecurityInfoW 打齐。
 *
 * @param path - 目标目录（调用方保证是 realpath 规范化后的绝对路径）。
 * @param sid - 能力 SID 串（S-1-4-x-y，来自 workspace-sid.ts）。
 * @param lockDir - 锁文件目录（调用方保证已存在）。
 */
export function grantWrite(bound: BoundWin32, path: string, sid: string, lockDir: string): GrantOutcome {
  const capability = sidStringToBuffer(bound, sid)
  const everyone = wellKnownSidBuffer(bound, WinWorldSid)
  const low = wellKnownSidBuffer(bound, WinLowLabelSid)
  const name = utf16Buffer(path)
  return withPathLock(bound, lockDir, path, () => {
    const owner = slotUintPtr(bound)
    const group = slotUintPtr(bound)
    const dacl = slotUintPtr(bound)
    const sacl = slotUintPtr(bound)
    const sd = slotUintPtr(bound)
    const readCode = Number(bound.getNamedSecurityInfoW(
      name,
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
      owner.slot,
      group.slot,
      dacl.slot,
      sacl.slot,
      sd.slot,
    ))
    if (readCode !== 0) throwWin32(bound, 'GetNamedSecurityInfoW(三件套)', readCode)
    try {
      if (hasExactTrio(readAclBytes(bound, dacl.get()), readAclBytes(bound, sacl.get()), capability, everyone, low)) {
        return { applied: false, detail: '三件套已在（幂等跳过，不重传播）' }
      }

      // 两条 EA 打进一块 96 字节：Allow（能力 SID，OI|CI）+ Deny（Everyone 只删子项，仅 CI）
      const entries = Buffer.alloc(EXPLICIT_ACCESS_SIZE * 2)
      entries.set(packExplicitAccessSid(bound, {
        mask: GRANT_MASK,
        mode: GRANT_ACCESS,
        inheritance: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        sid: capability,
      }), 0)
      entries.set(packExplicitAccessSid(bound, {
        mask: FILE_DELETE_CHILD,
        mode: DENY_ACCESS,
        inheritance: CONTAINER_INHERIT_ACE,
        sid: everyone,
      }), EXPLICIT_ACCESS_SIZE)
      const newDacl = slotUintPtr(bound)
      const mergeCode = Number(bound.setEntriesInAclW(2, entries, dacl.get(), newDacl.slot))
      if (mergeCode !== 0) throwWin32(bound, 'SetEntriesInAclW(三件套)', mergeCode)

      // 标签 ACL：InitializeAcl 建空 ACL + AddMandatoryAce 加 Low 标签 + NO_WRITE_UP（OI|CI）
      const labelAcl = Buffer.alloc(8 + 8 + SID_MAX_BYTES)
      if (Number(bound.initializeAcl(labelAcl, labelAcl.length, ACL_REVISION)) === 0) {
        throwLastError(bound, 'InitializeAcl')
      }
      if (Number(bound.addMandatoryAce(
        labelAcl,
        ACL_REVISION,
        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
        low,
      )) === 0) {
        throwLastError(bound, 'AddMandatoryAce')
      }

      // labelAcl 只活在这次调用里：地址被嵌进 Win32 参数后必须由局部变量持有到返回（防 GC）
      const writeCode = Number(bound.setNamedSecurityInfoW(
        name,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
        0,
        0,
        newDacl.get(),
        addressOf(bound, labelAcl),
      ))
      if (writeCode !== 0) throwWin32(bound, 'SetNamedSecurityInfoW(三件套)', writeCode)
      return { applied: true, detail: '已打三件套（Allow 能力 SID + Deny Everyone 删子项 + Low 标签）' }
    } finally {
      // GetNamedSecurityInfoW 的契约：只 LocalFree 描述符本身，绝不 free 里面的 ACL 指针
      const descriptor = sd.get()
      if (descriptor !== 0) {
        try {
          bound.localFree(descriptor)
        } catch {
          /* 描述符释放失败不该遮住真实结果：进程退出时内核兜底 */
        }
      }
    }
  })
}

/**
 * 给目录补「账号 SID 的读写执行 Allow ACE」（网络第二级账号分支专用）。
 *
 * 为什么要它：专用离线账号没有当前用户的权限，工作区里它连**读**都不行——
 * pass-1（普通 SID 检查）就过不去，命令在仓库里什么都干不了。假能力 SID 的
 * 三件套只解决 pass-2（写受限交集），pass-1 得靠这条 ACE 补上。
 *
 * 掩码 = 读 + 执行 + GRANT_MASK（写/删），仍刻意不含 WRITE_DAC/WRITE_OWNER；
 * 幂等口径与三件套一致（精确命中即跳过整树重传播）。
 */
export function grantAccountAccess(bound: BoundWin32, path: string, accountSid: string, lockDir: string): GrantOutcome {
  const capability = sidStringToBuffer(bound, accountSid)
  const name = utf16Buffer(path)
  const accountMask = (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | GRANT_MASK) >>> 0
  return withPathLock(bound, lockDir, path, () => {
    const ownerSlot = slotUintPtr(bound)
    const groupSlot = slotUintPtr(bound)
    const daclSlot = slotUintPtr(bound)
    const saclSlot = slotUintPtr(bound)
    const sdSlot = slotUintPtr(bound)
    const readCode = Number(bound.getNamedSecurityInfoW(
      name, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
      ownerSlot.slot, groupSlot.slot, daclSlot.slot, saclSlot.slot, sdSlot.slot,
    ))
    if (readCode !== 0) throwWin32(bound, 'GetNamedSecurityInfoW(账号授权)', readCode)
    try {
      const daclPointer = daclSlot.get()
      const already = walkAces(readAclBytes(bound, daclPointer) ?? new Uint8Array()).some((ace) =>
        ace.type === ACCESS_ALLOWED_ACE_TYPE &&
        ace.flags === (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) &&
        ace.mask === accountMask && sameSid(ace.sid, capability))
      if (already) return { applied: false, detail: '账号 ACE 已在（幂等跳过）' }

      const entry = packExplicitAccessSid(bound, {
        mask: accountMask, mode: GRANT_ACCESS, inheritance: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE, sid: capability,
      })
      const newDaclSlot = slotUintPtr(bound)
      const code = Number(bound.setEntriesInAclW(1, entry, daclPointer, newDaclSlot.slot))
      if (code !== 0) throwWin32(bound, 'SetEntriesInAclW(账号授权)', code)
      const writeCode = Number(bound.setNamedSecurityInfoW(
        name, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        0, 0, newDaclSlot.get(), 0,
      ))
      if (writeCode !== 0) throwWin32(bound, 'SetNamedSecurityInfoW(账号授权)', writeCode)
      return { applied: true, detail: '已补账号读写执行 ACE' }
    } finally {
      try { bound.localFree(sdSlot.get()) } catch { /* 描述符为空时忽略 */ }
    }
  })
}

/**
 * 回收目录上的能力 SID 授权（REVOKE_ACCESS 只摘我们自己的那条 ACE）。
 *
 * 刻意**不动** Low 标签：NO_WRITE_UP 只拦「比标签更低」的写，用户自己的中完整性
 * 进程不受影响，留着它等于给这个目录留一道永久加固；摘标签反而要在「还有没有别的
 * 能力授权」上做一堆判断，收益为负。
 */
export function revokeWrite(bound: BoundWin32, path: string, sid: string, lockDir: string): GrantOutcome {
  const capability = sidStringToBuffer(bound, sid)
  const name = utf16Buffer(path)
  return withPathLock(bound, lockDir, path, () => {
    const owner = slotUintPtr(bound)
    const group = slotUintPtr(bound)
    const dacl = slotUintPtr(bound)
    const sacl = slotUintPtr(bound)
    const sd = slotUintPtr(bound)
    const readCode = Number(bound.getNamedSecurityInfoW(
      name,
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION,
      owner.slot,
      group.slot,
      dacl.slot,
      sacl.slot,
      sd.slot,
    ))
    if (readCode !== 0) throwWin32(bound, 'GetNamedSecurityInfoW(回收)', readCode)
    try {
      const stillThere = walkAces(readAclBytes(bound, dacl.get()) ?? new Uint8Array())
        .some((ace) => ace.type === ACCESS_ALLOWED_ACE_TYPE && sameSid(ace.sid, capability))
      if (!stillThere) return { applied: false, detail: '授权本就不在（幂等跳过）' }

      const entry = packExplicitAccessSid(bound, { mask: 0, mode: REVOKE_ACCESS, inheritance: 0, sid: capability })
      const newDacl = slotUintPtr(bound)
      const mergeCode = Number(bound.setEntriesInAclW(1, entry, dacl.get(), newDacl.slot))
      if (mergeCode !== 0) throwWin32(bound, 'SetEntriesInAclW(回收)', mergeCode)
      const writeCode = Number(bound.setNamedSecurityInfoW(
        name,
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        0,
        0,
        newDacl.get(),
        0,
      ))
      if (writeCode !== 0) throwWin32(bound, 'SetNamedSecurityInfoW(回收)', writeCode)
      return { applied: true, detail: '已摘除能力 ACE（Low 标签保留）' }
    } finally {
      const descriptor = sd.get()
      if (descriptor !== 0) {
        try {
          bound.localFree(descriptor)
        } catch {
          /* 同上 */
        }
      }
    }
  })
}
