/**
 * 每轮对话底部的脚注（对照 dsh 的 TurnTailNodeView + MessageIconActions），一条左对齐行：
 *
 *     复制 · 赞 · 踩 · 分叉 · 用量 · 时刻
 *
 * 顺序就是 dsh 图 4 的扫读顺序：TurnTailNodeView.tsx:63-77 把 MessageIconActions 摆在整轮尾巴上，
 * MessageIconActions.tsx:85-112 里依次是复制、插件动作（赞 / 踩）、分叉，最后是 endInfo 里的
 * 用量与时刻（clock="end" 的那一侧，:110-112）。dsc 这次把复制 / 赞 / 踩从助手消息末尾那条
 * 悬停操作条（.entry-meta）搬到这里，于是四个动作 + 两项读数挤在一行里，从左往右读一遍就够。
 *
 * 位置：整行贴正文列左缘、挂在这一轮最后一条条目的正下方，与正文同一条起跑线
 * （对照 dsh 的消息脚注：TurnTailNodeView.module.css:7-12 用负的 margin-left 把整条信息拉回
 * 正文起跑线，MessageIconActions.module.css:5-10 是一条 8px 间距的行内信息条）。
 *
 * 「用时」不再占行面：它挂在整行的 title 上。为什么——它是这一行里分量最轻的一项，宽度却跟
 * 时刻一样；形态上跟 dsh 也不同（dsh 整轮行里本来就没有「用时」这一项，时长只在整轮过程
 * 总开关的标签上，见 TurnProcessNodeView.tsx:21-29）。搬进 title 以后整行只剩「动作 + 用量 +
 * 时刻」，窄窗口下不会折行。
 *
 * 用量优先真实值：
 * - 有宿主上报（该轮最后一条带 usage 的条目，见 contract.ts 的 TranscriptEntry 与 ChatView 的
 *   roundUsage）→ 显示「用量 N tok」，不带波浪号；title 说明是整轮所有请求 prompt + completion 之和；
 * - 老会话一次都没上报过 → 回落 token-estimate 的正文估算，仍带 `~` 前缀，title 说明是估算。
 * 两种口径绝不混着写：真值带 `~` 会让人以为还算过、估算不带 `~` 会被当成真值。
 *
 * 降级规则（老会话没有 ts 时是常态，不是异常）：
 * - 什么都没有（没时刻、没用量、既不复制也不评价也不分叉）→ 整行不画；
 * - 只拿得到开始时刻（这一轮的条目都没有 ts）→ 只显示 HH:mm；
 * - 用时算出来是负数或 NaN（日志时间乱序）→ 不往 title 里写用时。
 * 任何情况下都不会出现「NaN」或「0秒」这种假数据。
 *
 * 这一轮还在跑（running）时时刻与用量都不画：那一刻流末尾的状态行正在报同一份时间，
 * 两处一起跳反而乱；用量还在长，报半截数字没有意义。但分叉按钮要留在这一行上（置灰），
 * 用户才知道这一轮结束时能在哪分叉。
 *
 * 复制的内容沿用改版前的口径：这一轮最终 text 条目的原文（ChatView 传 copyText）。
 * 一轮以工具结果收尾、没有最终正文时不给复制按钮。
 *
 * 用时怎么算是 turn-timing.ts 的 roundDuration 说了算，用量怎么估是 token-estimate.ts 说了算，
 * 这里只负责画：同一套口径只留一处，免得两个组件各算一遍算出两个数。
 *
 * @module desktop/renderer/TurnFooter
 */
import type { JSX } from 'react'
import { IconBranch, IconCopy, IconThumbDown, IconThumbUp } from './icons.js'
import { formatTokens } from './token-estimate.js'
import { formatClock, formatDuration, roundDuration, type RoundInfo } from './turn-timing.js'

