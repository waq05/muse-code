/**
 * UI ⇄ adapter 的共享契约（单一真源）。
 *
 * 边界规则（对齐 dsh-TUI 的 adapter 边界实践）：
 *   - `src/adapter/**` 是唯一允许 import `@deepseek-ai/*` 运行期包的层；
 *   - UI 层（src/app/**、src/state/**、src/commands.ts）只依赖本文件的
 *     中立类型，通过 DscRuntime 与宿主世界交互；
 *   - 本文件自身不得 import 任何 @deepseek-ai/*。
 */

/** deepseek adapter 的思考强度档位。default = 不声明思考字段（跟随端点默认）。 */
export type EffortLevel = 'default' | 'off' | 'low' | 'high' | 'max'

/** 思考强度档位里可被模型声明的四档（default 不是模型能力，是「不发字段」）。 */
export type ThinkingLevel = Exclude<EffortLevel, 'default'>

/**
 * 思考档位用哪个请求字段发给端点：
 *   thinking          —— DeepSeek / GLM 的 `thinking:{type}`，只有开关，低/高/最大都发 enabled；
 *   reasoning-effort —— OpenAI 与多数网关的 `reasoning_effort`，按档位发线上值（见 EffortMap）；
 *   none              —— 端点没有思考参数，选哪档都不发字段。
 */
export type ThinkingParam = 'thinking' | 'reasoning-effort' | 'none'

/** 模型能接受的输入类型（text 恒含；video 目前只作声明，dsc 还没有发视频的通道）。 */
export type Modality = 'text' | 'image' | 'video'

/** `reasoning-effort` 下每档要发的线上值；null = 该档不发字段。 */
export type EffortMap = Partial<Record<ThinkingLevel, string | null>>

/**
 * 权限模式（工具执行的沙箱策略）：
 *   readonly     —— 仅查看：write/exec 类工具一律拒绝，不弹审批；
 *   auto-edit    —— 工作区自动编辑：目标在工作目录内的写工具自动放行，
 *                   其余（工作区外写入、exec 类）走人工审批卡；
 *   full-access  —— 完全访问：全部工具自动放行；
 *   ai-review    —— AI 自动审查：由模型逐次判断是否放行，失败回退人工审批。
 */
export type ApprovalPolicy = 'readonly' | 'auto-edit' | 'full-access' | 'ai-review'

/**
 * 协作模式（这一轮允许模型把手伸多远）。与权限模式是两根独立的旋钮：
 * 模式决定要不要问、能问什么；权限模式决定问出来之后怎么裁。
 *   build   执行    —— 默认档，闸门不拦，全交给权限模式与审批卡；
 *   plan    计划    —— 只读 + 只读命令，产出 .dsc/plans 下的计划文件等用户批；
 *   explore 探索    —— 只读答疑，任何改动当场拒；
 *   quiet   免打扰  —— 不弹审批卡：工作区内写自动放行，需要问的一律当场拒。
 */
export type CollaborationMode = 'build' | 'plan' | 'explore' | 'quiet'

/**
 * 任务清单条目的状态。
 * core/todo.ts 直接用它（不再另写一遍四个字符串），界面与存储因此不可能各说一套。
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** 任务清单里的一条（界面渲染用；正文已被截到 300 字以内）。 */
export interface TodoItemView {
  id: string
  content: string
  status: TodoStatus
  /** 父任务 id；有值表示它是上一条的子任务，界面缩进一级。 */
  parent?: string
}

/** 任务清单投影：整表 + 版本号 + 进度，界面靠 revision 丢掉过期帧。 */
export interface TodoView {
  items: TodoItemView[]
  revision: number
  /** 已完成数（cancelled 不计入分母）。 */
  done: number
  /** 有效任务总数。 */
  total: number
  /** 当前在做的那条正文（清单条上直接显示）。 */
  active: string | null
}

/** 计划评审卡的状态。 */
export type PlanDecision = 'pending' | 'approved' | 'rejected'

/** 一份待批的计划。 */
export interface PlanView {
  /** 计划落盘的文件（相对工作目录显示由界面决定）。 */
  file: string
  title: string
  /** 计划全文（markdown）。 */
  text: string
  /** 用户批没批；pending = 评审卡还挂着。 */
  decision: PlanDecision
}

/**
 * 目标阶段。
 * `core/goal.ts` 直接 import 这个类型（那里只留别名），界面与存储因此共用一份声明。
 */
export type GoalPhaseView = 'active' | 'paused' | 'blocked' | 'complete'

/** 会话目标投影（界面顶部那条 goal 条的数据源）。 */
export interface GoalView {
  objective: string
  phase: GoalPhaseView
  rounds: number
  maxRounds: number
  /** phase=blocked 时说明卡在哪。 */
  blockedReason?: string
  /** 自动续跑开关（进程本地；重启后为 false）。 */
  armed: boolean
}

/** 模型问用户的一个问题（ask_user 工具的数据）。 */
export interface AskOptionView {
  label: string
  description?: string
}

/**
 * 一批提问里的一题：字段与单题视图完全相同，只是没有 `id`——
 * 题目在自己那一批里的位置就是它的标识。
 */
export interface AskQuestionItem {
  question: string
  header?: string
  options: AskOptionView[]
  multiSelect: boolean
  /** 「其他」自由输入是否允许。 */
  allowFreeText: boolean
}

/**
 * 模型发起的一次提问；界面渲染成带按钮的卡片，答案回给模型。
 *
 * 一次提问可以带好几题：`questions` 有内容时界面按「一张卡列出全部题目」渲染
 * （逐题作答、统一提交，一次调用把全部答案交回）；界面不认 `questions` 时
 * 就退回下面那几个单题字段，仍然能渲染出第 1 题。
 *
 * 单题字段因此是「第 1 题的投影」，和 `questions[0]` 必须同源：
 * 老会话回放里存下的单题视图没有 `questions`，也不需要迁移。
 */
export interface AskUserView {
  id: string
  question: string
  header?: string
  options: AskOptionView[]
  multiSelect: boolean
  /** 「其他」自由输入是否允许。 */
  allowFreeText: boolean
  /** 这一批的全部题目（含第 1 题）；单题提问可以不写，写了就必须与单题字段一致。 */
  questions?: AskQuestionItem[]
}

/** 提一个单题提问的入参：`id` 由服务发，`questions` 由服务按这一题的字段补出来。 */
export type AskUserViewInput = Omit<AskUserView, 'id' | 'questions'>

/**
 * 一次工具调用的展示状态。
 *
 * `preparing` = 模型已经开始吐这个工具的名字、参数还没到齐（对照 dsh 的 `preparing` 阶段）。
 * 那一行不解析参数、不可展开，只是告诉用户「接下来要干这件事」。它随后会被升级成 `running`。
 */
