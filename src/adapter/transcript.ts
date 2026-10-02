/**
 * core 事件流 → 中性 transcript 的折叠器（无 React、零宿主依赖）。
 *
 * 数据来源分工：
 * - `delta` 事件维护直播尾 `segments`（流式渲染）；
 * - `message` 事件是定稿：清直播尾、折叠 text/reasoning 条目；
 * - `tool/call` ↔ `tool/result` 按 callId 配对成工具卡（发起时刻与耗时分别记在
 *   `call.startedAt` / `call.durationMs` 上，条目上的 `ts` 只表示最后写入时刻）；
 * - `usage` 累计；`error` 折成 system 条目；压缩落点标 `compaction`（实时走
 *   `system()`，重放靠摘要正文的 {@link SUMMARY_BANNER} 前缀认）。
 *
 * 条目对象一旦发布视为不可变，更新靠替换（tool 卡 running→done）。
 *
 * @module dsc/adapter/transcript
 */
import type { CoreEvent } from '../core/events.js'
import { contentImages, contentText, type ChatMessage } from '../core/llm.js'
import type { FileChangeSummary } from '../core/tools.js'
import { SUMMARY_BANNER } from '../core/compact-anchors.js'
import type { CompactionMark, TokenUsageView, ToolCallView, ToolStatus, TranscriptEntry } from '../contract.js'

/** 工具卡条目（替换对象实现不可变更新）。 */
type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

/** 直播尾段：按到达顺序的 thinking/text 交替片段。 */
interface LiveSegment {
  kind: 'thinking' | 'text'
  text: string
  /** 这一段最后一次追加内容的时刻（界面按它算时间；重放老日志时没有）。 */
  ts?: number
}

const RESULT_TEXT_LIMIT = 1500

/** 把会话事件流折叠成有序 transcript。 */
export class Transcript {
  /** 定稿条目（append-only；`clear()` 重置）。 */
  private list: TranscriptEntry[] = []
  /** callId → 工具条目在 `list` 中的下标（append-only 保证下标稳定）。 */
  private toolIndex = new Map<string, number>()
  /**
   * 流式期间已经报出工具名、还在等参数的条目（对照 dsh 的 `preparing` 阶段）。
   *
   * 为什么**不直接进 list**：list 里的条目永远排在直播尾之前，而准备中的工具在语义上
   * 恰恰是「最新发生的一件事」——push 进去会让工具卡插到正在流式的思考前面（自检实测过，
   * 顺序会变成「工具 → 思考 → 正文」，而且升级是就地替换，这个位置会一直错下去）。
   * 交给 {@link liveEntries} 合成在最后，等 `tool/call` 到达时再正式落进 list——
   * 那时直播尾已经被清掉了，顺序自然对。
   */
  private prepared: { id: number; name: string; ts: number | null }[] = []
  private seq = 1
  /** 直播尾段（`message`/`turn/end`/清空时重置）。 */
  private segments: LiveSegment[] = []
  /** 本会话累计 token 用量。 */
  usage: TokenUsageView = { inputTokens: 0, outputTokens: 0 }
  /**
   * 本轮（最近一条用户消息起）累计 token 用量。
   *
   * 口径：这一轮里每一次模型请求的 prompt_tokens（含系统提示词与全部上下文）
   * 与 completion_tokens 全部累加。多步工具轮每次请求都重发整份上下文，
   * 所以这个和就是本轮真实计费量，界面每轮页脚要显示的就是它。
   * 收 'user' 事件时清零（新一轮的起点），'usage' 事件累加。
   */
  private turnUsage: TokenUsageView = { inputTokens: 0, outputTokens: 0 }
  /** 当前 turn 是否已进入工具执行阶段（驱动 working/thinking 状态区分）。 */
  working = false
  /** 事件驱动的 turn 状态（turn/start→true，turn/end→false；避免依赖 agent 瞬时值）。 */
  inTurn = false
  /**
   * 本会话已经落过几条压缩标记（`clear()` 归零）。新标记的 `count` 就是它加一，
   * 因此这个数就是「第几次压缩」。标记只在真正压过的地方产生，所以不必认识压缩服务。
   */
  private compactionCount = 0
  /**
   * 当前这次折叠的事件时刻，加入条目时统一盖上去（见 {@link stamp}）。
   * null = 正在重放老会话，日志里没记时间：条目就不带 ts，
   * 界面据此降级（不显示时间与用时），而不是拿现在的钟点冒充历史时刻。
   */
  private eventTs: number | null = Date.now()

