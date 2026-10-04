# dsc 开发手册

面向**要改这份代码的人**（包括下次坐到位子上的 AI 助手）。讲清楚代码怎么分层、一个新功能
该落在哪一层、改完怎么验证、出问题去哪看。

| 想知道 | 去看 |
| --- | --- |
| 怎么装、怎么跑、怎么配模型 | [README.md](../README.md) |
| **代码怎么分层、往哪改、怎么验证** | **本文档** |
| **界面怎么改、控件往哪加、颜色字号怎么取值** | [ui-design.md](ui-design.md) |
| 为什么长成这样、踩过哪些坑 | [development-log.md](development-log.md) |
| 记什么：对照 codex / hermes / dsh 还缺哪些能力 | [harness-benchmark-roadmap.md](harness-benchmark-roadmap.md) |
| 三家对标产品的功能清单全文（差距的证据底料） | [peer-feature-inventory.md](peer-feature-inventory.md) |
| 怎么写一个插件 | [plugin-development.md](plugin-development.md) |

## 1. 一张图看懂运行时

```
             ┌──────────────── Electron 主进程 ────────────────┐
             │  electron/main/index.ts   窗口 / 托盘 / 菜单     │
             │  electron/main/dsc-core.ts 运行时子进程与协议     │
             │  electron/main/dock.ts     终端与浏览器视图       │
             └───────┬────────────────────────────▲────────────┘
        IPC 单点     │ 'dsc:invoke'               │ 'dsc:event'
             ┌───────▼──────────────┐             │
             │  renderer (React)    │─────────────┘  快照流
             │  src/renderer/*.tsx  │   只能调白名单里的方法
             └──────────────────────┘
                    ▲
                    │ MessagePort（没有 parentPort 时走 stdio 一行一条 JSON）＋版本握手
             ┌──────┴───────────────────────────────────────────┐
             │  运行时子进程（node utilityProcess）              │
             │  lib/headless.js → host-stdio 插件               │
             │    └ createKernel() → cordis 上下文              │
             │        内核插件 25 + 官方可开关 16 + 外部插件 N                     │
             │  src/core/* 是纯能力，被插件包装后对外提供服务      │
             └──────────────────────────────────────────────────┘
```

三条铁律：

1. **内核不碰界面**。`src/core/` 里出现 `ink`、`electron`、`react` 就算越界；
2. **UI 不碰内核**。renderer 只能调 `host-stdio` 白名单里的方法（`src/plugins/host-stdio.ts`
   的 `INVOKABLE_METHODS`：它就是 `DscRuntime` 去掉 `subscribe`/`getSnapshot`/`exit`/`dispose`
   这四个只在宿主进程里成立的方法，清单漏一个编译就报错），想知道内核有什么，看
   `src/contract.ts` 的 `DscRuntime`；
3. **装配只在 cordis 里**。新功能往扩展点上挂，不改 `src/core/loop.ts` 的执行流程。要改循环，
   先改这份文档的扩展点清单。

## 2. 仓库地图

规模现量于 2026-10-02（0.6.28 时点，结构收敛批之后），只数源文件行数，当量尺用。

| 路径 | 规模 | 职责 |
| --- | --- | --- |
| `src/core/` | 101 个文件 ≈31900 行 | 纯能力：模型客户端与协议适配器、会话（含写租约）、循环、审批、压缩、溢出落盘、会话检索、MCP 客户端、工具、技能、设置、任务板；token 粗估（`token-estimate.ts`）与错误文案（`err-text.ts`）是全仓库唯一一份 |
| `src/core/tools/` | 6 个文件 ≈810 行 | 内置六件套 `bash`/`read`/`write`/`edit`/`glob`/`grep`（预算由 tools-default 配置下发）+ 沙箱的一次性升权参数与命令执行器缝 |
| `src/core/lsp/` | 7 个文件 ≈2400 行 | LSP 代码智能：`client`（连接/实例）、`manager`（池化调度）、`normalize`（应答归并）、`line-shift`（诊断行号对齐）、`framing`/`servers`/`uri` |
| `src/core/dsh-compat/` | 2 个文件 ≈210 行 | dsh 插件兼容层的模块解析钩子与工具形状适配 |
| `src/plugins/` | 51 个文件 ≈17700 行 | 每个服务一个 cordis 插件 + 十六个官方可开关插件；`remote/` 拆成 `types`/`http`/`routes`（HTTP 路由）+ `remote.ts`（传输与装配） |
| `src/host/kernel.ts` | 424 行 | 内核装配顺序与三档插件元数据 |
| `src/contract.ts` | 1118 行 | UI ⇄ 运行时的中性契约（`DscRuntime` + 视图类型） |
| `src/services/types.ts` | 1050 行 | 服务面声明（`ctx.llm`、`ctx.mcp` 这些是什么类型） |
| `src/adapter/transcript.ts` | 551 行 | 内核事件 → UI 快照的折叠投影 |
| `src/app/` | 7 个组件 ≈700 行 | ink 终端界面（与桌面端共用契约） |
| `desktop/electron/` | 6 个文件 ≈1150 行 | main + preload：窗口、托盘、运行时子进程、终端与浏览器 dock |
| `desktop/src/renderer/` | 64 个文件 ≈18900 行 | 桌面界面：会话、侧栏、插件、技能、设置、队友；`chat/`（markdown 渲染 / 评价存档 / 折叠预算 / 座位计划 / 视口 hook）与 `sidebar-groups.ts` 从两个巨型组件里拆出来 |
| `shots/` | 脚本 + 实拍产物 | 自检与实拍（全部跑在临时 HOME 上）。**这个目录被 `.gitignore` 忽略**：它只在本机存在，不随版本库分发 |
| `examples/plugins/` | 4 个示例 | 手写插件的参照 |

## 3. 三条启动链路

**TUI**（`msc`）

1. `bin/dsc.js`（bin 键 `msc`）解析 `--resume` / `config` 子命令，spawn `node lib/boot.js`；
2. `src/boot.ts` 只做装配，按顺序：`migrateFromDsh()`（幂等，只读 dsh）→ `readConfig()` →
   `readUiConfig()` → `createKernel()` → 装 TUI 插件 → `loadExternalPlugins()` →
   `emitStartupNotes()`。`readUiConfig()` 读 `config.yaml` 的 `ui` 段与 `plugins` 段，
   但 boot 是**无条件**挂 TUI 的（`src/boot.ts:27`）——真正起作用的只有 `plugins` 段；
3. `--resume` 走 `DSC_RESUME_SESSION` 环境变量传给子进程（`auto` = 看 `.last-session` 指针）。

**桌面**（`dist/win-unpacked/Muse Code.exe` 或 `pnpm run dev`）

1. 主进程 `readState()` 读 `~/.dsc/desktop.json`（最近工作目录最多记 12 个、托盘提示是否
   弹过），写侧 `writeState()` 做合并（`desktop/electron/main/dsc-core.ts:42-60`）；
2. `requestSingleInstanceLock()`，`DSC_DESKTOP_USER_DATA` 可以换 userData 让并行实例互不干扰
   （`desktop/electron/main/index.ts:363`）；
3. `dsc-core.ts` 以 `ELECTRON_RUN_AS_NODE=1` spawn 打包进 `resources/dsc-core/` 的运行时
   （`src/headless.ts:1-6`：exe 兼作内核的 node 解释器）；
4. 运行时 `hello { protocolVersion }` 握手，版本对不上直接报错；
5. renderer 通过 `bridge.ts` 调白名单方法，收快照流渲染。

**无头**（桌面端的运行时子进程，也是脚本化调用的入口）

1. `bin/headless.cjs` → `lib/headless.js`，stdin 关闭即退出；
2. 顺序和 TUI 一样：迁移检查 → 读配置 → `createKernel()`，只是装的插件换成
   `hostStdioPlugin`（`src/headless.ts`），不装任何界面；
3. 传输自动探测：`process.parentPort` 存在就用结构化克隆的 MessagePort（Electron
   `utilityProcess` 走这条），否则按「stdio 上一行一条 JSON」通信，不是 JSON 的行直接忽略。

## 4. 装配规则（cordis）

一个插件长这样，四条规矩都在代码里强制执行：

```ts
export const myPlugin: Plugin.Object = {
  name: 'my-plugin',
  inject: ['llm', 'transcript'],   // ① 要用的服务必须声明；没声明的读 ctx.xxx 会抛
  provide: 'mine',                 // ② 对外提供的服务名（可选）
  apply(ctx, config) {
    const off = ctx.tools.register({ ... })   // ③ 注册一律返回清理函数
    return () => off()                        // ④ apply 返回合并后的清理函数
  },
}
```

