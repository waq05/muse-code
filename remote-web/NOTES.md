# remote-web —— 遥控端界面（批 B）

手机浏览器优先的 Muse Code 遥控界面：会话列表、聊天直播、审批/计划/提问卡、打断。
构建产物由宿主插件 `src/plugins/remote.ts`（批 A）从 `lib/remote/assets` 静态伺服。

## 目录结构

```
remote-web/
├── index.html            # 挂载页：viewport-fit=cover、safe-area、manifest/图标、跟随系统的 theme-color
├── vite.config.ts        # root 相对本文件；outDir 固定 ../lib/remote/assets（emptyOutDir）；publicDir + sw 拷贝
├── tsconfig.json         # 应用代码（src）
├── tsconfig.node.json    # 构建脚本（vite.config.ts）
├── package.json          # 独立单包项目，自带 pnpm-lock.yaml，不影响根 lock
├── selfcheck.mjs         # 自检：假 socket + 假 fetch + 假 localStorage，不起浏览器不起宿主
├── NOTES.md              # 本文件
├── tools/make-icons.py   # 占位 PWA 图标的生成脚本（产物落 public/，不参与构建）
├── public/               # 原样拷进产物根（vite publicDir）
│   ├── manifest.json     # PWA manifest（name「Muse Code」、standalone、深色主题色）
│   ├── icon-192.png      # 占位图标（TODO：换正式图标）
│   └── icon-512.png
└── src/
    ├── main.tsx          # createRoot 挂 App + 注册 service worker（只在 https/localhost）
    ├── sw.js             # service worker 源文件：push → showNotification，notificationclick → 聚焦/打开页面
    ├── App.tsx           # 两层壳：没凭据→登录页；有凭据→遥控外壳（聊天 ⇄ 会话列表）
    ├── styles.css        # 全部样式：深浅两套令牌 + 各组件
    ├── lib/
    │   ├── types.ts      # 宿主 src/contract.ts 的最小契约子集（快照里的条目/卡片/会话）
    │   ├── protocol.ts   # 归一化：把 WS 上的 unknown 洗成组件能直接读的形状（缺字段不炸）
    │   ├── reduce.ts     # v3 的帧归并：全量帧重置 / 增量帧按 id 合并（纯函数）
    │   ├── api.ts        # /api/pair、/api/ticket、/api/upload、/api/push-key、推送登记与注销
    │   ├── client.ts     # WebSocket 客户端：取票据→连接→帧归并→invoke→指数退避重连+补帧
    │   ├── wire.ts       # 上行 invoke 的参数编码（全项目唯一可改的一处）
    │   ├── push.ts       # 推送：公钥解码、环境判定（纯函数）、订阅/退订、SW 注册
    │   ├── attachments.ts# 附件：图片缩放/压缩、附件行拼装、体积预算（纯逻辑 + 可注入 canvas）
    │   ├── storage.ts    # localStorage：设备凭据 + 最大帧序号 + 推送端点（不可用则降级成内存态）
    │   ├── hooks.ts      # useClientState / useTicker / useAction
    │   └── format.ts     # 时间、路径尾段、token 数、工具参数摘要
    ├── pages/
    │   ├── LoginPage.tsx     # 8 位配对码 + 设备名（配对成功后清零帧序号）
    │   ├── SessionsPage.tsx  # 按 cwd 分组、当前会话优先、归档区只读、设备区（推送开关 / 退出）
    │   └── ChatPage.tsx      # 对话流 + 用量小字 + 待办卡 + 发送框（带附件）
    └── components/
        ├── TopBar.tsx        # 阶梯式导航条
        ├── ConnBar.tsx       # 断开细条 + 倒计时 + 手动重试
        ├── ChatStream.tsx    # 唯一可滚区域、>500 条截断、贴底与「回到最新」
        ├── EntryView.tsx     # 按 kind 分派：user/text/thinking/tool/plan/system
        ├── ToolCard.tsx      # 工具卡：状态点 + 折叠细览
        ├── ApprovalCard.tsx  # 审批/计划/提问三合一卡
        ├── DecisionRow.tsx   # 四个决定按钮（同意一次/本会话/永久/拒绝）
        ├── Composer.tsx      # 发送框 + 📎 附件（图片压缩 / 文件上传）+ chips
        └── PushToggle.tsx    # 推送开关（宿主没开推送时整个不显示）
```