export function TurnFooter(props: {
  round: RoundInfo
  /** 这一轮还在跑：时刻与用量先不画（状态行正在报同一份时间），分叉按钮置灰留着。 */
  running?: boolean
  /**
   * 这一轮助手正文的 token 估算（见 token-estimate.ts）。
   * 只在没有真实用量时用来回落显示；不传 / 传 null / 算出 0 都不画这一项。
   */
  tokens?: number | null
  /**
   * 宿主上报的整轮真实用量（prompt + completion 累计，见 contract.ts 的 TranscriptEntry）。
   * 有真值就以它为准，不再显示估算。
   */
  usage?: { inputTokens: number; outputTokens: number } | null
  /**
   * 这一轮最终回答的原文；不传就整颗不画复制按钮
   * （一轮以工具结果收尾时没有可以复制的最终正文）。
   */
  copyText?: string
  /** 本机评价的两态（只记在这台机器上）；不传 = 这个视图不提供评价按钮。 */
  voteState?: 'up' | 'down'
  /** 点评价：同一项再点一次是取消，判断在 ChatView（本机组件的存档也在那边）。 */
  onVote?(next: 'up' | 'down'): void
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
  // 真值优先：宿主上报的整轮累计（一轮里每次请求的 prompt + completion 之和）。
  // 0 或负数当没上报——真跑过一轮不可能一个 token 都没有。
  const measured =
    running || props.usage === null || props.usage === undefined
      ? null
      : props.usage.inputTokens + props.usage.outputTokens
  const real = measured !== null && measured > 0 ? measured : null
  // 回落口径：老会话没有宿主上报的用量，才用正文估算顶上（显示时带 ~）。
  const estimated =
    real !== null || running || props.tokens === null || props.tokens === undefined || props.tokens <= 0
      ? null
      : props.tokens
  const copy = props.copyText !== undefined
  const vote = props.onVote !== undefined
  const fork = props.onFork !== undefined
  // 老会话什么时间都拿不到、又没有动作与用量要画：这一行不必占位
  if (clock === null && !copy && !vote && !fork && real === null && estimated === null) return null
  return (
    <div
      className="round-foot"
      // 「用时」不占行面，放在整行的悬停提示里（口径与改版前那颗 .round-used 的 title 一致）
      title={used === null ? undefined : `用时 ${used}（从发出这条消息到这一轮最后一次写入，中间的工具调用与思考都算在内）`}
    >
      {copy && (
        <button
          type="button"
          className="round-act"
          title="复制这条回复的原文"
          aria-label="复制这条回复的原文"
          onClick={() => void navigator.clipboard.writeText(props.copyText ?? '')}
        >
          {/* 图标 17px：dsh 助手消息末尾那条操作条（data-clock='end'）的图标就是 15px + 2px
              （MessageIconActions.module.css:79-87），28px 的 hit area 与倍率在 styles.css 的
              「对话区修正批」那一段。 */}
          <IconCopy size={17} />
        </button>
      )}
      {vote && (
        <button
          type="button"
          className={`round-act${props.voteState === 'up' ? ' on' : ''}`}
          title="这条回复不错（只记在本机）"
          aria-label="这条回复不错（只记在本机）"
          aria-pressed={props.voteState === 'up'}
          onClick={() => props.onVote?.('up')}
        >
          <IconThumbUp size={17} />
        </button>
      )}
      {vote && (
        <button
          type="button"
          className={`round-act${props.voteState === 'down' ? ' on' : ''}`}
          title="这条回复不好（只记在本机）"
          aria-label="这条回复不好（只记在本机）"
          aria-pressed={props.voteState === 'down'}
          onClick={() => props.onVote?.('down')}
        >
          <IconThumbDown size={17} />
        </button>
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
          {/* 图标沿用改版前页脚里分叉那颗的 15px（MessageIconActions.module.css:79-82 用户那一档
              也是 15px）；它比复制 / 赞 / 踩小一档是有意的：方向性动作用小图标，读数更大的图标
              反而会把扫读顺序读乱。 */}
          <IconBranch size={15} />
        </button>
      )}
      {real !== null && (
        <span
          className="round-tokens"
          title="这一轮所有模型请求的 prompt 与 completion 之和（宿主上报的真实用量）"
        >
          用量 {formatTokens(real)} tok
        </span>
      )}
      {estimated !== null && (
        <span
          className="round-tokens"
          title="这一轮助手正文的 token 估算（中文约 0.65 token/字、其余约 0.33）；老会话没有宿主上报的用量，这是估算值"
        >
          ~{formatTokens(estimated)} tok
        </span>
      )}
      {clock !== null && (real !== null || estimated !== null) && (
        <span className="round-sep" aria-hidden="true">
          ·
        </span>
      )}
      {clock !== null && (
        <span className="round-clock" title="这条消息发出的时刻（本机时区）">
          {clock}
        </span>
      )}
    </div>
  )
}
