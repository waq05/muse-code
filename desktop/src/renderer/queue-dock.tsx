/**
 * 排队消息条：回合跑着的时候提交的消息列在输入框下面，一行一条。
 *
 * 为什么要有这条：回合跑动中提交的消息不会立刻进对话——内核的收件箱先收着
 * （`async-inbox` 状态条目），步骤边界或回合收尾才落库（见 core/loop.ts 的 drainInbox）。
 * 0.6.67 起「入箱」不再画成气泡，这条队列条就是排队期间唯一的界面：一眼看见「发了、
 * 还没轮到」，并且改得动、撤得掉、插得上（对照 dsh 的 conversation.input.dock / QueueDock，
 * 那里也是发送钮 + 队列条的组合）。
 *
 * 数据来自快照的 `queued`（内核收件箱的只读投影，见 plugins/transcript.ts）——所以
 * 别的来源排进去的（作业完成通知、插件补投）照样看得见，不需要界面自己记账。
 * 所有动作都回宿主做，会话那边的真相只有一份。
 *
 * @module desktop/renderer/queue-dock
 */
import { useEffect, useState, type JSX, type KeyboardEvent } from 'react'
import type { QueuedMessageView } from '@dsc/runtime/contract.js'
import type { RuntimeProxy } from './bridge.js'
import { confirmAction } from './components/confirm.js'
import { toastErr } from './components/toast.js'
import { IconBolt, IconCheck, IconChevronDown, IconChevronUp, IconClose, IconEdit, IconQueue, IconTrash } from './icons.js'

/** 一行摘要最多这么多字（对齐 dsh 的 QUEUE_PREVIEW_CHARS），全文挂在悬浮提示上。 */
const PREVIEW_CHARS = 200

function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : flat
}

