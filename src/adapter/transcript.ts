/**
 * core 事件流 → 中性 transcript 的折叠器（无 React、零宿主依赖）。
 *
 * 数据来源分工：
 * - `delta` 事件维护直播尾 `segments`（流式渲染）；
 * - `message` 事件是定稿：清直播尾、折叠 text/reasoning 条目；
 * - `tool/call` ↔ `tool/result` 按 callId 配对成工具卡；
 * - `usage` 累计；`error` 折成 system 条目。
 *
 * 条目对象一旦发布视为不可变，更新靠替换（tool 卡 running→done）。
 *
 * @module dsc/adapter/transcript
 */
import type { CoreEvent } from '../core/events.js'
import { contentImages, contentText, type ChatMessage } from '../core/llm.js'
import type { TokenUsageView, ToolCallView, ToolStatus, TranscriptEntry } from '../contract.js'

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
   * 当前这次折叠的事件时刻，加入条目时统一盖上去（见 {@link stamp}）。
   * null = 正在重放老会话，日志里没记时间：条目就不带 ts，
   * 界面据此降级（不显示时间与用时），而不是拿现在的钟点冒充历史时刻。
   */
  private eventTs: number | null = Date.now()

  /** 定稿条目的只读视图。 */
  get entries(): readonly TranscriptEntry[] {
    return this.list
  }

  /** 直播尾条目（负 id，与定稿的正 id 不冲突）。 */
  liveEntries(): TranscriptEntry[] {
    return this.segments.map(
      (segment, position): TranscriptEntry => ({
        kind: segment.kind,
        id: -(position + 1),
        text: segment.text,
        ...(segment.ts === undefined ? {} : { ts: segment.ts }),
      }),
    )
  }

  /** 追加一条系统提示（错误/状态说明）。 */
  system(text: string): void {
    // 这条不走 reduce，时间戳在这里自己取
    this.list.push({ kind: 'system', id: this.seq++, text, ts: Date.now() })
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
    this.seq = 1
    this.segments = []
    this.usage = { inputTokens: 0, outputTokens: 0 }
    this.turnUsage = { inputTokens: 0, outputTokens: 0 }
    this.working = false
    this.inTurn = false
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
  replayHistory(messages: readonly ChatMessage[], toolErrors?: ReadonlyMap<string, string>): boolean {
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
        this.turnUsage = { inputTokens: 0, outputTokens: 0 }
        const last = this.list[this.list.length - 1]
        const imageCount = event.images?.length ?? 0
        const sameAsLast =
          last !== undefined &&
          last.kind === 'user' &&
          last.text === event.text &&
          (last.images?.length ?? 0) === imageCount
        if (sameAsLast) return false
        this.list.push(
          this.stamp({
            kind: 'user',
            id: this.seq++,
            text: event.text,
            ...(imageCount > 0 ? { images: event.images } : {}),
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
        return changed
      }
      case 'delta':
        this.appendSegment(event.kind === 'reasoning' ? 'thinking' : 'text', event.text)
        return true
      case 'tool/call': {
        this.working = true
        // 工具调用意味着模型输出已定稿，直播尾让位
        const hadLive = this.segments.length > 0
        this.segments = []
        const entry: ToolEntry = {
          kind: 'tool',
          id: this.seq++,
          call: {
            callId: event.callId,
            name: event.name,
            argsText: event.args,
            status: 'running' satisfies ToolStatus,
          } satisfies ToolCallView,
        }
        this.toolIndex.set(event.callId, this.list.length)
        this.list.push(this.stamp(entry))
        return true
      }
      case 'tool/result': {
        const index = this.toolIndex.get(event.callId)
        if (index === undefined) return false
        const previous = this.list[index] as ToolEntry
        const failed = event.error !== undefined && event.error !== 'rejected'
        // 时间戳跟着结果刷新：这张卡「最后一次写入」是拿到结果那一刻，
        // 界面按最后一条条目的 ts 算这一轮的结束时刻，刷新了才准
        this.list[index] = this.stamp({
          ...previous,
          call: {
            ...previous.call,
            status: event.error === 'rejected' ? 'rejected' : failed ? 'failed' : 'done',
            resultText: truncate(event.text),
          },
        })
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

export const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
