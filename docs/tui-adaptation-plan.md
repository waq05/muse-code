# TUI 功能适配与体验完善方案（2026-10-04 定稿）

> 对象：`msc` 终端界面（`src/app/`，ink 6 + React 19，约 700 行 MVP）。
> 基线：`DscRuntime` 契约（`src/contract.ts:1011`）+ 快照 surfaces——**宿主侧能力几乎全在，缺口集中在「数据已下发但 TUI 不渲染、不接按键」**。
> 参照：codex TUI（`D:\codex\codex\codex-rs\tui`）、dsh-TUI（`D:\deepseek-harness\dsh-TUI`）四路侦察结论（2026-10-04）。
> 原则：不改宿主、不加协议（个别只加可选字段），业务逻辑零复制；键盘优先、单屏可读；所有新键位进 `/help`。

## 缺口盘点（四路侦察结论，已完成）

### P0 核心流程硬伤
1. **计划评审卡与提问卡不可用**：`pendingPlan` / `pendingQuestion` 在快照里，TUI 不渲染、无作答按键，回合挂死只能 Ctrl+C。
2. **审批只有 y/n**：宿主四档 `allow-once / allow-session / allow-always / reject`（`approval.ts:552`），`reason / risk / scopes / diff`（write/edit 弹卡前算好的 unified diff，`approval.ts:83`）全部不显示。
3. **权限模式与思考强度无入口**：`setPolicy` / `setEffort` 在 TUI 侧是死代码，`/effort` 只剩占位。

### P1 数据在、UI 不画
4. 六类条目静默丢弃（`ChatView.tsx:81` default null）：`plan` / `turn-end` / `turn-max-tokens` / `model-retry` / `changes` / `turnDiff`。
5. todo / goal / 后台会话状态（`sessionStates`）不渲染；steering 插话无标记；压缩落点不画。
6. SessionPicker 只读 MVP：12 条上限、无标题、无搜索/分页/归档/删除/改名/置顶/分叉（runtime API 全有）。
7. 无滚动回看（尾部 30 条，`ChatView.tsx:17`）；工具卡无耗时、无专属渲染。
8. 输入框单行简陋：无多行、无 @-文件补全、无光标移动、历史不持久化、无图片附加。
9. 状态栏缺 cwd / 分支 / 协作模式 / 权限模式 / 上下文占用 / 缓存命中率。
10. 更新检查接不上（入口在设置分区）；无完成通知。

### P2 bug
11. `/review` 撞名：file-review 插件默认启用，`Map.set` 覆盖内置审查命令（`file-review.ts:365` + `commands.ts:44`）。

## 批次计划

### 批次一（0.6.51）— 核心流程闭环
| 项 | 做法 | 落点 |
| --- | --- | --- |
| 计划评审卡 | 新组件 `PlanReviewCard`：标题 + 落盘文件 + 计划全文（超长折叠，`v` 展开收起）；`y` 批准（`answerPlan('approved')`，自动切执行档）、`n` 拒绝、`e` 带反馈拒绝（Composer 进入反馈模式，提交即 `answerPlan('rejected', feedback)`，Esc 取消反馈回卡片）。语义对齐桌面端 TaskDock.PlanReview（批准 / 带反馈退回） | `src/app/PlanReviewCard.tsx`（新）、`App.tsx` |
| 提问卡 | 新组件 `AskCard`：渲染整批题目（`questions[]`），逐题作答即时提交（`answerQuestion` 按题序收，`ask.ts:175`）。单选按数字键立即作答并推进；多选数字键勾选、Enter（空输入）提交；自由文本直接在 Composer 输入 Enter 提交；Esc 跳过本题（写「（用户跳过了这一题）」，与桌面端 `TaskDock.tsx:225` 同口径） | `src/app/AskCard.tsx`（新）、`App.tsx`、`Composer.tsx` |
| 审批四档 | `y`=允许一次、`a`=本会话允许、`p`=永久允许（写 policy.rules）、`n`/Esc=拒绝；只渲染卡上 `scopes` 允许的按键，`hardline=true` 只留拒绝。卡片补 `reason`（为何要问）、`risk` 风险档、`policy/mode` 当前档位、`sessionPath`（后台会话来源标注）、内嵌 diff（`+` 绿 `−` 红 hunk 渲染，超长折叠 `v` 展开） | `ApprovalCard.tsx`、`App.tsx`、`theme.ts`（diff 色） |
| /policy | 内置命令：无参列出四档与当前档，带参切换（readonly/auto-edit/full-access/ai-review，前缀匹配），走 `runtime.setPolicy` | `commands.ts`、`commands-completion.ts` |
| /effort | 恢复内置命令：无参显示当前档与可选档，带参切换（default/off/low/high/max），走 `runtime.setEffort`（不支持档位的报错已有通道） | 同上 |
| /review 撞名 | file-review 的同名命令改名 `/file-review`，内置 `/review`（审查工作区改动）回归 | `file-review.ts:365` |

