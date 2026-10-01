# 在外面连回家里的 Muse Code：隧道访问指南

> **前提**：电脑上的**远程操控插件（remote）已经启用**，并且本机 `http://127.0.0.1:17321`
> 能打开遥控页、能在设置里生成配对码。本文只讲「怎么让手机从外网走到这个端口」，
> 不讲插件怎么开。
>
> 本文里的端口一律写 17321（插件的默认值）。如果你改过端口，把命令里的 17321 全部换成实际值。

---

## 0. 出发前的三件事

1. **端口只监听 127.0.0.1，别改成 0.0.0.0。**
   遥控插件的设计前提是「只有本机能连」，外网入口交给隧道进程。直接把端口开到公网，
   等于把一个能执行命令、读工作区文件的接口摆到扫描器面前。
2. **配对码在电脑上生成，只在自己手上输入。** 配对码 + 隧道地址 = 一台全权客户端，
   别发到聊天窗口、别截图分享。
3. **三条路选一条**：临时用选 cloudflared 快速隧道；长期用选具名隧道；
   已经有公网服务器就选 SSH 反向转发。

| 方案 | 需要什么 | 地址是否固定 | 有没有 TLS | 配置量 |
| --- | --- | --- | --- | --- |
| cloudflared 快速隧道 | 装 cloudflared | 每次重启都变 | 有（Cloudflare 边缘终止） | 一条命令 |
| cloudflared 具名隧道 | Cloudflare 账号 + 一个域名 | 固定 | 有，还能叠加 Access 登录 | 五步 |
| SSH 反向转发 | 一台有公网 IP 的服务器 | 看服务器地址 | **默认没有** | 一条命令 + sshd 配置 |

---

## 1. cloudflared 快速隧道（推荐先试这个）

临时域名、不用注册账号、一条命令，适合「今天出门半天，路上看一眼进度」。

### 1.1 安装 cloudflared

Windows（PowerShell，任选一种）：

```powershell
winget install --id Cloudflare.cloudflared
# 或者直接下 exe：https://github.com/cloudflare/cloudflared/releases/latest
# 把 cloudflared-windows-amd64.exe 改名 cloudflared.exe 放进 PATH 里的目录
```

macOS：`brew install cloudflared`；Linux：`apt install cloudflared` 或下 `.deb`。

### 1.2 起隧道

```powershell
cloudflared tunnel --url http://127.0.0.1:17321
```

终端会打出这样一段（域名是随机的，每次都不一样）：

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://brave-river-1234.trycloudflare.com                                                 |
+--------------------------------------------------------------------------------------------+
```

**这个进程要一直开着**：关掉窗口或按 Ctrl+C，隧道立刻断，手机上的界面会显示
「连接断开，正在重连…」。

### 1.3 手机上打开

1. 手机浏览器访问上面那个 `https://….trycloudflare.com`；
2. 填电脑上生成的 8 位配对码，给设备起个名（比如「我的手机」），点连接；
3. 之后凭据存在手机浏览器里，再打开这个地址直接进界面。

聊天是走 WebSocket 的，快速隧道会自动复用这条 HTTPS 连接，不用额外配置。

### 1.4 优缺点

**优点**

- 不用注册、不用域名、不用改任何配置；
- 自带 HTTPS 证书，手机浏览器不会拦；
- WebSocket 直接可用。

**缺点**

- **地址每次重启都变**，手机上要重新打开新地址；
- 没有可用性承诺（Cloudflare 明确说快速隧道不用于生产），偶发连不上；
- TLS 在 Cloudflare 边缘终止：**Cloudflare 侧能看到明文内容**，介意就不要用；
- 公司/校园网可能封 UDP 7844（QUIC）。连不上时加 `--protocol http2` 强制走 HTTP/2：
  ```powershell
  cloudflared tunnel --url http://127.0.0.1:17321 --protocol http2
  ```

---

## 2. 具名隧道（要用得久就选它）

需要一个 **Cloudflare 账号**和一个**托管在 Cloudflare 的域名**。好处是地址固定，
而且可以叠加 Cloudflare Access（连之前先登录一道）。