- **可选服务不能进 `inject`**：插件关着时它不存在，声明了会让整个挂载失败。别人要用
  `ctx.get('名字')` 读（读不到是 `undefined`），**不能**写 `ctx.名字?.`——cordis 的属性代理
  对没声明的名字是直接抛错，可选链救不了（这条是打包版里真踩出来的，见
  [development-log.md 坑 4](development-log.md)）。
- **waterfall 监听必须调 `next()`**，不调就把链断了。

### 三档插件

| 档 | 判定 | 开关 | 现在有谁 |
| --- | --- | --- | --- |
| 自定义 | `source: 'external'`，文件在 `~/.dsc/plugins/*.js` | 可拨，默认开 | 用户自己的（dsh 风格的插件走兼容层，见 [plugin-development.md](plugin-development.md) 的「dsh 兼容层」章） |
| 官方可开关 | `source: 'builtin'` + `toggleable: true` | 可拨，默认由 `defaultDisabled` 定 | 见下面那张表，共 17 个 |
| 运行内核 | `source: 'builtin'` 且没标 `toggleable` | 不给开关 | `llm`/`session`/`guards`/`surfaces`/`waiting`/`approval`/`hooks`/`tools`/`tools-default`/`transcript`/`commands`/`skills`/`prompt`/`mode`/`settings`/`compact`/`todo`/`plan`/`ask`/`agent`/`goal`/`memory`/`runtime` 共 23 个 |

官方可开关插件（`src/host/kernel.ts` 的 `OFFICIAL_PLUGINS` + `OFFICIAL_OBJECTS`）：

| 插件 | 默认 | 设置分区 | 干什么 |
| --- | --- | --- | --- |
| `subagent` 子智能体 | 关 | `subagent` | 把任务派给有明确授权的子智能体（`subagent` 工具），设置递归层级、数量和模型；队友按会话隔离 |
| `team` 智能体团队 | 关 | `team` | 协作层：共享任务看板（`team_task` 工具），看板按会话各一块；已启用 `subagent` 而没动过它时自动跟着打开 |
| `computer-use` 电脑操作 | 关 | `computer-use` | 截屏、点击、输入 Windows 桌面，每次动手都要审批 |
| `web-search` 网页搜索 | 开 | `web-search` | 提供 `web_search` 工具，经 Tavily / 博查 / Serper 检索网页 |
| `approval-floor` 审批灾难地板 | 开 | `approval-floor` | 守卫链 order 5 的硬闸：灾难命令、deny 黑名单、命令白名单、无人值守 |
| `spill` 大输出溢出 | 开 | `spill` | 工具输出超阈值落到临时文件，回给模型的只有前几行与续读写法 |
| `session-search` 会话全文检索 | 开 | `session-search` | 历史会话的中文全文索引，提供 `session_search` 工具与 `/search` 命令 |
| `lifecycle-hooks` 生命周期钩子 | 关 | `lifecycle-hooks` | 读 `~/.dsc/lifecycle-hooks.json`，按 codex 的十二个事件名跑外部命令钩子 |
| `mcp` MCP 客户端 | 关 | `mcp` | 连 stdio 或 streamable-http 的 MCP server，工具挂成 `mcp__服务器__工具` |
| `tool-search` 工具渐进披露 | 关 | `tool-search` | 用 `tool_search` / `tool_describe` / `tool_call` 替下这一轮用不到的工具 schema |
| `sandbox` 沙箱 | 开 | `sandbox` | 守卫链 order 8 的策略围栏（codex 路线）：三档模式、可写根白名单、受保护路径、命令前缀策略、一次性升权（`sandbox_permissions` + `justification` 成对）；容器后端可换真隔离，降级时照常执行 + 审批兜底并如实上报 |
| `schedule` 定时任务 | 关 | `schedule` | `after`/`at`/`every`/`daily`/`weekly`/`cron` 六种选择器，到点把提醒投回原会话；至多一次、catch-up 补投、pre-dispatch 校验 |
| `lsp` LSP 代码智能 | 关 | `lsp` | 连语言服务器查定义/引用/实现/悬停，并把本次编辑新引入的报错附在 write/edit 结果里 |
| `browser` 浏览器自动化 | 关 | `browser` | DOM 级控制浏览器：无障碍快照 + ref 定位点击输入（`browser_look` 只读 / `browser` 动手），不是截图比坐标 |
| `self-improve` 自我改进 | 关 | `self-improve` | 三条闭环：纠正捕获候选、复盘产技能草稿（默认停用待人启用）、技能自修 + 台账回滚 |
| `dsh-compat` dsh 兼容层 | 关 | — | 挂载 dsh（DeepSeek Harness）外部插件：`logger` 服务、模块解析钩子、dsh 风格工具注册的形状适配 |

默认开关按一条规矩定：会拉起外部进程、连外部服务器或改写每轮请求工具面的那几档默认关（`lifecycle-hooks`、`mcp`、`tool-search`、`schedule`、`lsp`、`browser`、`self-improve`）；提升安全与本地便利、且不配就完全无副作用的那几档默认开。沙箱是唯一的例外档：它默认开——不配就没有外部进程与外部服务器，开着的收益（越界写入当场拒）大于打扰，且默认档 workspace-write 不挡正常的工作区读写。

内核清单在 `src/host/kernel.ts` 的 `BUILTIN_PLUGINS`。新增一档官方可开关插件的三步写在 [plugin-development.md §3.4](plugin-development.md)。

## 5. 契约层与进程间协议

`src/contract.ts` 定义 `DscRuntime`：TUI 与桌面端消费同一接口，桌面端经协议转接。

**消息种类**（`src/plugins/host-stdio.ts:29-42`，桌面侧镜像在
`desktop/electron/main/protocol.ts:36`）：

| 方向 | 消息 | 作用 |
| --- | --- | --- |
| 宿主 → 运行时 | `invoke { id, method, args }` | 调白名单方法 |
| 宿主 → 运行时 | `exit` | 让运行时收尾退进程 |
| 运行时 → 宿主 | `hello { protocolVersion }` | 启动握手 |
| 运行时 → 宿主 | `result { id, ok, value \| error }` | 调用应答 |
| 运行时 → 宿主 | `snapshot { snapshot }` | 全量快照推送 |
| 运行时 → 宿主 | `ui { action: 'open-picker' }` | 命令要求开界面 |
| 运行时 → 宿主 | `dock-data { id, data }` | 终端输出流 |

**方法白名单**就是 `DscRuntime` 去掉 `subscribe` / `getSnapshot` / `exit` / `dispose`
（这四个只在宿主进程里成立：快照走 `snapshot` 消息流，退出由宿主动手）。清单按主题分组：
会话操作、模型与思考强度、插件开关、队友（`listTeammates` / `peekTranscript`）、命令、
审批应答、dock、会话库（归档/恢复/删除/改名/置顶/分叉）、界面偏好、技能中心、设置界面与
模型配置。

**加一个方法要走三步**，少一步就是「renderer 里点了没反应」：

1. `src/contract.ts` 的 `DscRuntime` 加签名；
2. `src/plugins/runtime.ts` 实现；
3. `src/plugins/host-stdio.ts` 的 `INVOKABLE_METHODS` 加名字，renderer 侧 `bridge.ts` 加一行转发。
   两份清单现在都由 `DscRuntime` 推出来：第 3 步漏了会编译报错（白名单那份 `satisfies`
   一份类型兜底，`bridge.ts` 那份是映射类型，少写一个实现就补不上），不再靠人记。

版本号一览：

| 常量 | 位置 | 当前值 | 什么时候动 |
| --- | --- | --- | --- |
| `KERNEL_API_VERSION` | `src/core/plugin-registry.ts:88` | 6 | 插件能用的扩展点有增减 |
| `HOST_PROTOCOL_VERSION` | `src/plugins/host-stdio.ts:25` + `desktop/electron/main/protocol.ts` | 2 | 协议消息种类或白名单语义变了 |

两个版本都是「加载时对不上就报错」，不做静默兼容。插件可以声明 `apiVersion`，内核只拒绝
**高于**自己的版本。

## 6. 数据与文件面

全在 `~/.dsc/` 下（工作区里的技能目录例外，见表末）。改任何一个格式都要先确认读写两侧。

