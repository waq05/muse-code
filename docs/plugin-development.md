# dsc 插件开发说明书

> **本文档的读者是 AI 编程助手**。当用户要求「给 dsc 写一个插件」时，先通读本文，
> 再按文末模板产出代码，并执行「交付前验证清单」。人类读者可直接跳到示例部分。

---

## 1. 插件是什么

dsc 采用「万物皆插件」架构：内核（cordis Context）只提供一组**服务**，所有能力
——内置工具、斜杠命令、模型路由、会话存储——都是向服务容器注册的插件。外部插件
与内核**零源码耦合**：一个独立 `.js` 文件，放进约定目录即被加载，不改动 dsc 任何源码。

**能做的扩展**：注册工具、注册 `/` 命令、监听并发布事件、消费全部内核服务、
维护插件自身状态与清理逻辑、声明 API 版本与元数据；往桌面端设置面板注册一个**设置分区**，
或往技能中心注册一个**技能来源 / 市场源**。
**做不到的**（当前版本边界，不要向用户承诺）：
- 不能注入自定义 React 组件、HTML 或 CSS。界面扩展只接受可 JSON 序列化的控件声明
  （`SettingsField`，见 §4.7），渲染由桌面端唯一的渲染器完成；TUI 不渲染插件分区；
- 不要尝试覆盖内置服务（cordis 允许 provide 同名服务，但该路径未经验证）。

## 2. 硬性规则（MUST / NEVER）

1. **MUST** 是单个 ESM `.js` 文件，使用命名导出（`export const inject` / `export function apply`）。
2. **MUST** 放在 `~/.dsc/plugins/`（或由 config.yaml `plugins: [...]` 显式声明路径）。
   加载顺序 = 目录内文件名排序；文件名即条目树的 key。
3. **MUST** 在 `inject` 数组里声明用到的全部服务名，且只使用 `ctx.<已声明服务名>`。
4. **NEVER** import dsc 内核源码或任何 dsc 依赖包（运行时零依赖；插件只拿到 `ctx`）。
5. **NEVER** 在模块顶层执行有副作用的代码（加载时顶层代码一定会运行；初始化写在 `apply` 里）。
6. **NEVER** 假设 UI 形态（终端 ink 或桌面端 Web）。任何用户反馈走 `transcript.system()`
   或命令的 `ui.notice()`；不要尝试 console.log 作为输出通道（桌面端不可见）。
7. **NEVER** 在 `apply` 里抛出未捕获异常；失败调用 `ctx.transcript.system('...')` 报告。
8. **MUST** 注册时保存退订函数，并在 `apply` 返回的 disposer 中全部调用（见示例 C）——
   **停用是热卸载**（disposer 会被立即调用，未清理的资源会泄漏）。
9. **MUST** 给工具声明正确的 `risk`：只读数据用 `'read'`（自动放行）；
   任何写文件 / 执行命令的行为用 `'write'` / `'exec'`（受权限模式与审批卡约束）。
10. **MUST** 工具 `run` 返回 `Promise<string>`——这段文本会被原样交给模型，请返回
    简洁、信息密度高的纯文本；失败直接 `throw new Error(...)`。

## 3. 插件解剖

```js
// ~/.dsc/plugins/my-plugin.js
export const name = '我的插件'            // 可选：管理页显示名（缺省 = 文件名去后缀）
export const description = '一句话描述'   // 可选：管理页描述
export const apiVersion = 2              // 可选：声明兼容的内核 API 版本（版本管理见 §3.1）
export const inject = ['tools', 'commands', 'transcript']  // 声明依赖的服务

export function apply(ctx, config) {     // config = 条目树里该条目的 config 对象（可为空）
  // ctx.<服务名> 在此可用（仅限 inject 声明的）
  // 返回值（可选）= disposer：插件停用/宿主退出时执行（热卸载会立即调用）
  return () => { /* 清理 */ }
}
```