  /** 定稿条目的只读视图。 */
  get entries(): readonly TranscriptEntry[] {
    return this.list
  }

  /** 还没定稿的条目：直播尾 + 「准备中」的工具（见 `prepared` 的注释）。 */
  liveEntries(): TranscriptEntry[] {
    const live = this.segments.map(
      (segment, position): TranscriptEntry => ({
        kind: segment.kind,
        id: -(position + 1),
        text: segment.text,
        ...(segment.ts === undefined ? {} : { ts: segment.ts }),
      }),
    )
    // 准备中的工具用**正 id**：负 id 是「这段内容还在长」的标记（整轮折叠与轮次划分都拿它
    // 当直播证据），而准备中的调用是一个已经确定的调用，只是参数还没到齐。
    const prepared = this.prepared.map((item): TranscriptEntry => ({
      kind: 'tool',
      id: item.id,
      call: {
        callId: '',
        name: item.name,
        // 参数这会儿还没到齐，一条都不解析（对照 dsh 的「不解析参数」）
        argsText: '',
        status: 'preparing',
      },
      ...(item.ts === null ? {} : { ts: item.ts }),
    }))
    return [...live, ...prepared]
  }

  /**
   * 追加一条系统提示（错误/状态说明）。
   * @param compaction - 这条提示是「历史刚被压缩」的落点：带标记，轨迹页据此切区段。
   */
  system(text: string, compaction = false): void {
    // 这条不走 reduce，时间戳在这里自己取
    this.list.push({
      kind: 'system',
      id: this.seq++,
      text,
      ts: Date.now(),
      ...(compaction ? { compaction: this.compactionMark() } : {}),
    })
  }

  /** 下一个压缩标记；只有真压过的地方才调用，所以序号不会跳。 */
  private compactionMark(): CompactionMark {
    this.compactionCount += 1
    return { count: this.compactionCount }
  }

  /**
   * 记一份计划（提交评审、批准、拒绝都走这里）。
   * 同一份计划（按文件路径认）只保留一张卡：批完之后原位更新结论，别叠两张。
   */
  plan(view: Extract<TranscriptEntry, { kind: 'plan' }>['plan']): void {
    const at = this.list.findIndex((entry) => entry.kind === 'plan' && entry.plan.file === view.file)
    if (at >= 0) {
      const previous = this.list[at]
      // 原位换成新结论时也刷新时间：这张卡的时刻是「最后一次更新」
      if (previous?.kind === 'plan') this.list[at] = { ...previous, plan: view, ts: Date.now() }
      return
    }
    this.list.push({ kind: 'plan', id: this.seq++, plan: view, ts: Date.now() })
  }

  /** 清空（开新会话/恢复会话时）。 */
  clear(): void {
    this.list = []
    this.toolIndex.clear()
    this.prepared = []
    this.seq = 1
    this.segments = []
    this.usage = { inputTokens: 0, outputTokens: 0 }
    this.turnUsage = { inputTokens: 0, outputTokens: 0 }
    this.working = false
    this.inTurn = false
    this.compactionCount = 0
  }

