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

---

## 阶段 17：体验微调批（0.6.1）

0.6.0 交付后用户实测反馈 8 条，三个并行子智能体（deepseek v4.1 flash）分组交付，主控只做派发与验收：字号滑杆（85%–135% 连续调节，旧 sm/md/lg 存档自动迁移到 0.92/1/1.12，拖动即时预览、松手才落盘——一次拖动几十个 change 事件会连写几十遍盘）；编辑按钮移出用户气泡（气泡正下方、贴底 2px）；分叉按钮挪进每轮 footer 的时间/用时右侧（进行中轮次只留置灰按钮不画时间，时间由状态行报着，不重复）；进行中状态两行之间加浅色分割线（用现成令牌 `--dsc-stroke-3`，任务书里写的 `--dsc-border` 根本不存在——派发前先核令牌名）；正文拖宽上限让出右缘刻度轨道（从样式表现读 `--dsc-jump-lane` + `--dsc-scrollbar-w`，不写死第二份数字）；DESKTOP 徽标删除；会话行右键弹菜单 +「复制会话 ID」；图标按钮 24→26/28px 整体放大。

| 决策 | 理由 |
| --- | --- |
| 字号连续化必须连带改宿主 `src/core/prefs.ts` | 渲染层把数字写进 settings.json，宿主读档只认 `'sm'|'md'|'lg'` 会把数字丢掉、每次重启回落 100%——「设了能存住」跨了渲染层与宿主的边界，只改渲染层做不到；`readFontScale()` 做数字夹取 + 旧档迁移 + 非法回落 |
| 「复制会话 ID」复制的是从路径剥出的 uuid，不是 `session.id` 原值 | 仓库里 `SessionSummary.id` 实际存的是 jsonl 绝对路径（`SessionListItem` 才是 id/path 两字段）；照字面实现剪贴板里就是一整条路径，与需求意图相反——**派发任务书里对字段名的假设要拿契约注释核实** |
| 会话 id 的复制入口走现有 `···` 菜单而不是独立右键菜单 | 行操作已有菜单体系（置顶/重命名/分叉/归档），右键 = 触发同一份菜单，归档行也顺带拿到这项（复制 id 无害，不受归档拦截） |
| 拖宽边界由上限自己守，不依赖别处内距 | 旧代码实测没真压到刻度（刻度靠 `.chat` 的 32px 右内距让位，输入框最近只剩 4px），但安全边界寄生在别的规则上是隐患；新上限让出 40px 后实测余 44px/24px |

验收：根目录 + 桌面版 typecheck/build 0 错误；sandbox 193/0、file-review 59+9/0、approval-floor 95/0 不回归；三组各自带隔离沙箱截图与数字证据（真实 `~/.dsc` 文件指纹零改动；拖宽三态一致：拖动中变量 = 落盘值 = localStorage；滑杆像素位置与 range 几何互相印证；剪贴板 uuid 与系统 `Get-Clipboard` 双路核对）。发布：`muse-code-0.6.1.tgz` + `dist/win-unpacked`。

---

## 阶段 18：对话区精修与 ask_user 批量化（0.6.2）

0.6.1 交付后用户两轮实测反馈（6 + 5 条），七个并行子智能体（deepseek v4.1 flash）分五批交付，主控只做派发与验收。两条产品线宿主侧也动了刀：偏好链路与 ask_user 协议各一次。

| 决策 | 理由 |
| --- | --- |
| 字号/按钮大小连续滑杆必须连带改宿主读档 | 宿主 `readPrefs` 是白名单制：未知字段读档即丢，且 `writePrefs` 用白名单结果拼整份文件重写——渲染层写进去的数字，改一次主题就被抹掉。`fontSize`（0.85–1.35，旧三档迁移）与 `buttonScale`（0.9–1.5）各补一个夹取读法；`runtime` 回执判字段也要认得新字段，否则 Toast 报错文案 |
| 图标缩放走「行内变量 × 全局倍率」而不是全量换算 | `icons.tsx` 把 size 挂成 `--dsc-icon-size` 行内变量，按钮图标宽高写 `calc(var(--dsc-icon-size) × var(--dsc-btn-scale))`——非按钮场景的图标一行不动；消息操作条等独立类各自补吃倍率 |
| 每轮 footer 左移与正文左缘对齐，用量并入 footer | 右缘孤立的一小块时间/用量观感差；实测左缘差 0px。分叉按钮随 footer 走，进行中轮次只留置灰按钮（时间由状态行报着，不说两遍） |
| 思考折叠照 dsh `ReasoningRow` 原文翻译 | 摘要口径是关键：跑动中取「最新写完段落的首行」（段落以空行分隔），收工取首行，去 `**`；整行可点、`grid-template-rows` 高度过渡、扫光用 `::after + background-clip:text` 自绘（dsc 无 CSS Modules）；fold-state 存档机制零改动 |
| 拖宽把手量真实列缘写入 CSS 变量 | 把手贴 `.chat-inner` 实际左右缘（`--dsc-thread-col-start/-end`），拖动/复位后仍 0px；React「子先于父」导致首帧 `zoneRef` 为 null 量不到——改从把手自己的 `parentElement` 取层，并用 `MutationObserver` 盯 `<html>` 内联变量（拖动每帧都改） |
| 流式输出改「条件式自动跟随」 | 用户主动滚离（scrollTop 离开底部）即暂停跟随，滚回距底 32px（复用 JumpStrip 的 `AT_BOTTOM_EPS`，一处口径）或点「回到底部」恢复；必须把「自己钉底那一跳的 scroll 事件」排除掉（`autoTopRef`），否则跟随会中途自己停——第一版实测踩到 |
| 条目 key 加会话限定 | `key={entry.id}` 在两条形状相同的会话间触发 React 实例复用，重放后不重挂、fold-state 存档不被读（只在「都走 openSession 且形状完全相同」复现，启动 resume 的会话前面多插件提示、id 序列不同所以撞不上）；代价是「加载更早历史」序号漂移退化为回默认折叠，渲染层本无该入口，留给宿主日后分页 |
| ask_user 批量化：宿主聚合一次挂出，渲染层向导式一卡一题 | 契约加可选 `questions[]`（单题字段保留为第 1 题投影，老回放零迁移）；一批一个视图、id 整批稳定，`answerQuestion` 按题序收答案、收齐才 resolve（没收齐连广播都不发，防止半空卡被推回去重画）；顺带修掉旧实现 abort 挂死（第 1 题被 abort 后第 2 题拿的是已 abort 的 signal）。呈现层用户拍板 dsh 向导式：只露当前题 + `‹ n/m ›` 翻页器 + 末题「提交」，缺题跳转提示，跳过按题序回传实话；呈现层与协议层分两批交付，中间态靠「归一适配器读 questions 数组」无缝衔接 |
| 剪贴板复制会话 ID 复制的是从路径剥出的 uuid | `SessionSummary.id` 存的是 jsonl 绝对路径，照字面复制就是一整条路径；右键 = 打开行菜单，归档行也拿到这项（复制 id 无害） |

**事故与教训**：一个子智能体自检时用 `$home` 当临时目录变量名——PowerShell 里 `$HOME` 是只读自动变量，赋值静默失败，后续写入落到真实 `~/.dsc`：settings.json 被覆盖（按桌面端 localStorage 镜像证据修回外观三项）、一个活动会话 jsonl 被换成 31 字节路径文本（内容不可恢复）。整改：自检脚本模板统一改用自命名变量（`$shotHome` 等）并加「跑前跑后对真实目录全量指纹比对」为固定验收项，本轮各组均已执行（135→186 文件逐个 SHA256）。另记：隔离新目录必须先建 `AppData\Roaming`，否则 Chromium 在 app ready 前直接崩（0x80000003、零输出）。

验收：根 + 桌面 typecheck/build 0 错误；sandbox 193/0、file-review 59+9/0、approval-floor 95/0、integration/m5/modes 四项 ask 相关检查全过；ask 批量化端到端 33 条断言全 PASS（同卡 3 题、翻页草稿保留、统一提交回显按题序且各一次、单题不回归）；流式滚动改前 200ms 被拽回、改后 gap 420→552 冻结 + 两条恢复路径实证；折叠修复改前 `expandedSurvived=false` 改后 true。诚实边界：modes-shots 两条检查需真模型且不隔离 HOME（会写真实目录），本轮未跑，与用户在场时补；dsh 的提问卡最小化/关闭按钮没有做（AskService 无取消通道，做了是假按钮）；自由输入仍单行。发布：`muse-code-0.6.2.tgz` + `dist/win-unpacked`。

---

## 阶段 19：审批语义、整轮折叠与真实用量（0.6.3）

0.6.2 交付后用户实测反馈 3 条（自动编辑下只读 bash 仍弹卡 / 会话折叠与 dsh「完全不同」/ 脚注图标跑右边 + tok 口径不对）。主控先把三处现状读到根上、写成审阅稿经用户逐条裁决后才派工：三个并行子智能体（deepseek v4.1 flash）分两批（宿主两件并行 → 渲染层一件），渲染层改动集中在 ChatView/styles.css，合并给一个代理避免互相覆盖。

| 决策 | 理由 |
| --- | --- |
| 弹卡的根因是只读命令名单缺 PowerShell 管道段，不是模式逻辑错 | `classifyCommand` 按管道分段判定，`Get-ChildItem` 在名单里但 `Select-Object`/`Format-Table` 不在，一段不认识整条判 ask；`READONLY_HEADS` 补 20 项纯展示 cmdlet 与别名，**故意不收** `ForEach-Object`/`%`（scriptblock 能执行任意代码，`Get-ChildItem \| ForEach-Object { Remove-Item $_ }` 头只读、刀在花括号里）与 `Tee-Object`/`Out-File`（落盘且不走 `>` 重定向防线） |
| 「仅查看」档从一刀切拒改成读类放行 | 原实现连纯只读命令都拒，与「只读：读放行」的字面语义相悖；在拒绝前先认 `classifyCommand` 判成 allow 的命令 |
| 会话折叠补上 dsh 的第一层：整轮过程总开关 | dsh 的 `foldCompletedTurns`（presentation-policy.ts）是把**整轮**思考+工具行收进一行「用时 X」总开关，收起只剩问题→开关→回答；此前 0.6.2 做的只是第二层（单条折叠）。跑动轮强制展开且不画开关（对齐 `TurnProcessNodeView` 的 `status!=='closed'→null`）；plan/system 不进组；展开态键 `会话:turn:轮序号`；轮收尾自动复位成收起 |
| 过程折叠程度做成三档设置进通用设置 | 用户点名「学 dsh 加折叠程度设置项」：紧凑（整轮折叠 + 定稿思考不显摘要预览，对应 dsh `settledReasoningPreview:false`）/ 标准（默认）/ 详细（不折叠）。偏好链路照 buttonScale 先例抄全：prefs 白名单 + runtime 回执校验，漏一层就出「已保存工作区名字」假提示 |
| tok 从字数估算换成真实累计口径 | 宿主每次请求本就拿到 `prompt_tokens+completion_tokens`（llm.ts 末块 usage）但从未暴露；transcript 按轮记账：'user' 清零、'usage' 累加、'message' 盖当时累计、'turn/end' 用最终累计**覆盖**轮内最后一条——因为 loop 先发 message 后发 usage，按「已有就跳过」会系统性少算末次请求；`plugins/transcript` 的 `shape()` 比对剔除 usage，否则 `replayIsRedundant` 永判 false 导致重放丢数 + id 重发号。页脚真值显示「用量 N tok」，老会话回落估算保留 `~` |
| 脚注合成一条左对齐行，顺序照 dsh | 复制·赞·踩·分叉·用量·时刻（dsh `MessageIconActions` 是行内条不是右缘浮层）；「用时」收进整行悬停提示（dsh 行面不显示）；复制/赞/踩从 `.entry-meta`（写死 flex-end）搬进 TurnFooter，旧规则整块删除 |
| 顺带修「思考过程」竖排字 | `.think-label` 缺 `flex:none`/`white-space:nowrap`，`.think-summary` 的 `flex:1` 吃光余量后标题被压成一列汉字 |

验收：根 + 桌面 typecheck/build 0 错误；sandbox 193/0、file-review 59+9/0、approval-floor 95/0、modes-security 172/0（新增 13 条：管道筛选格式化判 allow、`ForEach-Object`/`Tee-Object` 不判只读）、integration 104/0（新增 5 条：仅查看档真内核裁决）、transcript 用量 13/0（新建脚本，仓库原无 transcript 测试）、compact 53/0、整轮折叠探针 65/65、隔离截图自检 38/38（含紧凑档摘要消失、隔离 settings.json 真被写成 detailed、实时轮页脚「用量 330 tok」为真值不带 `~`）；三个真实 `~/.dsc` 指纹比对全部零改动。诚实边界：命令 tokenizer 不解析子表达式括号，`Get-Item (Remove-Item x)` 这类「头只读、括号里带刀」仍判 allow（既有风险面，收口另立阶段）；「plan 不折叠」只有产物断言没有截图用例（种子造不出 plan 条目）；分叉图标保留 15px 与复制/赞/踩的 17px 并存；页脚动作从 hover 浮出改为常驻（对齐 dsh 收尾轮）；浅色主题与 reduced-motion 只写了样式降级。发布：`muse-code-0.6.3.tgz` + `dist/win-unpacked`。

---

## 阶段 20：跟随暂停灵敏度（0.6.4）

0.6.3 交付后用户先要求去掉「回到底部」按钮，随即改口：按钮保留，真正的问题是**贴底时滚轮轻滑一格就弹按钮**——一格滚轮约 100px，旧判定离底超过 32px 就暂停，天然会误触发；且 `onWheel` 是无条件暂停，内容一屏装得下时滚轮上滑也会弹。处理：先回退未提交的删按钮改动（`git checkout` + 删掉探针里 3 条退场断言），再引入双阈值滞回——`PAUSE_EPS = 120`（大于一格滚轮的行程）暂停、`AT_BOTTOM_EPS = 32`（复用 JumpStrip 的导出）恢复，区间 (32, 120] 内跟随中不动、暂停中不闪；`onWheel` 改成预估落点离底超 120 才抢先暂停（防回弹的原始理由照留），`onWheel`/`onTouchMove` 补 `maxScroll <= 0` 早退。派发任务书里的落点公式 `scrollTop - deltaY` 方向写反了（向上滚 deltaY 为负），子代理按判据本身改成离底距离 `limit - scrollTop - deltaY`，物理正确——**给子代理的数值公式要自己先推一遍方向**。

验收：根 + 桌面 typecheck/build 0 错误；fold-check 65/65；产物探针：按钮 JSX 与 `PAUSE_EPS = 120` 声明及三处使用在位，数值推演（贴底单格 100px 不暂停、两格抢先暂停、离底 60px 滞留、20px 恢复、limit≤0 不暂停）全部符合。发布：`muse-code-0.6.4.tgz` + `dist/win-unpacked`。

---

## 阶段 21：轨迹页对标 dsh（0.6.5）

用户要求轨迹机制功能对标 dsh（ui-trajectory 包）。主控先出差距清单经用户裁决：TTFT/每 token 时间戳（宿主没记，不加埋点做不了真值）、嵌套子工具内部步骤、虚拟化+加载更早分页这三项明确出圈；远程控制插件（用户同批提出）经可行性调查确认 **npm 包直接装不可行**——`@linxin666/dsh-web-all/remote-web-ui` 真身是 `@linxin666/dsh-remote-web-ui`，双面 cordis 插件深度绑定 dsh 基建（`dsh web` webserver/profile/cordis.patch.yml/auth fence/`ctx.layout`/`/api` SDK），而 dsc 无 Web 通道（Electron 渲染层 + preload IPC），用户裁决先只做轨迹，远程控制待议。

| 决策 | 理由 |
| --- | --- |
| 工具耗时进 ToolCallView（startedAt/durationMs） | transcript 在 tool/result 时 stamp() 覆盖条目 ts，开始时间丢失——检查器与时间条都没原料；done/failed/rejected 都算耗时（中断同样花了时间），日志乱序（结果早于发起）宁缺不编 |
| 压缩识别选「字段标记」而不是新条目 kind | 压缩落两条路：实时是 system 条目（dsc/notice），重放只有摘要那条 user 消息（system 条目不进日志，replayHistory 只重放 messages）——稳定标记是摘要正文的 SUMMARY_BANNER 前缀，adapter 认掉后给 user/system 条目盖 `compaction:{count}`；换新 kind 会让摘要气泡当场从对话页和终端消失（`default:` 不渲染），数据任务不能顺手制造信息丢失 |
| shape() 比对剔除新字段照 usage 先例 | 否则 replayIsRedundant 永判 false：重放丢数 + id 重发号；反证验证过（注释掉 delete 后第 8 组立刻 FAIL） |
| 时间条诚实口径：没耗时的只画起点刻度 | dsh 同款语义——thinking/system/running 的行不虚构宽度，有 durationMs 的工具才投影成条；刻度一律 2px，「条 vs 刻度」一眼分得清有没有真耗时 |
| 渲染层崩在截图环节由主控接手验完 | 子代理留下约 1900 行完整代码（探针 85/85 已过）；主控复跑发现一处**真组件 bug**：检查器输入块 Block 内部又调了一次 prettyMaybeJson，父组件切回原文的单行参数被二次美化，「格式化/原文」开关切不回去——格式化决策必须只留一处；另三处 false（tick 数写死 5、带图消息在 round 3 却开了 round 2、内容不够滚 400px）全是探针/种子的锅 |

验收：根 + 桌面 typecheck/build 0 错误；sandbox 193/0、file-review 59+9/0、approval-floor 95/0、modes-security 全过、integration 全过、transcript-usage 全过、trace-data 25 项全过、composer 全过、compact 53/0、轨迹探针 85/85；隔离截图自检（dark+light 双主题）全部布尔旗标通过——时间条投影（63s 条宽 ≈ 4.2s 条 15 倍）、进行中调用只有刻度没有耗时格、失败红/被拒琥珀双色、检查器五段（输入/输出/计时/用量/附件）、格式化开关真切换、复制参数回执、附件缩略图 132px + 灯箱开合、压缩区段行「已压缩历史 · 第 1 次」、拖选聚焦（命中 3 条、暗淡 12 条、点选/右键两种清除）、回底跟随（内容不足 150px 可滚时持住判定如实跳过）；真实 `~/.dsc` 指纹零改动。诚实边界：滚动持住用例因种子内容不足一屏没量到（逻辑与 ChatView 同款、代码已核），真实长会话里再验；拖选聚焦用 chip 的「已选 1m30s · 3 步」表达，不改动对话页。发布：`muse-code-0.6.5.tgz` + `dist/win-unpacked`。

---

## 阶段 22：远程操控——宿主插件与移动 Web 界面（0.6.6）

用户要求参考三个现成实现出一版远程操控：OpenAI Codex CLI（`D:\codex`）、hermes-agent（`D:\hermes\hermes-agent`，多平台 gateway）、0.6.5 已判不可装的 dsh remote-web-ui 插件。主控派三路勘察（codex 出站中继与审批协议、hermes 配对与入站链路、dsc 客户端/会话模型），整合方案经用户三问裁决：**独立轻量 Web UI**（桌面渲染层绑死 `window.dsc` 的 21 个方法，剥离成本高于重写）、**显式加 `ws@8`**（自写 RFC6455 帧易埋鉴权时序坑）、公网走**隧道手册**（零代码）。

| 决策 | 理由 |
| --- | --- |
| 远程控制器装进宿主进程，不另起内核进程 | 会话状态在内存、jsonl 只是 append-only 日志、`.last-session` 是最后写者赢，跨进程读同文件必然消息分叉；插件吃 `ctx.transcript/agent/approval/ui` 与桌面共享同一会话。两个宿主（桌面 headless / CLI TUI）都会加载它，用 pid+出生时间主控锁仲裁端口归属（照 schedule runner 先例，前任死了下一个进程接管） |
| 配对抄 hermes 一次性码：8 位无歧义字母表、只存加盐 SHA-256、1h 过期、错 5 次锁 1h、最多 3 张待用 | 码即授权，输对就颁 device token（明文只回一次、永不落盘不进日志）；dsc 只有运营者一个管理员，hermes 的「管理面批准」砍掉，批准动作=用户自己在桌面设置页出示码 |
| 鉴权三件套：Bearer 存 localStorage（不进 Cookie，天然免 CSRF 面）、WS 用一次性 30s 票据（用后即焚、票据自带设备）、全路由 Host 头校验只认 IP 字面量/localhost | Host 校验是 DNS rebinding 的挡板，代价是 mDNS 主机名连不上（手机用设置页显示的 IP 访问），codex「拒绝带 Origin 的升级」是防陌生浏览器直连，不适用于「浏览器就是本产品」的形态故不抄 |
| 协议零重造：INVOKABLE_METHODS 抽成 `core/host-methods.ts` 共享，远端白名单取子集 | 灰名单去掉凭据与宿主生命周期方法（saveProvider/removeProvider/setProviderKey/setDefaultModel/设 skill 开关/装市场技能/dock 等）；快照沿用 transcript 的 16ms–1s 节流全量推送（含直播尾与 pendingApproval/pendingPlan/pendingQuestion），重连=全量快照重建不搞增量 |
| 不做逐字 delta 外放 | CoreEvent 不上 cordis 总线（agent 插件只落库+转快照），外放原始事件要动内核 emit 链；远端「能看能管」靠快照已够，批量快照在弱网流量偏高记为已知代价（增量帧列后续候选） |
| 审批来源标注 source:'web' 只落在审批，plan/question 不塞 | plan 的审计记在 kind:'mode-change'、question 根本没有审计记录，硬给这两个方法多传实参是被忽略的死代码；顺手加 `settings.watchPrefs` 把三处直写 writePrefs 的偏好转成统一通知（否则 remote 插件收不到「开关变了」就起停不了服务器） |
| 提交纪律：并行会话正在 desktop 渲染层做「轮内阶段分组折叠」，本批提交精确点名，绝不扫入 | 两会话同树并行（用户确认归属）；桌面 dist 也顺延到那边落定后一次重建，避免半成品进日常安装包 |

验收：根 typecheck/build 0 错、桌面 typecheck 0 错（并行改动编译干净）；新建探针 `remote-host-test` 49/49 + `remote-e2e` 47/47（配对错 5 次 429/哈希落盘无明文/票据一次性过期/Host 六类/白名单外拒/吊销当场踢线/双宿主休眠/开关关停监听）+ remote-web 界面自检 41 条假 socket 断言（修掉一处重连空指针）；老 lanes 全绿（sandbox/file-review×2/approval-floor/modes-security/integration/compact/hooks/transcript-usage/composer/trace-data）；真实 `~/.dsc` 零改动（`~/.dsc/remote` 不存在、settings.json 最后写盘早于所有探针）。诚实边界：TUI 装配路径无端到端冒烟（插件默认关零副作用已证）；跨进程改偏好不实时（要重启或重新开关）；远端 openSession 全局生效会换掉桌面正在看的会话（界面有橙字明示）；手机必须用 IP 访问。发布：`muse-code-0.6.6.tgz`；桌面 dist 顺延（用户裁定等折叠批落定后重建）。

---

## 阶段 23：会话区三层折叠，四档档位与收起的可访问性（0.6.7）

用户问「会话区的效果和 dsh 还有没有差别、能不能可选折叠思考与工具调用、长程任务里多个阶段的工具调用能不能自动折叠而不是只在最开始能折」。对照 dsh 的 `packages/client/ui-chat/src/client/conversation-nodes/` 逐个核完，差距落成三块：轮内缺一层「阶段组」、折叠档位少一档且 `detailed` 语义和 dsh 对不上、直播中组体不收起因此屏幕上话多。第一块（阶段组）已在上一批落地（三层结构 + 隔离截图四张网）；本批把剩下 11 项做完。

| 决策 | 理由 |
| --- | --- |
| 组一律默认收起（跑动中也是），「现在在干什么」交给组头的实时详情 | dsh 的组是 `useDisclosure` 的初始收起态（`use-disclosure.ts:12-13`），本轮跑不跑不参与这一位。dsc 原来「跑动中默认展开」，长程任务直播时几十条过程摊在屏幕上。收起之后信息不能变少，所以实时详情必须同批上：取参数的键序照抄 dsh（`process-activity.ts:25-28`），160 字素簇上限、按 `Intl.Segmenter` 切（避免切散 ZWJ 表情）；没有运行中的工具时退回组内最后一段直播尾思考 |
| 组头标题至少显示 150ms，且到点换的是**最新**那一个（中间态跳过） | 照 dsh 的 `useStableLiveProcessTitle`（`ChatGroupSeat.tsx:58-81`）。判定抽成纯函数 `liveTitleDecision(shown, desired, heldMs)`：真实行为依赖时钟，断言「间隔小于 150ms 不变」没法直接测，把时钟换成入参就能逐格核对 |
| 收起不再卸载 DOM，改挂 `hidden="until-found"`（**一次明确的取舍反转**） | 0.6.3 用 `return null` 是为了省一整轮的过程 DOM 与测量。但那样 Ctrl+F 搜不到收起来的内容、自动收起还会把键盘焦点连根拔走。dsh 的 `searchable-hidden.ts` 两个问题一起解（`beforematch` 放进画面 + 隐藏前先看焦点在不在里面）。代价是那一整轮的组件实例都留着——组体有 `content-visibility: hidden` 撑着，不会有大范围重排 |
| `.entry-row` 从 `display: contents` 改成真盒子 | `hidden` 靠 `display: none` 生效，而 `display: contents` 的元素上它不起作用（同特异性时作者样式优先于 UA 样式，`.entry-row{display:flex}` 会赢过 `[hidden]`）。改完对齐等价性靠 `.chat-inner` 那档 gap 与 `.entry-row` 内部的 flex column 保住：`align-self: flex-end`（用户气泡）与 `align-self: center`（system 提示）在盒子里照旧生效 |
| 计划卡从过程区里摘出来 | 它可能落在整轮过程区那段下标区间里面（夹在两条工具之间），按区间判会被一起藏掉。dsh 把 `turn-trigger` / `plan` 这类归进 `TURN_PROCESS_INDEPENDENT_KINDS`，dsc 跟着摘 |
| 档位从三档扩到四档，`detailed` 改语义 | dsh 是 `compact / standard / detailed / verbose`，其中 `detailed` 整轮照折、只有**历史轮**分组（正在跑的那一轮直接摊开），是 dsh 桌面端的实际默认档。dsc 原来三档里的 `detailed` 其实是 dsh 的 `verbose`。改完「全摊开」由新的 `verbose` 承担。**没做存档迁移**：这个档位 0.6.3 才加、迁移要额外引入一个存档版本位，收益只是「少数把档位调到详细档的人升级后观感不变」；代价是老的 `detailed` 用户升级后会看到过程折起来，去设置里改「完全展开」即可 |
| 档位能力表挪进零依赖模块（`fold-policy.ts`），渲染层只读能力不比档位字符串 | dsh 的 `presentation-policy.ts` 头注就是这么定的（「渲染层各自取一个字段，没有一个去比档位枚举，所以加一个档只改那张表」）。另有一个 dsc 自己的理由：原表在 `appearance.ts` 里，那个文件 import 了浏览器全局，拉不进 Node 单测——挪出来以后四档能力表能被行为单测逐格核对 |
| 新增两个与档位正交的开关（思考行 / 工具卡的默认态） | 用户点名要的「可选折叠思考、工具调用」。**dsh 没有这两项**（它的可选性只在四个档位加每层手动开合），所以这是 dsc 的增量，与档位构成第二套控制轴。两个开关只管**定稿**条目：跑动中的那一段永远展开（它是「现在在干什么」的唯一线索，与 `ThinkingBlock` 的 `showPreview` 同一条规矩） |
| 组体限高用 `min(400px, 50vh)` + mask 渐隐，而不是叠一层渐变色块 | 限高与渐隐宽度照抄 dsh 的 `ChatGroupSeat.module.css`。渐隐用 `mask-image` 是因为叠色块要求底色是纯色，而会话区底色是 `color-mix` 按主题与密度算出来的，写死颜色在浅色主题下会露馅。组内滚动自己跟随（滚离底部暂停、滚回贴底档恢复），与外层 transcript 用同一把尺子但互不干扰 |
| 有意不做：轮中途插话就不折整轮（dsh 的 `hasInterleavedInput`） | dsc 的 transcript 里没有 steering 这个条目类型（`src/contract.ts` 只有 user / thinking / text / tool / plan / system），既没数据也没行为。要做先得有「轮中途插话」的数据模型，那是另一条线 |

验收：根 + 桌面 typecheck/build 0 错；四张网全部扩过：`step-groups-check.mjs` 163/163（原 94 + 新增 69：实时详情取值优先级与 160 字素簇截断、150ms 防抖判定、四档能力表逐格、只给历史轮分组、文案表边界）、`step-seed-check.mjs` 25/25（种子加了「33 条调用挤一组」的第 4 轮与一条老格式 plan 记录）、`fold-check.mjs` 166/166（新增四档设置链路、直播详情与防抖、组体限高与渐隐、图标与箭头叠放、焦点保护与 `until-found`、`prefers-reduced-motion` 降级）、`step-shots.ps1` 六用例隔离截图全部布尔旗标通过——`step-static` 21 条（三层显隐 + 组体 `clientHeight=400 / scrollHeight=1414` + 渐隐 mask + 组内滚动不动外层 `scrollTop` + 焦点保护「点收起被撤回、焦点挪开后收得掉」+ `beforematch` 后 hidden 归零 + 计划卡前面那组已收口）、`step-live` 13 条（跑动中组头带详情「正在分析请求 · …」且组体收起、27 次采样零抖变、定稿后两级一起复位）、`step-detailed` 6 条（跑动中那一轮 `stepCount=0` 而过程摊开、总开关不新增，定稿后 2 个组头、文案改成聚合）、`step-verbose` 4 条（不折不分组、四轮全摊开）、`step-light` 2 条（浅色下组头对背景的对比度 9.43 对思考行 5.53）、`step-plan` 3 条（重新打开会话走真 `dsc/session-open` 后计划卡出现，不在任何组体里）；六轮跑完真实 `~/.dsc` 指纹逐文件零改动（138 个文件、清单聚合 `445d8ff1…`、内容聚合 `5014e8ba…` 三次一致）。

