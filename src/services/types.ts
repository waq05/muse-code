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
import type { ProviderConfig } from '../core/config.js'
import type { Session } from '../core/session.js'
import type { ChatMessage } from '../core/llm.js'
import type { ToolEntry } from '../core/tools.js'
import type { CoreEvent } from '../core/events.js'
import type { SkillDefinition, SkillSummary } from '../core/skills.js'
import type { DscPrefs } from '../core/prefs.js'
import type {
  ApprovalAnswer,
  ApprovalPolicy,
  ApprovalRequestView,
  ArchivedPage,
  ArchivedSessionView,
  DscRuntime,
  EffortLevel,
  MarketBrowseResult,
  MarketSkillView,
  ModelChoiceView,
  ModelConfigView,
  ProviderDraft,
  RuntimeSnapshot,
  TeammateView,
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

/** 每次请求的模型路由。 */
export interface LlmRoute {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens?: number
  temperature?: number
  /** 思考开关注入；undefined = 不发 thinking 字段（端点默认行为）。 */
  thinking?: 'enabled' | 'disabled'
}

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
  /** 组装当前路由；端点缺失时抛错（调用方负责转 system 条目）。 */
  route(): LlmRoute
  /**
   * 按指定端点/模型/思考强度组路由，不改动当前选择。
   * 子智能体用它跑角色自己指定的模型；端点或模型不存在时抛错。
   */
  routeTo(provider: string, model: string, effort: EffortLevel): LlmRoute
  /** 校验并切换端点/模型；失败抛错（消息可直接展示）。 */
  setModel(provider: string, model: string): void
  /** 设置思考强度档位（off=关闭思考，low/high/max=开启思考）。 */
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
  /** 切换权限模式（写 system 条目告知模型与用户）。 */
  setPolicy(policy: ApprovalPolicy): void
  /** 当前挂起的审批视图；null = 无。 */
  pendingView(): ApprovalRequestView | null
  /** 应答当前挂起审批（无挂起时静默忽略）。 */
  answer(answer: ApprovalAnswer): void
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
  /** 恢复会话时把历史消息重放为条目（启动恢复/session-open 场景）。 */
  replayHistory(messages: readonly ChatMessage[]): boolean
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
}

// ── agent ────────────────────────────────────────────────────────────────────

/** Agent 服务：ReAct 循环的对外操作面。 */
export interface AgentService {
  /** 提交一条用户消息（排队执行）。 */
  followup(text: string): void
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
   */
  register(id: string, text: () => string): () => void
  /**
   * 注册一个请求体改写函数。只改发出去的那份，会话日志不动。
   * 典型用法：电脑操作插件只保留最近一张截图，旧截图留在历史里除了撑上下文没有用。
   */
  transformMessages(fn: (messages: ChatMessage[]) => ChatMessage[]): () => void
  /** 拼好的附加提示文本（内置 agent 组装请求时用，插件不必直接调）。 */
  extraText(): string
}

// ── team ─────────────────────────────────────────────────────────────────────

/**
 * 子智能体团队服务：由 subagent 插件提供，插件关着时这个服务不存在（可选属性）。
 * 侧栏的「队友」列表与只读查看都走它，UI 因此不必知道队友文件放在哪。
 */
export interface TeamService {
  /** 队友清单，含已经收工的（来自 `~/.dsc/team/roster.json`）。 */
  list(): TeammateView[]
  /** 只读重放一个队友的运行记录，返回可渲染的对话条目。 */
  peek(file: string): Promise<TranscriptEntry[]>
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
  /** 注册一个设置分区；返回退订函数。 */
  registerSection(section: SettingsSectionSpec): () => void
  /** 分区清单（按 order 排序，内置标记 builtin）。 */
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

// ── cordis 声明合并 ──────────────────────────────────────────────────────────

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmService
    session: SessionService
    approval: ApprovalService
    tools: ToolService
    transcript: TranscriptService
    commands: CommandService
    compact: CompactService
    agent: AgentService
    /** 请求组装扩展点（附加系统提示 + 请求体改写）。 */
    prompt: PromptService
    /** 子智能体团队（subagent 插件提供；插件没开时不存在）。 */
    team?: TeamService
    /** 技能服务（发现/启停/市场/模型可见目录）。 */
    skills: SkillService
    /** 设置服务（分区注册表 + 模型配置 + 偏好）。 */
    settings: SettingsService
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
    'dsc/notice'(text: string): void
    'dsc/session-open'(payload: SessionOpenPayload): void
    'dsc/exit'(): void
    /** 命令 handler 请求打开会话选择面板（/resume；UI 桥转发给宿主壳）。 */
    'dsc/open-picker'(): void
    /** dock 终端输出流（desktop-dock 服务 → 桌面端面板）。 */
    'dsc/dock-data'(id: string, data: string): void
    /** 技能清单或启停状态变化（agent 据此重算模型可见目录）。 */
    'dsc/skills-changed'(): void
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
