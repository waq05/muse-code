/**
 * 整轮过程折叠：每一轮「哪些条目算过程、能不能折、收尾状态」的一次性预算，
 * 以及那个总开关行组件。
 *
 * 为什么要单独一个模块：哪些条目归总开关管、开关画在哪一行、这一轮能不能折，
 * 是三件互相牵连的事——分散在 map 回调里每次渲染重算一遍既慢又容易前后不一致
 * （比如开关画了、组内却没有条目）。预算器是纯函数（自检好打），开关行是纯展示。
 *
 * @module desktop/renderer/chat/round-fold
 */
import type { JSX } from 'react'
import type { TranscriptEntry, TurnEndReason } from '@dsc/runtime/contract.js'
import { IconChevronDown } from '../icons.js'
import { formatDuration, roundDuration, type RoundInfo } from '../turn-timing.js'

/**
 * 一轮过程区的折叠情况（下标 = round.index 存进 Map）。
 */
export interface RoundFold {
  /** 轮次序号（0 基，与 RoundInfo.index 同源）：存展开态时要用它拼键。 */
  roundIndex: number
  /** 总开关行画在这一条前面（= 组内第一条可折叠条目）；-1 = 这一轮没有过程内容。 */
  startIndex: number
  /** 组内最后一条可折叠条目的下标（含）。 */
  endIndex: number
  /** 过程区里有没有可折的内容。没有时照样画总开关，只是画成不可点的（照 dsh 的 disabled）。 */
  hasContent: boolean
  /** 这一轮可不可以折整轮（= 有过程内容）。 */
  foldable: boolean
  /** 跑动中：整组强制展开、连总开关都不画（dsh 的 `turnProcessAlwaysOpen` 的 status === 'open'）。 */
  running: boolean
  /**
   * 这一轮**不能**折整轮，但总开关照画（画成不可点的）。
   *
   * 三种情况（逐个对照 dsh 的 `turnProcessAlwaysOpen`，contract/turn-process.ts:69-74）：
   * 轮中途插过话（`hasInterleavedInput`）、这一轮被中断（aborted）、这一轮跑挂了（error）。
   * 为什么要区分它和 `running`：跑动中的轮**连这一行都不画**，而这三种情况的轮已经结束了，
   * 得留一行告诉用户「这一轮收成什么样」——「已停止」「过程失败」就在这一行上。
   */
  blocked: boolean
  /** 让这一轮不能折的那个原因；正常结束或还在跑的轮是 undefined。 */
  endReason: TurnEndReason | undefined
}

/**
 * 把每一轮的过程区折叠情况算成一张表（下标 = round.index）。
 *
 * 「过程区」是「用户消息之后、这一轮最后一条定稿正文之前」的那段：要一次看完这一轮
 * 才知道末条正文在哪，逐条判的话每条都要反扫一遍自己的轮次。同时这也让「开关画了、
 * 组内却没条目」这种不一致根本不可能发生。
 *
 * 三类条目不进组：
 * - plan：审批流的一部分（dsh 的 TURN_PROCESS_INDEPENDENT_KINDS），收起过程不能把
 *   「等你点批准」一起藏掉；
 * - 本轮最后一条定稿 text（id>=0）：那是这一轮的最终回答，折叠的目标就是「过程收起来、
 *   回答留着」；
 * - 定稿轮里的直播尾（id<0）——它只可能出现在还没收尾的那一轮，而那一轮强制展开。
 */