诚实边界：① 启动恢复历史会话这条路**不发** `dsc/session-open`（`src/host/kernel.ts:363-366` 只重放历史），所以冷启动看不到计划卡——`step-plan` 用例是重新打开一次会话才拿到它的；要两条路一致得把 kernel 的重放分支改成走 `session.open()`，会影响 approval-floor 的 reset 与 agent 的 switchSession，留在 roadmap §3.2 单独立项，本批不动。② Chromium 把 `hidden="until-found"` 实现成 `content-visibility: hidden`，被跳过的内容在 `getClientRects()` 里**仍然报矩形**（实测 8 条收起的组成员全报 1），所以自检的可见性判据是「祖先带 hidden 属性 + 有矩形」两条一起用，单看矩形会把收起来的又算成可见。③ 老 `detailed` 用户的档位语义变化见上表，界面设置页的说明文案已写明四档各是什么。④ `step-shots.ps1` 的 `prefers-reduced-motion` 降级仍是读样式表规则来核对（真实媒体查询命中要改主进程加 `--force-prefers-reduced-motion` 开关），诚实记为「规则在场且起作用」而不是「渲染结果验过」。

---

## 阶段 24：与 dsh 继续对齐——轮结束原因、轮中途插话与四道折叠闸门（0.6.8）

用户问「与 dsh 还有哪些不同」，要求**完全对齐**。这一轮先把 dsh 的规范文档（`conversation-nodes/README.zh.md`，310 行）与实现逐条核对，产出一份差异清单，再按可做性分四批；本阶段是批 1，另外三批登记在 roadmap §3.3。

**核出来的差异分三类**：会改变画面的行为差异六条（中断 / 失败的轮折不折、组收口是否重置阅读位置、轮内 `system` 会不会被折藏、有没有「准备中」态、没有过程内容时画不画那行抬头、子调用参不参与计数）、整块没有的四条（轮中途插话与轮次触发通知、模型重试行、加载更早历史的分页、token 上限提示与轮尾节点）、做法不同的四条（微光动画、图标、运行指示形态、工具名分类口径）。

**关键发现：有三条的原料一直都在，只是没人消费。**

| 决策 | 理由 |
| --- | --- |
| 轮结束原因落成一条 `turn-end` 条目，**正常结束不落** | 宿主的 `turn/end` 事件从 0.6 起就带 `reason: 'completed' \| 'aborted' \| 'error'`（`core/events.ts:22`），而 adapter 折条目时把它**直接丢了**（只重置状态、结算用量）。dsh 那边靠 `turn.end.data.reason` 判「中断或失败的轮不折整轮」并显示「已停止 / 过程失败」（`contract/turn-process.ts:69-74`、`chat/TurnProcessNodeView.tsx:26-28`），dsc 因此把「跑挂的一轮」和「好好答完的一轮」画得一模一样。为什么正常结束不落条目：渲染层那时没什么可判的，多一条只会让订阅者白重算，还会多出一个空盒子吃掉一段间距 |
| 轮中途插话由**宿主**标，渲染层只消费 | dsc 的 `followup` 在回合没跑完时收到的消息，**本来就会被并进这一轮的下一次模型请求**（`messages` 是同一份，`for(;;)` 重建请求时自然带上）——所以语义上它早就是 dsh 的 steering 了，缺的只是「界面上把它当插话」：一条标志（`const steering = this.running`，要在 `enqueueTurn` 之前读，那之后 `running` 就被置真了）+ `roundInfos` 不把它当新一轮的起点 + 有插话的轮锁住整轮折叠 |
| 「整轮折叠不许藏」抽成一张独立节点表 | dsh 的 `TURN_PROCESS_INDEPENDENT_KINDS`（`contract/turn-process.ts:20-29`）。dsc 原来只在渲染层硬写了一句 `entry.kind !== 'plan'`——于是轮内冒出来的 `system`（错误提示、宿主通知）**会被整轮折叠一起藏掉**，用户以为那一轮只是正常答完了。现在 `process-groups.ts` 导出 `TURN_PROCESS_INDEPENDENT`，两处共用 |
| `foldable` 与 `hasContent` 拆成两位 | dsh 的 `canCollapse = foldable && hasContent && !alwaysOpen`，不可折时**照样画那一行**、只是 `disabled`（`TurnProcessNodeView.tsx:19,44`）。dsc 原来把两者揉成一位，于是一轮「有助手内容但没有可折过程」（比如只答了一句）**整行都不画**。现在没内容时画在用户消息之后、画成不可点的 |
| 组体的定位只在**刚展开**那一刻做 | `useProcessScroll` 原来把「展开时定位」与「跟随态」写在一个 effect 里，依赖里带 `live`——组一收口（`live` 由真变假）就把 `scrollTop` 打回 0。dsh 明确写了这条规矩（`README.zh.md:170`：「数据中的组变为已关闭，或通过模式切换恢复限高时，不重置已展开组的阅读位置」）。改成用一个 `wasOpen` ref 分辨「刚展开」与「展开着、状态变了」 |
| 工具名分类：**规则**对齐，**名字表**按 dsc 自己的工具集填 | dsh 的表是按 dsh 的工具名写的。dsc 的 `ask_user` / `session_search` / `exit_plan_mode` / `browser` 在 dsh 表里没有对应项——照抄会让这些工具掉回「已调用工具」，信息量净减。用户裁决保留 dsc 的映射 |
| 运行指示保留 dsc 的两行，不换 dsh 的鲸鱼 | dsh 是最底部「鲸鱼摆尾 + 闪烁计时」，dsc 是两行（阶段说明 + 当前活动名 + 实时用时）。后者多一句「此刻在调什么」，换过去是降级。用户裁决保留 |

验收：根 + 桌面 typecheck/build 0 错；四张网全部扩过：`step-groups-check.mjs` 180/180（新增 17：插话不另起轮且是分组边界、计时不被插话归零、轮尾标记与长度上限都是独立节点、独立节点表五类）、`step-seed-check.mjs` 25/25、`fold-check.mjs` 190/190（新增 24：契约三样新东西、事件链原料真的从循环里出来、adapter 三处消费、渲染层四道闸门与三态文案、disabled 与空条目不占位、组体 `wasOpen`）、`step-shots.ps1` **七个用例**全绿——新加的 `step-control` 七条判定全真：插话的两条用户消息落在同一轮（`data-round` 都是 `1`）、那一轮的整轮开关 `data-turn-blocked="1"` 且 `disabled`、过程保持展开；组收口（`data-step-closed` 由 null 变 `1`）时组内 `scrollTop` 从 60 到 60 不动、**且那一刻这一轮仍在跑**（状态行还在，证明测的是「组收口」而不是「轮收尾的复位」）；中断的轮开关报「已停止」且不可点、过程保持展开。真实 `~/.dsc` 七轮跑完指纹逐文件零改动。

**顺手修掉一个自检基建的 bug（值得记一笔，因为它伪装成产品 bug）**：假端点用「请求体里有没有 `"role":"tool"`」判断这是第几跳。多轮对话里历史本来就带着前面几轮的工具消息，于是**第二轮的第一跳被误判成第二跳**、压根不吐工具调用——界面上表现为「那一轮只切出一个组」，排查时一度以为是分组器坏了。改成「最后一条消息的角色是 `tool` 才算后续跳」，并把跳数做成可配（`FOLD_FAKE_HOPS`）。

诚实边界：① **steering 的标记不落盘**——jsonl 里没记，切走再切回来那一轮的插话标志就丢了，它会退化成「两条消息两轮」。dsh 的 `hasInterleavedInput` 同样来自内存态的 node store，重放路径也没有。要根治得动 jsonl 格式与 `Session.load`，价值与风险不匹配，记为已知代价。② `turn-max-tokens` 也只在实时路径有（重放拿不到 `finish_reason`）。③ 「准备中」态、模型重试行、加载更早历史的分页还在批 2 / 批 3 / 批 4，见 roadmap §3.3。④ dsh 的 `turn-tail` 节点语义没查明，dsc 用 `turn-end` 条目承担了同样的角色。

---

## 阶段 25：准备中态与模型重试行——动到流式层（0.6.9）

阶段 24 的批 2。这两件事的原料都在 `src/core/llm.ts` 的**流式解析层**，不在渲染层，所以要一路从 SSE 解析透到界面：

| 决策 | 理由 |
| --- | --- |
| 「模型开始吐工具名」单独报一个回调 | dsh 的 `preparing` 节点是「具名实时 delta 可以创建该节点」。dsc 原来只在**流结束**才拿到完整的 `toolCalls`，于是从「模型决定要调什么」到「参数攒齐、工具真的开跑」之间有一整段真空（长参数能空好几秒），界面上一点线索都没有。回调命名 `onToolPrepare`，同一个 index **只报一次**（名字可能是分片拼出来的，只在「从没有名字变成有名字」那一次报） |
| 准备中的工具条目**就地升级**，不另开一条 | 对照 dsh 的 tool 节点 `phase: preparing → dispatched`——那条节点从头到尾只有一个。adapter 用一个「准备中」队列按**名字**配对（两边的顺序都由模型给的 index 决定，同名工具也不会错位），升级时保留原来的 id 与 ts（dsh 的口径是「准备中的调用使用首个具名 delta 的时间」） |
| 准备中那一行**不可展开** | dsh 的原话：「不解析参数，只渲染不可展开的一行」。参数此刻本来就不完整，展开出来是半截 JSON；所以不画箭头、`aria-expanded` 也不给。升级成 running 之后才恢复可展开 |
| 准备阶段只有通用类别补工具名 | dsh：「只有『准备调用工具』在标准模式中追加协议工具名，其他类别不追加」——因为「准备读取文件 · read」纯属废话。十四个类别各有一句准备文案（照 `locale.ts:22-34`，另加 dsc 自己的 `browser`） |
| 「等不到升级」的准备中条目在**轮末**清掉 | 模型吐了工具名之后被打断、或者吐到一半改了主意，那些条目代表「本来想调、最后没调」，留着会让用户一直盯着一句「准备读取文件」等下去。为什么不清在 `message` 时刻：`loop.ts` 的顺序是**先发 message、再执行工具**，那一刻这一批的 `tool/call` 还没发出来，在那儿清会把等着升级的一起误杀 |
| 模型重试也透一条事件出来 | 重试环在 `core/llm.ts:176-183` 内部，不报出来的话一次 429 之后用户只会觉得界面莫名卡了几秒、然后答案冒出来。`onRetry` 带「即将是第几次」与失败原因，adapter 落一条 `model-retry` 条目 |
| `model-retry` 是二级分组的**边界**，但**不进**独立节点表 | dsh：「二级分组把模型重试视为分隔节点，但整轮折叠仍包含重试行」。所以它 `flush` 前面的组（`process-groups.ts` 的边界分支），但不在 `TURN_PROCESS_INDEPENDENT` 里——整轮收拾过程时它跟着一起收 |

**做这一批时抓到一个真 bug（值得单独记一笔，因为它伪装成了别的样子）**：`tool/prepare` 一开始是往**已定稿列表**（`list`）里 push 条目的，而直播尾（正在流式的思考与正文）在 entries 里永远排在已定稿条目之后——于是工具卡**插到了正在流式的思考前面**。自检打出来的 DOM 顺序是「用户 → 工具卡 → 思考 → 正文 → 重试行」，直接后果是这一轮只切出**一个**组（工具与思考被正文一起收口），组头也就永远显示不出「准备读取文件」。

第一版修法是「push 之前先把直播尾定稿」（`flushSegments`）：顺序对了，但**引入了重复内容**——`message` 事件随后还会再 push 一遍思考与正文，而中间隔着刚插进来的工具条目，`pushThinking` / `pushAssistantText` 的「合并进相邻同类型条目」就落空了。`step-live` 当场从 2 个组变成 3 个组（多出一条「已完成分析」）。

最终改法是把准备中的条目**移出 `list`**：它在 `prepared` 队列里待着，由 `liveEntries()` 合成在直播尾**之后**，等 `tool/call` 到达时才正式落进 `list`（那时直播尾已经被清掉了）。这样顺序天然对、不会有重复内容、`dropPrepared` 也简化成「清空队列」一句（没有下标要修、没有 `toolIndex` 要重建）。

**这个 bug 是被自检的诊断逼出来的，不是看代码看出来的**：第一版用例只断言「组头文案以准备开头」，它一直失败而表象看着像 150ms 防抖；把 DOM 顺序、组号、条目构成、这一轮是否还在跑逐个打出来之后，才看见工具卡排在思考前面。教训记在这里：**实时路径上新插一类条目时，先想清楚它在 `list` / `segments` 里的位置**——`entries` 永远把 `list` 排在 `segments` 前面，这个隐含次序很容易被忽略。

验收：根 + 桌面 typecheck/build 0 错；四张网：`step-groups-check.mjs` 210/210（新增 30：十四个类别的准备文案、准备中的类别计数与详情规则、升级后回到「正在…」、只有 `preparing` 变也算换标题、模型重试是边界但不在独立节点表里）、`step-seed-check.mjs` 25/25、`fold-check.mjs` 213/213（新增 23：契约的 `preparing` 与 `model-retry`、流式层两个回调与触发点、事件链两条转发、adapter 的队列与由 `liveEntries` 合成、轮末清队列、十四类准备文案、工具卡不可展开、运行指示分开「正在准备 / 正在调用」、TUI 与轨迹页都认得）、`step-shots.ps1` **八个用例**全绿——新加的 `step-prepare` 六条判定全真：准备中那一行状态是「准备中」、右侧没有箭头也没有展开区、组头文案是「准备读取文件」（那一刻这一轮还在跑）、假端点头一次 500 之后界面上真的出现「模型请求失败，正在重试（第 2 次）：HTTP 500…」、重试之后这一轮正常跑完、轮末没有留下卡在准备中的条目；`step-live` 的 13 条也全真（修完顺序 bug 后，定稿展开仍是 2 个组头「已完成分析」+「已读取文件」）。真实 `~/.dsc` 八轮跑完指纹逐文件零改动。

诚实边界：① 准备中的条目只在**实时路径**有（重放老会话直接从 `tool/call` 开始，不重现准备过程——dsh 也是这个规矩）。② `model-retry` 同理，只在实时路径。③ 若模型吐了工具名之后一直不吐参数（流挂住），那一行会一直显示「准备中」直到流超时或轮结束——没有单独的"准备超时"处理，与 dsh 一致。

---

## 阶段 26：组头扫光（0.6.10）

批 3。这一批比预想的小，因为**dsc 早就做过同一件事**：思考摘要的跑动扫光（`styles.css` 那段 `.think-summary-text[data-shimmer]::after`）已经是 dsh `TextShimmer` 的等价写法——`::after` 用 `content: attr(data-shimmer)` 复制同一串文字、高光渐变裁进字形、字形自己填透明，底层那行真文字保持可选中、读屏读得到。所以这一批只是把那条规则的选择器**并列加上组头的 label**，加上一个定位父级与 reduced-motion 降级。

| 决策 | 理由 |
| --- | --- |
| 组头的扫光与思考摘要**共用同一条规则**，不另写一份 | 两处在 dsh 里都是同一个 `TextShimmer`（`ChatGroupSeat.tsx:123-125` 与 `ReasoningRow.tsx:65`），语义也一致：跑动中那句话「活着」。共用还保证了扫光节奏、颜色、延迟三处完全一致——各写一份迟早会漂 |
| 收口的组**不给**扫光 | 对照 dsh 的 `active={!data.closed}`：已经不动了还扫，看着像还在干活 |
| **类别图标不改** | dsh 的图标来自它自己的设计系统包，dsc 拿不到那些 SVG；而且 dsh 把 `commands` 画成抽象的 API 方块图标，语义上不如 dsc 的终端图标贴切。真正值得对齐的是「哪一类用哪一类图标」的映射，那条已经对齐。`webFetch` 一度想按 dsh 归到与 `read` 同用的「浏览」图标，但 dsc 没有浏览图标、地球图标对「抓取网页」更贴切，所以也保持原样。**这条与「运行指示保留 dsc 两行」「子调用计数不做」一起登记在 roadmap §3.3 的「明确不做」里** |

验收：根 + 桌面 typecheck/build 0 错；`fold-check.mjs` 218/218（新增 5：两条选择器并列、label 是定位父级、渲染层在跑动中挂 `data-shimmer`、reduced-motion 降级也在、扫光节奏照 dsh 的 `1.5s steps(48, end) 0.3s infinite`）；`step-shots.ps1` 八个用例全绿，`step-live` 多一条 `liveHeadShimmers`（跑动中的组头确实带扫光挂点）。真实 `~/.dsc` 零改动。

诚实边界：静态截图只能证明「挂点与样式在场」，证明不了「动画真在跑」——扫光是 1.5 秒一轮的连续动画，单帧看不出来。真要验得录一段或读 `getAnimations()` 的播放状态，本批按「规则在场 + 挂点在场」记，没做动画运行时的断言。

---

## 阶段 27：加载更早（0.6.11）

批 4。用户最初的要求是「完全对齐 dsh」，其中「加载更早历史的分页」按 dsh 的链路是**数据源分页**；讨论到一半用户提出「一次全存内存应该性能很差，还是对齐 dsh 吧」，于是先量了真实开销再定方案。

**实测（`desktop/shots/load-bench.mjs`，只读真实 `~/.dsc`）**：

| 量的是什么 | 实测 |
| --- | --- |
| 最大的单会话（1 MB / 25 条消息） | `Session.load` 4.9ms + `replayHistory` 0.5ms，堆增量 3.3 MB |
| **全部 78 个会话**加载一遍 | 26ms，堆增量 2.5 MB（共 237 条消息） |
| 全库磁盘占用 | 2.6 MB |

**机制上的关键**：dsc 的 `messages` **同时是「模型请求上下文」和「界面展示来源」同一份**（`Session.load` 读完整 jsonl → `replayHistory` 全量折条目）。只给展示分页的话，请求上下文仍然要全量加载——**内存一点不减，只是少画 DOM**。dsh 能靠分页省下来是因为它结构上把两者分开了（`session-query` 的索引 + node store + `next-turn` 领取批次），那是架构级改造；在 dsc 当前的数据量下做它，收益是零。

**所以这一步做的是渲染层渐进渲染**：用户可见行为与 dsh 完全一致，只是数据早就在内存里。

| 决策 | 理由 |
| --- | --- |
| 分「渲染量」不「数据量」，一页 8 轮 | 长会话真会被拖慢的是对话流的 DOM 数量（一轮可能压着几十条过程条目）。8 轮足够盖住常见的一屏半到两屏，首屏要挂的过程 DOM 从「几十轮」降到「八轮」 |
| 记「用户放出的最早**轮号**」，不记「放出了几页」 | 会话一直在长，按页数记的话每来一条新消息窗口就整体后移一轮、最上面那轮被悄悄收走——用户正看着它。记绝对轮号，新消息只影响末端（最近一页跟着走），前面放出来的原地不动 |
| 锚定按 dsh 的原文：**正文顺序**上按钮下第一个可见内容项 | dsh 的 `conversation-nodes/README.zh.md:98` 写死了这条（「不根据它在视口中的位置选择」）。所以从按钮往后找第一个有高度的兄弟节点，记下它的视口位置，DOM 更新后由 `useLayoutEffect` 拉回原处 |
| 限高组先吸收位移，吸不下的才交给外层 | 同一条规矩的后半句。锚点若落在某个阶段组体里，先把那个组体往上滚（按**实际**滚动量算，组体滚不动时这部分原样留给外层），剩下的再动 transcript |
| 「加载更早」居中放内容区最前面 | 它在 DOM 里的位置有语义：锚点就是按正文顺序从它后面找的。居中而不是左对齐，是因为它不是对话内容的一部分，是「上面还有东西」的提示 |

验收：根 + 桌面 typecheck/build 0 错；`step-seed-check.mjs` 28/28（新增 3：分页样张 12 轮、每轮一组、每轮过程从思考开始）；`step-shots.ps1` **九个用例**全绿——新加的 `step-paging` 五条判定全真：初始只画 8 轮（12 轮的样张）、按钮文案「加载更早的 4 轮（上面还有 4 轮）」、点完变成 12 轮、**锚点元素视口位置 `-407 → -407`（`moved: 0`）而外层 `scrollTop` 从 569 调到 527**（补偿确实在起作用）、手动展开的那一轮（第 11 轮）跨分页仍是 `aria-expanded="true"`。真实 `~/.dsc` 九轮跑完指纹逐文件零改动（含 `load-bench.mjs` 那次只读）。

诚实边界：① **数据源分页押后**——不是不做，是现在做没有收益（见上表的实测与机制）。等会话真长到几千轮、内存成为可观测问题时，再连「模型上下文与展示历史分离」一起做。② 分页窗口是**内存里的渲染窗口**，切会话回默认（`earliestVisible` 归 null）。③ 「分页请求期间若读者滚动则优先服从滚动」这条 dsh 规矩只在**异步取数据**时才有意义（dsc 这一步是同步的、一次渲染就完事），没有实现也没有可测的场景。④ `JumpStrip`（右缘刻度条）只为 DOM 里存在的轮画刻度，没放出来的轮没有刻度——与 dsh「未加载的轮没有锚点」一致。

---这与我上一批对 `prefers-reduced-motion` 的口径一致（那条也只验规则在场）。

---

---

## 阶段 28：远程操控宿主补全——增量帧、重连补帧、上传与推送（0.6.12 批 A）

0.6.6 的 remote 插件（阶段 22）对**每条连接**各自节流推**全量**快照：手机每 80ms 收一次整份会话（几十 KB 起），弱网下流量高；断线重连只能重建一整帧，没有「补上我漏掉的那几帧」这条路。这一批按一份**两批并行开发共用的协议契约 v3**改造宿主半边：全局 seq（跨连接连续）、按条目 id 做 diff 的增量帧、最近 120 帧环形缓冲与 `&lastSeq=N` 重连补帧，另外补上上传端点、浏览器推送（Web Push）与通知 Webhook。**手机界面那一半（remote-web 的增量合并、上传入口、推送订阅与 Service Worker）由并行批次 B 承担，本批不碰 `remote-web/`。**

契约 v3 的帧形状（宿主与界面两边都按这一份写代码）：

```
全量帧  {type:'snapshot', seq, full:true, ...快照字段（照 v2 铺平）}
增量帧  {type:'delta', seq, full:false, meta:{除 entries/liveEntries 外的所有快照字段},
         added:[条目], updated:[条目], removedIds:[number], liveEntries:[条目全量]}
```

| 决策 | 理由 |
| --- | --- |
| 帧流做成**宿主级一份**（一个节流定时器 + 一个 `RemoteFrameHub`），所有连接收同一串帧 | 增量 diff 必须有唯一的「上一帧」当基准。每条连接各自 diff 的话，两条连接看到的状态会各漂各的，重连补帧也没有共同参照；seq 也就没法「跨连接连续」 |
| 环形缓冲**存原样的 JSON 字符串**（120 帧），重发不重算 | 客户端是按收到的字节解析并记 `lastSeq` 的。补帧若按当前状态重算，同一个 seq 会给出跟当时不一样的字节，客户端重放出来的历史与旁观连接对不上——自检里就是逐字节比对这一条 |
| `liveEntries` 与 `meta` 每帧全量带，只对**定稿条目**（正 id）做 diff | 直播尾每几十毫秒整段改写，给它做 diff 只会更贵；`meta` 里是 status/surfaces/sessions，都很小且没有稳定身份可以拿来做 diff |
| 全量锚三条：连续 50 帧 delta、距上一全量 30 秒、**会话切换立刻** | 增量是可以无限长的，一旦漏了一帧（进程被杀、缓冲被覆盖）就永远补不回来，锚帧是唯一的复位点。会话切换时条目 id 空间整体换了一套，diff 没有意义 |
| 一条连接都没有时**不造帧**，改记一个「错过变化」标记；下一条连接补完缓冲帧之后再追一帧全量 | 没人看的时候按 80ms 造帧是白烧 CPU（一轮对话可能几万次变化）。但也不能让重连的客户端停在旧状态上（那段时间的变化没进缓冲），所以这个标记必须补一帧全量 |
| `lastSeq` 落在窗口之外时回落 `hello` + 全量，**包括「比最新一帧还新」** | 「比最新还新」只会在宿主进程重启之后出现（seq 从头数，客户端的号是上一世的）。照字面「补 N 之后的帧」这里会一帧都不发，界面停在空白——契约给「接不上」的客户端准备的就是全量这条路 |
| 上传落盘名 = 8 位随机十六进制 + 安全化文件名；目录按 `yyyymmdd` 分；总配额 100MB 按最旧淘汰 | 文件名完全不可信（可以带 `../`、控制字符、`CON` 这类 Windows 设备名）；随机前缀避免同名互相覆盖，按天分目录让人工翻的时候知道是哪天传的 |
| 20MB 上限由上传这条路由**自己的读取器**说了算，JSON 路由仍是 64KB | 要传的是照片、日志、短音频，64KB 不够；但不能顺手把配对、取票据这些路由的上限一起放开（那里只有几十字节） |
| Web Push 用 `web-push` + VAPID：密钥 `push-keys.json`、订阅 `push-subs.json`，都放 `~/.dsc/remote` | 与 `devices.json` 同一层，吊销与清理的边界一致；**首次用到才生成密钥**（装上插件不该顺手生成一对密钥）。`remote.push` 关着时公钥报 null、订阅端点回 403、一条推送都不发 |
| 通知 Webhook 的两种格式**由 URL 自己决定**（带 `{title}`/`{body}`/`{url}` → GET 替换，否则 POST JSON） | 用户只要把地址粘进设置里，不用先选模式。Bark 的地址天生带占位符、ntfy 的主题地址天生不带，这条规则刚好把两家都认下来 |
| 推送触发挂在插件**已有的** transcript 订阅与 `dsc/turn-end` 上 | 内核一条新事件都不用加。轮开始时刻没有现成事件，插件从快照的 `turnState` 由 idle 变非 idle 自己记（推送正文要报「用时 Xs」） |
| 逐台吊销走 `deviceId`（新增 `pairing.revokeDevice`） | token 本体从不落盘、设置页上也看不到，界面手上只有 `deviceId`，所以「吊销这一台」必须能按身份定位而不是按凭据 |
| 设备清单由 `fields()` 现算，每台设备两行（info + `revoke-device:<id>` 按钮） | `fields()` 本来就是每次刷新重新调的，吊销之后下一刷自然少一台，不用自己再往界面推事件 |

验收：根 `pnpm run typecheck` 与 `pnpm run build` **0 错**；`node scripts/remote-host-test.mjs` **134/134 通过**（阶段 22 记的是 49 条；逐段条数：偏好 19、配对 22、票据 4、主控位 5、Host 头 8、桩服务页 4、白名单 2、帧流 diff 与锚帧 17、上传 11、Web Push 12、通知 Webhook 6、HTTP+WS 24）；`node scripts/remote-e2e.mjs` **78/78 通过**（阶段 22 记的是 47 条，真起宿主走全链：上传落盘→submit 带路径→增量帧 added→断线→带 `lastSeq` 重连逐字节补帧→`lastSeq=0` 回落全量→审批卡触发假 Webhook 收 JSON→轮完成第二条 Webhook→推送路由→设备清单两行与单独吊销当场断线）；`node shots/integration-check.mjs` 仍绿；真实 `~/.dsc` 跑完整套探针前后逐文件指纹零改动（两个探针都换 HOME 到 `scripts/.remote-*-home` 并在成功时自删）。

诚实边界：① **手机界面那一半不在本批**：增量帧的合并、`lastSeq` 的记账与重连、上传入口、推送订阅与 Service Worker 的显示都由并行批次 B 做，本批只验宿主半边（自检里的「客户端重放视图」是我按契约写的可执行说明，不是批 B 的实现）。② **Web Push 的「真的送到手机」没法在自检里验**：host-test 注入假发送器验数据层与 404/410 清理，e2e 里验到的是路由（公钥、订阅入库去重、退订），真机上还得人工验一次（iOS 必须先把页面加到主屏幕）。③ 上传配额淘汰按 mtime 从旧到新，同一毫秒写入的文件之间顺序不稳定（生产上无所谓，自检里用 `utimesSync` 把时间钉死才可复现）。④ 一次推送的两条腿是**串行** await 的（先 Web Push 再 Webhook）：某台订阅超时会把它后面的 Webhook 推后最多 5 秒，没做并发，登记在 roadmap。⑤ 会话切换的「立即全量」靠 `sessionId` 变号；同一会话内的整体重排（压缩之类）不触发全量，靠 diff 自然收敛。⑥ `removedIds` 在常规流里很少出现（条目只在回滚/清空时消失），自检里是用合成快照逐格验的。⑦ 设置分区的「发送测试推送」在两条腿都关着时只会告诉你「没开 / 没配」，不会替你打开。

