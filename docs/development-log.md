# dsc 开发记录

这份文档记的是**这个 harness 是怎么一步步长成现在这样的**：每个阶段引入了什么、当时为
什么这么选、踩过的坑怎么修的。和另外两份文档的分工：

| 文档 | 回答的问题 |
| --- | --- |
| [README.md](../README.md) | 怎么装、怎么跑、怎么配 |
| [development.md](development.md) | 代码怎么分层、往哪改、怎么验证 |
| **本文档** | 为什么长成这样、踩过哪些坑、还欠什么 |
| [plugin-development.md](plugin-development.md) | 怎么写插件 |

> **依据说明**：本文的事实来源是代码本体、代码注释里的行为契约、`shots/` 下的自检脚本，
> 以及 git 历史。git 历史只有 5 个提交（首批代码是一次性收进来的基线），所以**阶段划分
> 按功能边界重建，没有逐轮时间戳**——我不给自己编日期。凡是我无法从代码确证的细节，
> 这里就不写。

---

## 阶段 0：为什么要自己做一个

参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的组件设计，做一个**装在自己
机器上的**终端 harness。取舍写死在 README 里：复用它的**设计**（回合语义、事件流、审批
分级、JSONL 落盘、超阈值压缩），不复用它的**实现**——仓库里零 `@deepseek-ai/*` 依赖。

个人版明确不做的：沙箱、检查点修复、投影事件语义。理由很直白：单人单机，审批卡够用，
把这些搬过来只会让代码读不动。

## 阶段 1：先有能跑的内核

`src/core/` 是最早的一层，它的设计约束到今天没变：**零 UI 依赖、零宿主依赖**。

| 模块 | 当时要解决的问题 |
| --- | --- |
| `llm.ts` | OpenAI 兼容流式协议：SSE 分片、reasoning 增量、tool_calls 分片拼装、usage |
| `session.ts` | append-only JSONL + 重放恢复。崩了也不丢历史，代价是恢复只能靠重放 |
| `loop.ts` | ReAct 回合：发给模型 → 流式回来 → 要审批 → 跑工具 → 定稿 |
| `tools/` | `bash` / `read` / `write` / `edit` / `glob` / `grep` 六件，读类自动放行 |
| `approval.ts` | 写与执行类挂起等人工 y/n，**不做持久授权**（一次授权只管这一次） |
| `compact.ts` | 超出上下文窗口 80% 就压：早期的消息压成一条摘要，最近 20 条原样留着 |

第一版界面是 ink（React for CLI）：`src/app/`。到今天它还在，和桌面端共用同一份契约。

## 阶段 2：改成 cordis 装配

内核功能多了以后，`createCoreRuntime()` 里的手工接线开始互相牵制——一个服务想插进另一
个服务的流程就得改对方的构造函数。这一步把 `src/core/` 拆成**纯能力**，把**装配**交给
cordis：

- `src/plugins/*.ts`：一个插件一个服务，`inject` 声明要谁、`provide` 交出自己，注册一律
  返回清理函数；
- `src/host/kernel.ts`：`createKernel()` 按顺序挂内核插件；
- `src/contract.ts`：UI 与运行时之间的中性契约 `DscRuntime`，TUI 和桌面端消费同一接口；
- `src/adapter/transcript.ts`：把内核事件折叠成 UI 快照（订阅即推全量快照，UI 不做增量合并）。

这一步带来的真正收益在后面：**加功能不用碰循环**。后来这两个官方插件（子智能体团队、
电脑操作）都没有改 `loop.ts` 的执行逻辑，只在扩展点上挂东西。

## 阶段 3：桌面端

结构是「一个 Electron 壳 + 一个独立的运行时子进程」：

```
electron main ──(node utilityProcess)──→ lib/host-stdio.js ──createKernel()──→ cordis 上下文
      │                                        │
      └──── IPC 'dsc:invoke' / 'dsc:event' ◄───┘  stdio 上一行一条 JSON
```

为什么不把内核跑在 Electron 主进程里：崩了不能带走窗口，而且内核要能被 TUI 和
headless 复用。代价是多一层协议——协议面刻意做窄：

- 只有 `src/plugins/host-stdio.ts` 白名单里的方法能被 renderer 调到；
- 协议版本常量 `HOST_PROTOCOL_VERSION`（`desktop/electron/main/protocol.ts:36` 一侧，
  `src/plugins/host-stdio.ts:25` 一侧）；
- 运行时启动即推 `hello { protocolVersion }`，对不上就报错，不做静默兼容。

同期加的：`desktop-dock` 服务（终端输出流与浏览器视图推给右侧 dock 面板）、关窗缩到托盘、
记住最近工作目录。

## 阶段 4：会话库

会话多了以后，「看不见但占地方」的老会话要能收起来。这里的关键决定是：**归档状态不进
jsonl 本体**。

- `sessions/meta.json` 存 sidecar（归档 / 置顶 / 改名），jsonl 只追加写；
- 归档 = 把文件挪进 `sessions/.archived/`；「永久删除」其实是挪进 `~/.dsc/.trash/`，
  超过 30 天才会被扫掉（`src/core/session.ts:388-417`），所以删错了还能手工救回；
- 分叉 = 复制一份新 uuid 的新文件，原会话一个字节不动。

于是侧栏有了工作区块（按工作目录分组）、拖动排序（落盘在 `desktop.json`）、搜索与排序。

## 阶段 5：技能中心与外置设置分区

两件事同属一个主题——**让界面能被非内核代码扩展**。

- 技能：`SKILL.md` 发现 → 开关 → 注入系统提示 → 市场源安装；
- 设置分区：插件调 `ctx.settings.defineSection()` 注册一个分区，控件只有
  `text`/`number`/`select`/`switch`/`info`/`button` 六种（`src/contract.ts:261-267`），
  样式由桌面端统一决定，插件**拿不到 DOM**；
- 值存 `plugins.json` 条目里的 `config`（`writePluginConfig`），不塞进插件条目树的 `config`
  之外的第二份状态文件里（这条最初写的是 `settings.json` 的 `pluginConfig`，后来统一到
  `plugins.json` 那份：装配时喂给 `apply()` 的和设置分区写回的是同一个地方，少一条通路）。

## 阶段 6：插件中心分三档

原始问题：用户把插件中心当成「开关中心」，点进「技能」才发现技能中心在隔壁。定下来的
界面模型是**能力层级**，从上到下：

| 档 | 判定 | 开关 |
| --- | --- | --- |
| 自定义 | `source: 'external'`（`~/.dsc/plugins/*.js`） | 可拨，默认开 |
| 官方可开关 | `source: 'builtin'` + `toggleable: true` | 可拨，`defaultDisabled` 决定默认 |
| 运行内核 | `source: 'builtin'` 没标 `toggleable` | 不给开关，只露 3 行，其余折叠 |

