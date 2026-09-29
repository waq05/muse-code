# 对标计划书：dsc 对照 codex / hermes / dsh 的差距与移植路线

这份文档把 dsc 与三个成熟 harness（OpenAI **codex**、Nous **hermes-agent**、本项目所参考的 **dsh / DeepSeek Harness**）横向对比的结果，整理成一份**能照着执行的计划书**。它回答三个问题：dsc 缺什么、哪些能作为插件补进来、按什么顺序补。

| 想知道 | 去看 |
| --- | --- |
| 怎么装、怎么跑、怎么配模型 | [README.md](../README.md) |
| 代码怎么分层、扩展点清单、契约层 | [development.md](development.md) |
| 为什么长成这样、踩过哪些坑 | [development-log.md](development-log.md) |
| **对标三家的差距、可移植项、落地顺序** | **本文档** |

本文档只读三家源码得出，未改动任何一家代码。引用一律给到 `文件:行号`；三家是外部项目，用完整路径，dsc 自己用仓库相对路径。

---

## 0. 一页看懂（先给结论）

四家各自最强的地方不同：

| 项目 | 语言/架构 | 立身之本 | 规模 |
| --- | --- | --- | --- |
| **dsc（Muse Code）** | TS + cordis 插件 + ink TUI + Electron | 个人终端 harness，复用 dsh 的设计而非实现 | 内核约 1.26 万行 + 插件约 0.94 万行 |
| **codex** | Rust（codex-rs，200+ crate）+ bazel | OS 级安全沙箱 + 客户端-服务架构 + 多前端 | 工业级 |
| **hermes** | Python 为主 + TS 前端 + 一个 C 分词器 | 自我改进学习闭环 + 随处可用（消息网关 / 多后端） | 工业级 |
| **dsh** | TS + cordis，200+ 包 | 全插件化 + 会话 / 沙箱 / 持久化的契约严谨度 | 工业级 |

**建议的落地顺序（只做三件）**：

1. **修压缩子系统** —— 先修一个当前让压缩失效的真 bug，再顺带提质。纯内核，不引外部依赖。
2. **审批加固插件** —— 加一层「任何权限模式都不放行」的灾难命令地板 + 用户黑名单 + 命令白名单，全部挂在现有 `ctx.guards` 上，不动内核。个人机器安全收益最高。
3. **中文会话检索** —— dsc 是中文优先工具，目前跨会话全文检索完全空白，这条是天天用得上。

紧随其后：MCP 客户端与 Tool Search 要绑在一起上（否则 schema 吃掉上下文）。「自我改进闭环」「OS 级沙箱」是独立路线，各自要先立前置条件，不进快赢清单。

这三件连同紧随其后的 spill、生命周期钩子、MCP + Tool Search 都已落地，逐项状态与验收证据见 §5.1。

---

## 1. 对标方法与一处事实修正

方法：读三家的 README、AGENTS.md 与关键源码/包 README，把每项能力映射到 dsc 的扩展点，判断「已具备 / 部分 / 缺失 / 有意不做」。

**先修正一个容易误判的事实**：hermes 自己没有 OS 级沙箱。它的 bubblewrap / seatbelt 只出现在自己的升级 e2e 测试里；跑 Codex 后端时是借用 codex 的 seatbelt / landlock，容器后端（Docker / Modal / Daytona）才是它的隔离边界。

所以「要真沙箱」这件事，**只有 codex 和 dsc 的参照对象 dsh 有现成蓝本**（dsh 有 Windows ACL 后端 `sandbox-windows-acl`，对 dsc 的 Windows 平台尤其对口）。别指望从 hermes 抄沙箱。

---

## 2. dsc 现状（一句话，细节见 development.md）

dsc 已具备：自研 ReAct 循环、OpenAI 兼容流式客户端（reasoning / tool_calls / usage / 重试）、会话 JSONL 落盘与重放恢复、会话库（归档 / 置顶 / 改名 / 分叉 / 回收站）、六件套工具（bash / read / write / edit / glob / grep）、四档权限模式（readonly / auto-edit / full-access / ai-review）、保头折尾摘要压缩（含重放折叠与锚点加固）、todo / plan / ask / goal、九个官方可开关插件（默认开：网页搜索、审批灾难地板、大输出溢出、会话全文检索；默认关：子智能体团队、电脑操作、生命周期钩子、MCP 客户端、工具渐进披露）、安全钩子（用户自登记的规则与脚本，四个事件）、技能系统与技能市场、外部单文件插件系统、Electron 桌面端（终端 / 浏览器 / 文件 / git dock）、主题引擎、模型能力字段、AGENTS.md 说明书预算注入。

dsc 的插件扩展点（`src/core/plugin-registry.ts:71`，`KERNEL_API_VERSION = 4`）已经很够用：`tools.register`、`commands.register`、`prompt.register + transformMessages`、`guards.register + registerObserver`、`surfaces.register`、`waiting.register`、`session.appendState / state`、`events.on`、`settings.defineSection`、`skills.source`、`transcript.system`。这份清单决定了「哪些能力不改内核就能挂」。

---

## 3. 差距矩阵

