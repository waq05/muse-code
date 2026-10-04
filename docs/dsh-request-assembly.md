# dsh 请求组装拆解（参考实现笔记）

「dsh 每轮对话给模型组装什么、怎么规范」的源码级拆解。2026-10-03 从本机 `D:\deepseek-harness\deepseek-harness` **逐包只读梳理**得出，快照 **HEAD `4878cdabd8`**（最后提交 2026-09-28）——dsh 仓库会继续演进，**行号是当日快照**；引用一律「包路径:行号」，拿不准时回源核对。用途：以后要再对齐 dsh，先读这里，不必重新探索。

| 想知道 | 去看 |
| --- | --- |
| dsh 插件怎么挂进 dsc（适配指南） | [dsh-plugin-porting.md](dsh-plugin-porting.md) |
| **本文档** | **dsh 的请求组装与上下文管理（源码级）** |
| codex 的同类拆解 | [codex-request-assembly.md](codex-request-assembly.md) |
| 三家功能面全景 | [peer-feature-inventory.md](peer-feature-inventory.md) |

**一句话架构**：没有独立 prompt 模板目录。system prompt 是按序 section 的注册表（`packages/core/system-prompt`），每个 step 在 pre-step 现场 assemble + render；请求本身每回合由 `session.deriveMessages()` 从会话日志重新派生（`packages/core/agent-loop/src/agent.ts:671`），运行时 invariant 校验「模型看到的 == 日志可重建」。

两份机制总纲（想快速回源先读它们）：`docs/architecture.md:113`（pre-step → 组装 → 提交 system/user 消息 → 构建请求的完整时序）、`.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md`（reconstructability 原则、EpochHeader 设计、"Prefix-cache stability is corollary #1"）。

---

## 1. 系统提示词的组装与投递

### 注册表与渲染
- `PromptSection = { name, order, text: string | (ctx) => string, interpolate?, complete? }`：`packages/core/system-prompt/src/index.ts:53-76`；order 升序拼接、同 order 按 name 的 code-unit 排序（:236-239）。
- 集中分配位置号：`:125-159`（`HARNESS_IDENTITY: -1000`、`DEPLOYMENT_PERSONA_PREFIX: 0`、`PLAN_POLICY: 500`、`TOOL_BASH: 1000`、…、`HARNESS_SOURCE: 10000`、`WEB_SURFACE: 10100`、`DEPLOYMENT_PERSONA_SUFFIX: 10200`）。
- 拼装 `assemble()`：`:558-635` —— global/scoped 两层（scoped 盖 global）、收集工具 schema、跑 `system-prompt/assemble` waterfall、最后若有 `complete: true` 的段则把 prompt 恢复成仅它一条（:629-634）。
- 渲染 `renderPrompt()`：`:279-284` —— 按序 `interpolate` + 过滤空段 + `'\n\n'` 连接；`{{var}}` 是**严格插值**，未注册/无值直接抛错（:325-362）。

### 文本从哪来（无 .md/.hbs 模板，全在代码/YAML）
- 固定身份：`:426-431` `'You are an AI agent powered by DeepSeek Harness.'`（`includeHarnessIdentity` 默认 true）。
- 部署 persona 前缀/后缀来自配置，默认空串；web 组合见 `packages/bundle/web-app/cordis.patch.yml:17-20`（`personaSuffix: Your working directory is {{cwd}}.` / `personaPrefix: You are a coding agent powered by the {{model}} model.`）；预设版 `packages/bundle/web-app/presets/standard.patch.yml:11-18` + `packages/preset/persona/src/index.ts:62-75`。
- 每个工具自带 guidance 段（30+ 处 `getSectionOrder(...)`）：如 `packages/fs/tool-fs/src/read.ts:69-74`、`packages/shell/tool-bash/src/index.ts:256-260`、`packages/plan/plan-mode/src/index.ts:219`、`packages/mcp/mcp-client/src/server-context.ts:35`。

### 按模型分的是「投递方式」不是文本
- `packages/llm/llm-deepseek/src/models.ts:8-20`：`deepseek-flash` 声明 `systemPromptUpdate: 'in-history'` 与 `toolUpdate: 'addition-only'`；`deepseek-v4-pro` 不声明（走「合并到 node 0」）。
- 另一家 provider 完全不同：`packages/llm/llm-pi-ai/src/context.ts:158-164` `splitSystemPrompt()` 把首条 system 折进 pi-ai 单一 `systemPrompt` 槽；后续 system 降级为 user 消息（:196-201）。