  /**
   * 恢复会话时把历史消息折叠为条目（合成为事件流走 reduce，复用配对逻辑）。
   * usage 不重放（历史 token 已计入模型侧缓存，快照从 0 起算当前会话增量）。
   * @param toolErrors 日志里记下的工具异常标记（callId → `rejected` / `tool-error`）。
   *                   OpenAI 协议消息不带这个信息，缺省时工具一律折成「完成」。
   *
   * 时间戳跟着消息走（`ChatMessage.ts`，由会话日志重放时填回）：有就盖在条目上，
   * 没有（2026-09 之前的老日志）就传 null，条目干脆不带 ts，界面降级不显示时间。
   */
  replayHistory(messages: readonly ChatMessage[], toolErrors?: ReadonlyMap<string, string>, fileChanges?: ReadonlyMap<string, FileChangeSummary>): boolean {
    let changed = false
    for (const message of messages) {
      const ts = message.ts ?? null
      switch (message.role) {
        case 'user': {
          const images = contentImages(message.content)
          changed =
            this.reduce(
              {
                type: 'user',
                text: contentText(message.content),
                ...(images.length > 0 ? { images } : {}),
              },
              ts,
            ) || changed
          break
        }
        case 'assistant':
          changed =
            this.reduce(
              {
                type: 'message',
                text: contentText(message.content),
                reasoning: message.reasoning_content ?? '',
              },
              ts,
            ) || changed
          for (const call of message.tool_calls ?? []) {
            changed =
              this.reduce(
                {
                  type: 'tool/call',
                  callId: call.id,
                  name: call.function.name,
                  args: call.function.arguments,
                },
                ts,
              ) || changed
          }
          break
        case 'tool': {
          const callId = message.tool_call_id ?? ''
          const error = toolErrors?.get(callId)
          changed =
            this.reduce(
              {
                type: 'tool/result',
                callId,
                text: contentText(message.content),
                ...(error !== undefined ? { error } : {}),
              },
              ts,
            ) || changed
          // 成功的 write / edit 把轮尾卡的变更事实一并重放（日志 tool 记录里存着）
          const change = fileChanges?.get(callId)
          if (change !== undefined) {
            changed = this.reduce({ type: 'tool/changes', callId, change }, ts) || changed
          }
          break
        }
      }
    }
    // 工具卡配对完成后不留在执行态（reduce 的 tool/call 会置 working）
    this.working = false
    return changed
  }

  /** 给新条目盖时间戳；重放老日志（eventTs 为 null）时不盖。 */
  private stamp(entry: TranscriptEntry): TranscriptEntry {
    return this.eventTs === null ? entry : { ...entry, ts: this.eventTs }
  }

  /**
   * 本轮累计的 `usage` 字段：非零才带。
   * 为什么零就不带：一次请求都还没回过用量时，硬写 `{0,0}` 会让界面把「还没数」
   * 当成「这一轮真的一分没花」，而带不带这个字段是能给界面区分的信号。
   */
  private turnUsageField(): { usage?: { inputTokens: number; outputTokens: number } } {
    const { inputTokens, outputTokens } = this.turnUsage
    if (inputTokens === 0 && outputTokens === 0) return {}
    return { usage: { inputTokens, outputTokens } }
  }

  /**
   * 轮末兜底：把本轮最终累计写到「本轮最后一条能挂 usage 的条目」上。
   *
   * 为什么 message 那一刻盖过了还要再写一次：`usage` 事件是在 `message` 之后才发的
   * （loop.ts 先定稿消息、再报用量），所以 message 那时盖上的累计还差本次请求那一笔。
   * 收尾时补上，轮内最后一条才是整轮真值——界面取的就是它。
   *
   * 为什么往前找而不是只看最后一条：一轮以工具结果收尾时最后一条是 tool 卡（能挂），
   * 但末尾要是又插了 system 行（错误提示之类），仍该落回上一张能挂的条目，别把数字丢了。
   * 为什么只认 text/tool：contract.ts 里只有这两种条目有 `usage` 字段。
   */
  private stampTurnUsage(): void {
    if (this.turnUsage.inputTokens === 0 && this.turnUsage.outputTokens === 0) return
    for (let index = this.list.length - 1; index >= 0; index -= 1) {
      const entry = this.list[index]
      if (entry === undefined || entry.kind === 'user') return
      if (entry.kind === 'text' || entry.kind === 'tool') {
        this.list[index] = { ...entry, usage: { ...this.turnUsage } }
        return
      }
    }
  }

