# remote-web —— 遥控端界面（批 B）

手机浏览器优先的 Muse Code 遥控界面：会话列表、聊天直播、审批/计划/提问卡、打断。
构建产物由宿主插件 `src/plugins/remote.ts`（批 A）从 `lib/remote/assets` 静态伺服。

## 目录结构

```
remote-web/
├── index.html            # 挂载页：viewport-fit=cover、safe-area、跟随系统的 theme-color
├── vite.config.ts        # root 相对本文件；outDir 固定 ../lib/remote/assets（emptyOutDir）
├── tsconfig.json         # 应用代码（src）
├── tsconfig.node.json    # 构建脚本（vite.config.ts）
├── package.json          # 独立单包项目，自带 pnpm-lock.yaml，不影响根 lock
├── NOTES.md              # 本文件
└── src/
    ├── main.tsx          # createRoot 挂 App
    ├── App.tsx           # 两层壳：没凭据→登录页；有凭据→遥控外壳（聊天 ⇄ 会话列表）
    ├── styles.css        # 全部样式：深浅两套令牌 + 各组件
    ├── lib/
    │   ├── types.ts      # 宿主 src/contract.ts 的最小契约子集（快照里的条目/卡片/会话）
    │   ├── protocol.ts   # 归一化：把 WS 上的 unknown 洗成组件能直接读的形状（缺字段不炸）
    │   ├── api.ts        # POST /api/pair、POST /api/ticket
    │   ├── client.ts     # WebSocket 客户端：取票据→连接→快照→invoke→指数退避重连
    │   ├── wire.ts       # 上行 invoke 的参数编码（全项目唯一可改的一处）
    │   ├── storage.ts    # localStorage 里的设备凭据（配对失败也能降级成内存态）
    │   ├── hooks.ts      # useClientState / useTicker / useAction
    │   └── format.ts     # 时间、路径尾段、token 数、工具参数摘要
    ├── pages/
    │   ├── LoginPage.tsx     # 8 位配对码 + 设备名
    │   ├── SessionsPage.tsx  # 按 cwd 分组、当前会话优先、归档区只读
    │   └── ChatPage.tsx      # 对话流 + 用量小字 + 待办卡 + 发送框
    └── components/
        ├── TopBar.tsx        # 阶梯式导航条
        ├── ConnBar.tsx       # 断开细条 + 倒计时 + 手动重试
        ├── ChatStream.tsx    # 唯一可滚区域、>500 条截断、贴底与「回到最新」
        ├── EntryView.tsx     # 按 kind 分派：user/text/thinking/tool/plan/system
        ├── ToolCard.tsx      # 工具卡：状态点 + 折叠细览
        ├── ApprovalCard.tsx  # 审批/计划/提问三合一卡
        └── DecisionRow.tsx   # 四个决定按钮（同意一次/本会话/永久/拒绝）
```

## 构建

```powershell
# 在 D:\dsc\remote-web 下
C:\Users\waq\node_global\pnpm.cmd install
C:\Users\waq\node_global\pnpm.cmd build     # tsc 双配置类型检查 + vite build
```

产物（`D:\dsc\lib\remote\assets`，`lib/` 已在 .gitignore 里）：

```
index.html              # 引用 ./app-<hash>.js 与 ./style-<hash>.css（相对路径）
app-<hash>.js
style-<hash>.css
```

资产不走 `assets/` 子目录（`build.assetsDir: ''`）：宿主按目录伺服，少一层就少一处路径对不上的可能。
也就是说 `index.html` 引用的是 `./app-<hash>.js` 与 `./style-<hash>.css`，**插件只要把
`lib/remote/assets` 整个目录挂在 `/` 下就够了，不需要额外拼 `/assets/` 前缀**。
如果批 A 的实现固定要把资产映射到 `/assets/*`，把 `vite.config.ts` 里的 `assetsDir` 改回
`'assets'` 再 build 一次即可（一行改动）。

本地联调：`pnpm dev` 起 vite（127.0.0.1:5273），`/api` 与 `/ws` 代理到 `http://127.0.0.1:17321`；
换端口用 `DSC_REMOTE_ORIGIN`。产物挂到别的域名下时用 `VITE_REMOTE_ORIGIN` 指定宿主源。

## 与宿主的契约（重要假设，集成期先看这一节）