## 2. 环境与运行时上下文（变化才注入）

- **cwd**：prompt 变量，值来自 session header（`packages/core/agent-loop/src/index.ts:370-372` 注册 `cwd/provider/model`；每次 assemble 求值 :563-573）。不是消息。
- **时间**：独立插件 `packages/context/time-context/src/index.ts`，作为 **user 角色快照消息**注入（:112-115，文案 `Time sampled while preparing turn N, step M: ...`）；默认 `refreshIntervalMs = 600_000`（:134），没到间隔不重注（:193-198）；注入时点持久化在 `timeContext` projection（:157-183）。
- **运行时动态上下文**（沙箱策略 / 审批策略 / 子代理委托）：`PromptContext`（"Dynamic model context materialized as a durable user-role snapshot"，`packages/core/system-prompt/src/index.ts:78-86`），三个注册点：`packages/sandbox/sandbox-policy/src/index.ts:142-144`（SANDBOX_POLICY=110）、`packages/interaction/user-approval/src/index.ts:161-165`（APPROVAL_POLICY=115）、`packages/subagent/subagent/src/child-agent.ts:206-211`（SUBAGENT_DELEGATION=120）。
  - 渲染头固定句：`'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'`（`system-prompt/src/index.ts:291-307/306`）。
  - **变化才注入**：`packages/core/agent-loop/src/runtime-context.ts:152-163` `if (this.retained?.text === snapshot) return`；快照清除时发 `'Current runtime context: none. ...'`（:20）。
- **OS/平台、git 状态**：**没有找到**。全仓没有把 `process.platform` / git branch / status 注入 prompt 的路径；`packages/shell/shell-env/README.md:121` 明确 managed environment never enters the request prefix（`DSH_*` 只进 shell 环境，不进 prompt）。

## 3. 用户指令（AGENTS.md）

包：`packages/context/agent-instructions`。

- **候选与上限**（`src/config.ts:11-14`）：`DEFAULT_PROJECT_ROOT_MARKERS = ['.git']`、`DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md','CLAUDE.md']`、`DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.local.md','CLAUDE.local.md']`、`DEFAULT_MAX_SOURCE_BYTES = 1_048_576`（单文件超限整文件丢弃，`files.ts:344`）。渲染总预算 `maxBytes` 默认 **65536**（`packages/bundle/base/cordis.patch.yml:289-292`、`presets/standard.patch.yml:19-21`）。
- **发现**：先 `$DSH_HOME/AGENTS.md`（用户全局，`src/files.ts:285-301`），再从 project root → cwd 的祖先链逐目录找，顺序「宽泛 → 具体」（`files.ts:303-312`；`ancestorChain()` :204-217；project root 由 `.git` 等 marker 向上探测 `findProjectRoot()` :181-196）。
- **合并与去重**：路径级去重（`files.ts:279-283`）；**同目录内**按 trim 后内容摘要折叠重复（最早候选保留，:375-391；注释：Different directories never collapse even when identical）。
- **超预算**：从最宽泛的开始丢（保最具体），最后对最具体文件做二分截断，并附预算标记 `Workspace instruction budget ${maxBytes} bytes: omitted ...; truncated ...`（`render.ts:215-225/275-332`）。
- **注入形态**：**user 消息**，在 `agent/pre-step` 折进 claimed batch 之后（`src/index.ts:315-341`，`toSpliced(lastClaimedIndex + 1, 0, desired)`）；`<system-reminder>` 包裹（`render.ts:242`），首行引导语 `'The following workspace instructions may be relevant to your work. ... More specific instructions take precedence over broader ones.'`（`render.ts:12-14`），每文件一段 `Instructions from: ${displayPath}`（:86）。
- **跨回合不重复发**：baseline identity 相同就不发新 baseline（`index.ts:130-138`）；文件被工具触碰后走差量 reconcile（`index.ts:343-359`，`set/replace/remove` 文案 `render.ts:171-184`）；pending 里按内容深比较去重（`syncInbox()` :227-252）。
- 已知 TODO：聚合读取预算尚未强制（`files.ts:340-342`）。

## 4. 工具目录与变更通告

