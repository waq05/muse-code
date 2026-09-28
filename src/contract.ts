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

/** /resume 会话选择器与侧栏的一行。 */
export interface SessionSummary {
  /** jsonl 的绝对路径（UI 侧的会话标识就是它）。 */
  id: string
  cwd: string
  createdAt: number
  /** 最后一次写入日志的时间（文件 mtime），「按最近使用」排序的键。 */
  updatedAt: number
  /** 会话标题：用户改过的名字优先，否则首条用户消息截断；都没有时 undefined。 */
  title?: string
  /** 置顶时间；undefined = 未置顶。 */
  pinnedAt?: number
}

/** 归档列表的一行（设置 → 归档）。 */
export interface ArchivedSessionView {
  /** 归档区里那个 jsonl 的绝对路径（恢复与永久删除都以它为准）。 */
  path: string
  cwd: string
  title?: string
  createdAt: number
  updatedAt: number
  /** 归档时间；老数据没记过就退化成文件时间。 */
  archivedAt: number
}

/** 归档页的一页数据：条目 + 回收站情况。 */
export interface ArchivedPage {
  items: ArchivedSessionView[]
  /** 回收站目录：永久删除的会话先进这里，保留 30 天。 */
  trashDir: string
  /** 回收站里现有的文件数（超过 30 天的在下一次读归档页时清掉）。 */
  trashCount: number
}

/** 会话排序方式：按创建时间，或按最后一次写入时间。 */
export type SessionSortKey = 'created' | 'recent'

/** 侧栏界面偏好，存在 `~/.dsc/settings.json`，桌面端与以后别的界面共用。 */
export interface UiPrefsView {
  sessionSort: SessionSortKey
  /** 手动拖出来的工作区顺序（cwd 绝对路径）；没拖过是空数组。 */
  workspaceOrder: string[]
  /** 工作区显示名别名：cwd → 想要的名字。 */
  workspaceAliases: Record<string, string>
}

/** 分叉结果：成功时带新会话的 jsonl 路径，UI 拿它直接切过去。 */
export type SessionForkResult = { ok: true; path: string } | { ok: false; error: string }

/** 插件管理页的一行（内置/外部统一投影；宿主启动时扫描的快照）。 */
export interface PluginInfoView {
  /** 开关键：外部插件为文件名，内置为插件名。 */
  file: string
  /** 显示名（外部插件取其 name 导出，缺省为去后缀文件名）。 */
  name: string
  description: string
  enabled: boolean
  source: 'builtin' | 'external'
  /** true = 有开关可拨（外部插件 + 官方可开关插件）；false = 运行内核，不可停用。 */
  toggleable: boolean
  /** 这个插件在设置面板里的分区 id；undefined = 没有可配置项，UI 不给「配置」按钮。 */
  settingsSection?: string
  /** 插件声明的内核 API 版本；未声明时 undefined。 */
  apiVersion?: number
  /** 加载失败/被自动停用的原因（回滚说明），正常时 undefined。 */
  problem?: string
}

