# dsc 开发手册

面向**要改这份代码的人**（包括下次坐到位子上的 AI 助手）。讲清楚代码怎么分层、一个新功能
该落在哪一层、改完怎么验证、出问题去哪看。

| 想知道 | 去看 |
| --- | --- |
| 怎么装、怎么跑、怎么配模型 | [README.md](../README.md) |
| **代码怎么分层、往哪改、怎么验证** | **本文档** |
| 为什么长成这样、踩过哪些坑 | [development-log.md](development-log.md) |
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
             │        内核插件 14（清单里显示 12）+ 官方可开关 2 + 外部插件 N     │
             │  src/core/* 是纯能力，被插件包装后对外提供服务      │
             └──────────────────────────────────────────────────┘
```

三条铁律：

1. **内核不碰界面**。`src/core/` 里出现 `ink`、`electron`、`react` 就算越界；
2. **UI 不碰内核**。renderer 只能调 `host-stdio` 白名单里的方法（`src/plugins/host-stdio.ts:44`
   的 `INVOKABLE_METHODS`），想知道内核有什么，看 `src/contract.ts` 的 `DscRuntime`；
3. **装配只在 cordis 里**。新功能往扩展点上挂，不改 `src/core/loop.ts` 的执行流程。要改循环，
   先改这份文档的扩展点清单。

## 2. 仓库地图

规模是这轮改动之后现量的，只数源文件行数，当量尺用。

| 路径 | 规模 | 职责 |
| --- | --- | --- |
| `src/core/` | 21 个文件 ≈3700 行 | 纯能力：模型客户端、会话、循环、审批、压缩、工具、技能、设置、任务板 |
| `src/core/tools/` | 4 个文件 ≈305 行 | 内置六件套 `bash`/`read`/`write`/`edit`/`glob`/`grep` |
| `src/plugins/` | 18 个文件 ≈3530 行 | 每个服务一个 cordis 插件 + 两个官方可开关插件 |
| `src/host/kernel.ts` | 178 行 | 内核装配顺序与三档插件元数据 |
| `src/contract.ts` | 414 行 | UI ⇄ 运行时的中性契约（`DscRuntime` + 视图类型） |
| `src/services/types.ts` | 429 行 | 服务面声明（`ctx.llm`、`ctx.team` 这些是什么类型） |
| `src/adapter/transcript.ts` | 226 行 | 内核事件 → UI 快照的折叠投影 |
| `src/app/` | 7 个组件 | ink 终端界面（与桌面端共用契约） |
| `desktop/electron/` | main + preload | 窗口、托盘、运行时子进程、终端与浏览器 dock |
| `desktop/src/renderer/` | 20 个文件 ≈4250 行 | 桌面界面：会话、侧栏、插件、技能、设置、队友 |
| `shots/` | 6 个脚本 | 自检与实拍（全部跑在临时 HOME 上） |
| `examples/plugins/` | 5 个示例 | 手写插件的参照 |

## 3. 三条启动链路

**TUI**（`dsc`）

1. `bin/dsc.js` 解析 `--resume` / `config` 子命令，spawn `node lib/boot.js`；
2. `src/boot.ts` 只做装配，按顺序：`migrateFromDsh()`（幂等，只读 dsh）→ `readConfig()` →
   `readUiConfig()` → `createKernel()` → 装 TUI 插件 → `loadExternalPlugins()` →
   `emitStartupNotes()`。`readUiConfig()` 读 `config.yaml` 的 `ui` 段与 `plugins` 段，
   但 boot 是**无条件**挂 TUI 的（`src/boot.ts:27`）——真正起作用的只有 `plugins` 段；
3. `--resume` 走 `DSC_RESUME_SESSION` 环境变量传给子进程（`auto` = 看 `.last-session` 指针）。

**桌面**（`dist/win-unpacked/dsc.exe` 或 `pnpm run dev`）

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
| 自定义 | `source: 'external'`，文件在 `~/.dsc/plugins/*.js` | 可拨，默认开 | 用户自己的 |
| 官方可开关 | `source: 'builtin'` + `toggleable: true` | 可拨，默认由 `defaultDisabled` 定 | 子智能体团队、电脑操作（都默认关） |
| 运行内核 | `source: 'builtin'` 且没标 `toggleable` | 不给开关 | `llm`/`session`/`approval`/`tools`/`tools-default`/`transcript`/`commands`/`skills`/`settings`/`compact`/`agent`/`runtime` 共 12 个 |

内核清单在 `src/host/kernel.ts` 的 `BUILTIN_PLUGINS`，官方可开关清单在同文件
`OFFICIAL_PLUGINS`。新增一档官方可开关插件的三步写在
[plugin-development.md §3.4](plugin-development.md)。

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

**方法白名单**约 40 个，按主题分组：会话操作、模型与思考强度、插件开关、队友
（`listTeammates` / `peekTranscript`）、命令、审批应答、dock、会话库（归档/恢复/删除/改名/
置顶/分叉）、界面偏好、技能中心、设置界面与模型配置。

**加一个方法要走三步**，少一步就是「renderer 里点了没反应」：

1. `src/contract.ts` 的 `DscRuntime` 加签名；
2. `src/plugins/runtime.ts` 实现；
3. `src/plugins/host-stdio.ts` 的 `INVOKABLE_METHODS` 加名字，renderer 侧 `bridge.ts` 加调用。

版本号一览：

| 常量 | 位置 | 当前值 | 什么时候动 |
| --- | --- | --- | --- |
| `KERNEL_API_VERSION` | `src/core/plugin-registry.ts:67` | 3 | 插件能用的扩展点有增减 |
| `HOST_PROTOCOL_VERSION` | `src/plugins/host-stdio.ts:25` + `desktop/electron/main/protocol.ts` | 2 | 协议消息种类或白名单语义变了 |

两个版本都是「加载时对不上就报错」，不做静默兼容。插件可以声明 `apiVersion`，内核只拒绝
**高于**自己的版本。

## 6. 数据与文件面

全在 `~/.dsc/` 下（工作区里的技能目录例外，见表末）。改任何一个格式都要先确认读写两侧。

| 路径 | 谁写 | 作用 |
| --- | --- | --- |
| `config.yaml` | 用户 / 设置界面（容错读写在 `src/core/config-store.ts`）/ `dsc config migrate` | 主配置：默认 provider/model + `providers`（`baseURL`/`apiKeyEnv`/`models`）+ `skills` 自定义目录 + `ui` 段选界面 |
| `credentials.yaml` | 用户 / 设置界面 | key 的第二来源（第一是 `apiKeyEnv` 指向的环境变量，第三是回退读 `~/.dsh`） |
| `config.json` | 用户（可选） | 轻量覆盖：provider / model / temperature |
| `settings.json` | 设置界面与 `ctx.settings`（`src/core/prefs.ts:15`） | 审批与思考强度默认值、市场源清单、关窗是否缩托盘、侧栏界面偏好，加上插件分区写回的 `pluginConfig[file][key]` |
| `plugins.json` | 插件中心、`plugin_manager` 工具 | 条目树：`entries[{file, disabled, config}]` + `history` 版本记录（自动回滚靠它） |
| `skills.json` | 技能中心 | 每个技能的开关 |
| `desktop.json` | 桌面主进程（`desktop/electron/main/dsc-core.ts:42-60`） | 最近工作目录（最多记 12 个）、托盘提示是否弹过 |
| `.last-session` | 会话插件 | `--resume` 无参时指向上次的会话文件 |
| `sessions/<cwd 压缩名>/<uuid>.jsonl` | 会话插件 | 会话历史，append-only，恢复靠重放 |
| `sessions/meta.json` | 会话插件 | sidecar：归档 / 置顶 / 改名，**不进 jsonl** |
| `sessions/.archived/<工作区名>/` | 会话库（归档） | 归档区（把文件挪进来，不是在 jsonl 里打标记） |
| `.trash/<工作区名>/` | 会话库（「永久删除」） | 其实是回收站：按 mtime 超过 30 天才扫掉（`src/core/session.ts:397-417`），删错了还能手工捞回来 |
| `sessions/.teammates/<cwd>/<id>.jsonl` | 子智能体插件 | 队友运行记录。目录以点开头 ⇒ 会话列表扫不到 |
| `team/roster.json` | 子智能体插件 | 队友名册（收工的队友靠它出现在侧栏） |
| `team/board.json` | 子智能体插件 | 共享任务板 |
| `team/inbox/<队友名>.jsonl` | 子智能体插件 | 给队友的留言（追加写，队友在回合边界读） |
| `agents/<角色名>.md` | 用户 / 子智能体设置分区 | 队友角色文件，一个角色一个文件 |
| `plugins/*.js` | 用户 | 自定义插件 |
| `skills/` | 技能中心（安装） | 用户级技能目录，每个子目录一份 `SKILL.md` |
| `cache/` | 技能市场（`src/core/market.ts:10`） | 市场条目清单，缓存 1 小时 |
| `memory/` | `examples/plugins/memory.js` 示例插件 | 按项目工作区分区存的长期事实，内核不管它 |

技能发现的优先级（rank 小的赢，`src/core/skills.ts:64-71`）：当前目录 `.dsc/skills` →
当前目录 `.agents/skills` → `config.yaml` 的 `skills` 段自定义目录 → `~/.dsc/skills`。
**插件分区的配置值写进 `settings.json` 的 `pluginConfig`，不写 `plugins.json` 的 `config`**——
后者的 `config` 是内核装配插件时喂给 `apply()` 的那份。

带 `version` 字段的只有三个文件：`plugins.json`、`skills.json`、`sessions/meta.json`，
都写死 `version: 1`，读到别的值就整表当空的重来（`src/core/session-meta.ts:53`）。
**会话 jsonl 本身没有格式版本号**——这是明写的取舍（`src/core/session.ts:4-5`），
所以改事件种类时没有加载期检查会替你兜底。

**会话 jsonl 的事件种类**（`src/core/session.ts`）：

```
meta     { cwd, createdAt, ... }        第一行，重写时保留
user     { text }
assistant{ text, reasoning, toolCalls? }
tool     { callId, name, text, images?, error? }   error = rejected | tool-error
summary  { text }                       压缩产生的摘要
```

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
| 往系统提示加一段 | `ctx.prompt.contribute()` | 插件关着时这段话自动消失 |
| 改写发给模型的消息 | `ctx.prompt.transformMessages()` | 只改请求体，不动会话日志（旧截图裁剪用的就是它） |
| 监听内核事件 | `ctx.events.on(...)` | 见 plugin-development.md §5 |
| 加一个设置分区 | `ctx.settings.defineSection()` | 声明式控件，插件拿不到 DOM |
| 挂一个技能来源 | `ctx.skills.source()` | 技能中心会多一个来源 |
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
node shots/order-check.mjs         # 侧栏工作区排序落盘
node scripts/composer-test.mjs     # TUI 输入候选面板

# 打包版实拍
cd D:\dsc\desktop && pnpm run dist:dir     # → dist/win-unpacked/dsc.exe
```

实拍的环境变量钩子（`desktop/electron/main/index.ts:292-329`）：

| 变量 | 作用 |
| --- | --- |
| `DSC_DESKTOP_SHOT=<png 路径>` | 加载完成后截图并退出（带看门狗，`capturePage` 卡住也会退） |
| `DSC_DESKTOP_SHOT_DELAY` | 截图前等多久，默认 4000 ms |
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
| 重新打开会话后上下文又变长了 | 压缩只在内存里生效，重放时会把摘要之前的原始记录一起读回来（`src/core/session.ts:120-122`），见 [development-log 阶段 9](development-log.md) |
| 网络断了却不重试 | 可重试条件要求错误带 429/5xx 状态码，fetch 抛的异常不带（`src/core/llm.ts:99-103`） |
| 截图后 token 暴涨 | 看是否启用了旧截图裁剪（`computer-use` 插件的 `transformMessages`） |

## 12. 关键取值速查

改这些之前先确认设置界面对不对得上：能在界面改的一律走设置分区，不许在代码里另起一份。

**枚举**

| 名称 | 取值 | 位置 |
| --- | --- | --- |
| 权限模式 `ApprovalPolicy` | `readonly`（只读，写和执行一律拒）/ `auto-edit`（写文件放行，执行命令仍要审批）/ `full-access`（动手都要审批）/ `ai-review`（当前模型逐次判断放行，判断失败退回人工审批） | `src/contract.ts:22`，判读在 `src/plugins/approval.ts:144` |
| 思考强度 `EffortLevel` | `default` / `off` / `low` / `high` / `max` | `src/contract.ts:12` |
| 会话排序 `SessionSortKey` | `created` / `recent` | `src/contract.ts:115` |
| 队友审批 `TeammateApproval` | `forbid`（不允许）/ `foreground`（仅前台子允许）/ `ask`（允许并标注），从严到松按 `forbid < foreground < ask` 比较 | `src/plugins/subagent.ts:75` |

**默认值与硬编码数值**

| 数值 | 值 | 出处 |
| --- | --- | --- |
| 压缩保留的最近消息条数 | 20 条（更早的送进摘要） | `src/core/compact.ts:16` |
| 自动压缩触发 | 估算 tokens 超过模型上下文窗口 80% | README「交互」一节 |
| 模型请求重试 | 最多 3 次，退避 500ms × 2^(n-1) | `src/core/llm.ts:89` |
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

**写/执行类不留持久授权**：一次审批只管这一次，`approval` 服务不跨回合记住「上次同意过」。

## 13. 模块速查

### 内核装配顺序

`createKernel()` 依次挂 14 个内核插件：`llm` → `session` → `approval` → `tools` →
`tools-default` → `transcript` → `commands` → `skills` → `settings` → `compact` →
`agent` → `runtime` → `desktop-dock` → `plugin-manager`，然后按 `plugins.json` 决定两个
官方可开关插件本次挂不挂（`src/host/kernel.ts:90-117`）。注意 `desktop-dock` 与
`plugin-manager` 不显示在插件中心的「运行内核」清单里（那份清单是 12 条，
`src/host/kernel.ts:70-83`）。把 `tools-default` 剔掉就得到一个只有对话、没有工具的
harness（`src/plugins/tools-default.ts:3`）。

### core 层

| 模块 | 该知道的 |
| --- | --- |
| `config.ts` | 合成运行期路由表：`config.yaml` + 凭据 + `config.json` 覆盖。`apiKeyEnv` 取不到值的端点整条不注册（`:74-76`）；默认路由指向不存在的端点时退回第一个可用组合（`:131-142`）。上下文窗口缺省 128000、输出上限缺省 8192（`:85-86`） |
| `config-store.ts` | 设置界面写 `config.yaml` / `credentials.yaml` 的**唯一**入口。端点名要匹配 `/^[a-z0-9][a-z0-9_-]{0,40}$/`（`:124`）；不写 `apiKeyEnv` 时按端点名推导成 `<名字大写>_API_KEY`；覆盖前会先存一份 `config.yaml.bak`，**YAML 注释会在这一步丢掉**（`:44`） |
| `migrate.ts` | 一次性搬 dsh 的配置，只读 dsh。目标已存在且没给 `force` 就直接返回（`:107`）。只收 `api: openai-completions` 的端点（`:78`） |
| `llm.ts` | 手写 SSE 解析：只认 `data:` 行，单行 JSON 解析失败就跳过（`:172-176`）。思考增量字段是 `delta.reasoning_content`（`:179-182`），重放给模型时原样回传（空串不回传）。工具调用按 `delta.tool_calls[].index` 拼，`arguments` 用 `+=` 续接，最后按 index 排序（`:187-216`）。最多 3 次尝试，退避 500ms、1000ms（`:89`、`:105`） |
| `session.ts` | 列表只读每个文件前 8 行 + mtime（`:297-319`），所以列表页别指望读到深处的内容。目录名把 `\\`、`/`、`:` 换成 `-`（`:34-36`） |
| `session-meta.ts` | `sessions/meta.json` 用 uuid 当键，所以归档挪文件不会丢状态（`:7`）。`version` 不是 1 就整表当空（`:53`） |
| `events.ts` | `CoreEvent` 九个变体，是 core 唯一对外通道（`:10-22`） |
| `compact.ts` | 见 §12 |
| `approval.ts` | 只有审批通道**接口**，判读在 `src/plugins/approval.ts` |
| `tools/` | `bash` 默认 30 秒、最多 120 秒，输出超 8000 字符截断（累积到 16000 就不再收），Windows 走 `powershell -NoProfile -Command`，超时和取消都 SIGKILL。`read` 单次最多 2000 行。`glob` 遍历上限 1 万、`grep` 2 万，都跳过 `node_modules`/`.git`/`dist`/`build`/`coverage`/`__pycache__` 与 1 MiB 以上的文件。**没有目录白名单**——路径只按会话工作目录解析 |
| `skills.ts` | 只认顶层 `<目录>/SKILL.md` 与顶层 `<名字>.md`，不递归（`:165-178`）。`name` 要 kebab-case，非法就退回文件名并记一条问题 |
| `market.ts` | 缓存 1 小时、拉取超时 15 秒、浏览并发 6、附属文件最多 40 个。GitHub 匿名限额低，403/422 会提示设 `GITHUB_TOKEN` |
| `prefs.ts` | 偏好文件读坏了按默认返回，不崩（`:89-91`）。`closeToTray` 默认 true |
| `version.ts` | 版本号从 `name === "dsc-tui"` 的 `package.json` 往上找（`:19`），所以包名和版本轴是绑在一起的 |

### 审批判定顺序（`src/plugins/approval.ts:126-152`）

只有 `risk !== 'read'` 的工具进审批（`src/core/loop.ts:198`）。判读顺序：

1. `readonly` → 直接拒；
2. `full-access` → 直接放行；
3. `auto-edit` → 三个条件同时成立才自动放行：工具名是 `write` 或 `edit`、参数里取得到路径
   （按 `file_path`→`path`→`target`→`file` 顺序找）、路径落在会话工作目录内；否则弹人工卡；
4. `ai-review` → 用当前模型问一次（`maxTokens: 200`、思考关掉，只要 ALLOW 或 DENY），
   问不出来退回人工卡；
5. 未知模式 → 弹人工卡。

**没有审批超时**：挂起的审批只有两条出路——本轮被中断（按拒绝结算）或收到退出事件。
被拒时循环会补一条 tool 消息「用户拒绝了这次工具调用。」，因为协议要求每个工具调用都有
对应的 tool 消息，否则下一轮直接 400（`src/core/loop.ts:203-207`）。

### 快照投影（`src/adapter/transcript.ts`）

- `delta` 只进「直播尾」，不进定稿表；`message` 才是定稿信号。定稿条目 id 从 1 递增，
  直播尾条目用**负 id**（`-(位置+1)`）避免撞号（`:51-59`）。
- 工具卡状态就四个：`running` / `done` / `failed` / `rejected`（`src/contract.ts:25`），
  结果文字超 1500 字符截断（`:27`）。
- 状态灯优先级：有挂起审批 → `awaiting-approval`，否则在回合内且working → `working`，
  回合内不 working → `thinking`，其余 `idle`（`src/plugins/transcript.ts:74-81`）。
- **跨进程推的是全量快照，80 ms 节流**（`src/plugins/host-stdio.ts:22`），没有 diff 协议；
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

### 命令与补全（`src/plugins/commands.ts`）

内置命令 6 条：`new` / `resume` / `compact` / `model` / `help` / `exit`（`:19-26`），插件
注册的命令进 `extraSpecs`。输入 `/ne` 按 Enter 会展开成 `/new`（唯一前缀，`:94`）。
`/effort` 保留着但只回一句「v2 已移除」（`:170-173`）。