| 路径 | 谁写 | 作用 |
| --- | --- | --- |
| `config.yaml` | 用户 / 设置界面（容错读写在 `src/core/config-store.ts`）/ `dsc config migrate` | 主配置：默认 provider/model + `providers`（`baseURL`/`apiKeyEnv`/`models`，可选 `api` 选协议适配器，缺省 `openai-completions`）+ `skills` 自定义目录 + `ui` 段选界面。每个模型可选 `contextWindow`/`maxTokens`/`thinkingLevels`/`thinkingParam`/`effortMap`/`modalities`（不写=四档 + `thinking` 开关 + 只吃文本） |
| `credentials.yaml` | 用户 / 设置界面 | key 的第二来源（第一是 `apiKeyEnv` 指向的环境变量，第三是回退读 `~/.dsh`） |
| `config.json` | 用户（可选） | 轻量覆盖：provider / model / temperature |
| `settings.json` | 设置界面与 `ctx.settings`（`src/core/prefs.ts:15`） | 审批与思考强度默认值、市场源清单、关窗是否缩托盘、侧栏界面偏好（排序、工作区顺序与别名） |
| `plugins.json` | 插件中心、`plugin_manager` 工具 | 条目树：`entries[{file, disabled, config}]` + `history` 版本记录（自动回滚靠它）。十六个官方可开关插件各占一条，`config` 里存它们的可调值（dsh 插件的 `risk` / `risks` 也存这里） |
| `skills.json` | 技能中心 | 每个技能的开关 |
| `desktop.json` | 桌面主进程（`desktop/electron/main/dsc-core.ts:42-60`） | 最近工作目录（最多记 12 个）、托盘提示是否弹过 |
| `.last-session` | 会话插件 | `--resume` 无参时指向上次的会话文件 |
| `sessions/<cwd 压缩名>/<uuid>.jsonl` | 会话插件 | 会话历史，append-only，恢复靠重放 |
| `sessions/meta.json` | 会话插件 | sidecar：归档 / 置顶 / 改名，**不进 jsonl** |
| `sessions/.archived/<工作区名>/` | 会话库（归档） | 归档区（把文件挪进来，不是在 jsonl 里打标记） |
| `.trash/<工作区名>/` | 会话库（「永久删除」） | 其实是回收站：按 mtime 超过 30 天才扫掉（`src/core/session.ts:564`），删错了还能手工捞回来 |
| `sessions/.teammates/<cwd>/<id>.jsonl` | 子智能体插件 | 队友运行记录。目录以点开头 ⇒ 会话列表扫不到 |
| `team/roster.json` | 子智能体插件 | 队友名册（收工的队友靠它出现在侧栏） |
| `team/boards/<会话 id>.json` | 智能体团队插件 | 共享任务板，每个会话各一块（0.6.16 及以前是全局的 `team/board.json`，不再读写） |
| `team/inbox/<队友名>.jsonl` | 子智能体插件 | 给队友的留言（追加写，队友在回合边界读） |
| `agents/<角色名>.md` | 用户 / 子智能体设置分区 | 队友角色文件，一个角色一个文件 |
| `plugins/*.js` | 用户 | 自定义插件 |
| `skills/` | 技能中心（安装） | 用户级技能目录，每个子目录一份 `SKILL.md` |
| `cache/` | 技能市场（`src/core/market.ts:10`） | 市场条目清单，缓存 1 小时 |
| `cache/session-index.json` | session-search 插件（`src/core/session-index.ts`） | 会话全文检索的倒排索引，带 `version`；是旁路缓存，删掉只会让下次检索重新回填 |
| `spill/` | spill 插件（`src/core/spill.ts`） | 工具输出超阈值时落盘的文件，目录 0700、文件 0600；按 mtime 保留 7 天、目录总量超上限从最旧的删 |
| `lifecycle-hooks.json` | 用户 | codex 形态的十二事件外部命令钩子配置（lifecycle-hooks 插件读它，与安全钩子的 `hooks.json` 各读各的） |
| `memory/` | memory 插件（内核，`src/core/memory.ts`） | 跨会话留下的长期事实：全局事实、用户偏好、当前工作区各一格 |
| `sandbox/tmp/<会话或工作区哈希>/` | sandbox 插件 | 沙箱私有临时目录：`TMP`/`TEMP`/`HOME` 在工具执行期间被重定向到这里，按会话×工作区隔离 |
| `schedule/` | schedule 插件 | `tasks.json` 任务定义（tmp+rename 原子替换）+ `runs.jsonl` 执行台账 + `.lock` 单实例互斥（pid + 启动时间指纹） |
| `learnings/<工作区哈希>/candidates.jsonl` | self-improve 插件 | 纠正/失败候选（`dsc/turn-end` 落一条），**不进系统提示**，`/learnings promote` 才生效 |
| `skills/.ledger.jsonl`、`skills/.usage.json`、`skills/.archive/` | self-improve 插件 | 技能变更台账（前后 hash，`/skills-ledger rollback <id>` 可回滚；patch 前另有 `SKILL.md.bak.<秒级时间戳>` 漂移备份）、命中计数与老化（active → stale 14 天 → archived 30 天，pin 挡自动改写）、归档区（只搬不删） |

技能发现的优先级（rank 小的赢，`src/core/skills.ts:64-71`）：当前目录 `.dsc/skills` →
当前目录 `.agents/skills` → `config.yaml` 的 `skills` 段自定义目录 → `~/.dsc/skills`。
**插件自己的可调值统一存 `plugins.json` 条目里那份 `config`**：设置分区点「保存」走
`writePluginConfig` 写它，插件取值走 `resolvePluginConfig(file, passed)`
（`src/core/plugin-registry.ts:168`）——装配时传进来的那份作底，磁盘上那份覆盖它，
插件每次用值时现调这个函数，所以改完不必重启宿主。
界面上就能改的：`compact`（压缩保留条数、自动压缩触发线、锚点索引与用户原话两个字符预算）、`goal`（缺省轮次、一次加几轮）、`approval-floor`、`spill`、`session-search`、`lifecycle-hooks`、`mcp`、`tool-search`、`subagent`、`computer-use`、`web-search`——插件贡献的分区都排在**插件中心**那个插件的详情页里（内置插件要在内核清单里声明 `settingsSection`，见 `src/host/kernel.ts` 的 `BUILTIN_PLUGINS` 与 `OFFICIAL_PLUGINS`），设置面板只列内核自己的六个分区。
只能手写这个文件的：`approval.approvalTimeoutMs`（每次弹卡现读，改完下一张卡生效）、
`ask.maxQuestions` / `ask.maxOptions`（每次提问现读）、`prompt.instructionBudget`（每次拼提示词现读）、
`host-stdio.snapshotThrottleMs`（只在挂载时读一次，改完要重启）。

带 `version` 字段的有四个文件：`plugins.json`、`skills.json`、`sessions/meta.json`、`cache/session-index.json`。前三个都写死 `version: 1`，读到别的值就整表当空的重来（`src/core/session-meta.ts:53`）；`session-index.json` 的版本对不上（或内容读不懂）就整表重建，它是旁路缓存，没有迁移价值。
**会话 jsonl 本身没有格式版本号**——这是明写的取舍（`src/core/session.ts:4-5`），
所以改事件种类时没有加载期检查会替你兜底。

**会话 jsonl 的事件种类**（`src/core/session.ts`）：

```
meta     { cwd, createdAt, ... }        第一行，重写时保留
user     { text }
assistant{ text, reasoning, toolCalls? }
tool     { callId, name, text, images?, error? }   error = rejected | tool-error
summary  { text, keep? }                压缩产生的摘要；keep = 摘要之外保留了尾部多少条
state    { id, payload }                功能点状态（模式/清单/计划/目标/记忆/学习/system-prompt…）
note     { id, text }                   请求注入备忘（投影塞进请求体的日志外内容在此留底）
```

**「模型可见 ⟺ 已记录」**（对齐 dsh 的 Model-visible ⟺ logged）：发给模型的每一份
都要求能从日志重建——消息历史存原文，改写走 `ctx.prompt.registerProjection` 的
**命名纯投影链**（内置 `fold-system` 并 system、`drop-images` 兜底换图，插件投影按
order 插队）；系统提示词不进消息流，由 agent 插件在每次请求时把用到的全文写进
`system-prompt` 状态条目（hash 去重，恢复会话后最后一条即当前生效的那份）；投影往
请求里注入的日志外内容（LSP 写后诊断、生命周期钩子话术）必须用 `session.appendNote`
落一条 `note` 记录。重建公式：**日志原文 + 投影链定义 + system-prompt + notes = 模型
看到的完整请求**。

读到 `summary` 记录时，`Session.load` 把已经读到的消息换成「摘要 + 末尾 `keep` 条」，尾部在清空之前先取下来：日志是 append-only，摘要之前的原始记录一条都没删，重放时只能靠这个数字知道接回多少。老日志没有 `keep` 字段，按 0 处理，结果是「摘要 + 摘要之后的记录」——这是刻意的向后兼容，比把摘要之前的原文整段读回来（压缩等于白压）好得多。

`tool` 的 `error` 只影响界面（工具卡显示「已拒绝」还是「完成」），不进 OpenAI 协议消息，
所以它存在 jsonl 里、由 `Session.toolErrors` 在重放时单独递给 transcript；
早于这个字段的老日志没有它，读的时候按固定拒绝文案补判一次（`src/core/session.ts` 的 `REJECTED_TOOL_TEXT`）。