export type ToolStatus = 'preparing' | 'running' | 'done' | 'failed' | 'rejected'

/** 工具卡片视图：参数原文 +（完成后的）结果摘要。 */
export interface ToolCallView {
  callId: string
  name: string
  /** 模型产出的原始 arguments JSON 字符串（截断由 UI 决定）。 */
  argsText: string
  /** 工具结果文本（可能为空：无结果或尚未完成）。 */
  resultText?: string
  status: ToolStatus
  /**
   * 这次调用发起的时刻（epoch ms）：宿主收到 `tool/call` 那一刻。
   *
   * 为什么不复用条目上的 `ts`：`ts` 的口径是「这条条目最后一次被写入的时刻」，
   * 拿到结果时会被刷成结果时刻（见 adapter/transcript.ts 的 `tool/result` 分支），
   * 光凭它算不出这次调用从头到尾花了多久。发起时刻因此单独存一份，只写一次不再改。
   *
   * 为什么是可选的：2026-09 之前的会话日志没记时间，重放老会话时拿不到——
   * 界面据此不显示耗时，绝不拿「现在」冒充历史时刻。
   */
  startedAt?: number
  /**
   * 这次调用从发起到结果回来花掉的毫秒数（结果到达时刻 − `startedAt`）。
   *
   * 口径：`done` / `failed` / `rejected` 一视同仁都算——跑挂了、被审批拒掉、用户中途
   * 打断的工具调用同样占用了这段时间，轨迹页的时间线要如实显示。只有还停在 `running`
   * （结果没回来）时才没有这个数。
   *
   * 为什么是可选的：① 老会话没有 `startedAt`，算不出来；② 日志时间乱序（手改过、
   * 跨机器拷过）导致结果时刻早于发起时刻时也不写——宁可让界面不显示，也不编一个 0 秒。
   */
  durationMs?: number
}

/**
 * 压缩落点标记：条目带上它，就说明「从这一刻起，模型看到的历史已经是压缩后的」。
 * 轨迹页据此把压缩历史渲染成独立区段（对照 dsh 的 Between turns），不必去猜正文。
 *
 * `count` = 本会话累计到这一条为止发生过的压缩次数（也就是「第几次压缩」），1 基。
 * 为什么用次数而不是「折进去多少条消息」：实时路径算得出条数，但会话日志里只记了
 * 保留了多少条（见 core/session.ts 的 `replaceWithSummary`，只写 `keep`），重放时
 * 反推不回来——同一个字段两条路径给不出同一个口径，索性不带。
 *
 * 压缩有两个落点，各自留在原本的 kind 上：
 * - 实时：compact 插件经 `dsc/notice(text, 'compaction')` 写下的 **system** 条目；
 * - 重放：摘要自己在内存里就是一条 `role: 'user'` 的消息（core/compact.ts 造的），
 *   正文固定以 `SUMMARY_BANNER` 开头，adapter 靠这个前缀把它认出来，仍是 **user** 条目。
 *   没有换成专属 kind，是因为「对话」页现在把摘要当用户气泡渲染——换 kind 会让摘要
 *   正文当场从对话页和终端界面消失。
 *
 * 老会话（日志里只有那条摘要消息）重放照样认得出，只是日志里只留最后一条摘要
 * （core/session.ts 的 `case 'summary'` 会把更早的记录换掉），所以重放路径的 `count`
 * 永远是 1。
 */
export interface CompactionMark {
  /** 本会话里这是第几次压缩，1 基。 */
  count: number
}

/**
 * 会话流里的一条可渲染条目。adapter 把 session/event 折叠成这个序列，
 * UI 只读消费；`id` 单调递增、仅在本会话生命周期内唯一。
 *
 * 每个条目都可以带 `ts`：毫秒 epoch，含义是「这条条目最后一次被写入的时刻」
 * （用户条目就是发消息那一刻，工具卡是最后一次更新那一刻）。界面按它显示
 * 「这条消息几点发的」「这一轮花了多久」。
 *
 * 为什么是可选的：2026-09 之前的会话日志里没有这个字段，重放老会话时拿不到时间。
 * 那时候界面降级为不显示时间与用时——绝不拿「现在」冒充历史时刻，也不显示 NaN。
 *
 * text / tool 条目还可以带 `usage`：从最近一条 user 条目算起，**这一轮**每一次模型
 * 请求的 prompt_tokens（含系统提示词与全部上下文）与 completion_tokens 全部累加之和。
 * 多步工具轮每次请求都重发整份上下文，所以这个和就是本轮的 API 真实计费量，
 * 而不是按正文字数估出来的。
 * 同一轮里靠前的条目挂的是「到那一刻为止」的累计，界面取轮内最后一条就是整轮真值。
 * 为什么是可选的：① 一次用量事件都没上报过（没有 usage 事件的老会话）时没有这个数；
 * ② 重放历史日志造不出这个数——会话日志只存消息，不存每次请求的用量。
 */
