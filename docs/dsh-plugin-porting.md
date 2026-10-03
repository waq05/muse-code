# dsh 插件适配指南

面向**想把 dsh（DeepSeek Harness）的插件跑到 dsc（Muse Code）上的人**。讲清楚：哪些能直接挂、
哪些要改代码、改的时候 API 怎么对应、实测踩过哪些坑、交付前怎么验证。

前置阅读：[plugin-development.md](plugin-development.md)（dsc 插件的基本形态与服务 API）。
本文只讲"dsh 插件 → dsc"这一件事。

| 想知道 | 去看 |
| --- | --- |
| 我手里的插件能不能直接用 | **§1 判定流程** |
| 直接挂载的步骤 | **§2 挂载路径** |
| 要改代码，API 怎么对应 | **§3 映射表** |
| 为什么我的插件挂不上/行为不对 | **§4 实测坑** |
| 交付前跑什么 | **§5 验证清单** |
| dsh 的请求组装/上下文管理内部机制（源码级） | [dsh-request-assembly.md](dsh-request-assembly.md) |

## 1. 判定流程：三种结局

兼容层（官方可开关插件 `dsh-compat`）解决的是"运行形态"差异；**业务语义**的差异没人能替你
适配。拿到一个 dsh 插件，先按这张表判定：

| dsh 插件的特征 | 结局 | 依据 |
| --- | --- | --- |
| `inject ⊆ ['tools', 'logger']`，工具用 `defineTool(...)` 定义，可选 `export const Config`（schemastery） | **直接挂**，零改动 | 兼容层的三件事正好覆盖：工具形状、logger 服务、配置校验（§2） |
| 同上，但 import 了 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 等包 | **直接挂**，零改动 | 解析钩子把这类导入重定向到 dsc 自带副本（§2.3） |
| `inject` 里有 **两边同名但 API 不同**的服务：`session` / `settings` / `commands` / `approval` / `agent` / `compact` | **能挂，但要改代码**：这些名字在 dsc 里解析到的是 dsc 自己的服务，dsh 的调用方式会运行时炸。按 §3 映射表改写，改完再挂 | 兼容层不垫同名异 API 的服务——垫了等于猜 |
| `inject` 里有 `sessionProjections` / `agents` / `goals` / `systemPrompt` 等 dsh 会话侧服务 | **不支持**：挂载即被拒，宿主会列出缺的服务名 | 这些要整个 dsh 会话语义（事件溯源、agent 注册表），个人版不背；部分场景可按 §3 映射表重写后去掉这些 inject |
| 工具 `execute` 里用了 `exec.agent` / `exec.deferContext` / `exec.requestContext` 等 dsh 执行上下文字段 | **能挂，但要改代码**：dsc 给的 `exec` 只有 `{ signal, cwd }`，其余字段是 `undefined`，用到就炸 | 改成只依赖 `signal`；真需要会话身份的插件属于不支持类 |
| 工具 `output.render` 返回图像块 | 能挂，图像块降级为占位说明文字 | dsc 工具图像走 data URL，dsh 的 attachment 引用没有直接映射 |

一句话：**纯工具插件（配 logger 与配置校验）是兼容层的主战场；会话侧语义是禁区**。

## 2. 直接挂载路径

### 2.1 前置：启用兼容层

插件中心（桌面端「插件」页）里打开**「dsh 兼容层」（dsh-compat）**。它默认关，因为开着会
改变外部插件的模块解析与工具注册行为——按"拉起外部机制的默认关"的规矩走。没开它时，
dsh 风格插件挂载会被拦下，宿主写出的 system 条目会明确提示先开兼容层。

### 2.2 自包含单文件（推荐起点）

dsh 插件若是单文件（或你能把它改写成单文件），放进 `~/.dsc/plugins/` 即可，其余流程与
dsc 原生插件完全一致。最小骨架（完整可跑的参照：`examples/plugins/dsh-style-clock.js`）：

