/**
 * UI ⇄ adapter 的共享契约（单一真源）。
 *
 * 边界规则（对齐 dsh-TUI 的 adapter 边界实践）：
 *   - `src/adapter/**` 是唯一允许 import `@deepseek-ai/*` 运行期包的层；
 *   - UI 层（src/app/**、src/state/**、src/commands.ts）只依赖本文件的
 *     中立类型，通过 DscRuntime 与宿主世界交互；
 *   - 本文件自身不得 import 任何 @deepseek-ai/*。
 */

/** deepseek adapter 的思考强度档位。default = 不声明 thinking 字段（跟随端点默认）。 */
export type EffortLevel = 'default' | 'off' | 'low' | 'high' | 'max'

/**
 * 权限模式（工具执行的沙箱策略）：
 *   readonly     —— 仅查看：write/exec 类工具一律拒绝，不弹审批；
 *   auto-edit    —— 工作区自动编辑：目标在工作目录内的写工具自动放行，
 *                   其余（工作区外写入、exec 类）走人工审批卡；
 *   full-access  —— 完全访问：全部工具自动放行；
 *   ai-review    —— AI 自动审查：由模型逐次判断是否放行，失败回退人工审批。
 */
export type ApprovalPolicy = 'readonly' | 'auto-edit' | 'full-access' | 'ai-review'

/** 一次工具调用的展示状态。 */
export type ToolStatus = 'running' | 'done' | 'failed' | 'rejected'

/** 工具卡片视图：参数原文 +（完成后的）结果摘要。 */
export interface ToolCallView {
  callId: string
  name: string
  /** 模型产出的原始 arguments JSON 字符串（截断由 UI 决定）。 */
  argsText: string
  /** 工具结果文本（可能为空：无结果或尚未完成）。 */
  resultText?: string
  status: ToolStatus
}

/**
 * 会话流里的一条可渲染条目。adapter 把 session/event 折叠成这个序列，
 * UI 只读消费；`id` 单调递增、仅在本会话生命周期内唯一。
 */
export type TranscriptEntry =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'thinking'; id: number; text: string }
  | { kind: 'text'; id: number; text: string }
  | { kind: 'tool'; id: number; call: ToolCallView }
  | { kind: 'system'; id: number; text: string }

/** 会话累计 token 用量。 */
export interface TokenUsageView {
  inputTokens: number
  outputTokens: number
}

/** 底部状态行数据。 */
export interface StatusView {
  sessionId: string | null
  /** 当前模型名；未知时 'unknown'。 */
  model: string
  effort: EffortLevel
  /** 当前权限模式（工具执行的沙箱策略）。 */
  policy: ApprovalPolicy
  turnState: 'idle' | 'thinking' | 'working' | 'awaiting-approval'
  usage: TokenUsageView | null
}

/** 待用户决定的工具审批请求（视图投影）。 */
export interface ApprovalRequestView {
  /** adapter 内部关联 id；answerApproval 不需要它（同一时刻至多一个挂起审批）。 */
  id: string
  toolName: string
  /** 参数摘要（单行、已截断）。 */
  argsSummary: string
}

/** 审批应答。v1 只提供一次性决定（对齐官方 ACP 桥的 one-shot 语义）。 */
export type ApprovalAnswer = 'allow-once' | 'reject'

/** /resume 会话选择器的一行。 */
export interface SessionSummary {
  id: string
  cwd: string
  createdAt: number
  /** 会话标题（session-title / session/title 事件投影），未知时 undefined。 */
  title?: string
}

/** 插件管理页的一行（内置/外部统一投影；宿主启动时扫描的快照）。 */
export interface PluginInfoView {
  /** 开关键：外部插件为文件名，内置为插件名。 */
  file: string
  /** 显示名（外部插件取其 name 导出，缺省为去后缀文件名）。 */
  name: string
  description: string
  enabled: boolean
  source: 'builtin' | 'external'
  /** 插件声明的内核 API 版本；未声明时 undefined。 */
  apiVersion?: number
  /** 加载失败/被自动停用的原因（回滚说明），正常时 undefined。 */
  problem?: string
}

/** 可切换的模型（/model 补全与校验的数据源）。 */
export interface ModelChoiceView {
  /** 可直接传给 /model 的完整值：`[端点/]模型名`。 */
  value: string
  provider: string
  model: string
  /** 面板展示用说明（端点显示名 · 上下文窗口）。 */
  description: string
}

/** UI 每帧读取的运行时快照（useSyncExternalStore 的 getSnapshot 返回）。 */
export interface RuntimeSnapshot {
  entries: TranscriptEntry[]
  status: StatusView
  /** 同一时刻至多一个挂起审批；null = 无。 */
  pendingApproval: ApprovalRequestView | null
  /** refreshSessions() 填充的会话列表缓存。 */
  sessions: SessionSummary[]
  sessionsLoading: boolean
}

/**
 * adapter 实现、UI 消费的唯一运行期接口。
 *
 * 约定：
 *   - subscribe/getSnapshot 遵循 useSyncExternalStore 语义（快照引用在两次
 *     notify 之间稳定）；
 *   - 所有方法不得抛出未捕获异常到 UI；失败经 entries 追加 kind:'system'
 *     条目报告；
 *   - openSession(undefined) 新建会话并切换；openSession(id) 恢复之；
 *     切换时清空 entries。
 */
export interface DscRuntime {
  subscribe(listener: () => void): () => void
  getSnapshot(): RuntimeSnapshot
  /** 提交一条用户消息（走 agent.followup）。 */
  submit(text: string): void
  /** 尝试取消当前回合（M4 前可为 no-op + system 提示）。 */
  interrupt(): void
  openSession(id?: string): Promise<void>
  compact(): Promise<void>
  setModel(model: string): Promise<void>
  setEffort(effort: EffortLevel): Promise<void>
  /** 异步刷新 sessions 列表（结果写回快照的 sessions/sessionsLoading）。 */
  refreshSessions(): Promise<void>
  /** 可切换的模型列表（进程内静态，UI 可在挂载时取一次）。 */
  listModels(): ModelChoiceView[]
  /** 插件清单（内置 + 外部；宿主启动时扫描的快照）。 */
  listPlugins(): PluginInfoView[]
  /** 更新外部插件启用状态（热生效：热挂载/卸载，写 ~/.dsc/plugins.json 持久化）。 */
  setPluginEnabled(file: string, enabled: boolean): void
  /** 切换权限模式（readonly / auto-edit / full-access / ai-review）。 */
  setPolicy(policy: ApprovalPolicy): void
  /** 派发一条 / 命令到宿主命令注册表（内置 + 外部插件命令统一）。 */
  runCommand(input: string): boolean
  /**
   * 桌面端 dock 面板的工作区能力（desktop-dock 服务透传）：
   * fs-list / fs-read / git-status / git-stage / git-unstage / git-commit / git-log / git-diff。
   */
  dock(op: string, payload?: Record<string, unknown>): Promise<unknown>
  answerApproval(answer: ApprovalAnswer): void
  /** 退出应用（dispose → 进程结束）。 */
  exit(): void
  /** 释放全部资源（dispose agent、退订）；集成层在 ink unmount 后调用。 */
  dispose(): void
}
