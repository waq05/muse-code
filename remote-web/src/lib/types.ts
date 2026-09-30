/**
 * 遥控端消费的契约子集。
 *
 * 这些类型跟宿主 `src/contract.ts` 是同一份东西的另一份拷贝：那个文件在宿主进程里，
 * 浏览器这边 import 不到（也不该 import——它连着 Node 侧的模块图）。所以这里只抄
 * 「遥控界面真正读的字段」，抄写纪律是：
 *
 *   1. 字段名与可选性必须与 contract.ts 逐字对齐，改那边就回来改这里；
 *   2. 只在注释里写清口径，不在这里加派生逻辑（派生在 protocol.ts）。
 *
 * 另外，快照是**跨版本**过来的：批 A 的插件升级、界面还没重新部署时，字段可能缺。
 * 因此协议层（protocol.ts）拿到的是 `unknown`，一律按「可能缺」归一化后再交给组件；
 * 本文件的类型描述的是「归一化之后」的形状，组件可以放心直接读。
 */

/** 思考强度档位。 */
export type EffortLevel = 'default' | 'off' | 'low' | 'high' | 'max'

/** 一次工具调用的展示状态。 */
export type ToolStatus = 'running' | 'done' | 'failed' | 'rejected'

/** 工具卡片视图（字段口径见宿主 src/contract.ts 的 ToolCallView）。 */
export interface ToolCallView {
  callId: string
  name: string
  argsText: string
  resultText?: string
  status: ToolStatus
  startedAt?: number
  durationMs?: number
}

/** 压缩落点标记（第几次压缩，1 基）。 */
export interface CompactionMark {
  count: number
}

/** 计划评审卡的状态。 */
export type PlanDecision = 'pending' | 'approved' | 'rejected'

/** 一份待批的计划。 */
export interface PlanView {
  file: string
  title: string
  text: string
  decision: PlanDecision
}

/** 会话流里的一条可渲染条目（与宿主 TranscriptEntry 的六种 kind 一一对应）。 */
export type TranscriptEntry =
  | { kind: 'user'; id: number; text: string; images?: string[]; ts?: number; compaction?: CompactionMark }
  | { kind: 'thinking'; id: number; text: string; ts?: number }
  | {
      kind: 'text'
      id: number
      text: string
      ts?: number
      usage?: { inputTokens: number; outputTokens: number }
    }
  | {
      kind: 'tool'
      id: number
      call: ToolCallView
      ts?: number
      usage?: { inputTokens: number; outputTokens: number }
    }
  | { kind: 'plan'; id: number; plan: PlanView; ts?: number }
  | { kind: 'system'; id: number; text: string; ts?: number; compaction?: CompactionMark }

/** 一轮的 token 用量（输入 + 输出）。 */
export interface TokenUsageView {
  inputTokens: number
  outputTokens: number
}

/** 引擎的回合状态。 */
export type TurnState = 'idle' | 'thinking' | 'working' | 'awaiting-approval'

/** 底部状态行（遥控端只用 turnState 与 usage，其余字段容错忽略）。 */
export interface StatusView {
  sessionId: string | null
  model: string
  effort: EffortLevel
  turnState: TurnState
  usage: TokenUsageView | null
}

/** 待用户决定的工具审批请求。 */
export interface ApprovalRequestView {
  id: string
  toolName: string
  argsSummary: string
  reason: string
  risk: 'low' | 'medium' | 'high' | 'critical'
  suggestedRule: string[] | null
  hardline: boolean
  scopes: Array<'once' | 'session' | 'always'>
  policy: string
  mode: string
}

/** 审批应答的四个决定。 */
export type ApprovalAnswer = 'allow-once' | 'allow-session' | 'allow-always' | 'reject'

/** 模型提问里的一个选项。 */
export interface AskOptionView {
  label: string
  description?: string
}

/** 一批提问里的一题。 */
export interface AskQuestionItem {
  question: string
  header?: string
  options: AskOptionView[]
  multiSelect: boolean
  allowFreeText: boolean
}

/** 模型发起的一次提问。 */
export interface AskUserView {
  id: string
  question: string
  header?: string
  options: AskOptionView[]
  multiSelect: boolean
  allowFreeText: boolean
  questions?: AskQuestionItem[]
}

/** 任务清单的一条。 */
export interface TodoItemView {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  parent?: string
}

/** 任务清单投影。 */
export interface TodoView {
  items: TodoItemView[]
  revision: number
  done: number
  total: number
  active: string | null
}

/** 侧栏/列表里的一条会话。 */
export interface SessionSummary {
  id: string
  cwd: string
  createdAt: number
  updatedAt: number
  title?: string
  pinnedAt?: number
  archivedAt?: number
}

/** 归档区的一行。 */
export interface ArchivedSessionView {
  path: string
  cwd: string
  title?: string
  createdAt: number
  updatedAt: number
  archivedAt: number
}

/** 归档页的一页数据。 */
export interface ArchivedPage {
  items: ArchivedSessionView[]
  trashDir: string
  trashCount: number
}

/**
 * 快照里各功能点贡献的界面片段（归一化之后的形状）。
 *
 * `pendingTodos` 与 `todos` 都留着：批 A 的契约里写的是 `surfaces.pendingTodos`，
 * 而宿主 core 的 RuntimeSurfaces 用的是 `todos`——两个键都认，谁在就用谁。
 */
export interface RemoteSurfaces {
  pendingApproval: ApprovalRequestView | null
  pendingPlan: PlanView | null
  pendingQuestion: AskUserView | null
  pendingTodos: TodoView | null
}

/** 归一化之后的快照：遥控界面的全部数据源。 */
export interface RemoteSnapshot {
  seq: number
  cwd: string | null
  sessionId: string | null
  /** 已定稿的历史条目。 */
  entries: TranscriptEntry[]
  /** 还在长的直播尾（同一 id 内容会变）。 */
  liveEntries: TranscriptEntry[]
  status: StatusView | null
  surfaces: RemoteSurfaces
  /** 宿主 cached 的会话列表（refreshSessions 之后由快照带回来）。 */
  sessions: SessionSummary[]
}