export type TranscriptEntry =
  /**
   * images 是 data URL 清单（用户贴进来的图）；界面渲染成缩略图。
   * `compaction` 只出现在重放出来的压缩摘要上（见 {@link CompactionMark}）。
   * `steering` = 这条消息是在助手回合**还没跑完**时插进来的（对照 dsh 的 steering 节点）。
   */
  | { kind: 'user'; id: number; text: string; images?: string[]; ts?: number; compaction?: CompactionMark; steering?: boolean }
  /**
   * durationMs 是这段思考从第一口 reasoning delta 到定稿的耗时（≥1s 界面才显示）。
   * 为什么可选：重放历史日志造不出它（日志只存定稿文本），老会话回看就降级不显示。
   */
  | { kind: 'thinking'; id: number; text: string; ts?: number; durationMs?: number }
  /**
   * 子代理内联卡（实时条目，不落盘）：队友在跑的时候长在转录里，收工折成一行头。
   * 由 subagent 插件把队友的事件流转成 SubagentCardView 推进来（dsc/subagent 事件），
   * 同名原位更新（React key 不换，卡片就地刷新）。
   */
  | { kind: 'subagent'; id: number; sub: SubagentCardView; ts?: number }
  /** usage 是整轮累计口径，见本类型头部的说明。 */
  | { kind: 'text'; id: number; text: string; ts?: number; usage?: { inputTokens: number; outputTokens: number } }
  /** usage 同上（一轮以工具结果收尾、没有最终正文时，数字落在这张卡上）。 */
  | { kind: 'tool'; id: number; call: ToolCallView; ts?: number; usage?: { inputTokens: number; outputTokens: number } }
  /** 计划卡：exit_plan_mode 交上来的计划，带用户批没批。 */
  | { kind: 'plan'; id: number; plan: PlanView; ts?: number }
  /** `compaction` 只出现在压缩插件写下的那条通知上（见 {@link CompactionMark}）。 */
  | { kind: 'system'; id: number; text: string; ts?: number; compaction?: CompactionMark }
  /** 轮尾标记：这一轮为什么结束，见 {@link TurnEndReason}。 */
  | { kind: 'turn-end'; id: number; reason: TurnEndReason; ts?: number }
  /** 这一轮的输出撞上了长度上限（对照 dsh 的 `turn-max-tokens` 节点）。 */
  | { kind: 'turn-max-tokens'; id: number; ts?: number }
  /**
   * 模型这次请求失败、正在重试（对照 dsh 的 `model-retry` 节点）。
   *
   * 它是二级分组的**边界**（前后两段过程被它切开），但**不属于**整轮折叠要放过的那些
   * 独立节点——dsh 的规矩是「二级分组把模型重试视为分隔节点，但整轮折叠仍包含重试行」。
   */
  | { kind: 'model-retry'; id: number; attempt: number; text: string; ts?: number }
  /**
   * 一次成功的 write / edit 落盘后的实际改动（对照 dsh deliverables 的 produced 文件）。
   * 界面把同一轮里的这些条目聚合成轮尾一张「文件已更改」卡；`hunks` 是算好的
   * unified 差异段（结构见 {@link DiffHunkView}），审查面板直接渲染。
   */
  | { kind: 'changes'; id: number; file: ChangedFileView; ts?: number }
  /**
   * 回合收尾的聚合改动（codex `turn/diff/updated` 的同位条目）：本回合动过的每个文件
   * 一份「回合基线 vs 盘上终态」的差异，同文件多刀合一。纯内存条目——不落 jsonl，
   * 重启恢复后界面回退逐刀合并显示（`kind: 'changes'` 照常重放）。
   */
  | { kind: 'turnDiff'; id: number; files: ChangedFileView[]; ts?: number }

/**
 * 一轮对话为什么结束（口径就是宿主 `turn/end` 事件的 reason，见 core/events.ts）。
 *
 * 为什么要有它：dsh 的整轮折叠有一条规矩——**中断或失败的轮不折整轮**，开关行还要把
 * 「已停止 / 过程失败」显示出来（`contract/turn-process.ts` 的 `turnProcessAlwaysOpen`
 * 与 `chat/TurnProcessNodeView.tsx:26-28`）。dsc 的宿主一直知道这个原因，只是 adapter
 * 从事件折条目时把它丢了，于是界面上「跑挂了的一轮」和「好好答完的一轮」长得一模一样。
 */
export type TurnEndReason = 'completed' | 'aborted' | 'error'

/**
 * 子代理内联卡的数据（dsh SubagentMessage 同位物）：头行「状态点 + 任务 + 轮数/工具数/
 * 耗时/token + 状态词」，跑动时再加当前工具行与输出瀑布。数据是插件侧的实时快照，
 * 每次事件整体替换。
 */
export interface SubagentCardView {
  /** 队友名（同会话内唯一，卡片按它原位更新）。 */
  name: string
  /** 角色名（工牌冻结的那份）。 */
  role: string
  /** 派给它的任务原文（界面自己截断）。 */
  task: string
  /** 运行状态；`idle` = 正常收工，`stopped` = 被打断，`failed` = 过程失败。 */
  state: 'working' | 'idle' | 'failed' | 'stopped'
  /** 用的模型（`端点/模型`；跟随主会话模型时填当时的模型）。 */
  model?: string
  /** 已发起的模型请求轮数。 */
  rounds: number
  /** 已执行的工具调用次数。 */
  toolCalls: number
  /** 开工时刻（毫秒 epoch；名册种子卡才有，实时转发必有）。 */
  startedAt?: number
  /** 收工时刻；还在跑就没有。 */
  finishedAt?: number
  /** 当前（或最后一把）工具：跑动时画「当前工具行」。 */
  lastTool?: { name: string; args: string; status: 'running' | 'done' | 'failed' }
  /** 输出瀑布的行池（最新在后；界面只取最后几行，每行硬截单行宽）。 */
  outputLines?: string[]
  /** 累计 token（输入+输出，端点真值；一次都没回过用量时缺省）。 */
  tokens?: number
  /** 过程失败的原因（state=failed 时界面画一条错误行）。 */
  error?: string
  /** 队友会话的 jsonl 路径（点卡片开只读转录浮层）。 */
  file?: string
}

/** context 条按内容类型的分段（token 估算值，只描述占用段的颜色组成）。 */
export interface ContextSegmentsView {
  system: number
  prompt: number
  assistant: number
  thinking: number
  tools: number
}

/** 差异里的一行（与 core/diff-text.ts 的 DiffLine 同构，视图层零宿主依赖）。 */
export interface DiffLineView {
  kind: 'context' | 'remove' | 'add'
  text: string
  /** 这一行在旧文件里的行号；`add` 行为 null。 */
  oldLine: number | null
  /** 这一行在新文件里的行号；`remove` 行为 null。 */
  newLine: number | null
}

/** 一段 hunk：`@@ -oldStart,oldCount +newStart,newCount @@` 加上它包含的行（同构 DiffHunk）。 */
export interface DiffHunkView {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLineView[]
}

/** 一次成功的 write / edit 的实际改动（轮尾「文件已更改」卡与审查面板的数据）。 */
export interface ChangedFileView {
  /** 文件的绝对路径（打开预览用）。 */
  path: string
  /** 新增行数。 */
  added: number
  /** 删除行数。 */
  removed: number
  /** 算好的 unified 差异段；审查面板直接渲染，不再碰文件系统。 */
  hunks: DiffHunkView[]
  /** true = hunks 超过行数上限被砍过（面板据此提示「只显示前一部分」）。 */
  truncated?: boolean
  /** `added` = 新建文件（改前不存在）；`modified` = 改已有文件。 */
  status: 'added' | 'modified'
}

/**
 * 会话累计 token 用量。
 * 缓存命中两项只在端点上报过明细的请求上累计（命中率 = 命中 /（命中 + 未命中）），
 * 没上报明细的请求既不加命中也不加未命中——命中率才不会被稀释（口径与 usage-log 一致）。
 */
export interface TokenUsageView {
  inputTokens: number
  outputTokens: number
  /** 输入里的前缀缓存命中 tokens 合计；端点从未上报过明细时缺省。 */
  cacheHitTokens?: number
  /** 输入里的前缀缓存未命中 tokens 合计；同上。 */
  cacheMissTokens?: number
}