- **schema 生成**：`defineTool` DSL（`packages/core/tools/src/schema.ts:13-70`）→ `schemaOf()`（`index.ts:1281-1295`，`snapshotJsonValue` 深拷贝）。执行期字段（timeoutMs、isConcurrencySafe、presenter）**永不发给模型**（`index.ts:262-266`）。
- **顺序**：默认按 name 字典序（code-unit，`packages/core/system-prompt/src/index.ts:215-244`）；`Config.toolOrder` 可写死模型可见顺序，未列的插到 `<unlisted-tools>` 占位处（:191-208）。
- **变更才通告**：`toolsChanged()` 与 `session.requestHeader()` 基线比较（`agent.ts:288-293`）；只在增/删时追加 developer 消息（`tool-addition` / `tool-removal`，`agent.ts:635-649`）；历史由 `ToolHistoryProjection` 折叠（`packages/core/session/src/tool-history.ts:8-74`）；header 规范化比较 `canonicalHeader()` / `headerEquals()`（`packages/core/session/src/request-header.ts:21-52`）。

## 5. 「模型可见 ⟺ 已记录」怎么被强制

- 原则原文：`AGENTS.md:136`（"anything that reaches a model request must be reconstructable from the session log"）、`docs/architecture.md:127`。
- **运行时 invariant（真正的强制点）**：`packages/core/agent-loop/src/invariant.ts:20-56`，注册在 `llm/stream` waterfall：请求 options 必须冻结；`options.system === undefined`（system prompt 走消息 node 0，**不走 system 字段**）；`options.messages` 与 `session.deriveMessages()` 的 JSON 逐字节相等，不符即 fail。
- **日志 → 消息的唯一投影通道**：`packages/core/session/src/index.ts:860-889` `deriveMessages()`（surface 是唯一来源）；逐事件投影 `packages/core/session/src/surface.ts:110-175`（注释：Do NOT re-add per-type framing here: framing is caller-owned）；插件要投影必须先 `registerMessageProjection()`（`index.ts:942`），未注册的事件类型直接抛错（`surface.ts:527-533`）。
- 一次性辅助调用也要记账：compaction 摘要调用把 envelope 记成 `compaction/summary` 事件 + `llmStreamCall: true`（`compaction/src/types.ts:34`、`compaction-basic/src/region.ts:495-505`）。

## 6. 发请求前的规范化（四层）

1. **日志写入层**：孤儿 / 重复 tool 结果 append 即拒（`packages/core/session/src/invariant.ts:141-147`）；tool/result 的 surface 替换只许改 content（`surface.ts:462-491`）；system head 保护（:493-513）。
2. **循环层**：失败/中断 step 补 tool/result（`agent.ts:331-353`；恢复器 `packages/core/session/src/repair.ts:105-198` 按 assistant 顺序生成 isError 结果）；取消的调用写合成错误结果 `'Error: tool call aborted before dispatch'`（`tool-calls.ts:96-99/249-260`）；冷启动补 `interruptedTurnClosers`（`agent-loop/src/index.ts:852-856`）。
3. **LLM runtime 投影层**（按路由能力降级）：无 vision 的模型图片转文本；无 `toolUpdate` 能力的路由剥掉全部 developer 消息与 `deferLoading`（`packages/llm/llm/src/content.ts:424-492`）。
4. **wire 层**（DeepSeek 为例，`packages/llm/llm-deepseek/src/serialize.ts`）：相邻同 role 合并（:125-127）；空 user 跳过（:123）；tool_result 前置（:142）；**重复 call id 直接抛错** `'DeepSeek Messages duplicate tool call id'`（:135）；孤儿结果 / 未闭合调用 / 结尾未决调用分别抛错（:139/141/145）；system update 必须前面有 user/tool-result 轮次（:84-88）。pi-ai 路由则直接拒绝 developer 消息等（`llm-pi-ai/src/context.ts:50-64`）。

## 7. 压缩（compaction）

