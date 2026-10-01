/**
 * 服务契约：内置插件 provide 的全部服务接口 + cordis Context/Events 声明合并。
 *
 * 「万物皆插件」的类型边界：插件只 import 本文件、core/ 实现库与 contract.ts，
 * 服务之间通过 ctx.<name> 访问、通过 dsc/* 事件解耦（禁止直接 import 其他插件）。
 *
 * 事件约定：
 *   - `dsc/changed`      —— 任何影响快照的状态变化后发出（transcript 据此失效缓存）；
 *   - `dsc/notice`       —— 请求写一条 system 条目（transcript 监听）；
 *   - `dsc/session-open` —— 会话已切换（transcript 清空条目、agent 换会话）；
 *   - `dsc/exit`         —— 请求收尾（session close、approval 放行挂起、UI unmount），
 *                          监听器同步执行，随后宿主自行决定是否退进程。
 *
 * @module dsc/services
 */
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from '../core/approval.js'
import type { AuditRecord } from '../core/audit.js'
import type { HookJudgement, HooksDoc, HookTrust } from '../core/hooks.js'
import type { MemoryCell, MemoryConfig, MemoryOperation, MemoryWriteResult, WriteOptions } from '../core/memory.js'
import type { ProviderConfig } from '../core/config.js'
import type { Session } from '../core/session.js'
import type { ChatMessage, LlmAdapter, LlmRoute, StreamHandlers, StreamRequest, StreamResult } from '../core/llm.js'
import type { ToolEntry } from '../core/tools.js'
import type { CoreEvent } from '../core/events.js'
import type { SkillDefinition, SkillSummary } from '../core/skills.js'
import type { DscPrefs } from '../core/prefs.js'
import type { ToolGuard, ToolGuardChain, ToolObserver } from '../core/tool-guards.js'
import type { GoalStore } from '../core/goal.js'
import type { PromptContribution } from '../core/prompt.js'
import type { TodoWriteResult } from '../core/todo.js'
import type {
  ApprovalAnswer,
  ApprovalPolicy,
  ApprovalRequestView,
  ArchivedPage,
  ArchivedSessionView,
  AskQuestionItem,
  AskUserView,
  AskUserViewInput,
  CollaborationMode,
  DscRuntime,
  EffortLevel,
  GoalView,
  MarketBrowseResult,
  MarketSkillView,
  ModelChoiceView,
  ModelConfigView,
  Modality,
  ModeSurface,
  PlanDecision,
  PlanView,
  PolicySurface,
  ProviderDraft,
  RuntimeSnapshot,
  RuntimeSurfaces,
  TeammateView,
  TodoView,
  TranscriptEntry,
  SessionForkResult,
  SessionSummary,
  SettingsField,
  SettingsMutation,
  SettingsSectionView,
  SettingsValue,
  SettingsValues,
  SkillInfoView,
  SkillLoadResult,
} from '../contract.js'

/** 服务方法允许同步或异步返回（插件提供方常要联网）。 */
export type MaybePromise<T> = T | Promise<T>

/** 会话切换事件负载。 */
export interface SessionOpenPayload {
  /** 新会话实例。 */
  session: Session
  /** undefined = 新建；否则为恢复的 jsonl 路径。 */
  filePath: string | undefined
}

// ── llm ──────────────────────────────────────────────────────────────────────

/** 每次请求的模型路由（定义在 core/llm，这里转出口供插件引用；文件头已同时引入本地绑定）。 */
export type { LlmRoute } from '../core/llm.js'

/** 模型端点路由服务（provider/model 热切换的唯一状态持有者）。 */
export interface LlmService {
  /** 当前端点名。 */
  get provider(): string
  /** 当前模型名。 */
  get model(): string
  /** 当前思考强度档位；'default' = 不声明 thinking 字段（跟随端点默认）。 */
  get effort(): EffortLevel
  /** 当前模型上下文窗口（未知模型按 128k）。 */
  get contextWindow(): number
  /** 当前模型声明的输入模态（没勾照片时，图像在发请求前换成一句说明）。 */
  get inputModalities(): Modality[]
  /** 组装当前路由；端点缺失时抛错（调用方负责转 system 条目）。 */
  route(): LlmRoute
  /**
   * 按指定端点/模型/思考强度组路由，不改动当前选择。
   * 子智能体用它跑角色自己指定的模型；端点或模型不存在时抛错。
   */
  routeTo(provider: string, model: string, effort: EffortLevel): LlmRoute
  /**
   * 注册一个模型协议适配器；端点在 config.yaml 里用 `api: <id>` 选择它。
   * 重复 id 抛错（装配错误不许静默顶替）；返回卸载函数，插件卸载时一并撤销。
   */
  registerAdapter(adapter: LlmAdapter): () => void
  /**
   * 经适配器发一次流式请求。`api` 没有对应的已注册适配器时抛错
   * （消息可直接展示：多半是端点的 api 字段写错或提供它的插件没开）。
   */
  stream(api: string, request: StreamRequest, handlers: StreamHandlers): Promise<StreamResult>
  /** 校验并切换端点/模型；失败抛错（消息可直接展示）。 */
  setModel(provider: string, model: string): void
  /**
   * 设置思考强度档位（off=关闭思考，low/high/max=开启思考）。
   * 当前模型没声明这一档时抛错（消息可直接展示），越界的旧档位会随模型切换退回「默认」。
   */
  setEffort(effort: EffortLevel): void
  /** 可切换模型列表（/model 补全与校验数据源）。 */
  listModels(): ModelChoiceView[]
}

// ── session ──────────────────────────────────────────────────────────────────