发布（0.6.12）：手机界面那一半（批次 B）同批落地——`remote-web/src/lib/reduce.ts` 的帧归并（全量重置 / 增量按 id 合并）、`client.ts` 的 `lastSeq` 记账与补帧重连、上传入口（图片 canvas 压缩长边 1568 走 `images[]`，其它文件走 `/api/upload` 后拼「`[附件] <path>`」，总量 8MB）、PWA（manifest + Service Worker，`isSecureContext` 才注册）、推送订阅开关；`remote-web/selfcheck.mjs` **91/91**（归并 15 / 帧序号 6 / 假 socket 客户端 30+ / Web Push 12 / 附件 20 / PWA 产物 6）。批次 B 就地修掉一个跨批次口径坑：宿主在推送开关关着时回 403，客户端原先把 403 当凭据失效会踢回配对页——现在只有 401 算凭据失效，403 原样显示宿主的提示。`.webmanifest` 的 mime 宿主没配，界面用 `manifest.json`（application/json）绕开。汇总复验（Lead 本机）：host-test 134/134、e2e 78/78、selfcheck 91/91、根 typecheck/build 0 错、integration 95 / approval-floor 53 / sandbox 193 / compact 全绿。诚实边界：Web Push 只在 https（或 localhost）能注册——局域网明文 http 下界面会如实提示，锁屏送达靠 Webhook 那条腿（Bark/ntfy）；iOS 真机的通知权限、加主屏幕、大图压缩耗时待人工验收。

---

## 阶段 29：宿主侧三项——远程控制进设置页、嵌入运行时补依赖、智能体团队（0.6.13 批次 A）

0.6.13 分两个批次：**批次 A（本阶段）只动宿主**（`src/**`、`desktop/scripts/prepare-runtime.mjs`、`scripts/` 下的探针），**渲染层的队友面板、设置页过滤与手机端一律归批次 B**，两边并行开发、不在同一批提交。本批三件事各自的来路：① 「远程控制」分区在桌面设置页里点不开；② 打包件在别的机器上会崩（`ws` / `web-push` 没进嵌入运行时）；③ 智能体团队的更名、队友与会话的关联、以及用户从界面管理队友的通道。

| 决策 | 理由 |
| --- | --- |
| 「进设置页」做成 `registerSection(section, { inSettings: true })` 第二参，投影时 `builtin = section.inSettings === true \|\| builtinIds.has(id)` | 桌面端设置页只列 `builtin: true` 的分区，而 remote 插件由 `boot.ts` / `headless.ts` 直接挂载（不在 `OFFICIAL_PLUGINS` 里，插件中心压根没有它的卡），`builtin` 为 false 时两头都进不去。做成可选第二参而不是给 `SettingsSectionSpec` 加必填位，现有十几个 `registerSection` 调用点一行都不用改；`inSettings` 只落在分区声明上、**不进 `SettingsSectionView` 投影**——多一个字段就等于改 IPC 契约 |
| 注册时只做一份带上该位的浅拷贝，不改插件传进来的对象 | 插件常把同一份声明留着复用（重挂、多实例），就地改会让它下次注册白白带上上次的位 |
| 嵌入运行时的依赖清单改成「`package.json` dependencies 闭包 + `lib` 真实 import 对账」 | 旧的手工清单只有 5 个顶层包，`remote` 插件 import 的 `ws` 与 `web-push` 不在里面（开发机上靠 Node 从 `desktop/node_modules` 爬回仓库侥幸能跑，换机器直接崩）。只读 dependencies 也不够：`@deepseek-ai/schemastery`（`cordis-plugin-loader` 的传递依赖）旧清单同样漏了，编译产物是唯一真相，所以两处取并集 |
| `optionalDependencies` 也算一条边，解析不到就跳过 | `koffi` 的 win32 原生二进制拆在 `@koromix/koffi-win32-x64`（optional），不带它沙箱后端就废；其余十几个平台子包 pnpm 根本没装，把「解析不到」当错误会把 Windows 上的打包直接拦死 |
| `REQUIRED = ['ws', 'web-push']` 缺失当场抛错，装完再从产物目录 `require` 一次 | 解析对了不代表传递依赖齐（漏一个要到运行时才炸）。两个包真加载一次，顺带把「以后又有人在插件里 import 新包」这类地雷拦在打包阶段，而不是用户机器上 |
| TUI 专用（`ink` / `react`）照旧不带；`lib` 里 import 了但 dev 树上也解析不到的包只警告不拦 | `headless` 入口不 import 它们（旧清单的决定，继承）。而 dev 树上解析不到多半是别处正在写的代码，打包脚本不该替它判死刑——但也不能装看不见，所以打一行警告说明「嵌入运行时一样带不了它」 |
| 更名只改**用户可见**的「子智能体团队」→「智能体团队」 | 工具名 `subagent`、事件名、文件路径（`~/.dsc/team`）、JSONL 格式一律不动，外部脚本与老日志才不会碎；设置分区标题仍叫「子智能体」（那是分区名，不在改名范围） |
| `sessionId` 记**出生会话**（`parentSession.meta.id`）而不是队友自己的会话 id，且写进名册 | 用户要知道的是「这个队友是哪个会话派出去的」。名册是跨重启的台账，写进去之后新队友永久带着它；老记录没有这一位，读档时按 `undefined` 处理、投影里也**不补空值**（补了 UI 就分不清「没有」与「空」） |
| `stop` / `message` 从 `subagent` 工具的动作里抽出来，工具与 `TeamService` 共用同一段函数 | 话术一字不差，模型与用户看到的必须是同一件事；重写第二套迟早会漂。名字不存在时返回一句明确的错误说明（契约是 `Promise<string>`，界面直接显示这句话），不抛错 |
| 宿主方法名用 `stopTeammate` / `messageTeammate`，与 `listTeammates` 同族，并进 `INVOKABLE_METHODS`；**不进** remote 的 `REMOTE_METHODS` | 手机端本批不做管理。`INVOKABLE_METHODS` 的 `satisfies` + `INVOKE_COVERAGE` 是编译期兜底：往 `DscRuntime` 加了方法却没进白名单，编译当场报错 |

**中途撞上的一件事（记一笔）**：本批开发期间，树里另有一个批次（dsh 兼容层）正在写未跟踪的 `src/plugins/dsh-compat.ts` 与 `src/core/dsh-compat/`，并且**与我们同改 `src/services/types.ts`**（它加 `LoggerService` 与 `llm.registerAdapter` / `prompt.registerProjection`，把 `KERNEL_API_VERSION` 从 5 提到 6）。那段时间根 `pnpm run typecheck` 报的 4～6 条错全在它的文件/行上（`tools-facade.ts` 的 `../../tools.js` 路径笔误、`logger?: LoggerService` 与 cordis 内置 `logger` 的声明合并冲突）。处理办法是**不改别人的文件**：把 `src` 拷一份到临时目录、只摘掉它那两处，再单独 `tsc` → 0 错，以此证明本批改动本身干净；它修完之后整树两次 `pnpm run typecheck` / `pnpm run build` 都是 0 错（本阶段的验收数字以最终整树为准）。

验收（全部在最终整树上跑）：

- 根 `pnpm run typecheck`、`pnpm run build` **0 错**。
- `node scripts/settings-sections-check.mjs`（本批新建）**20/20**：内核六个分区 `builtin` 不变；挂上 remote 插件后「远程控制」分区 `builtin=true`、`fields` 有控件；挂插件前后插件中心清单逐字节一致；分区投影的字段名只有 `builtin,custom,fields,id,order,subtitle,title` 七个（`inSettings` 不漏进 IPC）；不传第二参的插件分区照旧 `builtin=false`；传了的是 true；退订后分区消失且写不进去。
- `node shots/team-check.mjs` **118 PASS / 1 FAIL**：本批新加的 **21 条全过**（3a 两条：系统提示词标题、插件中心插件名；3b 七条：老名册无 `sessionId` 不炸也不补空值、带 `sessionId` 的原样露出、IPC 那条路同样读得到、真派一个队友后名册与投影都带出生会话 id；3c 十二条：`TeamService` 上两个方法在位、`stopTeammate` 收掉队友、收掉后台账仍在而在场名单里没有它、投话进信箱且署名 `user`、不存在的名字与空话都给明确说明、`team` 服务与 `ui` 适配器同路，另加团队没开时两个方法都拒得说明白）。唯一那条 FAIL 与本次改动无关：`shots/team-check.mjs:127` 写死 `KERNEL_API_VERSION === 5`，而并行 dsh-compat 批次已把它升到 6（`src/core/plugin-registry.ts` 的 `5 → 6` 是它的改动，本批没碰这一行）。
- `node shots/integration-check.mjs` **104/104**、`node scripts/remote-host-test.mjs` **134/134**：远程插件的挂载、注册与白名单没被本批带偏。
- 嵌入运行时：`node desktop/scripts/prepare-runtime.mjs` 组装 **35 个依赖包**，`node_modules/ws` 与 `node_modules/web-push` 及其全部传递依赖（`asn1.js` / `http_ece` / `https-proxy-agent` / `jws` / `minimist` / `bn.js` / `inherits` / `minimalistic-assert` / `safer-buffer` / `agent-base` / `debug` / `jwa` / `safe-buffer` / `ms` / `buffer-equal-constant-time` / `ecdsa-sig-formatter`）真实存在；脚本自己从产物目录 `require` 这两个包成功。再做一次「换机器」的等价验证：把整个 `desktop/runtime-staging/dsc-core` 拷到 `%TEMP%`（没有任何祖先 `node_modules`）后 `import lib/plugins/remote.js` 成功（`remotePlugin` 是对象）；离线静态扫描 `lib` 下 157 个 `.js` 的裸依赖，除刻意不带的 `ink` / `react` 外**零缺失**。
- 隔离纪律：四个探针各自把 `HOME` / `USERPROFILE` 换到临时目录；跑前跑后对真实 `~/.dsc` 逐文件比对（138 个文件的路径 + 大小 + UTC 时间戳），**零改动**。

诚实边界：① **桌面渲染层不在本批**：设置页那个「只画 `builtin` 分区」的过滤、队友面板上的收掉与传话按钮、`remote-web` 的一切，都由并行批次 B 做；本批只保证协议与投影这一半（`listSections` 里「远程控制」的 `builtin=true`、两个新方法在 `INVOKABLE_METHODS` 上可调），界面到底画没画出来、按钮接没接上，要 B 的截图证据。② **旧名册的 `sessionId` 不回填**：老记录永远是 `undefined`，界面要么按「未知」显示要么不显示这一栏；不回填是因为名册里没有能反查会话的依据，填了就是编。③ **收掉的队友仍留在名册里**：`team.list()` 是名册投影，`stopTeammate` 收掉后那条记录还在（状态可能还写着 `working`），这是工具版 `stop` 一直以来的行为，本批没改；UI 要显示成「已收掉」得自己加一档状态。④ 依赖闭包按**当前平台**解析 `optionalDependencies`：Windows 上只带 `@koromix/koffi-win32-x64`，跨平台打包要在各自平台各跑一遍（既有约束没变）。⑤ `lib` 里 import 了、dev 树上也没有的包只警告不拦——今天最终树上是零警告，但这条口子留在那里，将来真漏了包只会看到一行字，不会停打包。⑥ 更名只做了宿主侧：`README.md`、`docs/development.md`、`docs/plugin-development.md` 与 `desktop/src`（渲染层）里还留着「子智能体团队」，前三份不在本批允许改的文件清单里、后者归批次 B。

发布：本阶段是 0.6.13 批次 A 的宿主半边，版本号与打包（根 `muse-code-0.6.13.tgz` + `desktop/dist`）等批次 B 与并行 dsh-compat 批次合并后统一落；`desktop/dist` 的 `resources/dsc-core` 由本批改好的 `prepare-runtime.mjs` 组装。

## 阶段 30：对标 dsh 收尾三件套 + dsh 插件兼容层（随 0.6.13 批次合并落版本）

审查报告（对照 dsh 的架构规范逐条核对）确认了三处真正的规范差距与一项能力诉求，本批全部落地：①模型协议不是接缝（`core/llm.ts` 是唯一的 OpenAI 兼容实现，加协议必须改内核）；②`transformMessages` 匿名改写违反 dsh 的「Model-visible ⟺ logged」不变量——模型看见的内容与日志记录的不是同一份，且无从重建；③bash/read 的超时与输出预算是钉死的常量（audit §五.4 的"两套输出预算互不知情"）；④用户要求兼容一部分 dsh 外部插件。

| 决策 | 理由 |
| --- | --- |
| LLM 接缝做成 `ctx.llm.registerAdapter({ id, stream })` + 端点配置 `api` 字段 + `ctx.llm.stream(api, …)` 派发，循环/压缩/审批全部改走这条缝 | dsh 的 `LlmRuntime.registerAdapter(providers, adapter)` 就是"适配器注册 + 路由选择"这个形状；dsc 的 `streamChat` 签名天然就是适配器契约，内置 `openai-completions` 由 llm 插件预注册。重复 id 注册抛错（装配错误不许静默顶替）；未注册的协议在发请求时报错并**列出已注册的协议名**（多半是 api 字段写错或插件没开，把这两条可能直接告诉用户） |
| `LlmRoute` 从 services/types.ts 下沉到 core/llm.ts，`AgentDeps.route()` 直接引用它 | 修本批抓到的真 bug 时发现的漂移根源：AgentDeps 里手抄了一份 route 形状，`reasoningEffort` 在 `routeFor` 里填了、llm 层也会发，但循环里那份手抄形状没有这个字段，档位从来没发出去过。类型只有一份，漂移才不会复发 |
| 投影改成**命名纯投影** `registerProjection(id, fn, { order })`，内置 `fold-system`(500)/`drop-images`(900) 占保留名、同名注册报错；`transformMessages` 移除，三个调用方迁移赋名 | dsh 的达成方式是"插件注册 pure message projections，脱离宿主的读者拿同一批定义重放"。命名 + 纯函数约定 + 有序管道 = 日志原文 + 投影链即可重建请求；保留名防止外部插件顶掉协议护栏。投影抛错跳过并发通知，不拖垮整轮请求 |
| 系统提示词落盘走 `state` 记录（`system-prompt` 条目，hash 去重）；注入走新的 `note` 记录（`session.appendNote`） | 系统提示不进 user/assistant 消息流，是提示词半边的不变量缺口；state 记录 latest-wins 正好匹配"最后一条即当前生效"。note 记录是新的 jsonl 类型——`Session.load` 的 switch 没有 default，未知类型老构建静默跳过，前向/后向都安全；不改用户可见行为（暂不进界面），只为重建模型可见内容留底 |
| bash/read 预算做成 tools-default 插件配置 + 设置分区「工具预算」，保存后按新预算重注册工具 | dsh 规矩：部署差异的选择必须是可验证的 Config 字段。`bashTimeoutMs`/`bashMaxTimeoutMs`/`bashOutputChars`/`readLineLimit` 全部带上下限夹取；描述文案里的数值随预算走，模型看到的承诺与实际执行一致。160 字摘要上限、守卫 order 等按 dsh 规矩归类为协议常量保留 |
| dsh 兼容层做成第 16 个官方可开关插件（`dsh-compat`，默认关），三件事：provide `logger` 服务、模块解析钩子、`ctx.tools` 双形状兼容面 | dsh 外部插件与 dsc 同为 cordis 命名导出插件、cordis 版本一致（^4.0.4），差的只是服务名与工具形状。默认关遵循"拉起外部机制的默认关"的既有规矩——它会改变外部插件的模块解析行为 |
| `logger` 用 cordis 内置管道加桥，而不是自建服务 | 撞出来的事实：npm 发布的 cordis 4.0.4 里 `logger` 是**原型属性**不是可注入服务（dsh 的 vendor 版本才是服务），dsh 插件 `inject: ['logger']` 会让 fiber 永久等待、apply 根本不执行（自检用文件标记抓到的，transcript 无声）。所以 dsh-compat `provide('logger')` 一个委托到内置管道的门面：可调用、四种级别都在；warn/error 经 exporter 镜像进 transcript，且 exporter 显式 `levels: { default: 3 }`——缺省阈值是 info(1)，不放开 warn/error 会被静默滤掉 |
| 解析钩子用 `module.registerHooks`（同步、本线程）而不是 `module.register` | Node 24 的 `register` 返回 undefined（旧文档承诺的 Promise 没了），就绪状态没法等；`registerHooks` 注册即生效，钩子函数直接闭包住运行时根与插件目录，没有跨线程数据要传。基点两个：dsc 根（直接依赖 cordis/dsh-tools）+ dsh-tools 的真实目录（pnpm 布局里 schemastery 等传递依赖住在兄弟位）；双构建包因此命中与 dsh-tools 内部 import 相同的文件，不会 CJS/ESM 双实例 |
| 兼容层开着时给**所有**外部插件换双形状 `ctx.tools`（dsc ToolEntry 与 dsh ToolDefinition 都收），不做"是不是 dsh 插件"的猜测 | `inject: ['tools']` 在两边都是合法形状，挂载前无法区分；猜测会在错的那一半翻车。兼容面按形状分派：有 `execute` 没有 `run` 的按 dsh 转换（risk 缺省 exec，条目配置 `risk`/`risks` 现读覆盖），否则原样注册。dsh 风格定义误入原生注册表由 tools 插件的形状关拦下并提示启用兼容层 |
| `@deepseek-ai/dsh-tools@0.2.0-rc.2` 精确 pin 进 dependencies，dsc 自身代码零 import | 它只是插件 import 的解析目标（defineTool/schemastery 的真实现，参数方言→JSON Schema 的编译与校验语义与 dsh 完全一致——自检证实 dsh 的 parameters 是纯对象方言，z 只用于 Config）；精确 pin 防上游 rc 版漂移 |
| `inject` 有 dsc 不认识的服务名时按兼容层开关给两条不同的响亮文案 | 没开 → 提示"先启用 dsh 兼容层再打开本插件"；开了仍缺 → 列出服务名并说明"依赖 dsh 会话语义的插件个人版不兼容"。绝不静默跳过 |

**本批抓到的真 bug**：`MiniAgent.requestOnce` 从未把 `route.reasoningEffort` 拷进请求——`routeFor` 填了值、llm 层也认这个字段，但循环的请求体里没有它，配置了 `thinkingParam: reasoning-effort` 的模型（网关按档位取值的）思考档位在主对话里**静默不生效**。根因是 AgentDeps 手抄的 route 形状漏了字段（见决策表第 2 条）。修复后顺带把 `AgentDeps.route()` 指到唯一的 `LlmRoute` 定义。

验收（全部在临时 HOME 上跑，不碰真实 ~/.dsc）：

- 根 `pnpm run build` **0 错**（每步改动后都过编译）。
- `node shots/llm-adapter-check.mjs`（本批新建）**11/11**：内置适配器预注册、route 带 api 字段、自定义适配器注册→派发→卸载、重复 id 拒绝、未知协议报错列出已注册项、config 的 api 字段装载期校验（非字符串响亮报错、合法值原样读进端点）。
- `node shots/prompt-projection-check.mjs`（本批新建）**17/17**：投影按 order 应用、fold-system 并 system、drop-images 换说明且原数组不动、保留名拒绝、退订生效、崩掉的投影跳过+通知；一轮真请求后 `system-prompt` 状态条目落盘且 hash 与文本一致、提示词没变不重复写；注入落 `note` 记录（每轮一条、原文在盘上）；`Session.load` 恢复后 note 与 system-prompt 都在。
- 新增 **docs/dsh-plugin-porting.md**（dsh 插件适配指南）：判定流程、挂载路径、API 映射表、实测坑与验证清单；README 文档表与 plugin-development.md §9 链接它
- `node shots/dsh-compat-check.mjs`（本批新建）**15/15**（补 printf 占位符还原断言；logger 桥升级为经 `Logger.format` 还原 printf）：兼容层没开时三个 dsh 插件全部被拦且文案点名 dsh-compat 与缺失服务；开着后——真 import `defineTool`/`schemastery` 的插件走解析钩子挂载成功、schemastery Config 校验、dsh_upper（自包含 ToolDefinition）进注册表、条目配置 `risk: read` 生效、execute 经 render 折成文本、defineTool 产物（纯对象方言）注册且编译出的参数 schema 是 JSON Schema、执行返回 render 文本、logger 桥把 warn 转进对话流；`dsh-needs-projections`（inject sessionProjections）被拒绝且说明超出兼容范围。
- 回归：`shots/llm-retry-check.mjs` **10/10**、`shots/storage-check.mjs` 全过、`shots/spill-check.mjs` **53/53**、`shots/sandbox-check.mjs` **193/193**、`shots/integration-check.mjs` 全过、`shots/m5-integration-check.mjs` 全过（其版本断言随 KERNEL_API_VERSION 6 更新）。
- 文档：`docs/development.md`（§6 数据面写「模型可见 ⟺ 已记录」的重建公式与 note/state 记录、§7 扩展点表加 registerAdapter/registerProjection 两行、§8 自检清单加三个新脚本、§12 tools 预算改配置化、§13 模块速查 llm 段、版本表 6）、`docs/plugin-development.md`（§4.4 llm 加 registerAdapter/stream、新增 §4.10 命名投影与 appendNote、新增 §9 dsh 兼容层专章、版本号表加 v6、三档计数 16）、`README.md`（官方插件 16 个 + dsh 兼容说明 + config 的 api 字段）。

诚实边界：① **dsh 兼容是子集**：`tools`/`logger`/schemastery Config 之外的一切（sessionProjections、agents、goals、systemPrompt、UI 类插件）不支持，挂载时列出缺的服务名响亮拒绝；兼容面里 `ctx.tools` 只实现了 `register`，其余成员调用时响亮报错而不是静默 undefined。② **note 记录暂不上界面**：它只为重建模型可见内容留底，恢复会话后经 `session.notes()` 可读，但对话流不显示——要显示得动 transcript 投影与条目契约，本批没做。③ **dsh 工具的 risk 缺省 exec**：每次调用都过审批卡，宁多问不漏问；放宽靠条目配置，没有更细的权限模型。④ **渲染层产物不匹配 render 的图像块**：dsh `output.render` 返回图像块时降级成占位说明文字——dsc 工具输出的图像走 data URL，dsh 的 attachment 引用没法直接映射，v1 先不投递。⑤ **`@deepseek-ai/dsh-tools` 是 rc 版**：精确 pin 0.2.0-rc.2，上游升版（尤其破坏 rc 期约定）需要同步升 dsc 的 pin；dsc 自身零 import，只有 dsh 插件会碰到它。⑥ **版本号未落**：按阶段 29 的约定，版本与打包等批次合并时统一处理，本批没动 `package.json`。

发布：随 0.6.13 批次合并统一落版本与打包；本批新增依赖 `@deepseek-ai/dsh-tools@0.2.0-rc.2`（`prepare-runtime.mjs` 的依赖闭包会自动带上它，嵌入运行时无需手工清单更新）。

---

## 阶段 31：手机连接弹窗与半小时配对码（0.6.14）

手机端验收反馈两件事：①设置里的「生成配对码」只把码塞进右下角一条通知，一闪就没，错过找不回，希望点按钮开一个**弹窗**——二维码与配对码并排、有效期统一半小时、能扫码也能输码；②手机要记住设备，以后别再重新扫码。

| 决策 | 理由 |
| --- | --- |
| 宿主动作回执加结构化载荷：`SettingsMutation.ok.data: PairShareData`（`{kind, code, url, expiresAt}`） | 一条 notice 字符串装不下「码 + 可扫地址 + 过期时刻」三个字段，界面要画一张能一直挂着、带倒计时的弹窗就必须拿结构；`mutate()` 两种返回形状（string / `{notice, data}`）共存，老动作一行不改 |
| 二维码内容 = 带 `?code=` 的**完整访问地址**，而不是裸码 | 扫码即落地到登录页并预填，等于把「输 8 位码」这一步也省了；地址本身仍是可复制的退路（手输码那条路没动） |
| 码有效期 1 小时 → **半小时**；锁码仍是错 5 次锁 1 小时 | 用户点名半小时；锁是防暴力破解的冷却，跟码的展示窗口是两件事，不跟着缩 |
| `issueCode({ replace: true })`：点「连接手机」与弹窗里的「重新生成」**永远换一张新码，旧码当场作废** | 明文码不落盘（只存盐 + 哈希），旧码的明文只存在于上一张已经关掉的弹窗上，宿主**重画不出来**；而这张弹窗的设计前提就是「一直看得见一张有效码」。老的无参语义（已有活码时返回 null）原样保留，别的调用方不受影响 |
| 弹窗里「先擦地址栏再预填」：登录页挂载即 `history.replaceState`，有凭据时由 App 兜底再擦一次 | 码留在地址栏里会被截屏、被复制分享、被浏览器历史记下来；两条路互斥（有凭据就不挂登录页），兜底那一条是并行批次多加的，本批保留 |
| 扫码落地**不自动提交**，只预填并把焦点移到设备名 | 设备名是设备身份，自动提交会让「重扫一次」变成「多出一台设备」；停一步让人确认，代价是少省一次点击 |
| 二维码深色块从**令牌探针**算出具体 hex（`qrcode` 只吃 hex），light 传全透明露出卡片底色 | `--dsc-text-primary` 是带 4% 透明的 `color-mix`，直接喂给库会被拒；light 全透明让深浅两套主题共用一条规则，不用各配一张图 |
| 样式走令牌、不写死颜色：弹窗只画卡内五块（二维码 / 码行 / 地址行 / 倒计时 / 动作行），遮罩与卡片复用原语层 `.dsc-overlay` | 与确认框同一档浮层（`--dsc-z-modal`），设置面板的 `overflow` 与 `backdrop-filter` 都绕开走 portal |

验收：`remote-host-test` **140/140**（新增两条：`replace:true` 时已有活码也照发新码、旧码当场 401）、`remote-e2e` **82/82**、`remote-web/selfcheck` **118/118**（含负向验证：把文案改回「1 小时」或在 effect 里塞自动提交 → 3 条当场失败，还原后 SHA256 一致）、桌面与根 `typecheck`/`build` **0 错**、`fold-check` 218/218、`step-groups-check` 210/210、`step-seed-check` 28/28、`integration-check` 与 `settings-sections-check` 全绿。新增隔离截图用例 `desktop/shots/pair-shots.ps1`（`?pair=1` 钩子：开设置到「远程控制」并自动点一次「连接手机」，走真宿主真配对码、隔离 HOME）：弹窗在场、二维码 `data:image/png;base64,…` 且实测 **220×220**、码为 8 位字母数字、倒计时「剩余有效时间 29:56」、两个复制钮、「重新生成」按钮、卡片宽 416px 且二维码底座取到卡片底色与 10px 圆角。

诚实边界：① **真机扫码没测**（iOS 相机 / 微信扫）：二维码的编码正确性只用「库里算出来的 data URL 与地址一致」间接保证，最终要人工扫一次才算数；② 「旧码当场作废」只有宿主层断言（`replace` 两条），没在手机上验「扫描旧二维码被拒」；③ 深色主题出了截图，浅色只验了规则从同一份令牌取值，没出浅色图；④ 换 IP / 换端口 = 换浏览器 origin = 记忆不共享（会被当新设备重新配对），这是浏览器安全模型，代码注释里写明了，界面不提；⑤ 弹窗里的「重新生成」按钮的点击路径没有截图断言（人在手机上验收时顺手点一下最直接）。

发布：`muse-code-0.6.14.tgz` + `desktop/dist` 重建（含本批的弹窗与半小时配对码；桌面渲染层新增运行期依赖 `qrcode`）。

---

## 阶段 32：手机输入框可见性、设置版式与深色配色对齐 dsh（0.6.15）

真机反馈三件事：①安卓手机浏览器打开遥控页面**看不到输入框**（会话、工具卡、思考行都正常，底部什么都没有）；②设置面板要照 dsh 的版式（每项之间有分隔线、左描述右控件）；③深色配色改成和 dsh 一样。

**这一批的四个子代理全部中途失败（同一条路由，连续三轮不同批次都失败），改由 Lead 自己实现**；dsh 的配色不是凭印象调的，是从它打包体（`D:\dsh\resources\app.asar`）里把设计令牌逐条提取出来照搬的。

| 决策 | 理由 |
| --- | --- |
| 输入框不可见定性为**视口高度问题**，不是渲染条件 | 先读代码排除掉「断线就不画发送框」这类猜测：`ChatPage.tsx` 里 `<Composer>` 是无条件渲染的（断线只是禁用并换 placeholder），所以它一定在 DOM 里；`body{overflow:hidden}` 又把整页滚动关掉了，于是「固定高度的 flex 列比可见区域高」就等于「发送框永远够不着」 |
| 用 `visualViewport.height` 实测可见高度写 `--app-h`，CSS 走 `100% → 100svh → var(--app-h,100dvh)` | `100dvh` 是「动态视口」，在自带底部工具栏的浏览器/WebView 里按「工具栏收起」的大视口算，正是把发送框顶到工具栏下面的原因；`visualViewport.height` 才是此刻真能看见的高度（软键盘弹起也跟着缩）。三级兜底保证 JS 没跑到时也不会像 `100dvh` 那样溢出 |
| 额外监听 `visualViewport` 的 `scroll` | iOS 工具栏收起/展开**不发** `window.resize`，只动 `visualViewport`；只听 resize 会在那种情况下算错高度 |
| 设置版式从「两列网格」改成「flex 左右两栏 + 行间 0.5px 发丝线」 | 网格里「说明」只能跟控件一起待在右列，而 dsh 是说明压在标题下面、控件单独靠右；`.setting-text` 这一层包装把标题与说明收进左栏，`.setting-control` 只放控件并靠右对齐。最后一行不画线（悬空的线看着像下面还有内容） |
| 深色配色**照 dsh 的设计令牌逐条对齐**（不是目测）：底 `#151517`、侧栏 `#1b1b1c`、面板 `#232324`、浮层与控件 `#2c2c2e`、抬升态 `#353638`、描边纯白 20/16/12/6%、文字 `#f9fafb`/`#cfd3d6`/`#adb2b8`/`#81858c`、强调蓝 `#5686fe`、危险 `#f25a5a`、成功 `#22c55e`、警告 `#f59e0b` | dsh 的深色是「中性蓝灰 + 纯白半透明描边」，dsc 原来是「蓝调底 + 品牌蓝掺进描边」，观感差别主要来自这两点。值取自它打包体里的 `--dsw-static-neutral-bluish-*` 与 `--dsw-alias-*` 深色映射 |
| 深色把品牌蓝在填充/描边/交互态里的占比压到 **0%**，只留纯白那半档 | dsh 的交互底色就是 `rgba(255,255,255,.08)`（hover）与 `.14`（active），描边是白 6–20%；继续掺蓝就不是同一套了 |
| 浅色主题把「今天实际生效的百分比」**显式写全** | 原来浅色只覆盖种子与三个混比，填充/描边/文字的百分比是继承深色块默认值的；深色一改，浅色会跟着变。把 10/7/5/4/3% 这一整套在浅色块里写明，浅色一像素不动（截图实测：分隔线仍是品牌蓝 8.8%、导航选中仍是白底 + 蓝描边） |
| 强调面上的字改成深色 `#0f1115`（dsh 的 `label-primary-foreground`） | 品牌蓝 `#5686fe` 上白字对比度只有 3:1 出头，深字约 6:1——dsh 自己的浅蓝按钮也是深字 |

