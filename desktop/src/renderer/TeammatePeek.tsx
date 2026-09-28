/**
 * 队友运行记录的只读视图。
 *
 * 侧栏「队友」那一档点一行就进这里：复用消息流的渲染，但没有任何输入口——
 * 给队友说话要用 `subagent` 工具（那是模型之间的事），人插手会打乱它的上下文。
 * 关掉它回自己的会话即可；这个文件也不能被归档、删除或分叉（校验在宿主那边）。
 *
 * @module desktop/renderer/TeammatePeek
 */
import type { JSX } from 'react'
import type { TeammateView, TranscriptEntry } from '@dsc/runtime/contract.js'
import { ChatView } from './ChatView.js'
import { IconClose } from './icons.js'

/** 状态 → 中文标签与颜色档位。 */
const STATE_LABEL: Record<TeammateView['state'], string> = {
  working: '正在干',
  idle: '已完工',
  stopped: '被打断',
  failed: '失败了',
}

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
          {teammate.role} · {STATE_LABEL[teammate.state]} · 已发 {teammate.rounds} 轮 · 派自 {teammate.parent === 'lead' ? '主会话' : teammate.parent}
        </span>
        <span className="peek-task" data-tip={teammate.task}>
          任务：{teammate.task}
        </span>
        <span className="peek-hint">只读，不能在这里发言</span>
        <button className="icon-btn" data-tip="关掉，回自己的会话" onClick={props.onClose}>
          <IconClose size={14} />
        </button>
      </div>
      {props.entries.length === 0 ? (
        <div className="peek-empty">它还没有留下内容。</div>
      ) : (
        <ChatView entries={props.entries} turnState={teammate.state === 'working' ? 'thinking' : 'idle'} />
      )}
    </div>
  )
}
