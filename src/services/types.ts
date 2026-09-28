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
import type {
  ApprovalAnswer,
  ApprovalPolicy,
  ApprovalRequestView,
  DscRuntime,
  EffortLevel,
  ModelChoiceView,
  RuntimeSnapshot,
  SessionSummary,
} from '../contract.js'

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
  }
}

/** 便利别名：contract/core 的公共类型统一从 services 透出（插件的唯一类型入口）。 */
export type { ProviderConfig }
export type { ApprovalDecision, ApprovalRequest }
export type {
  ApprovalAnswer,
  ApprovalPolicy,
  ApprovalRequestView,
  DscRuntime,
  EffortLevel,
  ModelChoiceView,
  RuntimeSnapshot,
  SessionSummary,
  StatusView,
  TokenUsageView,
  ToolCallView,
  ToolStatus,
  TranscriptEntry,
} from '../contract.js'
