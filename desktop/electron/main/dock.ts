/**
 * dock 基建：内置浏览器视图（WebContentsView 原生层，renderer 提供 rect）。
 * 终端（管道模式）与 git/文件能力经 dsc 宿主协议（desktop-dock 服务）。
 *
 * @module desktop/main/dock
 */
import { BrowserWindow, WebContentsView, ipcMain } from 'electron'

let dockView: WebContentsView | null = null
let dockViewVisible = false

function mainWindowRef(): BrowserWindow | null {
  return (globalThis as { __dscMainWindow?: BrowserWindow }).__dscMainWindow ?? null
}

/** dock 内置浏览器：显示/隐藏 + 定位（rect 为 renderer 坐标，窗口内容坐标一致）。 */
export function setDockBrowser(
  visible: boolean,
  rect?: { x: number; y: number; width: number; height: number },
): boolean {
  const win = mainWindowRef()
  if (win === null) return false
  if (visible && rect !== undefined && rect.width > 10 && rect.height > 10) {
    if (dockView === null) {
      dockView = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false } })
      dockView.webContents.setWindowOpenHandler(({ url }) => {
        void dockView?.webContents.loadURL(url).catch(() => {})
        return { action: 'deny' }
      })
      dockView.webContents.on('did-navigate', (_event, url) => {
        win.webContents.send('dsc:browser-state', { url })
      })
      dockView.webContents.on('did-navigate-in-page', (_event, url) => {
        win.webContents.send('dsc:browser-state', { url })
      })
      void dockView.webContents.loadURL('https://www.bing.com').catch(() => {})
    }
    if (!dockViewVisible) win.contentView.addChildView(dockView)
    dockView.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
    dockViewVisible = true
  } else if (dockView !== null && dockViewVisible) {
    win.contentView.removeChildView(dockView)
    dockViewVisible = false
  }
  return true
}

/** 注册 dock 的 IPC（内置浏览器控制）。 */
export function registerDockIpc(): void {
  ipcMain.handle(
    'dsc:dock-browser',
    (_event, visible: boolean, rect?: { x: number; y: number; width: number; height: number }) => {
      return setDockBrowser(visible, rect)
    },
  )
  ipcMain.handle('dsc:browser-nav', (_event, url: string, action: 'load' | 'back' | 'forward' | 'reload') => {
    if (dockView === null) return { ok: false }
    const contents = dockView.webContents
    if (action === 'back') contents.goBack()
    else if (action === 'forward') contents.goForward()
    else if (action === 'reload') contents.reload()
    else {
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: '仅支持 http/https' }
      void contents.loadURL(url).catch(() => {})
    }
    return { ok: true, url: contents.getURL() }
  })
}
