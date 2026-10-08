/**
 * MiniAgent：参考 dsh ReactLoopAgent 的 turn 语义的个人版 ReAct 循环。
 *
 * 一个 turn = `while(true){ streamChat → 定稿 assistant → 无 tool_calls 则
 * 结束；有则逐个 审批 → 执行 → append tool 消息 → 下一轮 }`。与 dsh 的
 * 差异（个人版取舍）：无 step/子代理/checkpoint 修复——单队列串行 turn，
 * 打断用 AbortController 贯穿 fetch 与工具执行。
 *
 * 0.6.47 起补了 dsh inbox 的最小版：轮中途到达的输入（用户插话、作业完成
 * 通知、定时补投）先进 `async-inbox` 状态条目排队，步骤边界/回合收尾才落库
 * （drainInbox）——它们不能落在「还没落结果的 tool 调用」和结果中间，否则
 * 网关按「tool 结果必须紧跟 tool_calls」判 400，会话从此卡死。
 * 0.6.67 起「入箱」与「进对话」在界面上也分开：入箱期间它只是输入框下方的
 * 队列条（可以编辑 / 删除 / 插话），出账那一刻才画成对话里的气泡。
 *
 * 每个协议要求：assistant 带 tool_calls 时，后续必须为每个 call 补一条
 * tool 消息（包括被拒绝的调用——拒绝也 append "用户拒绝" 结果），
 * 否则下一轮请求会被服务端 400。
 *
 * @module dsc/core/loop
 */
import type { ChatMessage, LlmRoute, StreamHandlers, StreamRequest, StreamResult, ToolCall, ToolSchema } from './llm.js'
import { LlmError, StreamInterruptedError } from './llm.js'
import type { CoreEvent } from './events.js'
import type { Session } from './session.js'
import type { ToolGuardChain } from './tool-guards.js'
import { callFacts, stripBaseline, type FileChangeSummary, type ToolEntry } from './tools.js'
import { collectGitTurnChanges, snapshotGitStatus } from './git-info.js'
import { errText } from './err-text.js'
import { estimateRequestSegments } from './token-estimate.js'

export interface AgentDeps {
  /** 每次请求时动态读取（支持 /model 热切换）。 */
  route(): LlmRoute
  systemPrompt(): string
  tools(): ToolEntry[]
  /**
   * 工具守卫链：一次调用动手之前该问谁，由链上的人自己说。
   * 循环只问结果（拦 / 免问 / 照常），不知道也不该知道链上有模式闸门、审批卡还是别的谁。
   */
  guards: ToolGuardChain
  emit(event: CoreEvent): void
  /**
   * 发一次流式模型请求：按端点声明的协议经 llm 服务的适配器表派发。
   * 循环不认识具体协议——OpenAI 兼容也好、别的插件注册的也好，都从这条缝过。
   */
  stream(api: string, request: StreamRequest, handlers: StreamHandlers): Promise<StreamResult>
  /**
   * 每轮请求前的一次维护动作（上下文压缩检查挂在这里）；缺省不启用。
   * T41：传入这一轮的取消信号——压缩若真在跑模型调用，用户打断要能停得掉它。
   */
  beforeRequest?(signal: AbortSignal): Promise<void>
  /**
   * 请求报「上下文装不下」（HTTP 400 的爆窗文案）时调：强制压缩一次历史。
   * 返回 true = 压出了空间，循环重试这轮请求；false 或缺省 = 原错误照抛。
   * T41：同样吃这一轮的取消信号。
   */
  onContextOverflow?(signal: AbortSignal): Promise<boolean>
  /**
   * 组装好「发给模型的那份消息」之后的投影链（只影响请求体，不改会话日志）。
   * 插件用它丢掉过期截图之类「留在历史里只会撑上下文、对下一轮没用」的内容；
   * 往请求里注入日志上没有的内容时，注入方自己用 appendNote 落一条备忘。
   * 第二参数是这个 agent 自己的会话（0.6.48 起常驻多 agent：env-facts 这类要按
   * 会话取 cwd 的投影靠它取对归属，不能再看「当前查看的会话」）。
   */
  rewrite?(messages: ChatMessage[], session: Session): ChatMessage[]
  /**
   * 完全闲下来（回合收完、没有排队的下一轮）时调一次。常驻注册表用它决定
   * 「非当前查看的 agent 就地收摊」（释放写租约与内存）；当前查看的 agent 不收。
   */
  onIdle?(): void
}