  /**
   * 从「准备中」队列里取一条同名的（先来后到）。
   *
   * 为什么按名字配对而不是纯按顺序：模型偶尔会重排 index，名字对上才算同一条。
   * 一个都没对上就返回 undefined，调用方用新 id 落一条——那条准备中的留给
   * {@link dropPrepared} 在轮末收掉。
   */
  private takePrepared(name: string): { id: number; ts: number | null } | undefined {
    const at = this.prepared.findIndex((item) => item.name === name)
    if (at < 0) return undefined
    return this.prepared.splice(at, 1)[0]
  }

  /**
   * 丢掉还挂着「准备中」、却等不到对应 `tool/call` 的那些。
   *
   * 什么时候会有：模型吐了工具名之后被打断，或者吐到一半改了主意。那些条目代表
   * 「本来想调、最后没调」，留着会让用户一直盯着一句「准备读取文件」等下去。
   *
   * 为什么放在轮末而不是 `message`：`loop.ts` 的顺序是「先发 message、再执行工具」，
   * message 那一刻这一批的 `tool/call` 还没发出来——在那儿清会把等着升级的一起误杀。
   *
   * 为什么只是一句赋值：这些条目从来没进过 `list`（见 `prepared` 的注释），
   * 所以没有下标要修、也没有 toolIndex 要重建。
   */
  private dropPrepared(): void {
    this.prepared = []
  }

