# 对标计划书：dsc 对照 codex / hermes / dsh 的差距与移植路线

这份文档把 dsc 与三个成熟 harness（OpenAI **codex**、Nous **hermes-agent**、本项目所参考的 **dsh / DeepSeek Harness**）横向对比的结果，整理成一份**能照着执行的计划书**。它回答三个问题：dsc 缺什么、哪些能作为插件补进来、按什么顺序补。

| 想知道 | 去看 |
| --- | --- |
| 怎么装、怎么跑、怎么配模型 | [README.md](../README.md) |
| 代码怎么分层、扩展点清单、契约层 | [development.md](development.md) |
| 为什么长成这样、踩过哪些坑 | [development-log.md](development-log.md) |
| **对标三家的差距、可移植项、落地顺序** | **本文档** |
| 三家（dsh / codex / Muse Code）功能清单全文（差距的证据底料） | [peer-feature-inventory.md](peer-feature-inventory.md) |

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

这三件连同紧随其后的 spill、生命周期钩子、MCP + Tool Search 都已落地，逐项状态与验收证据见 §5.1。**2026-10-02 又按三家源码清单全面重梳了一轮差距**（LSP、浏览器、定时任务、PTC、沙箱、diff 审查链在此之后陆续落地，旧矩阵曾把它们还标成缺失），修订后的矩阵见 §3，新登记的差距 T14–T28 见 §7。同日还做了一轮**已具备能力的实现深度复核**（对标同层实现抓「表面都有、细节不如」，确认 19 条疏漏含 1 个死锁级缺陷），见 §7.5。

---

## 1. 对标方法与一处事实修正

方法：读三家的 README、AGENTS.md 与关键源码/包 README，把每项能力映射到 dsc 的扩展点，判断「已具备 / 部分 / 缺失 / 有意不做」。

**先修正一个容易误判的事实**：hermes 自己没有 OS 级沙箱。它的 bubblewrap / seatbelt 只出现在自己的升级 e2e 测试里；跑 Codex 后端时是借用 codex 的 seatbelt / landlock，容器后端（Docker / Modal / Daytona）才是它的隔离边界。

所以「要真沙箱」这件事，**只有 codex 和 dsc 的参照对象 dsh 有现成蓝本**（dsh 有 Windows ACL 后端 `sandbox-windows-acl`，对 dsc 的 Windows 平台尤其对口）。别指望从 hermes 抄沙箱。

---

## 2. dsc 现状（一句话，细节见 development.md）

dsc 已具备：自研 ReAct 循环、OpenAI 兼容流式客户端（reasoning / tool_calls / usage / 重试）、会话 JSONL 落盘与重放恢复、会话库（归档 / 置顶 / 改名 / 分叉 / 回收站）、六件套工具（bash / read / write / edit / glob / grep）、四档权限模式（readonly / auto-edit / full-access / ai-review）、保头折尾摘要压缩（含重放折叠与锚点加固）、todo / plan / ask / goal、九个官方可开关插件（默认开：网页搜索、审批灾难地板、大输出溢出、会话全文检索；默认关：智能体团队、电脑操作、生命周期钩子、MCP 客户端、工具渐进披露）、安全钩子（用户自登记的规则与脚本，四个事件）、技能系统与技能市场、外部单文件插件系统、Electron 桌面端（终端 / 浏览器 / 文件 / git dock）、主题引擎、模型能力字段、AGENTS.md 说明书预算注入。

dsc 的插件扩展点（`src/core/plugin-registry.ts:71`，`KERNEL_API_VERSION = 4`）已经很够用：`tools.register`、`commands.register`、`prompt.register + transformMessages`、`guards.register + registerObserver`、`surfaces.register`、`waiting.register`、`session.appendState / state`、`events.on`、`settings.defineSection`、`skills.source`、`transcript.system`。这份清单决定了「哪些能力不改内核就能挂」。

---

## 3. 差距矩阵

图例：● 已具备　◐ 部分或受限　○ 缺失　⊘ 有意不做

**2026-10-02 修订**：把第五轮（沙箱 / LSP / 浏览器 / 定时任务 / PTC）与 0.6.24–0.6.26（diff 审查链）落地后的现状刷进来；hermes 本轮未重读源码，新增行的 hermes 列一律标「—」待核对，旧行的 hermes 列沿用当年结论。

| 能力 | dsc | codex | hermes | dsh | dsc 的判断 |
| --- | :--: | :--: | :--: | :--: | --- |
| ReAct 循环 / 流式 / 审批 | ● | ● | ● | ● | 持平，够个人用 |
| 会话 JSONL 落盘 / 重放 | ● | ● | ● | ● | 重放折叠已修（T1），见 §3.1 |
| 会话区过程折叠（三层 + 四档） | ● | ◐ | ◐ | ● | 已对齐 dsh（T13），见 §3.2 |
| 沙箱 | ◐ | ● | ○ | ● | 已落地策略级（T9）：三档模式 + 可写根白名单 + 命令前缀策略 + 一次性升权 + docker 容器后端；OS 原生隔离（Seatbelt / Landlock / Windows 受限令牌）仍是有意不做 |
| MCP 客户端 | ● | ● | ● | ● | 已补（T5），安全层与围栏复用现成的；elicitation / resources 还缺（T24） |
| 长期记忆 | ● | ● | ● | ◐ | 已内核化（`src/plugins/memory.ts`） |
| 跨会话全文检索 | ● | ◐ | ● | ● | 已补（T6），零依赖倒排索引，中文按 1+2-gram |
| 工具渐进披露 Tool Search | ● | ◐ | ● | ◐ | 已补（T5），与 MCP 同批上 |
| LSP 代码智能 | ● | ◐ | ○ | ● | 已落地（T12），含写后新引入报错注入 |
| 真浏览器自动化（DOM 级） | ● | ◐ | ● | ● | 已落地（T12，CDP 无障碍树 + ref 代际校验） |
| 生命周期 hooks | ● | ● | ● | ● | 已补（T4）：安全钩子（四个 dsc 事件）+ codex 十二事件名独立插件 |
| 定时任务 cron | ● | ◐ | ● | ● | 已落地（T8，六种选择器 + pre-dispatch 校验 + catch-up 补投） |
| PTC（模型写代码调工具） | ● | ● | ● | ● | 已落地；同进程 node:vm，隔离弱于 dsh 的子进程运行时（有意取舍，见 development-log 阶段 33） |
| 会话 checkpoint / rewind | ⊘ | ● | ● | ● | 有意不做；与 T26（部分行接受）同族，见 §7.2 |
| 子代理级联派生 | ⊘ | ◐ | ● | ● | 有意限 1 层，见 §6 |
| 细粒度执行策略 | ● | ● | ● | ● | 已补（T2）：四档之外加了灾难地板、命令白名单与 deny 黑名单 |
| 大输出溢出 spill | ● | ◐ | ◐ | ● | 已补（T3） |
| 可观测性（otel） | ○ | ● | ◐ | ● | 个人版低优先 |
| diff 审查链（轮尾聚合卡 / 右栏面板 / 悬停预览 / intended diff / 审批内嵌 / git 页签） | ● | ◐ | — | ● | 0.6.24–0.6.26 三连批补齐（development-log 阶段 42–44）；codex 的形态是 apply_patch diff 预览 + `/diff`，无轮尾聚合卡 |
| /review 审查命令 | ◐ | ● | — | ○ | dsc v1 发审查轮回复即意见；codex 有独立 review 子代理与结构化 findings（T18） |
| 输入端 @ 文件提及 | ○ | ● | — | ● | 输出端内联 chip 已有；输入端补全缺（T14） |
| bash 后台任务 | ○ | ◐ | — | ● | bash 超长任务目前只能等或砍（T15） |
| 会话标题自动生成 | ○ | ◐ | — | ● | 现靠首条消息截断 + 手动改名（T16） |
| 上下文占用表 / /status | ○ | ● | — | ● | 用量统计在设置页，会话内看不到占用（T17） |
| 会话导出 | ○ | ● | — | ● | （T22） |
| 侧栏会话运行状态点 | ○ | ◐ | — | ● | `Sidebar.tsx:671` 留空占位（T21） |
| 手机 / 移动端遥控 | ● | ◐ | ◐ | ◐ | **dsc 独有优势**：PWA + Web Push/Webhook + 二维码配对 |