export function QueueDock(props: {
  /** 快照里的排队输入（空数组 = 整条不渲染）。 */
  items: readonly QueuedMessageView[]
  /** 回合在不在跑：只有跑着的时候「插话」才有意义（否则队列马上自己出账）。 */
  running: boolean
  proxy: RuntimeProxy
}): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(true)
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const count = props.items.length

  // 队列空了就收回头行；正在编辑的那条出账了（下标没了）就退出编辑态，
  // 否则回车保存会打到别人头上。
  useEffect(() => {
    if (count === 0 && !collapsed) setCollapsed(true)
    if (editing !== null && !props.items.some((item) => item.index === editing.index)) setEditing(null)
  }, [collapsed, editing, props.items, count])

  if (count === 0) return null
  const expanded = count === 1 || !collapsed || editing !== null

  /**
   * 跑一个动作：false = 宿主说没做到（那条已经出账 / 没在跑），给一句人话而不是静默。
   * 抛出来的异常（宿主重启、协议错）也在这里收成一句提示。
   */
  const act = async (work: () => Promise<boolean>, failure: string): Promise<boolean> => {
    setBusy(true)
    try {
      return await work()
    } catch (error) {
      toastErr(`${failure}：${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = async (index: number): Promise<void> => {
    const text = editing?.text.trim() ?? ''
    if (text === '') return
    if (await act(() => props.proxy.editQueued(index, text), '编辑失败')) {
      setEditing(null)
      return
    }
    toastErr('编辑失败：这条已经开始发送了')
  }

  const remove = async (index: number): Promise<void> => {
    if (await act(() => props.proxy.removeQueued(index), '删除失败')) return
    toastErr('删除失败：这条已经开始发送了')
  }

  /**
   * 插话（对照 dsh 的 steer）：打断当前输出，让这条立刻作为新一轮发出去。
   * 先问一次——代价是把模型正在说的话砍断（半截会保留），不能点错了才发现。
   */
  const steer = async (index: number): Promise<void> => {
    const ahead = index
    const ok = await confirmAction({
      title: '打断并插话？',
      detail:
        ahead > 0
          ? `会打断模型当前的输出，让这条以及排在它前面的 ${String(ahead)} 条立刻作为新一轮发出去（模型已经说出的半截会保留）。`
          : '会打断模型当前的输出，让这条立刻作为新一轮发出去（模型已经说出的半截会保留）。',
      confirmLabel: '打断并插话',
    })
    if (!ok) return
    if (await act(() => props.proxy.steerQueued(index), '插话失败')) return
    toastErr('插话没赶上：这一轮刚结束，排队消息会自己发出去')
  }

  return (
    <div className="queue-dock" data-queue-dock="">
      <div className="queue-panel">
        {count > 1 && (
          <button
            className="queue-head"
            aria-expanded={expanded}
            disabled={busy || editing !== null}
            data-tip={expanded ? '收起排队消息' : '展开排队消息'}
            onClick={() => setCollapsed((current) => !current)}
          >
            <span className="queue-lead" aria-hidden>
              <IconQueue size={13} />
            </span>
            <span className="queue-count">{count} 条排队消息</span>
            <span className="queue-note">这一轮跑完自动发出</span>
            <span className="queue-caret" aria-hidden>
              {expanded ? <IconChevronDown size={13} /> : <IconChevronUp size={13} />}
            </span>
          </button>
        )}
        {expanded && (
          <ul className="queue-list">
            {/* key 用下标：这条列表的位置就是它的身份（编辑 / 删除 / 插话都按位置找），
                行本身没有内部状态（编辑态挂在上面那个 state 里）。 */}
            {props.items.map((item) => (
              <li key={item.index} className="queue-row">
                {editing?.index === item.index ? (
                  <>
                    <textarea
                      className="queue-edit-box"
                      value={editing.text}
                      autoFocus
                      rows={Math.min(8, Math.max(1, editing.text.split('\n').length))}
                      aria-label="编辑排队消息"
                      onChange={(event) => setEditing({ index: item.index, text: event.target.value })}
                      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          void save(item.index)
                          return
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          setEditing(null)
                        }
                      }}
                    />
                    <button
                      className="queue-act"
                      aria-label="保存排队消息"
                      data-tip="保存（回车）"
                      disabled={busy || editing.text.trim() === ''}
                      onClick={() => void save(item.index)}
                    >
                      <IconCheck size={13} />
                    </button>
                    <button
                      className="queue-act"
                      aria-label="取消编辑"
                      data-tip="取消（Esc）"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      <IconClose size={13} />
                    </button>
                  </>
                ) : (
                  <>
                    {/* 只有一条时没有头行，这一行自己带队列图标 */}
                    {count === 1 && (
                      <span className="queue-lead" aria-hidden>
                        <IconQueue size={13} />
                      </span>
                    )}
                    <span className="queue-text" data-tip={item.text}>
                      {previewOf(item.text)}
                    </span>
                    {item.images !== undefined && item.images.length > 0 && (
                      <span className="queue-badge" data-tip={`随这条一起排队的 ${String(item.images.length)} 张图`}>
                        +{item.images.length} 图
                      </span>
                    )}
                    <div className="queue-acts">
                      <button
                        className="queue-act"
                        aria-label="编辑排队消息"
                        data-tip="改这条排队消息"
                        disabled={busy}
                        onClick={() => setEditing({ index: item.index, text: item.text })}
                      >
                        <IconEdit size={13} />
                      </button>
                      <button
                        className="queue-act"
                        aria-label="删除排队消息"
                        data-tip="撤掉这条（还没发出去）"
                        disabled={busy}
                        onClick={() => void remove(item.index)}
                      >
                        <IconTrash size={13} />
                      </button>
                      <button
                        className="queue-act"
                        aria-label="插话发送"
                        data-tip={
                          props.running
                            ? '打断当前输出，让这条立刻发出去（模型已说出的半截保留）'
                            : '这一轮已经跑完，排队消息会自己发出去'
                        }
                        disabled={busy || !props.running}
                        onClick={() => void steer(item.index)}
                      >
                        <IconBolt size={13} />
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