配套的内核改动：`PluginMeta` 新增 `toggleable` / `defaultDisabled` / `settingsSection`，
`KERNEL_API_VERSION` 升到 **3**（`src/core/plugin-registry.ts:67`）。

三条当时讨论过的取舍，记下来免得下次再吵：

1. **官方可开关插件和自定义插件不合并成一档**。合并省事，但用户会以为关掉官方的也能像
   删外部文件那样把它清掉；
2. **运行内核给「只读显示」而不是完全隐藏**。全藏会显得像黑箱，露 3 行 + 折叠能一眼看出
   「dsc 自己也是由这些零件拼的」，而且这个解释只写在分组标题下那一行副标题里；
3. **插件没打开时不给「配置」入口**。分区是插件挂上来时才注册的，关着点「配置」只会看到
   「这个插件没写设置项」——那行字比不给按钮更让人困惑。

## 阶段 7：子智能体团队

设计约束来自一句判断：**「它只能干你交代的那件事」必须能讲清楚，不能靠自觉**。所以做成
权限面收窄的执行体，而不是「另一个聊天窗口」：

- **上下文**：独立会话文件 + 派活文本 + 共享任务板，看不到父会话历史；
- **工具面**：只给文件与命令那几件，内核工具一律不给；
- **权限**：全局只读 ⇒ 队友一律只读；全局自动接受 ⇒ 队友只放行读类；
- **审批**：三档（不允许 / 允许并标注 / 仅前台子允许），**默认不允许**——默认关是用户
  定的，理由是不希望「没盯着的时候有人替我点允许」；
- **深度**：`1 = 只有 Lead 能派`，`0 = 彻底不派`，默认 1；
- **额度**：`maxTeammates` 管的是**同时在干活**的队友数，干完的不占额度（否则额度会被
  历史记录吃光，这是实现中途改的，见坑 8）；
- **可见性**：侧栏「队友」档点开是**只读查看**，不切进活会话。用户明确选了这条：读它的
  过程可以，替它发言不行。

队友的运行记录落在 `sessions/.teammates/<cwd>/<id>.jsonl`——点开头的目录被会话扫描跳过，
所以它们不污染会话列表；`assertSessionFile` 对归档 / 永久删除 / 分叉一律拒绝。

## 阶段 8：电脑操作

Windows 桌面控制（PowerShell + Win32 API）。安全姿态和子智能体一样：**每次动手都要审批**，
读类（截屏、光标、窗口列表）可以选免审批。

两条设计：

1. **看与动分两个工具**。开着免审批时给 `computer_look`（`risk='read'`），关掉免审批时看
   屏动作合回 `computer` 一起走审批——一个动作永远只有一个入口，模型不会遇到「同一件事
   该调哪个」；
2. **旧截图只保留最新一张**。插件用 `prompt.transformMessages` 扩展点在发给模型前把历史里
   较早的自截图像换成一行说明文字，会话日志不动。一次点十几步时，这个省的是大头。

## 阶段 9：验证与踩坑台账

这个项目没有单测框架，验证靠三样：`tsc` 类型检查 + `shots/*.mjs` 自检脚本 + 打包版实拍。
自检脚本的共同约定：**全部跑在临时 HOME 上**，真实 `~/.dsc` 一个字节不动。

| 脚本 | 管什么 |
| --- | --- |
| `node shots/team-check.mjs` | 角色文件、任务板、队友日志隔离、插件登记与配置、桌面护栏、旧截图裁剪、内核装配、侧栏清单与只读查看（98 条） |
| `node shots/storage-check.mjs` | 会话存储与会话库操作 |
| `node shots/llm-retry-check.mjs` | LLM 重试（连接失败与 429 会重试，400 与已取消不重试）与版本号读取（10 条） |
| `node shots/order-check.mjs` | 侧栏工作区块排序落盘 |
| `node scripts/composer-test.mjs` | TUI 输入候选面板 |
| `node shots/seed-peek-home.mjs <目录>` | 给「队友只读查看」这张截图铺临时 HOME |

实拍靠打包版的环境变量钩子（`desktop/electron/main/index.ts:292-329`）：
`DSC_DESKTOP_SHOT`（截图并退出）、`DSC_DESKTOP_SHOT_DELAY`、`DSC_DESKTOP_SEARCH`（直接打开
某个界面）、`DSC_DESKTOP_USER_DATA`（独立 userData，单实例锁不跟已开着的打包版抢）。

### 真 bug 台账

这些是真跑出来的，不是推测。括号里是现在的回归用例所在。

| # | 症状 | 根因与修法 |
| --- | --- | --- |
| 1 | 只保存配置值，默认关着的插件被点亮了 | `writePluginConfig` 新建条目时硬写 `disabled: false`。改为沿用元数据声明的默认开关（team-check：「只存配置值不会把默认关闭的插件点亮」） |
| 2 | 查前台窗口时标题被截断 | 前台窗口那段文本自己带竖线（`进程\|标题`），`split('|')` 切多了。改成只按第一个竖线切、其余拼回（team-check：「前台窗口查得到（进程\|标题）」） |
| 3 | 默认配置下模型没法「先看后动」 | 看屏动作被默认配置从 `computer` 里过滤掉了，等于闭环死了。谓词写反，改成「只有开了免审批才把看屏挪去 `computer_look`」（team-check：「动手工具的参数里带上了动作清单」+ 免审批两向断言） |
| 4 | 打包版每 2 秒刷一条 `cannot get property "team" without inject` | cordis 的上下文代理对没 `inject` 的属性是**直接抛**，`ctx.team?.` 也救不了。改用 `ctx.get('team')`。这条只在打包版暴露——自检脚本里没走过这个调用路径，是实拍时看日志抓到的（team-check：「团队没开时问队友清单拿到空表而不是抛错」） |
| 5 | `claim_now: true` 没让任务进 in_progress | 建任务时只写了 owner，没走状态迁移。改为建完再发一次正常 `claim`，依赖没做完照样被拦（team-check：「任务板工具能建任务并直接认领」） |
| 6 | 没写 `name` 的角色文件全被判「角色名不合法」 | 角色名从整条路径取，带上了目录和 `.md`。改成取文件名（team-check 角色文件段） |
| 7 | 收工的队友把额度吃光，派不出新队友 | 额度按注册总数算。改成只算 `state === 'working'`，收工的最多在名册里留 12 条（`MAX_LISTED_FINISHED`） |
| 8 | 提示词里写「并发上限 N」，实现却是「不排队、派满就拒」 | 提示词和设置文案一起改成「同时干活上限」，并写明「干完的不占这个额度。派满再派会被直接拒绝，不排队」 |