## 构建

```powershell
# 在 D:\dsc\remote-web 下
C:\Users\waq\node_global\pnpm.cmd install
C:\Users\waq\node_global\pnpm.cmd build       # tsc 双配置类型检查 + vite build
C:\Users\waq\node_global\pnpm.cmd selfcheck   # 界面自检（89 条断言，不需要浏览器）
```

产物（`D:\dsc\lib\remote\assets`，`lib/` 已在 .gitignore 里）：

```
index.html              # 引用 ./app-<hash>.js 与 ./style-<hash>.css（相对路径）+ manifest / apple-touch-icon
app-<hash>.js
style-<hash>.css
sw.js                   # service worker（源文件 src/sw.js，构建时原样 emit，不带 hash）
manifest.json           # 源在 public/，vite 的 publicDir 原样拷贝
icon-192.png / icon-512.png
```

`sw.js` 走 `vite.config.ts` 里那个十行的 `copyServiceWorker` 插件（`this.emitFile`）而不是 public 目录：
service worker 的注册路径与作用域都写死在 `./sw.js` 上，不能带内容哈希，源码放 `src/` 下与它服务的界面代码挨着更好找。
manifest 与图标不需要打包，走 publicDir 最省事。产物根目录少了这层 `assets/` 子目录，插件把整个目录挂在 `/` 下就够。

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

## 协议 v3 的客户端实现（增量帧 / 补帧 / 上传 / 推送）

字段名与含义按契约照抄，一个字没改。客户端这边的落点：

1. **帧归并是纯函数**（`src/lib/reduce.ts` 的 `applyFrame`）：全量帧（`full:true` 或 `type:'snapshot'`）
   整份重置；增量帧按 `{...state, ...meta, liveEntries}` 合并，`entries` 用 id 做 Map 合并
   （`removedIds` 删、`updated` 替换、`added` 追加），最后统一按 id 升序排——宿主发号递增，
   所以 id 序就是时间序，重排比维护插入序少一处状态。
   两个宽松口子写在这里：`updated` 里本地没有的 id 照样收下（补帧从窗口中间开始时是常态）、
   `added` 撞上已有 id 按后者覆盖（补帧与实时帧重叠时不让同一个 id 画两行）。
   `meta` 的合并按「字段出现过才覆盖」而不是无条件覆盖——契约里 meta 是全的，
   但宿主漏带 `sessions` 时不该把会话列表清空。这是比契约宽一档，不是改契约。
2. **seq 单调**：同一条连接里只增，所以「不大于本地 lastSeq」的帧一律丢。
   两个例外都在 `client.ts` 的 `handleFrame` 里：
   - 重连后第一帧是**全量** → 无条件收下（宿主说窗口不够、整份重建；顺手兼容宿主重启后 seq 从头开始）；
   - 重连后第一帧是**增量**却比本地位点旧 → 本地位点不可信，清位点重连一次让宿主发全量
     （`recoverFromStaleSeq`，最多自愈两次，免得和宿主互相踢）。
3. **lastSeq 落盘**：`storage.ts` 的 `dsc.remote.lastSeq`，连接 URL 上带 `&lastSeq=`（`>=0` 才带）。
   只在「一帧真的应用成功」之后写，写早了下次重连会漏帧；配对成功（`LoginPage`）清零。
4. **上传**：`POST /api/upload?filename=<encodeURIComponent(名字)>` + `Authorization: Bearer`，
   体就是原始字节（`fetch` 直接吃 File）。成败以响应体的 `ok` 为准——宿主可能 HTTP 200 却回
   `{ok:false, error}`。走的 HTTP 不走 WS：几 MB 的字节塞进 WS 帧会把实时流一起卡住。