/**
 * T33：流中断后「保留半截再续」的自动重试次数（对齐 codex 的 stream_max_retries，
 * 个人版取 1 次且不做配置面：半截落库之后模型的续写是从中断处自然接上的）。
 */
const STREAM_RECOVERY_ATTEMPTS = 1

/**
 * 判定一个错误是不是「上下文装不下」：各家网关都把它报成 HTTP 400，措辞不一，多认几种。
 * 只认 400——流开始之后不会再有 400（llm 层对已开始的流不重试），半截回复不走这条路。
 */
function isContextOverflowError(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false
  if (error.status !== 400) return false
  return /context.{0,24}(length|window)|maximum.{0,20}context|(prompt|input).{0,20}too long|too many (tokens|输入)|上下文.{0,10}(长度|超)|length limit/i.test(
    error.message,
  )
}

/** 单行摘要工具参数（审批卡/日志用）。 */
function summarizeArgs(argsText: string): string {
  const flat = argsText.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}

export class MiniAgent {
  /** 这个 agent 从生到死只认一个会话（0.6.48 常驻模型：切会话=换 agent，不再换底层会话）。 */
  readonly session: Session
  private abort: AbortController | null = null
  private running = false
  /** 回合真正在跑（turn/start 起到 turn/end 发出为止）。收尾聚合的尾段不算。 */
  private turnActive = false
  private pendingTurn = false

  constructor(
    private readonly deps: AgentDeps,
    session: Session,
  ) {
    this.session = session
  }

  get sessionId(): string {
    return this.session.meta.id
  }

  get cwd(): string {
    return this.session.meta.cwd
  }

  get isRunning(): boolean {
    return this.running
  }

  /**
   * 还有没活干（回合在跑，或收件箱出账后排了下一轮）。常驻注册表据此决定收不收摊。
   * 用 turnActive 而不是 running：turn/end 发出之后还有一段异步收尾（git 聚合），
   * 那段时间 running 仍为 true，但回合已经结束——切走时它该算「闲」，收摊、翻徽标。
   */
  get busy(): boolean {
    return this.turnActive || this.pendingTurn
  }

  /** 收摊：取消在跑的回合并关闭会话（释放写租约）。app 退出与非活跃常驻 agent 清理都走这里。 */
  dispose(): void {
    this.cancel()
    this.session.close()
  }

  /**
   * 追加一条用户消息并排队跑一轮。
   * @param images - 随消息发送的图片（data URL 清单）；模型收不收图由请求前的改写决定。
   */
  followup(text: string, images?: string[]): void {
    // 回合还没跑完就收到的消息算「轮中途到达」（对照 dsh 的 steering/inject，生产者
    // 有用户插话、后台作业完成、定时补投、goal 提醒……）。它们一律先进收件箱：
    // 直接 appendUser 会落在「还没落结果的 tool 调用」和它的结果中间——比如调用正
    // 等审批时作业完成通知插队——网关要求 tool 结果紧跟 tool_calls，从此每轮请求
    // 都 400（0.6.46 那次卡死会话的新形状）。到达与入史拆成两段，见 drainInbox。
    // 要在 enqueueTurn 之前读 running——那之后 running 会被置真，再来一条就分不出先后了。
    if (this.running) {
      this.session.enqueueAsync(text, images)
      // 入箱只是「排队」，还没进对话：这里不发 user 事件（0.6.67 起出账时才发），
      // 只报一条「收件箱变了」，界面据此把队列条画出来 / 刷新。
      this.deps.emit({ type: 'inbox' })
      return
    }
    this.session.appendUser(text, images)
    this.deps.emit({
      type: 'user',
      text,
      ...(images !== undefined && images.length > 0 ? { images } : {}),
    })
    this.enqueueTurn()
  }

  /**
   * 改一条排队中的输入（回合跑动中提交、还没出账的那些）。
   * @returns 是否真的改了；越界（等到出账了）返回 false，界面据此提示。
   */
  editQueued(index: number, text: string): boolean {
    const changed = this.session.editAsync(index, text)
    if (changed) this.deps.emit({ type: 'inbox' })
    return changed
  }

  /** 撤掉一条排队中的输入：它还没进对话，撤了就等于没发过。 */
  removeQueued(index: number): boolean {
    const changed = this.session.removeAsync(index)
    if (changed) this.deps.emit({ type: 'inbox' })
    return changed
  }

