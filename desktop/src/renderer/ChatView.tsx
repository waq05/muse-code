/**
 * 消息流：user 气泡 / thinking 折叠 / text markdown（含底部操作条）/ 工具卡 / system 灰条
 * + 流式直播尾光标 + 条件式自动滚动到底。
 *
 * 自动跟随这次改成了条件式的（改版前每来一块新内容就把 scrollTop 钉到底，往上翻历史
 * 翻不动）：用户主动往上滚（滚轮 / 触摸拖动 / 拖滚动条，判定都落在「scrollTop 离开底部」
 * 这一件事上）就暂停跟随——「离开」按 120px 那一档算（PAUSE_EPS，比贴底档宽，见那里的
 * 注释）；滚回距底 32px（与 JumpStrip.tsx 的 AT_BOTTOM_EPS 同一档）以内、
 * 或点右下角那颗「回到底部」才恢复。两个场景无条件跟随：换会话（点开一条会话要看的是它的
 * 末尾）与自己刚发出一条用户消息（要立刻看到它和它的回复）。内容自己变高不算「用户滚离」——
 * 那不发 scroll 事件，程序性的高度变化因此不会被误判。
 *
 * 消息底部对照 dsh 的构图：每条条目下面是一行页脚（TurnFooter：复制 · 赞 · 踩 · 分叉 · 用量 · 时刻
 * 一条左对齐行，顺序照 dsh 图 4，见 TurnFooter.tsx 的模块注释）；复制 / 赞 / 踩原先挂在助手消息
 * 末尾那条悬停操作条（.entry-meta）上，这一轮搬进页脚——它们本来就是「对这条回复做什么」，
 * 跟这一轮的用量与时刻是同一件事的几面，同一行读完就不用再把眼睛挪回消息末尾。
 * 页脚这六项都贴正文列左缘、跟正文同一条起跑线（对照 dsh 的消息脚注排法）；
 * 敲定之前它贴在对话区最右缘、用量还挂在消息末尾右端，离正文太远。
 * 宿主记了每条条目的落盘时刻（contract.ts 的 TranscriptEntry.ts），
 * 老会话没有这个字段时那一行的两端各自降级，绝不显示 NaN。
 *
 * 整轮过程折叠（对照 dsh 的 standard 档，见 TurnProcessNodeView.tsx 与 ChatNodeSeat.tsx）：
 * 一轮跑完以后，这一轮的过程条目（思考 / 工具卡 / 中间几段正文）整组收起，原位只留一行左对齐的
 * 总开关（「用时 X」+ 箭头，整行可点）；收起时这一轮只剩「用户消息 → 总开关行 → 最终回答」。
 * - 定稿轮默认收起，展开态存 fold-state（键 `会话id:turn:轮序号`，见 turnFoldKey）；
 * - 跑动中的轮永远展开、连总开关都不画（dsh 的 turnProcessAlwaysOpen + liveProcess 语义）；
 * - plan 条目不进组：它是审批流的一部分（dsh 的 TURN_PROCESS_INDEPENDENT_KINDS），收起过程
 *   不能把「等你点批准」也一起藏掉；
 * - 最终回答正文与页脚不折叠；
 * - 展示档位（props.processFold）管这一层的三个开关：整轮折不折、定稿思考行显不显示摘要、
 *   以及阶段分组模式（见 appearance.ts 的 PROCESS_FOLD_POLICIES）。
 *
 * 阶段组折叠（对照 dsh 的 process-groups，见 process-groups.ts 与 StepGroupRow.tsx）：
 * 整轮折叠只给一轮一个开关、且永远画在轮首；长程任务一轮跑出十几个阶段时，中间没有第二个能
 * 收起来的地方。所以在整轮之内再切一层「阶段组」——两段阶段正文之间夹着的思考与工具调用合成
 * 一组，每组一个组头（「已读取文件，已搜索代码，执行了命令」这种类别聚合文案）。
 * - 切分规则与标题拼法全在 process-groups.ts（纯函数，可脱离界面核对）；
 * - 组头位置：站在组内第一条上（收起时它是这一阶段唯一看得见的东西）；
 * - **组的默认态一律是收起**（跑动中也是）：那一刻「现在在干什么」由组头承载——
 *   未结束的组头带实时任务详情（「正在运行命令 · pnpm build」），所以收起不会让信息变少
 *   （对照 dsh：组是 useDisclosure 的初始收起态，ChatGroupSeat.tsx:136）；
 * - 三层显隐从外向内：整轮 → 阶段组 → 单条思考 / 工具。整轮收起时组头跟着一起收，
 *   只留总开关那一行（对照 dsh 的 conversation-nodes/README.zh.md:56）；
 * - 轮收尾（跑动 → 定稿）时两层一起复位成默认收起，于是刚写完的那一轮自动折起来。
 * - 详细档（`stepGrouping: 'history'`）只给已定稿的轮分组：正在跑的那一轮直接摊开，
 *   连组头都不画（对照 dsh 的 ChatGroupSeat.tsx:143-144）。
 *
 * 每条条目外面套一层 `<div class="entry-row" data-round="N">`（样式里是 display:contents，
 * 不产生盒子、不改变 flex 布局）：一是让右缘刻度条能做真正的命中测试
 * （命中哪个条目就知道是第几轮，见 JumpStrip.tsx），二是每轮的页脚有地方挂，
 * 三是整轮折叠的总开关行有地方站（就站在组内第一条的位置上，收起时那些条目根本不渲染）。
 *
 * 用户消息的两个操作分处两地（都是悬停出现）：
 * - 「编辑」挂在气泡正下方的气泡外（`.user-turn` 里、`.entry-user` 之外）：铅笔压在气泡
 *   背景里会盖住正文最后一行，挪到气泡下面既不遮字，也还在拇指够得到的位置；
 * - 「分叉」挂在每轮末尾的时间行（TurnFooter）里、HH:mm 与用时的右边：分叉是按
 *   「以这条消息为界」切一刀，跟这一轮的时间是同一件事的两面，同处一行才读得通。
 * 两条都落到同一个宿主能力上——`forkSession(路径, 用户消息下标)` 把这条之前的全部内容
 * 复制成一份新会话，原会话一个字节都不动。区别只在分叉之后做什么：
 * 分叉就是切过去；编辑额外把改好的正文作为新会话的下一条用户消息发出去（重发一轮）。
 * 为什么走分叉而不是像 codex / hermes 那样就地截断当前会话：截断是不可逆的，
 * 用户改一个错字就把后半段对话删了，代价太大；新会话保住了旧内容，随时切得回去。
 *
 * @module desktop/renderer/ChatView
 */
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { ChangedFileView, StatusView, TranscriptEntry, UiProcessFold } from '@dsc/runtime/contract.js'
import type { RuntimeProxy } from './bridge.js'
import { processFoldPolicy } from './fold-policy.js'
import { JumpStrip } from './JumpStrip.js'
import { PlanReview } from './TaskDock.js'
import { RowSeat, StepGroupSeat } from './fold-seats.js'
import { ThinkingBlock } from './ThinkingBlock.js'
import { ToolCard } from './ToolCard.js'
import { TurnFooter } from './TurnFooter.js'
import { TurnStatusLine } from './TurnStatusLine.js'
import { ChangedFilesCard, mergeChangesByPath } from './ChangedFiles.js'
import { isSessionMarker } from './session-marker.js'
import { groupSteps, type StepGroup, type StepGrouping } from './process-groups.js'
import { readFold, stepGroupFoldKey, turnFoldKey, writeFold } from './fold-state.js'
import { liveActivity, roundInfos, turnStartedAt, type RoundInfo } from './turn-timing.js'
import { toastErr, toastOk } from './components/toast.js'
import { IconEdit } from './icons.js'
import { estimateTextTokens } from './token-estimate.js'
import { MarkdownText } from './chat/markdown-text.js'
import { loadFeedback, recordFeedback, type Feedback } from './chat/feedback.js'
import { buildRoundFolds, TurnFoldRow, type RoundFold } from './chat/round-fold.js'
import { buildSeatPlan, type ChatPlanItem, type RoundSeatPlan } from './chat/seat-plan.js'
import { useChatViewport, PAGE_ROUNDS } from './chat/use-chat-viewport.js'