图例：● 已具备　◐ 部分或受限　○ 缺失　⊘ 有意不做

| 能力 | dsc | codex | hermes | dsh | dsc 的判断 |
| --- | :--: | :--: | :--: | :--: | --- |
| ReAct 循环 / 流式 / 审批 | ● | ● | ● | ● | 持平，够个人用 |
| 会话 JSONL 落盘 / 重放 | ● | ● | ● | ● | 重放折叠已修（T1），见 §3.1 |
| OS 级沙箱 | ⊘ | ● | ○ | ● | 个人版取舍；要做得单独立项 |
| MCP 客户端 | ● | ● | ● | ● | 已补（T5），安全层与围栏复用现成的 |
| 长期记忆 | ● | ● | ● | ◐ | 已内核化（`src/plugins/memory.ts`） |
| 跨会话全文检索 | ● | ◐ | ● | ● | 已补（T6），零依赖倒排索引，中文按 bigram |
| 工具渐进披露 Tool Search | ● | ◐ | ● | ◐ | 已补（T5），与 MCP 同批上 |
| LSP 代码智能 | ○ | ◐ | ○ | ● | 可选，编码体验加成 |
| 真浏览器自动化（DOM 级） | ○ | ◐ | ● | ● | dsc 只有截图级 computer-use |
| 生命周期 hooks | ● | ● | ● | ● | 已补（T4）：安全钩子（四个 dsc 事件）先有，这轮加了 codex 十二事件名的独立插件 |
| 定时任务 cron | ○ | ◐ | ● | ● | 该补，能自触发 |
| PTC（模型写代码调工具） | ○ | ● | ● | ● | 高价值，但与沙箱强绑定 |
| 会话 checkpoint / rewind | ⊘ | ● | ● | ● | 有意不做；值得重新评估 |
| 子代理级联派生 | ⊘ | ◐ | ● | ● | 有意限 1 层，见 §6 |
| 细粒度执行策略 | ● | ● | ● | ● | 已补（T2）：四档之外加了灾难地板、命令白名单与 deny 黑名单 |
| 大输出溢出 spill | ● | ◐ | ◐ | ● | 已补（T3） |
| 可观测性（otel） | ○ | ● | ◐ | ● | 个人版低优先 |

### 3.1 压缩重放（已修，见 §5.1）

**当时的毛病**：内存里 `compactSession` 用 `session.replaceWithSummary` 折叠是对的，但磁盘是 append-only，而 `Session.load` 读到 `summary` 记录时**只把它当一条 user 消息 push 进去，前面累积的原始 `messages` 一条都没清**。结果 `/compact` 完当下上下文确实变小，一旦 `--resume` 重开，摘要之前的原始消息全被读回来，等于白压。

**后来更正的认识**：这里原本写的「最小改法：先 `messages.length = 0` 再放摘要」不充分——它会把压缩时特意保留的尾部（最近若干条原文）一起丢掉，压缩后的第一次交接就少了上下文。最终实现给 `summary` 记录加了 `keep` 字段（摘要之外保留了尾部多少条），重放时先取末尾 `keep` 条再清空，接回「摘要 + 保留尾部」；老日志没有这个字段按 0 处理，退化成「摘要 + 摘要之后的记录」，原文一样不会读回来。落地情况见 §5.1。

---

## 4. 可移植项分级与落地要点

**一个诚实前提**：codex 是 Rust、hermes 是 Python，**代码一行都搬不过来**；dsh 虽是 TS 且同样用 cordis，但它的插件依赖 dsh 自己的 `agent-loop` / `session` / `interaction` 服务，而 dsc 的服务面是自研的 `DscRuntime`。所以下面的「移植」几乎都是**照着设计在 dsc 的扩展点上重写**，不是复制粘贴。下面每项给出：落点、动不动内核、难度、风险、验收标准。

### 第一梯队：改动小、扩展点现成、价值高

#### T1. 修压缩子系统（P0，纯内核）
- **是什么**：先修 §3.1 的重放 bug；再借 hermes 的 lean 压缩提质——压缩时一次辅助模型调用同时产出：① 标识符保真的摘要、② 正则机械抽取的锚点索引（PR 号 / SHA / 路径 / 报错串，绝不让模型改写）、③ 真实用户消息逐字引用、④ 「去会话检索找回细节」的恢复指针。
- **为什么**：dsc 的保头折尾摘要会把 SHA、PR 号、用户原话丢掉，导致压缩后模型自己编 SHA、忘了需求原话（参照 `hermes/agent/context_compressor.py:1072-1115`）。
- **落点**：`src/core/compact.ts`（摘要逻辑）+ `src/core/session.ts`（重放折叠 + 可选 `compacted` 标记）。
- **动内核**：是（`Session` 读写两侧）。**难度**：bug 低；lean 提质低-中。
- **风险**：改事件记录格式要同时改读写两侧；若引入 `compacted` 标记，要保证老会话读得回来。
- **验收**：`/compact` 后立即续用与 `--resume` 后，送入模型的 token 都保持压缩后水平；含 SHA / 路径的关键事实不丢。