自检脚本自己也错过三条，记下来免得下次同样栽：断言前没注册插件元数据（未注册的插件按
「启用」算）、把 `toggleable` / `enabled` 猜成了 `canToggle` / `disabled`、以为
`createKernel()` 返回的对象带 `dispose()`（它返回的是 cordis `Context`，没有这个方法）。

### 复核出来的三处「注释这么说，代码不是这么做」

这轮写文档时逐行核对发现的。台账保留原始观察，只在每条后面补上现在的状态：

1. **压缩后的会话重新打开会变长**。压缩在内存里把历史换成「一条摘要 + 最近 20 条」
   （`src/core/compact.ts:70-71`），但重新加载时 `Session.load` 碰到 `summary` 记录只是再
   push 一条 user 消息，前面那批原始记录一条都没丢（`src/core/session.ts:120-122`）。
   `src/core/compact.ts` 文件头写的「重放时等价折叠」当时没有对应实现。
   **已修（阶段 11）**：`summary` 记录加 `keep` 字段记「尾部保留了几条」，重放时按它接回。
2. **网络错误不会重试**。`src/core/llm.ts` 的文件头注释说连接失败也重试，实际可重试条件
   要求错误带 HTTP 状态码且是 429 或 5xx；fetch 抛出的网络异常造出的 `LlmError` 不带
   status，因此直接上抛。
   **已修**：`LlmError` 增加 `retryable` 标记，连接失败（此时一个字节都没收到，重发安全）
   与 429 / 5xx 一起进退避重试；流已开始、或用户已取消，都不重试。
   回归见 `node shots/llm-retry-check.mjs`。
3. **设置「关于」里的版本号恒为 `0.0.0`**。`version.ts` 上溯 `package.json` 时按
   `name === 'dsc-tui'` 认包，而包已经改名 `muse-code`（打包时 [prepare-runtime.mjs](../desktop/scripts/prepare-runtime.mjs)
   把这份清单原样拷进 `dsc-core/`），于是永远匹配不上，上溯到盘根返回 `'0.0.0'`。
   **已修**：包名收进 `PACKAGE_NAMES = ['muse-code', 'dsc-tui']`，旧名留着兼容。

### 环境坑

- **`ELECTRON_RUN_AS_NODE=1` 会让打包版秒退**。在 harness 的 shell 里启动
  `dist/win-unpacked/dsc.exe`，它被当成纯 Node 跑，退出码 0、无输出、不写截图。拍图前必须
  清掉这个变量。
- **PowerShell 的 `Start-Process` 没有 `-Timeout`**。等进程要么 `-Wait`，要么
  `Start-Process -PassThru` + `Wait-Process -Timeout`。

## 阶段 10：功能点封装

这轮不改行为，只改「谁认识谁」。起因是一份只读体检：功能点之间互相点名，加一个新模式或
新卡片要回头改内核循环、改快照装配、改协议白名单，桌面端还自己抄了一份权限档位与模式档位
的文案。六刀切下去之后，四类新增功能各自只改自己那个插件。

| 刀 | 切之前 | 切之后 |
| --- | --- | --- |
| 声明出来的注入 | 6 个插件用 `ctx.get('mode')` 这类运行期取名，还有两个服务（compact、ui）压根没进 `Context` | 全部改成 `inject` 声明；`ctx.get` 只留给可能整个没挂的 `team`，`shots/modes-security-check.mjs` 有一条扫描脚本守这条 |
| 工具守卫链 | 循环按名字认识审批、模式闸门、遮红三个槽；审批卡反过来查当前模式（`mode` 已依赖 `approval`，反向就是环） | `ctx.guards.register()`：模式 10、审批 30，循环只问一条链；换档改由 `dsc/mode-changed` 事件通知 |
| 任务面拆开 | `plugins/tasks.ts` 一个 470 行插件管清单、计划、提问、目标，谁要用都得注入它 | 四个插件（`todo`/`plan`/`ask`/`goal`）各管一张卡片，服务也拆成四个 |
| 快照片段注册表 | `transcript` 装配快照时点名读模式、清单、计划、目标、提问五块 | 各功能点自己 `ctx.surfaces.register(id, 取值)`，装配层只问注册表 |
| 状态记录统一 | 会话日志里四种记录（`mode`/`todo`/`plan`/`goal`）各写各的，`Session` 上四对读写方法 | 统一成 `{type:'state', id, payload}` 一对（`appendState` / `state(id)`），老记录继续读得回来 |
| 旋钮进配置 | 审批超时、提问数上限、目标默认轮次、说明书预算、快照节流间隔写死在代码里 | 五处都改读各自插件的配置，并带上下限夹取；压缩保留条数与自动压缩触发线随后也挪了出来 |

顺手补的两处漏：`host-stdio.ts` 那份手写方法清单改成从 `keyof DscRuntime` 推（漏一个方法名
编译就报错，不再是运行期回一句「协议不允许调用」），桌面端 `RuntimeProxy` 同理改成映射类型。

`KERNEL_API_VERSION` 升到 **4**，因为多出了三个能被外部插件使用的扩展点（守卫链、快照片段、
等人登记）。

### 10.1 补刀：配置改完不必重启，两处旋钮进了界面

配置读法有个坑：内核挂载时把 `getPluginConfig('goal')` 当第二参数传进去，插件里写成
`passed ?? getPluginConfig(...)`，于是永远拿到挂载那一刻那份——设置分区保存了新值，
正在跑的插件却看不见（`subagent`、`computer-use` 的分区也一样中招）。现在统一走
`resolvePluginConfig(file, passed)`（`src/core/plugin-registry.ts:165`）：装配那份作底，
磁盘那份覆盖它，插件每次用值时现调，改完立刻生效。`compact` 与 `goal` 的两个数值各自
注册成设置分区（`src/plugins/compact.ts:140`、`src/plugins/goal.ts:259`），并在内核清单里声明
`settingsSection`（`src/host/kernel.ts:112`、`:117`），于是它们出现在插件中心那两条「运行内核」
详情的配置区里——设置面板按既定分工只列内核自己的六个分区，不收插件贡献的分区。
`GoalStore` 的缺省轮次改成取值函数（`src/core/goal.ts:35`），新建的目标马上用新上限。

审批卡的等待时限没做成分区：设置插件要用审批（「通用」分区里那个权限模式下拉框读写它的
档位），审批再反过来注入设置就是环，两个方向都等对方挂载会挂不起来。这一项留在手写配置里，
每次弹卡现读，改文件后下一张卡生效。

## 决策台账

写下来是为了下次不用重新推一遍。