5. **推送**：公钥来自 hello 的 `pushPublicKey`（null = 宿主开关关着 → 按钮整个不显示）；
   `GET /api/push-key` 在 `api.ts` 里留了兜底实现（自检覆盖），界面暂时不需要它。
   点击流程 = `pushBlockReason` 判环境 → `Notification.requestPermission` →
   `serviceWorker.ready`（自己掐 10 秒上限，注册失败时 `ready` 永远不落地）→
   `pushManager.subscribe({userVisibleOnly:true, applicationServerKey})` → POST `/api/push-subscribe`；
   端点记在 `dsc.remote.pushEndpoint`，按钮据此显示成「关闭推送」，点了就 POST `/api/push-unsubscribe`
   并把本机浏览器那一侧也退掉。**环境判定是纯函数**（`pushBlockReason`），文案四种：
   iOS 没加到主屏幕、不是 https/localhost、浏览器不支持通知或 SW、权限被拒过。
6. **service worker**（`src/sw.js`）：只处理 `push`（`showNotification`，title/body/url 从
   `{title, body, url}` 里取，缺了就用默认值）与 `notificationclick`（先聚焦同源窗口，没有才
   `clients.openWindow`）。**故意不写 fetch 处理器**：产物文件名带内容哈希、由宿主按目录伺服，
   在这里缓存只会让界面版本和宿主对不上。注册放在 `main.tsx`，`registerServiceWorker()` 里
   收口成「仅 https 或 localhost（`isSecureContext`）」。

## 附件（图片压缩 / 文件上传）

- 图片：canvas 压缩，长边 >1568px 等比缩到 1568（只缩不放），导出 JPEG 0.85；
  `image/png` 保留 PNG（保住透明）；压缩后仍 >4MB 就拒掉那一个并在 chip 上说明原因；
  结果当 data URL 进 `images[]`，随 `submit(text, images)` 一起发。
  解码用 `<img>` 而不是 `createImageBitmap`：iOS Safari 上 `<img>` 会照 EXIF 把方向摆正，
  `drawImage` 用的就是摆正后的尺寸，省掉一处「照片躺着」的坑。
- 非图片：`POST /api/upload` 拿到 `path`，消息文本变成「正文 + 空行 + 一行一个 `[附件] <path>`」
  （只有附件没有正文时就只发附件行）。上传失败把原因挂在那个 chip 上，不影响其它附件。
- 体积：单张图片 4MB（压缩后）、一次消息附件总量 8MB。**图片按压缩后算、文件按原始大小算**——
  不然一张 5MB 的原图会被「8MB 总量」在还没压缩之前就误杀。超出的文件不加入，并在输入框上方列出名字。
- chips 显示文件名 + 大小（图片显示「原始 → 压缩后」），处理中带转圈；处理期间发送按钮变
  「上传中…」且不可点（避免把半截附件发出去）。
  已上传的文件点 × 只是不再引用它：协议里没有删除这条路，宿主侧那份会留在磁盘上。

## 自检（`pnpm selfcheck`，89 条断言）

`selfcheck.mjs` 不起浏览器、不起宿主：用 `registerHooks` 把源码里的 `./x.js` 说明符解析到
`./x.ts`（Node 24 自带类型擦除，所以不用先编译），再装假 `window` / `localStorage` /
`WebSocket` / `fetch`，然后分六段跑：

1. **归并**：全量帧、增量的 added/updated/removedIds、`liveEntries` 全量替换、
   meta 缺字段保留旧值、added 乱序后按 id 重排、三条 delta 逐帧补入、全量帧整份重置、
   认不出的帧返回 null、v2 的 `type:'snapshot'`（没有 full 字段）照样当全量。