### 3.1 压缩重放（已修，见 §5.1）

**当时的毛病**：内存里 `compactSession` 用 `session.replaceWithSummary` 折叠是对的，但磁盘是 append-only，而 `Session.load` 读到 `summary` 记录时**只把它当一条 user 消息 push 进去，前面累积的原始 `messages` 一条都没清**。结果 `/compact` 完当下上下文确实变小，一旦 `--resume` 重开，摘要之前的原始消息全被读回来，等于白压。

**后来更正的认识**：这里原本写的「最小改法：先 `messages.length = 0` 再放摘要」不充分——它会把压缩时特意保留的尾部（最近若干条原文）一起丢掉，压缩后的第一次交接就少了上下文。最终实现给 `summary` 记录加了 `keep` 字段（摘要之外保留了尾部多少条），重放时先取末尾 `keep` 条再清空，接回「摘要 + 保留尾部」；老日志没有这个字段按 0 处理，退化成「摘要 + 摘要之后的记录」，原文一样不会读回来。落地情况见 §5.1。

### 3.2 会话区过程折叠（已对齐，见 §5.1 与 `docs/session-fold-todo.md`）

**这一层对齐的是 dsh 的三层结构**（对照 `packages/client/ui-chat/src/client/conversation-nodes/`）：

1. **整轮总开关**：一轮跑完，过程整组收起，原位只留一行「用时 X」（`TurnProcessNodeView.tsx`）。跑动中的轮不画这一行；
2. **阶段组头**：轮内再按「阶段正文」切段，每段一行类别聚合文案（`process-groups.ts` 的切分规则 + `step-process.ts` 的文案拼法）。运行中的组头带实时任务详情（「正在运行命令 · pnpm build」）；
3. **单条思考 / 工具行**：各自折叠成一行（`ReasoningRow.tsx` / `ui-tool` 的 `ToolRow.tsx`）。

**四档展示档位**（`presentation-policy.ts` 的四个能力逐格对照，落地在 `desktop/src/renderer/fold-policy.ts`）：
`compact`（折 + 分组 + 无摘要 + 组头不带详情）/ `standard`（默认）/ `detailed`（整轮照折，但只有**历史轮**分组）/ `verbose`（不折、也不分组）。

**本轮补齐的三项「dsh 有、dsc 原来没有」的界面能力**：

| 项 | dsh 的蓝本 | dsc 落地 |
| --- | --- | --- |
| 组体限高 + 方向渐隐 + 组内独立滚动 | `use-process-scroll.ts` + `ChatGroupSeat.module.css` 的 `max-height: min(400px, 50vh)` 与 mask 渐隐 | `.step-body` / `useProcessScroll`（`desktop/src/renderer/fold-seats.tsx`） |
| 收起的 DOM 仍能被浏览器查找命中 | `chat/searchable-hidden.ts` 的 `hidden="until-found"` + `beforematch` | `useSearchableHidden`（同上），两处收起都不再 `return null` |
| 自动收起不抽走键盘焦点 | 同一个 `useSearchableHidden` 里的焦点检查（隐藏前先看焦点在不在里面） | 同上；另外组头点击时先把焦点落到组头自己身上 |

**口径变更（会改变观感，值得记一笔）**：`processFold` 原本是「compact / standard / detailed」三档，其中 `detailed` 的语义是「不做整轮折叠」——那其实是 dsh 的 `verbose`。对齐之后 `detailed` 改为 dsh 的语义（整轮照折，只有历史轮分组），原来那种「全摊开」由新的 `verbose` 档承担。老 `settings.json` 里存着 `detailed` 的用户升级后会看到过程折起来了，去设置里改「完全展开」即可（没有做存档迁移：这个档位是 0.6.3 才加的，且迁移需要额外引入一个存档版本位）。

**有意不做**：`hasInterleavedInput`（轮中途插话就不折整轮）。dsc 的 transcript 里没有 steering 这个条目类型（`src/contract.ts` 只有 user / thinking / text / tool / plan / system），既没数据也没行为，要做先得有「轮中途插话」的数据模型。

**顺手发现的一处不一致（未在本轮动）**：启动恢复历史会话走的是 `src/host/kernel.ts:363-366` 的重放分支，**没有发 `dsc/session-open`**，而切会话（`src/plugins/session.ts:88-98`）会发。于是靠这个事件恢复自己状态的插件（plan / todo / goal / mode）在「冷启动恢复」这条路上不会被触发——计划卡因此不会出现在冷启动的会话流里（`src/plugins/plan.ts:114-121`）。要让两条路一致，得把 kernel 的重放分支改成走 `session.open(resumePath)`，或者补发一次事件；那会影响 approval-floor 的 reset 与 agent 的 switchSession，属于内核改动，单独立项。

### 3.3 会话区继续对齐：剩余批次（用户裁决「完全对齐 dsh」）

0.6.7 把折叠这一层的骨架对齐之后，逐项核出来的差异按可做性分了四批。批 1 已落地（见 `development-log.md` 阶段 24）：