键盘优先级（App 顶层）：Ctrl+C → 审批卡 → 提问卡 → 计划卡 → 会话选择器 → 回看浮层（批次三）→ Composer。提问卡打开时 Composer 保持可用（自由文本作答），计划反馈模式同理；两者由 App 显式路由 onSubmit。

### 批次二（0.6.52）— 信息呈现 + 状态栏增强
| 项 | 做法 |
| --- | --- |
| 六类条目渲染 | `turn-end`：aborted→「⏹ 已停止」、error→「✗ 过程失败」（completed 不出行）；`turn-max-tokens`→「⚠ 输出达到长度上限」；`model-retry`→「↻ 第 N 次重试：原因」；`changes`/`turnDiff`→轮尾「文件已更改」聚合卡（文件名 + added/removed 行数）；`plan` 条目→计划卡（带批准/拒绝状态徽标，评审卡收起后历史仍在） |
| todo / goal 常驻条 | 输入框上方纯展示条：goal 条（目标 + 阶段 + 轮次）、todo 条（active 项 + done/total 进度）——操作走 /goal 与 /todo 命令（终端里单行命令比隐藏热键更可发现，故不做热键）——数据源 `surfaces.goal` / `surfaces.todos` |
| steering 标记 | user 条目 `steering: true` → 行首「↩ 插话」徽标 |
| 压缩落点 | system/user 条目带 `compaction` → 独立分隔行「⎯ 已压缩历史 · 第 N 次 ⎯」 |
| 工具耗时 | ToolCard 有 `durationMs` 时状态后追加「· 1.2s」 |
| 后台会话状态 | `sessionStates` 非空时状态栏追加一行：working/awaiting-approval/just-finished 的会话短 id 分色列出（后台会话可感知；`i` 跳转、`s` 停止放批次三后评估） |
| **状态栏增强（用户点名）** | 两行制：第一行回合状态 + 协作模式 + 权限模式（档位名读 surfaces 投影）；第二行 cwd 尾部、模型、effort、会话累计用量（in↑/out↓ + **前缀缓存命中率**，= 命中/(命中+未命中)，只累计上报过明细的请求）、会话短 id；有后台会话时第三行状态点。git 分支暂不做（快照组装必须同步，异步 git 调用放不进去；分支看 dock/`/status`） |
| 缓存数据通道 | `CoreEvent.usage` 本来就带可选 `cacheHitTokens/cacheMissTokens`（`events.ts:55`），adapter 累加后进 `TokenUsageView`（加可选字段，桌面端向后兼容） |
| /usage 命令 | 读 `runtime.usageStats()` 聚合（~/.dsc/usage/usage.jsonl）：总量、请求轮数、缓存命中率、按模型拆分 top、活跃天数——文本报告经 notice 出条目 |
| UI 统一 | 状态栏改两行制：第一行模式与状态（彩色标签），第二行路径/模型/用量（暗淡）；theme 增加 diff 色与标签组间距 |