### 3.1 条目树与配置（~/.dsc/plugins.json）

参照 dsh 的声明式装配。文件形状：

```json
{
  "version": 1,
  "entries": [
    { "file": "ping.js", "disabled": false, "config": { "greeting": "hi" } }
  ]
}
```

- `disabled`：停用开关（桌面端「插件」页切换的就是它）；不在 entries 里的文件默认启用。
- `config`：**透传给 `apply(ctx, config)` 第二参**——插件用它读自己的配置，不必再自建
  配置文件。取值统一走 `resolvePluginConfig('<file>', passed)`（`src/core/plugin-registry.ts:165`）：
  装配时那份作底，磁盘上这份覆盖它，所以设置分区保存后正在跑的插件下一次用值就是新值，不用重启宿主。
  读它的内置插件有 `compact`、`approval`、`ask`、`goal`、`prompt`、`host-stdio`，取值范围都带上下限夹取；九个官方可开关插件（`subagent`、`computer-use`、`web-search`、`approval-floor`、`spill`、`session-search`、`lifecycle-hooks`、`mcp`、`tool-search`）也各读这一份，并把可调值挂进自己的设置分区。
- **启停热生效**：切换开关 → 内核卸载（调用 disposer）或重新挂载插件，无需重启宿主；
  文件内容变更后重新启用也会加载新代码（按 mtime 破坏模块缓存）。

### 3.2 版本管理（自动回滚）

内核有 API 版本号（当前 `KERNEL_API_VERSION = 4`）。插件声明 `export const apiVersion = 2`：
- 等于内核版本 → 正常挂载；
- **高于**内核（插件要求更新的内核）→ 拒绝挂载、**自动写入停用**（回滚到可用状态），
  管理页显示原因；升级 dsc 后重新启用即可；
- 未声明 → 视为兼容（向后兼容旧插件）。

| 内核 API | 内容 |
|---|---|
| 1 | 初始版本：工具、命令、事件、全部内核服务 |
| 2 | 新增 `settings` 与 `skills` 服务：设置分区、技能来源、市场源三个扩展点；桌面端设置面板与技能中心 |

`apiVersion = 1` 的旧插件在 v2 内核上照常挂载（判定只拒绝**高于**内核的声明），不用改代码；
但要用 §4.7 / §4.8 的扩展点就必须声明 `apiVersion = 2`。

### 3.3 AI 参与插件管理

内核内置 `plugin_manager` 工具（risk='write'，AI 调用会先经权限模式/审批卡）：
`list`（清单）/ `enable` / `disable`（热启停）/ `install`（安装本地 .js 绝对路径并热挂载）。
用户也可以在会话里输入 `/plugins` 查看清单。给 AI 的指引：安装第三方插件前先 `list`
确认没有同名文件；`install` 只接受绝对路径；版本不兼容的插件会被自动停用并在清单里
标注原因，此时应向用户说明而不是反复重试。

### 3.4 插件中心的三档：自定义 / 官方可开关 / 运行内核

桌面端「插件」页从上到下分三档，档位由插件元数据决定（`PluginMeta`，见 `dsc/src/core/plugin-registry.ts`）：

| 档位 | 判定 | 开关 |
|---|---|---|
| 自定义 | `source: 'external'`（`~/.dsc/plugins/*.js`） | 可拨，默认开 |
| 官方可开关 | `source: 'builtin'` 且 `toggleable: true` | 可拨，`defaultDisabled: true` 时默认关 |
| 运行内核 | `source: 'builtin'` 且没标 `toggleable` | 不给开关，页面只露 3 行，其余折叠 |

现有的九个官方可开关插件：默认开的四个是 `web-search`（网页搜索）、`approval-floor`（审批灾难地板）、`spill`（大输出溢出）、`session-search`（会话全文检索）；默认关的五个是 `subagent`（子智能体团队）、`computer-use`（电脑操作）、`lifecycle-hooks`（生命周期钩子）、`mcp`（MCP 客户端）、`tool-search`（工具渐进披露）。各自干什么、默认开关按什么规矩定，见 development.md §4 那张表。