export function buildRoundFolds(
  entries: readonly TranscriptEntry[],
  rounds: readonly RoundInfo[],
  options: { foldTurns: boolean; live: boolean; lastRoundIndex: number },
): Map<number, RoundFold> {
  const out = new Map<number, RoundFold>()
  for (const round of rounds) {
    // 本轮最后一条定稿正文（从后往前找，找到就走）；它之后（含它自己）都不折叠。
    let answerIndex = -1
    for (let at = round.endIndex; at > round.startIndex; at -= 1) {
      const entry = entries[at]
      if (entry !== undefined && entry.kind === 'text' && entry.id >= 0) {
        answerIndex = at
        break
      }
    }
    let startIndex = -1
    let endIndex = -1
    let hasLiveEntry = false
    /** 轮内插过话（steering）——dsh 的 hasInterleavedInput：插过话的轮不给整轮折叠。 */
    let hasSteering = false
    /** 轮尾标记给的结束原因。只有中断 / 失败才落这一条（见 adapter 的 turn/end 分支）。 */
    let endReason: TurnEndReason | undefined
    for (let at = round.startIndex + 1; at <= round.endIndex; at += 1) {
      const entry = entries[at]
      if (entry === undefined) continue
      if (entry.id < 0) hasLiveEntry = true
      if (entry.kind === 'user' && entry.steering === true) hasSteering = true
      if (entry.kind === 'turn-end') endReason = entry.reason
      if (entry.kind !== 'thinking' && entry.kind !== 'tool' && entry.kind !== 'text') continue
      if (answerIndex >= 0 && at >= answerIndex) continue
      if (startIndex < 0) startIndex = at
      endIndex = at
    }
    const hasContent = startIndex >= 0
    out.set(round.index, {
      roundIndex: round.index,
      startIndex,
      endIndex,
      hasContent,
      // foldable 只说「这一档允许折整轮」；有没有东西可折看 hasContent——
      // 没内容的轮照样画那一行抬头，只是画成不可点的（照 dsh 的 disabled 分支）。
      foldable: options.foldTurns,
      // 跑动中的两种形态都算「这一轮还没收尾」：出现了直播条目（id<0），或者这就是最后一轮
      // 而回合还没结束，或者用户刚发完消息、助手一个字都还没回（answered 为假）。
      running: hasLiveEntry || (options.live && round.index === options.lastRoundIndex) || !round.answered,
      blocked: hasSteering || endReason === 'aborted' || endReason === 'error',
      endReason,
    })
  }
  return out
}

/**
 * 整轮过程折叠的总开关行（对照 dsh 的 TurnProcessNodeView.tsx:36-53）：
 * 一行左对齐的小字按钮，「用时 X」（算不出用时就是「已完成」，绝不显示 NaN）+ 行尾箭头，整行可点。
 *
 * 只给定稿轮画（跑动中的轮不渲染这一行，见 seat 里那处条件）：dsh 的 turn-process 节点
 * 同样只在本轮 status === 'closed' 时才渲染（TurnProcessNodeView.tsx:18）。
 *
 * 三种结束状态各有一句话（逐字对照 dsh 的 TurnProcessNodeView.tsx:26-29）：
 * 被中断说「已停止」、跑挂说「过程失败」，其余才报到「用时 X」。后两种把这一行画成不可点的
 * （dsh 的 `disabled={!canCollapse}`），因为那一轮的过程要一直摊着给用户看。
 *
 * 为什么标题是「用时」而不是「思考过程 / 工具调用」：dsh 那一行报的是「这一轮花了多久」
 * （TurnProcessNodeView.tsx:21-29 的 took / worked），条数之类的统计留在 data-* 属性上给
 * 自检用，不占人眼。这一行收起来的是过程，用户最想知道的是「值不值得展开看一眼」。
 *
 * @param props.disabled 这一轮不让折（中断 / 失败 / 轮内插过话 / 压根没有过程内容）
 */
export function TurnFoldRow(props: {
  open: boolean
  round: RoundInfo
  disabled: boolean
  endReason: TurnEndReason | undefined
  onToggle(): void
}): JSX.Element {
  const used = formatDuration(roundDuration(props.round))
  const label = props.endReason === 'aborted' ? '已停止'
    : props.endReason === 'error' ? '过程失败'
      : used === null ? '已完成' : `用时 ${used}`
  return (
    <button
      type="button"
      className="turn-fold"
      // 展开态走 data-open（对照 dsh 的 css.root[data-open]），样式里靠它转箭头
      data-open={props.open ? '1' : undefined}
      data-round-index={props.round.index}
      data-turn-blocked={props.disabled ? '1' : undefined}
      disabled={props.disabled}
      // 不可折时这一行只是抬头：报一句「这一轮收成什么样」，不给开合承诺
      aria-expanded={props.disabled ? undefined : props.open}
      data-tip={
        props.disabled
          ? props.endReason === 'aborted'
            ? '这一轮被中断，过程保持展开'
            : props.endReason === 'error'
              ? '这一轮跑挂了，过程保持展开'
              : '这一轮没有可折叠的过程内容'
          : props.open ? '收起这一轮的过程（思考与工具调用）' : '展开这一轮的过程（思考与工具调用）'
      }
      onClick={props.onToggle}
    >
      <span className="turn-fold-label">{label}</span>
      {props.disabled ? null : <IconChevronDown size={11} className="turn-fold-chevron" />}
    </button>
  )
}