| 批 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 轮结束原因与「已停止 / 过程失败」（`turn/end` 的 reason 一直有，adapter 丢了）、轮中途插话（steering）落在同一轮且锁住整轮折叠、轮内 `system` 不再被折叠藏掉、组收口时不重置组内阅读位置、没有过程内容时画一行不可点的「用时 X」、输出撞长度上限时给一行提示 | 已落地（0.6.8） |
| 2 | **「准备中」态**（dsh 的 `preparing`：组头显示「准备读取文件」，通用类别在标准档还追加工具名）——落到 `core/llm.ts` 的流式层新增 `onToolPrepare` 回调，adapter 用「准备中」队列按名字配对、`tool/call` 到达时就地升级成 `running`；**模型重试行**（dsh 的 `model-retry`）——`core/llm.ts` 的重试环新增 `onRetry` 透出事件，adapter 落一条 `model-retry` 条目（它是二级分组的边界，但整轮折叠仍包含它） | 已落地（0.6.9） |
| 3 | **组头跑动中的扫光**（dsh 的 `TextShimmer`）：dsc 早在思考摘要上做了同一套写法（`styles.css` 的 `data-shimmer` + `::after` 复制文字 + `background-clip: text`），这一批把它共用给阶段组头的标题；**类别图标不改**，理由见下 | 已落地（0.6.10） |
| 4 | **加载更早历史**：dsh 是按正文顺序锚定按钮下第一个可见内容项、限高组先吸收位移再外层补偿、分页期间读者滚动优先、保留组级开合（`conversation-nodes/README.zh.md:96-100`）。dsc 按**同样的可见行为**做了渲染层渐进渲染（`ChatView.tsx` 的 `earliestVisible` / `loadEarlier`），**数据源分页不做**——理由见下 | 已落地（渲染层，0.6.11）；数据源分页押后 |

**明确不做（已裁定）**：

- **运行指示换成 dsh 的「鲸鱼摆尾 + 闪烁计时」**：dsc 现在的两行（阶段说明 + 当前活动名 + 实时用时）比它多一句「此刻在调什么」，换过去是信息量降级；
- **类别图标换成 dsh 那一套**：dsh 的图标来自它自己的设计系统包（`@deepseek-ai/dsh-client-ui-primitives`），dsc 拿不到那些 SVG（只能手抄路径）；而且 dsh 把 `commands` 画成一个抽象的 API 方块图标，语义上不如 dsc 现在用的终端图标贴切。真正值得对齐的是「哪一类用哪一类图标」这个映射，而那条已经对齐（读→文件夹、搜→放大镜、命令→终端、子代理→树、计划→队列）。`webFetch` 一度想按 dsh 归到与 `read` 同用的「浏览」图标，但 dsc 没有浏览图标，而地球图标对「抓取网页」更贴切，所以也保持原样；
- **子调用递归计数**：dsh 需要它是因为有 PTC（`run_code` 的嵌套调用）与子调用投影，dsc 的 `ToolCallView` 没有子调用结构、`subagent` 是另一条会话，规则无处应用；
- **`turn-tail` 节点语义未查明**，本批不动（它可能就是 dsh 的"轮尾标记"，dsc 用 `turn-end` 条目承担了同样的角色）。

**押后：数据源分页（不是不做，是现在做没有收益）**。原本打算照 dsh 把「加载更早」做成**从宿主分页取数据**，实测之后改了口径：

| 量的是什么（`desktop/shots/load-bench.mjs`，只读真实 `~/.dsc`） | 实测 |
| --- | --- |
| 最大的单会话（1 MB / 25 条消息） | `Session.load` 4.9ms + 重放 0.5ms，堆增量 3.3 MB |
| **全部 78 个会话**加载一遍 | 26ms，堆增量 2.5 MB（共 237 条消息） |
| 全库磁盘占用 | 2.6 MB |

**关键在于 dsc 的 `messages` 同时是「模型请求上下文」和「界面展示来源」同一份**：只给展示分页，请求上下文仍然要全量加载，**内存一点不减**，只是少画 DOM。dsh 能靠分页省下来是因为它结构上就把两者分开了（`session-query` 的索引 + node store + `next-turn` 领取批次），那是架构级改造。所以 dsc 这一步做的是**渲染层渐进渲染**——用户可见行为与 dsh 完全一致（有「加载更早」、锚定不动、保留组级开合、限高组先吸位移），只是数据早就在内存里。等哪天会话真长到几千轮，再连架构拆分一起做。

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
| T13 会话区过程折叠 | 已落地（第三轮，见 §3.2） | 三层结构（整轮总开关 / 阶段组头 / 单条思考与工具行）+ 四档展示档位（能力表在 `desktop/src/renderer/fold-policy.ts`，逐格对照 dsh 的 `presentation-policy.ts`）、运行中组头的实时任务详情（取参数的键序照抄 dsh，160 字素簇上限）、组头标题 150ms 最短保留（纯函数 `liveTitleDecision` 可测）、组体 `min(400px, 50vh)` 限高 + 24px mask 方向渐隐 + 组内独立滚动跟随、收起改挂 `hidden="until-found"`（Ctrl+F 能命中收起内容、自动收起不抽走键盘焦点）、两个与档位正交的默认态开关（思考行 / 工具卡，dsc 自己的增量）。四张网：`step-groups-check.mjs` 163 PASS / 0 FAIL、`step-seed-check.mjs` 25 PASS / 0 FAIL、`fold-check.mjs` 166 PASS / 0 FAIL、`step-shots.ps1` 六用例隔离截图全绿。已知未做：轮中途插话不折整轮（dsc 无 steering 条目类型） |

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

## 7. 2026-10-02 全面修订：差距登记（T14–T28）

方法：三路并行源码梳理（dsh、codex、Muse Code 各出一份按能力域分组的功能清单），清单全文与逐条出处见 [peer-feature-inventory.md](peer-feature-inventory.md)；hermes 未重读。编号延续 §4/§5.1 的 T13 之后。每条给出对标出处、dsc 现状、落点与动不动内核；优先级按「天天用得上 → 锦上添花」排。

### 7.1 高价值差距（P1，建议下一批按序做）

#### T14. 输入端 @ 文件提及补全（P1，不动内核）
- **是什么**：输入框敲 `@` 弹出工作区文件路径候选，选中后按路径插进正文。dsh 有 `@file`（`context/file-reference-local` + `ui-reference` 统一选择器）；codex 有 `/mention` + 文件搜索弹窗（`file-search` crate）。
- **dsc 现状**：输入端只有 `/` 命令补全（`src/core/commands-completion.ts`）；**输出端**的内联文件 chip 与 hover diff 已就位（0.6.25/26），`matchMentionPath` 已能把正文里的路径提及映射到改动卡——识别半边是现成的，缺的是输入半边。
- **落点**：渲染层 `Composer.tsx` 监听 `@` 触发候选面板；路径候选数据用 dock 已有的 `fs-list` 操作（或加一个 host 方法做前缀匹配，二选一先量成本）。TUI 侧同理可后补。
- **验收**：`@` 后敲两三个字符出候选、键盘可选；选中的路径在发出后能被改动卡与正文 chip 识别。

