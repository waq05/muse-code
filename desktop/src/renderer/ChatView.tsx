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
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { StatusView, TranscriptEntry, TurnEndReason, UiProcessFold } from '@dsc/runtime/contract.js'
import type { RuntimeProxy } from './bridge.js'
import { processFoldPolicy } from './fold-policy.js'
import { AT_BOTTOM_EPS, JumpStrip } from './JumpStrip.js'
import { PlanReview } from './TaskDock.js'
import { RowSeat, StepGroupSeat } from './fold-seats.js'
import { ThinkingBlock } from './ThinkingBlock.js'
import { ToolCard } from './ToolCard.js'
import { TurnFooter } from './TurnFooter.js'
import { TurnStatusLine } from './TurnStatusLine.js'
import { isSessionMarker } from './session-marker.js'
import { TURN_PROCESS_INDEPENDENT, groupSteps, type StepGroup, type StepGrouping } from './process-groups.js'
import { readFold, stepGroupFoldKey, turnFoldKey, writeFold } from './fold-state.js'
import { formatDuration, liveActivity, roundDuration, roundInfos, turnStartedAt, type RoundInfo } from './turn-timing.js'
import { toastErr, toastOk } from './components/toast.js'
import { IconChevronDown, IconEdit } from './icons.js'
import { estimateTextTokens } from './token-estimate.js'

/**
 * 「用户真的离开底部了」的门槛（px）：比贴底判定 AT_BOTTOM_EPS（32px）宽一档。
 *
 * 为什么是 120：一格滚轮约走 100px。用户贴在底部时轻推一格，scrollTop 立刻退到底以上
 * 约 100px，按 32px 判的话「回到底部」按钮马上弹出来——可他只是想把最后几行往上挪一点
 * 看清楚，人没打算走。门槛放到 120px 以后，单格上滑（约 100px）落在 120px 以内，算
 * 「还在原地」；两格以上（约 200px）才认「这是要去看历史了」。
 *
 * 暂停用这一档、恢复仍用 AT_BOTTOM_EPS（32px），两档之间（32~120px）是滞回区间：
 * 用户停在这一带时既不恢复也不暂停，省得在阈值附近来回抖着把按钮弹进弹出。
 */
const PAUSE_EPS = 120

/**
 * 一页画多少轮（更早的轮先不进 DOM，点「加载更早」再放出来）。
 *
 * 为什么是渲染量而不是数据量：dsc 的会话是一次性全量读进内存的（`Session.load` 读整个
 * jsonl），而且那份 `messages` 同时是模型请求上下文——给展示分页并不会少加载任何东西
 * （实测：最大的真实会话 1 MB / 25 条消息，`load` 4.9ms、堆增量 3.3 MB）。
 * 所以这一层分的是**对话流的 DOM 数量**，那才是长会话真的会拖慢的地方。
 *
 * 为什么是 8：常见窗口一屏半到两屏，首屏要挂的过程 DOM 从「几十轮」降到「八轮」。
 */
const PAGE_ROUNDS = 8

/** 一条回复的本机评价：只有赞 / 踩两态，再点一次取消。 */
type Feedback = 'up' | 'down'

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

/** 一条渲染块：一个独立过程条目，或者一个阶段组（组头 + 组体里的那几条）。 */
type ChatBlock = { kind: 'row'; index: number } | { kind: 'group'; group: StepGroup; members: number[] }

/**
 * 一轮的座位：用户消息 → 整轮总开关 → 过程区 → 过程区之后 → 页脚。
 *
 * 为什么要先算出这张表再渲染，而不是边遍历边判：阶段组的组体要包住「连续的那几条」，
 * 于是渲染必须按块产出；而哪些条目成组、页脚画在哪一条之后，都要先看完整轮才知道。
 */
