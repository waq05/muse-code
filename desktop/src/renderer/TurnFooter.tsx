/**
 * 每轮对话底部的一行：时刻 · 用时 · 分叉入口 · 这一轮的正文用量。
 *   本轮时间 = 用户发消息那一刻的 HH:mm；
 *   本轮用时 = 该轮末条目 ts − 用户消息 ts（中间的工具调用、思考都算在里面）。
 *
 * 位置（本轮改版）：整行贴正文列左缘、挂在这一轮最后一条条目的正下方，与正文同一条起跑线
 * （对照 dsh 的消息脚注：TurnTailNodeView.module.css:7-12 用负的 margin-left 把整条信息拉回
 * 正文起跑线，MessageIconActions.module.css:5-10 是一条 8px 间距的行内信息条）。
 * 改版前这一行靠 justify-content: flex-end 顶在对话区最右缘，离正文半屏远——读完一段回复
 * 想找分叉入口得横跨整屏，用户找不到它。
 *
 * 顺序就是扫读顺序：先「什么时候发的」、再「花了多久」、然后才是动作（分叉），最后是这一轮
 * 吐了多少字。用量从助手消息的操作条搬过来（原来贴在右缘），跟时刻、用时同处一行才读得通。
 *
 * 降级规则（老会话没有 ts 时是常态，不是异常）：
 * - 四项都拿不到、又没有分叉按钮要画 → 整行不画；
 * - 只拿得到开始时刻（这一轮的条目都没有 ts）→ 只显示 HH:mm，不显示用时；
 * - 用时算出来是负数或 NaN（日志时间乱序）→ 只显示 HH:mm。
 * 任何情况下都不会出现「NaN」或「0秒」这种假数据。
 *
 * 这一轮还在跑（running）时时刻、用时、用量都不画：那一刻流末尾的状态行正在报同一份时间，
 * 两处一起跳反而乱；用量也在长，报半截数字没有意义。但分叉按钮要留在这一行上（置灰），
 * 用户才知道这一轮结束时能在哪分叉。
 *
 * 「分叉」这颗按钮挂在这一行里（时刻与用时的右边）：它按的是「以这一轮的用户消息为界
 * 复制出一份新会话」，跟这一轮的时间是同一件事的两面，所以跟时间同处一行。
 * 只读视图（队友运行记录）不传 onFork，这里整颗不画——宿主本来就拒绝分叉队友文件。
 *
 * 用时怎么算是 turn-timing.ts 的 roundDuration 说了算，用量怎么估是 token-estimate.ts 说了算，
 * 这里只负责画：同一套口径只留一处，免得两个组件各算一遍算出两个数。
 *
 * @module desktop/renderer/TurnFooter
 */
import type { JSX } from 'react'
import { IconBranch } from './icons.js'
import { formatTokens } from './token-estimate.js'
import { formatClock, formatDuration, roundDuration, type RoundInfo } from './turn-timing.js'

export function TurnFooter(props: {
  round: RoundInfo
  /** 这一轮还在跑：时间与用时先不画（状态行正在报同一份时间），分叉按钮置灰留着。 */
  running?: boolean
  /**
   * 这一轮助手正文的 token 估算（见 token-estimate.ts）。
   * 不传 / 传 null / 算出 0（这一轮没有正文）都不画这一项。
   */
  tokens?: number | null
  /**
   * 以这一轮的用户消息为界分叉出新会话（参数是那条用户消息在 entries 里的下标）。
   * 不传 = 这个视图不提供分叉（只读视图），按钮整颗不画。
   */
  onFork?: (entryIndex: number) => void
  /** 分叉按钮能不能按：一轮正在跑、或这条消息之前没有内容时为真。 */
  forkDisabled?: boolean
  /** 分叉按钮的悬停提示；不传用默认那句（分叉点定不下来时的原因由 ChatView 传进来）。 */
  forkTitle?: string
}): JSX.Element | null {
  const running = props.running === true
  const clock = running ? null : formatClock(props.round.startTs)
  const used = running ? null : formatDuration(roundDuration(props.round))
  // 用量与时刻、用时同一个降级口径：拿不到、算出负数、这一轮还没收工，一律不画。
  const tokens = running || props.tokens === null || props.tokens === undefined || props.tokens <= 0
    ? null
    : props.tokens
  const fork = props.onFork !== undefined
  // 老会话什么时间都拿不到、又没有分叉入口要画：这一行不必占位
  if (clock === null && used === null && !fork && tokens === null) return null
  return (
    <div className="round-foot">
      {clock !== null && (
        <span className="round-clock" title="这条消息发出的时刻（本机时区）">
          {clock}
        </span>
      )}
      {clock !== null && used !== null && (
        <span className="round-sep" aria-hidden="true">
          ·
        </span>
      )}
      {used !== null && (
        <span
          className="round-used"
          title="从发出这条消息到这一轮最后一次写入（中间的工具调用与思考都算在内）"
        >
          用时 {used}
        </span>
      )}
      {fork && (
        <button
          type="button"
          className="user-act"
          title={props.forkTitle ?? '以这条消息为界分叉出新会话'}
          aria-label="以这条消息为界分叉出新会话"
          disabled={props.forkDisabled === true}
          onClick={() => props.onFork?.(props.round.startIndex)}
        >
          {/* 图标 15px：dsh 那条操作条里分支按钮的图标就是 15px
              （MessageIconActions.module.css:79-82；助手末尾那一档是 17px）。
              28px 的 hit area 与倍率在 styles.css 末尾「对话区修正批」那一段。 */}
          <IconBranch size={15} />
        </button>
      )}
      {tokens !== null && (clock !== null || used !== null) && (
        <span className="round-sep" aria-hidden="true">
          ·
        </span>
      )}
      {tokens !== null && (
        <span
          className="round-tokens"
          title="这一轮助手正文的 token 估算（中文约 0.65 token/字、其余约 0.33）；宿主没有按条记录用量，这是估算值"
        >
          ~{formatTokens(tokens)} tok
        </span>
      )}
    </div>
  )
}