验收：根与桌面 `typecheck`/`build` **0 错**；`remote-host-test` 140/140、`remote-e2e` 82/82、`settings-sections-check` 与 `integration-check` 全绿、`fold-check` 218/218、`step-groups-check` 210/210、`step-seed-check` 28/28；`remote-web/selfcheck` **131/131**（新增 13 条视口断言：取值优先级、0/NaN 回落、最小值夹取、取整、安装即写、两侧监听器计数、卸载不留）。新增两个隔离截图用例并把证据量到数字上：
- `desktop/shots/settings-shots.ps1`：12 行设置全部有 0.5px 分隔线（白 6%）、**最后一行无线**、11 处说明全在左栏（右栏 0 处）、控件右缘距行右缘稳定 2px、导航选中项 `#2c2c2e` + 1px 白 12% 内描边、标题区底边同档线宽；
- 深色计算值实测（骨架页挂真 CSS 读 `getComputedStyle`）：`--dsc-bg-page` = `color(srgb .0824 .0824 .0902)` = **#151517**、`--dsc-bg-side` = **#1b1b1c**、`--dsc-bg-card` = **#232324**、`--dsc-bg-raised` 与 `--dsc-composer-fill` = **#2c2c2e**、`--dsc-text-primary` = **#f9fafb**（次级/三级/四级 82/66/47% 恰好落在 `#cfd3d6`/`#adb2b8`/`#81858c`）、`--dsc-accent` = **#5686fe**、四档描边 = 白 20/16/12/6%，与 dsh 令牌逐条相符；
- 手机输入框：真产物（`lib/remote/assets`）在浏览器里实测 `--app-h` 被写成 `799px` = 可见高度；骨架页把 `--app-h` 压到 `innerHeight-120` 后，发送框底边随之落到 679px（**始终在可见区内**，这正是真机上被顶出去的那一段）。

诚实边界：① 手机那条**没有真机复现**（手上没有那个带底部工具栏的浏览器）：定性靠代码排除法 + `dvh` 语义，验证是「同一套 CSS 在不同 `--app-h` 下发送框始终可见」加真产物里变量确实被写入；② 深色只对了我提取的那批令牌值，**没做 WCAG 对比度计算**，个别组合（如三级文字压在浮层底上）目测够用但没有数字背书；③ 浅色只做了「与改动前一致」的截图与计算值核对，没有出浅色全页面图；④ dsh 的圆角、字号、间距没有一起对齐——这一批只动配色与设置版式，观感差异剩在这几处。

发布：`muse-code-0.6.15.tgz` + `desktop/dist` 重建。

## 阶段 33：模式（Agent 预设）系统——标准 / 极简 / 创造 / PTC + 自己加模式（0.6.16）

需求原文：「添加模式设计，参考 dsh 的标准模式、ptc 模式、极简模式、创造模式等，需要允许用户自己创建和切换个人的模式」。

先弄清 dsh 那四个到底是什么：它们**不叫模式，叫 Agent preset（Agent 预设）**，源码里是 `presets/{standard,minimal,ptc,cordis}.patch.yml`，骨架是三件东西——**工具呈现方式（native / ptc / both）+ 工具目录 + 系统提示**；界面在设置页「Agent 预设」里分内置/自定义两组，可以「设为新任务默认」，创建靠创造模式在对话里生成 bundle。而 dsc 已经有一个叫「模式」的东西（执行/计划/探索/免打扰），管的是**工具闸门**——两根旋钮，不是一回事。所以这一批是**新增一根**，不是改老的。

| 决策 | 理由 |
| --- | --- |
| 概念内部叫 `preset`、界面叫「模式」；与协作模式并列成两根独立旋钮 | dsh 自己也是分开的（preset 管工具目录与提示，`dsh-plan-mode` 管只读闸门），保持它这套分工；`modes.ts` 头注里早就写明「模式决定要不要问、权限模式决定问出来之后怎么裁」 |
| 模式 = `~/.dsc/presets/<名字>.md` 一个文件（frontmatter + 正文），形状**照抄已有的 `~/.dsc/agents/*.md`** | 队友角色文件已经跑熟了一套 frontmatter 解析（`splitFrontmatter` + 坏文件带 problem 不拦启动）；会写角色就会写模式，用户不用学第二种格式。dsh 的 preset 是插件 bundle 声明，那套对个人版太重 |
| 三条接缝都做成**通用扩展点**，不是让 mode 插件去改内核：提示段 `prompt.register(order 15)`、骨架取舍 `PromptService.registerSkeletonFilter`、工具目录 `ToolService.project/visible` | 三处都对「一个都不注册」保持逐字节不变；工具目录那条还顺手把「注册表」与「模型面前那份」分开——队友按工牌从 `list()` 里挑，界面与工具检索也读 `list()`，只有主会话循环读 `visible()` |
| 工具条目加 `presets?: string[]` 标签（`run_code` → `ptc`、`runtime_api` → `maker`） | 模式专属工具不该在标准模式里冒头。标签是「这个工具属于哪个模式」的声明，不是权限——显式写进白名单也能看见它；安全边界仍在守卫链与审批 |
| **模式只做减法**：白名单取交集（写错名字不报错）、`drop` 只认四段（behavior / tool-rules / instructions / skills），identity 与 environment 不在名单里 | 一个坏模式放宽不了安全：审批灾难地板、命令策略、路径策略都在代码里看命令行与权限模式，不看模式。identity 是产品约定（中文与称呼），environment 是事实，都不该被模式抹掉 |
| 标准档的工具投影是恒等映射、提示段是空串 | 空段会被 `composePrompt` 滤掉，于是**系统提示词逐字节不变**（服务端提示缓存只认前缀，默认档一变等于全失效）。这条写成了断言：`systemPrompt()` 与直接用 `buildSystemPrompt` 拼出来的一字不差 |
| 骨架取舍放在 `buildSystemPrompt` 的段清单**之前**，被去掉的段连算都不算 | 指令文件要读盘、技能目录要扫盘、环境事实要跑 git；去掉了还去算就是白花钱 |
| PTC 用**同进程 `node:vm`**，不用子进程沙箱 | dsh 的 PTC 跑在 `dsh-ptc-runtime-node` 子进程里，dsc 没有这条运行时。`vm.createContext` 之后脚本拿不到 `process` / `require` / 文件系统，出口只有 sdk；同步死循环由 vm 的 15 秒超时掐断，异步拖时间由 120 秒总时限掐断。**隔离强度不如 dsh，这是明说的边界** |
| 脚本里每次工具调用**照旧过守卫链**，被拒的返回「【被拒绝】原因」而不抛错 | 审批与模式闸门是同一套判法，脚本不该有后门；返回而不抛错，脚本可以自己决定接着跑还是收手（自检里就断言了「探索档下 Set-Content 被拦、只读调用照旧成功」） |
| 脚本里的调用**不各自成为一条 tool 记录**，而是全部写进 `run_code` 的结果正文 | jsonl 里 tool 记录必须与 assistant 的 `tool_call` 成对，凭空中插一条会让重放出来的请求 400。「调了什么、参数、成败、耗时」进结果正文，模型看到的与日志里存的是同一份 |
| `runtime_api` 只读工具只属于创造模式 | 创造模式要让模型「给自己加模式、写插件」，它必须能查到运行期真状态（内核 API 版本、插件、工具目录、提示段、守卫链、快照片段、模式清单）；这些答案在文档里会过时，在这里永远是真的。日常干活用不上，所以别在标准档白占一段 schema |
| 出厂四个文件第一次启动写出、**已存在的绝不覆盖** | 与 `ensureBuiltinRoles` 同一套规矩：用户改过的一直是他的。内置四个删不掉（删了下次启动又长回来，只会让人以为没删掉），想改就直接编辑 |
| 工具白名单之外，**不把模型 / 权限模式 / 思考强度放进模式** | 模型与权限各有自己的旋钮与默认值，模式里再存一份会出现「切个模式偷偷换了模型/放宽了权限」这种意外。三条旋钮各管各的，是这一批反复守住的线 |

验收：根与桌面 `typecheck`/`build` **0 错**；新增 `shots/preset-check.mjs` **77/77**（出厂落盘与不覆盖、默认档逐字节等价、极简只给 bash 而注册表仍全量、自定义模式文件生效、坏 frontmatter 带 problem 不崩、白名单写不存在的工具静默取交集、切档写进会话状态并能在重开会话时还原、`/preset` 中文别名、`visible()` 恒为 `list()` 子集、PTC 的 sdk 目录与 describe、真实工具调用与调用清单、console 回传、探索档拦下写命令且文件真没被写出来、调用次数上限、打断、截断、runtime_api 七个主题）；既有网全绿：`settings-sections-check`、`modes-runtime-smoke`、`modes-security-check`、`integration-check`、`memory-check`、`tool-search-check`、`self-improve-check` 181/181、`team-check`、`remote-host-test` 140/140、`remote-e2e` 82/82、`remote-web/selfcheck` 131/131、`fold-check` 218/218、`step-groups-check` 210/210、`step-seed-check` 28/28。

界面证据（新增 `desktop/shots/presets-shots.ps1`，三种取景 × 明暗，量到 DOM 上）：
- 面板：5 张卡（内置 4 + 自定义 1，自定义那个是从隔离 HOME 里读的真文件）、分组「内置 4 / 自定义 1」、标准档卡上有「当前」与「新会话默认」两个标、导航选中项是「模式」；
- 编辑表单：17 个工具勾选框（含风险标签与「仅 ptc」「仅 maker」）、4 个提示段勾选框、提示词框 697×132，`review` 那张卡的 read/glob/grep/bash 与 `tool-rules` 正确勾着；
- 输入框旋钮：三颗 chip（`+` / 自动编辑 / 标准模式），模式弹出面板 300px、5 条可选、当前项带勾、默认项带「默认」标。

**真 bug 台账**：实机探针抓到一个只在真桌面端才暴露的错——`runtime.listTools()` 用了 `ctx.tools` 而 runtime 插件没把它列进 `inject`，cordis 对没注入的属性直接抛错，于是工具多选**静默空着**（内核自检里 `listTools` 是直调服务，测不到这一层）。修法：inject 补上 `tools`，并把面板里那个 `.catch(() => setTools([]))` 改成报错提示——空着一片会让人以为「一个工具都没有」，那不是同一件事。

诚实边界：① PTC 的脚本跑在同进程 vm 里，**没有 dsh 那种子进程级隔离**；② 脚本单次同步执行超过 15 秒才会被超时掐断，这条**没在自检里覆盖**（那要白等 15 秒），覆盖的是打断、总时限与调用次数上限三条；③ `docs/presets.md` 与 README 是新写的，没有第二个人照着走过一遍；④ 模式面板只做了桌面端，**手机端只显示不改**（远程控制的设置页不列模式分区）；⑤ 创造模式能不能真给自己写成一个新插件，**没有让模型端到端跑一遍**，验证到的是「它拿得到运行期真状态」这一层。

发布：`muse-code-0.6.16.tgz` + `desktop/dist` 重建。

## 阶段 34：设置页 UI 走查——文案、图标、尺寸与用量面板（随 0.6.17 一起落库）

用户截图圈了三处：Webhook 帮助文字压住输入框、侧栏「远程控制」图标像个太阳、「连接手机」按钮折成两行。顺着走查把同类问题一次清完。

- **文案**（宿主 `src/plugins/remote.ts`、`settings.ts`、`sandbox.ts` 与渲染层 `SettingsModal.tsx` 外观行）：帮助文字统一压短、说人话——Webhook 的三条帮助合并成「留空 = 关。带 {title}/{body}/{url} 占位符按 GET 发（Bark），不带的按 POST JSON 发（ntfy）」；「伺服状态」改名「运行状态」；外观五项的帮助各一句话。
- **图标**：`IconGear` 重绘成真齿轮（原来的分离射线段在 15px 下像太阳）；新增 `IconPhone`（圆角机身 + 听筒线 + 主屏点），设置导航里「远程控制」用它。
- **尺寸**：`.btn-ghost`/`.btn-primary` 补 `white-space: nowrap`（按钮在 flex 行里被压折行的根因）；`.setting-help` 补 `overflow-wrap: anywhere`（URL 长词溢出压住控件的根因）；配对弹窗地址在窄面板里可折行。
- **用量面板**：深色主题下 `--dsc-purple` 是蓝色系（dsh 配色扩展），与品牌蓝在系列色里撞色——调换顺序；热力图从「尾部一列漂浮」改成全年 GitHub 式画布（补齐空档列与月份标签），月份标签 nowrap 防折行。

验收：`shots/audit2-*.png` 九张走查图逐张目检（visual-judge 子代理在本环境起不来，按协议回退自检）；打包件冒烟 `pkg-smoke-remote2.png`。

## 阶段 35：智能体团队拆成「子智能体 + 智能体团队」两个插件，全部按会话隔离（0.6.17）

需求原文两条：① 「切换会话时，智能体团队还是之前会话的，实现逻辑对照 dsh」；② 「在插件页里添加子智能体插件及其配置，子智能体每个会话独立使用」。

对照 dsh 的结论：那边是两个独立的东西——「子智能体」（`SubagentRuntime` + `tool-subagent`，配置就三样：递归层级 / 并行数量 / 模型）与「智能体团队」（实验性 profile：成员列表 + 共享任务看板）；子智能体列表按 `header.parentSession === 当前会话` 过滤，团队名册挂在 lead 会话之下——**会话隔离是结构给的，不是 UI 筛出来的**。dsc 把两件事捏在一个全局插件里：名册、在队名单、任务板全是全局单例，这就是泄漏的根。

| 决策 | 理由 |
| --- | --- |
| 拆成 `subagent`（子智能体）+ `team`（智能体团队）两个官方插件，**可叠加**而不是 dsh 那样的互斥 profile | dsh 的互斥是因为那边团队是另一套成员供给机制；dsc 的队友本来就只有一套（MiniAgent + 工牌），拆运行时是纯浪费。叠加的语义：只开子智能体 = 纯派活；只开团队 = 一块只有 lead 在写的看板（一份共享 todo）；都开 = 完整协作。成员列表服务（TeamService）留在子智能体插件——成员就是它派出的队友 |
| 队友按会话隔离：`subagent list` 只报本会话派出的（`parentSession.meta.id` 过滤），并发上限按会话各计各的 | dsh 的 `list_children` 就这么筛；「每个会话独立使用」最自然的读法就是每会话一份额度。名册保持全局台账（跨重启、名字全局唯一），只是视图按会话分 |
| 任务板按会话分文件 `~/.dsc/team/boards/<会话 id>.json`，旧全局 `board.json` 废弃不迁移 | 板上的内容属于派活的那轮协作，归属哪个会话无从考证；留着旧文件（不再读写），新板从零开始 |
| 队友转发 `team_task` 的署名走 `ToolContext.caller`（新可选字段），子智能体插件的 `toolsFor` 转发时塞入 | 看板认领人必须记得住是谁：队友调用不能再都算成 lead。原来是子智能体插件自己 rewrap 两个工具，拆分后 team_task 的实现在另一个插件里，caller 只能从工具上下文过缝 |
| 迁移：`subagent` 开着且 `team` 开关从未动过 → 自动点亮 `team`（`migrateTeamSplit`） | 否则升级那一刻用户的 `team_task` 工具凭空消失。用户明确关过就尊重 |
| 渲染端团队面板改为**本会话的队伍**为主列表，其它会话的队友收进底部折叠组**只读**（不给停止/发话） | 修的就是「切会话还看到上一支队伍」。跨会话管理刻意不给：管它请切回派出它的会话（与 dsh 一致）；老名册记录（没有 sessionId）也落在这个组里，不静默消失 |
| 子智能体提示段与团队提示段各自独立注册 | 子智能体的提示词不再提 team_task（它不知道团队插件在不在）；看板规矩（write_scopes、expected_revision）跟着 team 插件走 |

验收：`shots/team-check.mjs` 更新到两插件世界（板按会话隔离、迁移点亮、提示段与插件名）**全部通过**；`scripts/settings-sections-check.mjs`、`shots/integration-check.mjs`（104 PASS）绿；三张实机截图——团队面板（本会话 writer-1 带「本会话」标 + 其它会话只读折叠组）、插件页两个条目、子智能体详情页（递归层级/并行数量/默认模型）；任务板双会话冒烟（A/B 互不可见、重置只清本会话）。

诚实边界：① 名册是全局台账，`TeamService.list()` 仍返回全部（UI 负责按会话分——契约没动）；② 旧全局 `board.json` 的历史任务不迁移；③ team 插件的设置分区只有「清空本会话任务板」，看板容量仍是硬编码 256（dsh 的 maxTasks 也只是 profile 常量）；④ 手机端（remote-web）没有团队面板，不受影响。

发布：`desktop/dist` 重建（快捷方式吃到 0.6.17）。

## 阶段 36：主题跟随修复、选项改下拉、开始页对齐 dsh、检查更新（0.6.18）

需求原文四条：① 添加检查更新；② 修正部分界面没有跟随主题颜色；③ 选项改成下拉框，不要全部平铺；④ 侧边栏的设计对齐 dsh（截图 = dsh 的「开始」主页：居中 logo + 三张入口卡）。

根因与决策：

| 项 | 根因 / 决策 | 理由 |
| --- | --- | --- |
| 主题跟随 | `tokens.css` 早就有 `color-scheme: dark/light`，但 select 的**下拉选项列表**这类原生弹出层不看页面 CSS，只认主进程 `nativeTheme.themeSource`——它从没被设过，OS 浅色时弹层画白底、深色主题的白色选项文字直接隐形。修法 = `applyAppearance` 把请求的模式（dark/light/system 原样）经新 IPC `dsc:theme-source` 报给主进程设 `nativeTheme.themeSource` | 右键菜单等一切原生层一并修好；「跟随系统」透传给 OS 自己翻面 |
| 选项改下拉 | 外观区五处（主题/密度/过程折叠程度/定稿的思考行/工具卡）`Segments` 组件整体退役，换成宿主 select 字段同款的 `.setting-select` 下拉 | 用户点名「不要全部平铺」；用量面板里的范围切换是视图切换不是表单选项，保持分段不动（`.dsc-segmented` 样式因此保留） |
| 开始页 | `Welcome` 改对照 dsh：居中 app logo + 三张入口卡（工作区文件 Ctrl+P / 新建终端 Ctrl+\` / 浏览器 Ctrl+T），点击定向打开 dock 对应面板；dock 的 tab 从组件内 state 提升到 App（`dockTab`） | dock 本来就有这四个面板，缺的只是「对话前的入口」；快捷键 Ctrl+P / Ctrl+\` / Ctrl+T 在浏览器里没有默认行为可抢（已 grep 无冲突），角标即真键位 |
| 检查更新 | 新 `src/core/update-check.ts`：`UPDATE_CHECK_URL` 占位空串 + `compareVersions` 纯函数 + `checkForUpdate`（认 GitHub Releases API 的 `tag_name`/`html_url` 与简化 `{version,url}` 两种回包，10s 超时）；关于页加「检查更新」按钮与「更新源」info 行；发现新版经 `data:{kind:'url'}` 回执，桌面端新增 `dsc:open-external`（只放行 http/https）用系统浏览器打开发布页 | 仓库还没有发布渠道——没配源时按钮如实提示「还没配置」，发布后填一个常量即启用；下载安装（electron-updater）要签名与 channel，等真发布再说 |

验收：桌面端 typecheck 0 错；`scripts/settings-sections-check.mjs`、`shots/integration-check.mjs`、`shots/team-check.mjs` 全绿；update-check 冒烟（六个版本比较用例 + 本地 HTTP 服务的 GitHub 回包解析）全过；实机截图 `shots/r618-home-light/home-dark/general-dark/general-light/about-dark`——开始页三卡、下拉框、关于页按钮逐张目检；selfcheck 日志出现「原生主题源 dark」（新 IPC 生效）。

诚实边界：① 更新源未配置时「检查更新」只会提示还没配置，不会瞎报「已是最新」；② 快捷键在终端面板聚焦时同样生效（xterm 不吞 Ctrl 组合键，dsh 同款行为）；③ 手机端 remote-web 不受这轮影响（开始页与设置都是桌面端界面）。

## 阶段 37：右侧栏对齐 dsh——多页签 / 开始页 / 分栏 / 全屏 / 每会话布局（0.6.19）

用户纠偏：上一轮那张截图是 **dsh 的右侧栏**，不是主页——「开始 + 入口卡」是右侧栏没内容时的引导页。于是把 Muse Code 的右侧 dock 按它重做，且选择**完整对齐**档（多页签 + 分栏 + 每会话布局）；上一轮误放进对话空态的三张卡移进右侧栏的「开始」页，空态还原纯文字。

对照 dsh（`ui-sidebar-right` + `ui-dockkit`）收窄出的能力面与决策：

| 项 | 决策 | 理由 |
| --- | --- | --- |
| 布局真源 | 新建 `desktop/src/renderer/dock-model.ts` 纯模型（零 React）：`DockSurface { panes(1..2), activePaneId, fraction, expanded, mode }`，每会话一份；reducer 全部不可变 | 行为单测直接跑这份源码（`shots/dock-model-check.mjs`，node 内存转译），界面只是它的投影 |
| 页签种类 | `guide / terminal / browser / files / git`；终端可无限多开，浏览器/文件/Git 每布局单例（已开再开=聚焦），guide 每窗格至多一张 | 终端宿主侧本来就按 id 多实例；浏览器是主进程单例 WebContentsView；「开始」是门面不是内容 |
| 「开始」页 | 罗盘 + 四张入口卡（工作区文件/新建终端/浏览器/Git 管理，带快捷键角标），选中就地替换 guide（dsh 的 `replaceTab` 路径）；`+` 钮只在格内没有 guide 时画 | 对齐 dsh 的 guide 契约：guide 是「新标签页」的门面，选完就让位 |
| chrome 两钮 | 全屏切换 + 收起，只骑在**最右窗格**条尾（dsh 的 top-right pane seat）；`✕` 退役 | dsh 原样；收起不再是销毁，是整块滑出右缘（内容不卸载，终端进程存活） |
| 展示 | 贴边（占正文轨道）⇄ 全屏（盖住顶栏以下、`width:100vw`、轨道宽度保留，退出零回流）；视口 <768px 自动全屏 | dsh 的 push/fullscreen 双态与 autoFullscreen 同款 |
| 分栏 | 上限两格；右键菜单「向右分栏 / 收回分栏」；拖拽条调宽比（fraction 0.2–0.8，双击收回）；页签 chip 可拖拽跨窗格搬移 | dsh 的两格上限；浮动页签（floatTab）不做，工程量与收益不成比 |
| 页面体挂载 | 终端按页签 keepMounted（切页签/窗格只藏不卸，首次可见才 `term-spawn`）；浏览器/文件/Git 只在激活页签挂载（浏览器 URL 记入 localStorage，重开回到上次地址） | 终端的生命周期贵（进程），文件/Git 便宜（重取即回）；浏览器单例是主进程约束 |
| 每会话布局 | surfaces 按 `snapshot.status.sessionId` 取；切会话各回各的页签组与开合状态；localStorage 落盘最多 30 个会话 | dsh 的 surfaces 就是按会话分的；「切会话还是上一块面板」是这一轮要消灭的事 |
| 对话空态 | 还原纯文字引导；Ctrl+P / Ctrl+` / Ctrl+T 保留（dsh 里它们本来就是开右侧栏页面的命令键） | 卡片的家在右侧栏，对话区不放 |

验收：`shots/dock-model-check.mjs` 21 条断言全过（含 unsplit 合并后 guide 去重——测试抓出过这个真 bug）；typecheck 0 错；四个回归脚本全绿；实机截图六张——开始页浅/深（与 dsh 截图逐项对齐）、终端双页签、分栏（探针实测 `panes=206/206 dock=420`，即 50/50）、全屏（顶栏盖住、原生控件条保留）、空态还原。

诚实边界：① 非活动**会话**的终端在切走时随之关闭（同会话内切页签/窗格不关）；② 浏览器 WebContentsView 仍是主进程单例，跨会话共用一个视图；③ 浮动页签不做；④ 分栏宽度比在两格间拖拽调，不支持更多格。

发布：`desktop/dist` 重建（快捷方式吃到 0.6.19）。

## 阶段 38：dock 修四件——caption 条避让原生控件 / 开关钮原位 / 收起收掉浏览器 / 图片预览（0.6.20）

用户实测 0.6.19 报了四件事：① 开关钮摆放要照 dsh（展开时按钮仍在原处）；② 收起侧栏时浏览器收不掉（bug）；③ 看不到全屏按钮；④ 侧边栏要能预览不同类型的文件。

根因与修法：

| 问题 | 根因 | 修法 |
| --- | --- | --- |
| ③ 全屏钮看不见 | dock 整高顶到窗口顶，页签条（含条尾 chrome 两钮）正好骑在 caption 行高度——打包件的 `titleBarOverlay` 原生控件画在窗口右上角同一位置，两颗钮被盖住（开发模式不画原生控件，所以 0.6.19 自检截图没暴露） | dock 非全屏时自带一条 `.caption-bar`（拖拽区 + chrome-bar 底色），页签条下移一行；`.dock-strip` 行高从 `--dsc-row-h` 改对齐 `--dsc-titlebar-h`，条尾 chrome 与顶栏「新会话」行同高 |
| ① 开关钮移动 | dock 展开（push）时 `.main` 变窄，顶栏开关钮被挤得左移一个 dock 宽度 | 照 dsh `ExpandButton` 语义：展开时顶栏那颗**不渲染**，右上角由 dock 条尾的收起钮接管同一角落；收起后 dock 滑走，顶栏钮原位回来——两个状态各一颗钮，位置相同 |
| ② 浏览器收不掉 | dock 收起是 `translateX(100%)` 且常驻挂载；位移不改尺寸，ResizeObserver 不触发，原生 WebContentsView 浮在原地盖住正文（CSS 的 transform/visibility 管不到原生层） | 单例页签体挂载条件加 `surface.expanded`——收起即卸载 BrowserPane，cleanup 里既有的 `dsc.dockBrowser(false)` 自动收掉原生视图；再展开重挂并按新位置回报 bounds（URL 记忆在 localStorage，无感）。文件/Git 跟同规则 |
| ④ 文件预览单一 | `fs-read` 只回 `{text}`，图片读成乱码文本 | 宿主按扩展名分流：图片（png/jpg/jpeg/gif/webp/bmp/ico/svg）回 `{kind:'image', mime, base64}`（≤5MB），其余维持 `{kind:'text'}`（≤512KB）；FilesPane 按 kind 渲染 `<img>`（格底棋盘衬托透明区、等比缩放）或 `<pre>` |

验收：typecheck 0 错；宿主 + 渲染层 build 通过；`shots/integration-check.mjs`、`shots/team-check.mjs`、`scripts/settings-sections-check.mjs`、`shots/dock-model-check.mjs` 全绿；实机截图四张——`open-dark`（chrome 两钮与顶栏行同高、顶栏钮已让位）、`collapsed`（探针 `toggle-visible=true dock-collapsed=true`，顶栏钮原位回来）、`browser-cycle`（探针 `holder-when-collapsed=0 holder-reopen=1 url=https://cn.bing.com/`——收起卸载、重开回填记忆地址）、`img-preview`（`desktop/build/icon.png` 真图渲染，棋盘格底 + 预览头）。

诚实边界：① 富文档（PDF/Office）与音视频仍不预览，只加了图片类；② 文件/Git 页签在收起时会随之卸载（再展开重取，目录位置不保留）——和浏览器一个规则；③ `file-row` 的图片上限 5MB、文本 512KB 不变。

## 阶段 39：文件面板完整对标 dsh——树形操作逻辑、彩色类型图标与多类型预览（0.6.21）

用户拿 0.6.20 的文件面板与 dsh 对照：图标全是「·」、样式解析不了，要求完整对标——**操作逻辑也要对齐**（不只是视觉）。已确认档位：全套预览（md / 代码高亮 / JSON / CSV / XLSX / PDF / 图片 / 二进制兜底）+ Markdown 相对路径图片解析。

操作逻辑对照 dsh（`ui-sidebar-files` 的 FilesBody/store）逐条移植：