/** 用量统计的单日投影（本地时区的自然日）。 */
export interface UsageDayView {
  /** 本地时区的 YYYY-MM-DD。 */
  date: string
  inputTokens: number
  outputTokens: number
  /** 这一天的模型请求轮数。 */
  turns: number
  /** 按 `provider/model` 拆分的 token 总量（输入+输出）。 */
  byModel: Record<string, number>
}

/** 一个模型的用量汇总。 */
export interface UsageModelView {
  /** `provider/model`，与 daily byModel 的键一致。 */
  key: string
  inputTokens: number
  outputTokens: number
  turns: number
  /** 输入里的前缀缓存命中 / 未命中 tokens（端点没上报这项的记录按 0 计）。 */
  cacheHitTokens: number
  cacheMissTokens: number
}

/**
 * 用量统计（设置「用量统计」分区数据源）。
 * 宿主从 `~/.dsc/usage/usage.jsonl`（每次模型请求追加一条）聚合而来；
 * 这份日志从该功能上线那刻开始积累，更早的会话没有记录。
 */
export interface UsageStatsView {
  /** 最早一条记录的时间戳；一条都没有时 null。 */
  sinceTs: number | null
  totalInputTokens: number
  totalOutputTokens: number
  /**
   * 输入里的前缀缓存命中 / 未命中 tokens 合计（2026-10-03 起记录；更早的行没有这项，
   * 按 0 计）。两个数都只统计端点上报了明细的请求，命中率 = 前者 /（前者 + 后者）。
   */
  totalCacheHitTokens: number
  totalCacheMissTokens: number
  totalTurns: number
  /** 有记录的自然日数。 */
  activeDays: number
  /** 当前连续活跃天数（今天没活动就从昨天起算）。 */
  currentStreakDays: number
  longestStreakDays: number
  /** 单日 token 总量最高的那天；还没有记录时 null。 */
  peakDay: UsageDayView | null
  /** 首条记录所在日到今天（含零日）的逐日投影，按日期升序；跨度封顶 370 天。 */
  days: UsageDayView[]
  /** 按模型汇总，总量降序。 */
  models: UsageModelView[]
}

/**
 * 底部状态行数据：只放对话引擎自己的事实（哪条会话、哪个模型、这一轮在干什么）。
 * 某个功能点的状态（权限模式、协作模式、审批卡……）不进这里，由那个功能点自己
 * 往 {@link RuntimeSnapshot.surfaces} 里贡献自己那一块。
 */
export interface StatusView {
  sessionId: string | null
  /** 当前模型名；未知时 'unknown'。 */
  model: string
  effort: EffortLevel
  turnState: 'idle' | 'thinking' | 'working' | 'awaiting-approval'
  usage: TokenUsageView | null
  /** 当前模型的上下文窗口（状态栏 context 进度条的分母；未知 0 = 不画刻度）。 */
  contextWindow: number
  /**
   * 最近一次请求的 prompt_tokens（权威占用读数，读数与空闲段按它算）。
   * 为什么不用 usage 累计：那是整会话的计费和，多轮会把早已滚出窗口的内容也算进去，
   * 条只会虚胖。还没有任何请求回过用量时为 0。
   */
  contextUsed: number
  /** 最近一次请求组装的内容类型分段（估算；没有请求记录时全 0 = 条上只有空闲段）。 */
  contextSegments: ContextSegmentsView
  /**
   * 会话费用估算（人民币）：只有当 provider 是 DeepSeek 官方且模型在价目表里、
   * 且至少回过一笔用量时才有。峰谷按北京时段分桶计价（见 core/pricing）。
   */
  cost?: { total: number; peakNow: boolean }
  /** 当前会话的工作目录（状态栏显示；快照组装自 session.meta.cwd）。 */
  cwd?: string
  /**
   * 当前会话的 jsonl 绝对路径。sessionId 是 uuid，拿它当文件用会按进程 cwd
   * 解析出 ENOENT（/fork 0.6.65 实锤）——需要落盘路径的命令一律用这个。
   */
  sessionPath?: string
}

/** 档位按钮的一项：档位 id + 按钮文字 + 悬浮说明。 */
export interface TierOption<T extends string> {
  id: T
  label: string
  hint: string
}

/**
 * 协作模式投影：当前档位 + 可切的档位清单。
 * 清单由 mode 插件给出，界面因此不必自己抄一份四档表。
 */
export interface ModeSurface {
  current: CollaborationMode
  options: TierOption<CollaborationMode>[]
}

/** 权限模式投影（同上，清单由 approval 插件给出）。 */
export interface PolicySurface {
  current: ApprovalPolicy
  options: TierOption<ApprovalPolicy>[]
}

/**
 * 一个模式（预设）的投影：`~/.dsc/presets/<名字>.md` 一个文件读出来的那份声明。
 * 界面上「查看配置」看的是文件原文（`readPreset`），这份投影只给卡片要用的字段。
 */
export interface PresetView {
  /** 模式标识（小写字母数字连字符）。 */
  name: string
  /** 界面上的显示名。 */
  label: string
  description: string
  /** 工具白名单；null = 全量，空数组 = 一个工具都不给。 */
  tools: string[] | null
  /** 要去掉的骨架提示段 id。 */
  drop: string[]
  /** 正文 = 这个模式追加给模型的提示词（编辑表单要拿它当初始值）。 */
  prompt: string
  /** 出厂自带的四个之一（界面标「内置」，删不掉）。 */
  builtin: boolean
  /** 文件有问题时的说明（例如 frontmatter 坏了、drop 里写了不认识的段）。 */
  problem?: string
}

/**
 * 模式投影：当前会话用的 + 新会话默认用的 + 全部可选。
 * 清单由 presets 插件给出，界面因此不必自己抄一份四个模式的名字。
 */
export interface PresetSurface {
  /** 当前会话用的模式名。 */
  current: string
  /** 新会话默认用的模式名。 */
  defaultName: string
  options: PresetView[]
  /** 允许模式去掉的骨架提示段（界面画勾选框）：名单只在 core/presets.ts 里有一份。 */
  droppable: Array<{ id: string; label: string }>
}

/** 一个工具在界面上的投影（设置 → 模式 的工具多选；只读，不带 run）。 */
export interface ToolEntryView {
  name: string
  /** 风险档：read 自动放行，write / exec 要过审批。 */
  risk: 'read' | 'write' | 'exec'
  description: string
  /** 只在列出的模式里露面；不写 = 所有模式都能看见它。 */
  presets?: string[]
}

