# codex 请求组装拆解（参考实现笔记）

「codex（OpenAI Codex CLI，`codex-rs`）每轮对话给模型组装什么、怎么规范」的源码级拆解。2026-10-03 从本机 `D:\codex\codex` **只读梳理**得出，快照 **HEAD `1cc7e23612`**——仓库会继续演进，**行号是当日快照**；引用一律「文件:行号」（相对 `codex-rs/`）。用途：以后要对齐 codex，先读这里，不必重新探索。

| 想知道 | 去看 |
| --- | --- |
| dsh 的同类拆解 | [dsh-request-assembly.md](dsh-request-assembly.md) |
| **本文档** | **codex 的请求组装与上下文管理（源码级）** |
| 三家功能面全景 | [peer-feature-inventory.md](peer-feature-inventory.md) |

**请求流水线（一句话）**：`run_turn`（`core/src/session/turn.rs:1610-1645`）→ `get_prompt_base_instructions()` → `clone_history().for_prompt()`（补孤儿 call / 删孤儿 output / 剥多模态）→ `executed_tool_calls.attach_to_prompt` → `build_prompt`（tools = `tool_router.model_visible_specs()`）→ `client.build_responses_request`（instructions、tools、reasoning、`prompt_cache_key`）→ WebSocket 前缀匹配时只发增量 + `previous_response_id`。

**核心设计**：上下文类内容（AGENTS.md、environment_context、permissions）**不每轮重发**——`Session::record_context_updates_and_set_reference_context_item` + `WorldState::render_history_diff` 按快照 diff，只注入变化的那部分（`core/src/session/mod.rs:4672-4750`、`core/src/context_manager/history.rs:446-463`）。

---

## 1. base instructions / system prompt

- **没有 ModelFamily 选择逻辑**（该结构已删）。改由每个模型 slug 的 catalog 字段 `model_messages.instructions_template` 提供，缺失时回落打包的 `models-manager/prompt.md`：
  - `models-manager/src/model_info.rs:16` `pub const BASE_INSTRUCTIONS: &str = include_str!("../prompt.md");`；未知模型走 `model_info_from_slug()`（:99-157），`local_model_messages()`（:152-157）把 BASE_INSTRUCTIONS 塞进 `instructions_template`。
  - 模板按 slug 内联在 `models-manager/models.json`（每个模型一段完整字面文本，约 21KB，各不相同——「按模型区分」实际靠 catalog 数据）。渲染入口 `prompts/src/model_instructions.rs:8-17`；`ResolvedModelMessages::instructions_template()` 在 `prompts/src/model_messages.rs:84-87`。
- **会话启动优先级**（`core/src/session/mod.rs:708-743`）：① config.base_instructions（`model_instructions_file` / `instructions` 配置，`core/src/config/mod.rs:3981-3996`，provenance=Custom）> ② 会话历史里的 > ③ 当前模型的模板。`update_plan_enabled == false` 且 provenance=Model 时剥掉 update_plan 章节（`prompts/src/update_plan_instructions.rs:4-30`）。
- **投递**：`build_prompt`（`turn.rs:1563-1580`）；普通模型直接进 Responses API 的 `instructions` 字段（`core/src/client.rs:934-938`；序列化定义 `codex-api/src/common.rs:279-283`）；**Responses-Lite** 下变成输入流前缀项——`BaseInstructionsFragment`（role=`developer`，裸文本无 marker，`core/src/context/base_instructions.rs:5-31`），ID 用 thread 派生的 Uuid v5 保证重试/恢复前缀稳定（`client.rs:902-933`）。
- 与用户指令**不拼接**：分属 developer 片段与 user 消息，按 `fragment.role()` 分流（`session/mod.rs:4446-4509`）。
- ⚠️ `core/` 根目录的 `gpt_5_codex_prompt.md`、`gpt_5_1_prompt.md` 等文件在 Rust 代码里**没有任何引用**（全仓 grep `include_str!` 无命中）——遗留文件，别照着它们对齐。

## 2. 用户指令（AGENTS.md）

主实现 `core/src/agents_md.rs` 与 `core/src/agents_md_manager.rs`。