#### T15. bash 后台任务（P1，动内核或新官方插件）
- **是什么**：长命令（构建 / 测试 / 起服务器）不占住回合：`bash` 工具加 `run_in_background` 参数立即返回，配 `job_output` / `job_list` / `job_kill` 三个工具（dsh `jobs/tool-jobs` 三工具 + 完成通知经 `agent.inject()` 注入的形态）。dsh 还有一条同族姿势：**超时不 kill 而是转后台 job**。
- **dsc 现状**：`src/core/tools/bash.ts:20-27` 注释自认「更长的活该去后台跑」但未实现；桌面交互终端面板是人用的，模型够不着。
- **落点**：内核侧加一张后台作业表（进程句柄 + 输出环形缓冲），三个新工具走 `ctx.tools.register`；完成事件走 `agent.followup` 通知。
- **风险**：作业生命周期归谁管（会话结束收不收）、输出上限（复用 spill）。**验收**：模型发一个 10 分钟的构建立即拿到 job id，稍后 `job_output` 能读到增量，完成时收到通知。

#### T16. 会话标题自动生成（P1，不动内核）
- **是什么**：首回合结束后用一个小请求生成标题。dsh 的 `session-title` 包：首条消息回退词 / LLM 策略（首条 prompt 或全部 prompts 两档）/ 用户改名 + `refresh()` 重生成，标题永不进模型输入。
- **dsc 现状**：标题 = 首条 user 消息截断，只有手动改名。
- **落点**：首回合 `turn/end` 后经 `agent.followup` 或独立小请求生成，写 `sessions/meta.json`（sidecar 已有，不污染重放）；用户改过名的（meta 里有自定义标题）永不覆盖。
- **验收**：新会话第一轮跑完后侧栏标题变成概括词；手动改名后再跑轮不被覆盖。

#### T17. 上下文占用表 + /status（P1，不动内核）
- **是什么**：会话内能看见「当前上下文用了多少、构成是什么」。dsh：`token-meter` replay 确定性测量（tokenUsage/contextPressure/contextBreakdown，零模型调用）+ UI ContextMeter；codex：`/status` 展示 thread token 用量与美元成本估算。
- **dsc 现状**：compact 有自动阈值（80%×contextWindow）但触发前用户看不见；用量统计（usage.jsonl 聚合）只在设置页。
- **落点**：dsc 已有 CJK 感知的 token 估算器（compact 在用），把它包成一个 `/status` 命令 + 右栏/侧栏占用卡（消息数、估算 token、占窗口百分比、compact 剩余余量）。
- **验收**：长会话里 `/status` 能看到占用与距离自动压缩还剩多少；数字与 compact 实际触发点同源。

#### T18. /review 升级：独立审查子代理 + 结构化 findings（P2 偏高，不动内核）
- **是什么**：审查在隔离的子会话里跑，产出结构化发现而不是一段散文。codex：`core/src/session/review.rs` 独立 review 线程（独立 review_model、禁用 web_search/view_image），范围 UncommittedChanges / BaseBranch / Commit / 自定义，输出 `findings[title/body/confidence/priority/code_location(文件+行区间)]` + 总体正确性。
- **dsc 现状**：`/review` v1（0.6.26）在当前会话发一条审查消息，回复即意见。
- **落点**：subagent 插件派一个只读队友（审批意愿取只读交集，天然安全）；约定 findings 输出格式（JSON 或固定分节），渲染层按条渲染 + 行号跳转。v1 的消息组装与 git 收集（`src/core/git-info.ts`）全部复用。
- **验收**：`/review` 后出现独立审查轮（不打断当前会话上下文），findings 逐条带文件行号。

#### T19. 压缩前置裁剪 + 图像卸载（P1，不动内核）
- **是什么**：压缩前先做一遍机械瘦身再请模型摘要。dsh：`compaction-tool-result-pruner`（超限工具输出先裁掉，留指针）、`compaction-image-offload`（历史图像按预算卸载）。收益：摘要输入更小（省 token）、摘要质量更高（不被日志噪音淹没）。
- **dsc 现状**：compact 直接对全量消息摘要；`drop-images` 投影只在模型不支持图片时兜底换图。
- **落点**：`src/core/compact.ts` 摘要前加一个前置 pass——超长 tool 结果替换为「已裁剪 + spill 路径」（spill 落盘与续读写法全是现成的）；图片按预算卸载留占位说明。
- **验收**：同一段超长会话，裁剪后压缩的摘要输入 token 明显下降且关键事实（锚点索引断言）不丢。

### 7.2 中优先级（P2）

| 编号 | 差距 | 对标出处 | dsc 现状与落点 |
| --- | --- | --- | --- |
| T20 | 模型可用的持久终端工具 | dsh `tool-terminal` 六工具（open/read/send/signal/close/list，PTY、readiness 检测） | bash 是一次性管道（无 tty，全屏程序跑不了）；桌面终端面板只给人用。落点：新工具包，PTY 需要 node-pty 之类依赖（打包要过 prepare-runtime 依赖闭包），或先做「多页签管道会话 + 读写分离」的降级版 |
| T21 | 侧栏会话运行状态点 + 待审批圆点 | dsh ui-workspace 待处理交互警告圆点、定时任务时钟标记 | 快照里已有会话状态灯（awaiting-approval/working），但那是「当前会话」的；侧栏要的是跨会话一览。`Sidebar.tsx:671` 留空占位就是等它。落点：快照加每会话状态面（阶段 40 边界①已登记） |
| T22 | 会话导出 | dsh `/export` ZIP（`session-log-export`）；codex `/export` markdown | 无。落点：渲染层把当前会话条目序列化成 markdown 落盘即可（数据全在内存），成本极低 |
| T23 | 在线模型发现 | dsh 设置页「Fetch available models」 | 模型清单手填。落点：`GET {baseURL}/models` 拉取填充，host-stdio 加一个方法（走 §5 三步） |
| T24 | MCP elicitation + resources + prompts | dsh `mcp-resources` 三工具；codex elicitation + MCP resources + dynamic tools（prompts→工具） | mcp.ts 只收工具。落点：MCP 客户端扩展三类能力；elicitation 要接审批卡通道 |
| T25 | read 工具支持图片文件 | dsh `read_image`；codex `view_image` | read 只出文本（`src/core/tools/fs-tools.ts` 无 mime 分流）；模型看图只能靠用户贴图或 computer-use 截屏。落点：read 按扩展名分流，图片走 base64 image_part（模型 modalities 含 image 时） |
| T26 | diff 部分行接受 / 已执行改动回滚 | codex apply_patch 语义 + backtrack；hermes checkpoint writer-ledger（回滚保手改、只覆盖 agent 改动） | 审查面板纯只读，拒绝只能发生在审批前。**前置**：要先有「已执行改动的回滚语义」（shadow git / 反向 patch），与 checkpoint/rewind 同族——先单独立项评估，别顺手做 |
| T27 | 检查更新落地 | codex `codex update` 自更新 + 启动 update prompt；dsh 强制更新流 | 版本比较与 GitHub Releases 解析已备，`UPDATE_CHECK_URL` 还是空串占位（发布后填）。下载与安装（electron-updater 或手动换包）未做 |
| T28 | 外部插件远程安装 | dsh plugin_manager 安装 bundle；codex 插件 marketplace（add/remove/upgrade/policy） | `plugin_manager` 只收本地 .js。落点：照技能市场的两类源（GitHub 目录/索引 JSON）拉插件包，装前过审批 |