  /**
   * 插话（对照 dsh 的 steer）：把要插的那条提到队首，并打断当前回合——回合收尾
   * 出账时它先落库，紧接着自动补一轮，模型下一句话就先看它。
   *
   * 为什么要打断：dsc 的收件箱本来就在**下一个步骤边界**自动并进当前回合
   * （见 runTurn 里的 drainInbox(true)），所以「排在后面等」与「插话」的差别只剩
   * 「模型现在正在吐的这段话要不要说完」。要更快，只能打断——半截回复按 T33 的
   * 规矩保留为截断的 assistant 记录，输入一条不丢。
   *
   * @param index - 提到队首的那一条；省略则保持原顺序把整队送进去。
   * @returns 是否真的插上了；agent 没在跑（队列马上就会自己出账）时返回 false。
   */
  steerQueued(index?: number): boolean {
    if (!this.running) return false
    // 队列空了就绝不打断：界面按「提交那一刻的队列长度」算下标，而这一轮可能在
    // 提交与插话之间刚好跑完——那时消息已经作为新一轮发出去（不在队列里），
    // 不设这道闸就会把刚开始的那一轮白打断。
    const items = this.session.asyncInbox()
    if (items.length === 0) return false
    if (index !== undefined) {
      if (items[index] === undefined) return false
      this.session.promoteAsync(index)
    }
    this.deps.emit({ type: 'inbox' })
    this.cancel()
    return true
  }

  cancel(): void {
    this.abort?.abort()
  }

  private enqueueTurn(): void {
    if (this.running) {
      this.pendingTurn = true
      return
    }
    this.running = true
    void this.runTurn()
      .catch(() => {})
      .finally(() => {
        this.running = false
        // 关窗补出账：turn/end 事件发在 runTurn 内部，事件监听里紧跟的 followup
        // （界面解锁后用户立刻发话、探针连发两条）会在 running 仍为 true 时入箱，
        // 而上一轮的收尾出账已经跑过——这里不补一次，这条输入就永远没人出账。
        this.drainInbox(false)
        if (this.pendingTurn) {
          this.pendingTurn = false
          this.enqueueTurn()
        }
        // 完全闲下来（没排下一轮）才报 idle：常驻注册表据此收掉「用户已经切走、
        // 又没活干」的 agent，释放会话写租约；正被查看的 agent 由监听方自行豁免。
        if (!this.running) this.deps.onIdle?.()
      })
  }

  /**
   * 收件箱出账：把排队中的异步输入落到对话历史。
   *
   * 两个调用点（对照 dsh 的 claim 时机）：
   * - **步骤边界**（`midTurn = true`）：工具结果已闭合，消息以 steering 身份并入本轮，
   *   下一轮请求自然带上——不多花回合。
   * - **回合收尾**（`midTurn = false`）：消息悬在最后一条 assistant 之后，挂起
   *   pendingTurn 让模型接话；正在跑的回合收不了尾时输入也不会丢。
   *
   * 0.6.67 起 user 事件在这里发（而不是入箱时）：排队的消息在这一刻才真正进对话，
   * 界面上也就这一刻才画气泡——入箱期间它是输入框下方的队列条（快照的 `queued`）。
   * `steering` 按出账时机标：步骤边界并进本轮的算轮中途插话（界面上带 ↩），
   * 收尾出账的那批属于下一轮，不是插话。
   */
  private drainInbox(midTurn: boolean): void {
    const items = this.session.takeAsyncInbox()
    if (items.length === 0) return
    for (const item of items) {
      this.session.appendUser(item.text, item.images)
      this.deps.emit({
        type: 'user',
        text: item.text,
        ...(item.images !== undefined && item.images.length > 0 ? { images: item.images } : {}),
        ...(midTurn ? { steering: true } : {}),
      })
    }
    if (!midTurn) this.pendingTurn = true
  }