- **文件名与顺序**（`agents_md.rs:42-45/272-296`）：`AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames`（去重）。
- **发现**：cwd 向上用 `project_root_markers`（默认 `.git`）找项目根（:207-240），然后把 root→cwd 整条链反转逐目录收集、每目录命中一个候选即停（:244-268，并发 256）。注释即语义（:10-18）："Determine the project root by walking upwards... Collect every AGENTS.md found from the project root down to the current working directory (inclusive) and concatenate... We do **not** walk past the project root."。找不到 marker 只看 cwd（:238-240）。
- **合并格式**（`agents_md.rs:47-49`）：`const AGENTS_MD_SEPARATOR: &str = "\n\n--- project-doc ---\n\n";`；user/internal 与 project 的边界插它（`legacy_text()` :386-419）；多环境加环境标签（`environment_labeled_text()` :421-471）。
- **大小上限**：项目文档默认 **32KiB**（`config/src/config_toml.rs:74-82`，`core/src/config/mod.rs:253/4331`）；逐文件消耗剩余额度、超出即 `data.truncate(remaining)`（`agents_md.rs:145-179`）。host 提供的 thread 指令另有 **10k token 硬限**（拒绝而非截断，`agents_md_manager.rs:165-178`）。
- **注入形态**：**user 角色**，markers `("# AGENTS.md instructions", "</INSTRUCTIONS>")`（`core/src/context/user_instructions.rs:19-34`，正文首行是目录）。
- **不每条消息注入**：AGENTS.md 是 WorldState 的一个 section（`core/src/context/world_state/agents_md.rs:34-79`）；首次（reference context 为空）全量渲染（`world_state/mod.rs:398-400`），之后只在变化时注入并带提示（`agents_md.rs:9-11`）：`"These AGENTS.md instructions replace all previously provided AGENTS.md instructions."` / `"The previously provided AGENTS.md instructions no longer apply."`；diff 判定 = 快照相等返回 `None`（:52-59）。
- 去重：快照相等不重发；候选文件名去重；`AgentsMdManager::refresh` 里 user/thread 指令未变复用缓存（`agents_md_manager.rs:115-122`）。**没有**「同一段文本出现两次删一份」的规则。

## 3. environment_context 与 permissions（WorldState 快照 diff）

- **cwd / shell / 日期 / 时区 / 网络 / 文件系统**：**user 角色** `<environment_context>` 消息。
  - 定义与 diff：`core/src/context/world_state/environment.rs:104-195`（`render_diff` 只对变化的 environment 生成 `EnvironmentUpdate::Current`，消失的生成 `Unavailable`，无变化返回 `None`；:178-195）。
  - role 与标记：:198-217（markers `"<environment_context>"` / `"</environment_context>"`，`protocol/src/protocol.rs:120-121`）。
  - 渲染体：:256-322（`<cwd>/<shell>/<status>/<current_date>/<timezone>/<network enabled="true">.../<filesystem>/<subagents>`）；单环境保持 legacy 扁平格式（:174-177）。
  - 片段细节：`core/src/context/environment_context.rs:59-71`（`<workspace_roots>`）、:226-243（`<network><allowed>...`）、:199-210（XML 转义）；错误信息 256/512 字节预算（`environment.rs:490-511`）；subagents 8 个 / 1KiB 上限（`session/world_state.rs:35-36`）。
- **审批策略 / 沙箱模式**：**developer 角色** `<permissions instructions>`（`prompts/src/permissions_instructions.rs:258-278`；ID `"permissions"`，`world_state/permissions.rs:75`）；沙箱文案按 `SandboxMode::{DangerFullAccess,WorkspaceWrite,ReadOnly}` 选模板（:347-364）、审批文案按 `AskForApproval::{OnRequest,Never,UnlessTrusted,Granular}` 选（:287-345）。
  - diff 细节：指令 hash 未变且已批准前缀是旧集合超集时只发 `ApprovedCommandPrefixSaved`；都没变返回 `None`；否则重发完整说明（`permissions.rs:94-130`）。
