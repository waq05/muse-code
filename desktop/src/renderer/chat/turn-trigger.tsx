/**
 * 非人发起的唤醒消息：对话页把它画成一行「子任务状态更新」，不是用户气泡。
 *
 * 对照 dsh 的 TurnTriggerNodeView.tsx（packages/client/ui-chat/src/client/chat）：默认收起，
 * 只有一行「图标 + 标题 + 时刻 + 箭头」，展开才看得到通知正文；标题按消息来源取
 * （'subagent-settled' → locale.ts 的 'message.trigger.subagent' = 「子任务状态更新」）。
 *
 * dsh 认的是消息的 `source.kind`，dsc 的消息没有 source 字段，靠正文前缀认
 * （见 core/team-board.ts 的 TEAMMATE_REPORT_OPEN，与压缩摘要的 SUMMARY_BANNER 同一套路），
 * 识别结果由 adapter 落在条目的 `internal` 上，所以这里只读 `internal`。
 *
 * 为什么收起但保留展开：汇报正文是模型看得到的上下文（`<teammate-report>` 全文都在会话里），
 * 排查「队友回来说了什么」时得有地方看；可它是运行时投的机械文本，不该占着对话页的地方
 * 装成人打的字。
 *
 * @module desktop/renderer/chat/turn-trigger
 */
import { useState, type JSX } from 'react'
import { IconChevronDown, IconTree } from '../icons.js'
import { formatClock } from '../turn-timing.js'

export function TurnTriggerRow(props: {
  /** 投进来的原文（`<teammate-report>` 整段，含任务与汇报正文）。 */
  text: string
  /** 这条消息落库的时刻；老日志没有就不画时刻。 */
  ts?: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const clock = formatClock(props.ts ?? null)
  return (
    <section className="turn-trigger" data-turn-trigger="subagent">
      <button
        type="button"
        className="turn-trigger-head"
        aria-expanded={open}
        data-tip={open ? '收起这条通知' : '展开看通知原文'}
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span className="turn-trigger-icon" aria-hidden="true">
          <IconTree size={13} />
        </span>
        <span className="turn-trigger-label">子任务状态更新</span>
        {clock !== null && <time className="turn-trigger-time">{clock}</time>}
        <IconChevronDown size={12} className={open ? 'turn-trigger-chevron on' : 'turn-trigger-chevron'} />
      </button>
      {open && (
        <div className="turn-trigger-body">
          <p className="turn-trigger-note">运行时代模型收到的原文（模型看到的就是这段）。</p>
          <pre className="turn-trigger-text">{props.text}</pre>
        </div>
      )}
    </section>
  )
}