#### T2. 审批加固插件（P0，挂 `ctx.guards`，不动内核）
- **是什么**：在现有四档模式之前叠两层。① **灾难命令地板**：`rm -rf /`、fork bomb、`dd of=/dev/sd*`、引号不可解析等，任何模式（含 full-access / ai-review）都直接拒，fail-closed（参照 `hermes/tools/approval_floors.py:98`、`approval_detection.py:88-128`）。② **用户 deny glob 黑名单**（先于 yolo 生效）。③ **命令白名单**：`git status`、`ls` 等安全前缀自动放行（参照 codex `execpolicy/src/rule.rs` 的命令前缀匹配）。④ 可选：连续被拒 N 次熔断、无人值守（cron / 脚本）场景直接按拒快速失败。
- **为什么**：dsc 的 `full-access` 直接放行，没有一层「连满权限也不许」的兜底（`src/plugins/approval.ts:280`）；个人机器误放一条 `rm -rf` 就没了。codex 的白名单与 hermes 的黑名单地板方向互补，dsc 两个都该要。
- **落点**：`ctx.guards.register({ id, order, decide })`，排在审批（order 30）之前，比如 order 5。白名单 / 黑名单 / 地板都是规则表，走设置分区或独立配置文件。**必须排这么前的原因**是守卫链「第一位给出 deny 或 pass 的赢」：模式闸门（order 10）对只读工具、只读命令与工作区内的写直接返回 pass，它一返回 pass，后面的安全钩子（20）与审批（30）就轮不上；所以「连满权限也不许跑的灾难命令」只能由排在它们前面的一位自己判。
- **动内核**：否。**难度**：低。
- **风险**：白名单前缀匹配要防绕过（管道、`;`、子 shell、编码绕过）；地板宁可误拦不可漏放。
- **验收**：在 full-access 下 `rm -rf /` 被拒；命中白名单的安全命令不再弹卡；命中黑名单的命令即使在满权限下也弹拒。

#### T3. spill 大输出溢出（P1，挂 `ctx.guards.registerObserver`）
- **是什么**：工具输出超阈值时落到临时文件，只把「前 N 行 + 文件路径 + 怎么继续读」塞回模型。
- **为什么**：dsc 现在 bash 输出超 8000 字符直接截断（`src/core/tools/`，bash 累积到 16000 停止收），长日志直接丢尾巴。
- **落点**：工具输出改写环 `ctx.guards.registerObserver`（密钥遮红用的就是这一环，见 development.md §7）。
- **动内核**：否。**难度**：低（几十行）。
- **风险**：临时文件的清理与大小上限。
- **验收**：一条超长输出后，模型拿到的是摘要头 + 文件路径，而非被腰斩的原文。

#### T4. 生命周期 hooks 插件（P1，映射到现有扩展点）
- **是什么**：读一份 codex 形态的钩子配置，跑外部命令钩子，实现「工具前拦截 / 注入上下文 / 强制续跑」。codex 有 12 个生命周期事件（`codex/codex-rs/hooks/src/lib.rs:23-36`）：PreToolUse / PostToolUse / PreCompact / PostCompact / SessionStart / SessionEnd / UserPromptSubmit / SubagentStart / SubagentStop / Stop / Interrupt / PermissionRequest。
- **为什么**：不动内核就扩展行为；dsc 已有 `ctx.guards.register`（动手前闸门，可返回拒）、`ctx.prompt.transformMessages`（改写请求）、`ctx.events.on`（回合 / 工具事件），正好覆盖主要子集。
- **落点**：一个官方可开关插件，把 `PreToolUse` → `guards.register`、`PostToolUse` → `guards.registerObserver`、`SessionStart / UserPromptSubmit` → `prompt.transformMessages` 逐类映射。dsh 的 `hooks-codex` 直接跑现成 hooks.json，可作桥接蓝本。这一项**不是从零补 hooks**：dsc 当时已有自研的安全钩子（`src/core/hooks.ts` + `src/plugins/hooks.ts`，四个 dsc 自己的事件，配置 `~/.dsc/hooks.json`，守卫 order 20），要加的是另一份事件名与配置格式都照 codex 的插件，两份配置各读各的（实际落地读 `~/.dsc/lifecycle-hooks.json`，见 §5.1）。
- **动内核**：否。**难度**：低-中。
- **风险**：外部命令的超时与失败处理；钩子输出进模型前要走 `untrusted` 围栏。
- **验收**：配一个 PreToolUse 钩子能拦下指定工具并给出模型可见的拒绝理由。

### 第二梯队：价值高，但要新增扩展点或小改内核