| 决定 | 理由 |
| --- | --- |
| 两个官方插件**默认关** | 都要人工看着才放心；默认开等于替用户做了安全决定 |
| 队友审批默认**不允许** | 同上，且这条一旦放宽就是「有人替你点允许」 |
| 队友**只读查看**，不做活动视图 | 读过程够了；能发言就意味着我能打乱它的上下文 |
| 内核插件**给折叠显示**而不是隐藏 | 露 3 行能让「dsc 也是插件拼的」这件事自解释 |
| 关着的插件**不给配置入口** | 分区还没注册，点进去只有一行「没写设置项」 |
| 示例插件**保留并改名** `computer_demo` | 删了就没人手写插件的参照；改名避免和内置插件撞 file 键 |
| 写/执行类**不留持久授权** | 对齐 one-shot 语义。个人机器上「上次同意过」不该等于永久同意 |
| 归档状态放 sidecar 不进 jsonl | jsonl 保持纯追加，重放逻辑不被界面状态污染 |
| 守卫自己抛错按「拒」处理 | 安全链上「算不出来」不能等于放行；原因原样回给模型比偷偷放过好收拾 |
| `ctx.get` 只允许用于可能没挂的插件（目前只有 `team`） | 运行期取名会把「用了谁」藏起来，漏声明就是运行期炸一次；扫描脚本守住这条 |
| 界面快照里各功能点那块状态由各功能点自己登记（`surfaces`），不塞进 `status` 行 | `status` 只放跨功能点都认的几样（会话、模型、档位、回合状态）；加一块卡片不必回头改装配层 |
| 提示词段次用固定刻度（0/10/20/30/60/200/210/890/900），工具清单不随模式变 | 模型提供方的提示词缓存要求前缀稳定；模式只改「模式条款」那一段 |
| 插件取值走 `resolvePluginConfig`（磁盘那份覆盖装配那份） | 设置分区写的是磁盘：只在挂载时读一次的插件，改了数值要么重启宿主要么重挂插件；每次用值时现读，界面和文件说的就是同一句话 |
| 旋钮的分区由那个功能点自己注册，做不到就不做 | 让设置插件替审批写配置等于界面层跨功能点写别人的值；审批注入设置又和现有的 `settings → approval` 成环，两头互相等会挂不起来，于是审批的等待时限只走手写配置（每次弹卡现读） |

## 欠账

**只能人手点的**（自动化测不到，谁用谁顺手验一下）：

- 侧栏拖动排序后重开还在不在
- 每行 `···` 菜单（归档 / 改名 / 永久删除 / 分叉）
- `Ctrl+Alt+R`（整页重读）、`Ctrl+Alt+F`、`Ctrl+Shift+A`
- 切工作目录、分叉选点、托盘「完全退出」
- 真派一个队友跑通全流程（要模型 key，会花额度）

**已知限制**（README 里也有，这里补齐）：

- 无沙箱：`bash` 与写文件是全权限，靠审批卡兜底，只在个人机器上用；
- 跨进程的模型/思考强度不落盘，重启宿主回到配置默认；
- Windows 中文输入法可能吃掉审批卡的 y/n；
- 队友的运行记录不进会话列表，也没有搜索入口，只能从侧栏「队友」档点进去；
- 电脑操作只在 Windows 上可用（PowerShell + Win32）。

## 阶段 11：压缩重放、灾难地板与六个新插件

这一轮落地了两件事：压缩子系统（修重放 bug + 借 hermes 的 lean 压缩提质），以及六个新的官方可开关插件——`approval-floor`（审批灾难地板）、`spill`（大输出溢出）、`session-search`（会话全文检索）、`lifecycle-hooks`（codex 十二事件钩子）、`mcp`（MCP 客户端）、`tool-search`（工具渐进披露）。前三个默认开，后三个默认关。配套新增了各自的自检脚本，另加一份起真内核跑两遍装配的 `shots/integration-check.mjs`——功能点自己的自检用假 `ctx` 验判定逻辑，没人验过「登记进 `kernel.ts` 之后还挂不挂得上、守卫次序对不对、工具真进没进注册表」，这份补的就是这一段。

阶段 9 那份台账里「压缩后的会话重新打开会变长」这轮修掉了，改法与理由见下表。

| 决定 | 理由 |
| --- | --- |
| 摘要记录加 `keep` 字段记「尾部保留了几条」，重放时按它接回 | 日志是 append-only，摘要之前的原始记录一条都没删：只改成「遇到 `summary` 就把消息清空」的话，清空之后没法知道压缩当时留了哪几条尾部，最近几轮对话会被一起丢掉。`keep` 是唯一能从日志还原「摘要 + 保留尾部」的凭据；老日志没这个字段按 0 走，退化成「摘要 + 摘要之后的记录」，比把原文整段读回来（压缩等于白压）好 |
| 压缩切点先退到安全边界（`safeCut`） | 协议要求每条 `tool` 消息紧跟在带同 id `tool_calls` 的 assistant 消息后面，从中间切开会让压缩后的第一次请求直接 HTTP 400；退到那条 assistant 上，工具调用与它的结果一起留在尾部 |
| 锚点索引与用户原话直接附在摘要消息里 | 模型写的叙述会漏 SHA、文件路径、报错原文与用户原话，这三样换成正则抽取与逐字引用，不经模型改写。它们全是纯函数（`src/core/compact-anchors.ts`），可以脱开模型单独断言 |
| 灾难地板排在守卫链 order 5（模式 10、安全钩子 20、审批 30 之前） | 守卫链是「第一位给出 deny 或 pass 的赢」：模式闸门对只读工具、只读命令与工作区内的写直接返回 pass（`src/core/modes.ts:104`、`:135`），它一返回 pass，后面的安全钩子与审批就再也拿不到发言权；权限模式的「完全访问」还会在审批层直接放行（`src/plugins/approval.ts:334-337`）。所以「灾难命令连满权限也不许跑」只能由排在它们前面的一位自己完成 |
| 地板自己判定，不注入 `mode` 服务；配置读不通时照样挂载却一律拒 | 注入会让地板在模式插件没挂时压根不 mount，挂不上等于链上根本没有地板（fail-open）；配置读坏的处置同理——全部拒掉让用户看见问题去改，比静默放过安全 |
| 溢出观察者排在遮红之后（order 50 > 10） | 标记链按 order 从小到大加工，后一位看到前一位的输出：先遮红再落盘，磁盘上写的是脱敏文本。反序会把脱敏前的原文留在磁盘上，而回给模型的预览是脱敏的，泄漏悄无声息。`shots/spill-check.mjs` 把顺序故意反着挂了一次，断言原密钥真的会落进文件，证明验的是顺序不是巧合 |
| 溢出跳过 `read` 工具 | read 的结果就是模型点名要的那一段，再落盘只会让它照预览里的续读写法再去 read 一次，又溢出、又落盘，形成活锁 |
| MCP 的 `deferSchemas()` 只撤动手类（write / exec）工具的 schema | 只读 MCP 工具靠 `risk: 'read'` 免审批；把它们一起撤下，模型每次只读都得走 `tool_call`，而 `tool_call` 自己是 exec 档、每次都要过审批卡，「只读免审批」反倒变成「每次只读都弹卡」 |
| `tool-search` 必须排在 `mcp` 之后装配 | tool-search 在 apply 时用 `ctx.get('mcp')` 取 MCP 服务；排在前面拿到的 `undefined`，它自己的目录里只剩撤下的注册表工具，MCP 的 schema 永远不会被撤 |
| `tool_call` 执行前按真名重走一遍守卫链 | 桥接工具看到的工具名不能是 `tool_call`：模式闸门、安全钩子、审批卡与会话日志要记的是真实工具名与真实风险，否则「谁被批准了」事后查不出来 |
| 默认开关的规矩：会拉起外部进程、连外部服务器或改写每轮请求工具面的默认关，提升安全与本地便利、不配也不影响别人的默认开 | 默认关的是 `lifecycle-hooks`（跑外部命令）、`mcp`（连外部服务器）、`tool-search`（改写每轮工具面），加上原有的 `subagent`、`computer-use`；默认开的是 `approval-floor`、`spill`、`session-search` 与 `web-search` |
| 生命周期钩子单读一份 `lifecycle-hooks.json`，不复用安全钩子的 `hooks.json` | 安全钩子是 dsc 自己的四个事件，这份是 codex 的十二个事件名。共用一份文件等于两个插件抢同一份配置，谁也读不到完整的一份 |
| 十二个事件按 wired / partial / unwired 显式声明能力与理由 | 用户不该猜哪个事件配了会跑：PermissionRequest / PreCompact / SubagentStart / SubagentStop 在 dsc 里没有可挂的扩展点，配了也不执行，只把原因写进报告 |
| 会话检索自己写倒排索引，不引 `node:sqlite` | 个人版零新增依赖；中文按 1-gram + 2-gram 切词，「内存」这种 2 字词因此能命中，trigram 会漏。索引是旁路缓存，删了下次重新回填，会话 jsonl 一个字节都不动 |