```js
// ~/.dsc/plugins/dsh-my-tool.js
export const name = 'dsh-my-tool'
export const inject = ['tools', 'logger']

export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'dsh_my_tool',
    description: '让模型望文生义的一句话。',
    // dsh 的参数方言：纯对象，required 用布尔位（defineTool 会编译成 JSON Schema）
    parameters: { text: { type: 'string', required: true } },
    timeoutMs: 5_000,
    output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
    execute: async (args, exec) => {
      // exec 只有 { signal, cwd }；取消要协作式地看 exec.signal
      return doWork(args.text, exec.signal)
    },
  })
  return () => off()
}
```

### 2.3 npm 包形态

dsh 插件是 npm 包时，把依赖连同本体装进插件目录（npm ≥7 会自动装 peer 依赖，其中就包括
`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/cordis`）：

```sh
cd ~/.dsc/plugins && npm install <dsh 插件包>
```

然后在 `~/.dsc/config.yaml` 的 `plugins` 段声明包的入口：

```yaml
plugins:
  - "~/.dsc/plugins/node_modules/@<scope>/<dsh-plugin>/lib/index.js"
```

**要点**：`@deepseek-ai/*` 的解析重定向按路径前缀匹配，只对 `~/.dsc/plugins/` 目录**之下**
的导入方生效——装在它下面的 `node_modules` 命中，放到别的盘符路径不命中（那种情况插件
import dsh 库会 `ERR_MODULE_NOT_FOUND`，响亮失败，不会静默装错）。

### 2.4 兼容层自动做了什么（挂载路径上，无需你写）

| 环节 | 行为 |
| --- | --- |
| 模块解析 | 插件文件里 import `@deepseek-ai/*` → 重定向到 dsc 自带 node_modules 与 `@deepseek-ai/dsh-tools` 的传递依赖（schemastery 等）；cordis 保证单实例；双构建包按 ESM 条件命中与 dsh-tools 内部相同的文件 |
| 工具注册 | `ctx.tools.register` 收 dsh `ToolDefinition`：`parameters`（defineTool 已编译的 JSON Schema）透传、`execute(args, exec)` 的 `exec` 为 `{ signal, cwd }`、返回值经 `output.render` 折成文本、图像块降级占位、`timeoutMs` 到点放弃（协作式） |
| risk 映射 | dsh 没有 risk 概念；缺省 `exec`（每次过审批卡）。放宽见 §2.5 |
| logger | `inject: ['logger']` 有服务；`warn`/`error` 镜像进对话流（`[dsh 插件·名字]` 前缀，printf 占位符还原），`info`/`debug` 静默 |
| 配置校验 | `export const Config`（schemastery schema）在挂载时调用一次；抛错 = 挂载失败并自动停用，提示检查 plugins.json 的 config |

### 2.5 risk 映射（安全语义的差异点）

dsc 对工具分级：`read` 自动放行、`write`/`exec` 走权限模式与审批卡。dsh 工具转进来缺省
`exec`——**宁多问不漏问**。想放宽，写进该插件在 `~/.dsc/plugins.json` 条目的 `config`：

```json
{ "file": "dsh-my-tool.js", "disabled": false,
  "config": { "risk": "read", "risks": { "dsh_echo": "read", "dsh_deploy": "write" } } }
```

`risk` 是这份插件全部工具的缺省，`risks` 按工具名覆盖；非法值回落 `exec`。每次注册现读，
改完停用→启用（或重启挂载）即生效。**判定标准与 dsc 原生插件一致**：只读数据 `read`；
写文件 `write`；执行命令 `exec`。

## 3. 映射表：要改代码时的 API 对照

dsh 与 dsc 是同名生态（都叫 cordis 插件），但服务面不同。改写的总原则：**会话侧语义找
dsc 的等价扩展点重挂，找不到就砍掉那个功能**——个人版没有的，装不出来。

