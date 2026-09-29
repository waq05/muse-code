# muse-code-desktop

Muse Code（dsc 仓库）的桌面端：Electron 壳 + headless 宿主子进程（utilityProcess + MessagePort 协议）。

## 架构

```
┌ Electron 壳（本包）
│  ├ main：窗口、utilityProcess 拉起宿主、IPC、目录选择/记忆（~/.dsc/desktop.json）
│  ├ preload：contextBridge 暴露 window.dsc（invoke/onSnapshot/…）
│  └ renderer：React 暗色聊天 UI（组件对照 TUI 移植，复用 dsc 的命令补全）
└ 宿主 = utilityProcess 跑 dsc 的 bin/headless.cjs
   （CJS shim 保活 + 动态 import lib/headless.js；base 插件集 + host-stdio 协议桥）
```

宿主复用 dsc 的插件内核：工具、命令、LLM 路由、会话、审批全部是 cordis 插件，
外部插件（`~/.dsc/plugins/*.js` 与 config.yaml `plugins` 段）对桌面端同样生效。

## 开发

```bash
# 1. 先编译 dsc 宿主（dsc 根目录）
pnpm build

# 2. 启动桌面端 dev（vite + electron）
cd desktop && pnpm dev

# 截图自检（加载 4 秒后截图并退出，自动化验证用）
DSC_DESKTOP_SHOT=<png 路径> ./node_modules/.bin/electron out/main/index.js
```

## 打包

```bash
pnpm dist:dir     # 未压缩目录（冒烟）：dist/win-unpacked/Muse Code.exe
pnpm dist         # NSIS 安装包 + portable exe
```

打包流程：electron-vite build → prepare-runtime.mjs 组装 `runtime-staging/dsc-core`
（bin + lib + package.json + 运行期依赖 cordis/loader/cosmokit/@standard-schema/spec/yaml，
从 pnpm 虚拟目录解析真实文件）→ electron-builder（extraResources 携带 dsc-core；
node_modules 由 after-pack.cjs 钩子补齐——builder 会硬编码忽略该目录名）。

## 协议

宿主 ⇄ 壳消息（结构化克隆，形状见 `dsc/src/plugins/host-stdio.ts`）：

- 宿主→壳：`hello`（握手）、`result`（应答）、`snapshot`（80ms 节流全量快照）
- 壳→宿主：`invoke`（DscRuntime 方法白名单）、`exit`（收尾退进程）

## 已知边界

- 快照为全量推送（80ms 节流），超长会话可后续改增量协议
- 配置沿用 dsc 的 `~/.dsc/config.yaml`（providers + 可选 `ui`/`plugins` 段）；
  桌面端工作目录记忆在 `~/.dsc/desktop.json`