- **全量 vs diff 的开关**：首次（`reference_context_item.is_none()`）走 `build_initial_context_with_world_state` 全量 + 记基线；之后 `state.history.update_world_state(world_state)` 只记非空 items（`session/mod.rs:4672-4750`）。diff 本体 = RFC 7386 merge patch（`context_manager/history.rs:446-463`、`world_state/mod.rs:312-346`）；persisted snapshot 丢失时有回退匹配（`world_state/mod.rs:414-435`）。
- 稳定性标记：每个 section 有稳定 ID 与 SHA1 指纹（CRLF 归一化）——`world_state/mod.rs:219-225/262-281`（注释 "`ID` is persisted in rollouts and must remain stable"）。
- 开关默认都是 true（`core/src/config/mod.rs:3998/4011`）。

## 4. 历史规范化（for_prompt）

- 入口：`core/src/context_manager/history.rs:578-595`（`for_prompt(input_modalities)`）。规则注释 :929-932 三条：① 每个 call（function/custom）有对应 output；② 每个 output 有对应 call；③ 不支持的多模态剥掉。
- 执行：
  - **孤儿 call → 合成 "aborted" 输出**（插在 call 之后）：`normalize.rs:21-138`（四类 call：FunctionCall/ToolSearchCall/CustomToolCall/LocalShellCall；function 输出文本 `"aborted"`，:64；`items.insert(idx + 1, output_item)` :134-137）。
  - **孤儿 output → 删除**：`normalize.rs:155-225`（含 ToolSearchOutput 的 `execution != "server"` 特判）。
  - 不支持的多模态 → 替换为提示文本（:330-420，固定 namespace）。
  - **重复 tool 结果：没有找到去重逻辑**（`ensure_call_outputs_present` 只判存在性，两个相同 call_id 的输出都会留下；`remove_orphan_outputs` 只处理无 call 的）。仅 Code Mode 元数据侧对 `output_counts.get(call_id) != Some(&1)` 判「不可信」，不删消息（`tools/executed_tool_calls/request_metadata.rs:242/361/459`）。
- **请求级**（`client.rs`）：图片 detail 归一化（`client_common.rs:59-117`）；`ConfigurationUpdate` 在不支持时只从请求副本过滤（:895-900）；非 OpenAI provider 清 encrypted args（:940-951）；`include_internal == false` 清 metadata（:983-987）；ID/content-kind 清理（:1010-1019）。
- **角色顺序**：没有通用交替/重排逻辑。构造期固定顺序 = developer bundle → 独立 developer 片段 → multi-agent mode → user 上下文 → guardian → managed developer（`session/mod.rs:4444-4529`）；`is_api_message` 丢弃裸 system / 未标注 ConfigurationUpdate / CompactionTrigger / Other（`history.rs:997-1021`）。

## 5. 压缩（compaction）

- **触发**：mid-turn（`turn.rs:599-645`）、pre-turn（:1277-1307）、post-turn 阈值（:709-738，配置开才用）、模型切换 comp_hash 变化 / ModelDownshift（:1309-1444）、手动 `/compact`（`compact.rs:141-158`）。阈值 = 解析窗口的 **90%**（`protocol/src/openai_models.rs:525-536`）；硬上限 = `context_window * effective_context_window_percent / 100`（`context_window.rs:84-86`）。另有 TokenBudget 分支：不总结、直接开新窗口（`compact_token_budget.rs:43-84`）。
- **摘要构造**：SUMMARIZATION_PROMPT（`prompts/templates/compact/prompt.md`："You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM... Include: - Current progress and key decisions made - Important context... - What remains to be done - Any critical data, examples, or references..."）作为 **user 文本追加到现有历史之后**整体发给模型（`compact.rs:116-126/255-293`；可用 `config.compact_prompt` 覆盖）。
- **落地**：摘要文本 = 固定前缀 + 模型输出（`compact.rs:343-356`；前缀 `prompts/templates/compact/summary_prefix.md`："Another language model started to solve this problem and produced a summary of its thinking process..."）；替换历史 `build_compacted_history`（:649-740；从最新往回保留用户消息文本，`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` :55；摘要以 `CompactionSummary` 片段（role=user，无 marker，`core/src/context/compaction_summary.rs:17-37`）追加在末尾）。
- **缓存保护**：重试超窗时 `history.remove_first_item()` + 注释 "Trim from the beginning to preserve cache (prefix-based) and keep recent messages intact."（:310-320）；压缩后初始上下文回插位置规则（优先插到最后一条真实 user/agent 消息之前，:581-647）。
- 远程 v2：`compact_remote_v2.rs`（保留客户端 developer 消息，`RETAINED_MESSAGE_TOKEN_BUDGET = 64_000` :75）。