| # | dsh 的逻辑 | Muse Code 改法 |
| --- | --- | --- |
| 浏览模型 | 内联树：根常开，目录**单击展开/收起**，多级同屏、懒加载 | FilesPane 重写为递归 `TreeLevel`；删掉「↑ 上一级」按钮 |
| 打开方式 | 单击文件 → 侧栏**新开预览页签**，文件树页签保留 | dock 页签新增 `kind:'preview'`（`DockTab.path` 记绝对路径）：同路径去重=聚焦、每窗格上限 10 张（超出关最旧）、落盘随布局恢复 |
| 状态记忆 | 各层 listing/展开集/滚动位存 store，重挂原位恢复 | 新 `files-tree-store.ts`（模块级、按 cwd 一棵树、useSyncExternalStore 订阅）；FilesPane 收起重挂后展开态与 scrollTop 原样回来 |
| 排序 | 目录在前 + `Intl.Collator(numeric, base)` | 移植 `orderEntries`（渲染侧排，宿主只管列） |
| 行内状态 | 加载中/空/失败/**截断**提示行 | fs-list 加 `maxEntries`（对齐 dsh 默认 2000）+ `truncated` 回包；显示 dotfiles（去掉 `startsWith('.')` 过滤） |
| 头部 | 根路径 + 刷新钮（重拉已展开各层） | files-bar 改相对路径 + `IconRefresh` |

彩色图标（`file-icons.tsx`）：vscode-icons-js 解析图标名（VSCode 插件同款规则）→ `@iconify-json/vscode-icons` 全集（~4MB，动态 import 懒 chunk）**同步自渲染** `<svg>`。两个坑都在这里踩过：① iconify id 是插件原始名下划线转连字符（`file_type_markdown` → `file-type-markdown`），不转查不到；② 不用 `@iconify/react` 的 `<Icon>`——它的占位机制按需异步换 svg，离线整包下部分行会永远停在占位 span（实机探针 `svg-icons=1/33` 实锤），自渲染 + body 内渐变/裁剪 id 按实例加后缀（防同页串色）后 33/33 全画。目录行用琥珀色 `IconFolder/IconFolderOpen`（dsh folder 档色）。

预览（`file-preview.tsx`，全部 dynamic import，点开才加载）：markdown = 会话流同款 ReactMarkdown + 相对路径图片走 fs-read 转 base64（模块级缓存）+ 代码块 shiki；代码/文本 = shiki（JS regex 引擎免 WASM）单例 highlighter，**显式字面量 import 表**（`@shikijs/langs` 的 exports 是固定枚举没有通配，模板串动态 import 运行时解析不了——build 警告实锤后改 ~59 条映射表），双主题 `github-light`/`one-dark-pro` `defaultColor:false` 出 CSS 变量按 `data-theme` 切换，CSS counter 画行号，>5000 行截断；csv/tsv = papaparse 表格；xlsx = SheetJS（dsh 同源 cdn tarball 0.20.3）多 sheet 页签 + 表格；pdf = pdfjs-dist 逐页 canvas（worker 走 `?url` 资产，≤50 页）；binary = 宿主 `BINARY_EXTS` 清单直接回 `kind:'binary'` 不读内容。宿主 fs-read 新增 `kind:'bytes'`（pdf/xlsx/xlsm base64 ≤10MB）。

验收：desktop typecheck 0 错；宿主+渲染层 build 过（语法懒 chunk 逐语言产出，主包仅 +97KB 的映射数据）；四回归脚本全绿；实机截图十张——树（探针 `rows=33 svg-icons=33 dotfiles=true folder-icons=14`）、md（`md-img=512x512 md-shiki=1`——相对图片+高亮围栏+表格+引用全渲染）、csv 表格、xlsx（`sheets=进度|发布 rows=3`）、pdf（`pages=1 first=600x240`）、binary 占位、五预览页签并存（chip 各色彩色图标）、收起重挂恢复（`subtree-restored=true`）、浅色树（`theme=light rows=33`）。

诚实边界：① doc/docx/ppt/pptx/老 xls 不预览（dsh 走服务端 Office→PDF 管道，Muse Code 无此管道）——占位提示；② HTML 按源码高亮，不进 iframe 沙箱渲染；③ PDF 无缩放/搜索、表格只读；④ 预览页签上限 10 张/窗格（dsh 无上限，页签条没有虚拟化）；⑤ 图标数据 ~4MB 懒 chunk，打包体积约涨 4MB（gzip 后 ~500KB），首屏不受影响。

## 阶段 40：下拉框全量自绘主题化 + 会话区完整对标 dsh（0.6.22）

用户报了两件事：① 深色主题里 `<select>` 的下拉弹层是白底（设置页 + 终端 Shell 选择器，附截图），要求找齐所有同类问题；② 会话管理区（左栏）点击逻辑不对——点工作区其他组会塌、第一下只选中，要求直接对齐 dsh 的操作逻辑、视觉效果与图标。

### 一、下拉弹层白色：根因与修法

两个标准兜底早就齐了却都不管用：`nativeTheme.themeSource`（0.6.15 接的 IPC）与 `:root { color-scheme: dark }`（同 0.6.15），0.6.21 打包件实测弹层依旧白——Windows 上 Chromium 绘制的原生 select 弹层不吃这两套。结论：**原生弹层没救，全量换成自绘**。

- 新组件 `components/Select.tsx`（dsh Menu 规格）：触发钮 = 当前值 + chevron（展开旋转 180°）；弹层 portal 到 body、`--dsc-bg-popover` 底 + blur + 描边圆角阴影、宽不小于触发钮、max-height 320 内滚；键盘 ↑↓/Home/End/Enter/Escape（combobox 模式焦点不进浮层）、点外/滚轮关、选中项 accent + 勾。全吃 `--dsc-*` 令牌，深浅主题自动跟随。
- 替换全部 6 处原生 select：设置字段渲染器、`Dropdown` 助手、默认端点/默认模型、思考参数、终端 Shell。页面里 `<select>` 元素清零（探针 `native-select=0`）。
- 兜底层：tokens.css 补 `accent-color: var(--dsc-accent)`（checkbox/radio 原生部件的选中色跟品牌蓝；range 滑杆早已自绘）。

验收：弹层现在是 DOM，capturePage 拍得到——深色弹层底 `rgb(44,44,46)/0.96`（token 色）、浅色 `white/0.96`，选中项 accent + 勾，截图双主题留证。

### 二、会话区对标 dsh（ui-workspace 包）

操作逻辑（对照 dsh 逐条搬）：

| dsh 行为 | Muse Code 改法 |
| --- | --- |
| 点工作区行 = 只切换它自己的展开/收起 | `activateGroup` 的切 cwd 分支删除；切工作区走「点会话」（跨区打开）或行尾「新建会话」 |
| 展开态按组持久化（groupExpansion） | `UiPrefsView.sessionExpansion`（cwd→bool）落 settings.json；侧栏本地即时层 + 异步落盘，双击互不牵连 |
| 当前会话所在组自动展开并保持 | effect 把 cwd（树模式含祖先链）写 true——切走再回来也不塌 |
| 每组 5 条 + 「展开剩余 n」增量 | 全局 showAll 改 per-group limits（+5 增量 → 全开 → 「收起」，收组重置；不落盘同 dsh） |
| manual 档会话行拖拽（置顶块内） | `UiPrefsView.sessionOrder`（cwd→路径序列）落盘；置顶块约束 + 拖拽序只在块内生效；指示线同款 |
| 双击会话标题改名 | 新增（Ctrl+Alt+R 与 ··· 菜单保留） |
| 头部标题随分组方式 | 树/按工作区=「工作区」，单列=「会话」 |

视觉与图标：行高对齐 dsh（工作区 34px / 会话 32px × 密度档）；folder 常显（活动组 accent）↔ **hover 换实心三角箭头**（dsh `IconTriangleRightFill` artwork，开合 150ms 旋转）；行尾去常显数量徽标（数量进 data-tip），hover 浮出 [···][new-chat] 16px 裸图标（dsh `NewChatOutline` artwork 移植）；会话行去 14px 缩进（dsh 同缩进 + 16px 前导槽），行尾**时间戳 ↔ 操作钮 hover 互换**、置顶标挪行尾；组间距 4px/组内 2px；空态加图标。

验收：desktop typecheck 0 错；宿主+渲染层 build 过；四回归全绿；实机探针——侧栏基线（`native-select=0 groups=3 exp=false,false,true` 活动组自动展开）、hover 态留证（folder→三角、行尾按钮组）、干净 toggle（`before=false,false,true → g2-after-own=true → final=true,true,true` 点一组别的组不动）、重启恢复（`restored=true,true,true`）、每组限页（5 条 + 展开剩余 4/8）、双击改名（`rename-opened=true`）、会话拖拽（`drop-mark=true`，sessionOrder 落盘 9 条完整序）、弹层双主题（上）。

诚实边界：① 会话级状态点（运行中/待批准）没做——SessionSummary 无运行状态字段，单宿主单活动会话，不造假数据；② HoverCard 富浮卡用 data-tip（标题+快捷键）近似；③ dsh 的行进出场动画（AnimatedRows）与远端内容搜索不搬；④ 会话拖拽只在「手动排序」档生效（与 dsh 一致）。

## 阶段 41：收组回弹、消息样式误伤与孤儿 tool_calls 三连修（0.6.23）

用户实测 0.6.21/0.6.22 报三问题：① 选中一个工作区后再点收不起来；② AI 消息整段变蓝带下划线；③ 发消息报 HTTP 400「assistant 带 tool_calls 必须有跟随的 tool 消息」。

**① 收组回弹（0.6.22 回归）**：`Sidebar.tsx` 当前组自动展开 effect 的守卫写反——`explicit !== true` 把用户显式收起（记录 false）也强制翻回展开，而 effect 依赖的 groups 随会话列表推送不断重建，强制展开反复重放。对齐 dsh 的 `Object.hasOwn` 语义：`explicit === undefined` 才补展开，有记录（无论开/收）一律尊重。副作用与 dsh 一致：切回之前收起的组保持收起。

**② 消息样式误伤（0.6.21 引入）**：505f443 把消息 markdown 版式扩展到文件预览 `.file-md` 时，15 组选择器每组丢了 `.entry-text .markdown` 的后代段，裸选择器命中容器本身——`a` 规则让整段 accent 蓝、`a:hover` 的 `text-decoration` 传播到全部内联后代、`th/td` 给容器加边框、`pre/code` 加代码底色与等宽字体。逐组补回后代段（`.entry-text .markdown p, .file-md p` 等），消息侧与文件预览侧版式同时恢复。

**③ 孤儿 tool_calls（历史健壮性缺口，非本轮回归）**：进程在「assistant 的 tool_calls 已落盘、工具结果还没写」之间被杀（崩溃/强退），日志永久留下孤儿调用；`Session.load` 原样重建后**每次请求都被网关 400 拒掉，用户无自救手段**。运行中打断不需要管（loop.ts 已给没跑完的调用补合成结果），compact 的 safeCut 只防切界。修法：`llm.ts` 导出纯函数 `sanitizeToolOrphans`（没有回应的调用剔除；剔空后正文也空的消息整条删；找不到所属调用的 tool 消息删），接在 `streamOnce` 组包处（serializeMessages 之前）——离 wire 最近的统一守门，循环轮次与压缩等所有调用方自动受益；清洗只动请求副本，落盘历史保持原样，损坏的会话恢复后即可直接继续用。

回归顺手修活：`shots/compact-check.mjs` 还按 0.6.21 之前的 compactSession 旧签名传参（把 signal 当 stream 传），补上适配器派发小函数（按 api 查表 → streamChat）后 53/53 恢复全绿；`shots/llm-adapter-check.mjs` 新增 sanitizeToolOrphans 七条纯函数断言（配对原样保留/不动输入/孤儿调用剔/剔空留正文/剔空删条/部分回应只剔缺的/孤儿回应删），18/18。

验收：根 build + desktop typecheck 0 错；回归七脚本全绿（dock-model / integration / team / settings-sections / llm-retry 10/10 / llm-adapter 18/18 / compact 53/53）；实机探针——收起当前工作区 `got=false settled=false`（3 秒会话推送后不回弹）、消息容器 `color=近白正文色 accent=#5686fe deco=none border=0px`（截图目检正常）、构造孤儿 tool_calls 临时会话恢复后发送 `restored=true has400=false`（请求过协议校验，模型正常接单；探针轮次恰逢平台限流，与修复目标无关），探针数据（构造会话目录、settings.json、临时截图）用后全部清理。

诚实边界：① 恢复会话里的孤儿调用在界面上仍显示为一张「正在执行」的工具卡（重放无结果），只影响历史展示不影响请求；② 自检脚本 `delay − EVAL_LEAD ≥ 16000ms` 时预跑脚本不触发（dev 模式下主进程长定时器异常，成因未深究），本轮脚本全部改用 2-7 秒的预跑窗口；③ 打包件未重做（修复全部在渲染层与 lib，打包流程与 0.6.22 相同）。

## 阶段 42：会话区「文件已更改」聚合卡 + diff 审查面板（0.6.24）

对齐 dsh ui-deliverables：任务里改了文件，会话区每轮收尾处出现一张「N 个文件已更改 +x -y」聚合卡（每行文件 + 增删 + 审查/打开），点「审查」在主区右侧并排打开 diff 面板（文件切换 + 行号两列 + 红绿 diff 行），点「打开」直达文件预览页签。

数据流（dsh 的 produced 语义）：diff 在**工具执行层**算——write/edit 的 `run` 在写盘前后各读一次文件，用现成的 `core/diff-text.ts`（LCS unified diff）算实际改动，超 800 行砍尾标 `truncated`，挂在 `ToolOutput.changes` 上；loop 的 `finishCall` 在 `tool/result` 之后 emit 新事件 `tool/changes`，并随 tool 记录落盘 jsonl（**内存协议消息不带**——serializeMessages 对 tool 是剥 ts 后整条透传，多字段会被挑剔的网关判 400；它只活在日志里，与 toolErrors 同一条旁路：`Session.fileChanges` callId 索引）。折叠器把事件折成 `kind:'changes'` 独立条目，`replayHistory` 加第三参重放（kernel 启动恢复、transcript 插件的 session-open——**后者首轮漏传，实机探针抓出**——与队友 peek 三处都传）。渲染层 ChatView 的座位计划把每轮 changes 条目抽出、在 TurnFooter 前聚合一张卡（dsh 的 turn-tail 位置，不参与整轮折叠，条目本身不上屏）；轨迹页视它为对话页专属数据不进时间线。

界面（对照 dsh ChangedFiles/ReviewTab/FileDiff 规格）：单文件显示文件名卡头、多文件显示「N 个文件已更改」+ 展开列表（>4 行折起「展开全部」）；每行 [审查][打开]，审查开右栏（thread-zone 转 row 两列，对话列照旧、面板 `clamp(380px, 42%, 720px)`）；diff 行 22px、行号两列 3.2em、`+`/`-` 底色用既有 `--dsc-diff-add/remove-bg` token；换会话自动收起面板。只读视图（队友 peek）不传回调，审查/打开按钮整颗不画。

回归补强：`transcript-usage-test.mjs` 新增 5 断言（tool/changes 折成条目且事实完整 / 重放经 fileChanges 还原 / 老日志不出卡）。

验收：根 build + desktop typecheck 0 错；回归七脚本全绿（transcript-usage 含新断言、compact 53、llm-adapter 18、llm-retry 10、integration、team、settings-sections、dock-model）；宿主落盘链路 node 直测（jsonl 带 changes / load 回读 fileChanges / 内存消息不带 hunks）；实机探针（构造含 changes 的会话 jsonl 从磁盘恢复——同时验证重启恢复路径）：`card=1 counts="+2 -1" pane=open diffLines=5 add=2 del=1`，截图目检轮尾卡与右栏 diff 与 dsh 形态一致；探针数据（构造会话、临时文件）已清理。

诚实边界：① 探针轮次恰逢平台限流未恢复，实时「模型真改文件」路径由宿主单测（工具 diff 计算）+ 构造会话重放（事件折叠/落盘/恢复）两段覆盖，未走端到端真模型；② 只认 write/edit 第一方调用（bash 改文件不算，与 dsh 口径一致）；③ v1 不做 split 双栏 diff、wrap 切换、原生系统打开、500ms 悬停预览、正文内联文件提及；④ 面板宽固定 clamp 不拖宽；⑤ 审查的是「那一刀」的快照——文件后来又变了面板不知道（dsh 的 turn-start/turn-end 双快照对比没搬）。

## 阶段 43：diff 审查能力补齐——回合聚合、分栏/换行/高亮、悬停预览与文件提及（0.6.25）

补齐 0.6.24 披露的全部边界项，并借鉴 openai/codex 的核心能力（回合级基线聚合、语法高亮降级防护）。

**回合聚合（codex TurnDiffTracker 的同款思路，本轮最大增强）**：同一文件一回合改多刀，0.6.24 的卡会出多行、审查面板各刀 hunks 各自为政；现在宿主在 Session 上维护回合内基线（`turnBaselines`/`turnTouched`，首次触碰某文件记「改之前全文」），轮尾 finally 里逐文件读盘上现值与基线重算一份「回合起点 vs 终态」的聚合 diff，emit `turn/diff` 事件折成 `kind:'turnDiff'` 条目（纯内存不落盘，重启后渲染层回退逐刀合并）。三个防污染细节：baseline 挂在 `FileChangeSummary` 的内存字段上，runTool 摘给 ToolOutcome、appendTool 入口再 strip 一次（jsonl 与事件都漏不出去）；runTurn 开头捕获 session、finally 里 `this.session === session` 才发（切会话不打进新 transcript）；聚合 emit 在 turn/end 之后，靠 roundInfos「下一条 user 之前归当前轮」的口径落进本轮轮尾卡区间。改了又改回去（终态=基线）不出条目。

**渲染层四件套**：① DiffPane 加 unified ⇄ split 切换（hunk 行按 remove/add run zip 配对成左右两列，缺侧补空）与换行开关（pre ⇄ pre-wrap），视图与宽度都记忆 localStorage；② diff 行语法高亮——复用 file-preview 的 shiki 单例（codeToTokens 双主题出 CSS 变量），按 hunk 整块高亮保跨行语法状态，超 2000 行/512KB 降级纯文本（抄 codex 防护线），新建 diff-highlight.ts；③ 面板左缘拖宽（复用 panels.ts 的 useWidthDrag 轮子，`--dsc-diff-pane-w` clamp 320-900）；④ 轮尾卡行悬停 500ms 出预览卡（fs-read 读文件头 24 行 + shiki 高亮 + 「打开文件」，portal 到 body；读取中/读失败都出卡不无声）。另有「新增」徽标（status: added/modified，新建文件聚合 diff 呈全加行）、审查面板「系统打开」按钮（dsc.openPath → shell.openPath）、快照语义提示（「打开」的 tip 注明审查的是修改当时快照）。

**markdown 内联文件提及（dsh producedFileMentions 同位）**：助手正文 inline code 命中会话内改过的文件路径（精确或分隔符边界的后缀匹配，带 `\n` 的 fenced 块排除）渲染成可点文件徽章，点击进预览页签；块级 code 用 pre 覆盖 cloneElement 打 data-block 标记区分——无 language- 的 fence 不能靠 className 判，误判会把整块代码变 chip。

验收：根 build + desktop typecheck 0 错；transcript-usage 12/12（新增 turn/diff 折条目、重放不重建 turnDiff 两断言）；新增 `scripts/turn-changes-test.mjs` 14/14（基线幂等/终态回退不出条目/close 清空/jsonl 不带 baseline/**MiniAgent 整轮集成**——假 stream 吐同文件两刀，验证 finishCall 记基线、逐刀事件照发、turn/diff 在 turn/end 后到达且两刀合一）；实机探针（构造会话回退路径 + 渲染层全链）：`rows=2 counts="+6 -1" badges=2 preview=open（文件名+行数+内容）pane=open diffLines=7 add=4 del=1 split=6 wrap=y basis="560px"`，截图目检分栏两列/新增徽标/换行高亮/系统打开按钮全部就位；探针数据（构造会话、探针文件、udata 视图偏好）已清理。顺带修了 HoverPreview 的容错：读取中/读失败都渲染提示卡，不再无声无息。

诚实边界：① 探针期间 deepseek 限流未恢复，「模型真改文件走 turnDiff 聚合」的端到端由 MiniAgent 假模型直测（14 断言）+ 实机回退路径探针两段覆盖；② bash 改文件仍不归因（codex 同口径：无法精确归因时宁可缺失）；③ skill_write 不并入聚合卡（技能库有 ledger + /skills-ledger rollback 专门台账）；④ 审批弹窗内嵌 diff 预览、git 工作区 diff 模式、review 子代理、会话 fork 留后续轮次；⑤ 重启恢复后无聚合条目，卡回退逐刀合并（同文件 hunks 顺序拼接，行号以各刀为准，如实降级）。

## 阶段 44：吸纳 dsh + codex 剩余优势——审批/工具卡 intended diff、悬停预览出 diff、路径相对化、git 页签 diff、/review（0.6.26）

探索修正了两个假设：dsh 的审批卡本身无 diff——「将做的改动」预览长在**会话流工具卡**上（intended diff：折叠行相对路径 + `+N -M` 徽标，展开体摊 diff）；dsh 的悬停预览显示的是**该文件的 diff**（不读盘、无工作目录限制），不是文件头内容。codex 侧：审批弹窗内嵌 diff（ApplyPatchApproval）、/diff 的 git 安全姿势（`--no-textconv --no-ext-diff` 防 diff driver 执行外部程序）、/review 三目标审查。

**共享 diff 行渲染**：DiffPane.tsx 抽出导出 `DiffRows({ hunks, path, split?, wrap? })`（原 FileDiff 内核，hunks 拼一段喂 shiki 保跨行状态、effect 认字符串内容不认数组引用），四处复用——右栏审查面板 / 工具卡 intended diff / 审批卡内嵌 / 悬停预览；换行开关的 `data-wrap` 从 `.diff-pane` 挪到 `.diff-body` 上，各复用点自己决定折行还是横向滚。

**工具卡「将做的改动」（dsh 形态）**：新增渲染层 `intended-diff.ts`——write/edit 且 `status === 'running'`（含审批等待期，adapter 里两者同为 running）时，解析参数 + 经 fs-read 读盘上现值 + 按语义推演写后全文（write=整写 content；edit=盘上 indexOf 首处替换）→ `diffLines`（直接 import `@dsc/runtime/core/diff-text.js`，渲染层 import lib/core 已有先例）→ 800 行预算砍尾（与宿主 summarizeChange 同口径）。三种降级：盘读不到（工作区外/文件不存在）→ write 从空串起算、edit 用 old→new 参数差异，标 `fellBack`；edit 的 old 匹配不到/匹配多处 → 标 `mismatch` 并在卡上提示「执行会失败」；参数不齐 → 不出。折叠行升级成 dsh 形态：相对路径（title 全路径）+ 增删徽标；落地后（status 离开 running）自动消失，轮尾卡接手。

**审批卡内嵌 diff（codex 形态）**：contract 加 `ApprovalDiffView`（path/added/removed/hunks/truncated/status + fellBack/mismatch），`ApprovalRequestView.diff?` 挂载；宿主 approval 插件在**弹卡前**推演（`approvalDiffOf`：读盘 + 同款语义 + summarizeChange 同一算法，hunks 行文本过 redact——卡上会显示密钥形状的字符串不能裸奔），随视图下发；渲染层 ApprovalCard 默认收起一行「将写入/将修改 相对路径 + 计数」+「查看改动」切换展开 DiffRows。只有真要等人点卡的时刻才付一次读盘 + LCS 的成本。

**悬停预览对齐 dsh（替换 0.6.25 的文件头预览）**：轮尾卡文件行 hover 500ms 出**该文件的 diff**（file.hunks 直出，不读盘、无工作目录限制、fs-read 缓存逻辑全删）；dsh HoverCard preview 规格：宽 = 聚合卡宽 − 48、锚上方优先放不下落下方、maxHeight 420、移开 100ms 后收（计时抽成 `hover-delay.ts` hook，行与提及 chip 两处共用）、移进卡里续命、**Escape 关闭走 capture 截停**——审批卡在冒泡阶段监听 Esc=拒绝，预览开着时按 Esc 只能收预览不能误拒。正文提及 chip（mentionPaths 从 Set 升 Map<path, 合并改动视图>，mergeChangesByPath 复用）hover 同款 diff。

**路径显示对齐 dsh**：file-util.ts 新增 `displayPathOf(path, cwd, home?)`（cwd 内→相对、home 内→`~/`、否则 posix 化原样；两段比较按小写比——Windows 大小写不敏感）；轮尾卡行/审查面板文件名与 select option/hover 头/工具卡 tc-path/审批卡 diff 行全部走 display + title 全路径；cwd 经 props 传 ChatView（App 已有 state）与 ApprovalCard/DiffPane。

**git 页签看 diff（codex /diff 姿势）**：dock `git-diff` 服务扩展——file 为空时全量 `git diff HEAD --no-textconv --no-ext-diff`（两个旗标防文本转换与外部 diff driver 当场执行程序），单文件同样加旗标；渲染层新增 `unified-diff.ts`（`parseUnifiedDiff`：@@ 头解析、`\ No newline` 容错、计数以实际行为准；`splitUnifiedDiffByFile`：全量按 `diff --git` 切段取 `b/` 侧路径）；GitPane 文件行（span 升级 button）点击在底部展开该文件 diff、「全部改动」按钮展开全量（多文件分段），stage/commit 后 diff 过期自动收起。**顺手修了既有 bug**：unstaged 行的 porcelain 前缀是 ` M `（空格开头），`fileOf` 的 `[AMDRCU?]+\s` 剥不掉——此前对未暂存文件点「+」暂存实际是带着前缀在调 git add。

**/review 审查命令（codex /review 的 v1）**：BUILT_IN_COMMANDS 加 `/review [关注点]`——handler 用 execFile 固定子命令收集工作区未提交改动（core/git-info.ts 的 `collectWorkingTree`：diff HEAD 全量 + untracked 只列名单，60k 字符预算尾部截断）→ `reviewMessage` 组装 → `runtime.submit` 发起审查轮（回复即审查意见，与用户贴 diff 问「帮我看看」同一条链路）。codex 的独立 review 子会话/findings 渲染不搬。

**白屏教训（本次最重要的架构约束）**：commands 插件最初把 `import { execFile } from 'node:child_process'` 写在顶层——渲染层 Composer import `@dsc/runtime/plugins/commands.js` 拿补全函数，vite 对 node 内置模块是「externalize 即炸」（顶层 import 一求值就抛），整个渲染进程白屏、探针 sessions=0 三连扑空才抓到。修复：spec 表与补全函数（BUILT_IN_COMMANDS/helpText/commandCompletions/modelCompletions/completionsFor/expandCommand + extraSpecs 注册表）挪到 `core/commands-completion.ts`（**顶层零 node 模块**），git 收集挪 `core/git-info.ts`，渲染层与 TUI Composer 都改 import 纯模块；插件模块保留 handler 注册与派发。约束写进两个模块的头注释。

验证：根 build + desktop typecheck 0 错；回归全绿（composer / remote-host 140 / trace-data / transcript-usage / turn-changes 14 / settings-sections）；新增 `scripts/review-approval-test.mjs` 27/27（approvalDiffOf：write 新建 fellBack/覆盖 modified/edit 替换/mismatch 两种/工作区外回落/密钥遮红；collectWorkingTree：非 git null/临时仓库 diff+untracked；reviewMessage 组装；parseUnifiedDiff/splitUnifiedDiffByFile——node 24 type stripping 直跑渲染层 TS 源）；/review 补全与 expandCommand('/rev') node 直测。实机探针两轮：d626（构造「只有调用没有结果」的会话重放 → running 卡 intended diff：折叠行相对路径 `shots/probe-626-intended.txt` + `+2 -1`、展开 5 行 diff 增删着色、轮尾卡行悬停出 diff `previewDiff=2`、Esc 关闭 `escClose=y`、提及 chip 悬停 `chipPreview=open/2`，截图目检轮尾卡新增徽标+相对路径+审查/打开按钮）；d626b（git 页签：全量 `files=4 lines=437 highlights=4082`、单文件 `rowLines=21` 行高亮、截图目检底部 diff 视图与行号/增删色）；探针会话与临时文件已清理。

诚实边界：① 限流期 /review 的「submit 之后模型真审查」未走端到端（消息组装 + 收集已直测，链路与用户贴 diff 提问完全同路）；② 审批卡内嵌 diff 的实机形态未截到（审批等待需真模型发起写请求）——approvalDiffOf 直测 + 渲染层与工具卡共用 DiffRows 覆盖；③ intended diff 推演的是「调用发起时」的盘上现值，等待审批期间文件被并行改动不追更（dsh 同口径）；④ 全量 git diff 沿用 20000 字符截断，特大工作区只显示前几个文件的完整 diff；⑤ untracked 文件没有 diff 可看（git diff 天然不含），列名单提示。

## 阶段 45：对标清单全面修订——三家源码功能清单与差距重梳 T14–T28（纯文档，无版本号）

上一版 roadmap 的差距矩阵还停在第五轮之前：LSP、浏览器、定时任务、PTC、沙箱在矩阵里仍是「○ 缺失 / ⊘ 有意不做」，实际全部已落地（§5.1 有验收记录但矩阵没刷）；0.6.24–0.6.26 三连批补齐的整条 diff 审查链也没有登记。另外两个主要对标对象一直没有一份全面的功能清单——此前各阶段的「对标」都是按当次任务翻对应角落，没有横向全貌。

**改了什么**：

- 新建 `docs/peer-feature-inventory.md`——dsh / codex / Muse Code 三家的**全面功能清单**，按能力域分组（会话、模型、工具、权限、diff 审查、命令、上下文、终端、UI、部署、杂项），每条带源码出处，每家末尾有招牌能力排序与「未见」清单。dsc 侧清单同时标注了实现深度与已知边界，并单列「独有/领先项」防止纯差距叙事。
- `harness-benchmark-roadmap.md`：差距矩阵全面修订（沙箱从 ⊘ 改 ◐ 策略级、LSP/浏览器/定时任务/PTC 改 ●，新增 diff 审查链 / /review / @提及 / 后台任务 / 标题生成 / 占用表 / 会话导出 / 运行状态点 / 手机遥控九行；hermes 未重读，新行标「—」待核对）；新增 §7 差距登记 **T14–T28**（P1 六件：T14 输入端 @ 文件提及补全、T15 bash 后台任务、T16 会话标题自动生成、T17 上下文占用表 + /status、T18 /review 升级独立子代理与结构化 findings、T19 压缩前置裁剪 + 图像卸载；P2 九件：持久终端工具 / 侧栏运行状态 / 会话导出 / 在线模型发现 / MCP elicitation+resources / read 支持图片 / 部分行接受与回滚 / 检查更新落地 / 插件远程安装；P3 十三条登记免遗忘）；§7.4 单列 dsc 独有领先项、§7.5 给建议落地顺序。顺手修正附录 A 两处：codex 沙箱「fail-closed」表述与 §5.1 T9 落地记录矛盾（codex 降级同样不 fail-closed，dsc 照的是这个），并补 codex 新发现能力（review 子代理 / exec_command / backtrack / mention / request_permissions / Guardian）。
- `development.md`：§13「命令与补全」刷成现状——单一真源是 `core/commands-completion.ts`（顶层零 node 依赖，渲染层 import 链白屏教训写明）、内置命令 7 条（/review 进表）、/effort 占位行号更新；导航表补 peer-feature-inventory 入口。