- **触发**：pre-step 压力检查（`packages/compaction/compaction-basic/src/index.ts:158-176`）；provider 报上下文溢出后压缩并 `{kind:'retry'}`（:190-234，`maxOverflowRetries` 默认 1）；`/compact`（`command-compact/src/index.ts:67`，仅 idle agent）。阈值 `thresholdRatio 0.8` / `retainRatio 0.16` / `headroomTokens 65536`（`config.ts:20-23/75`）。
- **区域选择**：`region.ts:117-155` —— 永远保留 surface node 0（system prompt）；保留 priced 尾部 `retainTokens`；**绝不切开 tool-call/result 对**（`tool-pairing.ts:104-126`）。溢出路径跳过保留尾部。
- **摘要调用（核心缓存设计）**：`summarizer.ts:26-31` 注释原文大意——压缩指令作为**最后一条 user 消息**接在被重放的对话之后，**不发独立 system**，保持对话自己的 system prompt/工具/消息前缀在前，使辅助调用成为上次路由请求的真前缀，复用 provider KV 缓存。人设句 `'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint ...'`（:32-33）；固定小标题 8 段：Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context（:37-59）；规则段 :61-66（保留精确路径/命令/错误串；`Do NOT mention this summarization request...`）。调用带 `tools`/`toolHistory`、`purpose:'compaction'`（:145-163）。
- **落地**：`frameSummary()` 包 `<compacted-summary>`（:188-194），前置语 :70-71；替换写 `surfaceOp:{op:'replace',startSeq,endSeq}` + `sourceEventSeqs`（`region.ts:506-509`）；摘要若不小于被遮蔽内容的 route 价格则报错放弃（:415-424）；重放前缀构造 `buildSummarizationInput()`（:534-560，system head + header.tools + 被遮蔽节点消息）。
- 工具结果瘦身 / 图片回收是独立可选包（`compaction-tool-result-pruner`、`compaction-image-offload`）。

## 8. 前缀缓存友好设计

- 请求头基线 + 「变化才记」：只有内容变了才 append `reason:'change'`（`agent.ts:609-634`）；比较函数 `request-header.ts:21-52`。
- **system prompt 投递策略**：DeepSeek 系声明 `systemPromptUpdate:'in-history'` → 序列化时非首条 system 作为**追加的 system update**（`serialize.ts:63/109-114`），前缀字节不变；不支持的模型折进顶层 `system` 字段（:150）。agent-loop README:164 原文：「A prompt change that replaces a system node in place makes the request differ from that node's first token ... when the prepared call declares `systemPromptUpdate: 'in-history'`, a non-empty prompt change inside a continuing request series is appended after the cached history, so the prefix through that history stays reusable.」
- 工具侧 `toolUpdate:'addition-only'` + `deferLoading`（"an added tool follows the cached history instead of rewriting the declaration list"，`llm/src/types.ts:397-407/475-479`）。
- 时间戳位置：不进 system prompt，独立 user 快照 + 10 分钟刷新下限（见 §2）。
- 观测：usage 的 `cacheReadTokens/cacheWriteTokens`（`llm/src/types.ts:186-187`）；DeepSeek 映射 `prompt_cache_hit_tokens`（`llm-deepseek/src/translate.ts:36`）；e2e 断言「第二轮起命中 > 0」（`packages/core/agent-loop/tests/request-cache.e2e.ts:73-105`）。
- **无显式 cache key**（跟 codex 不同）：命中靠「请求字节前缀 + 路由不变」自然获得。

## 9. 与 Muse Code 的对照（0.6.46 实测）

- **抄了的**：环境/时间快照「变化才注入 + user 角色」→ dsc 的 env-facts 投影（每次请求附当前值，变了才写状态留痕）；压缩调用复用主对话前缀 → dsc 的 `compactSession(…, context)`；瞬态注入不改写头部（dsc 的 LSP 诊断/钩子产出改 user 角色）；「模型可见⟺logged」双轨达成（dsh 运行时不变量强校验 / dsc 命名投影链 + appendNote + 状态条目留痕）。
- **没抄的**：`systemPromptUpdate:'in-history'`（要 mid-history system 消息，dsc 的 fold-system 为兼容网关只认头部 system；dsc 用「易变段搬出提示词」达到同类缓存效果）；`toolUpdate` addition-only 与 request header 系列（多 provider 长驻场景，dsc 单路由 + DeepSeek 自动缓存，收益≈0）；scoped/global 两层提示词。
- **dsh 领先、dsc 仍缺的**：请求装配的**运行时强校验**（dsc 只有设计约定与探针）；工具变更的增量通告；会话层「孤儿写入即拒」（dsc 是重放/请求侧兜底，见 development-log 阶段 67）。
- **0.6.47 补上的**：dsh inbox 的最小版——轮中途到达的输入（插话/作业通知/定时补投）先入 `async-inbox` 状态条目排队，步骤边界/回合收尾才落库（对应 dsh 的 next-step claim + 「回合不许隔着收件箱收尾」）；请求侧 sanitize 加邻接重排兜底存量脏日志（对位 dsh serialize 校验的位置）。起因：作业完成通知在「调用等审批」期间落库，插进 tool_calls 与结果中间，网关 400 卡死会话（development-log 阶段 68）。