### 设置分区 save() 返回值的不一致（本轮已修）

`src/plugins/settings.ts` 原先让分区 `save()` 与 `action()` 共用同一个 `mutate()`，把返回的字符串一律当成**成功提示**；而 `src/services/types.ts` 的 `SettingsSectionSpec.save` 注释写的是「抛错或返回字符串 = 失败原因」。于是 `web-search`、`compact`、`approval-floor`、`spill`、`session-search`、`lifecycle-hooks`、`tool-search` 这些按注释契约写、把校验错误当字符串返回的分区，校验失败时界面弹的是绿色提示条，错值却已经落盘。
改法是给 `save()` 单开一条 `mutateSave()`（返回字符串即失败原因），`mutate()` 留给 `action()` 与 `saveProvider()` / `removeProvider()`——后面那几条的返回值确实是完成提示（例如「已添加端点 X」），不能一起改成错误语义。`src/plugins/mcp.ts` 原先靠抛错绕开这层语义差，改完两条路等价，它的写法不用动。
回归断言写在 `shots/integration-check.mjs` 的「设置写入的返回值契约」一节：注册一个探针分区，分别验 `save()` 返回字符串按失败处理、`save()` 不返回按成功处理、`action()` 返回字符串仍按成功提示处理。

---

## 阶段 12：安全判定的五个洞与「没人能应答」的审批卡

第一轮交付后按同一份红线复查判定层，用真内核实测出五个洞。判定层的共同毛病是**用一个信号替代了整件事**：只读与否只看第一个词，包装与重定向没参与判定；正则的边界写错一个字符，规则就静默失效。

| 决策 | 理由 |
| --- | --- |
| 灾难地板只判「拒」或「不拒」，命中白名单也走 `defer` | 守卫链是「第一位非 defer 的赢」，地板 `pass` 会连带跳掉 order 20 的安全钩子与 order 25 的生命周期钩子，那不是白名单的本意。改由 `ctx.provide('approvalFloor', …)` 把结论交给审批层免卡放行，用户自己的钩子照常被问到 |
| 去掉灾难地板对协作模式的依赖 | 地板原先在白名单命中时还要再问一次模式闸门；改成只 defer 之后，模式闸门（order 10）本来就会自己说话，地板再问一遍是重复判定。顺带把 `ApprovalFloorOptions.mode` 与 `SHELL_HEADS` 之外的注入都收掉 |
| 只读判定不看「第一个词」，要看「这段到底会不会动东西」 | 实测「计划模式 + 仅查看权限」下 `python -c` 删根、`find . -delete`、`sed "e …"`、`echo x > 任意文件` 全部被 `pass` 执行。补齐四类判据：重定向（引号外的 `>`，`2>&1` 除外）、解释器（`node`/`python`/`perl` 等，python 仅 `-m pytest`/`-m unittest`/`-m json.tool` 例外）、`env` 剥壳、以及 `find` / `sed` / `awk` 的写与执行开关 |
| 白名单放行要保留「跑测试」这条日常路径 | 把 `python` 整体踢出只读名单会连 `python -m pytest` 一起拦住，而计划模式的提示词明确说可以跑测试。所以 python 走子命令白名单，而不是一刀切 |
| 审批卡「没人能应答」由入口登记判定，不靠 `process.stdin.isTTY` 猜 | `tui` 与 `host-stdio` 各登记一份 `interactive` 服务，`reachable()` 是各自的传输状态（标准输入关了 / 父端口还在）。审批层读不到登记且本进程不是终端直连时，直接按拒并写明理由。`approval-floor.ts` 原来那句「dsc 没有可靠的宿主交互信号」是错的：入口是确定的 |
| 灾难命令的自检断言必须连带验耗时 | 只断言 `deny` 会放过「等审批超时按拒」这条路径——第一轮交付里 `format C:` 就是这么判成通过的，同时把 `integration-check` 拖成 300.6 秒。改成「是地板当场拒且 < 1 秒」，那 300 秒立刻变成红灯 |

改动落在 `src/core/command-policy.ts`（正则、`HARDLINE`、只读判定、`CommandSegment.redirect`）、`src/core/approval-floor.ts`（`SHELL_HEADS` 补 `cmd`、白名单改 defer、`whitelist()`）、`src/services/types.ts`（两个新服务类型）、`src/plugins/approval.ts`（白名单免卡 + 无人应答快速拒）、`src/plugins/approval-floor.ts`（登记服务）、`src/plugins/tui.ts` 与 `src/plugins/host-stdio.ts`（登记界面可达性，`Transport` 加 `reachable()`）。自检改动：`shots/integration-check.mjs` 加四节（只读判定、白名单不截断链、没有界面时的审批卡、界面可达性按兄弟插件接线），`shots/approval-floor-check.mjs` 里按旧行为写的五条断言改成新语义。

---

## 阶段 13：第五轮官方插件（沙箱 / 定时任务 / LSP / 浏览器 / 自我改进）