#### T5. MCP 客户端 + Tool Search（P1，一起上）
- **MCP 客户端**：连 stdio / streamable-http 的 MCP server，把工具经 `ctx.tools.register` 挂成 `mcp__<server>__<tool>`（命名照 codex / dsh）。**dsc 已经具备安全前置**：`src/core/untrusted.ts` 已实现防注入内容围栏，并已预留 `mcp:名字` 来源标签（`untrusted.ts:31`），缺的只是客户端本体。MCP 工具默认标 `write` / `exec` 走审批。参照 `dsh/mcp/mcp-client`（稳定命名、重连退避、generation 原子换）。
- **Tool Search（必配）**：dsc 一旦接入 MCP / 更多工具，每轮会为用不到的 schema 付 token。hermes 的解法是三个桥接工具 `tool_search / tool_describe / tool_call` + BM25 检索 + 三档 tier，且解包后审批 / hooks 看到的仍是真实工具名（`hermes/tools/tool_search.py:274,543,597`）。
- **落点**：MCP 走新插件 + `ctx.tools`；Tool Search 需要工具数组每轮重建但不污染前缀缓存。**动内核**：否（但 Tool Search 触及工具装配顺序）。**难度**：MCP 中；Tool Search 中。
- **风险**：MCP 子进程 env 要筛凭据；schema 变化会让前缀缓存失效，需缓存感知。**验收**：接一个 GitHub MCP server 能调其工具、结果走围栏；未命中的工具 schema 不进每轮请求。

#### T6. 会话全文检索（P1）
- **是什么**：给会话建 SQLite FTS 索引，暴露 `session_search` 工具 + 桌面侧栏搜索框。中文要 bigram 分词——hermes 用自研 C 扩展提供 `cjk_unicode61`，加载不了就降级到 trigram / LIKE（`hermes/hermes_state_fts.py:20-93`）。dsc 用 jieba / wasm / ICU 现成分词即可，不必写 C。
- **为什么**：dsc 是中文优先工具，trigram 要求词项 ≥3 字符，中文 1-2 字词大量存在；而 dsc 现在只有归档 / 分叉，会话列表还只读每个文件前 8 行（`src/core/session.ts:297-319`）。中文用户跨会话回忆目前完全不可用。
- **落点**：新增检索层（不动 jsonl 主格式）；参照 `dsh/session-query/session-query-sqlite`。**动内核**：否（旁路索引）。**难度**：中（难点在增量维护与回填，不在分词）。实际落地时没引 SQLite 也没引分词库：纯 TS 倒排索引，中文按 1-gram + 2-gram 切，见 §5.1。
- **风险**：做 lineage 时会撞上「会话边界」问题（`/new`、空闲过期、压缩续接、委派子会话算不算同一会话），要让存储层与检索层共用同一份边界常量。**验收**：中文关键词能命中历史会话正文并跳回。

#### T7. 记忆系统内核化（P2）
- **是什么**：把记忆做成官方插件：`ctx.tools.register` 加记忆工具，用独立 `~/.dsc/memory/` 落盘，`ctx.prompt.register` 注入系统提示。照 codex 给每条记忆记来源与用量上限，避免无限膨胀（`codex/codex-rs/memories/write/src/phase1.rs`）。**已落地**：`src/plugins/memory.ts` + `src/core/memory.ts`，工具名 `memory`，原来那份示例插件 `examples/plugins/memory.js` 已删除（见 §5.1）。
- **落点**：新官方插件，全用现有扩展点。**动内核**：否。**难度**：中。
- **风险**：注入记忆会改系统提示，若用前缀缓存要做到会话内稳定。**验收**：写入的事实跨回合可见、有大小上限、超限不静默裁剪。

#### T8. schedule 定时跟进（P2）
- **是什么**：`after / at / every / daily / cron` 五种选择器，到点作为 user 消息投递回原会话。借 hermes 的 pre-dispatch 校验：开跑前先验凭据可解析、投递目标已知，不通过就标 blocked 且一次模型请求都不发（`hermes/cron/scheduler_preflight.py`）。
- **落点**：新插件 + 宿主定时器。dsc 缺 dsh 那种「会话控制器」，个人版可退化为「下次启动补投最近一次错过的」。参照 `dsh/schedule/schedule`。**难度**：中。
- **风险**：宿主不常驻就无法准点投递。**验收**：一条 `every 60s` 任务能周期把提醒投回原会话。

### 第三梯队：架构级取舍，慎重评估（不在快赢清单）

#### T9. OS 级沙箱（价值最高、代价最大，且违背现有取舍）
- dsc 现在「无沙箱 + 审批卡兜底」，Windows 上 bash 全权限。dsh `sandbox` 三模式（read-only / workspace-write / danger-full-access）+ fail-closed + 一次性升级审批是完整蓝本，且有 `sandbox-windows-acl` 后端。但这是改 shell 执行路径的活（dsc 的 bash 现在直接 `powershell -NoProfile -Command`），要在执行处加一道 confine 缝，动到内核。**建议单独立项**，别顺手做。若暂不做沙箱，至少先做 T2 的命令白名单。

#### T10. PTC（模型写代码调工具）
- dsh 蓝本最贴 dsc：`ptc-runtime-node` 在一个受沙箱管的新 Node 子进程里跑模型写的 async TS，`return await tools.add(…)` 就能调工具，多步塌成一轮。但**没有沙箱时 PTC 等于给模型开「随便跑代码」的后门**，与 T9 强绑定，要一起才安全。参照 `dsh/ptc-runtime/ptc-runtime`、`hermes/tools/code_execution_tool.py`。