interface RoundSeatPlan {
  round: RoundInfo
  /** 这一轮的过程折叠情况；没有过程内容时是 undefined。 */
  fold: RoundFold | undefined
  /** 用户消息在 entries 里的下标（永远可见，不参与任何折叠）。 */
  lead: number
  /** 整轮总开关画在过程区最前面吗（只有可折的定稿轮为真）。 */
  withFoldRow: boolean
  /** 过程区：整轮收起时整条挂 hidden（但仍在 DOM 里，Ctrl+F 能命中）。 */
  process: ChatBlock[]
  /** 过程区之后那几条（最终回答、计划卡）：永远可见。 */
  after: ChatBlock[]
  /** 页脚画在这一轮末尾吗（还没回复的轮次不画）。 */
  withFoot: boolean
}

/** 渲染序列里的一项：不属于任何轮的条目，或者一整轮的座位。 */
type ChatPlanItem = { kind: 'loose'; index: number } | { kind: 'seat'; seat: RoundSeatPlan }

/** 本机评价的存档键（localStorage）。 */
const FEEDBACK_KEY = 'dsc.messageFeedback'

/**
 * 读本机评价存档。为什么存在浏览器本地而不是发给宿主：宿主协议里没有
 * 「用户对某条回复的评价」这一项，界面能做的只有如实记在自己这台机器上。
 * 存档坏了就当没点过——不能因为一段历史记录把消息流卡住。
 */
function loadFeedback(): Record<string, Feedback> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(FEEDBACK_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, Feedback> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'up' || value === 'down') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 本机评价只说明一次（第一次点的时候），免得每点一次都弹一条提示。 */
let toldFeedbackOnce = false

/**
 * 一轮过程区的折叠情况（下标 = round.index 存进 Map）。
 *
 * 为什么单独算一份：哪些条目归总开关管、开关画在哪一行、这一轮能不能折，是三件互相牵连的事，
 * 分散在 map 回调里每次渲染重算一遍既慢又容易前后不一致（比如开关画了、组内却没有条目）。
 */
