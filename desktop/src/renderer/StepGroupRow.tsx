/**
 * 阶段组头（对照 dsh 的 ChatGroupSeat.tsx:91-128 的 ProcessGroupHeader）：一行可点的小字，
 * 「类别图标 + 标题（+ 实时任务详情）+ 行尾箭头」，整行可点开合。
 *
 * 为什么是聚合标题而不是工具名清单：一阶段里可能压着十几次调用（read → grep → glob → bash），
 * 逐条列出来跟没折叠一样长。dsh 的组头只说「这一阶段干了哪类事」——
 * 「已读取文件，已搜索代码，执行了命令」——次数收进 data-step-counts 给自检用，不占人眼
 * （对照 conversation-nodes/step-process.ts:11-27）。
 *
 * 三处显隐与开合细节（都对照 dsh）：
 * - **未结束的组头带实时详情**：「正在运行命令 · pnpm build」，回答「现在卡在哪一步」。
 *   取参数的键序在 process-groups.ts 的 DETAIL_KEYS，档位开关是 liveDetail（紧凑档不带）。
 * - **标题至少保留 150ms**（useStableLiveTitle + liveTitleDecision）：不然一次多步工具轮里
 *   标题一秒跳好几次，读不出来。
 * - **图标位与箭头叠放，悬停或键盘聚焦时换成箭头**（dsh 的 .leading 里叠着
 *   .activityIcon 与 .chevron，ChatGroupSeat.tsx:117-121 与 README.zh.md:168）：
 *   静息一行只看「哪类活」，要动手时才把「能点」这件事显出来。
 *
 * 为什么整行是按钮而不是只有箭头可点：跟 ThinkingBlock / ToolCard 的紧凑行同款——
 * 三者在对话流里是紧挨着的「过程」条目，命中区不一样的话，扫视时要重新认一遍哪里能点
 * （对照 dsh 的 DisclosureRow expandOnRowClick，ReasoningRow.tsx:95）。
 *
 * 「正在… / 已…」两套文案由 group.closed 决定（见 process-groups.ts 的 stepGroupTitle）。
 * 已结束且一类工具都没调过的组显示「已完成分析」——那是「只思考没动手」的那一阶段。
 *
 * @module desktop/renderer/StepGroupRow
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import {
  IconBolt, IconChevronDown, IconCode, IconEdit, IconFolder, IconGlobe, IconInfo,
  IconQueue, IconSearch, IconSpark, IconTerminal, IconTree,
} from './icons.js'
import {
  joinLiveDetail, liveTitleDecision, liveTitleOf, sameLiveTitle, stepGroupTitle,
  type LiveProcessTitle, type ProcessActivity, type StepGroup,
} from './process-groups.js'

/**
 * 类别 → 图标（对照 dsh 的 PROCESS_ICONS，ChatGroupSeat.tsx:37-52）。
 *
 * 尺寸统一 12px：组头是过程区里最小的一档字，图标跟着最上面那行标题走，
 * 比思考行/工具行自己的图标不显眼——它是分组说明，不是内容本身。
 */
const ACTIVITY_ICON: Record<ProcessActivity | 'thinking', ReactNode> = {
  thinking: <IconSpark size={12} />,
  read: <IconFolder size={12} />,
  readImage: <IconFolder size={12} />,
  search: <IconSearch size={12} />,
  write: <IconEdit size={12} />,
  edit: <IconEdit size={12} />,
  commands: <IconTerminal size={12} />,
  code: <IconCode size={12} />,
  webSearch: <IconGlobe size={12} />,
  webFetch: <IconGlobe size={12} />,
  browser: <IconGlobe size={12} />,
  subagents: <IconTree size={12} />,
  plan: <IconQueue size={12} />,
  questions: <IconInfo size={12} />,
  tools: <IconBolt size={12} />,
}

/**
 * 让实时标题至少显示 150ms（对照 dsh 的 useStableLiveProcessTitle，ChatGroupSeat.tsx:58-81）。
 *
 * 时钟与判定分开：判定是 process-groups.ts 的纯函数 liveTitleDecision（能脱开 React 测），
 * 这里只管三件与 React 有关的事——记住「当前显示的是哪个标题」，到点换成**最新**的那一个
 * （不是排队时那一个：中间态直接跳过），以及组件卸载时把定时器收掉。
 *
 * 组一结束（active 为假）直接返回 desired：定稿的组头用聚合文案，不参与防抖。
 *
 * @param desired 此刻该显示的标题
 * @param active 这一组是不是还在跑
 */