新增一档官方可开关插件要做的三件事：

1. 在 `dsc/src/host/kernel.ts` 的 `OFFICIAL_PLUGINS` 里登记元数据，带上
   `toggleable: true`、`settingsSection: '<分区 id>'`（该默认关的再加 `defaultDisabled: true`），
   并把插件对象填进同文件的 `OFFICIAL_OBJECTS`——少填这一处，内核装配时会直接跳过它，
   开关拨了也不挂载；
2. 插件如果要对外提供服务，在 `apply()` 末尾 `ctx.provide('<服务名>', {...})`；
   没有对外服务的（例如 `approval-floor`、`spill`）跳过这一步；
3. **不要**把这个可选服务写进 `inject`：插件关着时它不存在，写了 `inject` 会让整个挂载失败。
   别人（比如 runtime 的 `listTeammates`、tool-search 读 MCP 工具目录）要用 cordis 的
   `ctx.get('<服务名>')` 去读，读不到就是 `undefined`。直接写 `ctx.<服务名>?.` 也会被代理拦下抛
   `cannot get property "xxx" without inject`——`?.` 救不了，属性访问本身就先抛了。

配置存在条目树里（`writePluginConfig(file, patch)`）。只改配置值不会把插件点亮：
新建条目时沿用元数据声明的默认开关。

## 4. 服务 API 参考

以下签名来自 `dsc/src/services/types.ts` 与 `dsc/src/contract.ts`，是最准确的依据。

### 4.1 tools —— 注册供模型调用的工具

```ts
ctx.tools.register({
  name: string                              // 模型可见的工具名，全小写、稳定
  description: string                       // 模型据此决定何时调用，写清用途与返回值
  parameters: Record<string, unknown>       // JSON Schema（OpenAI function 格式）
  risk: 'read' | 'write' | 'exec'
  run(args: Record<string, unknown>, ctx: { cwd: string; signal: AbortSignal }): Promise<string>
}) => () => void                            // 返回退订函数
ctx.tools.list(): ToolEntry[]
```

要点：`parameters` 必须是合法 JSON Schema（`{ type: 'object', properties: {...} }`）；
`signal` 中止时尽快返回或抛错；**不要**在 run 里再向用户提问（用审批机制表达风险）。

**返回图像**（截图类工具）：返回 `{ text: string, images: ['data:image/png;base64,...'] }`
——消息以多模态 content 数组交给模型，**需要端点支持视觉**（如 GLM 视觉系列）；
纯文本端点会报错。参考 `examples/plugins/computer-use.js` 与 `browser-control.js`。

### 4.2 commands —— 注册斜杠命令

```ts
ctx.commands.register(
  { name: 'greet', args: '<名字>', description: '向某人问好' },
  ({ args, runtime, ui }) => {           // args: string[]；runtime: DscRuntime；ui 见下
    ui.notice(`你好，${args[0] ?? '朋友'}`)   // ui.notice(text) → 会话内灰色提示条
    // ui.openPicker()  → 请求打开会话选择面板（桌面端 / TUI 都会响应）
  },
) => () => void
ctx.commands.specs(): CommandSpec[]          // 全部命令（含内置），/help 与补全数据源
ctx.commands.run(input, runtime, ui): boolean // 派发一条 "/..." 输入（一般不需要直接调）
```

命令名小写、无 `/` 前缀；与内置命令同名会覆盖内置项（避免这样做）。

### 4.3 transcript —— 会话流（反馈用户的正道）

```ts
ctx.transcript.system(text: string)          // 追加一条 system 提示条目（最常用的反馈方式）
ctx.transcript.emit(event)                   // 折叠一条内核事件（CoreEvent）；插件慎用
ctx.transcript.getSnapshot(): RuntimeSnapshot // 读当前快照（entries/status/sessions…）
ctx.transcript.subscribe(listener): () => void  // 快照变化订阅（useSyncExternalStore 语义）
ctx.transcript.touch()                       // 手动失效快照缓存并通知 UI
```