## 6. 前缀缓存与稳定 ID

- **cache key**：`prompt_cache_key`（`client.rs:575-587`，写入请求 :976；字段 `codex-api/src/common.rs:296-297`）。fork 复用父会话 key（`session/session.rs:879-893`）；guardian 用 `guardian:{parent_thread_id}`（`guardian/review_session.rs:272-284`）。
- **稳定的合成 ID**：`normalize.rs:18-19` 注释 "Changing this value would change model-visible IDs and invalidate prompt caches."；:140-153 "the namespace and name format must remain stable across retries and resumes to preserve prompt-cache reuse"。
- **WebSocket 增量**：只在非 input 字段完全一致、且 input 是上一请求的严格前缀扩展时复用（`client.rs:1380-1417`；比较函数 `:337-392`，比 model/instructions/tools/prompt_cache_key/text 等），可只发 delta + `previous_response_id`。
- 未变化的 WorldState section 不重发（diff 机制本身就是缓存稳定性设计）；历史裁剪从头部删（保最大共同前缀）。

## 7. 工具规格与排序

- 每步生成一次 `Arc<[ToolSpec]>`：`step_context.tool_router.model_visible_specs()`（`session/turn.rs:1571`；定义 `core/src/tools/router.rs:76/137-139`）。
- 构造链：`core/src/tools/spec_plan.rs:349-518` `finalize_tool_router` → :553-591 `build_model_visible_specs`（registry entries 逐个 `spec_for_model_request`，再 `specs.extend(hosted_specs)`，过 `merge_into_namespaces`）。
- **顺序**：注册表是**插入序** IndexMap（`tools/registry.rs:294-299`；`entries()` 按插入序 :429-431；重复注册报错 :348-357）；核心工具是固定代码序列（`spec_plan.rs:1015+`：exec_command/write_stdin → list_mcp_resources… → plan → …）；**namespace 内按名字排序**（:942-991）；顶层 function 列表**没有**整体排序。
- 序列化保留顺序（`tools/src/tool_spec.rs:82-93/145-149`）；Responses-Lite 把默认命名空间的函数合并进一个 `namespace`，插入位置用 `functions_index` 固定（:95-142）。扩展/MCP 工具在 core 之后注册（`spec_plan.rs:302-327`）。

## 8. 与 Muse Code 的对照（0.6.46 实测）

- **抄了的**：AGENTS.md 的发现链（root→cwd、override 优先、上限截断）与「变化才注入」的思路（dsc 每轮随 system prompt 重发，字节稳定时同样命中缓存）；压缩摘要接在真实对话之后（dsc 的 `compactSession(…, context)` 前缀复用）；环境/易变信息不进稳定前缀（dsc 的 env-facts 快照）。
- **没抄的**：per-model 21KB 模板（dsc 单身份段 + 「当前模型」行）；Responses API 的 `instructions` 字段与 Responses-Lite 前缀（OpenAI 自家 API 特性，兼容网关不通用）；namespace 排序（dsc 工具集小且注册序稳定）。
- **codex 没有、dsc 补了的**：重复 tool 结果去重（codex 的 normalize 只处理孤儿）；压缩的机械锚点 / 用户原话逐字引用 / 找回指针（codex 摘要纯模型生成，SHA/报错原文可能丢）。
- **codex 领先、dsc 仍缺的**：WorldState 的逐 section hash + 差分注入与回退匹配（dsc 只有 env 一处做变化注入）；`prompt_cache_key` 与 WebSocket 级增量复用（dsc 靠服务端自动前缀缓存）；压缩后初始上下文的回插位置规则（dsc 是摘要 + 保留尾部，无回插）。
