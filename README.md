# dsc — 独立终端 AI harness

参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的核心组件设计、**全自研**的个人版终端 harness：自写 ReAct loop + 会话落盘 + 工具栈 + 审批，UI 用 ink（React for CLI）。**不依赖 dsh 宿主**，零 `@deepseek-ai/*` 依赖。

## 安装与运行

```sh
cd D:\dsc && pnpm install && pnpm build   # 首次
npm i -g file:D:\dsc                      # 一次，得到全局 dsc 命令
dsc                                       # 独立启动（新会话）
dsc --resume                              # 恢复上次会话
dsc --resume <会话jsonl路径>              # 恢复指定会话
```

## 交互

| 按键 / 命令 | 作用 |
| --- | --- |
| 直接输入 + Enter | 发送消息 |
| 输入 `/` 后 | 输入框上方弹出候选面板：命令阶段列命令，`/model ` 后列**可用模型**（↑↓ 选择、Tab 补全、Esc 关闭） |
| ↑ / ↓（空输入时） | 翻输入历史 |
| Ctrl+C | 一次：打断当前回合；2 秒内两次：退出 |
| Ctrl+T | 展开/折叠思考（reasoning） |
| `/new` | 新建会话 |
| `/resume` | 恢复历史会话（↑↓ 选择，Enter 确认，Esc 取消） |
| `/compact` | 手动压缩上下文（自动阈值：估算 tokens > 80% × 模型上下文窗口） |
| `/model [端点/]模型名` | 切换模型（下一次请求生效；候选来自配置里的全部 provider/model） |
| `/help` `/exit` | 帮助 / 退出 |

面板打开时按 Enter 会采用当前选中项；命令名还支持**唯一前缀自动展开**（输入 `/ne` 按 Enter 即执行 `/new`）。

工具授权卡出现时：`y` 允许一次，`n`（或 Esc）拒绝。

## 工具集（6 件）

`bash`（PowerShell）、`read`、`write`、`edit`（唯一匹配替换）、`glob`、`grep`。
读类工具自动放行；**写/执行类必须过审批卡**（无持久授权，对齐官方 ACP 桥的 one-shot 语义）。

## 配置

dsc 只读**自己的**配置文件，与 dsh 完全解耦：

- **`~/.dsc/config.yaml`**（主配置）：`default`（默认 provider/model）+ `providers`
  （`displayName` / `baseURL` / `apiKeyEnv` / `models` 列表，OpenAI 兼容协议）。
- **key 来源顺序**：`apiKeyEnv` 指向的环境变量 → `~/.dsc/credentials.yaml`
  → `~/.dsh/.credentials.yaml`（兼容回退）。代码绝不打印 key。
- **`~/.dsc/config.json`**（可选轻量覆盖）：`{ "provider": "...", "model": "...", "temperature": 0.7 }`。

**从 dsh 迁移**（首次启动自动执行一次，只读 dsh、不修改它）：

```sh
dsc config migrate           # 把 dsh settings.yaml 的 llm-pi-ai 段 + 默认模型搬到 ~/.dsc/config.yaml，
                             # 并把用到的 key 复制到 ~/.dsc/credentials.yaml
dsc config migrate --force   # 目标已存在时强制重迁
dsc config show              # 查看当前生效的端点/模型/key 来源（不打印 key）
```

- **会话落盘**：`~/.dsc/sessions/<cwd 压缩名>/<uuid>.jsonl`（append-only，重放恢复）；
  `~/.dsc/.last-session` 是 `--resume` 无参时的指针。

## 架构（对应 dsh 组件）

```
bin/dsc.js          启动器（零依赖）：--resume / config 子命令 → spawn node lib/boot.js
src/boot.ts         进程入口：迁移检查 → 读配置 → createKernel()（cordis 装配）→ 装 UI 插件
src/tools/config-cli.ts  dsc config migrate|show
src/core/           自研引擎（零 UI 依赖、零 dsh 依赖）
  config.ts         读 ~/.dsc/config.yaml + key 来源链（env→dsc 凭据→dsh 回退）
  migrate.ts        dsh settings.yaml/凭据库 → ~/.dsc 的一次性迁移（只读 dsh）
  llm.ts            OpenAI chat-completions 流式客户端（SSE/reasoning/tool_calls/usage/重试）
  session.ts        JSONL 会话（append-only + 重放恢复）        ↔ dsh-session-persistence
  loop.ts           MiniAgent ReAct 循环（turn → stream → 审批 → 工具 → 定稿） ↔ dsh-agent-loop
  tools/            bash/read/write/edit/glob/grep 注册表       ↔ dsh-tools
  approval.ts       写/执行类挂起等 y/n                          ↔ dsh-user-approval
  compact.ts        保头折尾摘要压缩                             ↔ dsh-compaction
src/adapter/        core 事件 → 快照投影（transcript 折叠 + core-runtime）
src/contract.ts     UI ⇄ 运行时 的中性契约（DscRuntime）
src/host/kernel.ts  内核装配顺序 + 三档插件清单（运行内核 / 官方可开关 / 自定义）
src/plugins/        每个服务一个 cordis 插件（含两个默认关的官方插件：子智能体团队、电脑操作）
src/app/            ink UI（App/ChatView/Composer/ToolCard/ApprovalCard/SessionPicker/StatusBar）
desktop/            Electron 桌面端：主进程 + 独立运行时子进程 + React renderer
scripts/composer-test.mjs  候选面板/输入行的确定性测试（node scripts/composer-test.mjs，16 项断言）
```

与 dsh 的取舍：复用其**设计**（turn 语义、事件流、审批分级、JSONL 落盘、压缩），不复用其**实现**（无沙箱、无检查点修复、无投影事件语义——个人版不需要）。子代理与桌面操作这两个能力做成了**默认关掉的官方插件**，在插件中心里手动打开。

## 已知限制

- 无沙箱：bash/写文件全权限，靠审批卡兜底，只在个人机器上用。
- 插件能加工具、命令、事件监听、设置分区和技能来源，但拿不到 DOM：界面扩展只接受可 JSON 序列化的控件声明。
- Windows 中文输入法可能拦截审批卡的 y/n 键（输入法切英文即可）。
- 跨进程的路由状态（当前模型/思考强度）不落盘，重启宿主后回到配置默认值。

## 插件开发

外部插件 = 单个 ESM `.js` 文件放进 `~/.dsc/plugins/`，可注册工具、命令、监听事件，
桌面端「插件」页可视化管理。完整 API 与开发规范见 **[docs/plugin-development.md](docs/plugin-development.md)**
（面向 AI 编程助手编写，人类可直接跳到示例部分）；可运行示例见 `examples/plugins/ping.js`。

## 文档

| 文档 | 讲什么 |
| --- | --- |
| [docs/development.md](docs/development.md) | 开发手册：运行时结构、三条启动链路、进程间协议、`~/.dsc` 数据面、扩展点清单、自检与打包、代码约定、排错与关键数值 |
| [docs/development-log.md](docs/development-log.md) | 开发记录：九个阶段各自引入了什么、决策台账、真 bug 台账、还欠什么 |
| [docs/plugin-development.md](docs/plugin-development.md) | 插件 API 与开发规范 |
