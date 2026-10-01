import { useState, type ReactNode } from 'react'
import { PendingCard } from '../components/ApprovalCard.js'
import { ChatStream } from '../components/ChatStream.js'
import { Composer } from '../components/Composer.js'
import { TopBar } from '../components/TopBar.js'
import type { ClientState, RemoteClient } from '../lib/client.js'
import { pathName, pathTail, usageLine } from '../lib/format.js'
import { allEntries, currentTurnUsage } from '../lib/protocol.js'
import type { ApprovalAnswer, RemoteSnapshot } from '../lib/types.js'

/**
 * 聊天页：一屏里同时管四件事——看直播、发消息/打断、答卡片、看本轮用量。
 *
 * 布局是「不滚动的列 + 一个会滚的区域」：
 *   TopBar / 连接细条 / 对话流（唯一可滚）/ 用量小字 / 待办卡 / 发送框。
 * 这样软键盘弹起时只有对话流被压缩，发送框与卡片始终在手指够得到的地方。
 */
export interface ChatPageProps {
  client: RemoteClient
  state: ClientState
  onOpenSessions: () => void
}

export function ChatPage({ client, state, onOpenSessions }: ChatPageProps): ReactNode {
  const snapshot: RemoteSnapshot | null = state.snapshot
  const entries = allEntries(snapshot)
  const usage = currentTurnUsage(snapshot)

  // 卡片身份：宿主换一张卡（或卡片消失）就自动把「已提交」状态清掉，
  // 所以这里既不用本地隐藏卡片，也不会把上一张卡的状态带到下一张。
  const cardKey = [
    snapshot?.surfaces.pendingApproval?.id ?? '-',
    snapshot?.surfaces.pendingPlan?.file ?? '-',
    snapshot?.surfaces.pendingQuestion?.id ?? '-',
  ].join('|')
  const [decidedKey, setDecidedKey] = useState<string | null>(null)
  const [cardError, setCardError] = useState<string | null>(null)
  const decided = decidedKey === cardKey

  const cwd = snapshot?.cwd ?? null
  const title = cwd === null || cwd === '' ? '当前会话' : pathName(cwd)

  function answer(method: string, args: readonly unknown[]): void {
    setDecidedKey(cardKey)
    setCardError(null)
    void client.invoke(method, args).catch((cause: unknown) => {
      // 失败就把按钮放回来：用户可以再点一次，而不是干等一张永远不会消失的卡。
      setDecidedKey(null)
      setCardError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const hasPending =
    snapshot !== null &&
    (snapshot.surfaces.pendingApproval !== null ||
      snapshot.surfaces.pendingPlan !== null ||
      snapshot.surfaces.pendingQuestion !== null)

  return (
    <div className="page page-chat">
      <TopBar
        title={title}
        subtitle={cwd === null ? undefined : pathTail(cwd, 2)}
        right={
          <button type="button" className="ghost" onClick={onOpenSessions}>
            会话
          </button>
        }
      />
      <ChatStream entries={entries} />
      {usage !== null ? (
        <div className="usageline">
          本轮 <span className="mono">{usageLine(usage)}</span>
        </div>
      ) : null}
      {hasPending && snapshot !== null ? (
        <div className="pending-dock">
          <PendingCard
            approval={snapshot.surfaces.pendingApproval}
            plan={snapshot.surfaces.pendingPlan}
            question={snapshot.surfaces.pendingQuestion}
            decided={decided}
            // 第二个实参是审计来源（contract.ts 的 answerApproval(answer, source?)）：
            // 这里点的是手机上的卡，所以报 'web'，宿主的审计记录里能分清是谁批的。
            onAnswerApproval={(value: ApprovalAnswer) => answer('answerApproval', [value, 'web'])}
            onAnswerPlan={(value: ApprovalAnswer) => answer('answerPlan', [value])}
            onAnswerQuestion={(value: string) => answer('answerQuestion', [value])}
          />
          {cardError !== null ? <p className="pendingcard-error">{cardError}</p> : null}
        </div>
      ) : null}
      <Composer
        busy={state.busy}
        stopping={state.stopping}
        connected={state.conn === 'open'}
        error={state.lastError !== null && state.conn !== 'open' ? state.lastError : null}
        onSend={(text, images) => {
          void client.submit(text, images.length > 0 ? images : undefined).catch((cause: unknown) => {
            setCardError(cause instanceof Error ? cause.message : String(cause))
          })
        }}
        onUploadFile={(file) => client.upload(file).then((result) => result.path)}
        onInterrupt={() => {
          void client.interrupt().catch((cause: unknown) => {
            setCardError(cause instanceof Error ? cause.message : String(cause))
          })
        }}
      />
    </div>
  )
}