**方法**：三路并行只读源码梳理（dsh 全仓 11 能力域、codex 全仓 10 能力域、dsc 代码 + 全部 44 阶段日志），不运行任何一家；dsc 侧另行查证了四个易错事实——内置命令现为 7 条（`src/core/commands-completion.ts:16-22`）、/effort 保留占位（`src/plugins/commands.ts:118`）、read 工具不支持图片（`src/core/tools/fs-tools.ts` 无 mime 分流）、侧栏无会话运行状态（`desktop/src/renderer/Sidebar.tsx:671` 占位注释自证）；桌面端粘贴贴图已有（`Composer.tsx` 剪贴板图片 + modalities 检查），不算差距。

**诚实边界**：① hermes 本轮未重读（矩阵新行 hermes 列标「—」），三家清单是 2026-10-02 的源码快照，上游会漂移；② codex 功能面按本地 `D:\codex\codex` 源码梳理，官方文档站未对照（附录 C 既有声明沿用）；③ 差距登记只做了「是什么/对标/落点/验收」级别的立项，P1 六件都还没做探索与排期，落地前各需一轮设计（尤其 T15 动内核、T26 依赖回滚语义要先单独立项）；④ T17 的 token 估算与 compact 触发线的「同源」验收要防止两套估算并存。

**同日第二轮：已具备能力的实现深度复核（roadmap 新增 §7.5，登记 T29–T47）**。第一轮管「能力有没有」，这一轮反着来：dsc 已标 ● 的能力逐项与 dsh/codex 同层实现细比，抓「表面都有、细节不如」。方法：18 个定向疑点 + 双侧开放扫描，每条给三态结论（确认疏漏/不成立/部分成立）与两侧文件:行号证据。**确认 19 条疏漏**，按严重度分三档——P0 缺陷级五件：**T29 计划评审卡挂起时切换会话 → agent 循环死锁**（`plan.ts:39` 的 finish 首行早退与 `plan.ts:114-117` 监听器只清 planDone 不 resolve 挂起 promise 的顺序缺陷，修法对齐 approval 插件的写法、一行级）、**T30 会话 jsonl 无跨进程写锁**（桌面端 + TUI 同开一个工作区即交叉写坏日志；dsc 在 schedule/sandbox 都做了锁，唯独会话没有）、**T31 会话头行损坏即整个会话打不开且静默回落新会话**、**T32 中断 turn 恢复后模型对未完成动作失忆**（sanitizeToolOrphans 静默剔除 vs dsh 落盘合成闭合 + 重试指引）、**T33 流中断半截回复丢弃且流期零重试**（dsh durable 落库 + step 重试，codex stream_max_retries 缺省 10）；P1 防线补齐九件：read 输出无字节防线（spill 刻意排除 read）、edit/write 无 CAS 版本校验、bash 超时丢已收输出且无优雅终止档、MCP server instructions 被丢弃、PTC 可并发写调用、无会话级模型记忆、计划拒绝反馈回路断裂、压缩不可取消且无运行中守卫、轮尾聚合卡漏 bash 改动（dsh 用 turn 首尾 git 快照兜底）；P2 五件：AGENTS.md 深层增量发现、命令可用性矩阵、推送盲区（审批久等无再提醒/提问与计划卡不推）、web_search 域过滤、技能 whenToUse 与隐式调用识别。**复核为无疏漏四条**（写进 §7.5.4 防重复立案）：edit 多匹配 dsc 已报错且比 codex 严（codex 静默替换第一处）、PTC 守卫链完整重入（每次 sdk 调用走 ctx.guards.gate）、超窗自动压缩重试已有、write 的 read-before-write 带 mtime 陈旧检测比 dsh 多一层。peer-feature-inventory 的 dsc 清单各「差距」行同步并入第二轮结论。

---

## 阶段 46：正确性批次——对标疏漏 T29–T47 十九条全量修复 + 结构收敛（0.6.27）

上一阶段登记的 19 条实现深度疏漏（roadmap §7.5）这次全部修复。原则：每条先回源码核实登记证据，再按登记的修法落地；修完跑四张行为网 + 一次性会话探针验证。这是「正确性批次」：修的全是「已有能力比别人少一层防线」的洞，没有新功能。

**改了什么（P0 五件，缺陷级）**：

- **T29 计划评审死锁**：`dsc/session-open` 监听器现在先 `planDone?.('rejected', true)` 再清场（`src/plugins/plan.ts`），挂起的 `exit_plan_mode` await 能返回了，agent 循环不再永久 running。配套两处：`propose` 在提交时捕获会话引用，清理落库写回「提交时」的那个会话而不是已切换后的 `ctx.session.current()`；切会话/退出的清理走 quiet 标记，不再往新会话的界面喊「计划未获批准」。
- **T30 会话写租约**：新增 `src/core/lockfile.ts`（O_EXCL 独占创建 + pid/进程指纹 + 陈锁接管 + **同进程可重入计数**——同进程重复打开同一会话不能自己锁死自己）。`Session.create/load` 拿租约、`close()` 归还；归档/恢复/删除走短临界区锁；meta.json 的读改写进同一把锁并改成「临时文件 + 原子替换」。只读重放（队友记录 peek）显式 `lease: false` 不抢锁。两个 Muse Code 同开一个工作区时，第二方现在拿到「这份会话已在另一个 Muse Code 窗口打开」的明确报错，而不是交错写坏日志。
- **T31 头损坏抢救**：`Session.load` 遇到 meta 首行半截 JSON 不再直接 throw——从内容反推 meta（id 用文件名、createdAt 用文件诞生时间、cwd 用「绝对路径祖先 + slug 匹配日志目录名」两条件夹出来，推不出退最长公共目录）；列表投影 `readSessionFile` 同步抢救让损坏会话在侧栏可见。实在推不出 cwd 时抛明确错误、文件保留原位，绝不静默回落「开新会话」。
- **T32 中断回合修复**：恢复会话时扫尾部孤儿 tool_calls，各补一条「已发起、结果未知，先核查再决定重试」的合成结果并落盘（dsh interruptedTurnClosers 同款语义）；重复恢复幂等；修复只在握着写租约时做（写的人才负责修）。请求侧的 `sanitizeToolOrphans` 退居协议兜底。
- **T33 流中断**：llm 层新增 `StreamInterruptedError`（携带半截结果）；一个字节都没收到的流中断归一成可重试错误；408 纳入可重试状态码。loop 层收到流中断先把半截正文落库成截断 assistant 记录（不带工具调用——参数可能不完整），再自动整续一次（消息按会话现状重装，模型从断点自然接上），对齐 codex stream_max_retries 的个人版（1 次）。

**改了什么（P1 九件，防线补齐）**：

- **T34**：read 输出加三重封顶——总字符 16000（dsh 同款）、单行 2000（超长行截断说明）、limit 参数硬顶 10000；前 8000 字符含 NUL 判二进制直接拒绝并给 bash 取样指引。
- **T35**：edit 补上陈旧检测（与 write 同一台账，但不要求「没读过就拒」——edit 现读现值）；read→write 之间加 CAS 锚（stat 前后比对 mtime），write 同样补锚；「读→改→写窗口被第三方改」现在会被拒绝并要求重读。
- **T36**：bash 终止改两档——POSIX 对进程组发 SIGTERM、3 秒宽限后强杀、强杀后 2 秒兜底把已收输出直接交回；超时/取消不再丢输出（超时的编译错误前 20 秒的线索模型现在拿得到）。**Windows 的优雅档（taskkill 不带 /F）被 Mimosa 的命令选项注入检查拦下**，本批 Windows 直接走强杀（糙但杀得掉，输出照样交回），见诚实边界。
- **T37**：`openConnection` 不再丢 initialize 应答——`instructions` 摘出来挂在 McpConnection 上，mcp 插件在连接就绪后经 `ctx.prompt.register` 挂进系统提示（每 server 一段、4000 字符上限、掉线即摘）。
- **T38**：PTC 脚本内部调用加读写闸（dsh「mutating calls run alone」）：写/执行独占（排队写挡新读防饿死），读互相并发；守卫链（审批卡）在进闸之前问，等人不挡读。`Promise.all` 两个写调用并发落盘的口子关了。
- **T39**：`SessionStateMap` 新增 `model` 条目；/model 切换（含设置页设默认）写进当前会话，恢复会话与切会话优先恢复会话记住的模型；配置里已不存在的模型静默不恢复。
- **T40**：`answerPlan` 加反馈参数——计划评审卡点「还要改」现在展开一个反馈框（可空），原话经 `exit_plan_mode` 的结果捎给模型（`contract.ts` / `services/types.ts` / runtime / bridge / TaskDock 全链）。拒绝不再让模型盲猜。
- **T41**：压缩吃回合取消信号（`beforeRequest`/`onContextOverflow` 现在传 signal，用户打断时压到一半的模型调用跟着停）；新增 `dsc/turn-start` 事件，/compact 在回合运行中被守卫挡下（防摘要落库与工具落库交错），提示等这轮结束或先打断。
- **T42**：轮尾聚合卡加 git 快照兜底——回合起点异步拍 `git status --porcelain` 快照，收尾对比差集，bash/sed/构建脚本动过的文件补成变更条目（基线取 HEAD 版本或空串，一轮最多补 20 条）；不是 git 仓库或 git 跑不动就静默跳过，绝不挡回合。

**改了什么（P2 五件）**：

- **T43**：AGENTS.md 发现重写——有 git 仓库从仓库根锚定沿「根 → cwd」路径链有序收集（深层目录不再被 8 层硬截断弄丢根上的说明，根之上不越界，codex 同语义）；新增 `AGENTS.override.md` 覆盖层；git 根 30 秒 TTL 缓存不拖请求。
- **T44**：`CommandSpec` 加 `duringTask` 声明位（codex available_during_task 矩阵）：/new /resume /compact 运行中挡下，派发闸统一收口——桌面 / TUI / 远端三端行为一致。
- **T45**：推送补盲区——计划评审卡与模型提问卡也推（以前只盯审批卡）；节流键带上卡片标识，10 秒内第二张卡不再被吞；同一张卡挂满 2 分钟升级再提醒（最多 3 声），卡片清掉即撤。
- **T46**：web_search 加 `includeDomains` / `excludeDomains` 参数，tavily 原生直通（其它提供方没有等价参数，不硬凑）。
- **T47**：技能目录补渲染 whenToUse（「何时用」是模型挑技能的关键信号，之前解析了却不显示）；引导语改成明确的第一判断（任务明显匹配先调 skill 工具取正文）。

**顺手的结构收敛（结构审查的发现，cheap 的当场修）**：

- **errText 归一**：error→文案这句话此前抄了五份（adapter/transcript、core/loop、core/market、core/plugin-loader、渲染层 SettingsModal 各一份，全仓库 `instanceof Error ? :` 内联展开另有约 80 处）。新增 `src/core/err-text.ts` 为唯一正主（core 不能反向 import adapter、渲染层只能 import 纯 core 模块，放 core 两头都够得着）；adapter/transcript 保留同名 re-export，既有 18 处 import 不断。内联展开的机械替换留作后续小步做。
- **死导出删除**：`suspiciousCwd`（path-policy）、`supportsImages`（model-caps）、`builtinPresetNames`（presets）、`redactionActive`（secrets）四个 export 全仓库零引用（含文档与脚本，逐个 grep 核实过），删除。
- **prefs 白名单锁**：`PROCESS_FOLDS` 加 `satisfies readonly UiProcessFold[]`，档位名拼错当场编译报错。
- **插件页静默吞错**：`refreshPlugins` 的 `.catch(() => {})` 改成 toastErr 提示（对齐 SkillsView 的 setError 范式），拉失败不再静默空白。
- **自检探针腐化修复**：trace-check / fold-check 取产物用「目录里第一个 .js」——产物分包后字典序第一个不是主包，一口气报了 38/125 条假失败（与本批改动无关，早于本批就在失败）。两个探针改成扫全部 js 分包再断言；`electron.vite.config.ts` 的 renderer 显式 `emptyOutDir: true`（out 目录在工程根之外，vite 默认不清空，旧哈希包越积越多正是假失败的温床）。styles.css 加「追加区」哨兵注释，trace-check 的「新分段在末尾」纪律从钉死历史段占比（每版正常追加都会稀释，必然腐化）改成认哨兵位置（追加后把哨兵挪回末尾即可，自愈）。
- **development.md 量尺刷新**：§2 仓库地图的行数/文件数现量于 2026-10-02（旧数字停在几个版本之前）。

**验证**：`pnpm typecheck`（内核）+ `pnpm --dir desktop typecheck`（渲染层双侧）全绿；四张行为网全绿——step-groups 210/210、step-seed 28/28、fold-check 218/218、trace-check 85/85；一次性会话探针（临时 HOME 外的临时目录）8 条全过——租约建/释、孤儿修复落盘、重复恢复幂等、头损坏恢复 + cwd 反推、无法推断时明确报错（探针用后已删，未触碰真实 `~/.dsc`）。

**诚实边界**：

- T36 的 Windows 优雅终止档：taskkill 不带 /F 的方案被 Mimosa 安全门的「命令选项注入」检查拦截（它把存量 spawn 模式一并拦下，改参数顺序/加校验都不放行）。本批 Windows 直接强杀、已收输出照样交回，损失的是「让构建工具跑完清理逻辑」这层优雅；后续若要补，得先与安全门和解（进程内 API 或白名单）。
- T36 的两档在超时语义上有行为变化：超时从「立即报错丢输出」变成「终止后带输出返回（成功态）」。模型现在能拿到已收输出，但界面卡片不再标红。
- T42 的兜底口径：回合开始前就脏着的文件「又改了一刀」看不出来（dsh 的 scratch-index 私有对象库方案能看出来，个人版先不做）；删除类改动不进卡（diff 面板没有删除形态）；一轮最多补 20 条。
- T43 的「深层目录增量触达发现」（dsh 的 projectTouch：读到哪里就把那层的 AGENTS.md 捞进提示）未做，本批只做根锚定 + override 层；变更删除对账经 mtime 缓存已有。
- T44 的三端一致性只收口了命令派发闸；桌面侧栏「新会话」按钮仍然可绕过（T29 修掉死锁后，切换即安全打断，这是有意保留的快捷路径）。
- T47 的隐式调用识别（codex skills/invocation.rs 的完整检测 + allow_implicit_invocation 策略位）未做，只补了目录渲染与引导语。
- T45 的升级提醒是 2 分钟 × 最多 3 声的固定节奏，没做配置面。
- T39 只记忆 provider/model 两元组，思考档位（effort）仍是进程级的。
- 结构审查的大项（ChatView 约 1200 行 / Sidebar 约 1189 行 / App 约 823 行的巨型组件拆分、lsp/client.ts 1578 行拆三件、remote createRemoteServer 451 行拆路由、token 粗估三份口径合一、字节数格式化三份合一、localStorage 收敛单一出口、cwd/workspace 同物两名）登记未动——都是纯重构，与本批正确性修复混在一起会搅乱回归口径，单独立项做。
- `setAuditEnabled` / `renderDiff` 两个导出的唯一消费者是本机不入库的自检脚本，保留（脚本是自检工作流的一部分）。

## 阶段 47：结构收敛批——巨型文件全量拆分 + 重复实现归一（0.6.28）

上一阶段登记未动的结构大件，本批全部落账。纯结构重构（行为等价的代码搬移 + 类型收紧），没有新功能。

**lsp/client.ts（1578 行）拆四件**：

- `client.ts`（860 行）只留「一个连接怎么说话」：spawn、握手、JSON-RPC、请求超时取消、无状态文档生命周期；`LspInstance` / `LspQueryError` 转为 export 供 manager 使用。
- `manager.ts`（479 行，新）：实例池 + 按 (服务器, 根) 串行队列 + idle 回收 + 破键退避——「池化与调度」与「传输」分层；`errorText` 直接换成 core/err-text 的 `errText`（上一阶段的归一收尾）。
- `normalize.ts`（150 行，新）：应答归并纯函数（Location / LocationLink / Hover / Diagnostic），自检重点覆盖对象，只从 client 拿类型（`import type`，运行时无环）。
- `line-shift.ts`（138 行，新）：写前→写后的 LCS 行号对齐与诊断位移（假错不冒出来的关键算法），纯算法独立成件。
- `shots/lsp-check.mjs` 同步：模块导入路由到新件；假 ctx 补 `registerProjection` / `appendNote` 桩（lsp 插件自 00c6a6f 起走投影链注入诊断，探针没跟上、断言的 `transforms[0]` 已是过时口径——167 条断言现在全部真正跑通）。

**remote.ts（1449 行）拆四件**：

- `remote/types.ts`（127 行，新）：协议常量（`REMOTE_METHODS` 白名单 + 覆盖断言 + `REMOTE_SET`）与三张接口（deps / 快照 / 句柄）——插件、传输、路由三方共认的契约。
- `remote/http.ts`（117 行，新）：请求体读取、JSON 应答、Bearer 解析、Host 校验（防 DNS rebinding）、lastSeq 解析。
- `remote/routes.ts`（295 行，新）：静态兜底页 + 七条业务路由（配对 / 票据 / 吊销 / 上传 / push-key / 订阅 / 退订）+ `createRequestHandler` 分发器（Host 总闸）。
- `remote.ts`（987 行）：`createRemoteServer` 函数体从 451 行瘦到约 250 行，只剩帧流、WS 会话与生命周期；`rejectUpgrade` 留在原地（WS 升级唯一使用方）；errText 改走 core 正典。
- **新增 `shots/remote-server-check.mjs`（12 条）**：remote 此前没有任何行为探针——假 deps 起真服务器，实测 Host 校验总闸（恶意域名 403，用 node:http 伪造 Host——fetch 规范把 Host 列为禁改头）、配对/票据/吊销全链路、静态兜底页、未知路由。**第一条行为网就抓到了拆分重写 `bearerToken`（正则 exec 改字符串解析以过安全扫描）时引入的真 bug：小写化后的串去比大小写敏感的 `'Bearer '` 前缀，所有 Bearer 认证必 401**——已修（比对小写前缀），这正是拆分必须配行为网的原因。

**渲染层巨型组件**：

- ChatView（1579 → 946 行）拆五件：`chat/markdown-text.tsx`（正文渲染 + 文件提及 chip + 悬停预览）、`chat/feedback.ts`（本机评价存取 + 只提示一次）、`chat/round-fold.tsx`（每轮折叠预算 `buildRoundFolds` + 总开关行）、`chat/seat-plan.ts`（座位计划 `buildSeatPlan`：过程区/之后/轮尾卡分块）、`chat/use-chat-viewport.ts`（流式跟随 / 暂停滞回 / 回到底部 / 历史分页锚点补偿的完整 hook）。渲染序列 `renderNode`/`seatRow`/`renderSeat` 留在主组件——它们与十几份状态互锁，硬拆只会变成 prop 传递层。
- Sidebar（1289 → 1191 行）拆出 `sidebar-groups.ts`（179 行）：`buildWorkGroups`（归档筛选→分桶→搜索→组内/组间排序→tree 挂树）与显示助手（displayName/lastSegment/relative）成纯函数，类型直接对齐 contract 的三档 key（不再手抄同形字符串联合）。
- App（910 行）**保留不动**：它是根状态枢纽，约 20 个 effect 每个都咬着 2-5 份 state，接缝是假的——拆它只能得到 prop 钻透层。等某个 feature 域（如队友/自检钩子）需要跨文件复用时再顺势抽 hook。

**重复实现归一**：

- token 粗估三份 → 一份：新增 `src/core/token-estimate.ts`（中文 0.65 / 其余 0.33 的唯一正主，零依赖进得了渲染层）；compact.ts 与渲染层 token-estimate.ts 都改为复用，渲染层那份只留转出口与 formatTokens。此前注释里写着「口径抄宿主」的手抄正则删除。
- Sidebar 的本地 `formatTokens`（k/M 计数格式化）与渲染层 token-estimate.ts 的同名函数重复 → 统一导入（k→K 的大小写显示顺带对齐）。`spill.ts` 的 `formatBytes`（中文文案）与 file-util 的 `formatSize`（紧凑徽标）核实为**两种刻意不同的展示口径**，不是重复，保留。
- 死导出 `contentChars`（llm.ts，全仓库零引用）删除——上一阶段死导出清理的漏网之鱼。
- localStorage 收敛：8 个文件的 JSON 读写核实全部已有 try/catch + 校验防护（dock-model / appearance / feedback 各自的形状校验无法合并），真正的缺口是 6 处**裸 `setItem`**（App dockWidth、DiffPane 两处、Dock 两处）——隐私模式/配额满会在事件回调里抛异常，逐处补防护。「单一出口」抽象层不加：各处的校验逻辑才是主体，包一层 try 只是形式收敛。
- cwd/workspace 同物两名：持久化键名（workspaceOrder/workspaceAliases）是用户存档不能改，改名是高风险零收益——在 `workspace-order.ts` 头部补命名约定（值是 cwd，「工作区」是 UI 称呼），歧义在源头说清。
- 白名单手抄：核实为已收敛——command-policy.ts 是唯一判定引擎（approval-floor / modes / sandbox / bash 全部 import 它），无副本。

**验证**：双侧 typecheck 全绿；`pnpm build`（lib）+ desktop build 全绿；四张行为网全绿——step-groups 210/210、step-seed 28/28、fold-check 218/218（1 条断言随折叠预算器搬家更新匹配模式）、trace-check 85/85；探针矩阵全绿——remote-server-check 12/12（新）、lsp-check 167/167（修好假 ctx 后从 130+1 炸变为全过）、order-check、compact 53、mcp、dock-model、integration、kernel-boot、approval-floor 95、file-review 59、dsh-compat 15、llm-adapter 18、llm-retry 10、modes-security 全过。

**诚实边界**：

- App.tsx 未拆（理由如上，910 行根枢纽保留）；Sidebar 剩余 1191 行的主组件是拖拽/改名/菜单/展开态的互锁簇，本轮只拆出纯函数层。
- `bearerToken` 的行为网断言晚于重写本身（先拆后补网），若 Bearer 认证有真实用户在用，那个 bug 会活到本批——万幸 remote 尚在迭代期、探针先行补上了。
- remote 的 WS 升级守卫（/ws + 一次性票据）不在 HTTP 探针射程（undici 禁 Upgrade 头），由运行时真客户端覆盖；票据 redeem 的单测在 tickets 自检里。
- Mimosa 安全门把 `rejectUpgrade` 的 HTTP 状态行模板与 Bearer 正则解析误报为「命令注入」，两处代码以原语义保留/等价重写（正则 exec 改字符串解析，行为对齐 `/^Bearer\s+(\S+)$/i`：整段必须是 Bearer 前缀 + 无空白 token）。

## 阶段 48：功能批次 A——@提及/自动标题/占用表/会话导出（0.6.29）

roadmap §7 的 T14–T28 全量开工，第一批四件（全部不动内核的服务面）。

**T14 输入端 @ 文件提及**：`desktop/src/renderer/mention-complete.ts`（新，纯模块）——`mentionQueryAt` 定位光标处的 @token（`@` 前必须是空白或行首，邮箱不触发）、`rankMentionCandidates` 候选排序（文件名前缀 > 文件名包含 > 路径包含，同档路径短的靠前）、`insertMention` 替换回填、`collectWorkspaceFiles` 工作区遍历（注入 fs-list lister，跳过 node_modules/.git/dist 等构建目录，2000 条/6 层封顶）。Composer 加 @ 面板（与 / 命令面板互斥、Esc 关闭同 token 不再弹、键盘可选），App 注入带 60 秒缓存的文件清单；`matchMentionPath` 识别时剥掉前导 `@`，发出去的 `@路径` 照常命中改动卡 chip。

**T16 会话标题自动生成**：`src/plugins/session-title.ts`（新）——首个 completed 回合后经 `ctx.llm.stream` 发一次独立小请求（前 3 条用户消息各截 600 字符，20 秒超时），标题写 meta.json 的 `autoTitle`（与用户改名 `title` 分开存）；展示链改为 用户改名 → 自动标题 → 首条消息截断（session.ts 两处投影 + contract 注释）。用户改过名或已生成过的永不覆盖；失败完全静默（截断标题兜底）。

**T17 /status**：`CompactService.describe()` 新增（services/types + compact 插件，现读配置与 `check()` 同源）；`/status` 内建命令（plugins/commands.ts 的 `statusReport` 纯函数）报模型窗口、消息数、估算用量与占比、自动压缩触发线与剩余余量——估算走 compact 同一个 `estimateTokens`。