#### T11. 自我改进闭环（独立路线）
- hermes 从经验自动造技能、用时自我修订、定期老化归档。**关键前置**：dsc 目前根本没有让 agent 写技能的能力——`skill` 工具是 `risk: 'read'` 只能读正文（`src/plugins/skills.ts:345`），技能启停只写 `skills.json`，市场安装靠人在技能中心点。所以这不是「给现有裸写补护栏」，而是「要开放 self-writing 之前必须先立写入门」。照 hermes 先建门（写技能要确认、cron / 子 agent 的写直接拒、来源徽章 `agent_created / hub / bundled`），再谈 `skill_manage`。**否则一开放 self-writing 就同时开了注入后门。**

#### T12. 其他按需
- **LSP 代码智能**（参照 `dsh/lsp`）：编码体验加成大，中等工程量。
- **真浏览器自动化**（参照 `dsh/browser-use` 或 hermes `browser_*`）：dsc 现在只有截图级 computer-use，缺 DOM 级操作。
- **checkpoint / rewind**（参照 `hermes/tools/checkpoint_manager.py` 的 shadow git store + 写者 ledger、`dsh/session-checkpoint-policy` 的三道落盘屏障）：能救「已批准但毁掉未提交工作」的情况；ledger 区分「每个文件最后是 agent 还是人改的」，回滚时保手改、只覆盖 agent 改动，比 `git stash` 强。动内核，建议与 T1 同块评估。
- **hooks 之外的可观测性 / otel**（参照 `dsh/telemetry`）：个人版低优先。

---

## 5. 分期路线图

| 期 | 内容 | 动内核 | 依赖 | 建议顺序 |
| --- | --- | :--: | --- | --- |
| **P0** | T1 修压缩（bug + lean 提质）、T2 审批加固 | T1 是 / T2 否 | 无 | 先做，1~2 天内可落 T2 |
| **P1** | T3 spill、T4 hooks、T5 MCP + Tool Search、T6 中文检索 | 基本否 | T5 的 Tool Search 依赖工具装配梳理；T6 依赖检索层 | 外部生态与长会话稳定性 |
| **P2** | T7 记忆、T8 schedule | 否 | 各自独立 | 锦上添花 |
| **独立路线** | T9 沙箱、T10 PTC、T11 自我改进闭环、T12 LSP / 浏览器 / checkpoint | 是 / 部分 | T10 依赖 T9；T11 依赖写入门 | 各自单独立项评估 |

关键依赖链：**沙箱（T9）→ PTC（T10）** 必须同序；**写入门 → self-writing 技能（T11）** 必须同序；**MCP（T5）→ Tool Search（T5）** 必须同批，别先上裸 MCP。

### 5.1 实施状态

T1–T6 都已落地，下面就每项给出落点与验收证据。自检脚本都在 `shots/` 下（该目录不进版本库）、全部跑在临时 HOME 上，PASS 数是全绿运行的实测值。