```powershell
# 1) 浏览器里登录并授权（会让你选一个域名，多选一即可）
cloudflared tunnel login

# 2) 建一条隧道，记下输出的 UUID
cloudflared tunnel create dsc-remote
cloudflared tunnel list

# 3) 把域名指向这条隧道（remote.example.com 换成你自己的子域）
cloudflared tunnel route dns dsc-remote remote.example.com
```

编辑 `C:\Users\<你的用户名>\.cloudflared\config.yml`：

```yaml
tunnel: dsc-remote                     # 也可以直接写 UUID
credentials-file: C:\Users\<你的用户名>\.cloudflared\<UUID>.json
ingress:
  - hostname: remote.example.com
    service: http://127.0.0.1:17321    # 转发给本机的遥控插件
  - service: http_status:404           # 兜底规则，必须放最后
```

```powershell
# 4) 前台跑起来试试
cloudflared tunnel run dsc-remote

# 5) 验证没问题后装成系统服务（Windows 需要管理员 PowerShell），开机自启
cloudflared service install
```

手机访问 `https://remote.example.com`，配对流程和快速隧道完全一样。

### 2.1 加一层 Cloudflare Access（强烈建议）

Zero Trust 控制台 → Access → Applications → Add an application → Self-hosted，
把 `remote.example.com` 加进去，策略里要求邮箱一次性验证码（或 Google/GitHub 登录）。
这样「不知道你邮箱的人也拿不到页面」，就算配对码泄露还有一道墙。

注意：Access 会给浏览器下发一个 cookie，之后 WebSocket 升级同样带着它；
某些第三方客户端不认这条登录流程，那就退回用 service token。

**优点**：地址固定、可长期跑、能叠加 Access 与审计。
**缺点**：需要账号与域名，配置步骤多；忘了续费域名就断。

---

## 3. SSH 反向转发（有公网服务器就用它）

原理：从家里的电脑主动连服务器，把服务器的 17321 端口反向指回本机的 17321。

```powershell
ssh -N -R 17321:127.0.0.1:17321 user@your-server
```

`-N` 表示不执行远程命令，只做转发。**默认只绑到服务器的 127.0.0.1**，
也就是说服务器之外的机器访问不到——这通常正是你想要的。

想让外部（手机）也能访问，需要服务器 `/etc/ssh/sshd_config` 里设
`GatewayPorts yes` 或 `GatewayPorts clientspecified`，重启 sshd，然后：

```powershell
ssh -N -R 0.0.0.0:17321:127.0.0.1:17321 user@your-server
```

保活（网络切换、NAT 超时都会悄悄掐断空闲连接）：

```powershell
ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 17321:127.0.0.1:17321 user@your-server
# 或者用 autossh 自动重连
```

### 3.1 手机上怎么连（两种）

- **直连（`0.0.0.0` 绑定）**：手机浏览器开 `http://your-server:17321`。
  **这是明文 HTTP**：配对码和 token 会以明文经过中间网络，公共 Wi-Fi 上等于公开。
- **更安全的一种（推荐）**：服务器不对外开端口，手机上用 Termius / JuiceSSH 这类
  SSH 客户端建一条本地转发 `-L 17321:127.0.0.1:17321 user@your-server`，
  然后手机浏览器访问 `http://127.0.0.1:17321`。整条链路都在 SSH 里，
  和本机访问没有区别，只是要手动开 SSH 客户端。

如果一定要长期对外，建议在服务器上用 nginx/caddy 反代 17321 并配上证书（HTTPS），
别把明文端口裸露在外面。

**优点**：不经过任何第三方，服务器自己的日志与防火墙说了算。
**缺点**：需要一台公网服务器；要改服务端 sshd 配置（`GatewayPorts` 开大了有风险）；
默认没有 TLS；服务器重启或网络抖动后要重连（用服务或 autossh 兜住）。

---

## 4. 公网暴露的风险，以及出事怎么办

### 4.1 风险有多大