### 4.4 llm —— 模型路由（只读为主）

```ts
ctx.llm.provider / ctx.llm.model / ctx.llm.effort / ctx.llm.contextWindow   // 当前状态
ctx.llm.route(): LlmRoute               // { baseUrl, apiKey, model, maxTokens?, thinking? }
                                        // 注意：返回值含 apiKey，不要打印/落盘
ctx.llm.setModel(provider, model)       // 切换；端点/模型不存在时抛错
ctx.llm.setEffort('off' | 'low' | 'high' | 'max')
ctx.llm.listModels(): ModelChoiceView[] // [{ value: '端点/模型', provider, model, description }]
```

### 4.5 session / agent / approval / compact

```ts
ctx.session.current(): Session          // Session.meta: { id, cwd, createdAt }；Session.messages: 协议消息数组
ctx.session.open(filePath?: string): Promise<void>  // undefined=新建；传入 jsonl 路径=恢复
ctx.session.refresh(): Promise<void>    // 刷新会话列表缓存（ctx.session.sessions）
ctx.session.appendState(id, payload)    // 自己那块状态写进会话记录（见 §4.9 的键表）
ctx.session.current().state(id)         // 恢复会话时读回来；没写过就是 undefined

ctx.agent.followup(text: string)        // 以用户身份投递一条消息（触发完整 Agent 回合）
ctx.agent.interrupt()                   // 取消当前回合

ctx.approval.decide(request, signal): Promise<'allow-once' | 'reject'>  // 编程式审批
ctx.compact.run(): Promise<void>        // 手动压缩上下文
```

### 4.6 ui —— DscRuntime（与桌面端/TUI 同一接口）

`subscribe / getSnapshot / submit / interrupt / openSession / compact / setModel /
setEffort / refreshSessions / listModels / listPlugins / setPluginEnabled /
runCommand / answerApproval / exit / dispose`；
内核 API v2 另加技能与设置两批：`listSkills / readSkill / setSkillEnabled /
browseMarket / installMarketSkill / setMarketSources / getSettingsSections /
getSectionValues / setSettingValue / runSettingAction / getModelConfig /
saveProvider / removeProvider / setProviderKey / setDefaultModel`。
插件里通常用不到它（优先用 `agent` / `transcript`，改配置优先用 `settings` 服务）；
`exit()` 会结束宿主进程，务必只用于用户显式退出。

### 4.7 settings —— 往桌面端设置面板加一个分区

```js
const off = ctx.settings.registerSection({
  id: 'my-plugin-prefs',              // 导航键，建议 `<插件名>-<分区>`；内置 id 见下方规则
  title: '我的插件',                   // 左栏标题（插件贡献的分区会带上「插件」标记）
  subtitle: '轮询与同步设置',           // 可选：分区标题下的一行说明
  order: 30,                          // 小者在前；内置：通用 0 / 模型 10 / 技能 20 / 关于 900
  fields: () => [                     // 每次打开分区都调用；返回值必须能 JSON 序列化
    { type: 'switch', key: 'enabled', label: '启用轮询' },
    { type: 'select', key: 'interval', label: '间隔', options: [{ value: '60', label: '1 分钟' }, { value: '300', label: '5 分钟' }] },
    { type: 'text', key: 'webhook', label: 'Webhook', placeholder: 'https://…', mono: true },
    { type: 'number', key: 'retries', label: '重试次数', min: 0, max: 5 },
    { type: 'info', label: '数据目录', text: '/home/me/.dsc/cache/ping', mono: true, copyable: true },
    { type: 'button', action: 'sync-now', label: '立即同步', style: 'ghost' },
  ],
  values: () => ({ enabled: true, interval: '60', webhook: '', retries: 3 }),
  save: (key, value) => {             // 返回字符串或抛异常 = 失败原因，桌面端就地显示
    if (key === 'retries' && Number(value) < 0) return '重试次数不能是负数'
    state[key] = value
  },
  action: (name) => {                 // 按钮；返回字符串 = 完成后的提示文案
    if (name === 'sync-now') return `已同步 ${state.webhook}`
  },
})
return off                            // MUST 在 disposer 里退订
```