### 7.3 低优先（P3，登记免遗忘，个人版暂不做）

| 项 | 对标 | 不做的理由 |
| --- | --- | --- |
| checkpoint / rewind / backtrack | codex Esc-Esc 回退重编辑；hermes shadow git | 与 T26 同族，动内核，等真实痛点；**已升出立项 T52（§7.8）** |
| 轮中途插话 steering / 消息排队 | dsh steering inbox；codex turn steer + `codex queue` | 无 steering 数据模型，已裁定不做（§3.2 有意不做清单） |
| 对外 SDK / 协议面 | dsh SDK（TS+Python）；codex app-server v2 | 个人版没有第三方集成方；host-stdio 协议 v2 内部够用；**已升出立项 T53（§7.8）** |
| SSH 远程执行 | dsh `packages/ssh/*` | 手机遥控已覆盖「人不在电脑前」的主场景；**已升出立项 T54（§7.8）** |
| 消息评分反馈 | dsh Like/Dislike + `/feedback` | 无消费方（dsh 的评分喂官方日志上传，dsc 没有这条链路） |
| 快捷键自定义 / Vim 模式 | codex keymap + Vim；dsh shortcuts 持久化 + 冲突检测 | 快捷键只有 8 个，冲突面小 |
| GitHub PR 审查 webhook | dsh `webhook-github` 自动建只读审查会话 | 个人版没有 CI 场景 |
| OAuth 账号 / OS keyring | codex login PKCE + keyring-store；dsh DeepSeek 账号 | dsc 用环境变量/credentials.yaml，个人机器可接受 |
| i18n 英文界面 | dsh zh/en 双语 + 强制字典 gate | 全中文是产品定位 |
| Office 老格式预览管道 | dsh 内置 Office 技能 + 文档预览 tab | 阶段 39 边界①：预览占位提示已够用 |
| 手机端补齐 | dsh 无对应物 | 团队/模式面板、归档管理操作——手机端定位是遥控不是全功能 |
| MCP prompts→工具（dynamic tools） | codex `core/src/tools/handlers/extension_tools.rs` | 并入 T24 一起看 |
| doctor 体检命令 | codex `codex doctor`（安装/配置/auth/网络） | `/plugins`、`/sandbox`、设置页已分散覆盖；等插件生态变大再说 |

### 7.4 dsc 独有/领先项（防止纯「差距叙事」的误读）

以下能力 dsc 领先或独有（出处见 [peer-feature-inventory.md](peer-feature-inventory.md) §三）：

1. **手机遥控全家桶**（PWA + Web Push/Webhook + 二维码配对 + 逐台设备管理）——dsh 只有 `0.0.0.0` 裸暴露 + SSH 隧道，codex 只有 app-server remote；
2. **审批安全纵深**：灾难地板 + 熔断 + 命令策略引擎逐段判定 + 安全钩子 fail-closed + AI 审查档 + 无人值守拒——dsh 明确只有一次性 allow-once（README 原文），codex 的 granular 档未开放时主要靠沙箱兜底；
3. **中文优先**：会话检索 1+2-gram、界面全中文；
4. 技能自修 + 台账回滚 + 老化（self-improve 三闭环）；
5. 会话回收站（30 天可捞回）；
6. 定时任务 pre-dispatch 校验（坏配置一次 token 不花）；
7. 轨迹页（整轮折叠 + 时间线 + 独立节点检查器）。

### 7.5 已具备能力的实现深度复核（第二轮，2026-10-02，T29–T47）

§3 矩阵与 §7.1–7.3 管的是「能力有没有」；本节管「**已标 ● 的能力，实现深度够不够**」。方法：18 个定向疑点 + 双侧开放扫描，逐条与 dsh/codex 同层实现细比，每条给三态结论（确认疏漏 / 不成立 / 部分成立）与两侧文件:行号证据。共确认 19 条疏漏、澄清 4 条「其实已覆盖」（见 7.5.4，防未来重复立案）。

> **落地记录（同日 0.6.27）**：T29–T47 十九条已全部修复并验证（四张行为网 + 会话探针全绿）。
> 个别条目在落地时做了范围收敛——T36 的 Windows 优雅终止档、T42 的「回合前已脏文件」盲区、
> T43 的深层目录增量触达、T47 的隐式调用识别——细节与理由见 development-log 阶段 46 的诚实边界。

#### 7.5.1 P0：缺陷级（真 bug 或数据安全，先修）

**T29. 计划评审卡挂起时切换会话 → agent 循环永久死锁**
- dsc：`plan.ts:34-62` 的 `propose` 挂起等审批，abort 清理走 `finish('rejected')`，但 `finish` 首行 `if (planDone === null) return`（`plan.ts:39`）；`dsc/session-open` 监听器把 `planDone` 置 null **且不 resolve 挂起的 promise**（`plan.ts:114-117`）；插件顺序 plan 先于 agent（`kernel.ts:326,328`）——切换会话时监听器先清空、agent 的 abort 后到，清理落空，`exit_plan_mode` 的 await 永不返回，`running` 永真，之后所有消息变 steering，宿主只能重启。入口现成：侧栏「新会话」/SessionPicker/`/new`/`/resume` 全不受挂起计划约束。
- 对标：dsh 对「评审比插件 fiber 活得久」有明确工程化（`plan-mode/index.ts:336-339`）；dsc 自家 approval 插件的同类清理是对的（`approval.ts:582-588` exit 时调 `done`）。
- 修法：session-open 分支先 `planDone?.('rejected')` 再置空（对齐 approval 的写法），一行级。

