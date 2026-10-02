/**
 * 会话流视口：流式自动跟随（贴底 / 暂停 / 回到底部）与历史分页（加载更早、锚点补偿）。
 *
 * 为什么要单独一个模块：这两件事的全部状态都是「视口」自己的（滚动容器 ref、
 * 跟随标志、分页窗口、锚点），和消息内容怎么渲染无关——收进自定义 hook 之后，
 * ChatView 只管渲染，滚动行为在这里一处说清。
 *
 * @module desktop/renderer/chat/use-chat-viewport
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { TranscriptEntry } from '@dsc/runtime/contract.js'
import { AT_BOTTOM_EPS } from '../JumpStrip.js'

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
export const PAGE_ROUNDS = 8

/** 会话流视口 hook 交回的全部东西（含义见各成员注释）。 */
export interface ChatViewport {
  /** 滚动容器（`.chat`）。 */
  scroller: RefObject<HTMLDivElement | null>
  /** 暂停跟随时为真：外层据此画「回到底部」按钮。 */
  followPaused: boolean
  /** 从第几轮开始画（更早的轮先不进 DOM）。 */
  firstVisibleRound: number
  /** 上面还有没画出来的轮吗（决定画不画那颗「加载更早」）。 */
  hasEarlier: boolean
  /** 「加载更早」那颗按钮的 ref（锚点按正文顺序从它后面找）。 */
  earlierRef: RefObject<HTMLButtonElement | null>
  /** 改跟随态。 */
  setFollowing(next: boolean): void
  /** 把视角钉到最新一条。 */
  pinToBottom(): void
  /** 放出一页更早的轮。 */
  loadEarlier(): void
}

/**
 * 流式自动跟随 + 历史分页。参数里的 `roundCount` 是轮总数（ChatView 里 roundInfos
 * 的长度）：分页窗口按它算，hook 自己不重复算轮次。
 */
export function useChatViewport(options: {
  entries: TranscriptEntry[]
  sessionId: string | null
  roundCount: number
}): ChatViewport {
  const { entries, sessionId, roundCount } = options
  const scroller = useRef<HTMLDivElement | null>(null)
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
   * 从第几轮开始画（更早的轮先不进 DOM）。
   *
   * 取两者较小的那个：默认窗口是「最近一页」，而用户点过「加载更早」之后有了一个更靠前的
   * 起点——会话又长长了的时候，窗口后方跟着走，但用户已经放出来的那些不会被收走。
   */
  const pageStart = Math.max(0, roundCount - PAGE_ROUNDS)
  const firstVisibleRound = earliestVisible === null ? pageStart : Math.min(earliestVisible, pageStart)
  /** 上面还有没画出来的轮吗（决定画不画那颗「加载更早」）。 */
  const hasEarlier = firstVisibleRound > 0

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

  // 换会话必须落到最新一条（用户刚点开一条会话，看到的是它的末尾，不是上次停留的
  // 滚动位置）；分页窗口也跟着回默认：「已放出到第几轮」是上一条会话的事。
  // （编辑框的复位在 ChatView 自己的 effect 里，同 dep 各管各的。）
  useEffect(() => {
    forceFollowRef.current = true
    setFollowing(true)
    setEarliestVisible(null)
  }, [sessionId])

  /**
   * 流式自动跟随：entries 变了就把尾巴贴到底——前提是「还在跟随」。
   * 两个例外无条件跟随：刚换会话（forceFollowRef），以及末尾新出现的一条用户消息
   * （自己刚发出去的，要立刻看到它和它的回复）。
   * 注意这里不改 followRef 之外的任何东西：暂停期间内容照旧长高，只是不替用户决定视角。
   */
  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    const tail = entries[entries.length - 1]
    const tailIsUser = tail !== undefined && tail.kind === 'user' && tail.id >= 0
    if (forceFollowRef.current || tailIsUser) {
      forceFollowRef.current = false
      setFollowing(true)
    }
    if (followRef.current) pinToBottom()
  }, [entries])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    scroller,
    followPaused,
    firstVisibleRound,
    hasEarlier,
    earlierRef,
    setFollowing,
    pinToBottom,
    loadEarlier,
  }
}