/** 会话服务：当前会话持有者 + 列表缓存（快照的 sessions 字段来源）。 */
export interface SessionService {
  current(): Session
  /** 新建（undefined）或恢复指定 jsonl；成功后发出 dsc/session-open。 */
  open(filePath?: string): Promise<void>
  /** refresh() 填充的会话列表缓存。 */
  readonly sessions: SessionSummary[]
  readonly loading: boolean
  /** 启动时是否成功恢复了历史会话（宿主据此重放历史到 transcript）。 */
  readonly resumedStartup: boolean
  /** 异步刷新会话列表缓存。 */
  refresh(): Promise<void>
  /** 启动期一次性提示（如恢复失败回退），由宿主在就绪后转 system 条目。 */
  readonly startupNote: string | null
  /** 归档一批会话（移进归档区）；当前打开的会话拒绝归档。 */
  archive(paths: string[]): SettingsMutation
  /** 归档页数据（设置 → 归档的数据源）。 */
  archived(): ArchivedPage
  /** 从归档区恢复一批会话。 */
  restore(paths: string[]): SettingsMutation
  /** 永久删除一批会话（移进回收站，30 天后清）。 */
  purge(paths: string[]): SettingsMutation
  /** 改会话显示名（写 meta.json，不动 jsonl）。 */
  rename(path: string, title: string): SettingsMutation
  /** 置顶或取消置顶一个会话。 */
  setPinned(path: string, pinned: boolean): SettingsMutation
  /** 一个会话里的用户消息清单（数组下标即分叉位置）。 */
  userMessages(path: string): string[]
  /** 分叉会话：复制到第 index 条用户消息之前，成功时给新会话路径。 */
  fork(path: string, index: number): SessionForkResult
}

// ── approval ─────────────────────────────────────────────────────────────────

/** 审批服务：权限模式状态机（沙箱强制层）+ 工具执行的挂起 Promise ↔ UI 审批卡。 */
export interface ApprovalService extends ApprovalHandler {
  /** 当前权限模式。 */
  readonly policy: ApprovalPolicy
  /** 权限模式投影（当前档 + 可切清单），界面画档位按钮的数据源。 */
  surface(): PolicySurface
  /** 切换权限模式（写 system 条目告知模型与用户）。 */
  setPolicy(policy: ApprovalPolicy): void
  /** 当前挂起的审批视图；null = 无。 */
  pendingView(): ApprovalRequestView | null
  /**
   * 应答当前挂起审批（无挂起时静默忽略）。
   * @param source - 这个答案从哪儿来：省略 = 宿主界面（桌面端 / 终端），
   *                 `'web'` = 手机浏览器（远程控制）。它只进审计记录。
   */
  answer(answer: ApprovalAnswer, source?: 'app' | 'web'): void
}

// ── hooks（安全钩子）───────────────────────────────────────────────────────────

/**
 * 安全钩子服务：规则与脚本的清单、脚本批准状态、命中历史。
 * 拦与问的动作发生在守卫链里（这个服务不负责裁决），它负责让界面与 `/hooks` 看得见现状。
 */
export interface HookService {
  /** 当前配置（含读配置时发现的毛病）。 */
  doc(): HooksDoc
  /** 一条脚本的批准状态与「现在到底能不能跑」；找不到这条脚本返回 null。 */
  trustOf(id: string): HookTrust | null
  /** 只看规则会命中什么（不跑脚本），给 `/hooks` 与自检用。 */
  previewRules(input: { toolName: string; command?: string; target?: string; args?: Record<string, unknown> }): HookJudgement[]
  /** 最近若干条钩子命中记录（新的在前，从 `~/.dsc/audit.jsonl` 里挑）。 */
  recent(limit?: number): AuditRecord[]
}

// ── memory（长期记忆）──────────────────────────────────────────────────────────

/**
 * 长期记忆服务：三格清单的现状、写入入口、注入系统提示的那一栏。
 * 存储本体在 `~/.dsc/memory/`，这个服务负责让界面与 `/memory` 看得见现状。
 */
export interface MemoryService {
  /** 三格现状（含额度用量与「被外面改过」的提示）。不传 cwd 就用当前会话的工作目录。 */
  cells(cwd?: string): MemoryCell[]
  /** 当前生效的可调值。 */
  config(): MemoryConfig
  /** 写一批操作（设置页的按钮也走这条路，安检与额度一道不少）。 */
  write(operations: readonly MemoryOperation[], cwd?: string, options?: WriteOptions): MemoryWriteResult
  /** 现在注入系统提示的那一栏（可能为空串）。 */
  snapshot(): string
  /** 重算一份快照：新会话与压缩会自动做，这里留一个人工入口。 */
  refresh(): string
}

// ── mode（协作模式）────────────────────────────────────────────────────────────


/**
 * 协作模式服务：模式状态 + 注册进守卫链的那一道闸门。
 * 模式只管「这一轮允许把手伸多远」，权限模式管「问出来之后怎么裁」，两者互不越界。
 */
export interface ModeService {
  /** 当前模式（执行 / 计划 / 探索 / 免打扰）。 */
  readonly mode: CollaborationMode
  /** 协作模式投影（当前档 + 可切清单），界面画档位按钮的数据源。 */
  surface(): ModeSurface
  /** 切换模式：写会话记录（恢复会话时能还原）并广播快照失效。 */
  setMode(mode: CollaborationMode): void
}

// ── tasks（任务清单 / 计划 / 目标 / 提问）────────────────────────────────────────