**T30. 会话 jsonl 无跨进程写锁**
- dsc：append 直写无任何跨进程锁（`session.ts:556`）；「打开中的会话不能归档」只查本进程内存（`plugins/session.ts:117-126`）。桌面端（utilityProcess）与 TUI 都从同一份 `.last-session` 取默认会话，同开一个工作区 → 两条对话交错 append 进同一份日志，重放串线；fork/归档的 `renameSync` 可在另一侧持句柄时移动文件。meta.json sidecar 的读改写同样无锁、损坏即被空表覆盖（`session-meta.ts:77-91`，:44-67 注释自认）。**dsc 自己会做锁**：schedule 的 `.lock` 互斥（`schedule/runner.ts:10,328,364`）、sandbox ACL 的 LockFileEx（`sandbox/win/acl.ts:88-117`），唯独会话没有这层。
- 对标：codex `rollout/writer_lock.rs:43-86`（try_lock + 陈锁清理）；dsh `SessionWriteLease`（`lease.ts:70-116`，Windows 命名信号量 + POSIX flock + inode 校验），恢复时「先拿写所有权再读」。
- 修法：会话写租约，争用时报「会话已在另一窗口打开」；meta.json 纳入同一把锁。

**T31. 会话头行损坏 = 整个会话永久打不开**
- dsc：首行 meta 半截 JSON 直接 throw「缺少 meta 行」（`session.ts:329`），恢复失败**静默回落开新会话**（`plugins/session.ts:59-64`）——后面 99% 完好的对话再也进不去，用户无感知地丢了整个会话。坏行本可静默跳过（`session.ts:229-241`），唯独 meta 行没有抢救路径。
- 对标：codex rollout 有 reverse_jsonl_scanner / maintenance / state_db 巡检恢复面；dsh 有格式迁移链 + `repair.ts`。
- 修法：meta 损坏时向后重同步（按第一条 user 记录重建 meta），或至少隔离损坏文件并明确告知。

**T32. 中断 turn 恢复后模型对未完成动作失忆**
- dsc：`sanitizeToolOrphans` 每次请求在副本上**静默剔除**配不上对的 tool_calls/tool 消息（`llm.ts:153-190`）——崩溃中断的回合恢复后，模型不知道「我发起过一个可能已产生副作用的操作、结果未知」，无从决定是否核查；界面显示有这个调用、模型以为没有，两者矛盾。
- 对标：dsh `repair.ts` 的 `interruptedTurnClosers` 生成**合成闭合事件并落盘**——「已启动但结果未知」与「根本没启动」两种文案 + 明确行为指引（仅只读/幂等可重试；可能有副作用先核查），resume 时一次修复持久化。
- 修法：恢复会话时仿 dsh 落盘修复，`sanitizeToolOrphans` 退居协议兜底。

**T33. 流中断半截回复丢弃，且流期零重试**
- dsc：流已开始后网络错误半截直接 throw（`llm.ts:426-430`），半截 assistant **不落库**（`appendAssistant` 只在流正常返回后执行，`loop.ts:241`）——用户看到半截正文 + 报错，上下文里却没有这条消息；408 与流空闲超时刻意 `retryable=false`（`llm.ts:282,462`）。dsc 的重试预算是「连接期 3 次、流期 0 次」。
- 对标：dsh 已收内容 durable 落库（`agent.ts:476-520`）+ llm-retry step 边界整体重试；codex `turn.rs:1621-1707` `stream_max_retries` 缺省 10（注释原话 retry dropped SSE streams）。
- 修法：① 流错误时把已收 text/合计 toolCalls 落一条截断 assistant 记录；② 对「已收字节未到 finish」的流中断加一次可配重试；③ 408 纳入可重试清单。

#### 7.5.2 P1：防线补齐

| 编号 | 疏漏 | dsc 证据 | 对标证据 |
| --- | --- | --- | --- |
| T34 | **read 输出无字节/行长/limit 封顶、无二进制检测**——spill 插件刻意排除 read（`plugins/spill.ts:32`），read 成了全系统唯一无字节数防线的输出入口，单行超长文件（bundle/锁文件）可直接撑爆窗 | `fs-tools.ts:88-97`（`limit` 无上限） | dsh `maybeTruncate` 按 maxOutputChars（缺省 16000）截断附提示；dsc 自家 bash 有 8000 字符 + spill |
| T35 | **edit/write 无 CAS 版本校验**（读→改→写窗口内文件被第三方改，拿旧基线整篇写回；write 有 mtime 陈旧检测只覆盖「读之后被改」，edit 完全没有） | `fs-tools.ts:129-131,164-169` | dsh 写回带 `replaceIfVersion` 原子比对（`tool-str-replace-editor:314-322`）；codex 每次从盘上现值重算。另：dsh 的 edit 强制先读（FS_NOT_OBSERVED），dsc edit 不要求先读（自读现值，风险小） |
| T36 | **bash 超时丢全部已收输出 + 无优雅终止档**：超时只回一句「命令超时」，编译错误印在前 20 秒、31 秒超时时模型什么线索都拿不到；直接 SIGKILL/`/F` 跳过构建工具的清理逻辑 | `bash.ts:87-90,48-59` | dsh SIGTERM→3s grace→SIGKILL 树级两档，被杀进程输出仍可读；codex terminate→kill 两档（`exec-server/connection.rs:187-223`） |
| T37 | **MCP server instructions 被丢弃**：initialize 响应整个不接（只 await 不取返回值），server 用 instructions 传达的工具用法预期模型永远看不到 | `mcp.ts:692-696` | dsh 读 instructions 并注册进 system prompt（`mcp-client/connection.ts:305-321` + `server-context.ts:16-37`，带字节上限） |
| T38 | **PTC 脚本可并发写调用**：`Promise.all` 两个写调用并发跑，无互斥（总次数上限 200 是唯一的闸）——守卫链重入本身没问题（每调用走 `ctx.guards.gate`），缺的是 dsh 的「写/执行串行」屏障 | `plugins/ptc.ts:102-135` | dsh `core/tools/README.md:194` "mutating calls run alone" + `ptc.ts:419-441` 提交游标 + barrier |
| T39 | **会话级模型记忆缺失**：/model 切换只改进程级内存，恢复会话回落 config 默认模型 | `plugins/llm.ts:22-25`；SessionStateMap 无 model 条目（`session.ts:103-130`） | dsh 会话事件流持久投影（`model-selection-projection.ts:35-56`）：日志里记录实际发过请求的模型，恢复优先取它 |
| T40 | **计划拒绝反馈回路断裂**：`answerPlan` 只收决策枚举，拒绝后模型收到「把用户的反馈吸收进方案」但反馈无通道传入，只能盲猜 | `contract.ts:79,1087`；`plan.ts:109` 固定文案 | dsh 计划评审带自定义文本输入，反馈原文直接进工具结果（`plan-mode/index.ts:307-348`） |
| T41 | **压缩不可取消、/compact 无运行中守卫**：三条路径都传一次性 AbortController，用户 interrupt 停不掉压缩的 LLM 调用；回合运行中 /compact 会让摘要落库与进行中工具落库交错 | `plugins/compact.ts:126,146,163` | dsh `compactNow(invocation.agent, invocation.signal, …)` + 取消回执（`command-compact/index.ts:67,75`） |
| T42 | **轮尾「文件已更改」卡漏 bash/脚本改动**：只认 write/edit 第一方归因，bash/sed/构建脚本改的文件不进卡，用户看到「无更改」而工作区已变 | `loop.ts:374-378`；`session.ts:439-464` | dsh turn 首尾 git 快照 diff 兜底（私有对象库 + scratch index，含未跟踪与重命名检测，maxFiles=500），文件工具捕获只补 git 盲区（`workspace-changes/index.ts:143-165`） |