/** 一个队友（子智能体团队派出去的子智能体）；侧栏「队友」这一档看到的行。 */
export interface TeammateView {
  /** 队友名，例如 writer-1。 */
  name: string
  /** 角色名，例如 writer。 */
  role: string
  /** working = 正在干；idle = 干完待命；stopped = 被打断；failed = 出错。 */
  state: 'working' | 'idle' | 'stopped' | 'failed'
  /** 派给它的任务（截短了的）。 */
  task: string
  /** 它的运行记录文件（只读查看用）。 */
  file: string
  /** 谁派了它：'lead' = 主会话派的。 */
  parent: string
  /** 第几层：1 = Lead 的直属队友。 */
  depth: number
  /** 已发起的模型请求轮数。 */
  rounds: number
  startedAt: number
  finishedAt?: number
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

// ── 技能中心 ──────────────────────────────────────────────────────────────────

/** 技能来源标签（rank 小者赢得重名）。 */
export type SkillSourceLabel = 'project-dsc' | 'project-agents' | 'custom' | 'user-dsc' | (string & {})

/** 技能清单一行（技能中心页与设置「技能」分区共用）。 */
export interface SkillInfoView {
  /** kebab-case 名，同时是启停键。 */
  name: string
  description: string
  /** frontmatter when-to-use（技能卡片第二行）。 */
  whenToUse?: string
  source: SkillSourceLabel
  /** SKILL.md 绝对路径；插件注册的虚拟技能没有路径。 */
  path?: string
  enabled: boolean
  /** 是否出现在模型可见目录里。 */
  modelInvocable: boolean
  /** 是否注册成 `/技能名` 命令。 */
  userInvocable: boolean
  /** false = 由插件注册、不可启停。 */
  toggleable: boolean
  /** 发现或解析问题（名字非法、frontmatter 缺字段等），正常时 undefined。 */
  problem?: string
}

/** 技能详情（正文按需读，不进模型目录）。 */
export interface SkillDetail extends SkillInfoView {
  /** SKILL.md 去掉 frontmatter 之后的 markdown 正文。 */
  content: string
}

/** 技能读取结果。 */
export type SkillLoadResult = { ok: true; skill: SkillDetail } | { ok: false; error: string }

/** 一个技能市场源。 */
export interface MarketSource {
  name: string
  url: string
}

/** 市场源的健康投影（失败源保留错误原因，UI 才看得见为什么空）。 */
export interface MarketSourceView extends MarketSource {
  ok: boolean
  error?: string
}

/** 市场里的一条可安装技能。 */
export interface MarketSkillView {
  name: string
  description: string
  /** 所属市场源名。 */
  source: string
  version?: string
  /** 本地 ~/.dsc/skills 里是否已有同名技能。 */
  installed: boolean
}

/** 一次市场浏览的结果（当前源的条目 + 全部源的状态）。 */
export interface MarketBrowseResult {
  sources: MarketSourceView[]
  /** 本次条目来自哪个源。 */
  source: string
  items: MarketSkillView[]
  error?: string
}

// ── 设置界面 ──────────────────────────────────────────────────────────────────

/** 设置项的值类型（要过 IPC，只能是这三类）。 */
export type SettingsValue = string | number | boolean

/** 下拉选项。 */
export interface SettingsOption {
  value: string
  label: string
}

/**
 * 设置分区里的一个控件。内置分区与外部插件声明的分区共用这一张渲染表，
 * 所以字段必须可 JSON 序列化——插件给的是声明和回调，不是 React 组件。
 */
export type SettingsField =
  | { type: 'text'; key: string; label: string; placeholder?: string; help?: string; mono?: boolean }
  | { type: 'number'; key: string; label: string; min?: number; max?: number; step?: number; help?: string }
  | { type: 'select'; key: string; label: string; options: SettingsOption[]; help?: string }
  | { type: 'switch'; key: string; label: string; help?: string }
  | { type: 'info'; label?: string; text: string; mono?: boolean; copyable?: boolean; help?: string }
  | { type: 'button'; action: string; label: string; style?: 'primary' | 'ghost'; help?: string }

/** 一个设置分区的投影（顺序由 order 决定，小者在前）。 */
export interface SettingsSectionView {
  id: string
  title: string
  /** nav 行下方的一句话说明。 */
  subtitle?: string
  order: number
  /** 内核内置分区（插件贡献的为 false）。 */
  builtin: boolean
  /**
   * true = 内容要由桌面端自己画（模型、技能这类结构化界面），
   * 此时 fields 为空，数据走 getModelConfig / listSkills 等专门的方法。
   */
  custom: boolean
  fields: SettingsField[]
}

/** 分区控件的值表。 */
export type SettingsValues = Record<string, SettingsValue>

/** 写入或动作的结果：失败原因直接显示在控件下方。 */
export type SettingsMutation = { ok: true; notice?: string } | { ok: false; error: string }

// ── 模型配置（设置「模型」分区的数据源） ──────────────────────────────────────

/** 端点里的一个模型。 */
export interface ProviderModelView {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

/** 一个端点（API key 只报告状态，永不回传值）。 */
export interface ProviderView {
  name: string
  displayName: string
  baseUrl: string
  /** config.yaml 里 apiKeyEnv 指向的环境变量名 / 凭据库 key 名。 */
  keyRef: string
  /** 该 key 是否已取得（环境变量或凭据库）。 */
  keyConfigured: boolean
  models: ProviderModelView[]
}

/** 模型配置全貌。 */
export interface ModelConfigView {
  providers: ProviderView[]
  defaultProvider: string
  defaultModel: string
  /** 采样温度；null = 跟随端点默认。 */
  temperature: number | null
  /** 配置文件绝对路径（关于分区与错误提示都要用）。 */
  configFile: string
  credentialsFile: string
}

/** 新增或编辑一个端点的入参（apiKey 单独走 setProviderKey）。 */
export interface ProviderDraft {
  /** null = 新增；否则为被编辑端点的原名字（支持改名）。 */
  oldName: string | null
  name: string
  displayName: string
  baseUrl: string
  models: ProviderModelView[]
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
  /** 归档一批会话（会话行与工作区行「归档全部」共用一条通道）。 */
  archiveSessions(paths: string[]): Promise<SettingsMutation>
  /** 归档页数据（设置 → 归档；按归档时间倒序，带回收站目录与文件数）。 */
  listArchivedSessions(): Promise<ArchivedPage>
  /** 从归档区恢复一批会话。 */
  restoreSessions(paths: string[]): Promise<SettingsMutation>
  /** 永久删除一批会话：移进 `~/.dsc/.trash/`，30 天后自动清。 */
  purgeSessions(paths: string[]): Promise<SettingsMutation>
  /** 改会话显示名（写 meta.json，不动 jsonl 本体）。 */
  renameSession(path: string, title: string): Promise<SettingsMutation>
  /** 置顶或取消置顶一个会话。 */
  setSessionPinned(path: string, pinned: boolean): Promise<SettingsMutation>
  /** 分叉菜单的数据源：这个会话里的用户消息（数组下标就是分叉位置）。 */
  listUserMessages(path: string): Promise<string[]>
  /** 分叉会话：把日志复制到第 index 条用户消息之前，返回新会话路径。 */
  forkSession(path: string, index: number): Promise<SessionForkResult>
  /** 侧栏界面偏好（排序方式、工作区顺序与别名）。 */
  getUiPrefs(): UiPrefsView
  /** 改侧栏界面偏好（写 `~/.dsc/settings.json`）。 */
  setUiPrefs(patch: Partial<UiPrefsView>): Promise<SettingsMutation>
  /** 可切换的模型列表（进程内静态，UI 可在挂载时取一次）。 */
  listModels(): ModelChoiceView[]
  /** 插件清单（内置 + 外部；宿主启动时扫描的快照）。 */
  listPlugins(): PluginInfoView[]
  /** 更新外部插件启用状态（热生效：热挂载/卸载，写 ~/.dsc/plugins.json 持久化）。 */
  setPluginEnabled(file: string, enabled: boolean): void
  /**
   * 队友清单（子智能体团队开着才有内容；关着返回空数组）。
   * UI 在「队友」这一档开着时轮询它。
   */
  listTeammates(): TeammateView[]
  /**
   * 只读重放一个会话文件的对话条目（看队友在干什么用）。
   * 它不改那个文件，也不能归档/删除/分叉——校验在 core/session.ts。
   */
  peekTranscript(file: string): Promise<TranscriptEntry[]>
  /**
   * 技能清单（全部来源合并、重名按 rank 裁决、含被停用的条目）。
   * 工作目录取当前会话的 cwd，项目级技能因此随会话变化。
   */
  listSkills(): SkillInfoView[]
  /** 读一个技能的正文（技能中心详情用；不存在返回 ok:false）。 */
  readSkill(name: string): Promise<SkillLoadResult>
  /** 启停技能（写 ~/.dsc/skills.json，下一次请求生效）。 */
  setSkillEnabled(name: string, enabled: boolean): SettingsMutation
  /** 浏览技能市场（source 省略时用第一个源）。 */
  browseMarket(source?: string): Promise<MarketBrowseResult>
  /** 从市场源安装一个技能到 ~/.dsc/skills/。 */
  installMarketSkill(source: string, name: string): Promise<SettingsMutation>
  /** 覆盖市场源清单（写 ~/.dsc/settings.json）。 */
  setMarketSources(sources: MarketSource[]): SettingsMutation
  /** 设置分区清单（内置 + 插件贡献，按 order 排序）。 */
  getSettingsSections(): SettingsSectionView[]
  /** 读一个分区当前控件值。 */
  getSectionValues(id: string): Promise<SettingsValues>
  /** 写一个控件的值（分区自己的 save 回调校验；失败原因回 UI）。 */
  setSettingValue(id: string, key: string, value: SettingsValue): Promise<SettingsMutation>
  /** 执行分区的按钮动作（返回值里的 notice 由插件给出）。 */
  runSettingAction(id: string, action: string): Promise<SettingsMutation>
  /** 模型配置全貌（设置「模型」分区数据源）。 */
  getModelConfig(): ModelConfigView
  /** 新增或编辑端点（写 config.yaml；当前会话正在用的端点同步热更新）。 */
  saveProvider(draft: ProviderDraft): Promise<SettingsMutation>
  /** 删除端点（写 config.yaml；默认端点被删时自动改指第一个可用端点）。 */
  removeProvider(name: string): Promise<SettingsMutation>
  /** 写入或清除端点的 API key（写 ~/.dsc/credentials.yaml 的 refs）。 */
  setProviderKey(name: string, apiKey: string | null): Promise<SettingsMutation>
  /** 设为默认端点/模型（写 config.yaml 并对当前会话立即生效）。 */
  setDefaultModel(provider: string, model: string): Promise<SettingsMutation>
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
