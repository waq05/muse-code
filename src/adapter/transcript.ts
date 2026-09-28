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
import { contentText, type ChatMessage } from '../core/llm.js'
import type { TokenUsageView, ToolCallView, ToolStatus, TranscriptEntry } from '../contract.js'

/** 工具卡条目（替换对象实现不可变更新）。 */
type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

/** 直播尾段：按到达顺序的 thinking/text 交替片段。 */
interface LiveSegment {
  kind: 'thinking' | 'text'
  text: string
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
  /** 当前 turn 是否已进入工具执行阶段（驱动 working/thinking 状态区分）。 */
  working = false
  /** 事件驱动的 turn 状态（turn/start→true，turn/end→false；避免依赖 agent 瞬时值）。 */
  inTurn = false

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
      }),
    )
  }

  /** 追加一条系统提示（错误/状态说明）。 */
  system(text: string): void {
    this.list.push({ kind: 'system', id: this.seq++, text })
  }

  /** 清空（开新会话/恢复会话时）。 */
  clear(): void {
    this.list = []
    this.toolIndex.clear()
    this.seq = 1
    this.segments = []
    this.usage = { inputTokens: 0, outputTokens: 0 }
    this.working = false
    this.inTurn = false
  }

  /**
   * 恢复会话时把历史消息折叠为条目（合成为事件流走 reduce，复用配对逻辑）。
   * usage 不重放（历史 token 已计入模型侧缓存，快照从 0 起算当前会话增量）。
   * @param toolErrors 日志里记下的工具异常标记（callId → `rejected` / `tool-error`）。
   *                   OpenAI 协议消息不带这个信息，缺省时工具一律折成「完成」。
   */
  replayHistory(messages: readonly ChatMessage[], toolErrors?: ReadonlyMap<string, string>): boolean {
    let changed = false
    for (const message of messages) {
      switch (message.role) {
        case 'user':
          changed = this.reduce({ type: 'user', text: contentText(message.content) }) || changed
          break
        case 'assistant':
          changed =
            this.reduce({
              type: 'message',
              text: contentText(message.content),
              reasoning: message.reasoning_content ?? '',
            }) || changed
          for (const call of message.tool_calls ?? []) {
            changed =
              this.reduce({
                type: 'tool/call',
                callId: call.id,
                name: call.function.name,
                args: call.function.arguments,
              }) || changed
          }
          break
        case 'tool': {
          const callId = message.tool_call_id ?? ''
          const error = toolErrors?.get(callId)
          changed =
            this.reduce({
              type: 'tool/result',
              callId,
              text: contentText(message.content),
              ...(error !== undefined ? { error } : {}),
            }) || changed
          break
        }
      }
    }
    // 工具卡配对完成后不留在执行态（reduce 的 tool/call 会置 working）
    this.working = false
    return changed
  }

  /**
   * 折叠一条 core 事件。
   * @returns 是否产生了可见变化（调用方据此决定是否通知 UI）。
   */
  reduce(event: CoreEvent): boolean {
    switch (event.type) {
      case 'user': {
        const last = this.list[this.list.length - 1]
        if (last !== undefined && last.kind === 'user' && last.text === event.text) return false
        this.list.push({ kind: 'user', id: this.seq++, text: event.text })
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
        this.list.push(entry)
        return true
      }
      case 'tool/result': {
        const index = this.toolIndex.get(event.callId)
        if (index === undefined) return false
        const previous = this.list[index] as ToolEntry
        const failed = event.error !== undefined && event.error !== 'rejected'
        this.list[index] = {
          ...previous,
          call: {
            ...previous.call,
            status: event.error === 'rejected' ? 'rejected' : failed ? 'failed' : 'done',
            resultText: truncate(event.text),
          },
        }
        return true
      }
      case 'usage':
        this.usage = {
          inputTokens: this.usage.inputTokens + event.inputTokens,
          outputTokens: this.usage.outputTokens + event.outputTokens,
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
        return true
      }
      default:
        return false
    }
  }

  /** 追加到同类型尾段，否则开新段。 */
  private appendSegment(kind: LiveSegment['kind'], text: string): void {
    const last = this.segments[this.segments.length - 1]
    if (last !== undefined && last.kind === kind) last.text += text
    else this.segments.push({ kind, text })
  }

  /** 定稿文本：合并进相邻的最后一个 text 条目。 */
  private pushAssistantText(text: string): void {
    const last = this.list[this.list.length - 1]
    if (last !== undefined && last.kind === 'text') {
      this.list[this.list.length - 1] = { ...last, text: `${last.text}\n${text}` }
      return
    }
    this.list.push({ kind: 'text', id: this.seq++, text })
  }

  /** 定稿思考：合并进相邻的最后一个 thinking 条目（折叠展示）。 */
  private pushThinking(text: string): void {
    const last = this.list[this.list.length - 1]
    if (last !== undefined && last.kind === 'thinking') {
      this.list[this.list.length - 1] = { ...last, text: `${last.text}\n${text}` }
      return
    }
    this.list.push({ kind: 'thinking', id: this.seq++, text })
  }
}

const truncate = (text: string): string =>
  text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}…` : text

export const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