#### 7.5.3 P2

| 编号 | 疏漏 | dsc 证据 | 对标证据 |
| --- | --- | --- | --- |
| T43 | AGENTS.md 缺四手：深层目录触达的增量发现 / `AGENTS.override.md`·`*.local.md` 覆盖层 / 变更删除对账 / project-root 有序发现（dsc 是 cwd 向上 8 层硬截断，仓库根之上丢说明） | `prompt.ts:76-100,42-43` | dsh `agent-instructions`（fs 触达 → projectTouch 增量对账 + resume 对账）；codex `agents_md.rs:42-46`（override + fallback 配置 + root→cwd） |
| T44 | 命令可用性无声明矩阵、三端防护不一致：桌面审批等待期禁 textarea（连 /help 都敲不了）但侧栏「新会话」可绕过直接打断挂着审批的回合；TUI 一刀切；远端无回合状态检查 | `commands.ts:49-66`；`App.tsx:786,596-600` | codex `slash_command.rs:239-302` 每条命令声明 `available_during_task` 的矩阵 + 测试锚定 |
| T45 | 推送盲区：审批推送只在卡出现那一刻发一次，久等无升级再提醒；10 秒同类节流会吞掉第二张审批卡；ask_user 提问卡与计划评审卡**完全不推**（同样挂起等人的时机） | `remote.ts:961-970,1011-1032`（只盯 pendingApproval） | 审批推送本身 dsc 领先（codex notify 钩子只有回合完成一种）；此条是与自家场景对比出的盲区 |
| T46 | web_search 无域过滤/位置参数（tavily 原生支持 include/exclude_domains 白白不用） | `web-search.ts:165-171` | codex `tool_spec.rs:39-48` `allowed_domains` + `user_location`（dsh 与 dsc 同水平，此条只对标 codex 成立） |
| T47 | 技能两处小疏漏：whenToUse 解析了但不渲染进目录行（「何时该用」信号丢失）、目录引导语泛泛；无隐式调用识别（模型没调 skill 工具但实际踩到技能无记录无策略） | `skills.ts:102-108,110-112` | codex `skills/invocation.rs` 完整隐式检测 + `allow_implicit_invocation` 策略位；dsh 目录引导语明确（「任务明显匹配就先调 skill 工具」） |

#### 7.5.4 复核为无疏漏（已有实现且不弱于对标，防重复立案）

- **edit 多匹配**：dsc 报错（`fs-tools.ts:165-167`），比 codex 严——codex `seek_sequence` 只取第一个匹配静默替换（`apply-patch/seek_sequence.rs:39-70`）；可借鉴 dsh 的报错带匹配行号。
- **PTC 守卫链重入**：每次 sdk 调用完整走 `ctx.guards.gate` + `observe`（`plugins/ptc.ts:102-119`），fail-closed 成立，与 dsh 的「嵌套重入完整管线」同构。
- **超窗兜底**：`isContextOverflowError` + `forceCompact` 压完重试本轮已有（`loop.ts:59-65,160-171`）；与 dsh 的差异只是「400 + 措辞正则」vs「结构化错误码」，打磨级。
- **write 的 read-before-write**：有，且带 mtime 陈旧检测（`path-policy.ts:200-215`），比 dsh 的版本检查多防一层「读到写之间被第三方改」。

### 7.6 建议的落地顺序

**第二轮的 P0 五件（T29–T33）与 P1/P2 全部 19 条已于 0.6.27 修复完毕（见 §7.5 落地记录）**，正确性批次清账。

第一轮登记的缺失能力（T14–T28）按原顺序推进：**T14（@ 提及）与 T16（标题生成）最轻**（不动内核、半天级）先做；**T15（后台任务）价值最高但动内核**，单独立项；**T17（占用表）/ T19（压缩前置裁剪）同用 token 估算器，连着做**；**T18（review 子代理）等 T15 的 subagent 通道热身完再上**。P2 按 T22 → T21 → T23 → T25 → T24 → T20 → T27 → T28 → T26 的大致成本升序排。

### 7.7 T14–T28 落地收口（2026-10-02，0.6.29–0.6.33）

五个功能批次全部落地，逐项状态（探针与回归证据见 development-log 阶段 48–52）：

| 项 | 状态 | 落地形态 |
| --- | --- | --- |
| T14 @ 文件提及 | ✅ 0.6.29 | `mention-complete.ts` 渲染层纯模块 + Composer @ 面板；`matchMentionPath` 剥 `@` 使发送后 chip 可识别 |
| T16 会话标题自动生成 | ✅ 0.6.29 | `session-title` 官方插件；autoTitle 独立字段，用户改名永不被覆盖 |
| T17 /status 占用表 | ✅ 0.6.29 | `statusReport` 纯函数；窗口/消息数/估算/触发线，估算口径与自动压缩同源 |
| T22 会话导出 | ✅ 0.6.29 | `core/session-export.ts` markdown 序列化（工具输出限额留头去尾、围栏修无反引号 4 连 bug） |
| T19 压缩前置裁剪 | ✅ 0.6.30 | `pruneRegion`：工具结果超预算 spill 留指针、图像卸载；锚点引用取自未裁剪原文 |
| T23 在线模型发现 | ✅ 0.6.30 | `core/model-discovery.ts` + 设置页「拉取清单」，认 OpenAI/ollama/纯数组三种形状 |
| T25 read 读图 | ✅ 0.6.30 | read 按扩展名分流 data URL（6MB 红线）；`dropImageParts` 投影兜底 |
| T21 侧栏状态点 | ✅ 0.6.30 | 快照 `sessionStates`（当前会话 turnState + 队友名册），working 呼吸 / awaiting 橙点 |
| T15 bash 后台任务 | ✅ 0.6.31 | `run_in_background` + `job_output/job_list/job_kill` 三件 + `JobTable`；附带修 Windows 退出码透传 |
| T18 /review 升级 | ✅ 0.6.32 | `reviewer` 内置角色 + `ReviewService.spawn`（工牌强制只读交集）+ findings 结构化卡 + 行号跳转；subagent 插件没开回落 v1 |
| T24 MCP 扩展 | ✅ 0.6.33 | 协议升 2025-06-18；resources/prompts 客户端方法 + `mcp_resources`/`mcp_prompts` 工具（按 server 能力注册）；elicitation 接审批卡（stdio 通道声明能力，http 不声明） |
| T20 持久终端 | ✅ 0.6.33 | 降级版五动作 `terminal` 工具（open/read/send/close/list）+ `TerminalTable`；无 PTY、无中途打断（披露）；**完整版已立项 T48（§7.8）** |
| T27 检查更新 | ✅ 0.6.33 | 检查链路已备（0.6.18 起）+ `sourceUrl` 测试缝探针覆盖；`UPDATE_CHECK_URL` 仍待发布后填；**不做自动安装**（用户只要检查），有新版打开发布页手动换包 |
| T28 插件远程安装 | ✅ 0.6.33 | `plugin_manager` 加 `browse_remote`/`install_remote`；`core/market.ts` 插件市场两函数（GitHub 目录/索引 JSON 两类源）；必须 https，risk=write 装前过审批；**npm 包形态已立项 T49（§7.8）** |
| T26 回滚 / 部分行接受 | ▶ 已立项（T51，2026-10-03 用户裁决） | 见下方评估结论与 §7.8 |