| dsh 里的做法 | dsc 对应 | 差异要点 |
| --- | --- | --- |
| `ctx.tools.register(defineTool({...}))` | 原样（兼容面转换） | `exec` 缩水为 `{ signal, cwd }`；加 risk 配置（§2.5）；`presentCall`/`presentResult`/`isConcurrencySafe` 被忽略（dsc 工具卡通用渲染） |
| `ctx.logger.warn('… %s', x)` | 原样 | `info`/`debug` 不落地；warn/error 进对话流 |
| `export const Config = z.object({...})` | 原样 | 挂载期校验、失败回滚 |
| `ctx.systemPrompt` 的 provider / waterfall 贡献段 | `ctx.prompt.register(id, () => text, { order })` | dsc 是"每次组装取文本"的段注册表；order 刻度 0~890（身份 0 / 插件 60 / 指令文件 200 / 模型信息 890），易变内容往后放；环境事实不进提示词，由 env-facts 投影附在请求末尾（2026-10-03 起） |
| 改写发给模型的消息 | `ctx.prompt.registerProjection(id, fn, { order })` | dsc v6 的**命名纯投影**：必须是纯函数；往请求里加日志外内容必须配 `ctx.session.current().appendNote(id, text)` |
| `ctx.sessionProjections.register({ key, init, apply })` | `ctx.session.appendState(id, payload)` + `ctx.session.current().state(id)` | dsc 无投影 schema 与状态版本；语义是"最后一条生效"（latest-wins）；键要先在 `src/core/session.ts` 的 `SessionStateMap` 上声明合并（那是内核文件，随包插件才改得了） |
| `ctx.goals`（目标服务） | `ctx.goal.goalAction(action, …)` | dsc 的目标挂当前会话、跨轮自动续跑；无 dsh 的 agent 绑定语义 |
| `ctx.agents` / fork 会话 | 无直接对应 | 子智能体走 subagent 插件（`subagent` / `team_task` 工具，可选服务 `ctx.get('team')`） |
| `ctx.commands.register(...)` | `ctx.commands.register({ name, args, description }, handler)` | dsc 形状；handler 收 `({ ui })`，反馈用 `ui.notice()` |
| `ctx.settings`（dsh 的设置页） | `ctx.settings.registerSection({...})` | dsc 是声明式控件（六种），插件拿不到 DOM；字段定义见 plugin-development.md §4.7 |
| dsh 的审批桥（user-approval） | 无需适配 | dsc 的守卫链 + 审批插件按 risk 自动接管；`exec` 类工具天然过卡 |

改写时的两条硬规矩（与 dsc 原生插件相同，违者挂不上或运行时炸）：

1. **可选服务不进 `inject`**：`team` / `mcp` / `sandbox` / `sessionSearch` 这类"插件没开就
   不存在"的服务，读它用 `ctx.get('名字')`；写进 `inject` 会让挂载失败。
2. **注册一律返回清理函数**，在 `apply` 的 disposer 里全部调用——dsc 的停用是热卸载。

## 4. 实测坑（本批自检真踩出来的，每条都有产出物佐证）