function useStableLiveTitle(desired: LiveProcessTitle, active: boolean): LiveProcessTitle {
  const [shown, setShown] = useState(desired)
  const shownRef = useRef(shown)
  const wantedRef = useRef(desired)
  const shownAtRef = useRef(Date.now())

  useEffect(() => {
    wantedRef.current = desired
    if (!active) return
    const commit = (next: LiveProcessTitle): void => {
      shownRef.current = next
      shownAtRef.current = Date.now()
      setShown(next)
    }
    const decision = liveTitleDecision(shownRef.current, desired, Date.now() - shownAtRef.current)
    if (!decision.keep) {
      commit(desired)
      return
    }
    if (decision.waitMs <= 0) return
    const timer = setTimeout(() => {
      const next = wantedRef.current
      if (sameLiveTitle(shownRef.current, next)) return
      commit(next)
    }, decision.waitMs)
    return () => {
      clearTimeout(timer)
    }
  }, [active, desired.activity, desired.detail])

  return active ? shown : desired
}

export function StepGroupRow(props: {
  group: StepGroup
  /**
   * 这一组现在展开没有。
   *
   * 已定稿的组默认收起（一轮跑完要看的是「走过哪几个阶段」，不是每一阶段的每一条）；
   * 跑动中的组同样默认收起（对照 dsh：组是 useDisclosure 的初始收起态，
   * ChatGroupSeat.tsx:136 与 use-disclosure.ts:12-13），那一刻「现在在干什么」由组头的
   * 实时详情承载——所以这一位与跑不跑无关，只认用户手点过的存档。
   */
  open: boolean
  /** 这一档要不要在组头里显示实时详情（dsh 的 liveProcessDetail：紧凑档为假）。 */
  showDetail: boolean
  onToggle(): void
}): JSX.Element {
  const closed = props.group.closed
  const live = useStableLiveTitle(liveTitleOf(props.group), !closed)
  // 图标与标题同源（对照 ChatGroupSeat.tsx:113）：已结束的组按次数最多的那一类，
  // 未结束的组按此刻在跑的那一类——两边要是不同源，会出现「标题说在读文件、图标是终端」。
  const activity: ProcessActivity | 'thinking' = closed
    ? props.group.counts[0]?.kind ?? 'thinking'
    : live.activity
  const label = stepGroupTitle(
    props.group.counts,
    closed,
    activity === 'thinking' ? undefined : activity,
    // 「准备读取文件」与「正在读取文件」是两句不同的话：模型还在吐参数 vs 工具真的开跑了
    live.preparing,
  )
  const detail = closed || !props.showDetail ? '' : live.detail
  const title = joinLiveDetail(label, detail)
  // 次数与实时详情不上面面，但要留在 DOM 上：截图用例与探针靠它断言「这一组收进去几条什么类别的调用」
  const counts = props.group.counts.map((item) => `${item.kind}=${String(item.count)}`).join(',')
  return (
    <button
      type="button"
      className="step-fold"
      // 展开态走 data-open（与 .turn-fold 同一套写法），样式里靠它转箭头
      data-open={props.open ? '1' : undefined}
      data-step-group={`${String(props.group.roundIndex)}:${String(props.group.seq)}`}
      data-step-activity={activity}
      data-step-closed={closed ? '1' : undefined}
      data-step-counts={counts}
      data-step-detail={detail === '' ? undefined : detail}
      aria-expanded={props.open}
      data-tip={props.open ? '收起这一阶段' : '展开这一阶段的过程（思考与工具调用）'}
      onClick={(event) => {
        // 先把焦点落到组头自己身上再开合（对照 ChatGroupSeat.tsx:116 的
        // `event.currentTarget.focus(); toggle()`）：收起组体时，焦点如果正落在组里某个
        // 按钮上，那个按钮会随组体一起消失，键盘用户当场丢失位置。落到组头上就没有这个问题。
        event.currentTarget.focus()
        props.onToggle()
      }}
    >
      {/* 图标位与箭头叠放在同一格：静息显示类别图标，悬停 / 聚焦 / 展开时换成箭头
          （对照 dsh 的 .leading 把 activityIcon 与 chevron 叠在一起，ChatGroupSeat.tsx:117-121）。 */}
      <span className="step-fold-leading" aria-hidden="true">
        <span className="step-fold-icon" data-step-icon>
          {ACTIVITY_ICON[activity]}
        </span>
        <span className="step-fold-chevron" data-step-chevron>
          <IconChevronDown size={12} />
        </span>
      </span>
      <span
        className="step-fold-label"
        // 跑动中的扫光：属性值就是 ::after 要复制的那串文字（见 styles.css 里那条共用规则）。
        // 收口的组不给——它已经不动了，扫光反而像还在干活（对照 dsh 的 active={!data.closed}）。
        data-shimmer={closed ? undefined : title}
      >
        {title}
      </span>
    </button>
  )
}