/**
 * 「不分阶段组」的空结果（完全展开档用，见 stepGrouping 的注释）。
 *
 * 为什么是模块级常量而不是每次新建：渲染层拿它建的是同一批空 Map，做成常量能让「那一档下
 * stepGrouping 的引用不变」，那一档的整棵子树因此在 entries 变化时也不必因为分组结果换新对象
 * 而重算一遍。
 */
const EMPTY_STEP_GROUPING: StepGrouping = { groups: [], headAt: new Map(), at: new Map() }

/** 不需要「被查找命中时放行」这个动作的座位用它（不属于任何轮的条目）。 */
const NO_REVEAL = (): void => undefined

export function ChatView(props: {
  entries: TranscriptEntry[]
  turnState: StatusView['turnState']
  /** 当前会话 id（评价按「会话:条目」存，换会话不串味）；未知时传 null。 */
  sessionId: string | null
  /**
   * 当前会话的 jsonl 绝对路径（分叉与「重发」都要把它交给宿主）。
   * 只读视图（队友运行记录）不传：那里不提供编辑与分叉——宿主本来就拒绝分叉队友文件。
   */
  sessionPath?: string | null
  /** 宿主代理；不传就只读（只读视图里那颗「编辑」「分叉」都不出现）。 */
  proxy?: RuntimeProxy
  /**
   * 切到某个会话（路径）或开一个新会话（不传参数）。返回 Promise：编辑重发要等宿主
   * 真的把会话换过去，才能把改好的正文发给新会话——早一步就发到旧会话里去了。
   */
  onOpenSession?: (path?: string) => Promise<void>
  /**
   * 过程折叠程度（设置 → 通用 → 过程折叠程度）：
   * - `compact` / `standard`：整轮过程折叠（紧凑档另外把定稿思考行的摘要预览收掉、
   *   组头不报实时详情）；`detailed` 只给历史轮分组；`verbose` 整轮不折、也不分组。
   * 不传按 `standard`（只读视图如队友运行记录不传这个 prop，跟着默认档走）。
   */
  processFold?: UiProcessFold
  /**
   * 定稿的思考行默认展开吗（设置 → 通用 → 定稿的思考行）。
   *
   * 跑动中的那一段不受它管——永远是展开的（ThinkingBlock 的 showPreview 有同样的规矩，
   * 理由也一样：它是「现在在干什么」的唯一线索）。不传按 false。
   */
  reasoningDefaultOpen?: boolean
  /** 工具卡默认展开吗（设置 → 通用 → 工具卡）。不传按 false。 */
  toolDefaultOpen?: boolean
  /**
   * 点轮尾卡上的「打开」：把文件放进预览页签。不传就不画「打开」（只读视图）。
   */
  onOpenFile?: (path: string) => void
  /**
   * 点轮尾卡上的「审查」：打开右侧 diff 面板，定位到这一轮的第 index 个文件。
   * 不传 = 只读视图，审查入口整颗不画。
   */
  onReviewChanges?: (files: ChangedFileView[], index: number) => void
  /** 当前工作目录：write/edit 卡的「将做的改动」与轮尾卡把绝对路径显示成相对路径。 */
  cwd?: string
}): JSX.Element {
  const [feedback, setFeedback] = useState<Record<string, Feedback>>(loadFeedback)
  /** 正在原地编辑的那条用户消息（下标 = 在 entries 里的位置）+ 编辑框里的正文。 */
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null)
  /** 重发请求已经发出去、还在等宿主换会话：这期间按钮置灰，防止连点分叉出两份。 */
  const [sending, setSending] = useState(false)
  /**
   * 两级折叠的展开态：键 = turnFoldKey（整轮）或 stepGroupFoldKey（阶段组），见 fold-state.ts。
   *
   * 为什么要 React state 而不是只读 fold-state：fold-state 是个普通 Map，写它不会触发重渲染
   * （设计如此，见那儿的模块注释——它只为「重挂时读回初值」而生）。点开关是当场要看到变化的
   * 动作，所以这一层 state 管「立刻重画」，fold-state 管「重挂后读回来」，两边的键相同。
   * 键里带会话 id，换会话不会串味，所以这里不需要在切会话时清空。
   *
   * 为什么两级共用一份 state：两类键的形状天然不冲突（`会话:turn:N` 对 `会话:step:N:M`），
   * 而它们总被同一件事同时改——轮收尾时两层一起复位（见下面那个 effect）。拆成两份 state
   * 只会让那次复位多触发一次渲染。
   */
  const [foldOpen, setFoldOpen] = useState<Record<string, boolean>>({})
  // 每一轮的起止与时间（见 turn-timing.ts）；entries 变了才重算
  const rounds = useMemo(() => roundInfos(props.entries), [props.entries])
  // 视口（流式跟随 / 暂停 / 回到底部 / 历史分页与锚点补偿）整体收进 hook：
  // 这些状态与消息怎么渲染无关，全属「视口」自己，见 use-chat-viewport.ts。
  const viewport = useChatViewport({ entries: props.entries, sessionId: props.sessionId, roundCount: rounds.length })

  // 换会话（entries 整表换成另一条会话的内容）时把编辑框收掉：留着它，提交时
  // 那条下标指向的已经是别人会话里的消息了。落到最新一条、分页窗口回默认这两件
  // 视口的事，由 hook 在同一个 dep 的 effect 里办。
  useEffect(() => {
    setEditing(null)
  }, [props.sessionId])
  /**
   * 会话里出现过的改动文件（逐刀 + 回合聚合，同文件多刀先合并）：markdown 正文里的
   * inline code 命中其中之一就渲染成可点 chip，悬停出该文件的 diff——值是合并后的
   * 改动视图（回合聚合条目优先，与轮尾卡同款）。
   */
  const mentionPaths = useMemo(() => {
    const flat: ChangedFileView[] = []
    for (const entry of props.entries) {
      if (entry.kind === 'changes') flat.push(entry.file)
      else if (entry.kind === 'turnDiff') flat.push(...entry.files)
    }
    return new Map(mergeChangesByPath(flat).map((file) => [file.path, file]))
  }, [props.entries])
  // 视口的派生量与动作按原名解构：下面的渲染层照旧用这些名字。
  const { scroller, followPaused, firstVisibleRound, hasEarlier, earlierRef, setFollowing, pinToBottom, loadEarlier } = viewport
  // entries 下标 → 这条用户消息在会话里是第几条（0 起算）。口径与宿主的
  // readUserMessages / forkSession 一致：只数用户消息，从 0 开始。
  const userOrdinalAt = useMemo(() => {
    const map = new Map<number, number>()
    let seen = 0
    props.entries.forEach((entry, index) => {
      if (entry.kind !== 'user') return
      map.set(index, seen)
      seen += 1
    })
    return map
  }, [props.entries])
  /**
   * entries 下标 → 这条条目是第几条「内容条目」（system 提示不算）。
   *
   * 这个序号给折叠条的存档键用，而不是直接拿 `entry.id`：宿主启动时是把历史
   * **追加**在几条插件提示后面的（id 从 5、6 开始），而点开历史会话是 `clear()` 之后
   * 从 1 重新发号——同一条工具卡在两次重放里 id 不一样，用 id 当键的话第一次点开的
   * 展开态切一次会话就丢了。内容条目的先后次序两条路径完全一致，用它才稳。
   */
  const contentOrdinalAt = useMemo(() => {
    const map = new Map<number, number>()
    let seen = 0
    props.entries.forEach((entry, index) => {
      if (entry.kind === 'system') return
      map.set(index, seen)
      seen += 1
    })
    return map
  }, [props.entries])
  // entries 下标 → 它属于哪一轮。开场那条 system 提示不在任何一轮里，所以查不到。
  const roundAt = useMemo(() => {
    const map = new Map<number, RoundInfo>()
    for (const round of rounds) {
      for (let index = round.startIndex; index <= round.endIndex; index += 1) map.set(index, round)
    }
    return map
  }, [rounds])
  /** 这一轮还在跑（回合没结束）：跑动中的轮永远展开，永不提供折叠。 */
  const live = props.turnState !== 'idle'
  /** 最后一轮的下标；跑动判定只看它（历史轮次全是定稿轮）。 */
  const lastRoundIndex = rounds.length - 1
  /**
   * 这一档开哪几项能力（见 appearance.ts 的 PROCESS_FOLD_POLICIES）。
   *
   * 为什么渲染层读能力而不是比档位字符串：dsh 那篇 presentation-policy.ts 的头注就是这么定的
   * ——「渲染层各自取一个字段，没有一个去比档位枚举，所以加一个档只改那张表」。
   * 表里的对象是常量，所以这个引用在档位不变时是稳定的（不会让下游 memo 白算）。
   */
  const policy = processFoldPolicy(props.processFold)
  /** 整轮折叠：定稿轮把过程收成一行「用时 X」。详细档照折，只有 `verbose` 关掉。 */
  const foldTurns = policy.foldTurns
  /** 定稿思考行的摘要预览：紧凑档关掉；跑动中的摘要不受它管（见 ThinkingBlock）。 */
  const showReasoningPreview = policy.reasoningPreview
  /**
   * 每轮的过程区（下标 = round.index）：哪些条目归总开关管、开关画在哪、这一轮跑不跑。
   * 预算器的完整规则（三类条目不进组、跑动的三种形态）见 chat/round-fold.ts 的
   * buildRoundFolds——口径只留在那一处。
   */
  const roundFold = useMemo(
    () => buildRoundFolds(props.entries, rounds, { foldTurns, live, lastRoundIndex }),
    [props.entries, rounds, foldTurns, live, lastRoundIndex],
  )
  /**
   * 阶段分组（见 process-groups.ts）：把每一轮的过程条目按「阶段正文」切成若干组。
   *
   * 「这一轮还在跑吗」直接问 roundFold——它的 running 已经把三种形态算全了（出现直播尾、
   * 最后一轮且回合没结束、用户刚发完消息助手还没回）。口径只留一处，免得分组器自己再算一遍
   * 算出另一个答案。
   *
   * 三档分组模式（policy.stepGrouping）：
   * - `none`（完全展开档）整个不分：那一档的语义是「过程条目逐条摊开」，而组头本身就是把
   *   条目收起来的东西——外层既然撤了，内层不能自己冒出来把内容又收一遍；
   * - `collapsed`（紧凑 / 标准）每一轮都给组头；
   * - `history`（详细档）只给已定稿的轮：正在跑的那一轮直接摊开
   *   （对照 dsh 的 `policy.stepGrouping === 'history' && turnLocation.status !== 'open'`，
   *   ChatGroupSeat.tsx:143-144）。
   */
  const stepGrouping = useMemo(
    () => (policy.stepGrouping === 'none'
      ? EMPTY_STEP_GROUPING
      : groupSteps(
          props.entries,
          rounds,
          (roundIndex) => roundFold.get(roundIndex)?.running ?? false,
          policy.stepGrouping === 'history',
        )),
    [props.entries, rounds, roundFold, policy],
  )
  /**
   * 每轮的最终回答（下标 = round.index）：这一轮最后一条定稿 text。
   *
   * 页脚的复制按钮抄的就是它（改版前复制按钮挂在每条助手消息上，现在按轮收进页脚）；
   * 一轮以工具结果收尾、没有最终正文时这一轮就没有可复制的东西，复制按钮整颗不画。
   */
  const roundAnswer = useMemo(() => {
    const out = new Map<number, { id: number; text: string }>()
    props.entries.forEach((entry, index) => {
      if (entry.kind !== 'text' || entry.id < 0) return
      const round = roundAt.get(index)
      if (round === undefined) return
      // 按顺序覆盖，循环结束时留下的就是这一轮最后一条定稿正文
      out.set(round.index, { id: entry.id, text: entry.text })
    })
    return out
  }, [props.entries, roundAt])
  /**
   * 每轮的真实用量（下标 = round.index）：宿主上报的整轮累计（见 contract.ts 的 TranscriptEntry）。
   *
   * 为什么是「最后一条带 usage 的条目」：同一轮里靠前的条目挂的是「到那一刻为止」的累计
   * （多步工具轮每次请求都重发整份上下文），只有轮内最后一条才是整轮真值。按顺序覆盖正好
   * 留下最后一条。一次都没上报过的老会话这里全是 null，页脚回落按正文字数估算。
   */
  const roundUsage = useMemo(() => {
    const out = new Array<{ inputTokens: number; outputTokens: number } | null>(rounds.length).fill(null)
    props.entries.forEach((entry, index) => {
      if (entry.kind !== 'text' && entry.kind !== 'tool') return
      const usage = entry.usage
      if (usage === undefined) return
      const round = roundAt.get(index)
      if (round === undefined) return
      out[round.index] = usage
    })
    return out
  }, [props.entries, roundAt, rounds])
  /** 还在跑的那些轮（序号）：只认可折叠的轮——不可折的轮没有存档键，复位也无从谈起。 */
  const runningRounds = useMemo(() => {
    const indexes = new Set<number>()
    for (const fold of roundFold.values()) {
      if (fold.foldable && fold.hasContent && fold.running) indexes.add(fold.roundIndex)
    }
    return indexes
  }, [roundFold])
  /** 上一轮渲染还在跑的轮：用来发现「跑动 → 定稿」这一次跳变。 */
  const previousRunningRounds = useRef<Set<number>>(new Set())
  /**
   * 轮收尾（跑动 → 定稿）时把这一轮的两级折叠一起复位成默认收起：整轮总开关 + 轮内每个阶段组。
   *
   * 为什么要这一步：跑动中那一轮是展开的（整轮连总开关都不画），一旦收尾（回答落定、回合
   * 结束），它就该按「定稿轮默认收起」的规矩长回去——否则刚写完的那一轮会一直摊着，用户每发
   * 一条消息都要看一整轮过程。组也要一起复位：直播途中用户可能点开过某一组看细节，那是「看一
   * 眼现在在干什么」，不该把这个选择带进定稿后的扫读视图。
   * 口径对照 dsh 的 enclosing-Turn reset（ChatNodeSeat.tsx:111-122 把隐藏成员那次
   * disclosureReset 递增，让轮内折叠条下次展开时回到默认态；conversation-nodes/README.zh.md:104
   * 也说「收起整轮会重置内部组及推理、工具的开合」）。
   */
  useEffect(() => {
    const settled: string[] = []
    for (const roundIndex of previousRunningRounds.current) {
      if (runningRounds.has(roundIndex)) continue
      settled.push(turnFoldKey(props.sessionId, roundIndex))
      for (const group of stepGrouping.groups) {
        if (group.roundIndex === roundIndex) {
          settled.push(stepGroupFoldKey(props.sessionId, roundIndex, group.seq))
        }
      }
    }
    if (settled.length > 0) {
      // 存档写回默认值，React state 里那几条直接删掉（于是回落到 readFold 的默认态）
      for (const key of settled) writeFold(key, false)
      setFoldOpen((current) => {
        let next = current
        for (const key of settled) {
          if (next[key] === undefined) continue
          if (next === current) next = { ...current }
          delete next[key]
        }
        return next
      })
    }
    previousRunningRounds.current = runningRounds
  }, [runningRounds, stepGrouping, props.sessionId])
  /**
   * 这一轮的过程区现在收起来没有。
   *
   * 四道闸门，任何一道为假都保持展开（前三道逐个对照 dsh 的 `outerHidden` 条件）：
   * - 这一档允许折整轮（`verbose` 不允许）；
   * - 过程区里真有可折的内容；
   * - 这一轮已经收尾（跑动中的轮永不折叠）；
   * - 这一轮没被中断 / 没跑挂 / 轮内没插过话（dsh 的 `turnProcessAlwaysOpen`）。
   */
  const foldCollapsed = (fold: RoundFold): boolean => {
    if (!fold.foldable || !fold.hasContent || fold.running || fold.blocked) return false
    const key = turnFoldKey(props.sessionId, fold.roundIndex)
    return !(foldOpen[key] ?? readFold(key, false))
  }
  /** 点总开关：React state 管当场重画，fold-state 管重挂后读回来（键相同，见 turnFoldKey）。 */
  const toggleRoundFold = (roundIndex: number): void => {
    const key = turnFoldKey(props.sessionId, roundIndex)
    const next = !(foldOpen[key] ?? readFold(key, false))
    writeFold(key, next)
    setFoldOpen((current) => ({ ...current, [key]: next }))
  }
  /**
   * 一个阶段组现在展开没有。
   *
   * **默认一律收起**，跑动中也不例外（对照 dsh：组是 useDisclosure 的初始收起态，
   * use-disclosure.ts:12-13 里 `expandedVersion === null` 判出的就是收起；本轮是否结束不参与
   * 这一位，ChatGroupSeat.tsx:136-146 用的是状态本身而不是本轮状态）。
   *
   * 为什么不沿用 0.6.3 那种「跑动中默认展开」：那一刻「现在在干什么」由组头的实时详情承载
   * （「正在运行命令 · pnpm build」，见 StepGroupRow），与 dsh 的 standard 档观感一致——
   * 跑动中一个阶段只占一行，长程任务直播时屏幕上不会摊着几十条过程。
   * 有存档就认存档：用户手动点开的那一组不会自己弹回去。
   */
  const stepGroupExpanded = (group: StepGroup): boolean => {
    const key = stepGroupFoldKey(props.sessionId, group.roundIndex, group.seq)
    return foldOpen[key] ?? readFold(key, false)
  }
  /** 点组头：state 管当场重画，fold-state 管重挂后读回来（键相同，见 stepGroupFoldKey）。 */
  const toggleStepGroup = (group: StepGroup): void => {
    const key = stepGroupFoldKey(props.sessionId, group.roundIndex, group.seq)
    const next = !stepGroupExpanded(group)
    writeFold(key, next)
    setFoldOpen((current) => ({ ...current, [key]: next }))
  }
  /**
   * 每轮助手正文的 token 估算（下标 = round.index）：页脚里最后那一项「~N tok」。
   *
   * 为什么要按轮汇总而不是按条：页脚是每轮一个（挂在这一轮最后一条条目下面），而一轮里
   * 可能有好几段正文（写完一段去调工具、回来接着写）。先前这条数字跟在每一段正文末尾，
   * 现在归到页脚一处，把一轮里所有定稿正文加起来才是「这一轮写了多少」。
   * 直播尾（id < 0）不算：它还在长，而且页脚在自己这一轮跑动时本来就不画用量。
   */
  const roundTokens = useMemo(() => {
    const out = new Array<number>(rounds.length).fill(0)
    props.entries.forEach((entry, index) => {
      if (entry.kind !== 'text' || entry.id < 0) return
      const round = roundAt.get(index)
      if (round === undefined) return
      out[round.index] = (out[round.index] ?? 0) + estimateTextTokens(entry.text)
    })
    return out
  }, [props.entries, roundAt, rounds])

  /** 记一条本机评价（同一项再点一次 = 取消）。落盘与「只提示一次」见 chat/feedback.ts。 */
  const vote = (key: string, next: Feedback): void => {
    const merged = { ...feedback }
    if (merged[key] === next) delete merged[key]
    else merged[key] = next
    setFeedback(merged)
    recordFeedback(merged)
  }

  const activity = liveActivity(props.entries, props.turnState)
  const startedAt = turnStartedAt(props.entries)

  /** 与宿主 readUserMessages 一样的正文压法：空白折成一个空格、截前 50 字。 */
  const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 50)

  // 能不能对用户消息动手：要拿到宿主代理、当前会话路径与切换会话的回调。
  // 队友运行记录那种只读视图三样都不给，气泡上就连按钮都不画。
  const proxy = props.proxy
  const canAct = proxy !== undefined && props.onOpenSession !== undefined && props.sessionPath !== undefined && props.sessionPath !== null

  /** 折叠条的存档键（见 fold-state.ts）：会话 id + 内容条目序号，直播尾不存档。 */
  const foldKey = (entryId: number, ordinal: number | undefined): string | undefined =>
    entryId < 0 || ordinal === undefined ? undefined : `${props.sessionId ?? ''}:e${String(ordinal)}`

  /**
   * 把界面上这条用户消息对应到宿主日志里的下标（`forkSession` 的第二个参数）。
   *
   * 为什么不能只用界面数出来的序号：宿主按 jsonl 里 `{"type":"user"` 的行数，
   * 界面按折叠后的用户条目数，两边在极少数情况下（历史里有被折叠掉的重复消息）
   * 会差一条。条数对得上就直接用序号；对不上就退回按正文找，找不到就不动手——
   * 宁可报错也不能让分叉点悄悄落错地方，那会把用户没打算改的对话也复制走。
   */
  const resolveOrdinal = async (entryIndex: number, text: string): Promise<number | null> => {
    const path = props.sessionPath
    if (proxy === undefined || path === undefined || path === null) {
      toastErr('这个视图里不能分叉会话')
      return null
    }
    const points = await proxy.listUserMessages(path)
    const ordinal = userOrdinalAt.get(entryIndex)
    if (ordinal === undefined || ordinal >= points.length) {
      toastErr('这条消息和宿主的会话记录对不上，先刷新一下会话列表')
      return null
    }
    if (points.length === userOrdinalAt.size) return ordinal
    const found = points.indexOf(collapse(text))
    if (found < 0) {
      toastErr('在宿主的会话记录里找不到这条消息，分叉点定不下来')
      return null
    }
    return found
  }

  /** 每轮分叉：以这条用户消息为界复制出一份新会话，然后切过去。 */
  const forkAt = async (entryIndex: number): Promise<void> => {
    const entry = props.entries[entryIndex]
    if (entry === undefined || entry.kind !== 'user') return
    const ordinal = await resolveOrdinal(entryIndex, entry.text)
    if (ordinal === null) return
    if (ordinal === 0) {
      toastErr('第 1 条消息之前没有内容，分叉不出新会话')
      return
    }
    const path = props.sessionPath
    if (proxy === undefined || path === undefined || path === null || props.onOpenSession === undefined) return
    const result = await proxy.forkSession(path, ordinal)
    if (!result.ok) {
      toastErr(`分叉失败：${result.error}`)
      return
    }
    await proxy.refreshSessions()
    toastOk(`已分叉出新会话，包含第 ${String(ordinal + 1)} 条消息之前的内容；原会话不变`)
    await props.onOpenSession(result.path)
  }

  /** 编辑重发：分叉出新会话（含这条之前的全部内容），把改好的正文作为下一条消息发出去。 */
  const submitEdit = async (): Promise<void> => {
    if (editing === null || sending) return
    if (proxy === undefined || props.onOpenSession === undefined) return
    const openSession = props.onOpenSession
    const text = editing.text.trim()
    if (text === '') {
      toastErr('消息不能是空的')
      return
    }
    const entry = props.entries[editing.index]
    if (entry === undefined || entry.kind !== 'user') {
      setEditing(null)
      return
    }
    const ordinal = await resolveOrdinal(editing.index, entry.text)
    if (ordinal === null) return
    setSending(true)
    try {
      if (ordinal === 0) {
        // 这条之前一条消息都没有：宿主的分叉要求「分叉点之前得有内容」，
        // 等价做法是开一个新会话，把改好的正文当它的第一条消息发出去。
        await openSession(undefined)
      } else {
        const path = props.sessionPath
        if (path === undefined || path === null) return
        const result = await proxy.forkSession(path, ordinal)
        if (!result.ok) {
          toastErr(`分叉失败：${result.error}`)
          return
        }
        // 先换会话再发：晚一步就会把改好的正文追加回旧会话，等于什么都没改还多发一条
        await openSession(result.path)
      }
      await proxy.submit(text)
      // 发完再刷列表：新会话在第一条消息落盘之前不留文件，早刷一次它不会出现在侧栏
      await proxy.refreshSessions()
      setEditing(null)
      toastOk('已分叉出新会话并重发改后的内容；原会话原样保留')
    } finally {
      setSending(false)
    }
  }

  /**
   * 渲染序列：先按轮算出座位，再按 entries 的原顺序把不属于任何轮的条目插回原位
   * （计划卡单独摘出来、组体按块包住——完整规则见 chat/seat-plan.ts 的模块注释）。
   */
  const plan = useMemo(
    () => buildSeatPlan(props.entries, rounds, roundFold, stepGrouping, roundAt, firstVisibleRound),
    [props.entries, rounds, roundFold, stepGrouping, roundAt, firstVisibleRound],
  )

  /**
   * 一条条目的内容（**不含**外层 `.entry-row` 座位）。
   *
   * 为什么把内容与座位拆开：座位（`.entry-row`）要能挂 `hidden="until-found"`，
   * 而内容里那两种折叠条目（思考 / 工具卡）各自还持有自己的展开态。
   * 拆开以后，同一条内容在「独立一行」与「阶段组组体里」两个位置都能复用。
   *
   * @param index 这一条在 entries 里的下标
   */
  const renderNode = (index: number): ReactNode => {
    const entry = props.entries[index]
    if (entry === undefined) return null
    switch (entry.kind) {
      case 'user': {
        const open = editing !== null && editing.index === index
        return (
          // .user-turn 是这条用户消息的整块：气泡 + 气泡正下方的操作条。
          // 为什么要多这一层容器：编辑按钮得落在气泡盒子外面（气泡自己有底色和内距，
          // 按钮放在里面又压住正文最后一行），而它仍然要跟气泡一起右对齐、贴着气泡底边。
          <div className="user-turn">
            <div className={`entry-user${open ? ' editing' : ''}`}>
              {entry.images !== undefined && entry.images.length > 0 && (
                <div className="entry-user-images">
                  {entry.images.map((url, imageIndex) => (
                    <a key={imageIndex} href={url} target="_blank" rel="noreferrer" data-tip="点开看原图">
                      <img src={url} alt={`第 ${String(imageIndex + 1)} 张贴图`} />
                    </a>
                  ))}
                </div>
              )}
              {open && editing !== null ? (
                <div className="user-edit">
                  <textarea
                    className="user-edit-box"
                    value={editing.text}
                    autoFocus
                    rows={Math.min(10, Math.max(2, editing.text.split('\n').length))}
                    aria-label="编辑这条消息"
                    onChange={(event) => setEditing({ index, text: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setEditing(null)
                        return
                      }
                      // Enter 发送、Shift+Enter 换行（宿主里发消息也是这个习惯）
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        void submitEdit()
                      }
                    }}
                  />
                  <p className="user-edit-note">
                    重发会以此刻为界分叉出新会话（含这条之前的全部内容），原会话保留。
                    <br />
                    Enter 发送 · Shift+Enter 换行 · Esc 取消
                  </p>
                  <div className="user-edit-actions">
                    <button
                      type="button"
                      className="dsc-btn"
                      data-variant="ghost"
                      data-size="xs"
                      onClick={() => setEditing(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="dsc-btn"
                      data-variant="primary"
                      data-size="xs"
                      disabled={sending || editing.text.trim() === ''}
                      onClick={() => void submitEdit()}
                    >
                      {sending ? '正在重发…' : '重发'}
                    </button>
                  </div>
                </div>
              ) : (
                entry.text
              )}
            </div>
            {/* 编辑按钮：只在悬停/键盘聚焦这条消息时浮出（与页脚那一排动作同一套令牌），
                位置在气泡正下方、气泡之外。只读视图（队友运行记录）里 canAct 为假，这颗不渲染。
                复制 / 赞 / 踩 / 分叉都不在这里——它们跟这一轮的用量与时刻一起收进 TurnFooter
                （本轮改版），这一块只剩「改这条消息」这件专属于用户消息的事。
                图标 15px 对齐 dsh 用户那条操作条的图标（MessageIconActions.module.css:80-81），
                hit area 的 28px 在 styles.css 末尾「对话区修正批」那一段。 */}
            {!open && canAct && (
              <div className="user-actions">
                <button
                  type="button"
                  className="user-act"
                  title="编辑这条消息并重发（会分叉出新会话，原会话保留）"
                  aria-label="编辑并重发这条消息"
                  disabled={live}
                  onClick={() => setEditing({ index, text: entry.text })}
                >
                  <IconEdit size={15} />
                </button>
              </div>
            )}
          </div>
        )
      }
      case 'text':
        if (entry.id < 0) {
          // 流式直播尾：无操作条
          return (
            <div className="entry-text live">
              <div className="markdown">
                <MarkdownText text={entry.text} mentionPaths={mentionPaths} onOpenFile={props.onOpenFile} cwd={props.cwd ?? ''} />
              </div>
            </div>
          )
        }
        return (
          <div className="entry-text">
            <div className="markdown">
              <MarkdownText text={entry.text} mentionPaths={mentionPaths} onOpenFile={props.onOpenFile} cwd={props.cwd ?? ''} />
            </div>
          </div>
        )
      case 'thinking':
        // 折叠条与工具卡同一组规格（紧凑行 / 展开区 / 超 400px 的顶部吸附快捷栏），
        // 见 ThinkingBlock.tsx。流式直播尾（id<0）挂载即展开，定稿条目按用户设置的默认态来；
        // 展开与否由组件自己持有，所以直播中也能收起再展开。
        // storeKey 让展开态活过「整表重建」：换会话再切回来，用户之前展开的还开着
        // （键里带会话 id，两条会话的条目 id 都从 1 开始也不会串味）。
        // 直播尾（id<0）不给键：它每一段都是新的，默认展开就是它该有的样子。
        // showPreview：紧凑档把定稿行的摘要预览收掉（跑动中照显，见 ThinkingBlock）。
        return (
          <ThinkingBlock
            text={entry.text}
            live={entry.id < 0}
            storeKey={foldKey(entry.id, contentOrdinalAt.get(index))}
            showPreview={showReasoningPreview}
            // 定稿思考行的默认态（设置 → 通用 → 定稿的思考行）；直播尾那条永远展开，
            // ThinkingBlock 内部自己判（见那里的 defaultOpen 注释）。
            defaultOpen={props.reasoningDefaultOpen === true}
          />
        )
      case 'tool':
        return (
          <ToolCard
            call={entry.call}
            storeKey={foldKey(entry.id, contentOrdinalAt.get(index))}
            // 工具卡的默认态（设置 → 通用 → 工具卡）
            defaultOpen={props.toolDefaultOpen === true}
            // write/edit 进行中推演「将做的改动」：折叠行的相对路径 + 展开体的 diff
            cwd={props.cwd ?? ''}
            proxy={props.proxy}
          />
        )
      case 'plan':
        // 历史里的计划卡：批没批一眼可见，批按钮只在待批状态出现
        return <PlanReview plan={entry.plan} onAnswer={() => undefined} />
      case 'system':
        // 开场那条「会话 x · 模型 y」不画：状态栏第一段已经带着同样的信息，
        // 再在流末尾留一行居中灰字纯属重复（见 session-marker.ts）。
        return isSessionMarker(entry.text) ? null : <div className="entry-system">{entry.text}</div>
      case 'turn-end':
        // 轮尾标记：它只是给整轮折叠读的一条元数据（只有中断 / 失败才落），自己不上屏。
        // 「这一轮收成什么样」由总开关那一行说（「已停止」/「过程失败」），
        // 跑挂的正文另有一条 system 行，再补一条提示就是重复。
        return null
      case 'turn-max-tokens':
        // 输出撞上长度上限：这一条必须上屏。用户看到的是一段戛然而止的回复，
        // 不给一行说明，只会以为模型答到一半就不说了（对照 dsh 的 turn-max-tokens 节点）。
        return (
          <div className="entry-system" data-turn-notice="max-tokens">
            这一轮的输出达到长度上限，已被截断
          </div>
        )
      case 'model-retry':
        // 模型重试：重试发生在 llm 层内部，不报出来的话用户只会觉得界面莫名卡了几秒。
        // 它可以被整轮折叠一起收起（照 dsh：「二级分组把模型重试视为分隔节点，
        // 但整轮折叠仍包含重试行」），所以它不在 TURN_PROCESS_INDEPENDENT 里。
        return (
          <div className="entry-system" data-turn-notice="model-retry">
            {`模型请求失败，正在重试（第 ${String(entry.attempt)} 次）：${entry.text}`}
          </div>
        )
      case 'changes':
      case 'turnDiff':
        // 文件改动条目（逐刀 / 回合聚合）不在这里单独上屏：轮尾一张聚合卡代它们出场
        // （见 renderSeat 的 seat.turnDiff / seat.changes）。
        return null
      default:
        return null
    }
  }

  /**
   * 一条条目的座位。
   *
   * 收起的整轮里，过程条目**不再卸载**（0.6.3 是 `return null`），而是挂 `hidden="until-found"`：
   * 浏览器 Ctrl+F 因此能命中收起来的内容，键盘焦点也不会被抽走（见 fold-seats.tsx 的
   * useSearchableHidden）。代价是那一整轮的组件实例都留着——这正是当年选 `return null` 想省的，
   * 属于一次明确的取舍反转。
   *
   * index 必须带会话 id（这是 fold-state 那条「展开态切回来就丢」的根因）：宿主的条目 id 是
   * `clear()` 之后从 1 重新发号的，两条**形状相同**的会话因此给出同一个 id 序列，React 按 key
   * 对账时会把上一条会话的组件实例直接复用给下一条——实例复用意味着 ThinkingBlock / ToolCard
   * 的 useState 初值函数（readFold）根本不会再跑一次，用户切回来时看到的是「在另一条会话里
   * 顺手改成的那个状态」，fold-state.ts 里存着的展开态被绕过、等于没存；换会话必然重挂以后，
   * readFold 必然执行。
   *
   * 已知代价（接受）：靠「加载更早历史」把更早的条目插到前面时，内容条目序号
   * （contentOrdinalAt）会整体后移，已经展开的那一条的存档键跟着换号 → 新键落空、退回默认
   * 折叠态；改之前那是靠实例复用「碰巧」保住的。这里选跨会话保持展开这个主场景：
   * 它每天都在发生，而往前插历史是低频动作，重挂后重展开一次可以接受。
   */
  const seatRow = (index: number, hidden: boolean, onReveal: () => void): ReactNode => {
    const entry = props.entries[index]
    if (entry === undefined) return null
    const node = renderNode(index)
    // 内容为空、又不需要站位的条目（轮尾标记、开场那条会话标记）不产出盒子：
    // `.turn-seat` 的 gap 是给条目之间留的，一个空盒子会白占出一段空白。
    if (node === null) return null
    return (
      <RowSeat
        key={`${props.sessionId ?? ''}:${String(entry.id)}`}
        hidden={hidden}
        onReveal={onReveal}
        roundIndex={roundAt.get(index)?.index}
      >
        {node}
      </RowSeat>
    )
  }

  /**
   * 一轮的座位：用户消息 → 整轮总开关 → 过程区 → 过程区之后那几条 → 页脚。
   *
   * 为什么不沿用「逐条 map」：阶段组的组体需要有真正的盒子才能挂限高、方向渐隐与自己的滚动，
   * 而组员在 entries 里是连续的一段——只有按「块」产出才包得住它们。
   */
  const renderSeat = (seat: RoundSeatPlan): ReactNode => {
    /** 这一轮还在跑（只有最后一轮会跑）：页脚此时照片面挂，用量整轮结束才算得准。 */
    const running = live && seat.round.index === lastRoundIndex
    /** 整轮收起来了没有：收起时过程区那几条挂 hidden，但它们仍在 DOM 里（Ctrl+F 能命中）。 */
    const collapsed = seat.fold !== undefined && foldCollapsed(seat.fold)
    const reveal = (): void => {
      toggleRoundFold(seat.round.index)
    }
    // 页脚上的复制与评价都按「这一轮的最终回答」算：
    // - 复制抄最终 text 条目的原文（改版前挂在每条助手消息上的口径不变）；
    // - 评价还是按「会话:条目」存（键用最终回答那条的 id），改版前点过的赞不会丢。
    const answer = roundAnswer.get(seat.round.index)
    const feedbackKey = answer === undefined ? undefined : `${props.sessionId ?? ''}:${String(answer.id)}`
    return (
      <div className="turn-seat" key={`turn-${String(seat.round.index)}`} data-round-seat={seat.round.index}>
        {seatRow(seat.lead, false, reveal)}
        {/* 总开关行站在过程区最前面：收起时它是这一轮过程区唯一看得见的东西，
            展开时它下面接着就是原样的过程条目（对照 dsh TurnProcessNodeView 的位置）。
            跑动中的轮**不画这一行**：dsh 那边 turn-process 节点只有轮次收尾（status === 'closed'）
            才会渲染（TurnProcessNodeView.tsx:18），整轮展开、压根不给折叠入口——
            这样就不会出现「看着能点、点了没反应」的一行。 */}
        {seat.withFoldRow && seat.fold !== undefined && !seat.fold.running && (
          <TurnFoldRow
            open={!collapsed}
            round={seat.round}
            // 不可折的两种情况：这一轮压根没有过程内容，或者它被中断 / 跑挂 / 轮内插过话。
            // 照 dsh 的做法这一行照样画出来，只是点不动——用户得看得见「这一轮收成什么样」。
            disabled={!seat.fold.hasContent || seat.fold.blocked}
            endReason={seat.fold.endReason}
            onToggle={reveal}
          />
        )}
        {/* 过程区：阶段组与中间那些独立的过程条目。
            组头只在整轮展开时才看得见——整轮收起时这一轮只剩总开关一行，组头跟着过程内容一起收
            （对照 dsh 的 conversation-nodes/README.zh.md:56「整轮收起时，G1、阶段回复和 G2 一起隐藏」）。
            那件事由 StepGroupSeat 的 turnCollapsed 办，所以这里不再单独判 turnExpanded。 */}
        {seat.process.map((block) => (block.kind === 'group' ? (
          <StepGroupSeat
            key={`step-${String(block.group.roundIndex)}-${String(block.group.seq)}`}
            group={block.group}
            turnCollapsed={collapsed}
            open={stepGroupExpanded(block.group)}
            showDetail={policy.liveDetail}
            onToggle={() => toggleStepGroup(block.group)}
            onRevealTurn={reveal}
          >
            {block.members.map((member) => seatRow(member, false, reveal))}
          </StepGroupSeat>
        ) : (
          seatRow(block.index, collapsed, reveal)
        )))}
        {/* 过程区之后那几条（最终回答、计划卡）：永远可见，不参与整轮折叠 */}
        {seat.after.map((block) => (block.kind === 'row' ? seatRow(block.index, false, reveal) : null))}
        {/* 轮尾「文件已更改」卡（dsh 的 turn-tail 位置）：聚合这一轮成功落盘的实际改动，
            不参与整轮折叠。有回合聚合条目（turnDiff）优先用——同文件多刀一份准确差异；
            没有（轮中途 / 老日志重放）就回退逐刀合并。只读视图不传回调，卡退化成纯展示。 */}
        {(() => {
          const changed = seat.turnDiff ?? mergeChangesByPath(seat.changes)
          if (changed.length === 0) return null
          return (
            <ChangedFilesCard
              files={changed}
              cwd={props.cwd ?? ''}
              onReview={
                props.onReviewChanges === undefined
                  ? undefined
                  : (index) => props.onReviewChanges?.(changed, index)
              }
              onOpen={props.onOpenFile}
            />
          )
        })()}
        {seat.withFoot && (
          <TurnFooter
            round={seat.round}
            running={running}
            // 用量两个口径一起给：有宿主上报的真值就用真值（不带 ~），
            // 老会话回落这一轮正文的估算（带 ~）。取舍在 TurnFooter 里说明。
            usage={roundUsage[seat.round.index] ?? null}
            tokens={roundTokens[seat.round.index] ?? null}
            // 复制的就是这一轮最终回答的原文；一轮以工具结果收尾时没有可复制的正文
            copyText={answer?.text}
            voteState={feedbackKey === undefined ? undefined : feedback[feedbackKey]}
            onVote={
              feedbackKey === undefined
                ? undefined
                : (next) => vote(feedbackKey, next)
            }
            // 只读视图（队友运行记录）不传 proxy/sessionPath，canAct 为假，这里整颗按钮不画
            onFork={canAct ? forkAt : undefined}
            // 一轮正在跑时不给分叉（换会话会把这一轮打断），第 1 条之前没有内容也分不出来
            forkDisabled={live || seat.round.index === 0}
            forkTitle={
              seat.round.index === 0
                ? '这条消息之前没有内容，分叉不出新会话'
                : '以这条消息为界分叉出新会话'
            }
          />
        )}
      </div>
    )
  }

  return (
    <div className="chat-wrap">
      <div className="chat" ref={scroller}>
        <div className="chat-inner">
          {/* 「加载更早」：上面还有没画出来的轮时才有这一行。
              它在 DOM 里的位置很要紧——分页锚点就是按正文顺序从它后面找的第一个有高度的
              兄弟节点（见 loadEarlier），所以它必须是内容区最前面那一个。 */}
          {hasEarlier && (
            <button
              type="button"
              className="chat-earlier"
              ref={earlierRef}
              data-earlier-rounds={firstVisibleRound}
              data-tip="把更早的几轮画出来，你现在看的位置不会动"
              onClick={loadEarlier}
            >
              {`加载更早的 ${String(Math.min(PAGE_ROUNDS, firstVisibleRound))} 轮（上面还有 ${String(firstVisibleRound)} 轮）`}
            </button>
          )}
          {/* 按「座位」产出：不属于任何轮的条目（开场提示、轮间通知）单独一行，
              其余每轮一个座位（用户消息 → 总开关 → 过程区 → 最终回答 → 页脚）。 */}
          {plan.map((item) => (item.kind === 'loose' ? seatRow(item.index, false, NO_REVEAL) : renderSeat(item.seat)))}
          {/* 回合进行中：流末尾的状态行（阶段 + 活动名 + 实时用时 + 动画省略号） */}
          {live && activity !== null && (
            <TurnStatusLine stage={activity.stage} activity={activity.activity} startedAt={startedAt} />
          )}
        </div>
      </div>
      {/* 右缘的回合刻度条（对照 dsh 的快速跳转） */}
      <JumpStrip scrollerRef={scroller} entries={props.entries} />
      {/* 暂停跟随时的回头路：用户往上翻历史以后，新内容不再把他拽回底部，
          所以得给一颗「回到底部」的按钮。只在这一刻出现（跟随中不画，免得白占地方），
          点一下恢复跟随并把视角送回最新一条。 */}
      {followPaused && (
        <button
          type="button"
          className="chat-to-bottom"
          title="回到最新一条（自动跟随会重新打开）"
          onClick={() => {
            setFollowing(true)
            pinToBottom()
          }}
        >
          回到底部
        </button>
      )}
    </div>
  )
}