| 项 | 状态 | 落地与验收证据 |
| --- | --- | --- |
| T1 压缩子系统 | 已落地 | 重放折叠按 `keep` 字段接回尾部（`src/core/session.ts` 的 `case 'summary'`）、切点退到 `safeCut`（`src/core/compact.ts`）、锚点索引 / 用户原话 / 找回指针在 `src/core/compact-anchors.ts`、两个字符预算进 `compact` 设置分区。`node shots/compact-check.mjs` 53 PASS / 0 FAIL；`integration-check` 另用真 `Session.load` 验了新老两种日志 |
| T2 审批灾难地板 | 已落地 | `approval-floor` 插件挂在守卫 order 5（`src/core/approval-floor.ts` + `src/plugins/approval-floor.ts`），含命令白名单、deny glob 黑名单、熔断、无人值守。`node shots/approval-floor-check.mjs` 95 PASS / 0 FAIL；`integration-check` 在真守卫链上当场拒掉 `rm -rf /`、`format C:`、`cmd /c format C:`、`Format-Volume`、`Clear-Disk`、fork 炸弹与写 `/dev/sda`。**第二轮补了五个漏**，见 §5.2 |
| T3 spill | 已落地 | 观察者 order 50，落 `~/.dsc/spill/`，`read` 工具跳过，目录按 mtime 与总量清理。`node shots/spill-check.mjs` 53 PASS / 0 FAIL |
| T4 生命周期钩子 | 已落地（十二个事件里八个接通） | `lifecycle-hooks` 插件读 `~/.dsc/lifecycle-hooks.json`：PreToolUse → 守卫 25、PostToolUse → 观察者 45，其余走事件与 `transformMessages`；PermissionRequest / PreCompact / SubagentStart / SubagentStop 没有可挂的扩展点，配了不执行并把理由写进报告。`node shots/lifecycle-hooks-check.mjs` 81 PASS / 0 FAIL |
| T5 MCP 客户端 + Tool Search | 已落地 | `mcp` 插件支持 stdio 与 streamable-http，工具挂成 `mcp__服务器__工具`，结果过围栏，子进程环境按白名单筛；`tool-search` 提供三个桥接工具与手写 BM25，`tool_call` 按真名重走守卫链。`node shots/mcp-check.mjs` 75 PASS / 0 FAIL；`node shots/tool-search-check.mjs` 94 PASS / 0 FAIL |
| T6 中文会话检索 | 已落地 | 没上 SQLite：`src/core/session-index.ts` 是纯 TS 倒排索引（中文 1-gram + 2-gram，英文整词），落 `~/.dsc/cache/session-index.json`，按 mtime + size 增量维护；工具 `session_search` + `/search` 命令。`node shots/session-search-check.mjs` 70 PASS / 0 FAIL |
| T7 记忆内核化 | 已落地（不在本轮） | `src/plugins/memory.ts` + `src/core/memory.ts` 是默认开的内核插件，带 `memory` 设置分区与三格额度 |
| T8 schedule 定时跟进 | 已落地（第五轮） | `src/plugins/schedule.ts` + `src/core/schedule/{rule,store,runner}.ts`：六种选择器（cron 只收五字段 Vixie）、显式 IANA 时区与 DST 两规则、**先落盘推进 `nextRunAt` 再投递**的至多一次语义、重启 catch-up（grace 半周期夹 120s~2h，不补积压）、pre-dispatch 校验（凭据不可解析就标 blocked，一次模型请求都不发）、`.lock` 互斥、投递文本明写「定时触发不是用户指令不构成授权」且投前问 `ctx.waiting.any`。宿主无常驻进程，靠自重排 `setTimeout`（unref）+ 重启补投，界面写明「关机时段不触发」；**没有用 `schtasks` 兜底**（§3 判它是后门高危）。`node shots/schedule-check.mjs` 207 PASS / 0 FAIL |
| T9 沙箱 | 已落地（第五轮，**codex 路线**，非本节原先写的 dsh fail-closed 路线） | `src/plugins/sandbox.ts` + `src/core/sandbox/{policy,execpolicy,backends}.ts`，守卫 order 8：三档模式（默认 workspace-write）、可写根白名单（`realpathSync.native` 规范化 + 祖先包含 + 最深存在祖先回退）、受保护元数据名、NT 命名空间前缀守卫（resolve 之前判原始串）、8.3/ADS/junction、命令前缀 allow/prompt/forbidden（含内层脚本再拆一层）、一次性升权（`sandbox_permissions`+`justification` 必须成对、只对本次生效、照常弹审批卡）、**降级照 codex：强制层不可用不 fail-closed，改为照常执行 + 审批兜底并如实上报 `enforced: full/partial`**。容器后端（docker，探测通过且用户显式选择才启用）经命令执行器缝（`src/core/tools/command-runner.ts`，内核 API v5）真换执行体。不做受限令牌后端（纯 TS 拿不到，`runas /trustlevel` 隔离是假的）。`node shots/sandbox-check.mjs` 193 PASS / 0 FAIL |
| T11 自我改进闭环 | 已落地（第五轮，三条闭环先立写入门） | `src/plugins/self-improve.ts` + `src/core/learnings/{store,ledger,skill-write}.ts`：L1 纠正捕获（`dsc/turn-end` 落候选，**不进系统提示**，`/learnings promote` 才生效）；L2 复盘产技能草稿（迭代数 ≥12 触发，走 `agent.followup`，落盘即写进 `skills.json` disabled **默认停用**）；L3 `skill_write` 工具（read-before-write 硬校验、`.bak` 备份、`.ledger.jsonl` 台账可回滚、威胁扫描不过就还原、archive 只搬不删）。写入走 `ctx.approval.decide`；cron/队友/插件发起的写直接拒（判不出的退审批门，宁严不松）。`node shots/self-improve-check.mjs` 181 PASS / 0 FAIL |
| T12 LSP + 浏览器自动化 | 已落地（第五轮，checkpoint 仍未动） | LSP：`src/core/lsp/{framing,uri,servers,client}.ts` + 单工具按 operation 分发（定义/引用含声明/实现/悬停，100 条 + 16000 字符双上限），无状态同步（读盘→didOpen→请求→didClose），idle 回收 + 破键退避，诊断经 `registerObserver` 只报本次编辑新引入的 ERROR；`node shots/lsp-check.mjs` 167 PASS / 0 FAIL。浏览器：`src/core/cdp/{transport,launch,snapshot,actions}.ts`，无障碍树文本化 + 行内 ref、**ref 代际校验**（动作前 `DOM.describeNode` 复核）、独立临时 profile + `DevToolsActivePort`、对话框三策略、`browser_look`（read）/`browser`（exec）分档、`taskkill /T /F` 整树清理；`node shots/browser-check.mjs` 210 PASS / 0 FAIL |

集体验收：`node shots/integration-check.mjs` 起两次真内核（默认态 + 打开三个默认关的档位），95 PASS / 0 FAIL，顺带验了守卫链次序、打开后的灾难命令仍被拒、以及压缩重放的端到端回归。第五轮另起一份 `node shots/m5-integration-check.mjs`：起四次真内核，验五个新插件的登记/默认开关/挂载/工具面/热卸载无残留，以及「沙箱默认开不误伤只读命令、不挡正常工作区写入」。

### 5.2 第二轮补漏（安全判定的五个洞）