  /**
   * 折叠一条 core 事件。
   * @param ts 这条事件的时刻；省略取当前时间（运行中的实时事件都这样）。
   *           重放老会话时显式传 null：条目不带 ts，界面据此降级。
   * @returns 是否产生了可见变化（调用方据此决定是否通知 UI）。
   */
  reduce(event: CoreEvent, ts: number | null = Date.now()): boolean {
    this.eventTs = ts
    switch (event.type) {
      case 'user': {
        // 一条用户消息就是新一轮的起点：上一轮的累计不能带进这一轮，
        // 否则界面会把上一轮花掉的量算到这一轮头上。
        // 例外是轮中途插话（steering）：它还属于同一轮，累计要接着算下去，
        // 否则这一轮前半段已经花掉的量会被当场抹掉。
        if (event.steering !== true) this.turnUsage = { inputTokens: 0, outputTokens: 0 }
        const last = this.list[this.list.length - 1]
        const imageCount = event.images?.length ?? 0
        const sameAsLast =
          last !== undefined &&
          last.kind === 'user' &&
          last.text === event.text &&
          (last.images?.length ?? 0) === imageCount
        if (sameAsLast) return false
        // 压缩摘要本身在内存里就是一条 role:'user' 的消息（core/compact.ts 造的），
        // 正文固定以 SUMMARY_BANNER 开头：这是它和真用户消息唯一的区别。
        // 老会话重放时系统提示不落进条目（日志里根本不存 system 行），全靠这个前缀
        // 才能认出「这里压过一次」，所以标记就打在摘要这条 user 条目上（kind 不动）。
        const compacted = event.text.startsWith(SUMMARY_BANNER)
        this.list.push(
          this.stamp({
            kind: 'user',
            id: this.seq++,
            text: event.text,
            ...(imageCount > 0 ? { images: event.images } : {}),
            ...(compacted ? { compaction: this.compactionMark() } : {}),
            ...(event.steering === true ? { steering: true } : {}),
          }),
        )
        return true
      }
      case 'message': {
        const hadLive = this.segments.length > 0
        this.segments = []
        this.working = false
        let changed = hadLive
        if (event.reasoning !== '') {
          this.pushThinking(event.reasoning)
          changed = true
        }
        if (event.text !== '') {
          this.pushAssistantText(event.text)
          changed = true
        }
        // 这次输出撞上了长度上限：单独记一条（对照 dsh 的 turn-max-tokens 节点）。
        // 它是独立节点——不进任何阶段组，也不被整轮折叠藏掉：用户得看见「话被截断了」，
        // 否则只会以为模型答到一半就不说了。重放老会话时拿不到 finish_reason，所以没有这条。
        if (event.finishReason === 'length') {
          this.list.push(this.stamp({ kind: 'turn-max-tokens', id: this.seq++ }))
          changed = true
        }
        return changed
      }
      case 'delta':
        this.appendSegment(event.kind === 'reasoning' ? 'thinking' : 'text', event.text)
        return true
      case 'tool/prepare': {
        // 模型开始吐这个工具的名字、参数还没到齐：记一笔，好让用户看得见「接下来要干这件事」
        // （对照 dsh 的 preparing 节点）。这条不往 list 里 push，理由见 `prepared` 的注释——
        // 它由 liveEntries() 合成在最后，`tool/call` 到达时才正式落进 list。
        this.prepared.push({ id: this.seq++, name: event.name, ts: this.eventTs })
        return true
      }
      case 'model/retry': {
        // 重试发生在 llm 层内部，不报出来的话用户只会觉得界面卡了几秒。
        // 它同时是二级分组的边界（前后两段过程被切开），但整轮折叠仍包含它。
        this.list.push(this.stamp({
          kind: 'model-retry',
          id: this.seq++,
          attempt: event.attempt,
          text: event.reason,
        }))
        return true
      }
      case 'tool/call': {
        this.working = true
        // 工具调用意味着模型输出已定稿，直播尾让位
        const hadLive = this.segments.length > 0
        this.segments = []
        // 发起时刻就是这条条目第一次写入的时刻，只在这里取一次；结果回来时不许覆盖
        // （条目的 ts 是「最后写入时刻」，只留给界面算轮次计时）
        const startedAt = this.eventTs
        const call: ToolCallView = {
          callId: event.callId,
          name: event.name,
          argsText: event.args,
          status: 'running',
          // 重放老会话（eventTs 为 null）时拿不到发起时刻，干脆不写，界面据此降级
          ...(startedAt === null ? {} : { startedAt }),
        }
        // 流式期间为它报过「准备中」就接着用那一条的身份：id 与 ts 都保留，
        // 用户看到的是同一张卡从「准备读取文件」变成「正在读取文件」。
        // dsh 的口径是「准备中的调用使用首个具名 delta 的时间」，所以 ts 用准备那一刻的。
        const prepared = this.takePrepared(event.name)
        this.list.push(prepared === undefined
          ? this.stamp({ kind: 'tool', id: this.seq++, call })
          : {
              kind: 'tool',
              id: prepared.id,
              call,
              ...(prepared.ts === null ? {} : { ts: prepared.ts }),
            })
        this.toolIndex.set(event.callId, this.list.length - 1)
        return true
      }
      case 'tool/result': {
        const index = this.toolIndex.get(event.callId)
        if (index === undefined) return false
        const previous = this.list[index] as ToolEntry
        const failed = event.error !== undefined && event.error !== 'rejected'
        // 时间戳跟着结果刷新：这张卡「最后一次写入」是拿到结果那一刻，
        // 界面按最后一条条目的 ts 算这一轮的结束时刻，刷新了才准
        const startedAt = previous.call.startedAt
        const arrivedAt = this.eventTs
        // 耗时 = 结果到达时刻 − 发起时刻。done / failed / rejected 一视同仁：跑挂了、
        // 被审批拒掉、用户打断的工具调用同样占用了这段时间（见 contract.ts 的口径）。
        // 两头缺一个就写不出来；结果时刻早于发起时刻（日志乱序）也不写，不编 0 秒。
        const durationMs =
          startedAt === undefined || arrivedAt === null || arrivedAt < startedAt
            ? undefined
            : arrivedAt - startedAt
        this.list[index] = this.stamp({
          ...previous,
          call: {
            ...previous.call,
            status: event.error === 'rejected' ? 'rejected' : failed ? 'failed' : 'done',
            resultText: truncate(event.text),
            ...(durationMs === undefined ? {} : { durationMs }),
          },
        })
        return true
      }
      case 'tool/changes': {
        // 一次成功 write / edit 的实际改动：独立条目（渲染层把同一轮的聚合成轮尾一张卡）。
        // 时间戳口径与工具卡一致：条目创建那一刻就是落盘完成那一刻。
        this.list.push(this.stamp({ kind: 'changes', id: this.seq++, file: event.change }))
        return true
      }
      case 'turn/diff': {
        // 回合收尾的聚合改动（同文件多刀合一）：也是独立条目，渲染层优先拿它画轮尾卡。
        // 恢复会话的重放不重建它（纯内存条目不落盘），轮尾卡回退逐刀合并显示。
        this.list.push(this.stamp({ kind: 'turnDiff', id: this.seq++, files: event.files }))
        return true
      }
      case 'usage':
        this.usage = {
          inputTokens: this.usage.inputTokens + event.inputTokens,
          outputTokens: this.usage.outputTokens + event.outputTokens,
        }
        // 会话总量与本轮累计各记一份：前者给状态栏的会话累计，后者随条目送到界面
        this.turnUsage = {
          inputTokens: this.turnUsage.inputTokens + event.inputTokens,
          outputTokens: this.turnUsage.outputTokens + event.outputTokens,
        }
        return true
      case 'error':
        this.system(`错误：${event.message}`)
        return true
      case 'turn/start':
        // 快照的 turnState 完全由事件驱动（inTurn），事件发出即通知重算。
        this.working = false
        this.inTurn = true
        return true
      case 'turn/end': {
        const hadLive = this.segments.length > 0
        this.segments = []
        this.working = false
        this.inTurn = false
        this.stampTurnUsage()
        // 轮尾标记：把「这一轮为什么结束」记成一条独立条目（对照 dsh 的 turn.end.reason
        // 与 turn-error 节点）。为什么要落成条目：整轮折叠有两条规矩要读它——中断或失败的轮
        // 不折整轮，开关行还要显示「已停止 / 过程失败」。这两件事都发生在轮**结束之后**，
        // 「当前回合状态」那份快照表达不出来（它那时已经是 idle 了）。
        // 正常结束（completed）不落条目：那时渲染层没什么可判的，多一条只会让订阅者白重算。
        if (event.reason !== 'completed') {
          this.list.push(this.stamp({ kind: 'turn-end', id: this.seq++, reason: event.reason }))
        }
        // 到这里这一轮所有 tool/call 都已经发过了（loop 是等工具跑完才进下一跳），
        // 还挂在「准备中」的就是「吐了名字、最后没调」的那些，清掉。
        this.dropPrepared()
        return true
      }
      default:
        return false
    }
  }