规则：
- 控件只有 `text` / `number` / `select` / `switch` / `info` / `button` 六种，样式由桌面端统一决定，
  别指望像素级控制，也不要塞 HTML；
- `fields()` 与 `values()` 每次打开分区都会调用，可随状态返回不同清单；
- `save()` 抛异常与返回字符串等价，都是一句就地错误（不会弹全局提示条）；
- 分区被停用时 disposer 执行完，分区立刻从左栏消失，用户已存的值不受影响；
- id 撞了内置的 `general` / `models` / `skills` / `about` 时，这个分区被忽略（设置面板里看不到），
  会话里会多一行系统提示说明原因，插件其余部分照常挂载；
- `custom: true`（界面由桌面端自己画）只给内置的「模型」「技能」分区用，
  插件请拆成几个普通分区，不要指望桌面端为你的分区写特判。

### 4.8 skills —— 挂一个技能来源或市场源

```js
const offProvider = ctx.skills.registerProvider({
  name: 'team-skills',                // 进 SkillInfoView.source，技能中心当成来源标记
  rank: 500,                          // 重名裁决：小者赢。内置目录占 100/200/300/400，插件用 500+
  list: (cwd) => [
    { name: 'deploy', description: '部署到测试环境', whenToUse: '用户说「部署」时', source: 'team-skills', rank: 500, modelInvocable: true, userInvocable: true, local: false },
  ],
  get: (name) => (name === 'deploy' ? { name, description: '部署到测试环境', content: '正文（Markdown）' } : undefined),
})
const offMarket = ctx.skills.registerMarket({
  name: 'internal',
  browse: async (refresh) => [{ name: 'deploy', description: '部署到测试环境', source: 'internal', installed: false }],
  install: async (name) => `已安装 ${name}（来自 internal）`,   // 返回一句给用户看的落点说明
})
ctx.skills.userDir                    // ~/.dsc/skills，技能中心「导入技能」的目标目录
ctx.skills.catalogText()              // 模型可见目录文本（只有名字 + 一句话说明）
return () => { offProvider(); offMarket() }
```

规则：
- `local: false` 的虚拟条目在技能中心只展示，没有启停开关（启停只对本地文件生效）；
- 来源清单变了要发 `ctx.emit('dsc/skills-changed')`，桌面端与模型可见目录都会重取；
- 正文会原样进入模型上下文，别塞密钥；描述写清「做什么 + 何时用」，模型据此决定是否调用。

### 4.9 guards / surfaces / waiting —— 内核的三个挂入点

内核 API v4 加的三个扩展点，外加会话记录里那一块自己的状态。共同点：`register(...)` 返回
退订函数，插件卸载就在下一次判定 / 下一次装配快照前生效；同 id 再注册算顶掉前一份。

