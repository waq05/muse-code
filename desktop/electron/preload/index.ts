/**
 * preload：contextBridge 暴露 window.dsc——renderer 与主进程之间的窄接口。
 * 快照/宿主事件走推送通道；请求走 invoke；目录选择/重启宿主是壳能力。
 *
 * @module desktop/preload
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { SessionUsageView } from '../main/session-usage.js'

const api = {
  /** 调用 DscRuntime 方法（宿主侧白名单校验）。 */
  invoke(method: string, args: unknown[] = []): Promise<unknown> {
    return ipcRenderer.invoke('dsc:invoke', method, args)
  },

  /** 订阅快照推送（宿主侧 80ms 节流全量）。 */
  onSnapshot(listener: (snapshot: unknown) => void): () => void {
    const handler = (_event: IpcRendererEvent, snapshot: unknown): void => listener(snapshot)
    ipcRenderer.on('dsc:snapshot', handler)
    return () => ipcRenderer.removeListener('dsc:snapshot', handler)
  },

  /** 宿主 UI 动作（命令 handler 请求打开会话选择面板等）。 */
  onUi(listener: (action: string) => void): () => void {
    const handler = (_event: IpcRendererEvent, action: string): void => listener(action)
    ipcRenderer.on('dsc:ui', handler)
    return () => ipcRenderer.removeListener('dsc:ui', handler)
  },

  /** 宿主 stderr 诊断信息。 */
  onHostLog(listener: (message: string) => void): () => void {
    const handler = (_event: IpcRendererEvent, message: string): void => listener(message)
    ipcRenderer.on('dsc:host-log', handler)
    return () => ipcRenderer.removeListener('dsc:host-log', handler)
  },

  /** 宿主退出（含崩溃）。 */
  onHostExit(listener: (info: { code: number | null }) => void): () => void {
    const handler = (_event: IpcRendererEvent, info: { code: number | null }): void =>
      listener(info)
    ipcRenderer.on('dsc:host-exit', handler)
    return () => ipcRenderer.removeListener('dsc:host-exit', handler)
  },

  /** 当前宿主工作目录。 */
  getCwd(): Promise<string> {
    return ipcRenderer.invoke('dsc:get-cwd')
  },

  /** 打开目录选择对话框并切换工作目录（重启宿主）；取消返回 null。 */
  chooseDirectory(): Promise<string | null> {
    return ipcRenderer.invoke('dsc:choose-directory')
  },

  /** 以当前工作目录重启宿主（崩溃恢复）。 */
  restartHost(): Promise<boolean> {
    return ipcRenderer.invoke('dsc:restart-host')
  },

  /** 切到指定工作目录（侧栏点工作区名；失败给原因）。 */
  switchCwd(path: string): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
    return ipcRenderer.invoke('dsc:switch-cwd', path)
  },

  /** 最近用过的工作目录（最新的排最前）。 */
  recentCwds(): Promise<string[]> {
    return ipcRenderer.invoke('dsc:recent-cwds')
  },

  /** 当前会话在宿主用量日志里的累计（只读；这个会话没有记录时为 null）。 */
  sessionUsage(sessionId: string): Promise<SessionUsageView | null> {
    return ipcRenderer.invoke('dsc:session-usage', sessionId) as Promise<SessionUsageView | null>
  },

  /** 系统文件选择器挑选 .js 插件并复制到 ~/.dsc/plugins/；返回复制的文件名列表。 */
  installPlugin(): Promise<string[]> {
    return ipcRenderer.invoke('dsc:plugins-install')
  },

  /** 系统选择器挑选技能（SKILL.md 所在目录或 .md 文件）并复制到 ~/.dsc/skills/；返回技能名列表。 */
  installSkill(): Promise<string[]> {
    return ipcRenderer.invoke('dsc:skills-install')
  },

  /** 在系统文件管理器里打开目录或文件（设置「关于」里的路径按钮）；返回空串表示成功。 */
  openPath(path: string): Promise<string> {
    return ipcRenderer.invoke('dsc:open-path', path)
  },

  /** 用多种方式打开当前工作区（terminal / explorer / vscode；顶栏下拉菜单）。 */
  openWorkspace(kind: 'terminal' | 'explorer' | 'vscode'): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('dsc:workspace-open', kind)
  },

  /** 主题切换时把窗口底色、原生控件区的图标色报给主进程（两个 #rrggbb）。 */
  setWindowChrome(bar: string, symbol: string): void {
    ipcRenderer.send('dsc:set-window-chrome', bar, symbol)
  },

  /** 主题切换时把模式报给主进程设 nativeTheme.themeSource（原生弹出层的深浅跟它走）。 */
  setThemeSource(mode: 'dark' | 'light' | 'system'): void {
    ipcRenderer.send('dsc:theme-source', mode)
  },

  /** 用系统浏览器打开 http/https 链接（检查更新的「打开发布页」）；主进程校验协议。 */
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke('dsc:open-external', url)
  },

  /** 弹一条系统通知（任务完成提醒；点击通知唤回主窗口）。返回是否真的创建了。 */
  notify(payload: { title: string; body?: string }): Promise<boolean> {
    return ipcRenderer.invoke('dsc:notify', payload) as Promise<boolean>
  },

  // ── dock：内置终端（宿主 desktop-dock 服务，管道模式）/ 内置浏览器 ──

  /** dock 终端输出流（term-spawn 会话 id 维度）。 */
  onDockData(listener: (data: { id: string; data: string }) => void): () => void {
    const handler = (_event: IpcRendererEvent, data: unknown): void => listener(data as never)
    ipcRenderer.on('dsc:dock-data', handler)
    return () => ipcRenderer.removeListener('dsc:dock-data', handler)
  },

  /** dock 内置浏览器：显示/隐藏 + 定位（rect 为 renderer 页面坐标）。 */
  dockBrowser(visible: boolean, rect?: { x: number; y: number; width: number; height: number }): Promise<boolean> {
    return ipcRenderer.invoke('dsc:dock-browser', visible, rect)
  },
  browserNav(url: string, action: 'load' | 'back' | 'forward' | 'reload'): Promise<{ ok: boolean; url?: string; error?: string }> {
    return ipcRenderer.invoke('dsc:browser-nav', url, action)
  },
  onBrowserState(listener: (state: { url: string }) => void): () => void {
    const handler = (_event: IpcRendererEvent, state: unknown): void => listener(state as never)
    ipcRenderer.on('dsc:browser-state', handler)
    return () => ipcRenderer.removeListener('dsc:browser-state', handler)
  },

  /** 退出应用（关闭主窗口 → 优雅停宿主 → quit）。 */
  quit(): void {
    ipcRenderer.send('dsc:quit')
  },
}

contextBridge.exposeInMainWorld('dsc', api)

export type DscBridge = typeof api
