/**
 * 可写根的能力 SID 派生：`S-1-4-x-y`。
 *
 * 机制照 dsh `sandbox-windows-acl/src/workspace-sid.ts`：把「规范路径」哈希成两个
 * 30 位以内的子授权，得到一个**稳定且可复算**的假 SID。它的用途是当 restricting
 * SID 与 ACE 的 trustee：可写根的 ACL 上授这个 SID，受限令牌的 restricting 列表里
 * 放这个 SID，于是「令牌能不能写这个根」变成一条纯 ACL 判定，根外面则全部被
 * pass-2 交集拦死。
 *
 * 两个纪律（照 dsh 的实测教训）：
 *   1. 输入必须是 `realpathSync.native` 规范化后的路径——大小写、8.3 短名、符号链接
 *      拼法的差异会派生出**第二个身份**，等于沙箱凭空多一个可写根；
 *   2. temp 根用独立的消息前缀 + 固定子授权 `-1`，保证它和工作区永不派生同一条 SID
 *      （temp 会在会话结束回收 ACE，工作区是常驻的，两者混用会把常驻授权漏进临时身份）。
 *
 * @module dsc/core/sandbox/win/workspace-sid
 */
import { createHash } from 'node:crypto'

/** 授权值上限：2^30-1。取模后 +1，避免派生出 0（0 号授权在 S-1-4 里另有含义）。 */
const AUTHORITY_MODULUS = 2 ** 30 - 1

/** sha256 → 前 8 字节按小端拆成两个授权。 */
function derive(digest: Buffer): { x: number; y: number } {
  const x = digest.readUInt32LE(0) % AUTHORITY_MODULUS + 1
  const y = digest.readUInt32LE(4) % AUTHORITY_MODULUS + 1
  return { x, y }
}

/** 可写根（工作区 / 附加根）的能力 SID：`S-1-4-x-y`。 */
export function rootWriteSid(canonicalRoot: string): string {
  const digest = createHash('sha256').update(Buffer.from(canonicalRoot, 'utf8')).digest()
  const { x, y } = derive(digest)
  return `S-1-4-${String(x)}-${String(y)}`
}

/** 私有临时目录的能力 SID：`S-1-4-x-y-1`（固定尾授权做域分隔）。 */
export function tempWriteSid(canonicalTemp: string): string {
  const digest = createHash('sha256').update(Buffer.concat([Buffer.from('temp\0', 'utf8'), Buffer.from(canonicalTemp, 'utf8')])).digest()
  const { x, y } = derive(digest)
  return `S-1-4-${String(x)}-${String(y)}-1`
}

/**
 * 自检用的反算：给定 SID 与路径，验证派生关系成立（runner 启动时校验 argv，
 * 防「SID 与路径对不上号」的调用方 bug 变成静默错授权）。
 */
export function verifySidForPath(sid: string, canonicalPath: string, kind: 'root' | 'temp'): boolean {
  return sid === (kind === 'root' ? rootWriteSid(canonicalPath) : tempWriteSid(canonicalPath))
}