/** 读一个模式文件原文的结果（「查看配置」用；失败时 error 是给用户看的一句话）。 */
export type PresetFileView = { ok: true; name: string; text: string } | { ok: false; error: string }

/** 新建或编辑一个模式的入参。 */
export interface PresetDraft {
  /** null = 新建；否则是被编辑模式的原名（支持改名）。 */
  oldName: string | null
  name: string
  label: string
  description: string
  /** 工具白名单；null = 全量。 */
  tools: string[] | null
  drop: string[]
  /** 正文 = 这个模式追加给模型的提示词。 */
  prompt: string
}

/**
 * 快照里由各功能点贡献的界面片段。
 *
 * 内置那几项由对应插件自己登记（`ctx.surfaces.register`），组装快照的那一层不认识任何具体功能。
 * 外部插件要加自己那一块就用声明合并，不要往上面塞字段：
 * `declare module '@dsc/runtime/contract.js' { interface RuntimeSurfaces { memory: MyView } }`。
 */
export interface RuntimeSurfaces {
  /** 挂起的审批卡（approval 贡献）；同一时刻至多一张。 */
  pendingApproval: ApprovalRequestView | null
  /** 权限模式与可切档位（approval 贡献）。 */
  policy: PolicySurface
  /** 协作模式与可切档位（mode 贡献）。 */
  mode: ModeSurface
  /** 模式（预设）与可切清单（presets 贡献）。 */
  preset: PresetSurface
  /** 任务清单（todo 贡献）；没有任务时 items 为空数组。 */
  todos: TodoView
  /** 挂着等用户批的计划（plan 贡献）；null = 无。 */
  pendingPlan: PlanView | null
  /** 会话目标（goal 贡献）；null = 没设目标。 */
  goal: GoalView | null
  /** 模型发起的提问（ask 贡献）；同一时刻至多一个，它自己可能带一批题目（见 AskUserView.questions）。 */
  pendingQuestion: AskUserView | null
}

/**
 * 审批卡内嵌的「将做的改动」（codex 审批弹窗内嵌 diff 的同位能力）：宿主在弹卡前
 * 读盘上现值、按工具语义推演出这次 write / edit 将产生的差异。
 * 算不出来（非 write/edit、参数不齐）时整个字段缺省。
 */
export interface ApprovalDiffView {
  /** 目标绝对路径。 */
  path: string
  added: number
  removed: number
  /** 推演出的差异段（与 ChangedFileView.hunks 同一形状，审批卡直接渲染）。 */
  hunks: DiffHunkView[]
  /** true = hunks 超行数预算被砍过尾。 */
  truncated?: boolean
  /** `added` = 新建文件（改前不存在 / 从空串起算）；`modified` = 改已有文件。 */
  status: 'added' | 'modified'
  /** true = 盘上现值没读到（工作区外 / 文件还不存在），差异是从参数推算的。 */
  fellBack?: boolean
  /** 仅 edit：old 在盘上匹配不到 / 匹配多处——照参数执行会失败，卡片要提示。 */
  mismatch?: 'missing' | 'ambiguous'
}

/** 待用户决定的工具审批请求（视图投影）。 */
export interface ApprovalRequestView {
  /** adapter 内部关联 id；answerApproval 不需要它（同一时刻至多一个挂起审批）。 */
  id: string
  toolName: string
  /** 参数摘要（单行、已截断、已遮红）。 */
  argsSummary: string
  /** 为什么要问：命中的危险模式或规则，中文一句话。 */
  reason: string
  /** 风险档位：critical 表示只有它不会被任何自动档带走。 */
  risk: 'low' | 'medium' | 'high' | 'critical'
  /** 「永久允许」将往 `~/.dsc/policy.rules` 写的前缀；null = 这个动作不许持久化。 */
  suggestedRule: string[] | null
  /** true = 命中硬地板，界面不该给出任何放行按钮。 */
  hardline: boolean
  /** 这张卡允许哪些授权档位（危险动作会把 always 摘掉）。 */
  scopes: Array<'once' | 'session' | 'always'>
  /** 当前权限模式与协作模式（卡片上说明现在是哪一档）。 */
  policy: ApprovalPolicy
  mode: CollaborationMode
  /** 发起审批的会话 jsonl 路径（0.6.49）：后台会话的卡弹到当前视图时，界面据此标注「来自哪个会话」。 */
  sessionPath?: string
  /** write / edit 的「将做的改动」；其他工具或推演不出时缺省。 */
  diff?: ApprovalDiffView
}

/**
 * 审批应答。
 *   allow-once    只放过这一次；
 *   allow-session 同一会话内同类动作不再问（按会话 id 键控，切会话失效）；
 *   allow-always  往 `~/.dsc/policy.rules` 追加一条前缀规则（危险动作不给这个选项）；
 *   reject        拒。
 */
export type ApprovalAnswer = 'allow-once' | 'allow-session' | 'allow-always' | 'reject'