/**
 * 任务面服务（todo_write 那一块）：模型自己维护、界面实时显示的清单。
 * 计划、目标、提问各自是另一个功能点，各自的插件提供各自的服务。
 */
export interface TodoService {
  /** 任务清单投影（输入框上方那条清单条的数据源）。 */
  todoView(): TodoView
  /** 写入任务清单（整表替换或按 id 合并），同时落会话记录。 */
  writeTodos(todos: readonly unknown[], merge: boolean): TodoWriteResult
  /** 清空任务清单（用户手动清）。 */
  clearTodos(): void
  /** 任务清单的提示词投影（压缩后重新注入用；空清单返回空串）。 */
  todoPrompt(): string
}

/** 计划交付服务（exit_plan_mode 那一块）：写计划文件 + 弹评审卡等用户批。 */
export interface PlanService {
  /** 挂着等批的计划；null = 无。 */
  pendingPlan(): PlanView | null
  /** 交一份计划等用户批（挂起直到批准/拒绝/中断）。 */
  proposePlan(plan: { file: string; title: string; text: string }, signal: AbortSignal): Promise<PlanDecision>
  /** 回答挂起的计划评审卡。 */
  answerPlan(decision: PlanDecision): void
}

/** 模型提问服务（ask_user 那一块）：一次提问最多几个问题、每项几个选项由插件配置决定。 */
export interface AskService {
  /** 挂着等答的提问；null = 无。多题提问整批挂在这里，视图自己带 `questions` 数组。 */
  pendingQuestion(): AskUserView | null
  /** 模型向用户提一个问题（挂起直到有答案或中断）。 */
  ask(question: AskUserViewInput, signal: AbortSignal): Promise<string>
  /**
   * 模型一次问一批（挂起直到全部答完/跳过，或中断）；返回的答案按题序与入参一一对应。
   *
   * 界面在这一批上逐题作答、统一提交，每次 `answerQuestion` 收下当前这一题的答案，
   * 收齐整批才让这个 Promise 落地——所以模型看到的是「一次调用拿回全部答案」。
   */
  askMany(questions: readonly AskQuestionItem[], signal: AbortSignal): Promise<string[]>
  /** 回答挂起的提问：第 1 次调用解决第 1 题，第 2 次解决第 2 题…… */
  answerQuestion(answer: string): void
}

/** 会话目标服务（goal 那一块）：跨轮自动续跑与它的刹车。 */
export interface GoalService {
  /** 会话目标投影；null = 没设目标。 */
  goalView(): GoalView | null
  /** 目标存储（goal 工具与自动续跑驱动器共用）。 */
  readonly goals: GoalStore
  /** 用户侧目标动作（暂停 / 继续 / 清空 / 放宽轮次上限）。 */
  goalAction(action: 'pause' | 'resume' | 'clear' | 'extend'): SettingsMutation
  /**
   * 自动续跑驱动器向目标要一轮：目标 active 且已上膛时把轮次 +1 并返回要补发给模型的话。
   * 只要还有卡片在等用户做决定，或轮次跑到上限，就返回 null（不隔着一张卡硬推）。
   */
  takeGoalRound(): string | null
}

// ── guards / surfaces / waiting（三个内核扩展点）────────────────────────────────

/**
 * 工具守卫链服务（内核 API v4）：一次工具调用动手之前该问谁。
 * 模式注册 order 10 的那一位，审批注册 order 30 的那一位；循环只问结果。
 */
export interface GuardService extends ToolGuardChain {
  /** 注册一位守卫；返回退订函数。同 id 后注册者顶掉先注册者。 */
  register(guard: ToolGuard): () => void
  /** 注册一位工具结果加工者（遮红是内置唯一一位）；返回退订函数。 */
  registerObserver(observer: ToolObserver): () => void
  /** 当前链上的守卫（按询问顺序，自检与诊断用）。 */
  readonly chain: ToolGuard[]
}

/**
 * 快照片段注册表服务（内核 API v4）：界面快照里每一块状态投影由功能点自己登记。
 * 装配快照的那一层因此不认识任何具体功能。
 */
export interface SurfaceService {
  /**
   * 登记一片投影。
   * @param id - 界面读取时用的键（同时是 RuntimeSurfaces 的那个键）。
   * @param read - 每次装配快照时调用，所以功能点改内容不用通知谁。
   * @returns 退订函数。
   */
  register<K extends keyof RuntimeSurfaces>(id: K, read: () => RuntimeSurfaces[K]): () => void
  /** 装配当前全部投影（界面快照的 surfaces 字段就是它的返回值）。 */
  build(): RuntimeSurfaces
  /** 已登记的片段键（按登记顺序，自检与诊断用）。 */
  readonly ids: string[]
}

/**
 * 「正在等人」登记表（内核 API v4）：审批卡、计划卡、提问卡各登记一位。
 * 谁想自动往下推（例如目标续跑），先问这里有没有人挂着，不必认识每张卡。
 */
export interface WaitingService {
  /** 登记一位正在等用户做决定的卡片；返回退订函数。 */
  register(id: string, pending: () => boolean): () => void
  /** 当前有哪些卡片在等人（按登记顺序）。 */
  readonly ids: string[]
  /** 是否有任何卡片在等人。 */
  readonly any: boolean
}

// ── tools ────────────────────────────────────────────────────────────────────

/** 工具注册表服务：外部插件注入新工具的唯一入口。 */
export interface ToolService {
  /** 注册一个工具；返回退订函数。 */
  register(entry: ToolEntry): () => void
  list(): ToolEntry[]
}

// ── commands ─────────────────────────────────────────────────────────────────