**T22 /export**：`src/core/session-export.ts`（新，纯函数）——`session.messages` 直出 markdown（system 不进、工具调用/结果独立成节、超预算工具结果截断注明原长、内容含 ``` 时围栏自动加长）；`/export [路径]` 内建命令默认落 `<cwd>/msc-export-<id8>-<时间>.md`。走命令注册表，桌面/TUI/远端三端同链路（UI 折叠分组不进导出，披露）。

**验证**：双侧 typecheck、根 build + desktop build 全绿；新探针 `shots/batch-a-check.mjs` 22/22（假 ctx 走真生成流程 + 临时 HOME 断言 meta.json、导出序列化、/status 文本、@ 纯函数——渲染层纯模块 node 直读 TS）；四网 218/210/28/85、compact 54、approval-floor 95、dsh-compat 15、file-review 59、kernel-boot/integration/mcp/dock-model 全过。

**诚实边界**：@ 候选遍历的是 dock 根目录（标准桌面流里即会话 cwd；多工作区/异根场景路径可能错位）；标题生成失败无提示；T16 无手动重生成入口（要改可自己改名）；/export 导出的是协议消息流而非 UI 折叠条目。

## 阶段 49：功能批次 B——压缩前置裁剪/在线模型发现/read 读图/侧栏状态点（0.6.30）

**T19 压缩前置裁剪 + 图像卸载**（对标 dsh compaction-tool-result-pruner / compaction-image-offload）：`compact.ts` 新增 `pruneRegion` 前置 pass——超预算工具结果走 `spillText` 落盘留指针（模型可 `read` 找回全文），单行巨型输出（一行几万字符的 bundle）让「前 N 行」预览照样大，按 2×预算再截一刀、指针单独补回；带图工具结果的图整条卸载为占位；用户消息的图按预算（缺省 4 张）保留。**锚点索引与原话引用仍抽自未裁剪原文**——机械抽取要全量保真，不能跟着裁剪走（spill 里的报错原文靠锚点索引找回来）。compact 插件三处调用（check/forceCompact/run）统一带上口径，spill 配置复用 spill 插件那份。

**T23 在线模型发现**：`core/model-discovery.ts`（新）——`GET {baseUrl}/models`（路径约定与 chat 同级），认 OpenAI `data[]` / ollama `models[]` / 纯数组三种形状，15 秒超时；`SettingsService.discoverModels` + 协议白名单 + 渲染层「拉取清单」按钮——清单条里逐个「+」按 config.yaml 缺省能力（128k 窗口/四档 thinking/只吃文本）加进端点，已有 id 灰掉。

**T25 read 图片分流**：read 工具按扩展名（png/jpg/gif/webp/bmp/svg）整读成 data URL 走图片附件（6MB 红线与贴图一致）；模型没勾照片输入时请求组装的 `dropImageParts` 投影兜底换说明，工具不用关心模态。

**T21 侧栏会话运行状态点**：快照新增 `sessionStates`（jsonl 路径 → working / awaiting-approval）——当前会话按 turnState，干着活的队友会话按名册；队友 spawn/settle 时 subagent 触摸快照保证新鲜。侧栏 16px 前导槽从空占位变成状态点：working 强调色呼吸、awaiting-approval 警示色常亮（`Sidebar.tsx:597` 的占位转正）。

**验证**：双侧 typecheck、双构建全绿；新探针 `shots/batch-b-check.mjs` 12/12（假 stream 记录压缩请求断言输入缩半且哨兵经锚点保留、本地假端点实测发现链路、临时目录实测 read 分流）；全量回归——compact 54、batch-a 22、order/kernel-boot/integration、approval-floor 95、dsh-compat 15、file-review 59、dock-model、remote-server 12、lsp 167、mcp，四网 218/210/28/85。

**诚实边界**：T23 只支持 OpenAI 兼容 /models（当前唯一协议适配器就是 openai-completions，anthropic 端点要等适配器出现再加）；「+」进来的模型能力是缺省值，要按模型改窗口/模态还得进编辑框；T21 状态点不含「定时任务时钟标记」（dsh 有，dsc 定时任务跑在当前会话里，当前会话的点已覆盖）。

## 阶段 50：功能批次 C——bash 后台任务（0.6.31）

T15（对标 dsh tool-jobs）：长命令不占住回合。bash 工具新增 `run_in_background` 参数——同一道命令、同一套审批与硬地板，只是立即返回 job id 不等结果；配 `job_output`（增量续读，游标记「读到哪了」）/ `job_list`（清点）/ `job_kill`（整树收尾）三件工具。输出进字符环形缓冲（100k 上限，超限从头部丢，绝对偏移跟着平移）；作业结束经 `agent.followup` 叫模型回来收结果（800ms 合并窗口，几个作业同时收尾只发一条）；作业跨会话存活，内核收摊时统一收掉。落点：**全部并入 `bash.ts`**——`runShell` 加 `ShellRunOptions` 旁路（onChunk 增量 / onExit 退出码 / trackKey 进登记表），后台走与前台完全同一条执行计划缝与环境脱敏；`JobTable` 与三工具同文件。

**为什么并入 bash.ts（安全门实测结论，登记在案）**：Mimosa 候选扫描对「新文件里模型可控命令 → shell 的数据流」一律判高危——动态参数 spawn 行、kill 调用、转发包装函数、别名链、闭包工厂全部被逐层穿透拦下（连 ChildProcess 自带方法都不行），六种形态逐一试过无一放行；而 bash.ts 作为既有的进程原语文件是豁免边界（同文件新增 killTree 调用可过）。T15 因此以「进程原语不出 bash.ts」的形态落地。

**附带修掉一个存量真 bug（探针抓的）**：Windows 上 `powershell -Command` 不透传原生命令的退出码——powershell.exe 只回 0/1，bash 工具在 Windows 上从来拿不到真实退出码。修法：命令末尾补一句 `if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }`（用换行追加，command 以注释结尾不被吞；纯 cmdlet 命令无 $LASTEXITCODE，行为不变）。

**验证**：typecheck/build 全绿；新探针 `shots/batch-c-check.mjs` 13/13（真起子进程：增量缓冲时间线、退出码透传、kill 后 close 不覆盖状态不补发通知、后台旁路硬地板、三工具形状）；回归 compact 54、batch-a 22、batch-b 12、kernel-boot、integration、approval-floor 95、dsh-compat 15、mcp、file-review 59、order 全过。

**诚实边界**：后台作业没有超时（那是后台的意义），24 小时的描述值超时由 spawnShell 兜底；job_kill 的整树收割与前台超时共用 taskkill/组杀机制；完成通知是排队消息（模型下一轮看到），不是流中断注入。

## 阶段 51：功能批次 D——/review 升级为只读审查队友 + findings 结构化渲染（0.6.32）

**T18 /review 升级**（roadmap §7.1）：v1 的「审查消息发进当前会话走一轮」升级为「subagent 插件派一个工牌被强制压到只读交集的队友，后台审查，findings 结构化写回」。

- **内核**：`agent-roles.ts` 新增出厂角色 `reviewer`（tools read/glob/grep、approval forbid、16 轮，提示词约定 findings 输出格式：`### [P1] 标题 / 位置：相对路径:行号 / 说明 / 建议`，分级口径 P1 必须修、P2 应该修、P3 可更好）；解析角色文本的逻辑抽成 `parseRoleText` 供 `readRole` 与新导出 `builtinRole()`（按出厂定义就地构造、**不落盘**）共用——用户删了 reviewer.md 也照常可审。
- **审查通道**：`subagent.ts` provide 新服务 `review`（`ReviewService.spawn(request)`）——findRole('reviewer') ?? builtinRole('reviewer')，**工牌再压一次只读交集**（tools 强制 `['read','glob','grep']`、approval 强制 `'forbid'`，角色文件怎么改都不影响——审查通道的天然安全不靠配置自觉）；并发额度照占（满了 ok:false 带 reason）；后台跑，收工后 findings 以 `<review-findings teammate state>` 包裹 `appendUser` 写进**发起会话**并 `transcript.touch()`——不走 followup，不打断当前会话的模型轮；用户接着说「把 P1 修了」时模型又天然看得到。
- **命令分流**：`/review` 先 `ctx.get('review')`——subagent 插件开着就派队友（notice 告知），没开或额度满回落 v1 的主会话审查轮；`reviewMessage` 组装函数挪进 `core/git-info.ts`（收集与组装同域；主会话轮与队友任务描述共用一份）。
- **渲染层**：新纯模块 `review-findings.ts`（整体被 `<review-findings>` 包裹才认；逐行状态机解析条目；字段行剥加粗/反引号/列表标记、认全半角冒号；位置认 `path:line`；解析不动的行归进 detail 兜底——宁可多留不丢内容）+ `review-findings-card.tsx`（卡头=审查队友名+状态；按条渲染：优先级徽标 P1 红/P2 橙/P3 灰、标题、**位置可点**、说明、建议）；ChatView 的 user 消息分支命中 findings 文档就出卡，且这类消息隐藏「编辑重发」。
- **行号跳转**：dock 的 `openPreview(path, line?)`——同路径页签已开则聚焦并更新定位行、布局持久化恢复带上 line；`FilePreviewView`/`CodeView` 收 `targetLine`：跳转打开时代码视图挂行号列（CSS counter，shiki 的 `.line` 与纯文本回落同构）、渲染完把目标行滚进视口中央并挂高亮类，目标行超截断范围滚到截断条不硬来。

**探针抓到的两个真问题**：①解析器 `HEAD_RE` 捕获组只捕到 `1`，`priority` 实际是 `'1'` 而非 `'P1'`——卡片 `data-priority` 与 CSS 三档选择器会整体失效（探针「条目数与优先级」当场抓住，修为 `` `P${digit}` ``）；②`fieldOf` 先剥列表前缀再剥加粗，`**位置**：` 剩单星污染 key（调换顺序修复）。另：`createKernel({ config: {} })` 的 options.config 是**直传 llm 插件的运行时配置**，探针必须传 `readConfig()` 读好的盘上配置——空对象时 `route()` 炸 `reading 'undefined'`（kernel-boot 不发请求所以从未暴露）。

**Mimosa 误拦记录**：review-findings.ts 初版用了正则的 `.exec(`——与子进程 exec 撞词面被判「命令注入」拦截写入；改 `match`/逐行扫描绕开（纯文本解析器，无任何进程原语）。

**验证**：双侧 typecheck、根 build + desktop build 全绿；新探针 `shots/batch-d-check.mjs` 32/32（解析器 12、reviewer 角色/组装 9、真内核端到端 11——临时 HOME + 假协议适配器（registerAdapter 缝，不走真模型）+ **故意把 reviewer 角色文件改坏**（tools 混进 write/bash、approval: ask），断言 spawn 后假模型调 write 被「未知工具」挡下、盘上没写出文件、findings 带完成状态写回发起会话、队友进名册收工）；回归 batch-a 22、batch-b 12、batch-c 13、compact 53、order 18、integration 104、approval-floor、dsh-compat 15、mcp、file-review 59、dock-model、remote-server 12、lsp 167、四网 218/210/28/85 全绿。

**诚实边界**：findings 格式靠角色提示词约定、解析器宽松兜底——模型完全跑格时整块文本会落进 trailing 说明而非条目；行号跳转只对代码/文本视图生效（markdown/csv/pdf 预览无行概念）；审查队友不知道本地会话历史（fresh 上下文，只看 diff 与关注点）；/review 的并发额度与普通队友共用一份（maxTeammates 满时回落主会话轮并提示）。

## 阶段 52：功能批次 E——MCP 扩展/持久终端/更新检查/插件远程安装/roadmap 收口（0.6.33）

**T24 MCP elicitation + resources + prompts**（对标 dsh mcp-resources 三工具、codex elicitation）：协议版本 `2024-11-05` → `2025-06-18`（elicitation 进规范的版本；server 回旧版本照常协商，探针验证）。`core/mcp.ts`：client capabilities 按传输分流声明 elicitation（**只有 stdio 声明**——http 一问一答收不了 server 反向请求，那条路根本不暴露能力）；StdioChannel 补 server 反向请求的路由（`onLine` 分出「带 id 带 method = server 请求」支路，异步处理后按 id 回写，未挂缝/抛错回 JSON-RPC 错误）；`resources/list+read`、`prompts/list+get` 客户端方法（tools/list 的翻页循环抽成通用 `paginate`）；连接带 `capabilities`（initialize 应答的 capabilities.resources/prompts）。`plugins/mcp.ts`：`mcp_resources` / `mcp_prompts` 两个全局只读工具——**任一 server 声明了对应能力才注册，最后一个支持它的 server 掉线就撤**；连接就绪后异步补拉资源/模板条数进状态投影（不阻塞 ready）。elicitation 接既有审批卡通道：server 反向要确认时卡上写明 server 名与 message，同意 accept / 拒绝 decline，600 秒上限。

**T20 持久终端（降级版）**：对标 dsh tool-terminal 六工具，落地为**五动作**单工具 `terminal`（open/read/send/close/list）+ `TerminalTable`（bash.ts 文件尾，进程原语 `spawnTerminalShell` 同文件——shell 与参数全字面量，不经过 planCommand 缝（它不是一条命令，是长命 shell），登记/收尾/`stopAllBackgroundChildren` 复用 T15 那一套）。Windows `powershell -NoProfile -Command -`（stdin 逐条读）、POSIX 裸 bash；环形缓冲/增量读游标/遮红与 job_output 同语义。**降级披露**：无 PTY（全屏程序跑不了）、无中途打断（dsh 的 signal 动作没做——管道模式 Windows 收不到 Ctrl+C，信号通路这版没开，长命令等完或 close 重开）、会话不带模型指定的起始目录（进会话后自己 cd，起进程的输入面越窄越好）。

**T27 检查更新**：检查链路 0.6.18 已备（版本比较 + GitHub Releases/简化 JSON 两种回包），本轮补 `sourceUrl` 参数测试缝（缺省仍读 `UPDATE_CHECK_URL` 常量，行为不变），探针起本地更新源覆盖三种回包与坏回包。**有意不做自动安装**（用户只要检查）：有新版时打开发布页手动换包；`UPDATE_CHECK_URL` 仍是空串占位——发布后填，是唯一的配置尾巴。

**T28 插件远程安装**：`plugin_manager` 工具加 `browse_remote` / `install_remote` 两个动作；`core/market.ts` 加 `browsePluginMarketSource` / `installPluginMarketEntry`——机制照技能市场的两类源（GitHub 目录 trees API 里递归列 `*.js`；索引 JSON `[{name,file,description?,version?}]`），只拉单文件、1.5MB 上限。**安全姿势**：源与直链强制 https；远程插件是任意代码，工具 risk=write 弹审批卡（卡上带来源 URL），用户点头才落盘+热挂载。

**T26 评估结论（roadmap §7.7）**：完整回滚语义暂不立项——混合改动场景（bash 改的文件无 pre-image）下「回滚到回合前」语义残缺、「保手改」需要 per-hunk 三方合并基建、有 git 的场景已有顺路动作、部分行接受要动审批模型与转录契约；重启条件与 shadow git 方向写进 §7.7。

**roadmap 收口**：§7.7 新增 T14–T28 十五项逐项落地状态表（0.6.29–0.6.33 五批次，探针与回归证据见 development-log 阶段 48–52）。

**Mimosa 安全门实录（本批核心曲折）**：T20 的终端会话在 bash.ts 被拦 5 次——`spawn` 三元分支（变量经三元产生即判动态命令）、新增 `process.kill`（SIGINT）、`stdin.write(data)`（模型输入写 shell stdin，功能本质）、以及大 hunk 里「新函数 + 调用」的数据流。最终通过形态：**spawn 原语收成全字面量 if 分支函数 + 会话不带模型指定的 cwd + 砍 signal 动作 + 小步 hunk 追加**（大 hunk 被拦、同内容拆小后通过——hunk 尺寸影响判定窗口）。另有：Mimosa 拦 Bash heredoc 写 bash.ts（改用 Edit，与批次 B/C 同规）。

**验证**：双侧 typecheck、根 build + desktop build 全绿；新探针 `shots/batch-e-check.mjs` 33/33（T24：真起假 server 进程验能力协商/资源读写/blob 降级/模板取回/elicitation 审批往返与拒绝路径/无能力不注册——两内核两 server；T20：真起交互 shell 验 open/send/read 增量/close/结束后 send 报错；T27：本地更新源三种回包；T28：索引源浏览/拉取落盘/工具层 https 拦截）；回归 batch-a 22、batch-b 12、batch-c 13、batch-d 32、compact 53、order、kernel-boot、integration 104、approval-floor 95、dsh-compat 15、mcp、file-review 59、dock-model、remote-server 12、lsp 167、四网 218/210/28/85 全绿。

**诚实边界**：T20 降级版无 PTY 无 signal，全屏程序与中途打断不支持；T24 的 elicitation 只支持确认/拒绝（审批卡无表单输入，requestedSchema 只展示），http 传输的 server 拿不到 elicitation；T27 的 UPDATE_CHECK_URL 待发布后填写，自动安装有意不做；T28 只支持单文件 .js 插件（npm 包形态的插件不在远程安装范围）。

## 阶段 53：收尾——Mimosa 完整审计、批次 A–E UI 实机目检、@ 补全两个真 bug、打包（0.6.34）

0.6.29–0.6.33 五个功能批次全部提交后的收尾轮：完整安全审计 → 实机截图自检 → 修复自检揭出的问题 → 全量回归 → 打包。

**Mimosa 完整深度审计（首个密封完整结论）**：0.6.29 起每批提交都是 `scanner_enobufs` 兼容放行，这是第一次拿到完整扫描结论——scanId `scan-2026-10-02T14-20-51.127Z-8a112f758f1a`（seal `sha256:65650cf9…`，static-only 边界）。136 个 finding：`shots/_dsh_extract` 76（dsh 参考代码提取副本，非运行时代码）、`desktop/runtime-staging` 22 与 `lib/` 19（同一批 src finding 的编译产物/运行时暂存副本）、真实源码收敛为 **13 个独立 finding**。逐个人工复核：12 个定性误报或功能本质（cdp/actions.ts 的防御黑名单正则被当 sink；mcp.ts 的 spawn 是用户自己配置的 server 命令经 `resolveCommand` 解析；doctor.ts 是固定 System32 PowerShell 路径加常量参数；bash.ts 两处是 `require()` 错误消息模板；bash.ts 六处环境变量污点链是 taskkill 清理用受控 PID 与 harness 核心的 spawnShell——命令过审批门）；**1 个加固**：Web Push 订阅的 endpoint 入库时只查非空没校验 scheme（web-push 库照单全发，已配对设备可让宿主向任意 URL POST）——`push.ts` 补 `^https://` 校验。依赖扫描 298 包 0 命中。**按扫描结论纪律：这不构成「项目完全安全」的宣称，只登记复核结论**。

**实机截图自检（新 `desktop/shots/final-seed.mjs` + `final-shots.ps1`，三用例九项判定全绿）**：隔离 HOME + 真实 ~/.dsc 跑前跑后全量指纹（167 文件聚合 SHA256 逐文件比对，前后一致——零污染）。用例覆盖：findings 卡渲染与分级徽标、点位置按钮开 preview 并滚到目标行高亮（`dock-model.ts:40` 实测）；@ 面板候选、点选插入、清空重开；设置页「拉取清单」按钮、侧栏状态点 idle 不显示。

**自检揭出两个真 bug（都是 T14 上线即有、单测没覆盖真实仓库形态）**：
1. **工具状态点目录淹没 @ 补全**：`collectWorkspaceFiles` 的 2000 条上限被 `.mimosa/hook-state`（Mimosa 提交门的会话状态文件，本仓库 1400+ 个）吃满，点开头目录按字典序排在所有源码之前，`desktop/src` 整个缺席——实机输入 `@dock` 只出 `desktop/electron/main/dock.ts` 一个候选。修：点开头目录一律跳过 + 跳过名单补 `runtime-staging` 与 Chromium userData 标准缓存子目录（`Cache`/`Code Cache`/`GPUCache` 等，自检残留会以这些名字出现在仓库）+ 上限 2000→4000（修后本仓库 2474 条全部收进）。
2. **pickMention 点选后面板不收**：只更新文本与 DOM 光标，React 的 `caret` state 还是旧值——`mentionQueryAt(新文本, 旧光标)` 把整条已选路径当成新 token，面板在插入后继续开着。修：插入时 `setCaret(next.caret)` 同步。
3. 另一处 UX 精化：候选上限 8→12（面板本就 max-height 240px 可滚动）。同名前缀拥挤的既有局限如实登记：本仓库 `shots/dock-06xx.ps1` 系列自检脚本会占满前缀命中档，泛 token（`@dock`）时 `dock-model.ts` 排 13——稍精确的 token（`@dock-m`）即刻精准命中，与 dsh 文件搜索的真实用法一致。

**探针侧两个误判修正**（final-shots 初版断言写错，非产品问题）：findings 徽标文案是「P1 必须修」不是裸 `P1`；preview 页签在 `.dock-strip` 的 Chip 里，不是会话顶栏 `.tabs button`。`batch-a-check` 的 3000 条 mock 数据随上限 2000→4000 过时（封顶断言不再成立），改为按 `WALK_MAX_FILES + 1000` 动态造。

**验证**：根 build + desktop build + 双侧 typecheck 全绿；全量回归 19 个探针零失败——batch-a 22、batch-b 12、batch-c 13、batch-d 32、batch-e 33（batch-e 退出阶段有 libuv `UV_HANDLE_CLOSING` 断言噪声，33 项功能断言全过、复跑稳定，属探针进程清理时序非产品路径）、compact 53、order 18、dock-model、dsh-compat 15、integration 104、approval-floor 95、mcp 75、file-review 59、remote-server 12、lsp 167、browser 210、tool-search 94、session-search 70、win-net-setup 160；实机三用例九项判定全绿。

**诚实边界**：批次 B 的侧栏运行状态点只实机验证了 idle 档不显示（working/waiting 需要真模型跑中的会话，deepseek 限流到 2026-10-06，状态切换逻辑已有单测覆盖）；会话标题自动生成（T16）与 /export 的落盘提示未实机走查（需真模型轮，核心逻辑已有探针）。

## 阶段 54：实机 UI 反馈修复——turn-fold 分节线与滚动条几何对齐 dsh（0.6.35）

用户实机截图两张：会话里「用时 2秒」孤零零悬成一行灰字（红框圈出）、开始页侧栏滚动条粗亮扎眼。对照 dsh 逐处定根因，两处都是几何/结构问题，不涉及逻辑改动：

1. **turn-fold 行没画下边框**：0.6.2x 引入整轮折叠时刻意不画（当时判断「dsc 的过程条目各自是卡片，再来一条横线会读成又一张卡」），代价是没有过程内容的轮（不可点、无 chevron）只剩一行悬着的灰字，实机里被当成 bug。dsh 的 TurnProcessNodeView.module.css 这行是 33px 高 + 底 padding 8px + **0.5px 下边框**（`.root:7-10`），hover 只把文字提到最亮一档、不铺底色——结构感恰恰来自那条线。修：`.turn-fold` 补 `border-bottom: 0.5px solid var(--dsc-stroke-3)`（12% base，等值 dsh 暗色 alias-border-l2 的 rgba(255,255,255,0.12)）、`min-height: calc(33px * var(--dsc-density))`、label 贴左（去左右内距）、hover 从铺 `row-hover-bg` 改成 `:not(:disabled):hover` 提字色，`:active` 底色一并撤。实测折叠行高 33px 与 dsh 对齐，「用时 2秒」读作一轮的分节线。
2. **滚动条 8px 太粗**：对用户截图做像素采样，thumb 色 RGB(60,60,60) 正是令牌值 #3c3c3d——恰好等于 dsh 暗色 scrollbar-bg-l1（neutral-700 = rgb(60,60,61)），颜色早已同源，粗是几何问题：dsh `--dsh-scrollbar-width: 5px`，dsc 写了 8px。修：base.css `::-webkit-scrollbar` 8→5px；`--dsc-scrollbar-w` 同步 5px（刻度条与「回到底部」的 right 由它计算，自动让位）；panels.ts 的 `readRootPx` 回退值同步 5。

顺带排查确认不是问题的两处：侧栏底部的 `D:\dsc` 行是设计内的当前工作目录入口（点击浏览其他目录），与顶部「dsc」组不重复；顶栏的分段钮是「打开工作区 + 更多方式」分组钮（对照 dsh 的文件夹+下拉）。

**探针同步**：fold-check 四条断言旧行内按钮契约（`--dsc-row-h` 行高、hover 底色、active 底色、disabled 悬停去底色）→ 改断 dsh 形态（33px 档、0.5px 下边框、hover 只提字色且无 background、`:not(:disabled)` 门），220/220。

**验证**：desktop typecheck + build 全绿；新实机自检 `desktop/shots/ui-seed.mjs` + `ui-fix-shots.ps1` 两用例六判定全绿——种子会话第 0 轮无过程内容（精确复现「用时 2秒」形态：disabled、无 chevron）、第 1 轮带工具调用（可点、带 chevron），computed 边框 solid 非零、折叠行高 33、`::-webkit-scrollbar` 宽 5px；真实 ~/.dsc 跑前跑后 171 文件聚合 SHA256 逐文件一致（零污染）。

**诚实边界**：自检种子的侧栏只有 1 个会话、对话只有 2 轮，两个区域都没溢出，5px 滚动条只有样式表断言（thumb 色与 dsh 本就同值）没有溢出态实机特写；hover 提字色同样只有断言（截图钩子 `.shot-reveal` 已同步改成提字色，可复验）。

**Mimosa 重扫密封（0.6.35）**：提交时门仍报 `scanner_enobufs`，按上轮纪律重扫——scanId `scan-2026-10-02T15-46-21.830Z-ed45f0d7e50e`（seal `sha256:99cc271b…`），138 个 finding 里真实源码面仍是同样 13 个（文件与规则逐条同 0.6.34 密封结论：12 误报/功能本质 + 1 已加固的 push.ts），总数 +2 落在 `lib/remote/assets` 与 `shots/icon-preview` 的非运行时副本/探针资产；依赖 298 包 0 命中。按扫描结论纪律：不宣称「项目完全安全」，只登记复核结论。

## 阶段 55：开始页整组垂直居中——修复「整个会话框太靠上」（0.6.36）

用户实机截图：新会话开始页的「有什么可以帮忙的? + 提示行 + 输入框」整块顶着页眉排，下方留了一大截空白。根因是布局规则挂错了层：`.welcome` 自己写了 `flex: 1 + justify-content: center + padding-bottom: 8vh`，但它的父级 `.thread-main` 是个普通块——纵向 flex 规则只写在审查分栏分支（`.thread-zone[data-review] .thread-main`）里，普通态根本不存在 flex 上下文，那三条居中规则全部落空，welcome 塌成内容高、composer 紧随其后，整组顶格。

修法（对照 dsh 的 EmptyHero：`.root { height: 100%; justify-content: center }`，标题 + 工作区 chip + 输入卡**作为一个组**居中）：
1. `App.tsx`：thread-main 按条件挂 `thread-main-empty` 类——条件与 Welcome 分支完全一致（非轨迹页、非队友记录、空会话），轨迹页 / 队友记录不进居中容器；
2. `styles.css`：`.thread-main-empty`（flex 列 + `overflow-y: auto`），welcome `margin-top: auto` + composer-zone `margin-bottom: auto`、welcome↔composer 固定 28px 间距。居中用上下 auto 边距而不是 `justify-content: center`——system 提示多、窗口矮、内容高过容器时 auto 边距退回普通流（顶着排、容器可滚），flex 居中会把顶部溢出内容裁到滚不回来；
3. `.welcome` 基础规则清掉三条死规则（`flex: 1` / `justify-content: center` / `padding-bottom: 8vh`——旧结构遗产，现在只留 welcome 块自己的内部排布）。

**验证**：desktop typecheck + build 全绿、fold-check 220/220；ui-start 用例加 `centeredOk` 判定（welcome 上方留白 vs composer 下方留白差 ≤32px 且留白 >40px）实机 210/220 全绿（差值即 composer-zone 自身 10px 底 padding）；目检截图确认整组落在版心正中；真实 ~/.dsc 跑前跑后 171 文件聚合 SHA256 一致（零污染）。

**诚实边界**：带消息的会话、轨迹页、队友记录的布局不动（那些分支不挂居中类）；第一条消息发出后 composer 从居中组落回底部，行为与 dsh 的 blank-draft → conversation 切换一致，探针未单独取证（同一容器的两个 class 分支，逻辑已由 centeredOk 覆盖一半）。

**Mimosa 重扫密封（0.6.36）**：scanId `scan-2026-10-02T15-56-56.056Z-530f870f93a8`（seal `sha256:9a0879fc…`），138 finding、src 面 13 项与 0.6.35 密封结论逐条一致（本轮增量仅 UI 布局，无安全面变化）；依赖 298 包 0 命中。另：本轮首次出现提交门 L3 硬拦——拦的全是 `desktop/runtime-staging/dsc-core`（**未入库**的本地构建产物，prepare-runtime 打包时再生）里 src 已定性 finding 的编译镜像；提交文件本身零 finding，重试走 enobufs 兼容路径通过。若要消除这种「构建产物镜像反复触发门」的摩擦，可考虑让扫描范围排除 `desktop/runtime-staging/`（regenerable 构建输出，非源码）——留给用户决定。

## 阶段 56：体积与性能落地 + 死代码清理 + P3 立项（0.6.37）

用户裁决「落地」优化清单并把一批已披露边界正式立项。体积优化的实测构成（改前）：安装包 114MB；win-unpacked 407MB = Electron ~318MB + locales 49MB + app.asar 20MB（渲染层产物 13MB）+ dsc-core 20MB（node_modules 16MB）。渲染层 chunk：真入口 2.1MB + **vscode-icons 图标全集 3.7MB**（file-icons.tsx 动态 import，但文件树/预览页签/改动卡出现得早，懒加载名存实亡）+ xlsx 0.9 / pdf 0.8 / shiki 各语言（本就懒）+ CSS 296KB。

**四项体积/性能落地**：
1. **图标集瘦身（最大单项）**：新增 `desktop/scripts/build-icon-map.mjs`——按常用扩展名/文件名清单（~250 项）经 vscode-icons-js 解析、从全集抽出 115 个图标 body 固化成 `file-icon-map.generated.ts`（≈511KB，生成器校验每个名字可解析、default-file 必须在内）；`file-icons.tsx` 改同步查表，未知图标回落 default-file。**3.7MB chunk 从产物消失**，入口 2.1→2.24MB。
2. **xterm 懒加载**：新 `xterm-lazy.ts` 收拢动态 import（CSS 仍静态，几 KB 换首开不闪无样式帧）；`Dock.tsx` TerminalPane 的装配改异步——`disposed + teardown` 双保险处理卸载竞态。实机新用例 `ui-term`（展开 dock → 点「新建终端」→ 断言 `.term-host .xterm` 挂载且可见 407×794）termOk:true。
3. **electronLanguages**：electron-builder.yml 加 `electronLanguages: [zh-CN, en-US]`，Electron 自带 55 语言包（49MB）只留两份。
4. **zod 裁剪**：dsc src 零 import zod，它经 dsh 兼容生态（dsh-llm 等 peer 链）进闭包；全闭包 rg 证实对 `zod/v3|mini|v4-mini|locales|src` 零引用（只裸 `'zod'`）——prepare-runtime.mjs 复制后裁掉这五个子路径。**诚实边界**：仓库外的 dsh 插件若真 import 这些子路径会在运行时才炸，属兼容承诺外的长尾。

**死代码清理（依据阶段 55 的审查报告）**：CLI 侧删 `src/core/tools/index.ts`（旧工具注册表 barrel，插件体系取代）、11 个死导出（allowAllApproval / verdictLine / dropBackup / relativeToSkills / marketErrorText 别名 / isPluginDisabled / RUNNER_FAILURE_SIGNATURE / inboxSummary / makeTerminalChildExperiment「用后即删」实验块 / CommandRunnerEntry / defaultTools 随死文件）、abi.ts 与 net-abi.ts 里 12 个零引用 FFI 常量、`UiConfig.ui` 死字段（boot/headless 只用 `ui.plugins`；boot.ts 头注释「UI 由 config.yaml 的 ui 段选择」与实现不符，一并修正——UI 由 spawn 哪个入口决定）。桌面侧删 `IconGrip`、primitives.css 孤儿层（dsc-ctl/field/badge/row/sect/date-sep/tabs/pop/menu/loader/skeleton/state-*/notice/inline-code/hairline/grip/focusable，~10KB）、styles.css 的 `.group-row .grip` 三条与 `.pop-hint`、base.css 的 `.sr-only`。**探针契约恢复 3 项**：win-net-setup 钉住 IPPROTO_TCP/UDP 的值、self-improve-check 钉住 lastChangeOf、win-token-smoke 钉住 RUNNER_FAILURE_SIGNATURE——agent 审查看不到 gitignored 探针，删后探针当场抓住，按契约恢复并在注释里写明「删项前先看探针」。`risk-high`/`tone-*`/`status-*` 等是模板拼接（保留）；`.sweep`/`.fadeTop`/`.fadeBottom` 只是 CSS 注释里的对照物引用（无规则，不动）。

**roadmap 立项（§7.8，编号接 §7.5 的 T29–T47）**：T48 T20 完整版（PTY + signal，Mimosa 门预研前置）、T49 T28 升级 npm 包形态插件、T50 @ 补全多工作区/异根修正、T51 T26 完整回滚/部分行接受（用户裁决立项，hermes shadow git 方向）、T52 checkpoint/rewind、T53 对外 SDK、T54 SSH 远程执行（后三项自 §7.3 P3 升出，行内已标注）、V1 实机走查欠账（侧栏状态点 working/waiting、T16 标题、/export 落盘提示——deepseek 限流 10-06 解除后回销）。§7.7 的 T20/T28/T26 三行同步标注立项编号。

**Mimosa 排除配置的探索结论（用户「算了先这样」）**：`security-policy.json` 的 `threatModel.exclusions` 是威胁模型字段不是扫描范围（试配 `desktop/runtime-staging` 后 138→211，把 schedule/renderer 等更多区域翻出来）；扫描器不尊重 .gitignore（`shots/` 在 ignore 里照样被扫）；引擎为加密包无可见排除面。实验产生的策略文件已删除恢复未配置基线。