2. **帧序号**：lastSeq 读写、负数与坏值不认、清零；推送端点的存与清。
3. **客户端（假 socket）**：取票据 → hello（protocolVersion / pushPublicKey）→ 全量帧 →
   增量帧 → 更旧的帧丢弃 → lastSeq 落盘 → invoke 参数编码（零参数不带 args）与结果落地 →
   `submit(text, images)` → interrupt 的 stopping 复位 → 上传的 URL/头/体与返回路径 →
   推送登记与注销的报文 → 断线退避与 `retryNow` 重新取票（新连接带 `lastSeq`）→
   宿主重启后 seq 回退（全量收下 / 增量则清位点重连）→ 票据 401 触发退回登录页。
4. **Web Push**：`urlBase64ToUint8Array` 与 `Buffer.from(..., 'base64')` 逐字节交叉核对
   （含 URL-safe 字符与缺补位）、`AQAB → 01 00 01`；订阅流程里 `userVisibleOnly === true`、
   `applicationServerKey` 是解码后的字节；四种环境判定文案。
5. **附件**：附件行拼装（空行、多行、只有附件）、体积格式化、base64 字节估算、缩放尺寸
   （含竖图与 0 尺寸）、PNG/JPEG 选择、假 canvas 下的压缩路径与「压完仍超 4MB 抛错」。
6. **PWA 产物**：manifest 的关键字段与两档图标存在、`sw.js` 里 push 与 notificationclick 两条路都在。

上一轮这套假 socket 的自检逮到过一个真 bug 并已修：`retryNow()` / `stop()` 原先「先 detach 再 close」，
置空之后又去调 `.close()`，在「连接还开着时手动重试」这条路上会抛空指针
（现在统一走 `closeSocket()`：先置空再 close，顺带保证不会重复排重连）。

## 为什么不做（省下来的东西，逐条给理由）

- **虚拟化**：一次几百条在手机上排版仍然流畅；虚拟化会打断长按选择、页内查找与流式滚动跟随。
- **逐字 delta**：宿主推的是整条条目替换（同一 `id` 内容变化自动更新），做逐字动画只会和它打架。
  （协议 v3 的「增量帧」是条目级的，不是字符级的，这条不变。）
- **轨迹页 / 设置编辑**：批 A 开放的 invoke 里没有这两类方法，界面不做点不动的按钮。
- **附件的删除与进度条**：协议里没有删除这条路，所以移除 chip 只是不再引用（宿主侧那份留着）；
  上传进度只有「转圈」没有百分比——`fetch` 没有上传进度事件，要它就得换 XHR，不值当。
- **错误页文案精简**：所有失败都落到「一行红字 + 手动重试」，不做分类型引导页。
- **Markdown 渲染**：会引入一个解析器依赖与一套样式；纯文本 + `white-space: pre-wrap` 先把
  消息看全，需要再加。
- **桌面端设置分区样式微调**：批 A 的插件设置分区还没落地，按「不确定就先不动」处理，
  整个 `desktop/` 一个字没碰。

## 诚实边界（集成与真机时先看）

1. **http + IP 的页面上，service worker 与推送都用不了。** 浏览器只在 https 或 localhost 下允许
   注册 SW，遥控端现在由宿主以明文 http 伺服（手机是用 `http://<IP>:17321` 打开的），
   所以真机要推送必须另有 https 通道（反代 / 证书）。界面已经如实说明（`pushBlockReason`），
   不会给一个点了没反应的按钮。
2. **`sw.js` 只做推送、不做离线**：见上文第 6 条，这是刻意的取舍。
3. **图标是占位图**（`public/icon-192.png` / `icon-512.png`，用 `tools/make-icons.py` 生成）：
   与现有 favicon 的 `>_` 形状一致但不是正式资产，换成正式图标时保持两个尺寸即可。
4. **8MB / 4MB 是界面侧的上限**，宿主侧如果另有上限，界面会在上传那一步拿到它的错误文案并挂在 chip 上。
5. **lastSeq 每收到一帧就写一次 localStorage**（十来个字节的字符串）。写失败（隐私模式）只是
   下次重连不带位点、退回全量，不影响使用。
6. **未做真机验证**：本轮改动只跑了类型检查、构建与上面的自检；iOS Safari 的实际通知权限、
   加到主屏幕后的独立窗口、以及大图在真机上的压缩耗时都还没有实测证据。