/** 斜杠命令元数据。 */
export interface CommandSpec {
  name: string
  /** 参数占位提示（空 = 无参数）。 */
  args: string
  description: string
}

/** 补全面板的一项（命令候选与模型候选共用）。 */
export interface CompletionItem {
  /** Tab 补全时填入输入框的完整文本。 */
  insert: string
  label: string
  description: string
}

/** 命令执行期 UI 回调。 */
export interface CommandContext {
  openPicker(): void
  notice(text: string): void
}

/** 命令处理器入参。 */
export interface CommandInvocation {
  args: string[]
  runtime: DscRuntime
  ui: CommandContext
}

export type CommandHandler = (invocation: CommandInvocation) => void

/** 命令注册表服务：内置与外部命令的单一真源。 */
export interface CommandService {
  /** 注册一条命令；返回退订函数。同名注册覆盖旧项。 */
  register(spec: CommandSpec, handler: CommandHandler): () => void
  /** 全部已注册命令（/help 与补全数据源）。 */
  specs(): CommandSpec[]
  /**
   * 执行一条 `/...` 输入；参数错误经 notice 反馈。
   * @returns 输入是否为命令（false = 普通消息）。
   */
  run(input: string, runtime: DscRuntime, ui: CommandContext): boolean
}

// ── transcript ───────────────────────────────────────────────────────────────

/** 会话流服务：core 事件折叠器 + RuntimeSnapshot 快照源（UI 状态中心）。 */
export interface TranscriptService {
  /** 折叠一条 core 事件（可见变化时自动失效快照）。 */
  emit(event: CoreEvent): void
  /** 追加一条 system 条目。 */
  system(text: string): void
  /** 追加一条计划卡条目（提交评审与批完各更新一次）。 */
  plan(view: PlanView): void
  /**
   * 恢复会话时把历史消息重放为条目（启动恢复/session-open 场景）。
   * @param toolErrors 会话日志记的工具异常标记（`Session.toolErrors`），
   *                   决定了重放出来的工具卡是「已拒绝」「失败」还是「完成」。
   */
  replayHistory(messages: readonly ChatMessage[], toolErrors?: ReadonlyMap<string, string>): boolean
  subscribe(listener: () => void): () => void
  getSnapshot(): RuntimeSnapshot
  /** 手动失效快照缓存并通知订阅者。 */
  touch(): void
}

// ── compact ──────────────────────────────────────────────────────────────────

/** 上下文压缩服务。 */
export interface CompactService {
  /** 每轮请求前的自动压缩检查（超阈值时折叠历史）。 */
  check(): Promise<void>
  /** 手动压缩（/compact），结果经 dsc/notice 反馈。 */
  run(): Promise<void>
  /**
   * 请求报「上下文装不下」时的强制压缩：忽略触发线与「历史太短」检查直接折叠一次。
   * @returns true = 确实压缩了（调用方可以重试请求）；false = 没压出空间（原样报错）。
   */
  forceCompact(): Promise<boolean>
  /**
   * 登记一段「摘要之外必须原样带过去」的文本。
   * 任务清单、会话目标这类内容经摘要模型一转就会被改写走样，所以由功能点自己登记原文；
   * 压缩插件因此不认识任何具体功能。
   * @param contribute - 每次压缩时调用，返回要附在摘要后面的文本（空串 = 这次没有）。
   * @returns 退订函数。
   */
  registerCarry(contribute: () => string): () => void
}

// ── agent ────────────────────────────────────────────────────────────────────

/** Agent 服务：ReAct 循环的对外操作面。 */
export interface AgentService {
  /**
   * 提交一条用户消息（排队执行）。
   * @param images - 随消息发送的图片（data URL 清单）。
   */
  followup(text: string, images?: string[]): void
  /** 取消当前回合。 */
  interrupt(): void
}

// ── prompt ───────────────────────────────────────────────────────────────────

/**
 * 请求组装扩展点（内核 API v3）：插件往系统提示里加一段话，或者改写要发给
 * 模型的那份消息。两者的注册都返回 disposer，插件卸载即撤销。
 */
export interface PromptService {
  /**
   * 注册一段附加系统提示。
   * @param id - 归属键（例如插件名），同名后注册者顶掉先注册的。
   * @param text - 每次组装请求时调用，所以插件改内容不用重启。
   * @param options.order - 段落位置：小的排前面。内置刻度是身份 0、做事方式 10、
   *   工具规范 20、模式条款 30、插件贡献 60（缺省）、指令文件 200、技能目录 210、模型信息 890、环境事实 900。
   *   易变的内容请往大数值放，前面的稳定段才能一直命中服务端提示缓存。
   */
  register(id: string, text: () => string, options?: { order?: number }): () => void
  /**
   * 注册一个「模型可见投影」：对发给模型的消息做一次**纯函数**改写——同一输入永远
   * 同一输出、不读不改注册表之外的任何状态。
   *
   * 这是 dsh「Model-visible ⟺ logged」不变量的个人版达成方式：会话日志只存原文，
   * 模型看见什么 = 日志原文按注册序应用全部投影的结果，投影是命名且可复算的定义，
   * 任何人拿日志都能重建请求。往请求里**加**日志上没有的内容（LSP 诊断、钩子话术）
   * 的投影，必须同时用 `session.appendNote` 把加的东西落进日志。
   *
   * @param id - 投影名（诊断与文档用）。`fold-system`、`drop-images` 是内核保留名。
   * @param options.order - 应用次序，小的先做。内置刻度：插件投影 60（缺省）、
   *   fold-system 500（多条 system 并进头部一条）、drop-images 900（模型没勾照片时兜底）。
   */
  registerProjection(id: string, fn: (messages: ChatMessage[]) => ChatMessage[], options?: { order?: number }): () => void
  /** 已注册段（带顺序），拼提示词时与内核自己的段合并；外部插件一般不必直接调。 */
  sections(): PromptContribution[]
  /**
   * 拼出这一轮要用的完整系统提示词（内置骨架 + 各注册段 + 指令文件 + 技能目录 + 环境事实）。
   * @param cwd - 会话工作目录（决定读哪份 AGENTS.md，以及环境事实那一段）。
   */
  systemPrompt(cwd: string): string
  /**
   * 按注册序应用全部投影（含内置 fold-system / drop-images），得到真正发给模型的那份消息。
   * 这条链是纯函数管道：日志原文 + 这份定义 = 模型看见的内容。
   * @param messages - 已经拼好系统提示的那份。
   */
  rewrite(messages: ChatMessage[]): ChatMessage[]
}