```js
// 1) 工具动手之前拦一道。order 小的先问：灾难地板 5、协作模式 10、安全钩子 20、审批 30。
//    裁决三种：deny（当场拒，reason 原样回给模型）/ pass（免问直接执行）/ defer（问下一位）。
//    守卫自己抛错按 deny 处理——坏掉的闸门不该等于放行。
const offGuard = ctx.guards.register({
  id: 'my-plugin',
  order: 20,
  decide(input) {
    // input: { toolName, risk, cwd, args, target?, command?, signal }
    if (input.toolName === 'bash' && /sudo/.test(input.command ?? '')) {
      return { action: 'deny', reason: '这个插件不许代你跑 sudo' }
    }
    return { action: 'defer' }
  },
})

// 2) 改写工具的输出（进会话日志与回显之前）。内置刻度：密钥遮红 10、大输出溢出 50。
const offWatch = ctx.guards.registerObserver({
  id: 'my-plugin',
  order: 50,
  observe: (toolName, text) => text.replace(/秘密/g, '██'),
})

// 3) 界面快照里的一块状态投影：先在 contract.ts 的 RuntimeSurfaces 上声明合并这个键，
//    再来登记取值函数。装配快照的那一层不认识你的功能，它只问注册表要全部片段。
const offFace = ctx.surfaces.register('myPanel', () => ({ open: panelOpen }))

// 4) 有张卡片正挂着等用户点：登记一个「现在是否在等」的问法。
//    会话目标的自动续跑会看 ctx.waiting.any 刹车，免得卡片挂着没答就自己往下跑。
const offWaiting = ctx.waiting.register('my-plugin', () => panelOpen)
```

自己那块状态要跟着会话走，就写进会话记录（先在 `src/core/session.ts` 的 `SessionStateMap`
上声明合并这个键，`appendState` 与 `state()` 的类型才对得上）：

```js
ctx.session.appendState('myPanel', { open: true })   // 写一条 { type:'state', id, payload }
ctx.session.current().state('myPanel')               // 恢复会话时读回来
```

这四样都是**注册**，不是改内核：内置的协作模式闸门、审批卡、灾难地板、安全钩子、生命周期钩子、任务清单、计划评审、会话目标、密钥遮红、大输出溢出全都挂在这些点上，外部插件走同一扇门。

有些服务是可选的（插件关着时整个不存在），读它们只能用 `ctx.get('<服务名>')`，不能写进 `inject` 也不能用 `ctx.<服务名>?.`：`team`（子智能体团队）、`mcp`（MCP 客户端）、`sessionSearch`（会话全文检索）。例如 tool-search 读 MCP 工具目录就是 `const mcp = ctx.get('mcp')`，读到 `undefined` 就当没接 MCP。

## 5. 事件

`ctx.on(事件名, 处理器)` 监听、`ctx.emit(事件名, 载荷)` 发布（插件可发布自定义事件，
命名建议 `dsc/plugin/<插件名>/<事件>` 避免冲突）：

| 事件 | 载荷 | 触发时机 |
|---|---|---|
| `dsc/changed` | — | 任何影响快照的状态变化后 |
| `dsc/notice` | `(text: string)` | 请求写一条 system 条目 |
| `dsc/session-open` | `({ session, filePath })` | 会话已切换（filePath=undefined 表示新建） |
| `dsc/exit` | — | 请求收尾；监听器须同步执行 |
| `dsc/open-picker` | — | 命令请求打开会话选择面板 |
| `dsc/skills-changed` | — | 技能清单或启停状态变化（桌面端技能中心据此重取） |
| `dsc/mode-changed` | `(mode: CollaborationMode)` | 协作模式换档（含启动时那一次）。审批卡据此在卡上写当前档位，不必反过来问模式服务 |
| `dsc/turn-end` | `(reason: 'completed' \| 'aborted' \| 'error')` | 一个回合结束。只有 `completed` 会触发会话目标的自动续跑 |
| `dsc/plan` | `(plan: PlanView)` | 计划交付卡的内容有变（写出来、被批准或被驳回） |

## 6. 示例

> **综合参考**：`examples/plugins/browser-control.js`——外部插件里最长的一份：单工具 `browser`
> 按 action 分发、自己起受控浏览器子进程、经 CDP 的 WebSocket 收发、截图以图像返回模型，
> 带私有状态与卸载清理。要写「拉外部进程 + 返回图像」这类插件先读它；同类参照还有
> `examples/plugins/computer-use.js`（PowerShell 驱动 Windows 桌面）。
>
> **界面扩展参考**：`examples/plugins/settings-demo.js`——一个插件同时注册设置分区
> （含 switch/select/text/button）、一个虚拟技能来源、一个私有市场源。