  /** 追加到同类型尾段，否则开新段。 */
  private appendSegment(kind: LiveSegment['kind'], text: string): void {
    const ts = this.eventTs ?? Date.now()
    const last = this.segments[this.segments.length - 1]
    if (last !== undefined && last.kind === kind) {
      last.text += text
      last.ts = ts
    } else {
      this.segments.push({ kind, text, ts })
    }
  }

  /**
   * 定稿文本：合并进相邻的最后一个 text 条目。
   * 顺带盖本轮累计 usage：同一轮里后一条 message 覆盖前一条的累计值（累计在涨），
   * 界面取轮内最后一条 text 就是整轮消耗。
   */
  private pushAssistantText(text: string): void {
    const last = this.list[this.list.length - 1]
    if (last !== undefined && last.kind === 'text') {
      // 合并时刷新时间：这条条目最后一次写入就是现在，界面按它算这一轮何时结束
      this.list[this.list.length - 1] = this.stamp({
        ...last,
        text: `${last.text}\n${text}`,
        ...this.turnUsageField(),
      })
      return
    }
    this.list.push(this.stamp({ kind: 'text', id: this.seq++, text, ...this.turnUsageField() }))
  }

  /** 定稿思考：合并进相邻的最后一个 thinking 条目（折叠展示）。 */
  private pushThinking(text: string): void {
    const last = this.list[this.list.length - 1]
    if (last !== undefined && last.kind === 'thinking') {
      this.list[this.list.length - 1] = this.stamp({ ...last, text: `${last.text}\n${text}` })
      return
    }
    this.list.push(this.stamp({ kind: 'thinking', id: this.seq++, text }))
  }
}

const truncate = (text: string): string =>
  text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}…` : text

// errText 的正主在 core/err-text（渲染层只能 import 纯 core 模块，内核不能反向 import
// adapter）；这里保留同名 re-export，既有 import 不断。
export { errText } from '../core/err-text.js'
