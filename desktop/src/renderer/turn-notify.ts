/**
 * 任务完成提醒的判定与文案：纯函数、零运行时依赖（行为探针直接 import 本文件跑源码）。
 *
 * 两个消费方都在 App.tsx 的完成 effect 里：「该不该响」（{@link turnCompleted} +
 * {@link isBackgrounded}）与「响什么」（{@link completionNotifyBody} 组通知正文）。
 * 音色编号的归一也放在这里（{@link normalizeSoundVariant}），与宿主 prefs.ts 的
 * readSoundVariant 同一张表——渲染层要在首帧、读档、写盘前都过一遍，不能只靠宿主。
 *
 * @module desktop/renderer/turn-notify
 */

/** 完成提示音的音色数量，与 completion-sound.ts 的音色表、宿主 prefs.ts 一致（改要三边一起改）。 */
export const SOUND_VARIANT_COUNT = 14

/**
 * 把外部来的音色编号归一成 1–{@link SOUND_VARIANT_COUNT} 的整数。
 * 认不出的值（undefined、NaN、字符串、越界）一律回落 1 号音色。
 */
export function normalizeSoundVariant(value: unknown): number {
  const id = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 1
  return Math.min(SOUND_VARIANT_COUNT, Math.max(1, id))
}

/** 后台判定。`document.hidden` 只在最小化/被遮挡时翻转；alt-tab 之后窗口还可见但失焦，也算「离开」——所以还要看 hasFocus()。 */
export function isBackgrounded(doc?: { hidden?: boolean; hasFocus?: () => boolean }): boolean {
  const d = doc ?? (typeof document === 'undefined' ? undefined : document)
  if (d === undefined) return false
  if (d.hidden === true) return true
  return typeof d.hasFocus === 'function' && !d.hasFocus()
}

/**
 * 同一会话内「跑动 → 空闲」才算一轮干完。
 *
 * 两个反例都不算：切了会话（id 变了——切到一个本来就在空闲的会话不是「完成」，
 * 旧会话跑完时快照也不再推它）；本来就没在跑（空闲 → 空闲，首次快照 prev 为 null 同理）。
 */
export function turnCompleted(
  prev: { id: string; state: string } | null,
  curr: { id: string; state: string },
): boolean {
  if (prev === null) return false
  if (prev.id !== curr.id) return false
  return prev.state !== 'idle' && curr.state === 'idle'
}

/** 通知正文的长度上限：再多 Windows 的 toast 也放不下，徒增截断的突兀。 */
const BODY_LIMIT = 120

/**
 * 组通知正文：最后一条助手回复压成一行，取前 {@link BODY_LIMIT} 字。
 * 没有正文（一轮以工具结果收尾、或条目还没推到）就给一句通用话——通知总得有点字。
 */
export function completionNotifyBody(entries: readonly { kind: string; text?: string }[]): string {
  const last = [...entries].reverse().find((entry) => entry.kind === 'text' && (entry.text ?? '') !== '')
  const text = (last?.text ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return '任务已完成，等你查看'
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT).trimEnd()}…` : text
}