**任何一个拿到「隧道地址 + 设备 token」或「隧道地址 + 配对码」的人，等于拿到了你电脑上
这个助手和工作区的全权控制权**：能读工作区文件、能让你批准过的命令执行、能切换会话、
能替你回答审批卡。这个接口不是「查看进度」的只读面板。

具体几条：

- **token 存在手机浏览器的 localStorage 里**。手机丢了、借人用了、装了来路不明的扩展，
  都可能被读走。
- **配对码只有 8 位**。它本身有随机性，但配上「长期开着、地址固定」的隧道，
  就值得给暴力尝试留出防线（具名隧道 + Access 或者用完就关）。
- **TLS 只保护到隧道出口**。cloudflared 快速隧道与具名隧道的明文在 Cloudflare 边缘可见；
  SSH 直连方案默认连传输层都没加密。「端到端只有你和你的电脑」这件事，只有
  「手机走 SSH 本地转发」或「自己配证书的反代」才成立。
- **电脑休眠、网络切换都会断**。界面会自动指数退避重连（1 秒起，最多 30 秒一次），
  顶部出现「连接断开，正在重连…」，也可以点「手动重试」。

### 4.2 建议的做法

1. 只在**自己受信的网络**与**自己的设备**上开隧道；出门用完就 Ctrl+C 关掉。
2. 长期使用上加一层门：Cloudflare Access（要邮箱验证码）或自签证书 + 反向代理，
   或者干脆只走 VPN（WireGuard / Tailscale 这类）——**从外面根本看不到这个端口**是最强的做法。
3. 配对码只用手输，别复制粘贴到聊天工具、别截图发人。
4. 不要为了省事把插件端口绑到 `0.0.0.0`，也不要用 `http://` 的对外地址。
5. 换手机、卖手机之前，先按下一节把设备吊销掉。

### 4.3 token 泄露了怎么吊销

1. **在电脑上吊销设备**：进电脑端的设置 → 「远程操控」分区（面板文案以插件实际实现为准），
   把可疑设备（或「全部设备」）移除。移除之后：
   - 已经建立的 WebSocket 会断开；
   - 前端拿着旧 token 去取票据会收到 401，界面会自动退回登录页并提示「登录已失效，请重新配对设备」。
2. **在手机上清掉本地凭据**：遥控界面 → 会话列表页底部 → 「在本机退出」，
   会删除该浏览器里的 token（这一步只是清本地，真正的吊销以第 1 条为准）。
3. **彻底一点**：关掉隧道进程（Ctrl+C，或停掉 cloudflared 服务、断开 SSH 转发），
   必要时在电脑上把远程操控插件停用。三者叠加之后，外面没有任何入口。
4. **顺手做一次**：吊销后换一个新配对码重新配对；如果泄露期间有人在你的工作区里跑过命令，
   去看一眼最近的会话记录与文件改动。

---

## 5. 推送通知：不看屏幕也知道有事

手机锁屏之后，遥控页就不再跑了，浏览器不会替你响一声。要在「模型卡在审批上」或者
「一轮跑完」的时候收到通知，有两条路。**推荐先走路 1**：不用装 Service Worker、
不用管证书，两分钟能通。

两条路的触发点是同一对：**审批卡从无到有**（标题「Muse Code 等待审批」）与
**一轮跑完**（标题「Muse Code 轮完成」，正文「用时 Xs」；只有这一轮用过 15 秒以上、
或者这一轮里出现过审批卡才发）。同类通知 10 秒内只发一条，不会因为连着弹卡刷屏。

### 5.1 路 1：通知 Webhook（Bark / ntfy，推荐）

设置 → 远程控制 → 「通知 Webhook」里粘一个地址，格式由地址自己决定：

| 形态 | 填什么 | 怎么发 |
| --- | --- | --- |
| 带 `{title}` / `{body}` / `{url}` 占位符 | Bark：`https://api.day.app/你的KEY/{title}/{body}?url={url}` | GET，占位符的值先 URL 编码再替换 |
| 不带占位符 | ntfy：`https://ntfy.sh/你的主题` | POST JSON `{"title":…,"body":…,"url":…}` |

