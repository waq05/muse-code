/**
 * 消息流：user 气泡 / thinking 折叠 / text markdown（含底部操作条）/ 工具卡 / system 灰条
 * + 流式直播尾光标 + 条件式自动滚动到底。
 *
 * 自动跟随这次改成了条件式的（改版前每来一块新内容就把 scrollTop 钉到底，往上翻历史
 * 翻不动）：用户主动往上滚（滚轮 / 触摸拖动 / 拖滚动条，判定都落在「scrollTop 离开底部」
 * 这一件事上）就暂停跟随，滚回距底 32px（与 JumpStrip.tsx 的 AT_BOTTOM_EPS 同一档）以内、
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
 * - 展示档位（props.processFold）可以整层关掉这件事：详细档不做整轮折叠，紧凑档另外把定稿
 *   思考行的摘要预览收掉（那一档由 ThinkingBlock 的 showPreview 管）。
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
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { StatusView, TranscriptEntry, UiProcessFold } from '@dsc/runtime/contract.js'
import type { RuntimeProxy } from './bridge.js'
import { AT_BOTTOM_EPS, JumpStrip } from './JumpStrip.js'
import { PlanReview } from './TaskDock.js'
import { ThinkingBlock } from './ThinkingBlock.js'
import { ToolCard } from './ToolCard.js'
import { TurnFooter } from './TurnFooter.js'
import { TurnStatusLine } from './TurnStatusLine.js'
import { isSessionMarker } from './session-marker.js'
import { readFold, turnFoldKey, writeFold } from './fold-state.js'
import { formatDuration, liveActivity, roundDuration, roundInfos, turnStartedAt, type RoundInfo } from './turn-timing.js'
import { toastErr, toastOk } from './components/toast.js'
import { IconChevronDown, IconEdit } from './icons.js'
import { estimateTextTokens } from './token-estimate.js'

/** 一条回复的本机评价：只有赞 / 踩两态，再点一次取消。 */
type Feedback = 'up' | 'down'

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
  /** 有没有可折叠的过程内容：没有就不画总开关，这一轮照旧全摊开。 */
  foldable: boolean
  /** 跑动中：整组强制展开、连总开关都不画（dsh 的 turnProcessAlwaysOpen 语义）。 */
  running: boolean
}

/**
 * 整轮过程折叠的总开关行（对照 dsh 的 TurnProcessNodeView.tsx:36-53）：
 * 一行左对齐的小字按钮，「用时 X」（算不出用时就是「已完成」，绝不显示 NaN）+ 行尾箭头，整行可点。
 *
 * 只给定稿轮画（跑动中的轮不渲染这一行，见下面 map 里那处条件）：dsh 的 turn-process 节点
 * 同样只在本轮 status === 'closed' 时才渲染（TurnProcessNodeView.tsx:18）。
 *
 * 为什么标题是「用时」而不是「思考过程 / 工具调用」：dsh 那一行报的是「这一轮花了多久」
 * （TurnProcessNodeView.tsx:21-29 的 took / worked），条数之类的统计留在 data-* 属性上给
 * 自检用，不占人眼。这一行收起来的是过程，用户最想知道的是「值不值得展开看一眼」。
 */
