# 三家对标产品功能清单（dsh / codex / Muse Code）

[对标计划书](harness-benchmark-roadmap.md)的证据底料：三家产品的**全面功能清单**，2026-10-02 分别从源码逐包梳理得出。计划书只引用本清单的结论（§7 差距登记），想核对某条差距的出处就回到这里。

| 想知道 | 去看 |
| --- | --- |
| 这些清单怎么用、差距怎么排 | [harness-benchmark-roadmap.md](harness-benchmark-roadmap.md) |
| **本文档** | **三家各有什么（按能力域分组，带源码出处）** |

取材方法与口径：

- **dsh**：`D:\deepseek-harness\deepseek-harness`，约 60 个功能包组、60+ client UI 插件包、4 个 app。工具权威目录 `docs/tool-catalog.md`、配置权威目录 `docs/config-catalog.md`（由脚本从运行时生成）。
- **codex**：`D:\codex\codex`，Rust 主体 `codex-rs`（150+ crate）+ `sdk/`（TS/Python）+ `docs/`。
- **Muse Code**：本仓库，基于代码取证 + [development-log.md](development-log.md) 全部 44 个阶段。
- 全部为只读源码梳理，未运行任何一家；「未见」指在该仓库活动代码中未找到，不排除文档口径或仓库外实现。

---

## 一、dsh（DeepSeek Harness）

定位：一切皆插件的 Cordis agent harness。每个模型可见工具都有独立包，UI 也是插件（`packages/client/ui-*`）。

