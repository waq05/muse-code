/**
 * 协议 v3 的帧归并 —— 纯函数，客户端与自检共用同一份实现。
 *
 * 宿主现在推两种帧（字段名与含义钉死在契约里，这里一个字都不改）：
 *
 *   全量  {type:'snapshot', seq, full:true, ...快照字段铺平}
 *   增量  {type:'delta', seq, full:false,
 *          meta:<除 entries / liveEntries 外的所有快照字段打包>,
 *          added:[条目], updated:[条目], removedIds:[number], liveEntries:[条目全量]}
 *
 * 归并口径（照契约）：
 *   state = {...state, ...meta, liveEntries}
 *   entries 按 id 合并：added 追加、updated 按 id 替换、removedIds 删除，
 *   合并后统一按 id 升序排（宿主发号是递增的，所以 id 序就是时间序；重排比维护插入序少一处状态）。
 *
 * 断线重连时服务器会先补发缺失的帧（可能连续多条 snapshot / delta 混合），
 * 也可能因为窗口不够直接发全量。两种情况都不需要客户端区分：逐帧 applyFrame 就行，
 * 全量帧一进来整份重置。
 */

import { normalizeEntries, normalizeMeta, normalizeSnapshot } from './protocol.js'
import type { RemoteSnapshot, TranscriptEntry } from './types.js'

type Rec = Record<string, unknown>

function asRecord(value: unknown): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null
}

/** 帧顶层的 seq；不是有限数就是 null（认不出就不拿它做单调判定）。 */
export function readFrameSeq(raw: unknown): number | null {
  const frame = asRecord(raw)
  if (frame === null) return null
  const value = frame['seq']
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 是不是全量帧。
 *
 * 判定顺序：先看 `full`（契约字段），没有再退回 `type === 'snapshot'`——
 * 这样 v2 的宿主（只有 type、没有 full）也照样当全量处理，界面不会因为宿主没升级而白屏。
 */
export function isFullFrame(raw: unknown): boolean {
  const frame = asRecord(raw)
  if (frame === null) return false
  if (frame['full'] === true) return true
  if (frame['full'] === false) return false
  return frame['type'] === 'snapshot'
}

/** 是不是增量帧（`full:false` 或 `type:'delta'`）。 */
export function isDeltaFrame(raw: unknown): boolean {
  const frame = asRecord(raw)
  if (frame === null) return false
  if (frame['full'] === false) return true
  return frame['type'] === 'delta'
}

/** removedIds 里只认有限数字（宿主给字符串就当没给，避免删错条目）。 */
function readRemovedIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const out: number[] = []
  for (const item of raw) {
    if (typeof item === 'number' && Number.isFinite(item)) out.push(item)
  }
  return out
}

/**
 * 按 id 归并条目列表。
 *
 * 三个宽松口子，都是为了「宁可多一条也不要丢内容」：
 *   - updated 里的 id 本地没有（补帧从窗口中间开始时可能）→ 照样收下；
 *   - added 里出现本地已有的 id（补帧与实时帧重叠）→ 按后者覆盖，不让同一个 id 出现两行；
 *   - removedIds 删除不存在的 id → 什么也不做。
 *
 * 重排用 `sort((a, b) => a.id - b.id)`：ES2019 起 Array.prototype.sort 是稳定排序，
 * 所以同 id 不可能同时存在（上面已去重），结果稳定可复现。
 */
export function mergeEntries(
  previous: readonly TranscriptEntry[],
  added: readonly TranscriptEntry[],
  updated: readonly TranscriptEntry[],
  removedIds: readonly number[],
): TranscriptEntry[] {
  const byId = new Map<number, TranscriptEntry>()
  for (const entry of previous) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry)
  }
  for (const id of removedIds) byId.delete(id)
  for (const entry of updated) byId.set(entry.id, entry)
  for (const entry of added) byId.set(entry.id, entry)
  return [...byId.values()].sort((left, right) => left.id - right.id)
}

/**
 * 把一帧（全量或增量）并进当前快照。
 *
 * 返回值：认不出的帧（不是对象、type 不认识、全量帧洗出来是空）返回 null，
 * 调用方照旧保持原状态；认得出就返回新的快照对象（不可变更新，React 才能看出变化）。
 */
export function applyFrame(previous: RemoteSnapshot | null, raw: unknown): RemoteSnapshot | null {
  const frame = asRecord(raw)
  if (frame === null) return null

  if (isFullFrame(frame)) return normalizeSnapshot(frame)
  if (!isDeltaFrame(frame)) return null

  const meta = normalizeMeta(frame['meta'], previous)
  const entries = mergeEntries(
    previous?.entries ?? [],
    normalizeEntries(frame['added']),
    normalizeEntries(frame['updated']),
    readRemovedIds(frame['removedIds']),
  )
  // liveEntries 是「全量给」，不是增量：缺这个字段时保留旧值（契约里不缺，这是兜底）。
  const liveEntries =
    'liveEntries' in frame ? normalizeEntries(frame['liveEntries']) : (previous?.liveEntries ?? [])
  const seq = readFrameSeq(frame) ?? meta.seq
  return { ...meta, seq, entries, liveEntries }
}