// ── team ─────────────────────────────────────────────────────────────────────

/**
 * 智能体团队服务：由 subagent 插件提供，插件关着时这个服务不存在（可选属性）。
 * 侧栏的「队友」列表、只读查看与管理动作都走它，UI 因此不必知道队友文件放在哪。
 */
export interface TeamService {
  /** 队友清单，含已经收工的（来自 `~/.dsc/team/roster.json`）。 */
  list(): TeammateView[]
  /** 只读重放一个队友的运行记录，返回可渲染的对话条目。 */
  peek(file: string): Promise<TranscriptEntry[]>
  /**
   * 收掉一个队友（打断当前这一轮并从在场名单里摘掉）。
   * 与 `subagent` 工具的 `stop` 是同一条路：来自用户界面，署名是用户。
   * @returns 给用户看的一句话；名字不存在时这句话就是明确的错误说明（不抛错）。
   */
  stop(name: string): Promise<string>
  /**
   * 给队友投一句话（写进它的信箱并叫醒）。与 `subagent` 工具的 `message` 同一条路。
   * @returns 给用户看的一句话；名字不存在或话是空的，这句话就是明确的错误说明（不抛错）。
   */
  message(name: string, text: string): Promise<string>
}

// ── skills ───────────────────────────────────────────────────────────────────

/**
 * 技能提供方：本地目录之外，外部插件也能挂一个技能来源（例如公司内部库）。
 * 返回的条目里 `local: false`，技能中心只展示不提供启停与导入。
 */
export interface SkillProvider {
  /** 提供方名字（进 SkillSummary.source，也用于日志）。 */
  readonly name: string
  /** 重名裁决用的小者赢；内置目录占用 100/200/300/400，插件请用 500+。 */
  readonly rank: number
  /** 列出可用技能（cwd = 当前会话工作目录，供项目级源使用）。 */
  list(cwd: string): MaybePromise<SkillSummary[]>
  /** 按名字取正文；不存在返回 undefined。 */
  get(name: string): MaybePromise<SkillDefinition | undefined>
}

/** 技能市场提供方（外部插件可挂自己的源；内置实现见 core/market.ts）。 */
export interface SkillMarketProvider {
  readonly name: string
  /** 浏览可安装条目（抛错 = 源不可用，错误原因会显示在技能中心）。 */
  browse(refresh?: boolean): MaybePromise<MarketSkillView[]>
  /** 安装到 ~/.dsc/skills/，返回一句给用户看的落点说明。 */
  install(name: string): MaybePromise<string>
}

/** 技能服务：发现、启停、正文读取与模型可见目录。 */
export interface SkillService {
  /** 全部来源合并 + 重名按 rank 裁决 + 启停过滤后的清单（技能中心数据源）。 */
  list(): SkillInfoView[]
  /** 读正文（含被停用的技能，便于技能中心预览）。 */
  read(name: string): Promise<SkillLoadResult>
  /** 启停一个本地技能（虚拟条目返回错误原因）。 */
  setEnabled(name: string, enabled: boolean): SettingsMutation
  /** 注册外部技能提供方；返回退订函数。 */
  registerProvider(provider: SkillProvider): () => void
  /** 注册外部市场源；返回退订函数。 */
  registerMarket(market: SkillMarketProvider): () => void
  /** 市场浏览（内置源 + 插件注册源）。 */
  browseMarket(source: string, refresh?: boolean): Promise<MarketBrowseResult>
  /** 市场安装。 */
  installMarketSkill(source: string, name: string): Promise<SettingsMutation>
  /** 用户级技能目录（技能中心的导入目标）。 */
  readonly userDir: string
  /**
   * 模型可见目录文本（`<available_skills>` 段）。
   * 无可用技能时返回空串，调用方据此决定是否拼接。
   */
  catalogText(): string
}

// ── settings ─────────────────────────────────────────────────────────────────

/**
 * 设置分区声明：内置分区与外部插件贡献的分区走同一套注册接口。
 * 字段清单必须可 JSON 序列化——桌面端只渲染声明，插件不提供组件。
 */