/** /resume 会话选择器与侧栏的一行。 */
export interface SessionSummary {
  /** jsonl 的绝对路径（UI 侧的会话标识就是它）。 */
  id: string
  cwd: string
  createdAt: number
  /** 最后一次写入日志的时间（文件 mtime），「按最近使用」排序的键。 */
  updatedAt: number
  /** 会话标题：用户改名 → 自动生成（T16）→ 首条用户消息截断；都没有时 undefined。 */
  title?: string
  /** 置顶时间；undefined = 未置顶。 */
  pinnedAt?: number
  /** 归档时间；undefined = 还在活动区。归档不等于删除，恢复后回到列表。 */
  archivedAt?: number
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

/** 会话排序方式：手动（工作区按拖动顺序）、按最近写入时间，或按创建时间。 */
export type SessionSortKey = 'manual' | 'recent' | 'created'

/** 列表分组方式：按工作区分组、按工作区目录树嵌套，或平铺成单列表。 */
export type SessionGroupKey = 'workspace' | 'tree' | 'flat'

/** 已归档会话在侧栏里的显隐：隐藏（默认）、并入列表一起看，或只看归档。 */
export type ArchivedFilter = 'hide' | 'show' | 'only'

/** 主题模式：固定深色、固定浅色，或跟着系统的浅色偏好走。 */
export type ThemeMode = 'dark' | 'light' | 'system'

/**
 * 全局字号缩放倍数（1 = 正文 13px 基准）。桌面端把它直接写成 `--dsc-font-scale`。
 *
 * 0.6 之前的存档里这里是 `'sm' | 'md' | 'lg'` 三档字符串，读档时迁移成
 * 0.92 / 1 / 1.12（见 core/prefs.ts 的 readPrefs）。
 */
export type UiFontSize = number

/** 密度档位：行高与纵向内距的整体缩放（紧凑 / 标准 / 宽松）。 */
export type UiDensity = 'compact' | 'standard' | 'roomy'

/**
 * 过程折叠程度：对话流里「思考 / 工具调用」这些过程条目的展示档位。
 *
 * 四档与 dsh 的展示档位一一对应（packages/client/ui-chat/src/client/presentation-policy.ts:24-53），
 * 每档开哪几项能力见 desktop/src/renderer/appearance.ts 的 PROCESS_FOLD_POLICIES：
 *
 * - `compact`：整轮折叠 + 阶段分组 + 不显示思考行摘要 + 组头不带实时详情；
 * - `standard`：整轮折叠 + 阶段分组 + 摘要 + 组头带实时详情（默认）；
 * - `detailed`：整轮折叠，但**只有历史轮**才分组——正在跑的那一轮直接摊开；
 * - `verbose`：整轮不折、阶段也不分组，过程条目逐条摊开。
 *
 * 为什么 `detailed` 和 `verbose` 都要有：dsh 里 `detailed` 是桌面端的实际默认档
 * （ui-chat/src/client/apply.ts 里非 dsh 桌面端走 detailed），它的意思是「想看细节，但不想
 * 每次都把历史摊开」——整轮照折，只有运行中的那一轮摊着。`verbose` 才是「什么都不折」。
 * dsc 0.6.3 的三档里 `detailed` 曾经等于现在的 `verbose`，本次按 dsh 的语义改回
 * 「折叠 + 只折历史轮」，原来那种「全摊开」的行为改由 `verbose` 承担。
 */
export type UiProcessFold = 'compact' | 'standard' | 'detailed' | 'verbose'

/**
 * TUI 底部状态栏各段的显隐（存在 `~/.dsc/settings.json` 的 `ui.statusBar`）。
 * 全部必填：读档由 {@link normalizeStatusBarPrefs} 补齐，消费方不需要判缺。
 * 出厂口径对齐 dsh 底栏设置的默认——只留「身份 + 在看什么」，effort/模式/
 * Token 累计/会话 ID 这类设定完就不再看的默认收掉，要的在 设置 → 终端界面 →
 * 状态栏 子页里打开。
 */
export interface StatusBarPrefsView {
  /** 模型名。 */
  model: boolean
  /** 思考强度（effort 档位）。 */
  effort: boolean
  /** 缓存命中率。 */
  cache: boolean
  /** Token 累计（input/output）。 */
  tokens: boolean
  /** 本会话费用估算（仅 DeepSeek 官方端点有数据）。 */
  cost: boolean
  /** 会话模式（执行/计划/探索/免打扰）。 */
  mode: boolean
  /** 权限模式。 */
  policy: boolean
  /** 上下文用量百分比。 */
  ctx: boolean
  /** 工作目录。 */
  cwd: boolean
  /** 当前会话短 id。 */
  session: boolean
}

/** 侧栏界面偏好，存在 `~/.dsc/settings.json`，桌面端与以后别的界面共用。 */
export interface UiPrefsView {
  sessionSort: SessionSortKey
  /** 侧栏会话列表的分组方式。 */
  sessionGroup: SessionGroupKey
  /** 已归档会话在侧栏里的显隐。 */
  archivedFilter: ArchivedFilter
  /** 手动拖出来的工作区顺序（cwd 绝对路径）；没拖过是空数组。 */
  workspaceOrder: string[]
  /** 工作区显示名别名：cwd → 想要的名字。 */
  workspaceAliases: Record<string, string>
  /** 主题模式。 */
  themeMode: ThemeMode
  /** 字号缩放倍数（设置页滑杆可调范围 0.85–1.35）。 */
  fontSize: UiFontSize
  /** 按钮缩放倍数（设置页滑杆可调范围 0.9–1.5），桌面端把它写成 `--dsc-btn-scale`。 */
  buttonScale: number
  /** 密度档位。 */
  density: UiDensity
  /** 过程折叠程度（紧凑 / 标准 / 详细 / 逐条摊开），默认 standard。 */
  processFold: UiProcessFold
  /**
   * 定稿的思考行默认展开吗（默认 false = 折叠成一行「思考过程」）。
   *
   * 为什么与 {@link processFold} 分成两套：档位管的是「整轮折不折、阶段要不要分组」这一层
   * 结构，这两项管的是最里层「单条思考 / 单张工具卡默认长什么样」。dsh 没有这两项——它的
   * 可选性只体现在四个档位加上每层手动开合，所以这是 dsc 自己的增量（用户要求「可选折叠
   * 思考、工具调用」）。两条轴正交：档位是粗档，这两项是在档位之上的默认态微调。
   *
   * 只管**定稿**条目：跑动中的那一段思考永远是展开的（它是「现在在干什么」的唯一线索，
   * 见 ThinkingBlock 的 showPreview 那条同样的理由）。用户手点的展开态优先于这里的默认值。
   */
  reasoningDefaultOpen: boolean
  /** 工具卡默认展开吗（默认 false = 只显示一行「工具名 + 状态」）。口径同 {@link reasoningDefaultOpen}。 */
  toolDefaultOpen: boolean
  /**
   * 侧栏各工作区分组的展开状态（cwd → 展开？），对齐 dsh 的 groupExpansion：
   * 点工作区行只切换它自己，别的组不跟着动；关掉再开也记得住。
   * 键缺失 = 用默认（活动组与树模式父组展开，其余收起）。
   */
  sessionExpansion: Record<string, boolean>
  /**
   * 「手动排序」档下各工作区里会话行的顺序（cwd → 会话 jsonl 路径序列），
   * 对齐 dsh 的 sessionOrderByAccount：会话行拖完落在这里，置顶块照旧排最前。
   * 键缺失或表里没有的会话按最近使用排在后面。
   */
  sessionOrder: Record<string, string[]>
  /**
   * 一轮干完（跑动 → 空闲）时播一声完成提示音吗（默认开）。桌面端行为偏好：
   * 声音由桌面渲染层用 Web Audio 现场合成，远程界面（手机浏览器）不消费这几项。
   */
  turnCompleteSound: boolean
  /** 完成提示音的音色编号（1–14，设置里选中即试听）；读档越界时夹回。 */
  turnCompleteSoundVariant: number
  /**
   * 窗口不在前台（最小化 / 缩托盘 / 失焦）时，一轮干完弹一条系统通知吗（默认开）。
   * 通知由桌面主进程创建，点击唤回主窗口；前台时不弹——那时提示音已经足够。
   */
  turnCompleteNotify: boolean
  /** TUI 底部状态栏各段的显隐；读档缺键由 {@link normalizeStatusBarPrefs} 回落默认。 */
  statusBar: StatusBarPrefsView
}

/** 状态栏段显隐的出厂默认（口径见 {@link StatusBarPrefsView}）。 */
export const DEFAULT_STATUS_BAR_PREFS: StatusBarPrefsView = {
  model: true,
  effort: false,
  cache: true,
  tokens: false,
  cost: true,
  mode: false,
  policy: true,
  ctx: true,
  cwd: true,
  session: false,
}

/**
 * 把老存档 / 老宿主 / 手改坏档里的 `ui.statusBar` 归一成全键视图：对象缺失或
 * 单键缺失都回落出厂默认（与 prefs.ts 的读档白名单同一口径，坏档不拦启动）。
 * 桌面渲染层与 TUI 共用这一份——prefs.ts 带着 node 内置模块，渲染层 import 不得。
 */
export function normalizeStatusBarPrefs(value: unknown): StatusBarPrefsView {
  const source = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const merged = { ...DEFAULT_STATUS_BAR_PREFS }
  for (const key of Object.keys(DEFAULT_STATUS_BAR_PREFS) as (keyof StatusBarPrefsView)[]) {
    if (typeof source[key] === 'boolean') merged[key] = source[key] as boolean
  }
  return merged
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
  /** 这个插件贡献的设置分区 id；undefined = 没有可配置项，详情页不画配置表单。 */
  settingsSection?: string
  /** 插件声明的内核 API 版本；未声明时 undefined。 */
  apiVersion?: number
  /** 加载失败/被自动停用的原因（回滚说明），正常时 undefined。 */
  problem?: string
}

/** 一个队友（智能体团队派出去的子智能体）；侧栏「队友」这一档看到的行。 */
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
  /**
   * 出生会话 id（派它的那个会话，名册持久化下来的）。
   * roster.json 是跨重启的台账，字段后加；老记录没有这一项，读档时按 undefined 处理。
   */
  sessionId?: string
}