  private async runTurn(): Promise<void> {
    const abort = new AbortController()
    this.abort = abort
    // 0.6.48 常驻模型起一个 agent 只认一个会话：收尾聚合、收件箱出账都落在
    // 自己的会话里，不存在「会话已切走」的归属问题。
    this.turnActive = true
    this.deps.emit({ type: 'turn/start' })
    // T42：回合起点的 git 快照异步起跑，收尾才等它——write/edit 之外（bash/sed/构建
    // 脚本）动过的文件靠「起点 vs 终点」的 porcelain 差集兜底进轮尾卡。
    const gitStart = snapshotGitStatus(this.cwd)
    try {
      await this.deps.beforeRequest?.(abort.signal)
      if (abort.signal.aborted) throw new Error('aborted')
      for (;;) {
        let result: StreamResult
        try {
          result = await this.requestOnce(abort.signal)
        } catch (error) {
          // 上下文爆窗：强制压缩一次再重试这轮请求（只试一次，压不出空间就把原错误抛回去）。
          if (
            abort.signal.aborted ||
            this.deps.onContextOverflow === undefined ||
            !isContextOverflowError(error)
          ) {
            throw error
          }
          if (!(await this.deps.onContextOverflow(abort.signal))) throw error
          result = await this.requestOnce(abort.signal)
        }
        if (abort.signal.aborted) break
        if (result.toolCalls.length === 0) break
        await this.executeToolCalls(result, abort.signal)
        // 步骤边界（对照 dsh 的 preStep claim）：上一步的结果已闭合，收件箱此刻出账
        // 落库，下一轮请求自然带上——作业通知合并进本轮，不多花一个回合。
        this.drainInbox(true)
      }
      this.deps.emit({ type: 'turn/end', reason: abort.signal.aborted ? 'aborted' : 'completed' })
    } catch (error) {
      if (abort.signal.aborted) {
        this.deps.emit({ type: 'turn/end', reason: 'aborted' })
      } else {
        this.deps.emit({ type: 'error', message: errText(error) })
        this.deps.emit({ type: 'turn/end', reason: 'error' })
      }
    } finally {
      // turn/end 已经发出：从这一刻起 busy 不再把本回合算作「在跑」——
      // 剩下的只有异步收尾（出账 + git 聚合），切走的归属决策不等它。
      this.turnActive = false
      this.abort = null
      // 收尾出账：最后一步之后/流式定稿期间入箱的输入还欠着，这里落库（dsh：回合
      // 不许隔着未交货的收件箱收尾）。落库后它们悬在最后一条 assistant 之后，补一轮
      // 让模型接话。出错/打断一样算——输入不该因为回合失败而蒸发。
      this.drainInbox(false)
      // 收尾聚合（成功/中断/出错一样算——改了的文件如实展示）。条目按「下一条用户消息
      // 之前归当前轮」的口径落位，晚于 turn/end 也能进这一轮的轮尾卡区间。
      try {
        const files = await this.session.takeTurnChanges()
        // T42：git 快照差集补上 bash/脚本改的文件（write/edit 已记的路径不重复）
        const extra = await collectGitTurnChanges(this.cwd, await gitStart, await snapshotGitStatus(this.cwd), files.map((file) => file.path))
        files.push(...extra)
        if (files.length > 0) this.deps.emit({ type: 'turn/diff', files })
      } catch {
        // 聚合失败不遮回合本身的结果
      }
    }
  }

  /**
   * 一轮模型请求：流式增量 → emit；定稿 → 落库 + emit message/usage。
   * T33：流已开始后中断且已收到内容时，半截先落库成截断的 assistant 记录，
   * 再自动整轮重试一次（消息按会话现状重新组装——半截已经在里面了，模型顺着续）。
   */
  private async requestOnce(signal: AbortSignal): Promise<StreamResult> {
    for (let attempt = 1; ; attempt += 1) {
      const route = this.deps.route()
      const tools = this.deps.tools()
      const assembled: ChatMessage[] = [
        { role: 'system', content: this.deps.systemPrompt() },
        ...this.session.messages,
      ]
      const messages =
        this.deps.rewrite === undefined ? assembled : this.deps.rewrite(assembled, this.session)
      // context 条的分段在请求组装完、流还没开的时候画出来：模型还没吐字，
      // 界面就能显示这次的上下文由什么组成（每次重算，压缩/滚出自动重置）。
      this.deps.emit({ type: 'context', segments: estimateRequestSegments(messages) })
      try {
        const result = await this.deps.stream(
          route.api,
          {
            baseUrl: route.baseUrl,
            apiKey: route.apiKey,
            model: route.model,
            messages,
            maxTokens: route.maxTokens,
            temperature: route.temperature,
            thinking: route.thinking,
            reasoningEffort: route.reasoningEffort,
            signal,
            ...(tools.length > 0
              ? {
                  tools: tools.map(
                    (tool): ToolSchema => ({
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.parameters,
                    }),
                  ),
                }
              : {}),
          },
          {
            onDelta: (kind, text) => this.deps.emit({ type: 'delta', kind, text }),
            // 「模型决定要调什么」与「工具真的开跑」之间那段真空，界面上靠这一条才有线索
            onToolPrepare: (name) => this.deps.emit({ type: 'tool/prepare', name }),
            // 重试发生在 llm 层内部，不透出来用户只会觉得界面莫名卡了几秒
            onRetry: (attempt, reason) => this.deps.emit({ type: 'model/retry', attempt, reason }),
          },
        )
        this.session.appendAssistant(result.text, result.reasoning, result.toolCalls)
        this.deps.emit({
          type: 'message',
          text: result.text,
          reasoning: result.reasoning,
          finishReason: result.finishReason,
        })
        if (result.usage !== null) {
          this.deps.emit({
            type: 'usage',
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            ...(result.usage.cacheHitTokens === undefined ? {} : { cacheHitTokens: result.usage.cacheHitTokens }),
            ...(result.usage.cacheMissTokens === undefined ? {} : { cacheMissTokens: result.usage.cacheMissTokens }),
            model: route.model,
          })
        }
        return result
      } catch (error) {
        if (!(error instanceof StreamInterruptedError) || signal.aborted || attempt > STREAM_RECOVERY_ATTEMPTS) throw error
        this.persistPartial(error.partial)
        this.deps.emit({
          type: 'model/retry',
          attempt: attempt + 1,
          reason: `流中断，已保留半截回复并重试：${error.message}`,
        })
      }
    }
  }