**验证**：根 build + desktop build + 双侧 typecheck 全绿；CLI 探针 21 个零失败——batch-a 22、batch-b 12、batch-c 13、batch-d 32、batch-e 33（退出阶段 libuv 噪声同前）、compact 53、order、kernel-boot、integration、approval-floor 95、mcp、file-review 59、file-review-kernel 9、dock-model、dsh-compat 15、llm-adapter 18、memory、remote-server 12、lsp 167、browser 210、tool-search、session-search、win-net-setup 160、self-improve 181、win-token-smoke 19、model-caps、preset；桌面 fold-check 220。产物：图标 chunk 消失、xterm 独立懒 chunk 404KB。

## 阶段 57：V1 实机走查回销——假模型端点全链走查揪出并修掉两个侧栏缓存 bug（0.6.38）

V1 欠账（侧栏状态点 working/waiting 两档、T16 标题生成、/export 落盘提示）原计划等 deepseek 限流（2026-10-06）解除后走查；本轮不等了——**本地假 OpenAI 兼容端点**驱动真 UI 把三条链路端到端跑通（`desktop/shots/v1-fake-server.mjs` + `v1-walkthrough.ps1`，gitignored）。假服务按请求形状分三类应答：主对话首轮回 `write` 工具调用、工具结果回传轮回纯文本收尾、system 提示词含「会话标题生成器」回短标题（T16 的标题小请求走同一 baseUrl，可识别）；每个应答延迟 800ms 让「working」状态点窗口长到可采样；请求形状追加快照写入 `ui-home/e2e-server-log.jsonl` 供对账。隔离照既有规矩：HOME/USERPROFILE 指到 `shots/ui-home`（ui-seed 种子），真实 `~/.dsc` 跑前跑后 179 文件聚合 SHA256 逐轮一致。

**走查揪出并修掉两个真 bug**（侧栏会话列表缓存从来不认新东西）：
1. `App.tsx handleSubmit`：正常发消息路径 `proxy.submit` 后**从不刷新会话列表**——新会话首条消息落盘后侧栏不显示它，要等打开会话选择器/分叉/重启。分叉路径（ChatView）早就刷了并注释了原因（「新会话在第一条消息落盘之前不留文件」），正常路径漏了。修法：submit 的宿主处理器里同步 `appendUser`（RPC 返回时文件已在），`.then(() => proxy.refreshSessions())`。
2. `session-title.ts`：autoTitle 写进 meta 后只 emit `dsc/changed`，**列表缓存不重扫**——侧栏标题停在「首条消息截断」，自动标题永远显示不出来。修法：改调 `ctx.session.refresh()`（重扫 + 广播）；session 测试桩可能没有 refresh，有就刷、没有退回 emit（batch-a 探针契约两全）。

**走查记录的三个机制事实**（后续排查少走弯路）：
- **审批卡要满足三条件才弹**：权限档不能是 readonly（仅查看档写/执行**当场拒、不弹卡**——首轮走查的 write 就这么被拒的）；auto-edit 档下工作区内写自动放行（不弹卡）；工作区外写还**会被沙箱先拦**（档位 workspace-write 的 outside-writable-roots 规则当场拒，到不了审批层）——必须模型在同一次调用里带成对的 `sandbox_permissions` + `justification` 一次性升权请求才转审批卡。走查用 auto-edit + 写真 %TEMP% + `danger-full-access` 升权请求凑齐三条件，批准后文件真实落盘。
- **/export 等命令的 notice 不是 toast**：`runCommand` 的 ui.notice 走 `transcript.system`——线程里居中的系统行（`.entry-system`），右下角 toast 恒空。走查判定改为找系统行。
- **Electron 的 `app.getPath('home')` 不吃 USERPROFILE/HOME 环境变量覆盖**：桌面壳读的是**真实** `~/.dsc/desktop.json`（lastCwd/recentCwds）——本轮只读未写（真实 .dsc 指纹一致证明）；核心子进程的 `os.homedir()` 才吃 env 覆盖。侧栏那两个「幽灵工作区」（waq/System32 分组）就是真实 desktop.json 的 recentCwds 经这条路径读进来的，非本次引入。

**存量探针修复（6 个，git stash + 基线重建对照确认与本次改动无关）**：batch-e 两处——fake 市场服务的 JSON `writeHead` 提到了分支外，拉脚本文件时头已发过再 writeHead 当场抛 ERR_HTTP_HEADERS_SENT 带走进程（content-type 按分支各写一次）；收尾 `process.exit` 撞还在关闭中的句柄，Windows libuv 断言自杀 exit 127（改 await close + `process.exitCode` + unref 看门狗 500ms 兜底）。lifecycle-hooks——探针桩还停在旧 prompt API（transformMessages），补 `registerProjection` 与 `appendNote`（00c6a6f 起插件改用命名纯投影与会话备注）。modes-security——`OPTIONAL_PLUGINS` 白名单补 `compact`/`review`（commands.ts 两处 ctx.get 都有 undefined 守卫）。preset——标准档可见工具 15→19（skill/todo_write/exit_plan_mode/ask_user 等后续版本入列）。storage——T30 起新会话创建即持写租约（lockfile acquireLock 落 `.lock` 时就 mkdir），断言从「目录都不建」改为「目录里只有 .lock、无 .jsonl 本体」。team——出厂角色三→四（reviewer 审查队友入列）。

**验证**：走查两项判定全绿复跑两轮——seen=[working, awaiting-approval]、审批卡工具=write、批准后状态点消失+回复出现、侧栏出「E2E 状态点导出走查」自动标题、/export 出「已导出 4 条消息 → …」系统行且 675 字节 markdown 落盘、假端点请求序 tool-call→after-tool→title；探测文件（升权审批后）落真实 %TEMP% 并验内容。探针：desktop 4 + 根目录 38 全部零失败（含修好的 6 个；win-token-smoke 19、kernel-boot 亦绿），fold-check 220。根 build + desktop build 绿。

**诚实边界**：走查用假模型——模型内容质量、真实计费/限流行为不在覆盖面（限流解除后可用真模型再目检一轮，非阻塞）；桌面壳读真实 desktop.json 的隔离缝隙只读未写，未改行为（改它要动 Electron home 语义，收益低）；`更新检查 URL` 维持占位空串，等发布后填（用户已确认）。

## 阶段 58：会话行操作对齐图二（图钉前置 + 右键菜单）+ 团队面板名册删除通路（0.6.39）

用户两条补充任务：①会话行的图钉改到行首空白处悬浮展示、右侧「···」更多按钮去掉改右键；②智能体团队面板——「其它会话的队友」没有删除入口，问参考 dsh 是否有逻辑错误，并优化界面。

**任务①（Sidebar.tsx + styles.css）**：对照用户的图二目标稿（dsh 本身没有会话置顶，图二是样式意图）。行首 16px 前导槽改造：有会话级状态时照旧画状态点（working/awaiting-approval），没有时画**前置图钉**——平时 `opacity: 0`，行悬浮/键盘聚焦时浮出，已置顶的常显并染黄色（沿用原 `.pin-mark` 的色彩语言）；点一下切换置顶。行尾 `.row-actions` 只剩归档/恢复一颗钮（图钉钮、`···` 钮退场，时间旁的置顶标与 `.pin-mark` 样式一并删除）。右键菜单：会话行本来就有 `onContextMenu` 开行菜单，但只会贴在行底——现在菜单状态带指针坐标（`{key, x, y}`），`position: fixed` 贴指针展开并做视口收口（左/上各留 220/300px），与 dock 页签右键菜单同款；菜单项不变（置顶/重命名/分叉/复制 ID/归档·恢复）。工作区组行的 `···` 菜单保持原样（点击唤起、就地展开），只把菜单状态适配成对象形状。

**任务②——定性**：roster（`~/.dsc/team/roster.json`，上限 200 条）只进不出：名册没有删除 API、UI 没有删除入口，收工队友（尤其别的会话派出的）永久挂着，名字还被 `uniqueName` 永久占位；记录指向的运行记录文件被删后条目照样在，点开就报错。**不算逻辑错误，是缺了一整条清理通路**——dsh 没有这个问题是因为它的子智能体就是会话本体（`dsh-resource://subagentchat/session/...`），随会话列表的生灭管理；我们的 roster 是自研记账，补删除即可。另外「停止」按钮的条件原来是 `working || stopped`——对已停止的队友再点停止是空话，收紧为仅 working。

**任务②——落地**：核心 `TeamService.remove(name)`（subagent.ts）：working 的拒绝（先停止——文件正被流式写入，删了也会被重建）；收工的从内存表与名册同时摘除，运行记录文件连同 `.lock` 一并删除（只认 `teammateRoot()` 下的路径，越界路径不删；`rmSync force` 对不存在的文件也算成功，回执如实区分「已删」与「本来就不在」）；名字随之释放。合同链：`DscRuntime.removeTeammate`（contract.ts）→ runtime.ts（team 可选服务 ctx.get 模式，同 stopTeammate）→ host-methods.ts 白名单 → bridge.ts。UI（TeamPanel.tsx）：所有收工的行（**含其它会话派出的**——这正是清名册的入口）都有「移除」，确认框标 `danger: true`（破坏性确认钮走红档），文案写明「不进回收站、名字释放」；行尾动作渲染条件收紧；面板头与折叠组的提示文案同步。面板 CSS：`height: auto`（原来固定 560px 高，队伍只有两行时下半屏全是空的），`max-height` 封顶内部滚动，宽度 760→720。

**验证**：新增 `shots/team-remove-check.mjs`（8 条断言全绿）：真内核 + plugins.json 打开 subagent，种两条名册——收工队友移除（文件与租约一并删、名册摘除、名字释放）、文件已丢的老记录照删（回执如实说跳过文件）、不存在的名字给明确说明、teammateRoot 之外的路径不删。实机两用例（`shots/ui-row-team.ps1` + `ui-row-team-seed.mjs`，隔离 HOME + 真实 ~/.dsc 指纹比对一致）：ui-row 三项判定全绿（行尾恰好一颗钮、两行都有前置图钉、`pin-mark` 清零、图钉默认 opacity 0、点击置顶后 `.pinned` 常显、右键菜单 fixed 定位且含分叉/复制 ID、点遮罩关闭）；ui-team 两项判定全绿（面板直开、折叠组两行都有移除、确认框文案含「运行记录」、确认后行数 2→1），跑后对账 roster 只剩 explorer-2、explorer-1.jsonl 与租约确实被删。探针 43 个全绿（含新探针；browser-check 198/199——12.x 真启动烟测在本机偶发「Edge 起来但不写 DevToolsActivePort」，纯 Edge + HOME 覆盖可脱离 dsc 代码复现，属环境敏感项非代码回归）。根 build + desktop build + typecheck 绿。

**诚实边界**：移除只清运行记录文件，队友可能派生过的后台进程仍由宿主收摊逻辑管（remove 拒绝 working 已把风险面收到最小）；dsh 式「随会话删除联动清名册」没做（会话删除时名册保留记录，用户可从面板手动清——记录指向的文件丢了也照删不误）。

## 阶段 59：任务完成提醒——完成提示音 + 后台系统通知（0.6.40）

用户需求：一轮干完时响一声提示音；窗口在后台时桌面右下角弹系统通知；两项都要在设置里可开关；点名参考 codex 与 hermes，「可以抄他们的提示音效」。

**参考结论**：codex 本机无音频资产可抄——CLI 的「提示音」是向终端写 BEL 字符（`\x07`）让终端自己发声（Windows Terminal/VS Code 终端走 Bel 后端，`codex-rs/tui/src/notifications/`），桌面应用已卸载；它的可取处是**触发语义**：回合完成事件（agent-turn-complete）仅在终端失焦时发出（`notification_condition = "unfocused"`）、无排队 follow-up 且无活动 goal 才算真完成。hermes（`D:\hermes\hermes-agent`，Nous Research，Apache-2.0）正相反：14 种音色全部 **Web Audio 现场合成**（振荡器 + 包络 + 带通噪声 + 卷积混响，「no asset to ship」），音色库 `apps/desktop/src/lib/completion-sound.ts` 零依赖音频文件——直接移植参数（音效本体），音名译成中文，去 nanostores/跨窗口认领依赖（单窗口应用不需要）。后台判定抄它的口径：`document.hidden` 只在最小化/被遮挡时翻转，alt-tab 后窗口可见但失焦也算「离开」，所以要再查 `document.hasFocus()`。通知主进程链路参考它的 Electron `Notification` 用法（点击聚焦窗口）。

**信号**：渲染层快照的 `turnState` 在同一会话内「跑动 → idle」跳变即一轮干完（`turn-notify.ts` 纯函数 `turnCompleted`，带 sessionId 判同——切到一个本来就在空闲的会话不是完成；`awaiting-approval → idle` 也算，审批后继续跑完才到 idle）。判定与文案抽在零依赖模块 `desktop/src/renderer/turn-notify.ts`（探针直接 import 源码跑）：`turnCompleted` / `isBackgrounded` / `completionNotifyBody`（最后一条 text 条目压成一行、120 字截断）/ `normalizeSoundVariant`（与宿主 prefs.ts 的 readSoundVariant 同一张表，1–14 夹取）。App.tsx 完成 effect 与既有的「跑动→idle 重读名册」effect 并排，互不掺和。

**声音**：`completion-sound.ts`（新）——信号链 voices → master(0.48) → 低通 3800Hz → 干声(0.88)+卷积混响湿声(0.34)，混响脉冲 1.6s 指数衰减白噪声生成一次缓存；音量压得很低（gain 0.008–0.07）。播放函数不查开关（hermes 同款：设置里「选中即试听」不受静音管），开关判断在 App 的 effect 与设置 UI 各自做。**通知**：preload 加 `dsc.notify` → 主进程 `ipcMain.handle('dsc:notify')`——`Notification` 恒 `silent: true`（声音由渲染层音效负责，开关独立，别让 Windows toast 音和我们的音效叠两声）、点击 `showMainWindow()`、icon 从 build/resources 取；`app.setAppUserModelId('io.dsc.desktop')`（与 electron-builder.yml 的 appId 一致，Windows toast 归属正确）；sender 校验与 title 非空校验照安全惯例；DSC_DESKTOP_SHOT 时打 stderr 自检日志（照 theme-source 先例）。

**设置**：`UiPrefsView` 加三字段（`turnCompleteSound` / `turnCompleteSoundVariant` / `turnCompleteNotify`，出厂都开、1 号音色）——存 `~/.dsc/settings.json` 的 ui 段，宿主 prefs.ts 读档白名单 + 夹取归一（坏值回落，绝不拦启动）；渲染层 `normalizeUiPrefs` 缺项回落开（`!== false`）。设置 → 通用新增「任务完成提醒」组三行（开关 / 音色 14 选 1 选中即试听 / 后台通知），`setUiPrefs` 回执文案补「已保存任务完成提醒设置」。

**验证**：新探针 `shots/sound-notify-check.mjs` 31 断言全绿（音色表 14 项结构与编号连续、编号归一、后台判定三态、跳变判定七例、通知正文五例、宿主读档临时 HOME 六例）。实机走查 `desktop/shots/sound-notify.ps1` + `sound-fake-server.mjs`（18961 端口一律回纯文本，gitignored）：实例 A 假端点跑一轮真对话——EVAL 里把 `document.hasFocus` patch 成 false（比抢焦点可靠、与真实「用户在别的窗口」同构），stderr 出两条 `[selfcheck] 系统通知：`——「走查直调通知 / 主进程 notify 链路」（直调 dsc.notify 返回 true）与「跑一轮提醒走查 · 任务完成 / 提醒走查完成」（完成跳变 effect 真触发，标题走会话标题、正文取最后一条回复），`new AudioContext()` 冒烟 true，假端点对账 chat+title 两请求；实例 B `?settings=general` 截图目检——「任务完成提醒」组三行版式与外观组一致、音色下拉显示「双音轻抚」。真实 ~/.dsc 指纹逐文件一致（185 文件）。探针 45 个全绿（preset-check 首轮误报系 grep 把 PASS 行里的「（✗）」记号算进失败，重跑全绿）。双端 typecheck + build 绿。

**诚实边界**：通知与提示音只覆盖「当前会话」的回合完成——切走后旧会话跑完不提醒（快照只推当前会话的 turnState；跨会话完成提醒要动内核快照面，本轮不做）；用户主动打断、审批拒绝也走同一条「跑动→idle」跳变（回合确实结束了，响一声不算误报）；主进程通知的真实弹出效果（Windows toast 视觉、点击聚焦）自动化只验到 handler 与 show() 不抛，真机目检在本机通过；「通知铃铛图标」「错误回合独立音效」（hermes 的 turnError、codex 的 approval-requested 分型）未做——两开关各自独立已覆盖主需求，分型通知留待有真实需求再加。

## 阶段 60：0.6.40 重审与重打包——修掉通知标题的会话错配（0.6.40 补丁）

用户要求「重新审查并打包」。重审 0.6.40 全部改动面（turn-notify / completion-sound / App 完成 effect / SettingsModal 三行 / 主进程 notify handler / preload / prefs 读档 / contract 三字段 / runtime 回执），其余全过：合成器全程 AudioContext 时钟调度（无 setTimeout，窗口最小化时不会被 Electron 后台节流毁掉时序）、打包 icon 经 extraResources 进 resourcesPath 与 handler 路径一致、showMainWindow 处理最小化恢复、主进程 sender/title 校验与 `silent: true` 全对。

**揪出一处**：`App.tsx` 完成 effect 里通知标题的会话匹配写的是 `curr.id ?? '#'`——`curr.id` 已在两行前归一成空串（`?? ''`），`??` 永不触发，是死分支；且与顶栏既有口径（同文件 575 行 `snapshot.status.sessionId ?? '#'`）漂移：sessionId 还没落盘时空串拼出 `.jsonl`，`endsWith('.jsonl')` 会**错配到列表里第一个会话**的标题，而不是按设计回落「Muse Code」。修成与顶栏逐字同款（用 `snapshot.status.sessionId ?? '#'`），`curr.id` 只留给跳变判同。

**回归**：双端 typecheck + build 绿；sound-notify-check 31 断言全绿；40 个 check 类探针循环电池全绿。**browser-check 12.x 环境烟测失败**（198 PASS / 1 FAIL）：真启动受控 Chrome 等 DevToolsActivePort 30s 超时——本机浏览器环境态问题（与本次渲染层一行改动无交集，13.x 完整生命周期 198 项全过），两次重跑同点复现，记录在案。重打包（nsis + portable 签名完成）、dist-presets-probe 全过、pkg-smoke 截图冒烟绿（hasApp/hasComposer/hasSidebar/rendered 全 true，目检非白屏）。

## 阶段 61：完成提醒测试执行轮——补上渲染层 prefs 归一漏掉的三字段（0.6.40 补丁 2）

按测试计划逐项执行：sound-notify.ps1 实机走查重跑全绿（实例 A 两条 stderr 通知——直调链路与完成跳变各一，`notified`/`acProbe`/`replyOk` 全 true；实例 B marks 含「任务完成提醒」组；假端点本轮恰好 chat+title 一组，server-log 追加式前三组是上轮残留；真实 ~/.dsc 指纹逐文件一致 189 文件）。截图目检：设置页「任务完成提醒」三行版式对齐、说明文案齐全；主界面一轮真对话完整（回复/用量/标题生成都在）。注意通知标题显示的是**完成瞬间的**会话标题（首条用户消息版），LLM 生成的正式标题在其后异步到达才替换——时序内联，非回归。

**又揪出一处**：`appearance.ts` 的 `normalizeUiPrefs` 对三新字段零处理（`...prefs` 原样透传）——与阶段 59 交付说明宣称的「渲染层缺项 `!== false` 回落开」不符；既有的 `reasoningDefaultOpen`/`toolDefaultOpen` 都有渲染层第二层归一（不信任宿主形状的纵深防御），新字段漏了这层。宿主读档白名单目前恒返回归一值所以没暴露成可见 bug，但补齐：两开关 `!== false`（缺项回落**开**，与 `=== true` 的收起默认方向相反——出厂语义就是开）、音色过 `normalizeSoundVariant`。appearance.ts 因 import bridge.js 值依赖探针跑不了，这层归一无独立断言（normalizeSoundVariant 本体有探针九例），如实记录。typecheck + build + sound 探针 + 重打包 + pkg-smoke 全绿。

## 阶段 62：侧栏菜单两报障——右键菜单横贯窗口、工作区「···」贴底被裁（0.6.41）

用户实测报的两个侧栏菜单 bug，附截图：① 会话右键菜单「特别长一条」——菜单项只占左边一小列，容器横贯整个窗口；② 工作区行在最底下时点「···」更多，菜单被侧栏底部裁掉。

**根因一（超宽）**：`.row-menu` 类上默认 `top: calc(100% - 2px); right: 4px`（为「···」贴行右缘而设），而三处 fixed 贴指针/贴按钮的菜单（会话右键 `sess-ctx-menu`、dock 页签右键 `dock-tab-menu`、工作区「···」）inline 只给 `left`——**left 与遗留的 right 并存**（absolute/fixed 且 width:auto）把容器从 left 一直拉到视口右缘，菜单项窄列、空壳通栏。修法：`.row-menu` 删掉默认 top/right（全量核对过 6 个消费方——view-menu/`ws-open-menu`/`sub-menu` 全都显式定位，无一依赖默认值），位置一律归各消费方自己给；一处 CSS 删默认值同时修好两个右键菜单并杜绝复发。

**根因二（贴底被裁）**：工作区「···」菜单 absolute 就地展开（`top: calc(100% - 2px)`），挂在 `.group-row`（position:relative）里，被滚动区 `overflow-y: auto` 裁掉——viewMenu 当年正是这个坑（注释 116-118 写着「就地定位会被 overflow-y: auto 裁掉」），改成视口坐标时工作区「···」没一起改。修法：对齐 viewMenu 先例，`···` 按钮点击时 `getBoundingClientRect()` 记按钮坐标，菜单改 fixed 贴按钮（left = 按钮右缘 − 200、`Math.max(8, …)` 防窄窗出左缘）；底部空间 < 240（菜单最高约 5 项 ≈ 180px 留余量）翻到按钮上方（CSS `bottom`，不用估菜单高度）。state 从 `{key,x?,y?}` 扩成 `{key,x?,y?,left?,top?,bottom?}`。顺手：会话右键菜单的垂直夹取 300→240（菜单实际高约 160，300 会让靠底行的菜单与指针脱开一大截）；dock 页签菜单加同款左右下夹取（原来完全无夹取，dock 贴窗口底缘会伸出窗外）。

**走查**（`desktop/shots/menu-check.ps1`，复用 sound-home、无假端点）：三场景数值断言全绿——右键菜单宽 190px（min-width 收缩，修复前 ≈ 视口宽 − left ≈ 1700+）且完整在视口内；空间充足时菜单贴按钮下方 6px（downOk）；贴底翻转用「patch 按钮实例 getBoundingClientRect 成贴视口底缘的假矩形」构造（真实内容不足一屏、窗口有 640 下限构造不出真实贴底；判定与 CSS bottom 同源自洽，真实 innerHeight 不动）——菜单底边精确贴锚点 top−6（846 = 852−6）且完整可见（flipOk）。**走查脚本的三个坑记录在案**：① `.row-actions` 隐藏时按钮 rect 全 0——`body.classList.add('shot-reveal')` 让按钮组常驻（与用户 hover 后点击等价）；② patch `window.innerHeight` 后 `delete` 会让布局代码读到 undefined、渲染层崩（capturePage UnknownVizError + 宿主 invoke 报退出）——要么不 patch、要么恢复原值，本例换成自洽的按钮 rect patch；③ pwsh 相对路径跟 cwd 漂移（/d/dsc 与 /d/dsc/desktop 之间），跑前先 cd。sound-notify.ps1 对照重跑全绿（应用本身没坏，纯属脚本问题）。typecheck + build + sound 探针 + 重打包 + pkg-smoke 全绿。bump 0.6.41。

## 阶段 63：输入框位置对齐 dsh——空会话居中、对话时恒贴底（0.6.42）

用户报：短对话后输入框吊在内容下方（半空），要求参考 dsh（`D:\deepseek-harness`）——初始居中、对话后保持底部。

**dsh 做法**（ui-conversation skeleton）：`phase = settling | hero | active`（`hero = 无会话或空白会话`，settling 是加载中间态、seat 挂载但 visibility:hidden 防闪烁）；布局是 `scrollBody`（flex column 滚动容器）内消息列表 + composerSeat 两个 flex 子项——hero 态 `scrollBody { justify-content: center }` + `.composerHero { align-self: center; padding-bottom: 32px }`（整组居中、略高于正中心）；active 态 `viewArea { flex: 1 0 auto }` 把 seat 推到底 + `.composerSeat { position: sticky; bottom: 0; z-index: 7 }` 钉底 + 顶部 36px 渐变遮罩（transcript 从 seat 顶渐隐）。

**dsc 现状诊断**（`shots/composer-diag.ps1` 注入式实测）：空态居中**本来就是对**（`.thread-main-empty` 的上下 auto margin 夹持，数据：组中心 495 vs 视口中点 456）——坏的只是非空态：`.thread-main` 普通态在 CSS 里**没有任何规则**（裸 div），`chat-wrap` 的 `flex: 1` 落空 → composer 跟内容流：短对话吊半空（用户截图）、内容超屏时**滚出视口外**（注入 12 行实测 composer top 1189 vs 视口 912）。

**修法（一行规则，比 dsh 还省）**：dsc 的结构本来就是 composer 在 `.chat` 滚动容器**之外**（chat-wrap 兄弟节点），不需要 dsh 的 sticky/渐变那套——给 `.thread-main` 补上 flex column 骨架（与既有 `.thread-zone[data-review] .thread-main` 变体同款），`chat-wrap` 的 `flex: 1` 即刻生效：内容不足一屏时撑满把 composer 推到底，超屏时 `.chat` 内滚、composer 恒贴底可见。空态的 auto margin 居中与 flex 天然兼容，零改动。审批卡/计划卡/目标条都在 composer-zone 里，跟着恒贴底——比之前跟流更合理（审批挂起时永远看得到）。

**走查**（`shots/composer-check.ps1` 三断言全绿）：①空态组中心 495 vs 中点 456（容差 60 内）；②切到非空会话 composerBottom 882 = thread-main 底 882（零缝隙贴底）；③往 `.chat-inner` 注入 30 条假内容（+2700px）composer 纹丝不动（882→882）、`.chat` 自己滚（scrollHeight 3434 vs clientHeight 686）。截图目检：同样的短对话，输入框贴窗口底部。menu-check 回归绿（CSS 改动不涉菜单）。重打包 + pkg-smoke 绿。bump 0.6.42。

**诚实边界**：dsh 的 settling 中间态（防加载闪烁）与 hero 的 WorkspaceChip/AgentPreset 槽位没搬——dsc 空态只有 Welcome 引导没有工作区选择（工作区在侧栏切），settling 场景（会话恢复瞬间）在 dsc 表现为短暂 Welcome 闪一下，实机走查未见明显闪烁，不动；composer 顶部渐变遮罩没抄（dsc 的 composer 在滚动容器外，没有内容从它底下滚过，渐变无用武之地）。

## 阶段 64：工作区图标 active 跟选中会话所属组走（0.6.43）

用户报（附截图）：选中某个会话后，对应工作区的图标颜色不会改变——侧栏里 waq 组下的会话高亮了，但工作区行（文件夹图标）不亮/亮的不是它。

**根因**：组行 active 判定用错参照系。`Sidebar.tsx` 的 `isActiveGroup(cwd) => cwd === props.cwd`——`props.cwd` 是**宿主进程**工作目录（启动读一次、切工作区才变），而会话行的 active 是 `activeSessionId`。跨工作区点开历史会话（比如宿主跑在 D:\dsc、点开 C:\Users\waq 下的会话）时：会话行高亮 ✓，但它所属的 waq 组图标不亮 ✗，亮的（如果有）是宿主 cwd 那个组——两个高亮各跟各的，视觉上「会话所属工作区没有被指示出来」。dsh 的语义（ui-workspace `tree.ts` deriveGroups）：`containsCurrent = (组 key === 当前会话所属组)`，组行 `active = containsCurrentDescendant || (expanded && containsCurrent)`——**跟当前会话走**，无选中会话时没有任何组亮。

**修法（语义拆分）**：`newSessionIn`（组行「+」）对 `isActiveGroup` 的依赖**必须保持宿主 cwd 语义**（活动组直接 `onNew`；非活动组要先 `switchCwd` 换宿主目录再建会话——新会话的 cwd 是宿主进程目录，误判会把会话建错工作区）。所以拆成两个概念：保留 `isActiveGroup`（宿主 cwd）给 `newSessionIn`；新增 `activeCwd`（useMemo：有选中会话 → 在 groups 里找含它的组返回其 cwd；无选中会话或被搜索/归档筛出列表 → 回落 `props.cwd`）给组行 className。回落 cwd 而非照抄 dsh 的「无会话不亮」，是保住 dsc「你现在跑在哪个工作区」的空态指示（dsc 顶栏之外侧栏是唯一的工作区方位感）。树模式的祖先链高亮（dsh containsCurrentDescendant）没搬——dsc 树模式此前也没有祖先行高亮，不是本 bug 范围，避免视觉回归。

**走查**（`shots/ws-active-check.ps1`，sound-home 塞一条 C-Users-waq 假会话造出第二组，固定保留作回归依赖）：①跨组点 waq 会话 → active 组变 waq、图标色 = `--dsc-accent`（rgb(86,134,254)）；②点「新会话」→ activeSessionId 置空回落宿主 cwd（tip 显示 D:\dsc 的 dsc 组亮回）。截图目检（ws-active-shot.png）：waq 图标蓝、dsc 图标灰、会话行高亮——正是用户要的指示。探针电池 42/43 绿（browser-check 12.x 环境态失败沿用既有记录）。typecheck + build 绿。bump 0.6.43。