/** 可切换的模型（/model 补全与校验的数据源）。 */
export interface ModelChoiceView {
  /** 可直接传给 /model 的完整值：`[端点/]模型名`。 */
  value: string
  provider: string
  model: string
  /** 面板展示用说明（端点显示名 · 上下文窗口）。 */
  description: string
  /** 上下文窗口（面板右侧标注用）。 */
  contextWindow: number
  /** 这个模型支持的思考档位；思考面板据此收起不支持的档位。 */
  thinkingLevels: ThinkingLevel[]
  /** 这个模型能接受的输入类型。 */
  modalities: Modality[]
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
  | { type: 'text'; key: string; label: string; placeholder?: string; help?: string; mono?: boolean; group?: string }
  | { type: 'number'; key: string; label: string; min?: number; max?: number; step?: number; help?: string; group?: string }
  | { type: 'select'; key: string; label: string; options: SettingsOption[]; help?: string; group?: string }
  | { type: 'switch'; key: string; label: string; help?: string; group?: string }
  | { type: 'info'; label?: string; text: string; mono?: boolean; copyable?: boolean; help?: string; group?: string }
  | { type: 'button'; action: string; label: string; style?: 'primary' | 'ghost'; help?: string; group?: string }

/**
 * 分区内的一个分组（dsh 同款机制）：`fields` 里带 `group: id` 的字段收进这组，
 * TUI 在根页只画一行「组标题 … ›」，Enter 进子页才见到组内字段；桌面端不做
 * 子页导航，渲染成组头（相邻同组字段聚在一张组标题下）。组的 key 仍是分区里
 * 的扁平键，values/save 链路与顶层字段零差别。
 */
export interface SettingsGroupView {
  id: string
  title: string
  /** 聚焦组行时提示条里的一句话说明。 */
  description?: string
}

/** 一个设置分区的投影（顺序由 order 决定，小者在前）。 */
export interface SettingsSectionView {
  id: string
  title: string
  /** nav 行下方的一句话说明。 */
  subtitle?: string
  order: number
  /** 分组声明（display 顺序）；字段按 `group` id 归组，没进组的字段留在根页。 */
  groups?: SettingsGroupView[]
  /**
   * 内核内置分区，或声明了 inSettings 的插件代管分区（插件里的内核级功能，
   * 例如远程控制：它登记在插件上，但界面归设置页）。
   */
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

/**
 * 配对数据的结构化载荷：桌面端据此弹「连接手机」弹窗（画码与二维码），
 * 手机端也可以扫 {@link PairShareData.url} 直接把码带进登录框。
 *
 * 为什么不是只给一句 notice 文案：文案里的码一闪就没了，用户错过就得重新生成；
 * 弹窗要一直挂在屏幕上，界面就必须拿到「码 + 可扫地址 + 过期时刻」这三个字段。
 */
export interface PairShareData {
  /** 载荷种类；今天只有配对码这一种，将来加别的一起收在这条判别位上。 */
  kind: 'pair-code'
  /** 8 位配对码。明文只在宿主内存与这条载荷里出现，绝不落盘、不进日志。 */
  code: string
  /** 带 `?code=` 的完整访问地址：手机扫码打开即带上码，也可以整串复制。 */
  url: string
  /** 过期时刻（epoch 毫秒）；到点这张码就用不了了。 */
  expiresAt: number
}

/**
 * 「用系统浏览器打开一个链接」的载荷：检查更新发现新版时随回执带给桌面端，
 * 界面据此打开发布页（宿主自己够不着 shell）。
 */
export interface LinkShareData {
  kind: 'url'
  /** 要打开的地址；桌面端只放行 http/https。 */
  url: string
}

/** 写入或动作成功时的载荷：提示条文案之外，还可以带一份结构化数据给界面画弹窗。 */
export interface SettingsMutationOk {
  notice?: string
  data?: PairShareData | LinkShareData
}

/** 写入或动作的结果：失败原因直接显示在控件下方。 */
export type SettingsMutation = ({ ok: true } & SettingsMutationOk) | { ok: false; error: string }

// ── 模型配置（设置「模型」分区的数据源） ──────────────────────────────────────

/** 端点里的一个模型。 */
export interface ProviderModelView {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /** 这个模型支持的思考档位；空数组 = 没有思考开关，界面只留「默认」。 */
  thinkingLevels: ThinkingLevel[]
  /** 档位走哪个请求字段（见 {@link ThinkingParam}）。 */
  thinkingParam: ThinkingParam
  /** `reasoning-effort` 时档位 → 线上值；没写的档用内置缺省值。 */
  effortMap: EffortMap
  /** 能接受的输入类型；没勾照片就不能往这个模型发图。 */
  modalities: Modality[]
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

/**
 * 跨会话运行状态（T21）：侧栏会话行状态点的值域。
 * working = 那个会话正在跑（当前回合进行中，或它是干着活的队友）；
 * awaiting-approval = 挂着等用户批；
 * just-finished = 后台跑完时你没在看（0.6.48 常驻多 agent），点开即熄。
 */
export type SessionRunState = 'working' | 'awaiting-approval' | 'just-finished'

/** UI 每帧读取的运行时快照（useSyncExternalStore 的 getSnapshot 返回）。 */
export interface RuntimeSnapshot {
  entries: TranscriptEntry[]
  status: StatusView
  /** 各功能点自己贡献的界面片段（见 {@link RuntimeSurfaces}）。 */
  surfaces: RuntimeSurfaces
  /** refreshSessions() 填充的会话列表缓存。 */
  sessions: SessionSummary[]
  sessionsLoading: boolean
  /**
   * 跨会话运行状态面（T21）：会话 jsonl 路径 → 运行状态，侧栏状态点的数据源。
   * 收录当前会话（按 turnState）、后台常驻 agent（dsc/agent-status 事件喂进来的，
   * 含「已完成未读」徽标）与正干着活的队友会话；不在场/收工已看的会话不出现。
   */
  sessionStates: Record<string, SessionRunState>
  /**
   * 状态栏右下角的子代理 chip（0.6.65）：只收当前查看会话、还在干活的队友。
   * 别的会话的动态不进状态栏——出口是 /resume 行内状态点（sessionStates）与
   * /agents 浮层；任务收工（settle）或切走会话即从这里消失。
   */
  subagents: Array<{ sessionPath: string; state: SessionRunState }>
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
 *   - 0.6.48 起：切换会话**不打断**原来那个会话正在跑的回合（它转入后台
 *     继续跑完，侧栏亮状态点与「已完成」徽标）；打断只发生在显式 interrupt()。
 */
export interface DscRuntime {
  subscribe(listener: () => void): () => void
  getSnapshot(): RuntimeSnapshot
  /**
   * 提交一条用户消息（走 agent.followup）。
   * @param images - 随消息发送的图片（data URL 清单）；当前模型没勾「照片」时发送方要先拦住。
   */
  submit(text: string, images?: string[]): void
  /**
   * 取消在跑的回合。缺省停当前查看的会话；指定会话 jsonl 路径时停那个**后台**
   * 会话（0.6.49：侧栏行右键「停止」）——回合以 aborted 收尾，挂着的审批卡
   * 随信号兜底成 reject。
   */
  interrupt(filePath?: string): void
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
  /** 用量统计（设置「用量统计」分区数据源；聚合 ~/.dsc/usage/usage.jsonl）。 */
  usageStats(): Promise<UsageStatsView>
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
   * 队友清单（智能体团队开着才有内容；关着返回空数组）。
   * UI 在「队友」这一档开着时轮询它。
   */
  listTeammates(): TeammateView[]
  /**
   * 收掉一个队友（用户从界面上动手；等价于 `subagent` 工具的 stop）。
   * 队友名字不存在时返回的那句话就是明确的错误说明，不抛错。
   */
  stopTeammate(name: string): Promise<string>
  /**
   * 给队友投一句话（用户从界面上传话；等价于 `subagent` 工具的 message）。
   * 名字不存在或话是空的，返回的那句话就是明确的错误说明，不抛错。
   */
  messageTeammate(name: string, text: string): Promise<string>
  /**
   * 把一个收工的队友从名册移除（运行记录文件一并删除，名字随之释放）。
   * 还在干活的队友会被拒绝（先停止）；名字不存在时返回的那句话就是明确的错误说明，不抛错。
   */
  removeTeammate(name: string): Promise<string>
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
  /**
   * 拉一个端点线上可用的模型清单（T23，设置 → 模型里「拉取清单」用）。
   * 连不上或应答认不得时 reject（消息可直接展示）。
   */
  discoverModels(provider: string): Promise<string[]>
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
  /**
   * 回答审批（四种决定；scope 语义见 ApprovalAnswer）。
   * @param source - 这个答案从哪儿点下来的：省略 = 宿主界面（桌面端 / 终端），
   *                 `'web'` = 手机浏览器（远程控制）。只影响审计记录里那一栏。
   */
  answerApproval(answer: ApprovalAnswer, source?: 'app' | 'web'): void
  /** 回答模型发起的提问（ask_user）；文本就是答案，一批多题时按题序一次交一题。 */
  answerQuestion(answer: string): void
  /** 回答计划评审卡（批准 = 切回执行模式开工）；拒绝时可附反馈原话，模型按它改方案。 */
  answerPlan(decision: PlanDecision, feedback?: string): void
  /** 切换协作模式（执行 / 计划 / 探索 / 免打扰），写进会话记录。 */
  setMode(mode: CollaborationMode): void
  /**
   * 模式（预设）投影：当前会话用的、新会话默认用的、全部可选。
   * 输入框那颗模式旋钮与设置页「模式」分区都读它。
   */
  listPresets(): PresetSurface
  /** 读一个模式的原文（「查看配置」只读用）；不存在时 ok:false 带一句话。 */
  readPreset(name: string): Promise<PresetFileView>
  /** 切换当前会话的模式（写会话记录，恢复会话时一起恢复）。 */
  usePreset(name: string): SettingsMutation
  /** 新建或覆盖一个模式（写 `~/.dsc/presets/<名字>.md`）。 */
  savePreset(draft: PresetDraft): SettingsMutation
  /** 删掉一个自定义模式（内置四个删不掉）。 */
  removePreset(name: string): SettingsMutation
  /** 设为新会话默认模式（写 `~/.dsc/settings.json`）。 */
  setDefaultPreset(name: string): SettingsMutation
  /**
   * 全部已注册工具（名字 / 风险 / 一行说明 / 归属模式）。
   * 设置 → 模式 的工具多选读它；这也是界面第一次能看见完整工具目录。
   */
  listTools(): ToolEntryView[]
  /** 用户侧目标动作：暂停 / 继续 / 清空 / 放宽轮次上限。 */
  goalAction(action: 'pause' | 'resume' | 'clear' | 'extend'): SettingsMutation
  /** 手动清空任务清单（清单条上的小按钮）。 */
  clearTodos(): void
  /** 退出应用（dispose → 进程结束）。 */
  exit(): void
  /** 释放全部资源（dispose agent、退订）；集成层在 ink unmount 后调用。 */
  dispose(): void
}