  /** T33：把流中断的半截回复落库（截断的 assistant 记录，不带工具调用——参数可能不完整）。 */
  private persistPartial(partial: StreamResult): void {
    this.session.appendAssistant(partial.text, partial.reasoning, [])
    this.deps.emit({
      type: 'message',
      text: partial.text,
      reasoning: partial.reasoning,
      finishReason: 'interrupted',
    })
  }

  /**
   * 执行（或拒绝）本轮全部工具调用，append 对应 tool 消息。
   *
   * 并行策略（2026-09-29）：守卫链与审批卡必须串行问（一次只能弹一张卡），
   * 但「只读且放行」的调用不必等前一个跑完——先起飞，等撞上第一个写/执行调用
   * 或本轮收尾时一起收割；结果永远按模型给的顺序落库，协议形状不变。
   */
  private async executeToolCalls(result: StreamResult, signal: AbortSignal): Promise<void> {
    const registry = new Map(this.deps.tools().map((tool) => [tool.name, tool]))
    /** 已起飞还没落库的只读调用。 */
    let flying: Array<{ call: ToolCall; outcome: Promise<ToolOutcome> }> = []
    const flushFlying = async (): Promise<void> => {
      const batch = flying
      flying = []
      const outcomes = await Promise.all(batch.map((item) => item.outcome))
      for (const [index, outcome] of outcomes.entries()) {
        this.finishCall(batch[index]!.call, outcome)
      }
    }
    for (const call of result.toolCalls) {
      // 已打断：在飞的收尾，之后每一条没开始的调用都补一条合成结果——
      // 协议要求 assistant 的每个 tool_call 都有对应 tool 消息，缺一条下轮请求就 400。
      if (signal.aborted) {
        await flushFlying()
        for (const rest of result.toolCalls.slice(result.toolCalls.indexOf(call))) {
          this.finishCall(rest, { text: '用户取消，调用未执行', stored: '用户取消，调用未执行', error: 'tool-error' })
        }
        return
      }
      this.deps.emit({ type: 'tool/call', callId: call.id, name: call.name, args: call.arguments })
      const tool = registry.get(call.name)
      if (tool === undefined) {
        await flushFlying()
        this.finishCall(call, { text: `未知工具：${call.name}`, stored: `未知工具：${call.name}`, error: 'tool-error' })
        continue
      }
      let args: Record<string, unknown>
      try {
        args = JSON.parse(call.arguments) as Record<string, unknown>
      } catch {
        await flushFlying()
        this.finishCall(call, {
          text: `参数不是合法 JSON：${summarizeArgs(call.arguments)}`,
          stored: `参数不是合法 JSON：${summarizeArgs(call.arguments)}`,
          error: 'tool-error',
        })
        continue
      }
      // 一次调用动手之前先问守卫链：模式档不许改文件、免打扰档不许弹卡、审批卡等人点头，
      // 这些都是链上的人自己说的，循环不知道也不该知道是谁。守卫（含审批卡）必须串行问。
      const verdict = await this.deps.guards.gate({
        toolName: call.name,
        risk: tool.risk,
        cwd: this.cwd,
        args,
        signal,
        // 发起调用的会话身份：审批授权按会话记账、审批卡标明来处都靠它（0.6.48）
        sessionId: this.session.meta.id,
        sessionPath: this.session.filePath,
        ...callFacts(args, this.cwd),
      })
      if (verdict.action === 'deny') {
        await flushFlying()
        this.finishCall(call, { text: verdict.reason, stored: verdict.reason, error: 'rejected' })
        continue
      }
      if (tool.risk === 'read') {
        // 只读且放行：起飞不阻塞；落库顺序由 flushFlying 保证。
        flying.push({ call, outcome: this.runTool(call, tool, args, signal) })
        continue
      }
      // 写与执行不和在飞的只读并发：先把它们收干净再动手。
      await flushFlying()
      this.finishCall(call, await this.runTool(call, tool, args, signal))
    }
    await flushFlying()
  }

