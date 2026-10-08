/**
 * 队友运行记录的只读视图。
 *
 * 会话标题旁的下拉或「智能体团队」面板点一行就进这里：复用消息流的渲染，但这个视图里
 * 没有任何输入口——要跟队友说话，回到那两颗入口里的「发话」（走宿主转交）。
 * 关掉它回自己的会话即可；这个文件也不能被归档、删除或分叉（校验在宿主那边）。
 *
 * @module desktop/renderer/TeammatePeek
 */
import type { JSX } from 'react'
import type { TeammateView, TranscriptEntry } from '@dsc/runtime/contract.js'
import { ChatView } from './ChatView.js'
import { TEAMMATE_STATE_LABEL } from './TeamPanel.js'
import { IconClose } from './icons.js'

export function TeammatePeek(props: {
  teammate: TeammateView
  entries: TranscriptEntry[]
  onClose(): void
}): JSX.Element {
  const { teammate } = props
  return (
    <div className="peek">
      <div className="peek-banner">
        <span className={`tm-dot ${teammate.state}`} />
        <span className="peek-name">队友 {teammate.name}</span>
        <span className="peek-fact">
          {teammate.role} · {TEAMMATE_STATE_LABEL[teammate.state]} · 已发 {teammate.rounds} 轮 · 派自 {teammate.parent === 'lead' ? '主会话' : teammate.parent}
        </span>
        <span className="peek-task" data-tip={teammate.task}>
          任务：{teammate.task}
        </span>
        <span className="peek-hint">只读视图；点标题栏左边那节回主会话，要发话用标题旁的「智能体团队」</span>
        <button className="icon-btn" data-tip="关闭并返回自己的会话" onClick={props.onClose}>
          <IconClose size={14} />
        </button>
      </div>
      {props.entries.length === 0 ? (
        <div className="peek-empty">该队友还没有产生运行记录。</div>
      ) : (
        <ChatView
          entries={props.entries}
          turnState={teammate.state === 'working' ? 'thinking' : 'idle'}
          // 队友的记录不是当前会话：拿它的日志文件当评价键，和自己的会话不会撞
          sessionId={teammate.file}
        />
      )}
    </div>
  )
}