**T26 评估结论（2026-10-02）**：完整回滚语义暂不立项。理由：(1) dsc 的 write/edit 已带回合前全文基线（0.6.24 的 fileChanges pre-image），但只覆盖第一方工具——bash/sed 改的文件只有 git 状态码差集没有 pre-image，「回滚到回合前」在混合改动场景语义残缺；(2) 「回滚保手改」（hermes writer-ledger 的核心价值）需要 per-hunk 三方合并（基线 × 当前 × 手改），个人版没有这层算力与数据模型基建；(3) 有 git 的工作区，用户撤模型改动走 git checkout/恢复面板已是顺路动作，专属回滚 UI 的频次撑不起维护成本；(4) 部分行接受（codex apply_patch 语义）把 diff 审查面板从只读改成双向数据流，动审批模型与转录契约，与 checkpoint/rewind 同族的全部风险都要背。**2026-10-03 用户裁决：立项（T51），走 hermes shadow git 方向（checkpoint writer-ledger），不做反向 patch；动工前先补 per-hunk 三方合并的设计轮。**

### 7.8 立项登记（2026-10-03，0.6.37 起；全部「已立项待排期」）

用户裁决把下列已披露的降级边界与 §7.3 P3 项正式立项。编号接 §7.5（T29–T47 已被深度复核占用）。每项动工前仍需一轮设计探索（对标、落点、验收），表里给的是立项时的范围锚点。

| 项 | 范围锚点 | 主要前置 |
| --- | --- | --- |
| T48 T20 完整版：PTY + 中途打断 | node-pty 换掉管道 shell（全屏程序可跑）；signal 动作恢复（Ctrl+C 真中断）；prepare-runtime 依赖闭包带 node-pty 原生二进制 | Mimosa 门预研：spawn/kill 原语的判定边界（T20 降级时被拦 5 次的教训），signal 通路先设计再动内核 |
| T49 T28 升级：npm 包形态插件远程安装 | registry tarball 拉取（npm 源 + 自定义 registry）、依赖解析、完整性校验（integrity/shasum）、审批卡带包名与版本；装后热挂载同现有路径 | tarball 解包安全（路径穿越/任意代码已由 risk=write 审批覆盖）；market.ts 加第三类源 |
| T50 T14 边界修正：@ 补全多工作区/异根 | 遍历范围从「dock 根目录」改为「当前会话 cwd + 工作区集合」；候选路径显示与 insertMention 用同一套归一化；跨盘/异根场景路径不再错位 | mention-complete.ts 的 collectWorkspaceFiles 改多根遍历；@ 候选命中率的探针补多根用例 |
| T51 T26 完整回滚 / 部分行接受 | hermes shadow git 方向：checkpoint writer-ledger 记回合前快照（含 bash/sed 触碰的文件），「回滚到回合前」「保手改」先做前者；部分行接受（apply_patch 语义）二期 | per-hunk 三方合并基建设计轮；§7.7 评估结论的四条顾虑逐条在设计轮里给答案 |
| T52 checkpoint / rewind（§7.3 升出） | codex Esc-Esc 回退重编辑、hermes shadow git；与 T51 同族，设计轮合并做 | 同 T51 |
| T53 对外 SDK / 协议面（§7.3 升出） | dsh SDK（TS+Python）、codex app-server v2 对标；host-stdio 协议 v2 稳定化 + 客户端库 | 有真实集成方需求时排期优先级才升 |
| T54 SSH 远程执行（§7.3 升出） | dsh `packages/ssh/*` 对标：远程宿主跑命令与会话；手机遥控场景的延伸 | 安全面（远程执行授权模型）先于实现 |
| ~~V1 实机走查欠账~~（已回销 2026-10-03，0.6.38） | ✅ 不等 deepseek 限流：本地假 OpenAI 兼容端点（按请求形状应答工具调用/收尾/标题）驱动真 UI 全链走查——状态点 working→awaiting-approval→消失、T16 自动标题上侧栏、/export 提示与落盘全部实见（desktop/shots/v1-walkthrough.ps1，gitignored）。走查揪出并修掉两个真 bug：新会话提交后侧栏列表不刷新（App.tsx）、autoTitle 写入后列表缓存不刷（session-title 插件） | 权限档要点：readonly 档不弹卡直接拒、auto-edit 档工作区外写也要带 sandbox_permissions 升权请求才转审批卡（沙箱先于审批拦） |

§7.3 中被升出的三行（checkpoint/rewind、对外 SDK、SSH 远程执行）保留原文并在行内标注「已升出（T52/T53/T54）」；其余 P3 行维持「登记免遗忘」不变。

---

## 附录 A：三家特色速查（→ 移植到 dsc 的难度）

**codex（安全与架构最硬）**
- 三平台 OS 沙箱 `sandboxing`（bwrap / landlock / seatbelt / Windows 受限令牌）+ 一次性升级审批（降级不 fail-closed，与 dsc T9 同姿势）→ 高（动内核）
- 声明式执行策略 `execpolicy`（命令前缀 → allow / prompt / forbidden）→ 低（挂 guards）
- **独立 review 子代理**（uncommitted/base/commit/自定义四范围 + 结构化 findings[title/body/confidence/priority/行级定位] + `codex exec review` 非交互）→ 中（T18）
- **exec_command 统一 exec**（PTY + session 续写 + 交互 stdin）→ 中（T15/T20 的对标）
- **backtrack**（Esc-Esc 回退到任意 prompt 重编辑）→ 中高（要 turn 级重放语义）
- **/mention @ 文件提及**（`file-search` crate 弹窗）→ 低（T14）
- **request_permissions 运行时申请**（文件路径 + 网络，session scope）→ 低-中（dsc 已有 sandbox_permissions 一次性升权，差 session 级授权）
- **Guardian 自动审查**（隔离审查者复核审批决策，专用模型）→ 中（dsc 的 ai-review 档是简化版）
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