  /** 跑一个工具调用并把异常折进结果里（永不 reject），正文先过遮红观察者链。 */
  private async runTool(
    call: ToolCall,
    tool: ToolEntry,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    try {
      const output = await tool.run(args, {
        cwd: this.cwd,
        signal,
        // 工具生成的后续产物（后台作业完成通知等）按会话归属投递（0.6.48）
        sessionId: this.session.meta.id,
        sessionPath: this.session.filePath,
      })
      const rawText = typeof output === 'string' ? output : output.text
      // 工具结果里的密钥形状字符串不进会话日志，也不回显给模型（遮红挂在观察者链上）。
      const text = this.deps.guards.observe(call.name, rawText)
      const images = typeof output === 'string' ? undefined : output.images
      const changes = typeof output === 'string' ? undefined : output.changes
      // baseline 是回合基线记账的内存字段：单独摘到 outcome 上，事件与落盘形状里不留它。
      const baseline = changes?.baseline
      const clean = changes !== undefined ? stripBaseline(changes) : undefined
      const stored: string | { text: string; images?: string[]; changes?: FileChangeSummary } =
        text === rawText && clean === undefined
          ? output
          : images !== undefined && images.length > 0
            ? { text, images, ...(clean === undefined ? {} : { changes: clean }) }
            : { text, ...(clean === undefined ? {} : { changes: clean }) }
      const imageNote = images !== undefined && images.length > 0 ? `\n[附 ${images.length} 张截图]` : ''
      return {
        text: text + imageNote,
        stored,
        ...(baseline !== undefined ? { baseline } : {}),
        ...(clean === undefined ? {} : { changes: clean }),
      }
    } catch (error) {
      const message = errText(error)
      return { text: message, stored: message, error: 'tool-error' }
    }
  }

  /** 落库一条 tool 消息并广播结果事件。 */
  private finishCall(call: ToolCall, outcome: ToolOutcome): void {
    this.session.appendTool(call.id, call.name, outcome.stored, outcome.error)
    this.deps.emit({
      type: 'tool/result',
      callId: call.id,
      text: outcome.text,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    })
    // 成功的落盘类调用随带真实改动：界面聚合成轮尾「文件已更改」卡
    if (outcome.error === undefined && outcome.changes !== undefined) {
      // 改前全文记进回合基线：轮尾聚合 diff = 回合起点 vs 盘上终态（同文件多刀合一）
      if (outcome.baseline !== undefined) this.session.recordTurnChange(outcome.changes.path, outcome.baseline)
      this.deps.emit({ type: 'tool/changes', callId: call.id, change: outcome.changes })
    }
  }
}

export { LlmError }

/** 一次工具调用的落库与广播产物（runTool 保证永不 reject）。 */
type ToolOutcome = {
  /** 发给界面与模型的文本（已过遮红；带图时附截图说明）。 */
  text: string
  /** 落进会话日志的形状（带图 / 带文件改动时是对象）。 */
  stored: string | { text: string; images?: string[]; changes?: FileChangeSummary }
  /** undefined = 成功；tool-error = 执行失败；rejected = 被守卫拒绝。 */
  error?: 'tool-error' | 'rejected'
  /** 成功的 write / edit 附带的真实改动（发 `tool/changes` 事件用，不带 baseline）。 */
  changes?: FileChangeSummary
  /** 这次落盘前的文件全文（回合基线记账用，纯内存；不进事件与日志）。 */
  baseline?: string
}