**内核事件**（`src/core/loop.ts` 发出，`src/adapter/transcript.ts` 折叠成快照）：
`user` / `turn/start` / `turn/end{completed|aborted|error}` / `error` /
`delta{kind,text}` / `message` / `usage` / `tool/call` / `tool/result{error:tool-error|rejected}`。

## 7. 扩展点清单（新功能往这儿挂）

| 我要做的事 | 用的服务 | 落在哪 |
| --- | --- | --- |
| 给模型加一个工具 | `ctx.tools.register({ name, description, parameters, risk, run })` | `risk='read'` 自动放行，`write`/`exec` 走审批卡 |
| 加一个 `/命令` | `ctx.commands.register()` | 命令名撞内置的会被拒 |
| 往系统提示加一段 | `ctx.prompt.register(id, 取文本, { order })` | 插件关着时这段话自动消失；order 决定段次（模式条款 30、模型信息 890） |
| 加一个模型协议 | `ctx.llm.registerAdapter({ id, stream })` | 端点在 config.yaml 用 `api: <id>` 选择；未注册的协议发请求时响亮报错 |
| 改写发给模型的消息 | `ctx.prompt.registerProjection(id, fn, { order })` | **命名纯投影**：同一输入永远同一输出；模型可见 ⟺ 日志原文 + 投影链（旧截图裁剪用的就是它）。往请求里塞日志上没有的内容时必须配 `session.appendNote` |
| 工具动手之前拦一道 | `ctx.guards.register({ id, order, decide })` | 内置刻度：灾难地板 5、沙箱 8、协作模式 10、LSP 写前留底 7、安全钩子 20、浏览器域名 20、生命周期钩子 25、审批 30；守卫自己抛错按「拒」处理 |
| 改写工具的输出 | `ctx.guards.registerObserver({ id, order, observe })` | 内置刻度：密钥遮红 10、LSP 诊断注入 46、生命周期钩子 45、大输出溢出 50；order 小的先加工，后一位看到的是前一位的输出 |
| 换掉命令的执行体（真隔离） | `registerCommandRunner()`（`src/core/tools/command-runner.ts`） | 随包发布的内置插件可用（外部插件拿不到）：沙箱的容器后端把 `powershell -Command X` 换成 `docker run … sh -c X`；没有注册者时行为与从前完全一致 |
| 往界面快照加一块状态 | `ctx.surfaces.register(id, 取值)` | 先在 `contract.ts` 的 `RuntimeSurfaces` 上声明合并；快照装配层不认识具体功能 |
| 有张卡片正等用户点 | `ctx.waiting.register(id, () => 是否在等)` | 会话目标的自动续跑据此刹车 |
| 自己那块状态要跟着会话走 | `ctx.session.appendState(id, payload)` + `session.state(id)` | 先在 `SessionStateMap` 上声明合并；写进去是一条 `state` 记录 |
| 监听内核事件 | `ctx.events.on(...)` | 见 plugin-development.md §5 |
| 加一个设置分区 | `ctx.settings.registerSection()` | 声明式控件，插件拿不到 DOM |
| 挂一个技能来源 | `ctx.skills.registerProvider()` | 技能中心会多一个来源 |
| 对外提供能力给 UI | `ctx.provide('名字', {...})` + `contract.ts` + 白名单 | 见 §5 三步 |
| 让 UI 说话 | `ctx.transcript.system(...)` / `ui.notice` | **绝不用 console.log**，用户看不见 |

## 8. 开发流程

```sh
# 内核（改 src/** 之后必跑）
cd D:\dsc && pnpm run build        # tsc → lib/，自检脚本跑的就是 lib/

# 类型检查（桌面端）
cd D:\dsc\desktop && pnpm run typecheck

# 自检脚本：全部在临时 HOME 上跑，不碰真实 ~/.dsc
node shots/team-check.mjs          # 插件与团队，98 条
node shots/storage-check.mjs       # 会话存储与会话库
node shots/llm-retry-check.mjs     # LLM 重试（连接失败 / 429 重试，400 与取消不重试）+ 版本号（10 条）
node shots/llm-adapter-check.mjs   # 协议适配器接缝：注册/派发/卸载、重复拒绝、未注册报错、api 字段校验（11 条）
node shots/prompt-projection-check.mjs # 命名投影链 + system-prompt 落盘 + note 记录与重放（17 条）
node shots/dsh-compat-check.mjs    # dsh 兼容层：解析钩子、工具兼容面、logger 桥、不支持项响亮拒绝（14 条）
node shots/model-caps-check.mjs    # 模型能力字段读写往返 + 档位 → 请求字段映射（23 条）
node shots/order-check.mjs         # 侧栏工作区排序落点 + 按工作区树的层级（跑前先编 workspace-order.ts）
node shots/sandbox-check.mjs       # 沙箱：路径围栏、命令策略、一次性升权、降级可见（193 条）
node shots/schedule-check.mjs      # 定时任务：六种选择器、DST、至多一次、catch-up、原子落盘（207 条）
node shots/lsp-check.mjs           # LSP：分帧、URI/UTF-16、服务器表、真握手（自带假语言服务器，167 条）
node shots/browser-check.mjs       # 浏览器：CDP 消息层、ref 代际、快照截断、整树清理（210 条，本机有 Chrome/Edge 才跑真启动段）
node shots/self-improve-check.mjs  # 自我改进：候选状态机、SKILL.md 硬校验、台账回滚、老化（181 条）
node shots/integration-check.mjs   # 集成交付自检（既有：守卫链次序 + 灾难命令 + 压缩重放，95 条）
node shots/m5-integration-check.mjs# 第五轮集成自检：五插件登记/挂载/热卸载/沙箱默认开不误伤（起四次真内核）
node shots/seed-ui-home.mjs        # 造一份临时 HOME 的会话数据，配 DSC_DESKTOP_SHOT 拍侧栏/轨迹
node shots/seed-model-home.mjs     # 造三个带能力字段的端点 + 一条带贴图的消息，拍模型设置与贴图
node scripts/composer-test.mjs     # TUI 输入候选面板

# 打包版实拍
cd D:\dsc\desktop && pnpm run dist:dir     # → dist/win-unpacked/dsc.exe
```

实拍的环境变量钩子（`desktop/electron/main/index.ts`，截图块从 `:433` 起，
`captureCaptionStrip` 在 `:545`，界面参数钩子在 `:499` 附近）：

| 变量 | 作用 |
| --- | --- |
| `DSC_DESKTOP_SHOT=<png 路径>` | 加载完成后截图并退出（带看门狗，`capturePage` 卡住也会退） |
| `DSC_DESKTOP_SHOT_DELAY` | 截图前等多久，默认 4000 ms |
| `DSC_DESKTOP_SHOT_TOPMOST=1` | 把窗口钉在最上层并 `show()` 一次。脚本启动 exe 时 STARTUPINFO 里的 `SW_HIDE` 会让窗口开成隐藏的，那样整屏抓图只能抓到窗口后面的东西 |
| `DSC_DESKTOP_SHOT_STRIP=<png 路径>` | 整屏抓图后裁出窗口右上角的原生控件条，写出 PNG 并把取样颜色打进日志。系统画的最小化/最大化/关闭**不在 `capturePage` 里**，只能这么看（实现见 `captureCaptionStrip`，`:433`） |
| `DSC_DESKTOP_SHOT_EVAL=<js>` | 截图前先在渲染层跑一段脚本：点开某个弹层，或把算出来的颜色读回来 |
| `DSC_DESKTOP_SHOT_EVAL_LEAD` | 上面这段脚本提前多少毫秒跑，默认 2000 ms |
| `DSC_DESKTOP_SEARCH` | 拼到界面的 query：`view=plugins`、`settings=subagent`、`teammates=1`、`peek=1`、`reveal=1`（让 hover 才出现的按钮常驻） |
| `DSC_DESKTOP_USER_DATA` | 换 userData 目录，单实例锁不跟已开着的实例抢 |
| `DSC_DESKTOP_DEMO=1` | 自动跑一轮真实对话（要模型 key） |

**拍图前必须清掉 `ELECTRON_RUN_AS_NODE`**：带着它启动打包 exe，会被当成纯 Node 直接退出，
退出码 0、无输出、不写文件，看上去像「截图功能坏了」。这个变量在环境里出现是合法的——
桌面壳启动内核就是靠它把同一份 exe 当 node 用（`src/headless.ts:1-6`），只有当你想让
exe 当**桌面端**跑的时候才要清掉它。

界面参数想自动化，就加 `?xxx=1` 这类一次性钩子（`desktop/src/renderer/App.tsx:90-124` 已经
有 `view` / `settings` / `reveal` / `dropline` / `peek` 五个），别在自检脚本里手写点击。

## 9. 打包与发布

`pnpm run dist:dir`（试）/ `pnpm run dist`（安装包与便携版）三步：