interface RoundFold {
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
 * 整轮过程折叠的总开关行（对照 dsh 的 TurnProcessNodeView.tsx:36-53）：
 * 一行左对齐的小字按钮，「用时 X」（算不出用时就是「已完成」，绝不显示 NaN）+ 行尾箭头，整行可点。
 *
 * 只给定稿轮画（跑动中的轮不渲染这一行，见下面 seat 里那处条件）：dsh 的 turn-process 节点
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
function TurnFoldRow(props: {
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
}): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)
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
  /**
   * 还在不在「跟随最新内容」（流式输出时自动贴底）。
   *
   * 为什么要有这一位：改版前每来一块新内容就把 scrollTop 钉到底，用户想往上翻历史，
   * 刚滚上去就被下一块拽回来，长回答里根本翻不动。现在的规矩是——
   * 用户主动往上翻（滚轮向上 / 触摸拖动 / 拖滚动条，落到 scrollTop 离开底部这一件事上）
   * 就暂停跟随——「离开」按 PAUSE_EPS（120px）判，滚回距底 AT_BOTTOM_EPS（32px，与
   * JumpStrip 贴底判定同一档）以内、或点「回到底部」就恢复。两档之差是滞回区间（见 PAUSE_EPS）。
   *
   * 用 ref 存而不是 state：这个判断挂在滚动事件与每次渲染上，走 state 会为了一个
   * 只在切换瞬间才变的值多渲染一轮；配套的 state 只用来画那颗「回到底部」按钮。
   * 只认「用户主动」这一路：内容自己变高（图片解码、代码块展开、流式追加）不发
   * scroll 事件，程序性的高度变化因此不会被误判成「用户滚离」。
   */
  const followRef = useRef(true)
  /** 暂停跟随时显示的「回到底部」按钮。 */
  const [followPaused, setFollowPaused] = useState(false)
  /**
   * 「这一次必须落到最新一条」：换会话、自己刚发出一条用户消息。
   * 这两个场景是用户主动产生的，不该被上一轮的暂停态挡住（改版前靠无条件贴底实现）。
   */
  const forceFollowRef = useRef(true)
  /**
   * 我们自己钉底时落到的那个 scrollTop。
   *
   * 为什么要记这一笔：`scrollTop = scrollHeight` 是程序性滚动，但它同样会（异步）发一个
   * scroll 事件；而滚动事件是下一帧才投递的，这中间流式内容可能又长高了一截，只按
   * 「离底还有多远」判的话，自动跟随会把**自己钉的那一下**判成「用户滚离」，
   * 于是长回答写着写着就自己停了跟随。拿位置和这一笔对上，就能把两者分开。
   */
  const autoTopRef = useRef(-1)
  /**
   * 用户已经放出的**最早轮号**（null = 还没点过「加载更早」，只画最近一页）。
   *
   * 为什么记轮号而不是「放出了几页」：会话一直在长，按页数记的话每来一条新消息，
   * 窗口就整体后移一轮，最上面那一轮会被悄悄收走——用户正看着它。记绝对轮号，
   * 新消息只影响末端（最近一页跟着走），前面放出来的那些原地不动。
   */
  const [earliestVisible, setEarliestVisible] = useState<number | null>(null)
  /** 点「加载更早」时记下的锚点：新内容插到上方之后，把它拉回原来的视口位置。 */
  const earlierAnchorRef = useRef<{ node: HTMLElement; viewportTop: number } | null>(null)
  /** 「加载更早」那颗按钮（锚点按正文顺序从它后面找，不按视口位置挑）。 */
  const earlierRef = useRef<HTMLButtonElement | null>(null)

  /** 改跟随态：ref 与按钮用的 state 一起动，值没变就不惊动 React。 */
  const setFollowing = (next: boolean): void => {
    if (followRef.current === next) return
    followRef.current = next
    setFollowPaused(!next)
  }

  /**
   * 把视角钉到最新一条，并把落点记进 autoTopRef（见那里的注释）。
   * 自动跟随的每一次贴底、以及「回到底部」那颗按钮，都走这一处。
   */
  const pinToBottom = (): void => {
    const element = scroller.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
    autoTopRef.current = element.scrollTop
  }

  /**
   * 放出一页更早的轮。
   *
   * 锚定规则照 dsh 的 conversation-nodes/README.zh.md:98：「按正文顺序锚定按钮下的第一个
   * 可见内容项，不根据它在视口中的位置选择」——所以从按钮往后找第一个有高度的兄弟节点，
   * 记下它此刻的视口位置，DOM 更新后由下面那个 layout effect 把它拉回原处。
   */
  const loadEarlier = (): void => {
    const button = earlierRef.current
    if (button === null) return
    let node = button.nextElementSibling as HTMLElement | null
    while (node !== null && node.getBoundingClientRect().height === 0) {
      node = node.nextElementSibling as HTMLElement | null
    }
    earlierAnchorRef.current = node === null
      ? null
      : { node, viewportTop: node.getBoundingClientRect().top }
    setEarliestVisible(Math.max(0, firstVisibleRound - PAGE_ROUNDS))
  }

  /**
   * 把锚点拉回原来的视口位置。
   *
   * 更早的内容插在上面会把锚点整套往下推，不补偿的话点「加载更早」像把页面弹走
   * （dsh 的规矩：「分页把更早内容加到保留的锚点上方，不主动跳到新内容顶部」）。
   *
   * 限高组先在自己的滚动范围内吸收位移，吸不下的才交给外层（同一条规矩的后半句）：
   * 锚点若落在某个阶段组体里，先把那个组体往上滚，剩下的再动 transcript——
   * 这样「组内滚到一半时被分页推走」也会被正确抵消。
   */
  useLayoutEffect(() => {
    const anchor = earlierAnchorRef.current
    if (anchor === null) return
    earlierAnchorRef.current = null
    let delta = anchor.node.getBoundingClientRect().top - anchor.viewportTop
    if (delta === 0) return
    const body = anchor.node.closest('.step-body')
    if (body !== null) {
      const before = body.scrollTop
      body.scrollTop = before + delta
      // 吸掉多少按实际滚动量算：组体滚不动时（内容不够高）这部分原样留给外层
      delta -= body.scrollTop - before
      if (delta === 0) return
    }
    const element = scroller.current
    if (element === null) return
    element.scrollTop += delta
    autoTopRef.current = element.scrollTop
  }, [earliestVisible])

  // 换会话（entries 整表换成另一条会话的内容）时把编辑框收掉：留着它，提交时
  // 那条下标指向的已经是别人会话里的消息了。同一件事还捎带一条：换会话必须落到
  // 最新一条（用户刚点开一条会话，看到的是它的末尾，不是上次停留的滚动位置）。
  useEffect(() => {
    setEditing(null)
    forceFollowRef.current = true
    setFollowing(true)
    // 分页窗口也跟着回默认：换了一条会话，「已放出到第几轮」是上一条会话的事
    setEarliestVisible(null)
  }, [props.sessionId])

  /**
   * 流式自动跟随：entries 变了就把尾巴贴到底——前提是「还在跟随」。
   * 两个例外无条件跟随：刚换会话（forceFollowRef），以及末尾新出现的一条用户消息
   * （自己刚发出去的，要立刻看到它和它的回复）。
   * 注意这里不改 followRef 之外的任何东西：暂停期间内容照旧长高，只是不替用户决定视角。
   */
  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    const tail = props.entries[props.entries.length - 1]
    const tailIsUser = tail !== undefined && tail.kind === 'user' && tail.id >= 0
    if (forceFollowRef.current || tailIsUser) {
      forceFollowRef.current = false
      setFollowing(true)
    }
    if (followRef.current) pinToBottom()
  }, [props.entries])

  /**
   * 滚动 = 用户对视角的表态：离开底部就暂停跟随，回到 32px 以内就恢复。
   *
   * 滚轮、触摸拖动、拖滚动条三条路最后都落成同一个事实——scrollTop 离开底部，
   * 所以判定只写在 scroll 这一处，不各挂一份。滚轮向上额外抢一帧：滚动事件是异步
   * 投递的，而流式内容可能先到一步（它一到就会贴底），只等 scroll 事件会有一次回弹。
   * 触摸按「手指往下拖（clientY 变大）」认往回翻，与滚动方向一致。
   *
   * 两个门槛分工（见 PAUSE_EPS）：暂停用宽的 120px，恢复用窄的 AT_BOTTOM_EPS（32px），
   * 中间 32~120px 是滞回区间，停在这一带两边都不动，按钮不会反复弹进弹出。
   * 唯一要排除的是「自己钉的那一下」：落点与 autoTopRef 重合就不算用户滚离。
   */
  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    /**
     * 现算可滚距离。为什么是函数而不是一个变量：流式内容一直在长，算一次存下来，
     * 下一帧就不作数了。返回值 <= 0 表示这一屏根本装得下，那就不存在「离开底部」。
     */
    const maxScroll = (): number => element.scrollHeight - element.clientHeight
    const onScroll = (): void => {
      if (Math.abs(element.scrollTop - autoTopRef.current) <= 1) return
      const limit = maxScroll()
      // 装得下：任何路径都不暂停，跟随照旧（也顺带把按钮收掉）
      if (limit <= 0) {
        setFollowing(true)
        return
      }
      const away = limit - element.scrollTop
      // 回到贴底档（32px）以内：恢复跟随。恢复门槛刻意比暂停门槛窄
      if (away <= AT_BOTTOM_EPS) {
        setFollowing(true)
        return
      }
      // 越过宽门槛才算「用户真的要走」；落在滞回区间里维持现状，什么都不做
      if (away > PAUSE_EPS) setFollowing(false)
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY >= 0) return
      const limit = maxScroll()
      // 一屏装得下就没有「离开底部」可言（没有滚动条时滚轮本来也滚不动）
      if (limit <= 0) return
      // 预估这一格滚完的落点离底还有多远：当前位置离底是 limit - scrollTop，
      // 再减掉这一格的行程——deltaY 向上为负，所以「- deltaY」是正的，落点更靠上、离底更远。
      //
      // 为什么要预估而不是等 scroll 事件：滚动事件下一帧才投递，流式内容可能先到一步
      // 把视角又拽回底部；抢在内容前头暂停，能省掉那一下回弹。预估落点要是还没越过宽门槛
      // （贴底时单格上滑就是这样）就什么都不做，交给随后的 scroll 事件按同一把尺子判。
      const landingAway = limit - element.scrollTop - event.deltaY
      if (landingAway > PAUSE_EPS) setFollowing(false)
    }
    let touchY = 0
    const onTouchStart = (event: TouchEvent): void => {
      touchY = event.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (event: TouchEvent): void => {
      const y = event.touches[0]?.clientY ?? touchY
      if (y > touchY + 2) {
        // 手指往回拖时 scrollTop 已经实时跟着变了，直接拿当前位置判，不用预估
        const limit = maxScroll()
        if (limit > 0 && limit - element.scrollTop > PAUSE_EPS) setFollowing(false)
      }
      touchY = y
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    element.addEventListener('wheel', onWheel, { passive: true })
    element.addEventListener('touchstart', onTouchStart, { passive: true })
    element.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      element.removeEventListener('scroll', onScroll)
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('touchstart', onTouchStart)
      element.removeEventListener('touchmove', onTouchMove)
    }
  }, [])

  // 每一轮的起止与时间（见 turn-timing.ts）；entries 变了才重算
  const rounds = useMemo(() => roundInfos(props.entries), [props.entries])
  /**
   * 从第几轮开始画（更早的轮先不进 DOM）。
   *
   * 取两者较小的那个：默认窗口是「最近一页」，而用户点过「加载更早」之后有了一个更靠前的
   * 起点——会话又长长了的时候，窗口后方跟着走，但用户已经放出来的那些不会被收走。
   */
  const pageStart = Math.max(0, rounds.length - PAGE_ROUNDS)
  const firstVisibleRound = earliestVisible === null ? pageStart : Math.min(earliestVisible, pageStart)
  /** 上面还有没画出来的轮吗（决定画不画那颗「加载更早」）。 */
  const hasEarlier = firstVisibleRound > 0
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
   *
   * 为什么把「哪几条算过程」算在这里而不是散在 map 回调里：这条线是「用户消息之后、
   * 这一轮最后一条定稿正文之前」，要一次看完这一轮才知道末条正文在哪；逐条判的话每条都要
   * 反扫一遍自己的轮次。同时这也让「开关画了、组内却没条目」这种不一致根本不可能发生。
   *
   * 三类条目不进组：
   * - plan：审批流的一部分（dsh 的 TURN_PROCESS_INDEPENDENT_KINDS），收起过程不能把
   *   「等你点批准」一起藏掉；
   * - 本轮最后一条定稿 text（id>=0）：那是这一轮的最终回答，折叠的目标就是「过程收起来、
   *   回答留着」；
   * - 定稿轮里的直播尾（id<0）——它只可能出现在还没收尾的那一轮，而那一轮强制展开。
   */
  const roundFold = useMemo(() => {
    const out = new Map<number, RoundFold>()
    for (const round of rounds) {
      // 本轮最后一条定稿正文（从后往前找，找到就走）；它之后（含它自己）都不折叠。
      let answerIndex = -1
      for (let at = round.endIndex; at > round.startIndex; at -= 1) {
        const entry = props.entries[at]
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
        const entry = props.entries[at]
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
        foldable: foldTurns,
        // 跑动中的两种形态都算「这一轮还没收尾」：出现了直播条目（id<0），或者这就是最后一轮
        // 而回合还没结束，或者用户刚发完消息、助手一个字都还没回（answered 为假）。
        running: hasLiveEntry || (live && round.index === lastRoundIndex) || !round.answered,
        blocked: hasSteering || endReason === 'aborted' || endReason === 'error',
        endReason,
      })
    }
    return out
  }, [props.entries, rounds, foldTurns, live, lastRoundIndex])
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

  /** 记一条本机评价（同一项再点一次 = 取消）。 */
  const vote = (key: string, next: Feedback): void => {
    const merged = { ...feedback }
    if (merged[key] === next) delete merged[key]
    else merged[key] = next
    setFeedback(merged)
    try {
      localStorage.setItem(FEEDBACK_KEY, JSON.stringify(merged))
    } catch {
      // 存不下（本地存储被禁用/写满）也不影响这次会话里的显示
    }
    if (!toldFeedbackOnce) {
      toldFeedbackOnce = true
      toastOk('已在本机记下你的评价（宿主还没有评价上传通道）')
    }
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
   * 渲染序列：先按轮算出座位，再按 entries 的原顺序把不属于任何轮的条目插回原位。
   *
   * 「哪些条目算过程区」的判据沿用 roundFold 给的那段下标区间，但**计划卡要单独摘出来**：
   * 它可能落在区间里面（夹在两条工具之间），而它是审批流的一部分——收起整轮不能把
   * 「等你点批准」一起藏掉（对照 dsh 的 TURN_PROCESS_INDEPENDENT_KINDS）。
   */
  const plan = useMemo<ChatPlanItem[]>(() => {
    const seats = new Map<number, RoundSeatPlan>()
    for (const round of rounds) {
      // 更早的那几轮先不进 DOM（点「加载更早」再放出来）：分的是渲染量，不是数据量
      if (round.index < firstVisibleRound) continue
      const fold = roundFold.get(round.index)
      const process: ChatBlock[] = []
      const after: ChatBlock[] = []
      let withFoldRow = false
      // 总开关画在过程区第一条之前。没有过程内容时（hasContent 为假）改画在用户消息之后——
      // dsh 的整轮控件位置就是「该轮所有起始输入之后、最终答案之前」，那种轮那一行照样出现，
      // 只是画成不可点的（TurnProcessNodeView.tsx:19,44 的 disabled={!canCollapse}）。
      const foldRowAt = fold === undefined || !fold.foldable
        ? -1
        : fold.hasContent ? fold.startIndex : round.startIndex + 1
      for (let at = round.startIndex + 1; at <= round.endIndex; at += 1) {
        const entry = props.entries[at]
        if (entry === undefined) continue
        if (at === foldRowAt) withFoldRow = true
        const head = stepGrouping.headAt.get(at)
        if (head !== undefined) {
          const members: number[] = []
          for (let member = head.startIndex; member <= head.endIndex; member += 1) members.push(member)
          process.push({ kind: 'group', group: head, members })
          // 组里那几条已经收进组体，跳过（组头只画一次，画在这个块上）
          at = head.endIndex
          continue
        }
        const inProcess =
          fold !== undefined && fold.foldable && fold.hasContent
          && at >= fold.startIndex && at <= fold.endIndex
        // 独立节点不进过程区：收起整轮不能把「等你点批准」「这一轮出错了」也一起藏掉
        // （对照 dsh 的 TURN_PROCESS_INDEPENDENT_KINDS）
        if (inProcess && !TURN_PROCESS_INDEPENDENT.has(entry.kind)) process.push({ kind: 'row', index: at })
        else after.push({ kind: 'row', index: at })
      }
      seats.set(round.index, {
        round,
        fold,
        lead: round.startIndex,
        withFoldRow,
        process,
        after,
        withFoot: round.answered,
      })
    }
    const items: ChatPlanItem[] = []
    props.entries.forEach((_entry, index) => {
      const round = roundAt.get(index)
      if (round === undefined) {
        // 不属于任何一轮：开场那条 system 提示、轮之间冒出来的错误提示或宿主通知
        items.push({ kind: 'loose', index })
        return
      }
      // 轮内的其它条目由这一轮的座位自己渲染；只在轮首插一次座位
      if (index !== round.startIndex) return
      const seat = seats.get(round.index)
      if (seat !== undefined) items.push({ kind: 'seat', seat })
    })
    return items
  }, [props.entries, rounds, roundFold, stepGrouping, roundAt, firstVisibleRound])

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
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
              </div>
            </div>
          )
        }
        return (
          <div className="entry-text">
            <div className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
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