### A. 最小命令插件（消费条目树 config）

```js
export const inject = ['commands']
export function apply(ctx, config) {
  const greeting = (config && config.greeting) || '你好'
  const off = ctx.commands.register(
    { name: 'roll', args: '[面数]', description: '掷一个骰子' },
    ({ args, ui }) => {
      const faces = Number(args[0]) || 6
      ui.notice(`${greeting}：🎲 ${1 + Math.floor(Math.random() * faces)}`)
    },
  )
  return off
}
```

对应条目树：`{ "file": "my-plugin.js", "disabled": false, "config": { "greeting": "嗨" } }`。

### B. 工具插件（带 JSON Schema 与风险分级）

```js
export const inject = ['tools']
export function apply(ctx) {
  const off = ctx.tools.register({
    name: 'word_count',
    description: '统计一段文本的字符数与词数。需要统计长度时使用。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要统计的文本' } },
      required: ['text'],
    },
    risk: 'read',
    async run(args) {
      const text = String(args.text ?? '')
      return `chars=${text.length} words=${text.split(/\s+/).filter(Boolean).length}`
    },
  })
  return off
}
```

### C. 事件监听 + 状态维护 + 清理

```js
export const inject = ['transcript', 'session']
export function apply(ctx) {
  const openedAt = new Map()                       // 插件私有状态
  const offSession = ctx.on('dsc/session-open', ({ session, filePath }) => {
    openedAt.set(session.meta.id, { at: Date.now(), resumed: filePath !== undefined })
    ctx.transcript.system(`[my-plugin] 会话 ${session.meta.id.slice(0, 8)} 已就绪`)
  })
  const offNotice = ctx.on('dsc/notice', (text) => { /* 按需响应 */ })
  return () => {                                   // 停用/退出时必须清干净
    offSession()
    offNotice()
    openedAt.clear()
  }
}
```

### D. 界面扩展：设置分区 + 技能来源 + 私有市场源

完整可运行版本见 `examples/plugins/settings-demo.js`。骨架：

```js
export const name = '设置与技能示例'
export const description = '演示设置分区、技能来源、市场源三个扩展点'
export const apiVersion = 2
export const inject = ['settings', 'skills', 'transcript']

export function apply(ctx, config) {
  const state = { ...(config ?? {}), enabled: true, interval: '60', note: '' }

  const offSection = ctx.settings.registerSection({
    id: 'settings-demo-prefs',
    title: '示例插件',
    subtitle: '演示：控件声明由桌面端渲染，值存在插件里',
    order: 30,
    fields: () => [
      { type: 'switch', key: 'enabled', label: '启用', help: '关掉后技能来源不再贡献条目' },
      { type: 'select', key: 'interval', label: '轮询间隔', options: [{ value: '60', label: '1 分钟' }, { value: '300', label: '5 分钟' }] },
      { type: 'text', key: 'note', label: '备注', placeholder: '随便写点什么' },
      { type: 'button', action: 'reset', label: '恢复默认', style: 'ghost' },
    ],
    values: () => ({ enabled: state.enabled, interval: state.interval, note: state.note }),
    save: (key, value) => {
      if (key === 'interval' && !['60', '300'].includes(String(value))) return '间隔只能是 1 分钟或 5 分钟'
      state[key] = value
    },
    action: (name) => {
      Object.assign(state, { enabled: true, interval: '60', note: '' })
      ctx.emit('dsc/skills-changed')
      return '已恢复默认'
    },
  })

  const offProvider = ctx.skills.registerProvider({
    name: 'settings-demo',
    rank: 500,
    list: () => (state.enabled ? [{ name: 'demo-skill', description: '演示技能：说明写清做什么', whenToUse: '用户说「演示一下」时', source: 'settings-demo', rank: 500, modelInvocable: true, userInvocable: true, local: false }] : []),
    get: (name) => (name === 'demo-skill' ? { name, description: '演示技能', content: '# 演示技能\n\n正文由插件返回，会进入模型上下文。' } : undefined),
  })

  const offMarket = ctx.skills.registerMarket({
    name: 'settings-demo',
    browse: () => [{ name: 'demo-skill', description: '演示技能', source: 'settings-demo', installed: false }],
    install: (name) => `演示源不落地文件，直接用「技能」页的开关启用（${name}）`,
  })

  return () => { offSection(); offProvider(); offMarket() }
}
```