### 1. 会话管理
- 事件溯源会话日志：JSONL 可选 Zstandard 压缩（`packages/session/session-persistence-jsonl`），格式版本迁移链 v0→v4（`session-format-*`）
- 列表：工作区分组或扁平、最近/手动排序、置顶分区、拖拽、每组 5 条折叠展开（`ui-workspace/README.md`）
- 管理操作：新建、改名、排序、搜索、fork、归档、工作区删除；子代理会话隐藏；**待处理交互警告圆点**；有定时任务的空闲会话显示时钟标记
- 多会话并行：Host 同时驱动多 agent/多 session；桌面退出守卫统计 running agents（含子代理、审批等待、排队消息、jobs、armed reminders）
- resume：持久会话恢复 + 崩溃中断 turn 修复（`core/agent-loop`）；语义崩溃检查点（`session-checkpoint-policy`）
- fork：会话行 fork 菜单 + `subagent_fork` 工具（以父会话已完成 turns 播种，`subagent-fork-in-process`）
- **会话标题生成**（`session-title`）：首条消息回退词 / LLM 策略（两个包：首条 prompt 或全部 prompts）/ 用户改名 + `refresh()` 重生成；永不进模型输入
- 查询/导出：统一查询层（list/filter/read/trace/**全文搜索**，`session-query`）+ SQLite FTS5 后端；`/export` 导出会话日志 ZIP（`session-log-export`）

### 2. 模型与 provider
- DeepSeek 原生 adapter：Messages 协议、thinking 档位（off/low/high/max）、图像 Files API（上传 + base64 回退）、私有 wire 扩展（`llm-deepseek` + `docs/deepseek-llm-api-wire-extensions.md`）
- 多 provider：pi-ai 目录（anthropic/openai/kimi/GLM 等 + 手工声明网关）、OAuth/交互式 key 登录、per-route 兼容开关、自托管端点的思考预算参数（`llm-pi-ai`）
- 自定义端点：设置页 Add model provider（Provider ID/baseURL/协议三选一/凭据/模型清单 + **「Fetch available models」在线发现**）
- 模型切换：`/model` 弹窗 + composer 模型位；会话已发请求则锁定日志中记录的模型
- 推理档位：Model/Effort 双行选择器（档位来自 Host 模型元数据）；档位词汇可重映射（如 `max: ultra`）
- **token 用量与占用**（`token-meter`）：replay 确定性测量（tokenUsage/contextPressure/contextBreakdown，无模型调用）；UI 上下文占用表 + ContextMeter（`ui-conversation`）；Trajectory 检查器显示 token/duration
- 重试：durable step 边界恢复（`llm-retry`）；DeepSeek 账号 OAuth 登录（`deepseek-account(-platform)`）

### 3. 工具集（30+ 工具包）
- 文件：`read`/`write`/`edit`/`read_image`（`tool-fs` + read-before-write 策略）、Claude-Code 风格 `str_replace_editor`
- 搜索：`glob`/`grep` 内置打包 ripgrep，超限结果 spill 落盘可续读
- Shell：一次性 `bash`/`pwsh` + **持久 PTY 版**（`tool-bash-persistent` 等）+ **六个持久终端工具** `terminal_open/read/send/signal/close/list`（`tool-terminal`）
- **PTC 编程式调用**：`run_code`（模型写 TS 经绑定调全部工具，嵌套调用重入完整安全管线、并发上限、沙箱提权需 justification+审批）；Python 版（CPython 子进程 + fd-3 协议）；Node 运行时
- Web：`web_search`/`web_fetch`，后端可换（DeepSeek 原生/Exa/Perplexity/匿名 HTTP）
- 子代理：`subagent` + `send_message`/`interrupt_agent`/`list_agents`；后端可插拔：in-process spawn/fork、ACP、DSH SDK、**Claude Code、Codex**
- **后台任务**：`run_in_background` + `job_output`/`job_list`/`job_kill`（`tool-jobs`），完成通知经 `agent.inject()` 注入
- 结构化：`todo_write`、`exit_plan_mode`、`create/get/update_goal`、`schedule_create/list/update/delete`（after/at/every/daily/weekly/cron + IANA 时区）、`ask_user_question`
- 交付与发现：`present`（交付卡）、`load_workspace_dependencies`（离线 Python/Node/pnpm 载荷）、`skill`（技能目录 + 本地文件系统技能源 + 内置 Office 技能）、会话历史五工具（`session_search`/`session_trace`/`session_event_*`）、`lsp` 四个只读导航操作
- 运行时自省/管理：`cordis_inspect_*`（Creator mode 只读自省）、`plugin_manager`（安装/启停 bundle，需 danger 权限或审批）
- MCP：stdio + Streamable HTTP、自动重连退避、工具名 `mcp__<server>__<tool>`、server instructions 进 system prompt、stdio 启动前清洗凭据环境变量；`mcp-resources` 三个资源工具
- experimental：Agent Team 九工具、Stagehand 浏览器六工具
- 工具权限：per-agent allow/deny mask（`ctx.tools.restrict`）；pre-execute allow/deny/ask waterfall 管线
- 未见：notebook/Jupyter 工具

### 4. 权限与审批
- 沙箱三档 read-only / workspace-write / danger-full-access；Linux/macOS 本地沙箱、**Windows 受限令牌 ACL**（`sandbox-windows-acl`）
- 审批策略 `ask`/`never` 两档；**fail-closed**（无 answerer 时拒）；**明确只有一次性 allow-once**，无 always-allow/记忆规则/撤销存储（README Known Limitations 原文）；每次请求与结果入审计日志
- 权限预设：sandbox+approval 两旋钮捆绑预设，`/permission` 命令 + 设置默认行 + Auto 实验预设（`permission-presets`）
- 审批卡：composer takeover 卡片，Enter 批准 / Escape 拒绝
- 危险动作：沙箱拒绝以政策文案回给模型；fs-sandbox 限制会话 workspace 写
- Auto review（实验）：每次工具调用前由当前模型审查，允许则以 Full access 执行、拒绝转人工
- 计划模式：`exit_plan_mode` 呈现计划，approve / 带反馈继续规划

### 5. diff 与代码审查
- 轮尾聚合 changed-files 卡：Host 侧 turn 首尾 git 快照 diff + 文件工具整文件捕获（maxFiles=500），UI 带行数统计
- 审查面板：右侧栏 changes-review tab——unified/side-by-side、换行开关、文件选择器、截断状态提示、Shiki 高亮
- 悬停预览：changed-file 行悬停 500ms 弹该文件 diff 预览（与侧栏共享缓存）
- 工具卡内嵌输出卡（terminal/read/diff/search/web）；正文 `code` 文件引用可点击打开侧栏预览
- 交付卡 `present` + Open in default app / reveal（解析已装编辑器/Git GUI/终端/文件管理器）
- GitHub PR 审查自动化：签名 webhook，PR ready-for-review 自动创建只读 review 会话
- 未见：`/review` 斜杠命令、per-hunk 接受/拒绝、per-tool always-allow

### 6. 命令系统
- 宿主命令：`/plan` `/compact` `/permission` `/export` `/feedback` `/goal` `/model` `/skill`（各由独立包注册）
- 命令基础设施：插件自有命令注册表（三种 dispatch、per-session 目录、附件准入）；client 侧 `/` 触发管道 + 分组候选菜单
- @提及：`@file`（本地 provider + 统一文件/会话选择器）、`@session` 跨会话引用、`@` 子代理引用
- 未见：用户自定义命令文件（命令只能由插件注册）

### 7. 上下文工程
- system prompt 组装：sections/variables/tool-schema sources 插件可扩展
- AGENTS.md 记忆链：`$DSH_HOME/AGENTS.md` + 项目根→cwd 全链（AGENTS.md/CLAUDE.md + .local 叠加）、去重、65,536 字节预算、深层目录增量发现、resume 对账
- 压缩：token 压力自动压缩 + overflow 后压缩重试 + `/compact` 手动；**超限工具输出先裁剪**（`compaction-tool-result-pruner`）；**图像预算卸载**（`compaction-image-offload`）
- 溢出保护：超限文本/图像落盘为可恢复文件 + 定位符回给模型（spill 组）
- 上下文注入：每步时钟/浏览器时区/elapsed（`time-context`）、tmux 感知、跨会话快照引用（不受信上下文）
- 计划/todo/goal：todos 投影清单；plan mode + 状态 chip；goal 持久目标 + 自动 continuation 轮次（含 blocked 下限轮数）

### 8. 终端与执行
- shell seam：bash/pwsh 各有 local 与 sandbox 两版；每调用新进程、托管环境变量；长输出截尾 + 全量落盘；**超时不 kill 而是转后台 job**
- 后台任务：per-owner 准入、输出 ring、事件流；前台 job 化路径
- 持久终端：PTY、readiness 检测、有界行输出；用户交互终端 controller（screen recovery）
- 信号：`terminal_signal` 白名单（SIGINT/SIGTERM/SIGKILL/SIGTSTP/SIGHUP，对 shell 的 SIGKILL 拒绝）
- **SSH 执行**：OpenSSH 连接配置、远程 subprocess/terminal/fs、远程沙箱效果约束（`packages/ssh/*`）

### 9. UI 形态
- 布局：三栏 AppFrame（左栏 264–420px、折叠 56px rail、右栏 45%→70%）；可停靠分页树（`ui-dockkit`）；右侧栏多 tab：文件树/交互终端/沙箱浏览器/文档预览（Markdown、code、image、PDF、Office、HTML）
- 开始页：Session Intent hero + 工作区选择；目录选择三后端（native OS chooser / Miller 列浏览 / 自动）
- 主题：light/dark/system + 内容字号档 + `--dsw-*` token + 第三方主题注册
- 快捷键：按 device×OS 默认、覆盖持久化、双键 chord、冲突检测；`ui-shortcuts` 命令浏览/搜索；审批 Enter/Escape
- 设置页：General / Models（provider 卡+自定义 API+发现）/ Plugins 分功能 tab / Account / Plugin inventory
- 会话内：工具卡（root 树+嵌套 subcall）、Trajectory 视图（turn-aware 事件台账+时间线+记录检查器）、Reasoning 预览/Verbose 模式、**Like/Dislike 消息评分**（`ui-message-feedback`）、附件栏（拖放/图片 gallery/lightbox）+ 流式上传、上下文占用表
- 通知：仅桌面更新系统通知；会话/任务完成无 OS 通知
- i18n：zh/en + 浏览器回退

### 10. 传输与部署
- CLI：`dsh web`（本地 server + 自动开浏览器）、`--profile headless`（一次性任务）、`--profile sdk`（JSON-RPC stdio）、`--profile acp`、`dsh plugin`、`--patch` 配置覆盖层、`--dump-config[-schema]`
- HMR：监视 profile manifest + patch，插件代码与配置热重载
- Web Host：named routes + WebSocket + SPA fallback；typed Client↔Host gateway + 各 controller
- Desktop：Electron 壳（端口 19387）、托盘、退出任务守卫、应用内自动更新（强制更新流、签名）、`dsh://open` 协议、**内置离线 Python(numpy/pandas/python-docx/pptx/openpyxl/Pillow/lxml/XlsxWriter)/Node/pnpm 载荷**、内置 Office 技能、麦克风权限管理
- SDK：TS + Python（打包 dsh 可执行与原生 sidecar）；ACP server；Webhook 规则路由外部事件为会话
- 网络代理：HTTPS_PROXY 全局支持，拒绝项目 .env 决定代理
- 多设备：浏览器多客户端共享会话（steering inbox 排序、本地回声、原子对账）；OpenTelemetry 遥测

### 11. 其他差异化
- 一切皆插件 + 运行时自修改：插件管理器 UI、HMR、**Creator mode 让 agent 自省并自装插件**、浏览器端动态 Cordis 包
- Agent presets：单进程多组合（standard/ptc/cordis）+ persona 行插件
- Agent Teams（实验）：命名队友 + 持久消息 + 共享任务板 + roster/task board UI
- 语音输入（实验）：录音→可审阅转写；本地 CPU SenseVoice worker
- 防御性治理：同类工具循环提醒守护、协作式超时策略
- 会话日志上传（官方 DeepSeek 请求元数据，可关）
- 基建：双语文档 + 生成目录、recorded-session 快照回放测试、100% 覆盖率 gate

### dsh 招牌能力（按完成度排序）
1. 一切皆插件的运行时可组合架构（插件管理器 + HMR + Creator mode 自装插件）
2. PTC（run_code）编程式工具调用，native/ptc/both 三态呈现
3. 轮尾 changed-files 卡 + 侧栏 review tab 的 turn 级 diff 审查流
4. 三档沙箱 × fail-closed 审批 ×（实验）Auto review，三平台真沙箱（含 Windows ACL）
5. 一套代码五种部署形态：web / desktop / headless / SDK(TS+Python) / ACP
6. 深度 DeepSeek 纵向集成（OAuth、Files API、thinking、原生搜索、日志上传）
7. 多会话 Workspace 管理（置顶/排序/fork/归档/FTS5 全文搜索/ZIP 导出/崩溃检查点）
8. 长任务驱动（goal 自动续轮 + cron 定时跨重启补投 + 后台 job 三工具）
9. 运行中 steering（多客户端排队 inbox）
10. 子代理生态互通（in-process/ACP/SDK/Claude Code/Codex 五后端）
- 未见：notebook、per-hunk 接受/拒绝、`/review` 命令、per-tool always-allow、用户自定义命令文件、移动端专属 UI、会话完成 OS 通知

---

## 二、codex（OpenAI Codex CLI）

定位：Rust 工业级编码 agent，OS 级沙箱 + 客户端-服务架构 + 多前端。

### 1. 会话管理
- Rollout JSONL 持久化（专用 crate：recorder/压缩/search/索引/SQLite 状态库/写锁/维护）
- 历史模型：Legacy 与 Paginated 双模式；`codex resume`（picker/--last/--all）+ 协议侧 by thread_id / by history / by rollout path 三来源 resume，支持带权限 profile 与 turns 分页
- fork：CLI `codex fork` + TUI `/fork` + 协议 `thread/fork`
- 多会话：共享 app-server daemon；`codex agents` 浏览全部会话；**side conversation（`/side`、`/btw` 临时分支）**；`codex queue` 向已有会话排队消息；`/rename` `/archive` `/delete`
- **Backtrack**：Esc-Esc 进 transcript 浏览，左右选 prompt、Enter 回退到该 turn 前并重新编辑（`tui/src/app_backtrack.rs`）
- 轨迹调试：rollout-trace crate + `codex debug replay-trace`、`/rollout`

### 2. 模型与推理
- reasoning effort：none/minimal/low/medium/high/xhigh/max/ultra/persistent/custom（`protocol/src/openai_models.rs:59`）
- 模型目录：后端 `/models` 拉取 + 内置 catalog；`/model` 选择模型与 effort；模型升级/退役迁移文案
- ModelInfo 元数据面：context_window、effective_context_window_percent（默认 95%）、auto_compact_token_limit（默认 90%）、truncation_policy、service tiers、verbosity、输入模态、tool_mode（Direct/CodeMode/CodeModeOnly）、multi_agent_version、**model_messages（可覆盖每个内置工具的描述与 JSON Schema）**
- Provider：OpenAI 默认、自定义 provider、Amazon Bedrock（含 AWS auth/workload identity）、Ollama、LM Studio
- Context 工具：`get_context_remaining`、`new_context`（换新窗口）；token budget 提醒

### 3. 工具集
- **exec_command（统一 exec）**：PTY 运行、`yield_time_ms`/`max_output_tokens`、返回 session_id 供续写、`write_stdin` 交互；`sandbox_permissions`（use_default/with_additional/require_escalated）+ justification + prefix_rule
- `apply_patch`（freeform/custom 工具形态、流式事件）、`update_plan`、`view_image`、`web_search`（hosted）
- **request_permissions**：运行时申请文件系统 read/write 路径 + 网络（session scope）
- request_user_input（结构化提问，同步/异步）、send_message_to_user_async
- curr_time / sleep / wait_for_environment
- **tool_search + 延迟加载**（`tools/src/tool_discovery.rs`）；插件安装类工具；imagegen 图像生成
- MCP client：stdio/HTTP、**OAuth login/logout**、elicitation、MCP resources、CLI `codex mcp list/get/add/remove/login/logout`
- 子代理：V1/V2 两代协议（spawn/send_message/wait/interrupt/resume + **channels 消息板**）、spawn 深度限制
- **Code Mode**：JS/TS 代码方式调工具（V8 运行时，gRPC host、cell actor），per-model 可强制 CodeModeOnly
- 未见：MCP server 模式（把自身暴露为 MCP server；用 app-server/exec-server 代替）

### 4. 权限与审批
- approval_policy：untrusted / on-request（默认）/ **granular**（细分 sandbox_approval、rules、skill_approval、request_permissions、mcp_elicitations）/ never
- sandbox_policy：danger-full-access / read-only / external-sandbox / workspace-write（writable_roots、network_access、exclude_tmpdir）；WritableRoot 支持只读子路径与受保护元数据名（.git、.codex、.git/hooks）
- 平台沙箱：macOS Seatbelt（.sbpl 策略文件 + daemon）、Linux Landlock + seccomp（pid namespace、bwrap）、**Windows 受限令牌/提权后端**（`windows-sandbox-rs` + process-hardening）
- 网络管控：execpolicy 规则、network policy decision、**MITM 网络代理 + 凭据 broker**
- 审批交互：TUI 审批 overlay + diff 预览头部、prefix_rule 复用批准、session 级授权、`/permissions` 命令 + config `[permissions]` 命名 profile
- **Guardian 自动审查**：隔离同步审查者自动复核审批决策（专用模型 codex-auto-review），`/approve` 允许一次被拒重试
- config.toml：分层配置、profiles、`-c` 覆盖、`--strict-config`、约 150 个 feature flags

### 5. diff 与代码审查
- apply_patch 审批：PatchApproval 事件 + TUI diff 渲染
- `/diff`：show git diff (including untracked files)
- **`/review`**：审查范围 UncommittedChanges（含 untracked）/ BaseBranch / Commit / **Custom instructions**；**独立 review 子线程**（独立 review_model、禁用 web_search/view_image）；**结构化输出 findings[title/body/confidence/priority/code_location(文件+行区间)] + overall_correctness/explanation/confidence_score**；delivery 分 inline/detached
- 非交互审查：`codex exec review --uncommitted/--base/--commit`
- git 集成：git-utils crate、`codex apply`（git apply 应用 agent diff）、`/worktree`、doctor 的 git 检查

### 6. 命令系统
- TUI 斜杠命令约 60 条（`tui/src/slash_command.rs`，声明式矩阵管 inline args 与任务中可用性）：`/model /ide /permissions /keymap /vim /setup-default-sandbox /experimental /approve /memories /skills /import /hooks /review /rename /new /archive /delete /resume /fork /worktree /app /init /compact /recap /plan /voice /goal /agents /side /copy /export /raw /tui /diff /mention /status /daemon /warnings /cd /pwd /usage /debug-config /title /statusline /theme /mcp /apps /plugins /logout /quit /exit /feedback /rollout /ps /stop /clear …`
- **自定义 prompts 目录未见**（被 skills + 旧命令迁移器取代，`core-plugins/src/command_migration.rs` 含 Claude Code 命令迁移 profile）
- **@ 文件提及**：`/mention` + 文件搜索弹窗（`file-search` crate）；`@` 文本提及、`$` 工具提及
- 补全：composer 命令弹窗；CLI `codex completion`（shell 补全）

### 7. 上下文工程
- AGENTS.md 发现链：cwd 上溯到 project root（marker 默认 `.git`），根→cwd 全部拼接；`AGENTS.override.md` 与 fallback 文件名；`/init` 生成
- compact：手动 `/compact`、`/recap`；自动阈值 min(配置, 90%)；mid-turn vs pre-turn 压缩语义；远端 compact v2；**图像预算**；fallback 模型；Pre/PostCompact hooks
- `/status`：账户/plan、credits、rate limits（多窗口）、thread token 用量与**美元成本估算**、模型+reasoning、fork 来源、profile、sandbox/approval、远端连接
- 其他：IDE 上下文注入（/ide 选区与打开文件）、`<environment_context>`、`/import` 从 Claude Code 导入

### 8. 交互形态
- 布局：底部 composer + footer 状态行、transcript overlay（Ctrl+T）、审批 overlay、命令/文件搜索/多选 picker、排队消息预览、状态 shimmer
- Backtrack（见 §1）；**可重映射 keymap** + **Vim 模式**
- 附件：剪贴板图片粘贴、CLI `--image`、thread attachments
- 通知：legacy `notify` 钩子；`/warnings` 诊断
- 主题：`/theme` 内置 + `.tmTheme` 自定义 + 实时预览；`/statusline`、`/title`；`/pets` 终端宠物；`/raw` 原始 scrollback；`/export` markdown；**`/voice` 实时语音**（WebRTC）

### 9. 部署形态
- CLI/TUI 默认交互；`codex exec`（别名 e）：`--json`（JSONL 事件）、`--output-last-message`、`--output-schema`（结构化最终输出）、`--skip-git-repo-check`、`--ephemeral`、stdin prompt、resume/fork/review 子命令
- **app-server**：JSON-RPC v2，方法面一目录一域（thread/turn/account/model/review/mcp/memory/plugin/apps/fs/command_exec/feedback/browser_use_config/computer_use_config/realtime…）；传输 stdio/unix/ws/off；可生成 TS 绑定与 JSON Schema；remote control + 共享 daemon
- exec-server 独立执行器服务
- Desktop App（`codex app`，macOS/Windows）+ TUI `/app` 接力；IDE 扩展（VS Code/Cursor/Windsurf）经 app-server
- 云任务：`codex cloud` 浏览/新建/本地 apply（scrollable diff）
- SDK：TypeScript（spawn CLI + JSONL）+ Python + python-runtime
- GitHub Actions：不在本仓库（官方独立仓库）

### 10. 其他差异化
- login：ChatGPT OAuth PKCE + Device Code、API key、Bedrock、workload identity、**密钥存 OS keyring**
- 更新：`codex update` 自更新、启动时 update prompt
- **doctor**：`codex doctor` 体检安装/配置/auth/网络/桌面安全
- 遥测：otel（session）+ analytics（可关）；`/feedback` 上报日志
- Hooks 12 事件（PreToolUse/PermissionRequest/PostToolUse/PreCompact/PostCompact/SessionStart/SessionEnd/UserPromptSubmit/SubagentStart/SubagentStop/Stop/Interrupt，9 类支持 matcher，hook outcome 可改变行为）
- **Memories 两阶段**：phase1 提取 → phase2 汇总落盘 + citations/usage、线程级开关、`codex memory-reset`、外部 agent 记忆导入
- Worktree 隔离：受管 worktree 创建/base 分支/保留数量 + `/worktree`
- Skills/Plugins/Apps：SKILL.md 解析/隐式调用检测；插件 marketplace（add/remove/upgrade/policy）；ChatGPT Apps/Connectors 经 MCP
- 多代理 V2 + agent 命令中心（`/agents`）+ proactive 模式
- 浏览器/Computer Use 确认策略；attestation、cyber access program；`/experimental` 特性开关面板

### codex 招牌能力（按完成度排序）
1. 统一 exec（PTY + 续写 + 交互 stdin）+ 三平台原生沙箱（Seatbelt/Landlock+seccomp/Windows 受限令牌）+ 网络MITM 代理
2. 四档 approval_policy + granular 细粒度 + per-command sandbox_permissions + prefix_rule 复用批准 + Guardian 自动审查
3. Rollout 持久化 + resume/fork/backtrack 回退重编辑 + 共享 daemon 多会话 + 消息排队
4. 独立 review 子代理（uncommitted/base/commit/自定义，结构化 findings+置信度+行级定位）+ `codex exec review`
5. AGENTS.md 链 + 多级 compact（手动/自动 90%/mid-turn/远端 v2）+ token budget 提醒
6. 12 事件 hooks + skills + 插件 marketplace + MCP client（OAuth/elicitation/resources/tool_search）
7. app-server JSON-RPC 协议 + TS/Python SDK + IDE 扩展 + Desktop App + 云任务
8. 多代理 V2（spawn/channels 消息板/interrupt/wait + `/agents` 命令中心）
9. Memories 两阶段写入（提取/汇总 + citations）与线程级开关
10. Code Mode：V8 中以 JS/TS 编排工具调用
- 未见：自定义 prompts 目录加载、把自身暴露为 MCP server、GitHub Actions（独立仓库）

---

## 三、Muse Code（本仓库，dsc）

定位：个人终端 harness，TS + cordis 插件 + Electron 桌面端 + ink TUI + 手机 PWA 遥控端。装配约 45 个内置/官方插件（`src/host/kernel.ts`）。

### 1. 会话管理 ——【完整】
- append-only JSONL 落盘与重放恢复（`src/core/session.ts`）；summary/keep 压缩折叠、state/note 记录、「模型可见 ⟺ 已记录」不变量
- 列表：三种分组（工作区/树/单列）+ 三种排序 + 置顶 + 拖拽 + 每组 5 条增量展开 + 展开态持久化；侧栏本地过滤搜索框
- 重命名/置顶/归档/回收站（30 天）/恢复/永久删除/分叉；sidecar `meta.json` 不污染重放
- 跨会话全文检索：纯 TS 倒排索引（中文 1+2-gram），`session_search` 工具 + `/search` 命令 + 后台回填
- 恢复启动：`--resume auto`（.last-session 指针）；孤儿 tool_calls 自愈清洗
- 差距：会话标题靠首条消息截断（无 LLM 生成）；无会话导出；侧栏无运行状态点/待审批圆点（`Sidebar.tsx:671` 占位）；无轮中途插话（有意不做）

### 2. 模型与 provider ——【完整】
- 协议接缝 `registerAdapter`（内置 openai-completions，SSE 手写解析）；config.yaml 多端点多模型，`/model` 带参数级补全
- 推理档位五档（default/off/low/high/max）+ 档位字段三态（thinking/reasoning-effort/none）+ 模型能力字段（model-caps.ts 唯一真源：thinkingLevels/modalities/effortMap）
- 用量统计：usage.jsonl + 设置页聚合（汇总卡 + 全年热力图 + 分模型趋势 + 环形图）
- dsh 配置一次性只读迁移
- 差距：无在线模型发现（手填清单）；无会话内上下文占用表；无 /status；账号 OAuth 不做

### 3. 工具集 ——【完整，多为官方插件可开关】
- 内置六件 bash/read/write/edit/glob/grep（预算可配、进程树收割、输出遮红、外部内容围栏）；大输出溢出落盘（spill）
- MCP：stdio + streamable-http 手写 JSON-RPC，`mcp__服务器__工具`，环境变量白名单（默认关）
- 子代理（MiniAgent 队友，按会话隔离、审批意愿取全局∩角色）+ 智能体团队（共享任务看板 + team_task）
- 电脑操作（PowerShell+user32，DPI 感知，每次审批）；浏览器自动化（CDP DOM 级，ref 代际校验，默认关）
- 网页搜索（tavily/bocha/serper）；定时任务（六种选择器 + DST + pre-dispatch 校验 + catch-up 补投）；LSP（定义/引用/实现/悬停 + 写后新引入报错）
- PTC：`run_code` 同进程 node:vm（15s/120s/调用数上限）；runtime_api（创造模式）
- 工具渐进披露（tool_search/tool_describe/tool_call + BM25，默认关）
- ask_user（批量选项）、exit_plan_mode、todo_write、goal、memory、skill/skill_write、session_search、self-improve（三闭环）
- 差距：无后台任务（bash.ts 自认）；无持久终端工具（终端面板是人用的）；read 不支持图片文件；MCP 无 elicitation/resources/prompts

### 4. 权限与审批 ——【完整，本仓库最重】
- 双旋钮：协作模式四档（build/plan/explore/quiet）× 权限模式四档（readonly/auto-edit/full-access/ai-review）
- 审批裁决四档（allow-once/session/always/reject），键盘 y/s/a/n/Esc，风险动态限档
- 审批灾难地板（order 5 硬拒 + 白名单 + deny 黑名单 + 熔断 + 无人值守拒）；命令策略引擎（逐段判定 + 前缀 DSL 规则文件 + 加载期自检）
- AI 审查档（模型逐次判断，失败退人工卡）；安全钩子（规则 + 脚本，fail-closed，mtime 信任名单）；生命周期钩子（codex 12 事件名，8 个接通）
- 守卫链固定刻度（5 地板/8 沙箱/10 模式/20 安全钩子/25 预览/30 审批）；审计日志 + 密钥遮红
- 沙箱（codex 路线）：三档 + 可写根白名单 + 受保护路径 + 命令前缀策略 + 一次性升权（sandbox_permissions+justification 成对）+ docker 容器后端；降级照常执行 + 审批兜底并如实上报（193 条自检）
- Windows 真隔离（受限令牌）不做；无 dsh 式权限预设捆绑（/mode + /sandbox 分开切）

### 5. diff 与代码审查 ——【完整，0.6.24–0.6.26 三连批刚补齐】
- 底层 LCS unified diff（diff-text.ts）
- 工具卡 intended diff：write/edit running 期间从参数+盘上现值推演写后 diff，折叠行 +N -M 徽标 + mismatch 预告「执行会失败」
- 审批卡内嵌 diff：弹卡前推演、密钥遮红、默认收起一键展开
- 轮尾聚合卡「N 个文件已更改」（第一方归因）+ 回合级基线聚合（turnBaselines，纯内存）
- 右栏审查面板：unified⇄split、换行、shiki 高亮、拖宽、系统打开
- 悬停预览：轮尾卡行/正文提及 chip 停 500ms 出该文件 diff（Esc capture 截停防误拒审批）
- git 页签 diff：全量/单文件 `git diff HEAD --no-textconv --no-ext-diff` + stage/commit
- `/review [关注点]`：收集工作区未提交改动组装审查轮（v1）
- 差距：/review 无独立子代理与结构化 findings；审查面板纯只读（无部分行接受）；面板不追文件后续变化；bash 改文件不进聚合卡

### 6. 命令系统 ——【完整】
- 内置 7 条：/new /resume /compact /model /review /help /exit（`src/core/commands-completion.ts:16-22`，单一真源）；/effort 保留「已移除」占位
- 插件注册约 18 条：/search /plugins /floor /hooks /learn /learnings /lifecycle-hooks /memory /mode /sandbox /schedule /skills /skills-ledger /todo /goal /browser 等
- 补全：命令前缀候选 + `/model` 参数级候选 + 唯一前缀自动展开（渲染层/TUI/插件共用同一纯模块）
- 自定义命令：外部插件 `ctx.commands.register`
- 差距：输入端无 @ 文件提及补全（输出端已有内联 chip）；无 @session 引用

### 7. 上下文工程 ——【完整】
- system prompt 分段注册（稳定在前缓存友好）；AGENTS.md/CLAUDE.md/cursorrules 逐级上找 8 层 + 用户全局，20k 预算头尾保留
- compact：手动 + 自动阈值（80%×contextWindow，CJK 感知），保头折尾 + 锚点索引 + 用户原话逐字 + 细节找回指针
- 长期记忆三格 Markdown（global/USER/workspace）+ 轮尾自动复盘；todo 实时进度条；goal 跨轮续跑（带刹车）；技能（四层发现根 + 市场缓存）
- 模式（Agent 预设）：标准/极简/创造/PTC 四内置 + 自定义 presets/*.md
- 差距：压缩前不对超限工具输出预裁剪；压缩时无图像预算卸载

### 8. 终端与执行 ——【基础】
- bash 前台一次性（30s/120s/8000 字符，超时收进程树）；桌面交互终端面板（xterm.js 多页签，人用）
- 执行体缝：沙箱容器后端可整体换 spawn
- 差距：无后台 job、无模型可用的持久 PTY

### 9. UI ——【完整】
- 布局：左栏会话区 + 正文列 + 右侧 dock（guide/terminal/browser/files/git/preview 多页签、两格分栏、全屏、每会话布局持久化、caption 避让）
- 主题：深/浅/跟随系统 + 原生控件条 IPC 同步 + 密度档 + 原生 select 全量自绘；设计令牌 `--dsc-*`
- 快捷键固定 8 个（Ctrl+B/P/`/T、Ctrl+Alt+R/F、Ctrl+Shift+A）；设置页 7 内置分区 + 25 插件分区热生效
- 文件面板（树形懒加载 + vscode-icons 全集 + 多类型预览）；轨迹页（TraceView/Timeline/Inspector）；队友面板/用量面板/技能中心/插件中心/配对弹窗
- 托盘（关窗缩托盘 + 一次性气泡）；检查更新（占位，UPDATE_CHECK_URL 空串）
- **手机遥控（独有）**：PWA 遥控端（visualViewport 键盘适配、图片压缩上传、增量帧重连补帧）+ Web Push（VAPID）+ Webhook（Bark/ntfy）+ 二维码半小时配对 + 逐台设备吊销
- 差距：无会话运行状态点；桌面无原生系统通知（只有托盘气泡+toast）；手机端无团队/模式面板、归档只读

### 10. 传输部署 ——【完整】
- 远程宿主：HTTP+WS（配对/票据/上传/推送 7 条路由 + 主控位锁 + 多设备 devices.json + INVOKABLE_COVERAGE 编译期兜底）
- 桌面宿主通道：Electron utilityProcess + host-stdio JSONL（协议 v2，白名单由 DscRuntime 推出）；嵌入运行时依赖闭包自动组装
- TUI（ink，同契约）+ CLI 入口（bin/dsc.js）+ headless；SSH 隧道文档（remote-tunnel.md）
- 差距：无对外 SDK/协议面（host-stdio 是内部协议）；ACP 无

### 11. 插件系统与杂项 ——【完整】
- 三档插件（内核不可停 / 官方可开关 17 / 外部单文件）+ 热挂载 + plugin_manager 工具 + dsh 插件兼容层（logger 桥/模块解析钩子/双形状 ctx.tools）
- 技能市场（GitHub 目录/索引 JSON 两类源，缓存 1h）
- 扩展点 15+（tools/commands/prompt/guards/surfaces/waiting/session.appendState/events/settings/skills/provide…），KERNEL_API_VERSION=6
- 差距：外部插件无 npm/GitHub 远程安装（只收本地 .js）；无 doctor 式体检命令；无插件管理器 HMR

### Muse Code 独有/领先项（相对 dsh 与 codex）
1. **手机遥控**：PWA + Web Push/Webhook + 二维码配对 + 逐台设备管理——三家都没有
2. **审批安全纵深**：灾难地板 + 熔断 + 命令策略引擎逐段判定 + 安全钩子 fail-closed + AI 审查档 + 无人值守拒——比 dsh（ask/never 两档）细
3. **中文优先**：会话检索 1+2-gram、界面全中文（codex/dsh 主英文）
4. 用量统计面板（热力图/趋势/环形）
5. 技能自修 + 台账回滚（self-improve 三闭环 + 老化）
6. 会话回收站（30 天可捞回）
7. 目标续跑带刹车 + 定时任务 pre-dispatch 校验（坏配置一次 token 不花）
8. 轨迹页（整轮折叠 + 时间线 + 独立节点检查器）