1. `electron-vite build` → `out/`（主进程 + preload + renderer）；
2. `scripts/prepare-runtime.mjs` → `runtime-staging/dsc-core/`：拷 `D:\dsc\{bin,lib,package.json}`
   与运行期依赖（依赖用 `realpath` 穿过 pnpm 虚拟 store 解析）；
3. `electron-builder`：`files: [out/**, package.json]`，`extraResources` 把 `dsc-core` 与
   托盘图标放进 `resources/`，`afterPack` 再把 `dsc-core/node_modules` 落到位。

产物里的位置：`resources/app.asar`（壳）+ `resources/dsc-core/lib`（内核）。
**内核没跟着 exe 更新**时先怀疑 `prepare-runtime` 之前没跑 `pnpm run build`。

`asar: true` 会吃掉 fs 直读，自检脚本里那句「`app.asar` 里没找到运行时」就是这么来的。

## 10. 代码约定

- 注释与文档写中文，说人话：主语谓语宾语齐、逻辑词显式、能用数字就别用范畴词。
- **注释只写本地事实**：不复述代码、不留「这里原来怎样」的评审史。
- **不在插件里硬编码可调值**：会随部署变的东西一律进 `Config` 字段并能在界面改；协议常量
  和安全不变量该固定的就固定。
- **注册即副作用**：每个注册返回清理函数，`apply` 返回合并后的清理函数。
- **配置错误宁可炸**：能加载时发现的就在加载时报错，绝不静默跳过引用不到的东西。
- 空 `catch` 必须说明吞了什么、为什么。
- 文件结尾恰好一个换行。
- 提交用约定式格式：`feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `test:`，
  正文写「为什么」，中文。

## 11. 排错速查

| 症状 | 先看哪里 |
| --- | --- |
| 界面点了没反应 | 方法在不在 `INVOKABLE_METHODS`（§5 三步） |
| 控制台刷 `cannot get property "xxx" without inject` | 那是可选服务，读它的人要用 `ctx.get('xxx')` |
| 插件开关拨了没效果 | `plugins.json` 条目 + 内核是否热挂载失败（会话里会有一行说明） |
| 打包版没截图就退了 | `ELECTRON_RUN_AS_NODE` 没清；或单实例锁被已有实例占了 |
| 打包版行为和本机不一样 | `resources/dsc-core/lib` 是不是旧的（先 `pnpm run build` 再 `dist:dir`） |
| 队友不出现在侧栏 | 名册 `team/roster.json` 有没有那条记录；子智能体插件是不是开着 |
| 会话列表里冒出队友记录 | `sessions/.teammates` 的目录名被改了（点开头才会被跳过） |
| 模型看不见某个工具 | 插件是否启用；`description` 是否够明确；`parameters` 是否合法 JSON Schema |
| 重新打开会话后上下文又变长了 | 不该再出现：`Session.load` 读到 `summary` 记录时把之前累积的消息换成「摘要 + 末尾 `keep` 条」（`src/core/session.ts` 的 `case 'summary'`）。老日志没有 `keep` 字段时只接回摘要之后的记录，摘要之前的原文一样不读回来 |
| 网络断了却不重试 | 连接失败（`LlmError.retryable`，`src/core/llm.ts:199-205`）与 429 / 5xx 都会退避重试 2 次，判定在 `src/core/llm.ts:162-166`；流已开始或用户已取消则不重试 |
| 截图后 token 暴涨 | 看是否启用了旧截图裁剪（`computer-use` 插件的 `transformMessages`） |
| 写工作区外的文件被拒（沙箱） | 拒因里带当前档位与可写根清单；确有必要就在**同一次调用**里成对带上 `sandbox_permissions` 与 `justification`（照常弹审批卡），或把目录加进「设置 → 沙箱」的附加可写根 |
| 命令被沙箱当场拒 | 拒因写明命中规则（forbidden 前缀 / 网络开关关 / 越界写目标）；`/sandbox` 能看档位、强制执行等级与最近 3 次拒绝 |
| 定时任务没触发 | 宿主不常驻就不触发（重启后补投最近一次错过的）；`/schedule list` 看任务是否 enabled、`lastError` 写了什么、是否标了 blocked |
| `lsp` 工具回「没有数据」 | 按返回里的原因装对应语言服务器（typescript-language-server / pyright / rust-analyzer 等）；设置分区的状态按钮能看每个服务器的起停与 stderr 尾巴 |
| 浏览器起不来 | 「设置 → 浏览器」的 executablePath 填本机 Chrome/Edge 路径；必须用自建 profile（用户默认 profile 会被 Chrome 136+ 静默忽略调试端口），看当前标签页与关闭两个按钮可以直接验进程 |
| 模型新建的技能没进目录 | self-improve 产的草稿**默认停用**，去「技能」页手动启用；`/skills-ledger` 查每次变更，`rollback <id>` 可退回 |

## 12. 关键取值速查

改这些之前先确认设置界面对不对得上：能在界面改的一律走设置分区，不许在代码里另起一份。

**枚举**

| 名称 | 取值 | 位置 |
| --- | --- | --- |
| 权限模式 `ApprovalPolicy` | `readonly`（只读，写和执行一律拒）/ `auto-edit`（写文件放行，执行命令仍要审批）/ `full-access`（动手都要审批）/ `ai-review`（当前模型逐次判断放行，判断失败退回人工审批） | `src/contract.ts:22`，判读在 `src/plugins/approval.ts:280`，档位文案在 `approval.ts:56` |
| 思考强度 `EffortLevel` | `default` / `off` / `low` / `high` / `max` | `src/contract.ts:12` |
| 思考档位 `ThinkingLevel` | `off` / `low` / `high` / `max`（每个模型可只声明其中几档，`default` 不算模型能力） | `src/contract.ts:15` |
| 档位字段 `ThinkingParam` | `thinking`（发 `thinking:{type}`，只有开关）/ `reasoning-effort`（发 `reasoning_effort`，线上值见 `EffortMap`）/ `none`（不发思考字段）。缺省 `thinking` | `src/contract.ts:23`，映射在 `src/core/model-caps.ts:201` |
| 输入类型 `Modality` | `text`（恒含）/ `image`（贴图、computer-use 截图）/ `video`（只作声明，目前没有发视频的通路） | `src/contract.ts:26` |
| 会话排序 `SessionSortKey` | `manual`（工作区按拖动顺序，没拖过就活动区置顶）/ `recent`（按最近写入）/ `created`（按创建时间） | `src/contract.ts:162` |
| 列表分组 `SessionGroupKey` | `workspace`（按工作区分组）/ `tree`（嵌套目录挂到最近的祖先工作区下）/ `flat`（不分组的单列表） | `src/contract.ts:165` |
| 归档显隐 `ArchivedFilter` | `hide`（默认，只看活动区）/ `show`（两区并成一份列表）/ `only`（只看归档区） | `src/contract.ts:168` |
| 队友审批 `TeammateApproval` | `forbid`（不允许）/ `foreground`（仅前台子允许）/ `ask`（允许并标注），从严到松按 `forbid < foreground < ask` 比较 | `src/plugins/subagent.ts:75` |

**默认值与硬编码数值**

| 数值 | 值 | 出处 |
| --- | --- | --- |
| 压缩保留的最近消息条数 | 缺省 20 条，夹在 5~200；可配 `compact.keepRecent`，设置「上下文压缩」分区就能改 | `src/plugins/compact.ts:38-43`、`src/core/compact.ts:27` |
| 审批卡等多久没人答 | 缺省 300 秒，夹在 10 秒~1 小时；可配 `approval.approvalTimeoutMs`，每次弹卡现读。**没人能应答时不等这个值**：没有 `interactive` 服务（tui / host-stdio 登记）且本进程不是终端直连时，直接按拒处理并写明理由 | `src/plugins/approval.ts:42-56`、`:116-128` |
| 模型一次最多问几题 / 每题几个选项 | 缺省 3 题 / 每题 4 项，都夹在 1~8；可配 `ask.maxQuestions` / `ask.maxOptions` | `src/plugins/ask.ts` |
| 会话目标缺省轮次上限 / 一次放宽几轮 | 缺省 24 轮 / 8 轮，夹在 1~256 / 1~64；可配 `goal.defaultMaxRounds` / `goal.extendRoundsBy`，设置「会话目标」分区就能改；256 这个硬顶不可配 | `src/plugins/goal.ts:44`、`src/core/goal.ts:30` |
| 说明书（AGENTS.md）字符预算 | 缺省 20000，夹在 4000~200000；可配 `prompt.instructionBudget` | `src/plugins/prompt.ts`、`src/core/prompt.ts:37` |
| 快照推送节流 | 缺省 80 ms，夹在 16 ms~1 秒；可配 `host-stdio.snapshotThrottleMs` | `src/plugins/host-stdio.ts` |
| 自动压缩触发线 | 缺省为模型上下文窗口的 80%，夹在 50%~95%；可配 `compact.autoCompactPercent`，设置「上下文压缩」分区就能改 | `src/plugins/compact.ts:40`、`:63` |
| 压缩摘要的锚点索引预算 | 缺省 6000 字符，夹在 1000~20000；可配 `compact.anchorBudgetChars` | `src/core/compact-anchors.ts:32`、`src/plugins/compact.ts:46` |
| 压缩摘要的用户原话预算 | 缺省 8000 字符，夹在 1000~40000；可配 `compact.userQuoteBudgetChars` | `src/core/compact-anchors.ts:35`、`src/plugins/compact.ts:47` |
| 灾难地板的命令长度上限 | 缺省 4000 字符，夹在 100~100000；更长的命令按「看不清要跑什么」拒；可配 `approval-floor.maxCommandLength` | `src/core/approval-floor.ts:34`、`:116` |
| 灾难地板的熔断 | 连续被地板拒 5 次（1~100）后冷却 60000 毫秒（0~3600000），缺省开着；可配 `approval-floor.circuitBreakerThreshold` / `circuitBreakerCooldownMs` / `circuitBreakerEnabled` | `src/core/approval-floor.ts:35-36`、`:117-119` |
| 「只读命令」的判据 | 不止「第一个词在只读名单里」：① 引号外的 `>`（`2>&1` 不算）算写盘，整段不算只读；② `node`/`python`/`perl` 这类解释器一律不算只读，python 只有 `-m pytest`/`-m unittest`/`-m json.tool` 例外；③ `env` 会被剥掉再看真正的命令；④ `find` 带 `-delete`/`-exec`/`-fprint` 不算；⑤ `sed` 的 `e`/`w`/`-i` 与 `awk` 的 `system(`/`popen(`/`>` 不算。只有 ① 是可配的（走白名单），其余是安全不变量 | `src/core/command-policy.ts:299-320`、`:506-563` |
| 大输出溢出阈值与预览 | 缺省超过 4000 字符就落盘（200~4000000），预览留前 30 行（1~500），续读一次 200 行（1~2000）；可配 `spill.thresholdChars` / `keepLines` / `readChunkLines` | `src/core/spill.ts:31-39`、`:65-73` |
| 溢出的落盘与清理 | 单文件上限 1048576 字节（4096~268435456）、按 mtime 保留 7 天（1~3650）、目录总量上限 67108864 字节（65536~8589934592，超了从最旧的删）、目录 `~/.dsc/spill/`；可配 `spill.maxBytes` / `retentionDays` / `maxTotalBytes` / `dir` | `src/core/spill.ts:31-39`、`:65-73` |
| 会话检索返回几条 | 缺省 20 条，夹在 1~200；可配 `session-search.defaultLimit` | `src/core/session-index.ts:70` |
| 会话检索的片段与回填 | 命中片段 160 字符（40~2000）、回填每批 25 个文件（1~500）、单文件大小上限 8 MiB（4096~256 MiB，超了只记指纹）、索引目录 `~/.dsc/cache`；可配 `session-search.snippetLength` / `backfillBatch` / `maxFileBytes` / `indexDir` | `src/core/session-index.ts:51-56`、`:62-72` |
| 生命周期钩子缺省超时 | 缺省 10000 毫秒，夹在 500~120000；钩子最多 50 条、单条命令 1000 字符、matcher 120 字符；可配 `lifecycle-hooks.timeoutMs` | `src/core/hooks.ts:53`、`src/core/lifecycle-hooks.ts:168-170`、`:190-196` |
| MCP 的调用与重连 | 单次调用超时 60000 毫秒、握手 20000 毫秒（都夹在 1000~600000）；重连退避 1000→30000 毫秒、连续失败 5 次放弃（1~50）；清单里没写 `defaultRisk` 的 server 缺省按 `exec` 算；可配 `mcp.*` | `src/plugins/mcp.ts:53-62`、`:65-70` |
| 工具渐进披露 | 一次检索最多 5 条（1~20），档位缺省 2（1 = 只撤 MCP、2 = 再按 `deferRules` 撤、3 = 除 `keepTools` 外全撤）；可配 `tool-search.searchLimit` / `tier` | `src/core/tool-search.ts:24-29`、`:54-60` |
| 模型请求重试 | 最多 3 次，退避 500ms × 2^(n-1)；可重试的是连接失败（`LlmError.retryable`，一个字节都没收到时）与 HTTP 429 / 5xx | `src/core/llm.ts:152`、`:162-166` |
| 同时在干的队友上限 | 4（收工的不占额度） | `src/plugins/subagent.ts:68` |
| 队友派活层数 | 1（只有 Lead 能派），0 = 彻底不派 | `src/plugins/subagent.ts:69` |
| 队友审批默认 | `forbid` | `src/plugins/subagent.ts:70` |
| 名册里最多留几条收工记录 | 12（`MAX_LISTED_FINISHED`） | `src/plugins/subagent.ts` |
| 截图最长边 | 1568 px，JPEG 质量 80 | `src/plugins/computer-use.ts:49-51` |
| 动作之间等待 | 120 ms | `src/plugins/computer-use.ts:52` |
| 距上次截屏允许的动作数 | 12，超了强制要求先看一眼 | `src/plugins/computer-use.ts:53` |
| 应用白名单 | 空串 = 不限 | `src/plugins/computer-use.ts:54` |
| 看屏免审批 | 默认关 | `src/plugins/computer-use.ts:56` |
| 最近工作目录记忆条数 | 12 | `desktop/electron/main/index.ts:146` |
| 技能市场清单缓存 | 1 小时，落在 `~/.dsc/cache/` | `src/core/market.ts:10` |
| 截图识别标记 | 工具结果文字里含「屏幕物理分辨率」才认定是自己截的图，不误伤别的插件带的图 | `src/plugins/computer-use.ts:72` |
| 沙箱默认档 | workspace-write：可写根 = 会话 cwd + 沙箱私有临时目录，附加根默认空、网络默认关 | `src/core/sandbox/policy.ts:54-55` |
| 沙箱一次性升权 | `sandbox_permissions` + `justification` 必须成对，只对本次调用生效 | `src/core/tools/sandbox-args.ts` |
| schedule 最小间隔 | `every` 下限 60 秒 | `src/core/schedule/rule.ts:26` |
| schedule catch-up 窗口 | 一次性 120 秒；循环取半周期夹在 120 秒 ~ 2 小时，超窗只跑一次不补积压 | `src/core/schedule/rule.ts:29-35` |
| lsp idle 回收 | 600 秒（设置可调，下限 30 秒） | `src/core/lsp/client.ts:22` |
| lsp 结果上限 | 默认 100 条（可配 1~1000）+ 16000 字符双上限 | `src/plugins/lsp.ts:71-76` |
| browser 快照与缓冲 | 快照默认 15000 字符按行截断（不切碎元素）；控制台环形 200 条 | `src/plugins/browser.ts:79,84` |
| browser profile 清理 | 整树 taskkill 后等 300ms 再删自建 profile | `src/core/cdp/launch.ts:288,444` |
| self-improve 复盘触发 | 本轮工具迭代数 ≥ 12（对齐 hermes 用迭代数不用轮数） | `src/plugins/self-improve.ts:115` |
| self-improve 技能草稿 | description ≤60 字符（超了拒收不截断）；老化 14 天 stale / 30 天归档 | `src/core/learnings/skill-write.ts:61,866` |

**写/执行类不留持久授权**：一次审批只管这一次，`approval` 服务不跨回合记住「上次同意过」。

## 13. 模块速查

### 内核装配顺序

`createKernel()` 依次挂 25 个内核插件：`llm` → `session` → 三个扩展点（`guards` / `surfaces` / `waiting`）→ `approval` → `tools` → `tools-default` → `transcript` → `commands` → `skills` → `prompt` → `mode` → `settings` → `hooks` → `compact` → `todo` → `plan` → `ask` → `agent` → `goal` → `memory` → `runtime` → `desktop-dock` → `plugin-manager`；末尾把十六个官方可开关插件登记进热挂载表（`registerBuiltinMount`），再按 `plugins.json` 的条目决定本次挂不挂（`src/host/kernel.ts`）。
这个顺序里有两处是必须的，不只是好看：`approval` 早于 `mode`，因为换档广播 `dsc/mode-changed` 而审批要听（审批卡上得写当前档位）；`transcript` 早于 `plan`，因为恢复会话时要先把会话流清空，计划卡那条条目才不会被清掉。
官方可开关插件之间还有一条硬约束：`tool-search` 必须排在 `mcp` 之后，否则它 apply 时 `ctx.get('mcp')` 是 `undefined`，MCP 工具的 schema 永远不会被撤下。

**自检脚本同进程起多个内核时要先停再验**：命令补全面（`src/plugins/commands.ts` 的模块级 `extraSpecs`）与插件元数据一样是进程级共享——不先停掉前面的内核，后起内核的 `specs()` 会看见前几份注册，验「关掉后消失」全是假阳性。cordis 的 `Context` 本身没有 dispose，fiber 在 `ctx.fiber` 上，停整棵内核是 `await ctx.fiber.dispose()`（m5 集成自检踩过这个坑）。
注意 `desktop-dock` 与 `plugin-manager` 不显示在插件中心的「运行内核」清单里。
把 `tools-default` 剔掉就得到一个只有对话、没有工具的 harness（`src/plugins/tools-default.ts:3`）。

### core 层

| 模块 | 该知道的 |
| --- | --- |
| `config.ts` | 合成运行期路由表：`config.yaml` + 凭据 + `config.json` 覆盖。`apiKeyEnv` 取不到值的端点整条不注册（`:74-76`）；默认路由指向不存在的端点时退回第一个可用组合（`:131-142`）。上下文窗口缺省 128000、输出上限缺省 8192（`:85-86`）。每个模型的能力字段过 `readModelCaps()` 归一化 |
| `model-caps.ts` | 模型能力（思考档位 / 档位走哪个字段 / 输入模态）的**唯一**来源：默认值、YAML 容错解析（认 `vision`、`photo`、`图片`、旧字段 `vision: true`）、档位 → 请求字段映射 `effortToWire()`（`:201`）。切模型时越界的档位由 `clampEffort()`（`:184`）退回 `default`；界面文案（`THINKING_LEVEL_LABELS`、`MODALITY_LABELS`、`EFFORT_WIRE_HINT`）也在这里，渲染层不另抄一份 |
| `config-store.ts` | 设置界面写 `config.yaml` / `credentials.yaml` 的**唯一**入口。端点名要匹配 `/^[a-z0-9][a-z0-9_-]{0,40}$/`（`:137`）；不写 `apiKeyEnv` 时按端点名推导成 `<名字大写>_API_KEY`；草稿的能力字段在 `validateDraft()`（`:156`）过枚举，缺省字段由 `capsOf()` 补，能力字段只在偏离缺省时写进 YAML（`:186`）；覆盖前会先存一份 `config.yaml.bak`，**YAML 注释会在这一步丢掉**（`:44`） |
| `migrate.ts` | 一次性搬 dsh 的配置，只读 dsh。目标已存在且没给 `force` 就直接返回（`:107`）。只收 `api: openai-completions` 的端点（`:78`） |
| `llm.ts` | 手写 SSE 解析：只认 `data:` 行，单行 JSON 解析失败就跳过。思考增量字段是 `delta.reasoning_content`，重放给模型时原样回传（空串不回传）。工具调用按 `delta.tool_calls[].index` 拼，`arguments` 用 `+=` 续接，最后按 index 排序。最多 3 次尝试，退避 500ms、1000ms。**协议适配器**：这份实现就是内置 `openai-completions` 适配器（`LlmAdapter`），别的协议由插件经 `ctx.llm.registerAdapter` 注册，端点配置 `api` 字段选择 |
| `session.ts` | 列表只读每个文件前 8 行 + mtime（`:463-472`），所以列表页别指望读到深处的内容。目录名把 `\\`、`/`、`:` 换成 `-`（`:34-36`） |
| `session-meta.ts` | `sessions/meta.json` 用 uuid 当键，所以归档挪文件不会丢状态（`:7`）。`version` 不是 1 就整表当空（`:53`） |
| `events.ts` | `CoreEvent` 九个变体，是 core 唯一对外通道（`:10-22`） |
| `compact.ts` | 见 §12 |
| `compact-anchors.ts` | 摘要的机械加固件：锚点索引（正则抽 PR 号 / commit / 分支 / 文件 / 报错 / 链接）、用户原话逐字引用、细节找回指针。全是纯函数，可以脱离模型单独断言 |
| `approval-floor.ts` | 灾难地板的判定：结构不可验证 → 灾难命令 → 用户 deny 黑名单 → 危险模式 → 命令白名单 → 无人值守，逐层给结论。配置读不通时守卫照样挂载却一律拒（挂不上等于链上没有地板，是 fail-open）。**只判「拒」或「不拒」**：命中白名单也只 `defer`，由 `approvalFloor` 服务把结论交给审批层免卡放行——地板自己 `pass` 会把 order 20 / 25 的安全钩子一并跳掉 |
| `spill.ts` | 溢出落盘：建文件（目录 0700、文件 0600）、按整行截断并在文件末尾写明第几行没落盘、生成预览与续读写法、按 mtime 与目录总量扫目录 |
| `sandbox/` | 沙箱纯逻辑：`policy`（路径规范化 + 可写根/受保护名/NT 前缀判定，**按每次调用的 cwd 算根**，解析失败保守拒）、`execpolicy`（命令前缀 allow/prompt/forbidden，写目标与网络命令识别，内层脚本再拆一层）、`backends`（docker 探测与执行体替换） |
| `schedule/` | 定时任务：`rule`（六种选择器 + 时区/DST）、`store`（tasks.json 原子替换 + runs.jsonl 台账 + pendingSlot）、`runner`（自重排 setTimeout + catch-up + pre-dispatch 校验）。**先落盘推进 nextRunAt 再投递** |
| `lsp/` | 语言服务器客户端：`framing`（Content-Length 分帧，别照抄 mcp.ts 的换行分帧）、`uri`（先解码成路径再比内外）、`servers`（内置表 + marker 找根 + PATHEXT）、`client`（握手/串行队列/idle 回收/破键退避）。挂着的请求结算用本地 settled 闸门——先清表再 settle 会让请求永不落地 |
| `cdp/` | 浏览器 CDP 底座：`transport`（id 配对 + **按 sessionId 路由** + 事件订阅）、`launch`（探测/参数串/DevToolsActivePort/整树 taskkill）、`snapshot`（无障碍树文本化 + ref 代际）、`actions`（Input/DOM/Runtime 动作） |
| `learnings/` | 自我改进：`store`（候选 jsonl 状态机）、`ledger`（技能变更台账与回滚）、`skill-write`（SKILL.md 硬校验 + 威胁扫描 + read-before-write + 老化）。读会话状态一律过 `normalizeLearningsState` 收口 |
| `tools/command-runner.ts` | 命令执行器缝：bash 在 spawn 前问注册表，容器后端换执行体用；无注册者时行为不变 |
| `tools/sandbox-args.ts` | 一次性升权参数的 schema 与解析：`sandbox_permissions` + `justification` 必须成对，只给半截按拒处理 |
| `session-index.ts` | 会话检索的旁路倒排索引：中文按 1-gram + 2-gram（所以「内存」这种 2 字词能命中），英文按整词小写；按 mtime + size 增量维护，落 `cache/session-index.json`，版本对不上就整表重建 |
| `mcp.ts` | MCP 客户端底座：stdio 与 streamable-http 两种传输上的 JSON-RPC、`mcp__服务器__工具` 命名、子进程环境白名单筛选、Windows 上按 PATH + PATHEXT 解析启动命令 |
| `tool-search.ts` | 工具渐进披露的纯逻辑：分词（中文按相邻两字）、手写 BM25 索引、延后判定（read 一律不许撤）、配置校验 |
| `lifecycle-hooks.ts` | codex 十二事件的钩子引擎：事件能力清单（wired / partial / unwired 与理由）、codex 形态配置的解析、跑外部命令、按失败方向给裁决 |
| `approval.ts` | 只有审批通道**接口**，判读在 `src/plugins/approval.ts` |
| `tools/` | `bash` 缺省 30 秒、最多 120 秒，输出超 8000 字符截断（累积到 16000 就不再收）——三个值都由 tools-default 插件配置下发（`bashTimeoutMs` / `bashMaxTimeoutMs` / `bashOutputChars`，设置分区「工具预算」可改），代码里的常量只是缺省。Windows 走 `powershell -NoProfile -Command`，超时和取消都收进程树。`read` 单次缺省 2000 行（`tools-default.readLineLimit`）。`glob` 遍历上限 1 万、`grep` 2 万，都跳过 `node_modules`/`.git`/`dist`/`build`/`coverage`/`__pycache__` 与 1 MiB 以上的文件。**没有目录白名单**——路径只按会话工作目录解析 |
| `skills.ts` | 只认顶层 `<目录>/SKILL.md` 与顶层 `<名字>.md`，不递归（`:165-178`）。`name` 要 kebab-case，非法就退回文件名并记一条问题 |
| `market.ts` | 缓存 1 小时、拉取超时 15 秒、浏览并发 6、附属文件最多 40 个。GitHub 匿名限额低，403/422 会提示设 `GITHUB_TOKEN` |
| `prefs.ts` | 偏好文件读坏了按默认返回，不崩（`:89-91`）。`closeToTray` 默认 true |
| `version.ts` | 版本号从包名 `muse-code`（兼容旧名 `dsc-tui`）的 `package.json` 往上找（`:12-13`、`:23`）。**改包名要同步 `PACKAGE_NAMES`**，否则「关于」分区显示 `0.0.0` |

### 审批判定顺序（`src/plugins/approval.ts:126-152`）

只有 `risk !== 'read'` 的工具进审批（`src/core/loop.ts:198`）。判读顺序：

1. `readonly` → 直接拒；
2. `full-access` → 直接放行；
3. `auto-edit` → 三个条件同时成立才自动放行：工具名是 `write` 或 `edit`、参数里取得到路径
   （按 `file_path`→`path`→`target`→`file` 顺序找）、路径落在会话工作目录内；否则弹人工卡；
4. `ai-review` → 用当前模型问一次（`maxTokens: 200`、思考关掉，只要 ALLOW 或 DENY），
   问不出来退回人工卡；
5. 未知模式 → 弹人工卡。

**审批有超时**：挂起的审批等 `approval.approvalTimeoutMs`（缺省 300 秒，夹在 10 秒~1 小时，
每次弹卡现读），到点按拒绝结算（`src/plugins/approval.ts:172`）；本轮被中断也按拒绝结算。
被拒时循环会补一条 tool 消息「用户拒绝了这次工具调用。」，因为协议要求每个工具调用都有
对应的 tool 消息，否则下一轮直接 400（`src/core/loop.ts:203-207`）。

### 快照投影（`src/adapter/transcript.ts`）

- `delta` 只进「直播尾」，不进定稿表；`message` 才是定稿信号。定稿条目 id 从 1 递增，
  直播尾条目用**负 id**（`-(位置+1)`）避免撞号（`:51-59`）。
- 工具卡状态就四个：`running` / `done` / `failed` / `rejected`（`src/contract.ts:25`），
  结果文字超 1500 字符截断（`:27`）。
- 状态灯优先级：有挂起审批 → `awaiting-approval`，否则在回合内且working → `working`，
  回合内不 working → `thinking`，其余 `idle`（`src/plugins/transcript.ts:74-81`）。
  0.6.50 起「有挂起审批」只数**当前查看会话**的卡（`approval.pendingView` 按
  `ctx.session.current().filePath` 过滤，后台会话的卡不串进当前视图）；后台会话的灯由
  `dsc/agent-status` 事件喂 `backgroundStates`，agent 切走 busy 会话时按
  `approval.pendingFor(path)` 重发对应状态（挂着卡发 `awaiting-approval`，否则 `working`），
  不再把「等你批准」盖成「还在跑」。
- **跨进程推的是全量快照，缺省 80 ms 节流**（可配 `host-stdio.snapshotThrottleMs`），没有 diff 协议；
  renderer 侧必须走 `onSnapshot`，代理对象的 `getSnapshot()` 会直接抛错（`bridge.ts:97-100`）。

### dock 的两侧分工

| 侧 | 管什么 | 护栏 |
| --- | --- | --- |
| `src/plugins/desktop-dock.ts` | 终端会话、工作区文件读写、git | 路径必须在宿主工作目录内；读文件超 512KB 返回 `tooLarge`；git 全部 `execFile` 固定子命令 + 参数净化（拒 `\0`、拒以 `-` 开头的注入）；默认超时 15 秒 |
| `desktop/electron/main/dock.ts` | 内置浏览器视图 | `contextIsolation: true`、`nodeIntegration: false`；弹窗一律 deny 并把新窗口 URL 就地加载；只允许 `http`/`https` |

dock 的操作名：`term-spawn` / `term-input` / `term-kill` / `fs-list` / `fs-read` /
`git-status` / `git-stage` / `git-unstage` / `git-commit` / `git-log` / `git-diff`，未知的
直接抛「dock 未知操作：xxx」。终端是管道模式（没有 tty），所以全屏程序跑不了。

`Dock.tsx` 四个 tab（terminal / browser / files / git），宽度夹在 300~820，双击复位 420；
shell 候选 5 个，选中的存 renderer 的 `localStorage['dsc.dockShell']`。

### 面板尺寸与收起状态存哪

存在 renderer 的 `localStorage`、而不是 `~/.dsc/settings.json` 的用户状态，都是「这个窗口在
这台机器上摆成什么样」这一类，跟跨机器的用户偏好（外观、会话排序）分开：

| localStorage 键 | 管什么 | 夹取范围 / 默认 |
| --- | --- | --- |
| `dsc.dockShell` | dock 终端用哪个 shell | 5 个白名单值 |
| `dsc.dockWidth` | 右侧 dock 宽 | 300~820，双击复位 420 |
| `dsc.sidebarWidth` | 左侧侧栏宽 | 200~420，默认取样式表的 `--dsc-sidebar-w` |
| `dsc.sidebarRail` | 侧栏是否收成 56px 图标窄栏（`Ctrl+B` 切） | `'1'` / `'0'` |
| `dsc.threadWidth` | 中间正文列宽 | 480 ~（可用宽 − 80），默认取样式表的 `--dsc-thread-max`（76ch） |

拖拽逻辑共用 `desktop/src/renderer/panels.ts` 的 `useWidthDrag`：Pointer Capture 攥住指针
（拖出窗口外再回来还接着拖），移动按 `requestAnimationFrame` 合并，取消就退回原宽。
**拖动中只改根元素上的 CSS 变量**（`--dsc-sidebar-w`、`--dsc-thread-max`），松手才写状态和
localStorage——每帧 setState 会重渲染整棵对话树。复位（双击）就是撤掉行内变量，让 `:root`
里那份默认值自己回来，JS 里不抄第二份默认数字。正文列宽写一个变量就够，是因为正文、审批卡、
输入区三处读的都是它。

### 主题色怎么送到原生窗口控件

Windows 的最小化/最大化/关闭三个按钮由系统画，样式表够不到它，所以主题切换时要多走一跳 IPC：

1. `tokens.css` 里的 `--dsc-chrome-bar` / `--dsc-chrome-symbol` 给出两个**不透明**颜色：
   底色就是顶栏透出来的 `--dsc-bg-page`，图标色把顶栏图标用的那 74% 次要文字色压平到页面
   底色上（系统那侧不接受 alpha，半透明颜色交过去会被压成错色）。
2. `appearance.ts` 的 `applyAppearance` 每次落完 `data-theme` 就调一次 `pushWindowChrome()`：
   用一个隐藏探针让浏览器把 `var(--dsc-chrome-*)` 算成实际颜色（同一份 `color-mix()`，内核会
   写成 `rgb()` 或 `color(srgb …)`，两种都要认），转成 `#rrggbb` 后经 `dsc:set-window-chrome`
   发给主进程；同一次外观里两个值没变就不重发。
3. 主进程收到后调 `setTitleBarOverlay` 改控件条、`setBackgroundColor` 改窗口底色。
   只收 `#rrggbb`，其它格式直接拒收，窗口留着深色默认值。

窗口从创建到第一帧外观生效之间有一小段空白，主进程按 `DARK_CHROME` 上色，这两个值取自深色主题
下同名令牌算出来的实际颜色，选深色时看不见跳色。选浅色的这段时间靠 localStorage 镜像顶着：
`main.tsx` 首帧和 `App.tsx` 的 `uiPrefs` 初值都读同一份镜像，否则宿主返回真实设置之前会先按写死
的深色上一遍色，连控件条都会被推成深色，每次启动黑闪一下。

顺带一条颜色纪律：`styles.css` 里不再出现颜色字面量，只剩 6 行是故意留的（品牌渐变 logo
和它的白字、彩底上的白色图标、开关的白滑块、两处深色遮罩）。要更重或更轻的语义色就用
`color-mix(in srgb, var(--dsc-*) N%, transparent)` 现调，不要再抄一份十六进制。

### 命令与补全（`src/core/commands-completion.ts` + `src/plugins/commands.ts`）

命令表、补全与唯一前缀展开的**单一真源是 `src/core/commands-completion.ts`**——它是顶层
零 node 依赖的纯模块，渲染层（经 `@dsc/runtime/core/commands-completion.js` alias）、TUI
与插件三方共用。渲染层 import 链上任何一个模块顶层碰 node 内置模块，vite externalize
代理一求值就把整个渲染进程炸成白屏（0.6.26 踩的，见 development-log 阶段 44 与 memory）。
内置命令 7 条：`new` / `resume` / `compact` / `model` / `review` / `help` / `exit`
（`commands-completion.ts:16-22`）；`/review` 的 handler 在 `src/plugins/commands.ts`
（收集工作区未提交改动组装审查轮，git 收集在 `src/core/git-info.ts`）。插件注册的命令进
`extraSpecs`。输入 `/ne` 按 Enter 会展开成 `/new`（唯一前缀）。`/effort` 保留着但只回
一句「已移除」（`src/plugins/commands.ts:118`）。