一次补齐对标清单上 T8、T9、T11、T12 四项，全部做成官方可开关插件（共十四个），内核只开了一条缝。分批落盘：内核缝与沙箱 → schedule → lsp → browser → self-improve（含登记）→ 文档。

| 决策 | 理由 |
| --- | --- |
| 沙箱走 codex 路线（策略面 + 降级为审批兜底），不走 dsh 的 fail-closed | 沙箱默认开，fail-closed 会在强制层不可用时把用户的所有写入拒掉，那不是「更安全」是「更难用」；codex 的语义是「说拦得住和真拦得住是两件事，如实上报 `enforced`」。受限令牌后端明确不做：纯 TS 拿不到，`runas /trustlevel` 只降令牌完整性、不改 ACL，隔离是假的 |
| 真隔离只留一条路：容器后端，且默认不启用 | 容器里只有 sh，Windows 的 PowerShell 语法跑不通，只有用户显式选择才启用；执行体替换靠内核新增的命令执行器缝（`src/core/tools/command-runner.ts`），没有注册者时 bash 行为与从前完全一致 |
| 沙箱守卫 order 8，早于协作模式 10 | 沙箱管「能不能」，审批管「要不要问」；一次调用先过物理围栏再谈交互，拒绝理由里带档位、可写根与「怎么合法地做」 |
| 可写根按每次调用的 `input.cwd` 算，不用挂载时的 `process.cwd()` | 同进程里不同会话的工作目录不同，拿挂载时的 cwd 当基准会把别的会话的合法写入误判成越界（集成自检真实逮到过） |
| schedule 的至多一次：先落盘推进 `nextRunAt` 再投递 | 崩在投递中途靠 `pendingSlot` 恢复一次，重启不重复投；catch-up 只补最近一次错过的，不补积压（一次恢复炸上下文比漏一条提醒更糟） |
| 定时投递明写「不是用户指令，不构成授权」 | 定时输入 ≠ 用户授权（codex `UserInputOrigin` 的分级）；投递前问 `ctx.waiting.any`，不改 goal 的 rounds、不给 goal 上膛，不隔着一挂卡硬推 |
| LSP 只做导航四件事，诊断走注入不走工具 | rename/codeAction/format 要 ApplyEdit + 审批且与 write/edit 重复；「本次编辑新引入的 ERROR」才是模型当下需要的（照 hermes 的 reporter 收敛体积）。无状态同步（读盘→didOpen→请求→didClose）天然没有脏文档 |
| 浏览器快照发 ref、动作只收 ref，且加 ref 代际校验 | 坐标方案对布局漂移太脆；无障碍树浏览器已算好 role/name，不自算。代际校验（动作前 `DOM.describeNode` 复核）是三家成熟实现都没做干净的一处，页面一变就报「重新 snapshot」而不是点错 |
| 自我改进先立写入门再谈自写 | dsc 的技能原本只读：`skill_write` 强制 read-before-write、`.bak` 备份、台账可回滚、威胁扫描不过就还原、archive 只搬不删；L2 产物**默认停用**待人启用；L1 候选**不进系统提示**——这三道门是「模型能写」与「模型能污染」之间的全部距离 |
| 内核 API 升到 v5，但只加一条缝 + 一个可选服务 | `ctx.get('sandbox')` 是唯一的新插件可见能力；命令执行器缝只开给随包发布的内置插件。五插件各自一个独立目录（`src/core/{sandbox,schedule,lsp,cdp,learnings}/`），互不 import |

验收：五个单元自检全绿（sandbox 193 / schedule 207 / lsp 167 / browser 210 / self-improve 181，全部 0 FAIL，跑在临时 HOME 上），两份集成自检全绿（既有 95 条 + 新增 m5：起四次真内核验登记/挂载/热卸载/沙箱不误伤），全套既有回归 15 个脚本 0 FAIL。过程中自检真实逮到并修掉的实现 bug：LSP 的 pending 结账先清表后 settle（挂着的请求永不落地、进程 exit 13）、启动失败不透传 stderr 尾巴、PATHEXT 候选顺序错；self-improve 的 store 重复声明会话状态键（项目编译失败）；沙箱可写根误用挂载 cwd。

阶段 13 补记（交接时容易漏的三件小事）：内核侧除执行器缝与 `sandbox` 服务外，`SessionStateMap` 也加了一个 `learnings` 键——形状故意留 `unknown`，core 层不认识插件层类型，读回一律过 `normalizeLearningsState` 收口；plugin-development 的内核 API 版本表原先只写到 v2，v3/v4 两行一直只在 `src/core/plugin-registry.ts` 的注释里，这次连同 v5 一起补全；两个被自检逼出来的架构事实进了 development.md §4——命令补全面（`src/plugins/commands.ts` 的模块级 `extraSpecs`）是进程级共享，同进程起多个内核验「热卸载无残留」必须先 `await ctx.fiber.dispose()`（cordis 的 `Context` 本身没有 dispose，fiber 在 `ctx.fiber` 上）。

---

## 阶段 14：全面对标审查（codex / hermes / dsh）与九项修复

四路并行源码审查（dsc 深审 + 三家参照盘点），报告落在 `docs/audit-2026-09-29.md`。审查发现两条高危并当轮修复，其余按优先级分六批落地（`180dc05` → `aff6f68`），收尾时全量 23 个检查脚本 0 FAIL。

| 发现与决策 | 理由 |
| --- | --- |
| 命令切段漏洞是全仓唯一能被持久化规则放大的免审批执行面 | `OPERATORS` 里的 `'\n'` 是单字符、切段只认 2 字符切片——多行命令永远是一段；配上前缀规则只看前 N 个词元、allow 命中即 `continue`，`git status` 的授权会被「git status⏎curl evil」整条继承。修法把换行/孤立 `&` 入切段点、allow 只放干净段，并顺手堵掉同族洞：反引号与 `$()` 替换段不再算只读（`echo $(node -e …)` 原来免卡） |
| dsc 控制文件的保护落点在 plugins.json 而非 settings.json | 审查报告初稿把 LSP/browser 配置写成 settings.json，动手前核实：真实落点是 `~/.dsc/plugins.json` 条目树的 config（LSP 服务器、MCP 服务器、浏览器 executablePath 全在里面），settings.json 是 UI 偏好与市场源。必问清单补进 plugins.json / hooks.json / **hooks-trusted.json**（钩子脚本批准名单可被直接写入=自己盖章） |
| 中断后的 tool 消息缺口是协议洞不是体验问题 | 主循环 abort 后直接 return，剩余 tool_call 没有对应 tool 消息，下一轮请求 400。并行化改造时一并对齐 dsh 的做法：未启动的调用补「用户取消」合成结果，已启动的排干 |
| 压缩的两处失手要分开修 | chars/3 对中文低估近一半（DeepSeek 中文 ≈0.6 token/字），自动压缩等真实用量冲过窗口才触发——估算改成 CJK 0.65/其余 0.33 分开算；估算再准也有失手时，补上 dsh 式兜底：请求报爆窗 400 就 `forceCompact` 一次再重试一轮 |
| 「纯 TS 做不了 Windows 受限令牌」的旧结论修正为「做得到但要 koffi」 | dsh 的实现桥是 koffi 3.1.1 FFI（runner 进程内直调 CreateProcessAsUserW，完全绕开 Node 的 spawn），移植约 1.5-2k 行、一个专项迭代；只做 ACL deny 半套证实要么无效要么全局自伤。移植列远景，本期不动 |
| secrets 超 4MB 跳遮红改按行分段，不做偏移量拼接 | 密钥形状（sk-、JWT）不跨行、PEM 整块夹在相邻换行之间——切点落在换行上就不会把真密钥切成两半，比正则命中收集+绝对坐标替换的方案少一整类 bug |

