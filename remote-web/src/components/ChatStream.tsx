import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { entryKey } from '../lib/format.js'
import type { TranscriptEntry } from '../lib/types.js'
import { EntryView } from './EntryView.js'

/**
 * 对话流（唯一可滚动的区域）。
 *
 * 三件事：
 *   1. 渲染全部条目，不做虚拟化（一次几百条在手机上排版仍然流畅，虚拟化反而会打断
 *      长按选择、查找、流式增长的滚动跟随）；
 *   2. 超过 TRUNCATE_TRIGGER 条就只画最后 `shown` 条，顶部给「加载更早」——这是
 *      「先截断」的省法，不是分页：点一次往前多给一页，不请求宿主；
 *   3. 自动贴底：用户已经在底部时跟着新内容走；用户翻上去看历史时不打扰，只在
 *      右下角给一个「回到最新」的小按钮。
 */
const TRUNCATE_TRIGGER = 500
const PAGE_SIZE = 200

export interface ChatStreamProps {
  entries: TranscriptEntry[]
}

export function ChatStream({ entries }: ChatStreamProps): ReactNode {
  const [shown, setShown] = useState(PAGE_SIZE)
  const scroller = useRef<HTMLDivElement | null>(null)
  const atBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const needsTruncate = entries.length > TRUNCATE_TRIGGER && entries.length > shown
  const visible = needsTruncate ? entries.slice(entries.length - shown) : entries
  const hiddenCount = entries.length - visible.length

  // key 用「原数组里的下标」算，避免截断窗口变化时把不同的条目认成同一条。
  const startIndex = entries.length - visible.length
  const tailKey = entries.length === 0 ? 'empty' : entryKey(entries[entries.length - 1]!.kind, entries[entries.length - 1]!.id, entries.length - 1)
  const tailText = entries.length === 0 ? '' : textOf(entries[entries.length - 1]!)

  useLayoutEffect(() => {
    const node = scroller.current
    if (node === null) return
    if (atBottom.current) node.scrollTop = node.scrollHeight
  }, [tailKey, tailText, visible.length])

  useEffect(() => {
    // 首屏进来直接落在最新一条上。
    const node = scroller.current
    if (node !== null && atBottom.current) node.scrollTop = node.scrollHeight
  }, [])

  function handleScroll(): void {
    const node = scroller.current
    if (node === null) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    const bottom = distance < 48
    atBottom.current = bottom
    setShowJump(!bottom)
  }

  function jumpToLatest(): void {
    const node = scroller.current
    if (node === null) return
    node.scrollTop = node.scrollHeight
    atBottom.current = true
    setShowJump(false)
  }

  return (
    <div className="stream-wrap">
      <div className="stream" ref={scroller} onScroll={handleScroll}>
        {entries.length === 0 ? (
          <div className="stream-empty">
            还没有对话内容。
            <br />
            在下面发一条消息，或者返回会话列表换一个会话。
          </div>
        ) : null}
        {needsTruncate ? (
          <button type="button" className="stream-more" onClick={() => setShown((value) => value + PAGE_SIZE)}>
            加载更早（还有 {hiddenCount} 条）
          </button>
        ) : null}
        {visible.map((entry, index) => (
          <EntryView key={entryKey(entry.kind, entry.id, startIndex + index)} entry={entry} />
        ))}
        <div className="stream-tail" aria-hidden="true" />
      </div>
      {showJump ? (
        <button type="button" className="stream-jump" onClick={jumpToLatest}>
          回到最新 ↓
        </button>
      ) : null}
    </div>
  )
}

/** 直播尾的文本长度：放进依赖里，让流式增长也能触发贴底。 */
function textOf(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case 'text':
    case 'thinking':
    case 'user':
    case 'system':
      return entry.text
    case 'tool':
      return `${entry.call.status}:${entry.call.resultText?.length ?? 0}`
    case 'plan':
      return entry.plan.decision
  }
}