- **Bark**（iOS，App Store 搜 Bark）：打开 app 首页会给你一串 key，形如
  `https://api.day.app/xxxxxxxx`。把地址写成
  `https://api.day.app/xxxxxxxx/{title}/{body}?url={url}` 即可（`url` 是点了通知之后
  跳转的遥控页地址）。
- **ntfy**（iOS / Android 都有）：在 app 里订阅一个别人猜不到的主题名（例如
  `msc-7f3a91`），地址填 `https://ntfy.sh/msc-7f3a91`。
- **自建的也行**：任何接受 `POST` 一个 JSON 的地址都能用；对面回 2xx 就算成功，
  失败只会在电脑端写一条提示（不会影响宿主干活）。
- 想确认通没通：按「发送测试推送」这个按钮，它会**分别**告诉你浏览器推送发给了几台、
  Webhook 是发出去了还是失败了、失败原因是什么。
- 留空 = 关掉。填了非 http(s) 的东西会被设置页当场拒掉（`ftp://`、`javascript:` 这类）。

### 5.2 路 2：浏览器推送（Web Push）

这条路不用第三方 app，但**必须先把遥控页变成「装到主屏幕的 PWA」**，否则浏览器不给
推送权限：

1. **电脑端**：设置 → 远程控制 → 打开「浏览器推送（Web Push）」。打开之后宿主才会
   生成 VAPID 密钥（`~/.dsc/remote/push-keys.json`）并接受订阅；关着时订阅接口直接回 403。
2. **手机上**：用浏览器打开遥控页，选「添加到主屏幕」，然后**从主屏幕图标**打开它。
3. 在遥控页里点一次「开启通知」（界面上那个按钮由批 B 的界面调用
   `GET /api/push-key` 与 `POST /api/push-subscribe` 完成订阅）。订阅成功后设置页的
   「推送状态」会显示已订阅几台。
4. 想要静音就再把开关关掉；用户清了站点数据之后推送服务会回 404/410，宿主会**当场把
   那条订阅从库里删掉**（不会一直往一个死地址发）。换手机、换浏览器之后重新订阅一次即可。

**iOS 特别注意**：Safari 只有 **16.4 及以上**、并且页面**已经加到主屏幕**、从主屏幕打开
的情况下才支持 Web Push。直接开一个 Safari 标签页是收不到系统通知的。Android 上的
Chrome 没有这条限制，但同样建议加到主屏幕（否则页面被后台回收之后订阅容易失效）。

### 5.3 两条路的取舍

- 只是「想知道卡住了没有」：走 Webhook（Bark/ntfy），不用管 PWA 与 iOS 版本。
- 想要「点通知直接回到遥控页、还能在通知上直接同意/拒绝」：那是 Web Push 那条路加上
  批 B 的 Service Worker 交互，先按 5.2 把订阅跑通。
- 推送内容只有标题、一句正文（审批卡的工具摘要或「用时 Xs」）与遥控页地址，
  **不含会话正文**，也不含配对码与 token。

---

## 附：常见问题

- **页面能打开，但一直在「连接断开，正在重连…」**：多数是隧道只转发 HTTP 没转发 WebSocket，
  或者中间的反代没开 upgrade 头。cloudflared 自身没问题；自建 nginx 记得
  `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`。
- **手机上打不开地址**：先确认电脑上 `http://127.0.0.1:17321` 能开（插件是不是没启用），
  再看隧道进程还在不在，最后看手机网络能不能出 QUIC（改 `--protocol http2`）。
- **配对码总说不对**：码有时效，重新在电脑上生成一个；注意别把 `0` 和 `O` 看错，
  界面对大小写不敏感（输入会自动转成大写）。
- **收不到推送**：先在设置里按一次「发送测试推送」，它会分别说清两条腿的结果。
  Webhook 那条看地址对不对（Bark 要有 `{title}` 这类占位符，ntfy 不要）；Web Push 那条
  要确认电脑端开关开着、手机把页面加到了主屏幕、并且「推送状态」显示已订阅几台；
  iOS 还要求 16.4 以上。
- **插件的端口不是 17321**：本文命令里的 17321 换成实际端口，`ingress.service` 那一行也要换。