第一轮交付后按同一份红线复查判定层，实测出五个洞并修掉。前四个都是「本该拦住却没拦住」，第五个是「拦得太宽」：

| 洞 | 实测现象 | 根因与修法 |
| --- | --- | --- |
| Windows 格式化漏网 | `format C:` 没被地板拦下，在「完全访问」权限模式下 `pass` 放行；默认配置下它要等满 300 秒审批超时才被拒 | `src/core/command-policy.ts` 的 `mkfs` 正则末尾多写了一个 `\b`，而 `format C:` 的 `:` 后面就是行尾，`\b` 永不成立。改成正则只给词尾成立的分支加边界 |
| 清盘命令根本没规则 | `Format-Volume`、`Clear-Disk`、`Initialize-Disk`、`Remove-Partition` 全都不在任何规则里，满权限下直接放行 | `HARDLINE` 补一条 `ps-wipe-disk` |
| `cmd /c` 不算包装 | `cmd /c format C:` 被当地板眼里的「明文命令」审 | `SHELL_HEADS` 漏了 `cmd`，而 `/c` 早已在 `INLINE_FLAGS` 里。补一个词即可（`baseName` 会去掉 `.exe`） |
| 只读白名单把解释器当只读 | 「计划模式 + 仅查看权限」下 `python -c "import shutil; shutil.rmtree('/')"`、`find . -delete`、`sed "e ..."`、`echo x > 任意文件` 全部 `pass` 执行 | `isReadOnlySegment` 只认第一个词，而 `node` 早被单独排除、同类解释器没排除；重定向也没参与判定。补齐：解释器、`env` 剥壳、`find` 的 `-delete/-exec/-fprint`、`sed` 的 `e/w/-i`、`awk` 的 `system(`、以及引号外的 `>` |
| 白名单把整条链截断 | 命中默认白名单的 `pnpm run build` 不经过用户的 `hooks`（order 20）与 `lifecycle-hooks`（order 25） | 地板原来直接 `pass`，而守卫链是「第一位非 defer 的赢」。改成只 `defer` 并登记 `approvalFloor` 服务，由审批层免卡放行；顺带去掉地板对协作模式的依赖 |

同一轮还修了一个可用性坑：**没有任何界面能回答审批卡时，卡会白等满一次超时**（默认 300 秒）。`approval-floor.ts` 的注释原本写「dsc 没有可靠的宿主交互信号」，实际上入口是确定的——`tui` 与 `host-stdio` 各登记一份 `interactive` 服务，审批层读不到且本进程不是终端直连时，直接按拒处理并写明理由。`shots/integration-check.mjs` 因此从 300.6 秒降到 0.5 秒，并且加了一条反向断言：登记了界面之后这张卡照旧挂着等人答。

自检同步加严：灾难命令的断言从「结果是 deny」改成「**必须是地板当场拒**（< 1 秒）」。老写法放过了「等审批超时才拒」，正是它把 `format C:` 判成通过的原因。


---

## 6. 红线与「有意不做」

- **子代理级联**：dsc 刻意限成「只有 Lead 能派、1 层、队友只读、审批默认 forbid」（development-log 决策台账理由充分）。要放开级联得重设计审批与安全面，**不建议轻易动**。
- **写 / 执行类不留持久授权**（one-shot 语义）：这是 dsc 的既定安全选择，三家移植项不得引入「上次同意过 = 永久同意」。
- **无沙箱是明确取舍**：README 已声明只在个人机器用。任何「让模型写代码 / 更自动」的移植（PTC、self-writing、无人值守 cron）都必须先补安全兜底，否则是把取舍悄悄推翻。
- **配置改完不必重启**：新增可配项一律走 `resolvePluginConfig`（`src/core/plugin-registry.ts:165`）那条路径，别在插件里硬编码、也别只在挂载时读一次。

---

## 附录 A：三家特色速查（→ 移植到 dsc 的难度）

**codex（安全与架构最硬）**
- 三平台 OS 沙箱 `sandboxing`（bwrap / landlock / seatbelt）+ fail-closed + 一次性升级审批 → 高（动内核）
- 声明式执行策略 `execpolicy`（命令前缀 → allow / prompt / forbidden）→ 低（挂 guards）
- app-server 客户端-服务架构（SQ / EQ 队列对 + JSON-RPC v2 + TS 类型生成）→ 架构级
- code-mode（V8 内嵌，模型写 JS 连续调工具）→ 高，需沙箱
- 生命周期 hooks 12 事件（`hooks/src/lib.rs:23-36`）→ 低-中
- 两阶段记忆系统（抽取 + 子 agent 合并 + 引用回溯 + git baseline diff）→ 中
- worktree 每任务独立 checkout 隔离 → 中