改动落在 `src/core/command-policy.ts`、`src/core/path-policy.ts`、`src/core/loop.ts`、`src/core/compact.ts`、`src/core/prompt.ts`、`src/core/llm.ts`、`src/core/tools/bash.ts`、`src/core/session.ts`、`src/core/secrets.ts`、`src/core/cdp/launch.ts`、`src/plugins/{compact,agent,desktop-dock}.ts`、`src/services/types.ts`。自检断言同步：modes-security 新增 17 条回归（切段、替换段、控制文件必问），browser-check 2.5 翻转为「不放开 --remote-allow-origins」。验收：全量回归 23 个脚本 0 FAIL（含 approval-floor 95、browser 210、sandbox 193、schedule 207、lsp 167、self-improve 181、compact 53）。

---

## 阶段 15：Windows 强制沙箱（受限令牌 + 专用账号网络第二级）

推翻阶段 13「受限令牌后端不做」的旧决定（用户拍板引入 koffi 换真隔离），两个并行子智能体（DeepSeek V41 Flash）分别交付 FS 强制层与网络第二级，主控做接缝、账号分支与集成。分两批落库：FS 层 `ddc0aa7`、网络层 `2ee5f6f`。

| 决策 | 理由 |
| --- | --- |
| 隔离执行体用「runner 子进程」而不是宿主内直调 CreateProcessAsUserW | koffi 传显式环境块必报 ERROR_INVALID_PARAMETER——子进程环境只能靠继承；TMP/TEMP 重定向要在不污染宿主的前提下生效，只能由短命进程改自己再 spawn。runner 顺带解决 CTRL+C 回收（SetConsoleCtrlHandler 忽略）与退出码全宽镜像；宿主 taskkill 杀 runner = 作业句柄随进程关闭，内核按 KILL_ON_JOB_CLOSE 收掉整棵受限子树 |
| 受限令牌 restricting 列表 = [logon SID, Everyone, …可写根能力 SID]，保活组绝不能省 | CNG 密钥隔离文件与每登录会话目录只授给登录会话 SID，缺保活组 DLL 初始化直接 0xC0000142（pwsh 0xE0434352）；完整性与默认 DACL（能力 SID 全权 ACE，否则沙箱进程建管道时被 pass-2 拦死自己）照 dsh 的实证配方 |
| WRITE_RESTRICTED 的「读不受限」是结构性缺口，如实报 partial 而不是装 full | pass-2 交集只对写生效；配合的读限制要换专用账号才有（pass-1 普通 ACL），那是网络第二级的事。诚实上报正是当年「半可靠比明说 partial 更危险」顾虑的解法 |
| ACL 只授可写根三件套（能力 SID Allow + Deny Everyone 删子项仅 CI + Low 标签），按路径幂等跳过整树重传播 | Deny 挂 OI\|CI 会把 FILE_DELETE_CHILD 落到每个文件、拒掉所有 FullControl 打开；幂等跳过是「大树首次传播几十秒」的唯一缓解；temp 授权可回收、工作区常驻；**read-only 档零授权**——该档令牌本无能力 SID，授权纯属永久改用户 ACL 的副作用 |
| 网络两级：一级软墙（codex env.rs 同款），二级 = 专用离线账号 + WFP 12 条持久 filter + 防火墙 5 规则 + 本地白名单代理 | WFP 的 ALE_USER_ID 条件按账号 SID 限定——当前用户的进程不受影响，只有跑在专用账号里的沙箱命令被断网到只剩回环代理口；代理按 CONNECT 域名判定、TLS 原样中继：对「管控」与 codex 的 MITM 等价（没进清单的字节都出不去），省掉 CA 私钥落盘与证书固定两类新攻击面 |
| 账号分支：账号令牌**照样受限化**（pass-2 照旧），另补账号 SID 的读写执行 ACE | 假能力 SID 三件套只解决 pass-2；专用账号没有当前用户权限，pass-1 连仓库都读不了，必须补账号 ACE（掩码=读+执行+写删，仍不含 WRITE_DAC/OWNER）。代理端口与防火墙的环回补集一致（3128 → 1-3127,3129-65535）；代理起不来 = 账号出网全被 WFP 拦死等于离线——fail-closed，绝不静默放开 |
| doctor 的 WFP 探测降为提示项（不计 tier） | 非提权会话看不到 WFP 对象是 Windows 权限行为（engine 打得开、查询必被拒）；setup 脚本「首错即停」且账本写在 WFP 安装成功之后，②-⑤ 全绿已蕴含布防在位。不降级会让非提权环境永远 partial 假阴性 |
| 执行缝加可选自定义 spawn，本次实际没用上 | 起初以为受限令牌需要自定义 ChildProcess，runner 子进程方案让 SpawnPlan 用普通 `node runner.js … -- 原 argv` 就表达得下；缝留下（容器运行时 API 类计划用得上），bash 默认路径零改动 |

真机冒烟与自检逮掉的坑（每一处都有复现证据）：koffi 对超安全整数的 uintptr_t 回 **BigInt**（INVALID_HANDLE_VALUE 判 `===0` 会漏）；`byteArea().bytes()` 是 decode **副本**，当出参写不进原生内存（CreateWellKnownSid 回 122）；`Buffer.from` 小块切 **8KB 共享池**，`DataView(buf.buffer)` 从池原点读直接越界；JS 位运算 int32 符号坑（`0xC0000007 & 0xC0000000` 为负，保活组判定全跳过）；`CopySid` 返回 BOOL 被拿去跟字节长度比；**parseRunnerArgs 漏把 account 放进返回值**——账号分支被「静默跳过」，命令照常以当前用户跑且退出码一切正常（最危险的一类失败，靠真机探针逮住）。C 侧自检还抓到 LocalFree 误绑 advapi32（实际在 kernel32）且炸在 finally 释放路径上。