function TurnFoldRow(props: {
  open: boolean
  round: RoundInfo
  onToggle(): void
}): JSX.Element {
  const used = formatDuration(roundDuration(props.round))
  const label = used === null ? '已完成' : `用时 ${used}`
  return (
    <button
      type="button"
      className="turn-fold"
      // 展开态走 data-open（对照 dsh 的 css.root[data-open]），样式里靠它转箭头
      data-open={props.open ? '1' : undefined}
      data-round-index={props.round.index}
      aria-expanded={props.open}
      data-tip={props.open ? '收起这一轮的过程（思考与工具调用）' : '展开这一轮的过程（思考与工具调用）'}
      onClick={props.onToggle}
    >
      <span className="turn-fold-label">{label}</span>
      <IconChevronDown size={11} className="turn-fold-chevron" />
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
   * - 'compact' / 'standard'：整轮过程折叠（紧凑档另外把定稿思考行的摘要预览收掉）；
   * - 'detailed'：不做整轮折叠。
   * 不传按 'standard'（只读视图如队友运行记录不传这个 prop，跟着默认档走）。
   */
  processFold?: UiProcessFold
}): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)
  const [feedback, setFeedback] = useState<Record<string, Feedback>>(loadFeedback)
  /** 正在原地编辑的那条用户消息（下标 = 在 entries 里的位置）+ 编辑框里的正文。 */
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null)
  /** 重发请求已经发出去、还在等宿主换会话：这期间按钮置灰，防止连点分叉出两份。 */
  const [sending, setSending] = useState(false)
  /**
   * 整轮过程折叠的展开态（键 = turnFoldKey，见 fold-state.ts）。
   *
   * 为什么要 React state 而不是只读 fold-state：fold-state 是个普通 Map，写它不会触发重渲染
   * （设计如此，见那儿的模块注释——它只为「重挂时读回初值」而生）。点总开关是当场要看到变化的
   * 动作，所以这一层 state 管「立刻重画」，fold-state 管「重挂后读回来」，两边的键相同。
   * 键里带会话 id，换会话不会串味，所以这里不需要在切会话时清空。
   */
  const [turnOpen, setTurnOpen] = useState<Record<string, boolean>>({})
  /**
   * 还在不在「跟随最新内容」（流式输出时自动贴底）。
   *
   * 为什么要有这一位：改版前每来一块新内容就把 scrollTop 钉到底，用户想往上翻历史，
   * 刚滚上去就被下一块拽回来，长回答里根本翻不动。现在的规矩是——
   * 用户主动往上翻（滚轮向上 / 触摸拖动 / 拖滚动条，落到 scrollTop 离开底部这一件事上）
   * 就暂停跟随，滚回距底 AT_BOTTOM_EPS（32px，与 JumpStrip 贴底判定同一档）以内、
   * 或点「回到底部」就恢复。
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

  // 换会话（entries 整表换成另一条会话的内容）时把编辑框收掉：留着它，提交时
  // 那条下标指向的已经是别人会话里的消息了。同一件事还捎带一条：换会话必须落到
  // 最新一条（用户刚点开一条会话，看到的是它的末尾，不是上次停留的滚动位置）。
  useEffect(() => {
    setEditing(null)
    forceFollowRef.current = true
    setFollowing(true)
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
   * 唯一要排除的是「自己钉的那一下」：落点与 autoTopRef 重合就不算用户滚离。
   */
  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    const readBottom = (): boolean => {
      const maxScroll = element.scrollHeight - element.clientHeight
      return maxScroll <= 0 || maxScroll - element.scrollTop <= AT_BOTTOM_EPS
    }
    const onScroll = (): void => {
      if (Math.abs(element.scrollTop - autoTopRef.current) <= 1) return
      setFollowing(readBottom())
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) setFollowing(false)
    }
    let touchY = 0
    const onTouchStart = (event: TouchEvent): void => {
      touchY = event.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (event: TouchEvent): void => {
      const y = event.touches[0]?.clientY ?? touchY
      if (y > touchY + 2) setFollowing(false)
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
  /** 详细档不做整轮折叠；紧凑 / 标准两档都折。 */
  const foldTurns = (props.processFold ?? 'standard') !== 'detailed'
  /** 紧凑档把定稿思考行的摘要预览收掉；跑动中的摘要不受档位影响（见 ThinkingBlock）。 */
  const showReasoningPreview = (props.processFold ?? 'standard') !== 'compact'
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
      for (let at = round.startIndex + 1; at <= round.endIndex; at += 1) {
        const entry = props.entries[at]
        if (entry === undefined) continue
        if (entry.id < 0) hasLiveEntry = true
        if (entry.kind !== 'thinking' && entry.kind !== 'tool' && entry.kind !== 'text') continue
        if (answerIndex >= 0 && at >= answerIndex) continue
        if (startIndex < 0) startIndex = at
        endIndex = at
      }
      out.set(round.index, {
        roundIndex: round.index,
        startIndex,
        endIndex,
        foldable: foldTurns && startIndex >= 0,
        // 跑动中的两种形态都算「这一轮还没收尾」：出现了直播条目（id<0），或者这就是最后一轮
        // 而回合还没结束，或者用户刚发完消息、助手一个字都还没回（answered 为假）。
        running: hasLiveEntry || (live && round.index === lastRoundIndex) || !round.answered,
      })
    }
    return out
  }, [props.entries, rounds, foldTurns, live, lastRoundIndex])
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
  /** 跑动中的轮次键集合（键 = turnFoldKey）：轮收尾时靠它认出「这一轮刚定稿」。 */
  const runningFoldKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const fold of roundFold.values()) {
      if (fold.foldable && fold.running) keys.add(turnFoldKey(props.sessionId, fold.roundIndex))
    }
    return keys
  }, [roundFold, props.sessionId])
  /** 上一轮渲染还在跑的键：用来发现「跑动 → 定稿」这一次跳变。 */
  const previousRunningFoldKeys = useRef<Set<string>>(new Set())
  /**
   * 轮收尾（跑动 → 定稿）时把这一轮的展开态复位成默认收起。
   *
   * 为什么要这一步：跑动中那一轮是强制展开的、连总开关都不画，用户没机会做任何选择；
   * 一旦这一轮收尾（回答落定、回合结束），它就该按「定稿轮默认收起」的规矩长回去——
   * 否则刚写完的那一轮会一直摊着，用户每发一条消息都要看一整轮过程。
   * 口径对照 dsh 的 enclosing-Turn reset（ChatNodeSeat.tsx:111-122 把隐藏的成员那次
   * disclosureReset 递增，让轮内折叠条下次展开时回到默认态）。
   */
  useEffect(() => {
    for (const key of previousRunningFoldKeys.current) {
      if (runningFoldKeys.has(key)) continue
      // 存档写回默认值，React state 里那条直接删掉（于是回落到 readFold 的默认收起）
      writeFold(key, false)
      setTurnOpen((current) => {
        if (current[key] === undefined) return current
        const next = { ...current }
        delete next[key]
        return next
      })
    }
    previousRunningFoldKeys.current = runningFoldKeys
  }, [runningFoldKeys])
  /** 这一轮的过程组现在收起来没有：跑动中的轮永远展开（不提供折叠）。 */
  const foldCollapsed = (fold: RoundFold): boolean => {
    if (!fold.foldable || fold.running) return false
    const key = turnFoldKey(props.sessionId, fold.roundIndex)
    return !(turnOpen[key] ?? readFold(key, false))
  }
  /** 点总开关：React state 管当场重画，fold-state 管重挂后读回来（键相同，见 turnFoldKey）。 */
  const toggleRoundFold = (roundIndex: number): void => {
    const key = turnFoldKey(props.sessionId, roundIndex)
    const next = !(turnOpen[key] ?? readFold(key, false))
    writeFold(key, next)
    setTurnOpen((current) => ({ ...current, [key]: next }))
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

  return (
    <div className="chat-wrap">
      <div className="chat" ref={scroller}>
        <div className="chat-inner">
          {props.entries.map((entry, index) => {
            const round = roundAt.get(index)
            // 每轮只在「这一轮的最后一条条目」下面挂页脚。这一轮还在跑（最后一轮）时照片面挂：
            // 时间与用量先不画（状态行正在报同一份时间），但页脚里的分叉按钮留着——置灰，
            // 用户一眼看得到「这一轮结束时在哪分叉」。还没回复的轮次（answered 为假）不挂。
            const running = live && round !== undefined && round.index === lastRoundIndex
            const foot = round !== undefined && round.endIndex === index && round.answered
            /**
             * 这一轮的过程折叠组（见 roundFold）：inFold 说明这条条目归总开关管，
             * foldHead 说明总开关就画在这一条的位置上（组内第一条）。
             *
             * 收起时组内条目一律不渲染（不是藏起来而是根本不画）：各自的展开态、吸附快捷栏
             * 都跟着一起下线，省掉一整轮的过程 DOM 与它的测量工作。
             * 但总开关自己所在的那一条例外——开关要留在原位（用户消息正下方）。
             */
            const fold = round === undefined ? undefined : roundFold.get(round.index)
            const inFold =
              fold !== undefined && fold.foldable && fold.startIndex >= 0 && index >= fold.startIndex && index <= fold.endIndex
            const foldOpen = inFold && fold !== undefined ? !foldCollapsed(fold) : true
            const foldHead = inFold && fold !== undefined && index === fold.startIndex
            let node: ReactNode
            switch (entry.kind) {
              case 'user': {
                const open = editing !== null && editing.index === index
                node = (
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
                break
              }
              case 'text':
                if (entry.id < 0) {
                  // 流式直播尾：无操作条
                  node = (
                    <div className="entry-text live">
                      <div className="markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
                      </div>
                    </div>
                  )
                  break
                }
                node = (
                  <div className="entry-text">
                    <div className="markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
                    </div>
                  </div>
                )
                break
              case 'thinking':
                // 折叠条与工具卡同一组规格（紧凑行 / 展开区 / 超 400px 的顶部吸附快捷栏），
                // 见 ThinkingBlock.tsx。流式直播尾（id<0）挂载即展开，定稿条目默认折叠；
                // 展开与否由组件自己持有，所以直播中也能收起再展开。
                // storeKey 让展开态活过「整表重建」：换会话再切回来，用户之前展开的还开着
                // （键里带会话 id，两条会话的条目 id 都从 1 开始也不会串味）。
                // 直播尾（id<0）不给键：它每一段都是新的，默认展开就是它该有的样子。
                // showPreview：紧凑档把定稿行的摘要预览收掉（跑动中照显，见 ThinkingBlock）。
                node = (
                  <ThinkingBlock
                    text={entry.text}
                    live={entry.id < 0}
                    storeKey={foldKey(entry.id, contentOrdinalAt.get(index))}
                    showPreview={showReasoningPreview}
                  />
                )
                break
              case 'tool':
                node = <ToolCard call={entry.call} storeKey={foldKey(entry.id, contentOrdinalAt.get(index))} />
                break
              case 'plan':
                // 历史里的计划卡：批没批一眼可见，批按钮只在待批状态出现
                node = <PlanReview plan={entry.plan} onAnswer={() => undefined} />
                break
              case 'system':
                // 开场那条「会话 x · 模型 y」不画：状态栏第一段已经带着同样的信息，
                // 再在流末尾留一行居中灰字纯属重复（见 session-marker.ts）。
                node = isSessionMarker(entry.text) ? null : <div className="entry-system">{entry.text}</div>
                break
              default:
                node = null
            }
            // 收起的整轮里，组内条目根本不渲染（不是用 CSS 藏起来）：它们各自的展开态、
            // 吸附快捷栏、高度测量一并下线。两种例外要留下：
            // - 总开关自己所在的那一条（开关要留在原位）；
            // - 这一轮页脚所在的那一条——一轮以工具结果收尾、没有最终正文时，页脚正好挂在
            //   组内最后一条上，收起过程不能把复制 / 分叉 / 用量整行也收掉。
            if (inFold && !foldHead && !foldOpen && !foot) return null
            if (node === null && !foldHead) return null
            // 页脚上的复制与评价都按「这一轮的最终回答」算：
            // - 复制抄最终 text 条目的原文（改版前挂在每条助手消息上的口径不变）；
            // - 评价还是按「会话:条目」存（键用最终回答那条的 id），改版前点过的赞不会丢。
            const answer = round === undefined ? undefined : roundAnswer.get(round.index)
            const feedbackKey = answer === undefined ? undefined : `${props.sessionId ?? ''}:${String(answer.id)}`
            return (
              // data-round 给刻度条命中测试用（第几轮）；display:contents 见 styles.css
              //
              // key 里必须带会话 id（这是 fold-state 那条「展开态切回来就丢」的根因）：
              // 宿主的条目 id 是 `clear()` 之后从 1 重新发号的，两条**形状相同**的会话
              // 因此给出同一个 id 序列，React 按 key 对账时会把上一条会话的组件实例
              // 直接复用给下一条——实例复用意味着 ThinkingBlock / ToolCard 的 useState 初值
              // 函数（readFold）根本不会再跑一次，用户切回来时看到的是「在另一条会话里
              // 顺手改成的那个状态」，fold-state.ts 里存着的展开态被绕过、等于没存。
              // 键里加上会话前缀以后，换会话必然重挂，readFold 必然执行。
              //
              // 已知代价（接受）：靠「加载更早历史」把更早的条目插到前面时，内容条目序号
              // （contentOrdinalAt）会整体后移，已经展开的那一条的存档键跟着换号 → 新键落空、
              // 退回默认折叠态；改之前那是靠实例复用「碰巧」保住的。这里选跨会话保持展开
              // 这个主场景：它每天都在发生，而往前插历史是低频动作，重挂后重展开一次可以接受。
              <div key={`${props.sessionId ?? ''}:${String(entry.id)}`} className="entry-row" data-round={round?.index}>
                {/* 总开关行站在组内第一条的位置上：收起时它是这一轮过程区唯一看得见的东西，
                    展开时它下面接着就是原样的过程条目（对照 dsh TurnProcessNodeView 的位置）。
                    跑动中的轮**不画这一行**：dsh 那边 turn-process 节点只有轮次收尾（status === 'closed'）
                    才会渲染（TurnProcessNodeView.tsx:18），整轮展开、压根不给折叠入口——
                    这样就不会出现「看着能点、点了没反应」的一行。 */}
                {foldHead && fold !== undefined && !fold.running && round !== undefined && (
                  <TurnFoldRow open={foldOpen} round={round} onToggle={() => toggleRoundFold(fold.roundIndex)} />
                )}
                {foldOpen ? node : null}
                {foot && round !== undefined && (
                  <TurnFooter
                    round={round}
                    running={running}
                    // 用量两个口径一起给：有宿主上报的真值就用真值（不带 ~），
                    // 老会话回落这一轮正文的估算（带 ~）。取舍在 TurnFooter 里说明。
                    usage={roundUsage[round.index] ?? null}
                    tokens={roundTokens[round.index] ?? null}
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
                    forkDisabled={live || round.index === 0}
                    forkTitle={
                      round.index === 0
                        ? '这条消息之前没有内容，分叉不出新会话'
                        : '以这条消息为界分叉出新会话'
                    }
                  />
                )}
              </div>
            )
          })}
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