**hermes（学习与触达最广）**
- CJK bigram FTS 三索引共存降级 `hermes_state_fts.py:20-93` → 中
- lean 压缩（锚点索引 + 用户原话逐字 + 恢复指针 + 压缩历史软归档可检索）`context_compressor.py:1072-1115,999,977` → 低-中
- 审批分层（灾难地板 + deny glob + 判官 + 熔断 + 无人值守 deny）`approval_floors.py:98`、`approval.py` → 低
- Tool Search 渐进披露 BM25 `tool_search.py` → 中
- execute_code 脚本 RPC 回调工具 `code_execution_tool.py` → 中
- checkpoint / rollback（共享 shadow git store + 写者 ledger）`checkpoint_manager.py:251,745` → 中
- 自我改进闭环（后台复盘 fork + `skill_manage` + curator 老化）+ 技能写入审批门 → 中高
- cron pre-dispatch 校验（配置坏则一次 token 不花）+ no-agent 脚本作业 → 低
- 消息网关（Telegram / Discord / Slack / WhatsApp / Signal / Email）+ 7 种终端后端 → 平台面，非个人版优先
- 注意：**hermes 无自有 OS 沙箱**，容器才是它的边界

**dsh（契约与工程最严，且是 dsc 的直接参照）**
- 会话 checkpoint 三道落盘屏障（请求前 / 顶层工具前 / step 边界，fail-closed）`session-checkpoint-policy` → 中
- 会话格式版本迁移链（v0→v1→v2→v3→v4）→ 中（dsc 有意无版本号，见 §6）
- MCP 客户端稳定命名 + 重连退避 `mcp-client` → 中
- schedule cron / daily / weekly + 投递历史 → 中
- ptc-runtime-node（受沙箱管的新 Node 子进程跑模型写的 TS）→ 高，需沙箱
- hooks-codex / hooks-claude-code（跑现成 hooks.json）→ 低-中
- sandbox 三模式 + `sandbox-windows-acl`（Windows 对口）→ 高，动内核
- LSP / browser-use / webhook / e2b 云沙箱 / ssh 远程执行 / session-query 搜索 → 按需

---

## 附录 B：关键源码引用清单

dsc（相对路径）：
- 压缩：`src/core/compact.ts`（`safeCut` 切点 + 摘要拼装）、`src/core/compact-anchors.ts`（锚点索引 / 用户原话 / 找回指针）、重放折叠 `src/core/session.ts` 的 `case 'summary'`；会话列表只读前 8 行 `src/core/session.ts:463-472`
- 灾难地板 `src/core/approval-floor.ts` + `src/plugins/approval-floor.ts`；溢出 `src/core/spill.ts` + `src/plugins/spill.ts`；MCP `src/core/mcp.ts` + `src/plugins/mcp.ts`；渐进披露 `src/core/tool-search.ts` + `src/plugins/tool-search.ts`；十二事件钩子 `src/core/lifecycle-hooks.ts`；会话检索 `src/core/session-index.ts` + `src/plugins/session-search.ts`
- 审批四档判定 `src/plugins/approval.ts:280`；守卫链刻度见 development.md §7
- 扩展点与内核 API 版本 `src/core/plugin-registry.ts:71`；插件配置热生效 `src/core/plugin-registry.ts:165`
- 防注入围栏（已预留 mcp 来源）`src/core/untrusted.ts:31`
- 技能只读工具 `src/plugins/skills.ts:345`

codex（`D:\codex\codex\codex-rs\`）：
- `sandboxing\`（bwrap / landlock / seatbelt）、`execpolicy\src\rule.rs`
- `hooks\src\lib.rs:23-36`（12 事件）、`memories\write\src\phase1.rs`、`worktree\src\lib.rs`
- `code-mode-runtime`（`v8_init.rs`）、`context-fragments\src\fragment.rs`、`docs\protocol_v1.md`（SQ/EQ）

hermes（`D:\hermes\hermes-agent\`）：
- `hermes_state_fts.py:20-93`、`native\fts5_cjk\fts5_cjk.c`
- `agent\context_compressor.py:1072-1115,999,977`、`agent\curator.py:30-31`
- `tools\approval_floors.py:98`、`approval_detection.py:88-128`、`checkpoint_manager.py:251,745`
- `tools\tool_search.py:274,543,597`、`code_execution_tool.py`、`toolsets.py:12-41`
- `cron\scheduler_preflight.py`、`agent\turn_finalizer.py:749-763`

dsh（`packages\`）：
- `sandbox\sandbox`、`session\session-checkpoint-policy`、`mcp\mcp-client`、`schedule\schedule`
- `ptc-runtime\ptc-runtime`、`hooks\hooks-codex`、`lsp\tool-lsp`、`session-query\session-query-sqlite`

---

## 附录 C：不确定项声明

以下是外部项目的口径，未逐行清点，采用时请再核：
- hermes 工具数「70+ / 28 toolset」是文档口径（`website/docs/developer-guide/architecture.md:35-36`），未逐个点数注册表。
- hermes 后台复盘的「每 N 轮」触发阈值常量未定位到，只确认触发点在 `agent/turn_finalizer.py:749-763`。
- hermes 会话 fork / branch 的 DB 层实现只确认到 `acp_adapter/session.py:197`；`git-worktrees.md` 在 AGENTS.md 里是坏链。
- hermes 侧未见会话「置顶」能力——这块 dsc 反而更强。
- codex 官方文档站（developers.openai.com/codex）本地不可达，沙箱 / 执行策略细节以本地源码为准。
