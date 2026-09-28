# dsc 插件开发说明书

> **本文档的读者是 AI 编程助手**。当用户要求「给 dsc 写一个插件」时，先通读本文，
> 再按文末模板产出代码，并执行「交付前验证清单」。人类读者可直接跳到示例部分。

---

## 1. 插件是什么

dsc 采用「万物皆插件」架构：内核（cordis Context）只提供一组**服务**，所有能力
——内置工具、斜杠命令、模型路由、会话存储——都是向服务容器注册的插件。外部插件
与内核**零源码耦合**：一个独立 `.js` 文件，放进约定目录即被加载，不改动 dsc 任何源码。

**能做的扩展**：注册工具、注册 `/` 命令、监听并发布事件、消费全部内核服务、
维护插件自身状态与清理逻辑、声明 API 版本与元数据。
**做不到的**（当前版本边界，不要向用户承诺）：
- 不能向桌面端 / TUI 注入自定义界面（反馈只能走会话条目与命令）；
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
export const apiVersion = 1              // 可选：声明兼容的内核 API 版本（版本管理见 §3.1）
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
- `config`：**原样透传给 `apply(ctx, config)` 第二参**——插件用它读自己的配置，
  不必再自建配置文件。
- **启停热生效**：切换开关 → 内核卸载（调用 disposer）或重新挂载插件，无需重启宿主；
  文件内容变更后重新启用也会加载新代码（按 mtime 破坏模块缓存）。

### 3.2 版本管理（自动回滚）

内核有 API 版本号（当前 `KERNEL_API_VERSION = 1`）。插件声明 `export const apiVersion = 1`：
- 等于内核版本 → 正常挂载；
- **高于**内核（插件要求更新的内核）→ 拒绝挂载、**自动写入停用**（回滚到可用状态），
  管理页显示原因；升级 dsc 后重新启用即可；
- 未声明 → 视为兼容（向后兼容旧插件）。

### 3.3 AI 参与插件管理

内核内置 `plugin_manager` 工具（risk='write'，AI 调用会先经权限模式/审批卡）：
`list`（清单）/ `enable` / `disable`（热启停）/ `install`（安装本地 .js 绝对路径并热挂载）。
用户也可以在会话里输入 `/plugins` 查看清单。给 AI 的指引：安装第三方插件前先 `list`
确认没有同名文件；`install` 只接受绝对路径；版本不兼容的插件会被自动停用并在清单里
标注原因，此时应向用户说明而不是反复重试。

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

ctx.agent.followup(text: string)        // 以用户身份投递一条消息（触发完整 Agent 回合）
ctx.agent.interrupt()                   // 取消当前回合

ctx.approval.decide(request, signal): Promise<'allow-once' | 'reject'>  // 编程式审批
ctx.compact.run(): Promise<void>        // 手动压缩上下文
```

### 4.6 ui —— DscRuntime（与桌面端/TUI 同一接口）

`subscribe / getSnapshot / submit / interrupt / openSession / compact / setModel /
setEffort / refreshSessions / listModels / listPlugins / setPluginEnabled /
runCommand / answerApproval / exit / dispose`。插件里通常用不到它（优先用
`agent` / `transcript`）；`exit()` 会结束宿主进程，务必只用于用户显式退出。

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

## 6. 示例

> **综合参考**：`examples/plugins/memory.js`——Hermes 风格记忆插件，覆盖了工具注册（4 个）、
> 命令注册、快照监听（prefetch 注入 + 回合结束自动沉淀）、session.messages 滚动注入、
> `llm.route()` 直连 chat/completions、文件存储与 Markdown 导出。写复杂插件前先读它。

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

## 7. 交付前验证清单（AI 必须逐项执行）

1. **语法**：`node --check <文件>`（若报 "Cannot use import statement"，见 §8 首条）。
2. **安装**：把文件放进 `~/.dsc/plugins/`（或让用户走桌面端「+ 添加插件」）。
3. **加载**：重启宿主（桌面端插件页右上角电源按钮）。若加载失败，宿主会写
   system 条目「外部插件加载失败（…）：…」——修好再继续。
4. **功能**：命令插件 → 让用户输入 `/<命令名>`；工具插件 → 在对话里诱导模型调用并确认
   结果返回；事件插件 → 触发对应场景（如切换会话）。
5. **展示**：桌面端「插件」页确认 name/description 出现且开关可用。
6. **清理**：临时测试文件删除；若插件不应保留，移除文件并重启宿主。

## 8. 常见错误

| 症状 | 原因与修法 |
|---|---|
| 加载报 "Cannot use import statement outside a module" | 运行环境过旧、未启用 module 语法探测。在插件文件同目录放 `package.json` 内容 `{"type":"module"}`，或改写为 CommonJS（`exports.apply = ...`） |
| 插件没被加载 | 文件不在 `~/.dsc/plugins/`；后缀非 `.js`；条目树里 `disabled: true`；宿主未重启（目录里**新放入**的文件需重启或用 plugin_manager 工具 install） |
| 管理页显示 ⚠ 版本不兼容 | 插件 `apiVersion` 高于内核；升级 dsc，或把插件 `apiVersion` 降到当前内核版本 |
| `ctx.tools` 等是 undefined | 忘了在 `inject` 里声明该服务 |
| 桌面端看不到任何输出 | 用了 console.log；反馈必须走 `transcript.system` / `ui.notice` |
| 模型从不调用你的工具 | description 太弱或 parameters 不是合法 JSON Schema；name 要让模型望文生义 |
| 写入类工具绕过审批直接执行 | risk 误标为 `'read'`——写文件/执行命令必须是 `'write'`/`'exec'`（权限模式 readonly 下一律拒绝） |
| 插件被启用但行为还是旧的 | 文件变更后需重新停用→启用（或重启宿主）以触发重载 |