export interface SettingsSectionSpec {
  /** 分区 id，同时是 UI 的导航键；建议 `<插件名>-<分区名>`。 */
  id: string
  title: string
  subtitle?: string
  /** 导航顺序，小者在前；内置：通用 0、模型 10、技能 20、关于 900。 */
  order?: number
  /**
   * true = 这块界面由桌面端自己画（结构化数据，通用表单渲染器表达不了），
   * 此时 fields 返回空数组，数据走 SettingsService / SkillService 的专门方法。
   */
  custom?: boolean
  /**
   * true = 这个插件代管的分区要进桌面端的设置页（在插件注册时声明，见
   * {@link SettingsService.registerSection} 的第二参）。给的是「内核级功能」：
   * 桌面端设置页只列 `builtin: true` 的分区，而这些功能不属于内核自己注册的那几档。
   * 不声明时插件分区照旧只出现在插件中心那张卡上。
   */
  inSettings?: boolean
  /** 分区内的控件清单（值从 values() 取）。 */
  fields(): SettingsField[]
  /** 当前控件值（打开分区时调用）。 */
  values(): MaybePromise<SettingsValues>
  /** 控件写入；抛错或返回字符串 = 失败原因。 */
  save?(key: string, value: SettingsValue): MaybePromise<string | void>
  /** 按钮动作；返回字符串 = 完成后的提示文案。 */
  action?(name: string): MaybePromise<string | void>
}

/** 设置服务：分区注册表 + 模型配置读写 + 偏好持久化。 */
export interface SettingsService {
  /**
   * 注册一个设置分区；返回退订函数。
   * @param options.inSettings - true = 这个插件代管的分区也进桌面端设置页
   *   （投影出来的 `builtin` 为 true）。内核级功能（例如远程控制）用它；
   *   普通插件分区不传，仍旧只出现在插件中心那张卡上。
   */
  registerSection(section: SettingsSectionSpec, options?: { inSettings?: boolean }): () => void
  /** 分区清单（按 order 排序；`builtin` = 内核内置分区，或声明了 inSettings 的插件代管分区）。 */
  sections(): SettingsSectionView[]
  values(id: string): Promise<SettingsValues>
  /** 写入一个控件；分区不存在或校验失败返回错误原因。 */
  save(id: string, key: string, value: SettingsValue): Promise<SettingsMutation>
  /** 执行分区按钮。 */
  action(id: string, name: string): Promise<SettingsMutation>
  /** 模型配置全貌（读 config.yaml，缺 key 的端点也在列表里）。 */
  modelConfig(): ModelConfigView
  saveProvider(draft: ProviderDraft): SettingsMutation
  removeProvider(name: string): SettingsMutation
  setProviderKey(name: string, apiKey: string | null): SettingsMutation
  /** 写默认端点/模型，并对当前会话立即生效。 */
  setDefaultModel(provider: string, model: string): SettingsMutation
  /** 界面层偏好。 */
  prefs(): DscPrefs
  /** 合并写偏好并应用（权限模式/思考强度立即生效，市场源即时生效）。 */
  setPrefs(patch: Partial<DscPrefs>): DscPrefs
  /**
   * 监听偏好写盘：每次写成功的此刻同步回调，返回退订函数。
   * 用途是远程控制这类「开关一改就要实时起停服务」的功能点，不必去轮询 settings.json。
   */
  watchPrefs(listener: (prefs: DscPrefs) => void): () => void
  /** 宿主内核 API 版本（关于分区展示，外部插件兼容性判定的基准）。 */
  readonly kernelApiVersion: number
  /** dsc 版本号与配置路径（关于分区）。 */
  about(): { version: string; apiVersion: number; home: string; skillsDir: string; pluginsDir: string }
}

// ── desktop-dock ─────────────────────────────────────────────────────────────

/** dock 服务：桌面端面板的工作区文件系统 + git 能力（op/payload 透传协议）。 */
export interface DockService {
  /** 处理一次 dock 请求（fs-list / fs-read / git-status / git-stage / git-unstage / git-commit / git-log / git-diff）。 */
  handle(op: string, payload: Record<string, unknown>): Promise<unknown>
}

/** 一个 MCP server 的连接状态（给设置页与自检看，不进模型上下文）。 */
export interface McpServerInfo {
  name: string
  transport: 'stdio' | 'http'
  /** 这个 server 暴露了几个工具。 */
  tools: number
  state: 'ready' | 'connecting' | 'failed'
  /** state 为 failed 时的原因原文。 */
  problem?: string
}

/** 一个 MCP 工具在目录里的样子（渐进披露的检索对象）。 */
export interface McpToolInfo {
  /** 完整工具名，形如 `mcp__<server>__<tool>`；模型与守卫链看到的都是它。 */
  name: string
  server: string
  tool: string
  description: string
  /** JSON Schema（OpenAI function 参数格式）。 */
  parameters: Record<string, unknown>
  risk: 'read' | 'write' | 'exec'
}

/**
 * MCP 客户端（mcp 插件提供；插件没开时不存在）。
 *
 * 命令式四个方法构成的能力面：查连接状态、列工具目录、按真名调用、把 schema 从
 * 每轮请求里撤下。最后一个是给 Tool Search 用的——由工具目录的持有者自己决定
 * 哪些工具留在台面上，免得两处各存一份「谁可见」的判断。
 */
export interface McpService {
  /** 已配置的 server 及其连接状态。 */
  servers(): McpServerInfo[]
  /** 当前可用的 MCP 工具目录（与是否已注册进 ctx.tools 无关）。 */
  tools(): McpToolInfo[]
  /** 按完整工具名调用；结果已过防注入围栏。 */
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>
  /**
   * 把已注册进 `ctx.tools` 的动手类（write / exec）MCP 工具撤下，只留在本服务里供渐进披露；
   * 只读工具留在台面上——它们靠 `risk: 'read'` 免审批，撤下去就只剩走 `tool_call` 的审批卡。
   * 幂等。
   */
  deferSchemas(): void
}