验收：FS 冒烟 19/19（越界写/删拒、读放行=文档化缺口、temp 重定向子进程可见、杀树内核收尾、降级、幂等、dispose 回收留标签）；网络自检 160/160（PS 5.1 parser 整份 719 行脚本只解析不执行、内嵌 C# Add-Type 真编译并跑结构体布局自检、DPAPI 往返含篡改必抛、PS 5.1 真写账本 → TS 真读的跨语言契约、WFP 探测三类返回不抛）；net-proxy 探针 4/4（白名单域真实建连、域外 403、总开关关全拒、日志对账）；全量回归 23 脚本 0 FAIL + sandbox 193/0 不回归。诚实边界：提权 setup 的端到端（UAC 那一下之后的 WFP 事务、防火墙规则接受性、DPAPI 跨提权解密）只能由用户点一次 UAC 实测，已写进 development-log 与设置页说明。


---

## 阶段 16：桌面版产品线与对话体验大版（0.4 → 0.6）

这一阶段跨三次发布（0.4.0 沙箱落地版、0.5.0 文件预览版、0.6.0 对话体验大版），核心是两条产物线的分离与桌面端的体验对齐：CLI（bin=msc，pnpm pack 出 tgz）与桌面版（desktop/dist，electron-builder）从此各打各的；全局 `dsc` 命令是 Junction 指向仓库本体的历史遗留，`msc` shim 需单独补建。六个并行子智能体（deepseek v4.1 flash）分五批交付，主控只做派发、验收与集成。

| 决策 | 理由 |
| --- | --- |
| 桌面运行时组装必须连带 `koffi` 与平台子包 `@koromix/koffi-win32-x64` | koffi 3.x 把原生二进制（`win32_x64/koffi.node`）拆在平台子包里，主包 `require` 时才加载；只拷主包，桌面版里选「Windows 受限令牌」后端会永远报「不可用」且不报错——静默失效比崩溃更难查 |
| 文件更改预览做成插件而不是改 tools 层 | codex 的实证形态（执行前算 unified diff、挂在审批请求上）映射到 dsc 就是守卫链 order 25（审批 30 之前）：永远 defer（返回 pass 会跳掉审批卡、返回 deny 是越权拦人），diff 以 system 条目进 transcript——这是仓库现成且唯一的「不经模型摆进对话流」通道；diff 算法零依赖自写（先削公共前后缀再 LCS，5000 行改 1 行 1.9ms），为一个几十行算法拉包不值 |
| transcript 条目补可选 `ts`，老日志全链路降级 | 每轮「时间 + 用时」需要真值；2026-09 前的 jsonl 没有该字段，重放老日志传 `ts=null` 绝不拿「现在」冒充历史时刻；`llm.ts` 发请求前剥掉 `ts`——协议里没这一项，多传会被挑剔的网关判 400 |
| 状态栏三段式（轮数/步数/速度、总 token、上下文占比）+ 每段详情卡，对齐 dsh | 拿不到的如实省略不造假：缓存命中率（服务端字段读取时被丢，日志里没有）、系统提示词与工具定义分项（宿主不上报构成，合并一行带 ~ 注明口径）；上下文占比用「最后一次请求输入 ÷ contextWindow」是服务端真值 |
| 悬停交互对齐 dsh：数量/时间隐藏、按钮接管同一槽位 | 「按钮出现在徽标左侧」的浮层方案保住了坐标但保不住「dsh 的手感」——用户拍板以 dsh 行为为准；菜单项图标补齐（重命名/分叉/恢复目录名），参差不齐比没有更难看 |
| 工具卡与思考过程统一「紧凑行 ↔ 展开区 + 400px 吸附快捷栏」 | 两个组件规格逐项同值（行高 26px、圆角 2.5px、过渡 100ms）；400px 量 scrollHeight 而非渲染高度（参数/结果各被 180px 夹住，读渲染高度加总永远到不了 400，快捷栏就永不出现）；sticky 落点在滚动容器内容盒顶端，吸住瞬间加 `.stuck` 用 box-shadow 补缝，否则盖住紧凑行下半截 |
| 刻度判定改「真实 scrollTop + 探针线 elementFromPoint 命中」+ 独立轨道 | 估算式判定经常与屏上对话不一致；贴底 32px 内高亮最后一轮（不加这条，边流边滚到底会一直亮倒数第二个）；轨道 = 正文 | 4px | 刻度 16px | 12px | 滚动条 8px，`right` 由 `--dsc-scrollbar-w` 算，滚动条画宽自动让位 |
| 分叉 + 编辑重发采用「分叉出新会话 + 自动重发」，不采用 codex/hermes 的就地截断 | codex 是 truncate+revert（旧 rollout 不删）、hermes 是软归档——底线都是「不销毁历史」；宿主现成能力就是 `forkSession`（按用户消息位置分叉），没有截断 API，改动面最小；编辑后自动发一轮（对齐 hermes），发送前先 `await openSession(新会话)` 再 submit——顺序反了会把改后正文追加回旧会话 |
| 重放幂等 + 折叠态按「会话 id + 内容条目序号」存档 | 子智能体先报「宿主启动迟到 session-open」——实测不成立（诊断插件盯全过程，恢复只重放一次）；真机制是每次开会话 `clear()+replayHistory` 整表重建、id 从 1 重发号，`key={entry.id}` 让 React 重挂、折叠态回默认；修复 = 重放内容与当前条目一致就整个 return + 折叠态改用序号做键（启动时历史追加在插件提示后 id 从 5、6 起，点开会话从 1 起，同一条卡两次重放 id 不同，序号才稳）——这是本轮最值钱的教训：**诊断结论必须带复现证据，上一个智能体的「实测」也要重验** |
| 托盘图标单独 32px 剪影 + 回退链 | 512px 水墨主图缩到 16px 只剩一团灰；`icon-tray.png` 缺失时回退主图标，托盘永远有图 |

验收：根目录 typecheck/build 0 错误；sandbox 回归 193/0；file-review 冒烟 59+9 全绿；桌面版 typecheck/build 通过；截图套件自检五批（sb-*/chat-*/tc-*/think-*/fork-*，全部走独立 `DSC_DESKTOP_USER_DATA` + 临时 HOME，真实 `~/.dsc` 零写入）——其中 fork 六用例取证编辑重发真的把改后文本发进了新会话、原会话保留、折叠态跨会话往返存活（`foldsSurvived=true`、`redundantReplayNoop=true`）。发布：`muse-code-0.6.0.tgz` + `dist/win-unpacked`（核心版本号以运行时读 package.json 为准，双线各自出包）。诚实边界：缓存命中率、prompt 构成分项、消息级时间戳宿主侧暂无上报，界面如实省略或带 `~` 估算并注明口径；编辑重发选分叉形态意味着旧会话保留，用户要「就地截断」需另立阶段（涉及宿主截断 API 的设计）。