### 批次三（0.6.53）— 会话与输入
| 项 | 做法 |
| --- | --- |
| SessionPicker 升级 | 全量列表 + 输入即筛选（标题/cwd/会话 id 子串）；显示标题（`title` 字段现成）+ 置顶标 + 归档标 + 后台状态点；Tab 切「活动 / 归档」两页；键位：Enter 打开、`r` 改名（Composer 改名模式）、`p` 置顶、`a` 归档（归档页 `u` 恢复）、`x` 删除（二次确认）、`f` 按最后一条用户消息分叉。分页↑↓ 循环滚动 |
| Esc 打断 | 空闲无浮层时 Esc 中断当前回合（对齐 codex/dsh）；补全面板开着时 Esc 仍只关面板 |
| Ctrl+O 回看浮层 | 全量 transcript 浮层（↑↓/PgUp/PgDn/j/k 滚动、q/Esc/Ctrl+O 关闭），复用 Entry 渲染、去直播光标；Ctrl+T 保留「思考展开」不变 |
| 多行输入 | Composer 重写为光标模型：Shift+Enter / Ctrl+J 换行，←→/Home/End 移动，Ctrl+U/K/W 编辑；粘贴含换行整段插入（PasteBurst-lite：粘贴进来的换行不压平） |
| @-文件补全 | 输入 `@` 触发文件候选（cwd 递归，子序列模糊匹配，复用 core 无 node 依赖约束——文件枚举走宿主 `runtime.dock('fs-list')` 已有能力） |
| 历史持久化 | 输入历史落 `~/.dsc/.tui-history`（上限 200 条，去重） |
| 图片附加 | 提交文本中出现的本地图片文件路径（存在且后缀 png/jpg/jpeg/webp/gif）自动读为 data URL 附加（`submit(text, images)` 通道现成）；模型不支持照片时提示 |

### 批次四（0.6.54）— 进阶
- `/diff`：工作区 git diff 文本报告（走 dock 的 git-diff 能力）。
- 完成通知：回合 working→idle 时 BEL（`\x07`），可配 OSC9。
- `/model` 无参弹选择器：全屏浮层列模型（上下文窗口/思考档位），Enter 切换。
- `/copy`：复制上一条回复到剪贴板（Windows `clip`）。
- 主题：不做明暗切换（终端 16 色限制），只把批次一~二沉淀的配色全部收敛进 theme.ts。

### 远期（不承诺）
双 Esc 回溯 rewind（fork+回放）、/trace 轨迹页、侧栏分栏面板、图片缩略图（kitty/sixel）、vim 模式、/keymap 重映射、多语言、外部 agent 会话迁移。

## UI 设计优化原则（贯穿各批次）
- 三档文字 + 四状态色不扩权：新元素一律从 `theme.ts` 取值，不硬编码色值（对齐 hermes/tokens 令牌纪律）。
- 卡片语言统一：浮动块（审批/计划/提问/选择器/浮层）双线框；内联块（todo/goal/文件更改）无框贴排；状态标签「图标 + 词」从 `STATUS_LABEL` 族取。
- 密度优先：默认折叠、一行优先；展开是显式动作（`v`/`t`/Ctrl+O），关掉即回。
- 键位提示就地在卡片尾行标注（`[y] 允许一次` 式），不藏进帮助。
- 每批次过一遍整屏效果再提交（DSC_DESKTOP_SHOT 不适用于 TUI，用 `pnpm dev` + 真终端人工走查 + 既有 23 个检查脚本回归）。

## 版本与提交节奏
每批次一个版本（0.6.51 → 0.6.54），约定式提交（feat:/fix:），每批完成：`pnpm build` + typecheck + 全量检查脚本 → 提交 → dev log 记阶段（77 起）。批次一、二优先落地；三、四视反馈排期。