/** 一条跨会话检索命中。 */
export interface SessionSearchHit {
  sessionId: string
  /** 会话 jsonl 的绝对路径，可直接交给 openSession 打开。 */
  file: string
  cwd: string
  /** 命中那一行属于谁：user / assistant / tool / summary。 */
  role: string
  /** 命中行的记录时间戳（毫秒）；老日志没有就是 0。 */
  ts: number
  /** 命中处前后各截一段的正文片段。 */
  snippet: string
  /** 命中所在行号（从 1 数），供精确定位。 */
  line: number
}

/** {@link SessionSearchService.search} 的可选条件。 */
export interface SessionSearchOptions {
  /** 最多返回几条，缺省由插件配置决定。 */
  limit?: number
  /** 是否把归档区（`sessions/.archived/`）也算进来。 */
  includeArchived?: boolean
  /** 只搜这个工作目录下的会话。 */
  cwd?: string
}

/**
 * 跨会话全文检索（session-search 插件提供；插件没开时不存在）。
 *
 * 检索走旁路索引，不改会话 jsonl 的主格式：索引坏了重建即可，会话历史不受影响。
 */
export interface SessionSearchService {
  /** 按关键词检索历史会话正文；中文按 bigram 切词，所以 1-2 字词也命中。 */
  search(query: string, options?: SessionSearchOptions): Promise<SessionSearchHit[]>
  /** 丢掉索引整表重建（回填用）。 */
  rebuild(): Promise<void>
  /** 索引现状：建了几个文件、多少词项、最后更新时间。 */
  stats(): { files: number; terms: number; updatedAt: number }
}

/**
 * 审批灾难地板的只读视图（approval-floor 插件提供；插件没开时不存在）。
 *
 * 地板排在守卫链最前面，它判过的东西后面的守卫看不到，所以「这条命令命中白名单」这件事
 * 必须显式交出来，由审批层去免卡放行——地板不能自己 `pass`，那会把后面的安全钩子一起跳掉。
 */
export interface ApprovalFloorService {
  /** 这条命令命中白名单前缀就返回那串词元；没命中返回 null。 */
  whitelist(command: string): readonly string[] | null
  /** 白名单当前条数（诊断与设置页用）。 */
  count(): number
}

/**
 * 沙箱档位（形制照 codex 的 `sandbox_mode`）：
 *   read-only            只读：任何写盘与越界命令都拒；
 *   workspace-write      工作区可写：工作区 + 沙箱私有临时目录可写，越界拒（默认档）；
 *   danger-full-access   不设围栏（等同关掉沙箱）。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * 沙箱的强制执行等级——「说拦得住」和「真拦得住」是两件事，这个字段说的就是后者：
 *   full     执行体真被换掉了（容器后端：网络与文件系统由内核隔离）；
 *   partial  进程内策略围栏：拦得住 dsc 自己发起的工具调用，拦不住命令内部的任意写；
 *   none     沙箱插件关着，或当前档位不设围栏。
 */
export type SandboxEnforcement = 'full' | 'partial' | 'none'

/** 一次路径判定的结果。 */
export interface SandboxCheck {
  allowed: boolean
  /** 被拒时说明命中哪条规则。 */
  reason?: string
  /** 放行时，是被哪个可写根覆盖的。 */
  root?: string
}

/**
 * 沙箱（sandbox 插件提供；插件关着时这个服务不存在，读它要用 `ctx.get('sandbox')`）。
 *
 * 对外只给「查」和「判」两类能力：别的功能（将来的 PTC、无人值守的定时任务）
 * 要问「我现在能不能写这个路径」，不必自己重算一遍白名单——白名单只有持有者该认识。
 */
export interface SandboxService {
  /** 当前档位。 */
  readonly mode: SandboxMode
  /** 强制执行等级（见 {@link SandboxEnforcement}）。 */
  readonly enforcement: SandboxEnforcement
  /** 本次会话的可写根（绝对路径，已规范化）。 */
  readonly writableRoots: readonly string[]
  /** 网络是否放行（声明式开关；策略后端只能靠环境变量与容器后端落实）。 */
  readonly networkAccess: boolean
  /** 沙箱私有临时目录（本次会话；`TMP/TEMP/HOME` 被重定向到这里）。 */
  readonly tmpDir: string
  /**
   * 判一个路径能不能写；解析失败保守拒绝。
   * @param path - 目标路径（相对路径按 cwd 展开）。
   * @param cwd - 会话工作目录（可写根的基准）；省略时用最近一次工具调用看到的工作目录。
   *   为什么要有这个参数：可写根随会话走，同一进程里不同会话的 cwd 不同；
   *   拿挂载时的 `process.cwd()` 当基准，会把别的会话的合法写入误判成越界。
   */
  canWrite(path: string, cwd?: string): SandboxCheck
  /** 当前策略的一句话摘要（系统提示与诊断用）。 */
  describe(): string
}

/**
 * 界面可达性：tui / host-stdio 这类「有人在看」的入口登记一份，没有登记就是没人能回答审批卡。
 * 审批插件据此决定是弹卡还是立刻按拒处理，不再白等一次审批超时。
 */
export interface InteractiveService {
  /** tui = 终端界面；host = 桌面端 stdio 宿主。 */
  kind: 'tui' | 'host'
  /** 现在还有人能回答审批卡吗（宿主客户端断开后为 false）。 */
  reachable(): boolean
}