## 7. 交付前验证清单（AI 必须逐项执行）

1. **语法**：`node --check <文件>`（若报 "Cannot use import statement"，见 §8 首条）。
2. **安装**：把文件放进 `~/.dsc/plugins/`（或让用户走桌面端「+ 添加插件」）。
3. **加载**：重启宿主（桌面端插件页右上角电源按钮）。若加载失败，宿主会写
   system 条目「外部插件加载失败（…）：…」——修好再继续。
4. **功能**：命令插件 → 让用户输入 `/<命令名>`；工具插件 → 在对话里诱导模型调用并确认
   结果返回；事件插件 → 触发对应场景（如切换会话）。
5. **展示**：桌面端「插件」页确认 name/description 出现且开关可用。
   注册了设置分区 → 打开左栏「设置」，确认分区在左栏列出（带「插件」标记）、控件能读写、
   校验失败时错误就地显示；注册了技能来源 → 打开「技能」页，确认条目带来源标记且 `/技能名` 能调用。
6. **清理**：临时测试文件删除；若插件不应保留，移除文件并重启宿主。

## 8. 常见错误

| 症状 | 原因与修法 |
|---|---|
| 加载报 "Cannot use import statement outside a module" | 运行环境过旧、未启用 module 语法探测。在插件文件同目录放 `package.json` 内容 `{"type":"module"}`，或改写为 CommonJS（`exports.apply = ...`） |
| 插件没被加载 | 文件不在 `~/.dsc/plugins/`；后缀非 `.js`；条目树里 `disabled: true`；宿主未重启（目录里**新放入**的文件需重启或用 plugin_manager 工具 install） |
| 管理页显示 ⚠ 版本不兼容 | 插件 `apiVersion` 高于内核；升级 dsc，或把插件 `apiVersion` 降到当前内核版本 |
| `ctx.tools` 等是 undefined | 忘了在 `inject` 里声明该服务 |
| 控制台刷 `cannot get property "xxx" without inject` | 那是可选服务（插件关着时不存在）。别把它写进 `inject`，读它的人改用 `ctx.get('xxx')`；`ctx.xxx?.` 不算，属性访问就先抛了 |
| 桌面端看不到任何输出 | 用了 console.log；反馈必须走 `transcript.system` / `ui.notice` |
| 模型从不调用你的工具 | description 太弱或 parameters 不是合法 JSON Schema；name 要让模型望文生义 |
| 设置分区/技能来源没出现 | `inject` 里忘了声明 `settings` 或 `skills`；或分区 id 撞了内置的 `general/models/skills/about`（该分区被忽略，会话里有一行提示） |
| 设置分区里控件点不动、值不回填 | `values()` 返回的 key 和 `fields()` 里的 `key` 对不上；或 `values()` 返回了不能 JSON 序列化的对象（函数、Date） |
| 技能中心有条目但 `/名字` 调不动 | 条目 `userInvocable` 为 false，或名字撞了内置命令（new/resume/compact/model/help/exit/effort/plugins/skills） |
| 写入类工具绕过审批直接执行 | risk 误标为 `'read'`——写文件/执行命令必须是 `'write'`/`'exec'`（权限模式 readonly 下一律拒绝） |
| 插件被启用但行为还是旧的 | 文件变更后需重新停用→启用（或重启宿主）以触发重载 |