| 坑 | 症状 | 原因 | 对策 |
| --- | --- | --- | --- |
| cordis 的 `logger` 不是可注入服务 | `inject: ['logger']` 的插件**挂载成功但 apply 永不执行**，无任何报错 | npm 发布的 cordis 4.0.4 里 logger 是原型属性（dsh 的 vendor 版才是服务），fiber 等一个永远不会来的服务 | 开 dsh-compat：它 `provide('logger')` 一个委托门面。**排查这类"挂上了但没跑"的插件，先怀疑 inject 缺服务** |
| logger 的 warn/error 看不见 | 插件打了 warn，对话流没有 | cordis exporter 缺省阈值是 info(1)，warn(2)/error(0 之外) 被滤 | 兼容桥已显式 `levels: { default: 3 }` 放开；自己注册 exporter 时记得照做 |
| parameters 用 schemastery 实例报 `must be a value schema object` | defineTool 当场抛 JsonSchemaError | dsh 的参数方言是**纯对象**（`{ type: 'string', required: true }`），schemastery 的 `z` 只用于 `Config` 导出 | 参数写纯对象方言，或干脆写标准 JSON Schema；z 留给 Config |
| schemastery 双实例 | 同上，且时而好时而坏 | CJS/ESM 双构建包被解析成两份模块副本，原型不等、instanceof 分裂 | 插件里**只** `import z from '@deepseek-ai/schemastery'`（解析钩子按 ESM 条件命中与 dsh-tools 内部相同的文件）；不要自己 `require` 它的 CJS 入口 |
| printf 占位符原样透传 | `warn('failed: %s', err)` 显示出字面 `%s` | 桥若直接 join 参数不会替换占位符 | 兼容桥已用 `Logger.format` 还原；自建桥时记得调它 |
| 解析钩子不生效 | 插件 import `@deepseek-ai/*` 报 `ERR_MODULE_NOT_FOUND` | 插件文件不在 `~/.dsc/plugins/` 之下（前缀匹配失败），或 dsh-compat 没开（钩子未注册） | 插件放对目录并开兼容层；npm 包装进 `~/.dsc/plugins/node_modules/` 即命中前缀 |
| dsh 工具定义直接塞给 dsc 注册表 | 挂载失败：`是 dsh 风格的定义（有 execute 没有 run）` | 兼容层没开时 `ctx.tools.register` 只认 dsc 的 ToolEntry（`run` 函数） | 按提示开 dsh-compat 后重新挂载；这是形状关的预期行为，不是 bug |

## 5. 验证清单（交付前逐项执行）

1. **判定复核**：§1 表格走一遍，确认插件落在"直接挂"或"改码后挂"，没有禁区特征。
2. **兼容层开着**：插件中心确认 `dsh-compat` 已启用。
3. **挂载**：启用插件；挂载失败时宿主会写 system 条目说明原因（缺服务 / 配置校验失败 /
   版本不兼容），修好再继续。
4. **功能**：工具插件 → 在对话里诱导模型调用，确认结果返回、参数校验生效（喂非法参数应报
   ToolArgsError 类错误）；logger → 触发一次 warn，确认对话流出现 `[dsh 插件·名字]` 行。
5. **审批语义**：`exec` 缺省的工具确认每次弹卡；配置了 `risk: read` 的确认不弹；写类操作
   确认走审批而不是静默落盘。
6. **卸载干净**：停用插件后确认工具从注册表消失、logger 桥停止输出（disposer 返回的清理
   函数全部被调用）。
7. **回归自检**：`node shots/dsh-compat-check.mjs`——14+ 条断言覆盖解析钩子、工具兼容面、
   logger 桥、配置校验、不支持项拒绝；给兼容层改代码时必须全绿再交付。

## 6. 边界（当前明确不支持的，别绕）

- **dsh 会话侧语义**：`sessionProjections`（事件溯源投影）、`agents`（agent 注册表与 fork）、
  `goals`（agent 绑定目标）、`systemPrompt`（waterfall 装配）——挂载被拒；等价功能按 §3
  映射表重写后去掉对应 inject。
- **dsh 的 UI / client 类插件**：dsc 的界面走自己的 contract 体系（快照 + 白名单方法），
  dsh 的 ConversationNode 之类的渲染扩展没有对应物。
- **`ctx.tools` 兼容面只实现了 `register`**：调其余成员（`schemas` / dispatch 类）会响亮
  报错，不会静默 undefined——这是刻意的，别依赖。
- **`config.yaml plugins` 段的 extraPaths 不享受解析重定向**：重定向按 `~/.dsc/plugins/`
  前缀匹配；放外头的插件要么搬进来，要么自带依赖（把 `@deepseek-ai/*` 装在它自己的
  node_modules 里，Node 自然解析，但 cordis 双实例风险自担）。