// ── cordis 声明合并 ──────────────────────────────────────────────────────────

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmService
    session: SessionService
    approval: ApprovalService
    /** 协作模式（执行 / 计划 / 探索 / 免打扰）与它注册的那道守卫。 */
    mode: ModeService
    /** 任务清单（todo_write）。 */
    todo: TodoService
    /** 计划交付与评审卡（exit_plan_mode）。 */
    plan: PlanService
    /** 模型提问（ask_user）。 */
    ask: AskService
    /** 会话目标与自动续跑。 */
    goal: GoalService
    tools: ToolService
    transcript: TranscriptService
    commands: CommandService
    compact: CompactService
    agent: AgentService
    /** 请求组装扩展点（附加系统提示 + 请求体改写）。 */
    prompt: PromptService
    /** 工具守卫链（内核扩展点：谁想在工具动手前说话就注册一位）。 */
    guards: GuardService
    /** 快照片段注册表（内核扩展点：谁想在界面快照里有一块就登记一片）。 */
    surfaces: SurfaceService
    /** 「正在等人」登记表（内核扩展点：卡片挂没挂着一问就知道）。 */
    waiting: WaitingService
    /** 智能体团队（subagent 插件提供；插件没开时不存在）。 */
    team?: TeamService
    /** 技能服务（发现/启停/市场/模型可见目录）。 */
    skills: SkillService
    /** 设置服务（分区注册表 + 模型配置 + 偏好）。 */
    settings: SettingsService
    /** 安全钩子（用户在工具动手前自己加的规则与脚本）。 */
    hooks: HookService
    /** 长期记忆（跨会话留下的事实，写在 `~/.dsc/memory/`）。 */
    memory: MemoryService
    /** MCP 客户端（mcp 插件提供；插件没开时不存在，读它要用 `ctx.get('mcp')`）。 */
    mcp?: McpService
    /** 跨会话全文检索（session-search 插件提供；插件没开时不存在，读它要用 `ctx.get('sessionSearch')`）。 */
    sessionSearch?: SessionSearchService
    /** 审批灾难地板的只读视图（approval-floor 插件提供；插件没开时不存在，读它要用 `ctx.get('approvalFloor')`）。 */
    approvalFloor?: ApprovalFloorService
    /** 界面可达性（tui / host-stdio 入口登记；脚本环境里不存在，读它要用 `ctx.get('interactive')`）。 */
    interactive?: InteractiveService
    /** 沙箱（sandbox 插件提供；插件没开时不存在，读它要用 `ctx.get('sandbox')`）。 */
    sandbox?: SandboxService
    /** desktop-dock 服务（桌面端面板的工作区文件系统 + git）。 */
    dock: DockService
    /**
     * DscRuntime 适配器（供 UI 插件消费）。
     * 注意：不能叫 `runtime`——那是 cordis 内置的 fiber.mixin 保留属性名。
     */
    ui: DscRuntime
  }

  interface Events {
    'dsc/changed'(): void
    /**
     * 请求写一条 system 条目（transcript 监听）。
     * @param kind - 通知的类别；`'compaction'` = 这条通知是「历史刚被压缩」的落点，
     *               transcript 会给这条条目打上压缩标记（轨迹页据此切区段），
     *               省略 = 普通通知（错误、状态说明这类）。
     */
    'dsc/notice'(text: string, kind?: 'compaction'): void
    /** 计划卡内容或评审结果有变（plan 插件发出，transcript 折叠成会话流里的计划条目）。 */
    'dsc/plan'(plan: PlanView): void
    'dsc/session-open'(payload: SessionOpenPayload): void
    'dsc/exit'(): void
    /** 命令 handler 请求打开会话选择面板（/resume；UI 桥转发给宿主壳）。 */
    'dsc/open-picker'(): void
    /** dock 终端输出流（desktop-dock 服务 → 桌面端面板）。 */
    'dsc/dock-data'(id: string, data: string): void
    /** 技能清单或启停状态变化（agent 据此重算模型可见目录）。 */
    'dsc/skills-changed'(): void
    /**
     * 协作模式换了档位（mode 插件发出）。
     * 审批插件听这个把档位留在审批卡与审计记录里——它因此不必反过来依赖模式服务
     * （mode 已经依赖 approval，反向再依赖一次就是环）。
     */
    'dsc/mode-changed'(mode: CollaborationMode): void
    /**
     * 一轮对话结束（agent 发出，reason 与 CoreEvent 的 turn/end 一致）。
     * 目标续跑听这个；循环因此不认识「目标」这个功能。
     */
    'dsc/turn-end'(reason: 'completed' | 'aborted' | 'error'): void
    /**
     * 历史刚被压缩掉（compact 插件发出）。
     * 加载时冻结的东西要重算：记忆栏就是靠这个换新的一份，不然压缩后模型还在读旧事实。
     */
    'dsc/compacted'(): void
  }
}

/** 便利别名：contract/core 的公共类型统一从 services 透出（插件的唯一类型入口）。 */
export type { ProviderConfig }
export type { ApprovalDecision, ApprovalRequest }
export type { SkillDefinition, SkillSummary }
export type { DscPrefs }
export type {
  ApprovalAnswer,
  ApprovalPolicy,
  ApprovalRequestView,
  ArchivedPage,
  ArchivedSessionView,
  DscRuntime,
  EffortLevel,
  MarketBrowseResult,
  MarketSkillView,
  MarketSource,
  ModelChoiceView,
  ModelConfigView,
  Modality,
  ProviderDraft,
  ProviderModelView,
  ProviderView,
  RuntimeSnapshot,
  SessionForkResult,
  SessionSummary,
  SettingsField,
  SettingsMutation,
  SettingsOption,
  SettingsSectionView,
  SettingsValue,
  SettingsValues,
  SkillDetail,
  SkillInfoView,
  SkillLoadResult,
  StatusView,
  TokenUsageView,
  ToolCallView,
  ToolStatus,
  TranscriptEntry,
} from '../contract.js'