1. **上行 `args` 是实参数组，`id` 是数字。** 这不是猜的，是照宿主既有协议核过的：
   `src/plugins/host-stdio.ts` 里消息类型写的是 `{type:'invoke'; id: number; method: string; args?: unknown[]}`，
   收到后 `Reflect.apply(runtime[method], runtime, message.args ?? [])` 按形参表展开；
   `desktop/src/renderer/bridge.ts` 同样是 `invoke(method, args?: unknown[])`、一个参数一个位置地发。
   所以界面发 `submit` → `args:["文本"]`，`openSession` → `args:["会话路径"]`，
   零参数方法（`refreshSessions`）不带 `args` 字段。
   万一批 A 的桥接层改成按单个值解，**只需要改 `src/lib/wire.ts` 里的 `encodeArgs` 一行**；
   作为集成期缓冲，读取类方法（`READ_ONLY_METHODS`，无副作用）收到「参数不对」这类错误时
   会自动换一种编码重试一次，而 `submit`/审批这类有副作用的调用绝不重试，免得发两遍。
   审批答案发两个实参：`answerApproval` → `['allow-once', 'web']`，第二个是审计来源。
2. **快照字段一律按「可能缺」处理**（`src/lib/protocol.ts`）：认不出的 `kind` 丢掉、缺的字段填
   `null`/空数组、`surfaces` 整个缺失也不崩。`seq` 单调，迟到的旧快照直接丢弃。
3. **直播尾两种骨架都认**：`liveEntries` 单独给（批 A 的契约），或已经并进 `entries`
   （宿主 core 的 `RuntimeSnapshot`）。归一化后仍分成两个数组，界面按 `entries ++ liveEntries` 渲染。
4. **`surfaces` 里任务清单的键名两个都认**：契约写的是 `pendingTodos`，宿主 core 用的是 `todos`，
   谁在就用谁（`protocol.ts` 的 `normalizeSurfaces`）。
5. **轮次是否在跑**：优先用 `status.turnState`（唯一权威口径）；没有该字段时退回证据法
   （最后一张工具卡还在 running / 最后一条是没答完的用户消息 / 刚投递过 submit 的三分钟窗口）。
   投递 submit 之后宿主还没推新快照时，同一份旧快照的 `idle` 不会把「在跑」判掉。
6. **提问卡比批 A 多给了两条路**：题目自带选项（点一下把选项文案当答案发）与自由输入，都走
   `answerQuestion`；下面仍然保留同款四个决定（按审批口径回答）。四个决定对提问语义上不总成立，
   所以并列给出，而不是把选项藏掉。
7. **归档区是只读的**：开放的方法里只有 `listArchivedSessions` / `archiveSessions`，没有恢复与
   永久删除，所以界面只列出来并直说「去桌面端做」。

## 验收时跑过的自检（脚本已删，结论留在这里）

- `pnpm build`：两个 tsconfig 都无 TS 报错，vite 产出带 hash 的三个文件。
- 归一化层：20 条断言（完整快照 / 空对象 / 非对象 / 认不出的 kind / 旧骨架 / 归档页），全过。
- 客户端：用一个假 WebSocket + 假 fetch 跑了两轮，共 21 条断言，覆盖「取票据 → 连接 →
  hello/快照 → seq 单调丢弃旧快照 → invoke 参数编码与换编码重试 → submit 后的在跑判定 →
  interrupt 的 stopping 复位 → 断线自动重连并重新取票据 → 连接未就绪时调用被拒 →
  宿主 error 原样抛出 → 票据 401 触发退回登录页」，全过。
  这一轮复检抓到一个真 bug 并已修：`retryNow()` / `stop()` 原先「先 detach 再 close」，
  置空之后又去调 `.close()`，在「连接还开着时手动重试」这条路上会抛空指针
  （现在统一走 `closeSocket()`：先置空再 close，顺带保证不会重复排重连）。

## 为什么不做（省下来的东西，逐条给理由）

- **虚拟化**：一次几百条在手机上排版仍然流畅；虚拟化会打断长按选择、页内查找与流式滚动跟随。
- **逐字 delta**：宿主推的是整条条目替换（同一 `id` 内容变化自动更新），做逐字动画只会和它打架。
- **轨迹页 / 设置编辑**：批 A 开放的 invoke 里没有这两类方法，界面不做点不动的按钮。
- **头像上传 / 文件传输**：`submit` 只约定文本（图片是可选 data URL），传文件没有通道。
- **错误页文案精简**：所有失败都落到「一行红字 + 手动重试」，不做分类型引导页。
- **Markdown 渲染**：会引入一个解析器依赖与一套样式；纯文本 + `white-space: pre-wrap` 先把
  消息看全，需要再加。
- **桌面端设置分区样式微调**：批 A 的插件设置分区还没落地，按「不确定就先不动」处理，
  整个 `desktop/` 一个字没碰。
