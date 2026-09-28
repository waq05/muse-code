/**
 * dsc-desktop 主进程：窗口 + headless 宿主（utilityProcess）生命周期 + IPC。
 *
 * 宿主 = Electron utilityProcess 拉起的 dsc headless 进程（base 插件集 +
 * host-stdio 协议桥的 parentPort 传输，见 dsc 的 src/plugins/host-stdio.ts）。
 * renderer 经 contextBridge 的 window.dsc 与本进程通信。
 *
 * @module desktop/main
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { BrowserWindow, WebContentsView, app, dialog, ipcMain, utilityProcess, type UtilityProcess } from 'electron'
import { HostProtocol } from './protocol.js'
import { registerDockIpc } from './dock.js'
import { readState, resolveHeadlessEntry, writeState } from './dsc-core.js'

let mainWindow: BrowserWindow | null = null
let protocol: HostProtocol | null = null
let quitting = false
/** 计划内重启（插件变更）时抑制 host-exit 事件，避免 renderer 误报崩溃。 */
let suppressHostExit = false

/** 当前宿主工作目录（会话 cwd；desktop.json 记忆）。 */
let hostCwd = ''

// ── 宿主生命周期 ──────────────────────────────────────────────────────────────

/** 启动 headless 宿主（utilityProcess；入口为应用自有编译产物，无用户输入）。 */
function startHost(cwd: string): void {
  hostCwd = cwd
  const entry = resolveHeadlessEntry()
  protocol = new HostProtocol(entry, cwd)

  protocol.onSnapshot((snapshot) => {
    mainWindow?.webContents.send('dsc:snapshot', snapshot)
  })
  protocol.onUi((action) => {
    mainWindow?.webContents.send('dsc:ui', action)
  })
  protocol.onDockData((data) => {
    mainWindow?.webContents.send('dsc:dock-data', data)
  })
  protocol.onClose(({ code }) => {
    const silent = suppressHostExit
    suppressHostExit = false
    protocol = null
    if (!quitting && !silent) {
      mainWindow?.webContents.send('dsc:host-exit', { code })
    }
  })
}

function stopHost(onDone?: () => void, { silent = false } = {}): void {
  const current = protocol
  if (current === null) {
    onDone?.()
    return
  }
  suppressHostExit = silent
  const timeout = setTimeout(() => current.kill(), 2000)
  current.exitGracefully(() => {
    clearTimeout(timeout)
    protocol = null
    onDone?.()
  })
}

/** 切换工作目录：停旧宿主 → 以新 cwd 重启（快照清空由宿主侧初始会话保证）。 */
function restartHost(cwd: string): Promise<void> {
  return new Promise((resolveDone) => {
    stopHost(
      () => {
        startHost(cwd)
        writeState({ lastCwd: cwd })
        resolveDone()
      },
      { silent: true },
    )
  })
}

// ── IPC ──────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle('dsc:invoke', (_event, method: string, args: unknown[]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke(method, args ?? [])
  })

  ipcMain.handle('dsc:get-cwd', () => hostCwd)

  ipcMain.handle('dsc:choose-directory', async () => {
    if (mainWindow === null) return null
    const outcome = await dialog.showOpenDialog(mainWindow, {
      title: '选择 dsc 工作目录',
      properties: ['openDirectory'],
      defaultPath: hostCwd || undefined,
    })
    if (outcome.canceled || outcome.filePaths.length === 0) return null
    const next = resolve(outcome.filePaths[0] ?? '')
    if (next !== hostCwd) await restartHost(next)
    return next
  })

  ipcMain.handle('dsc:restart-host', async () => {
    await restartHost(hostCwd)
    return true
  })

  // 选择 .js 插件文件并复制到 ~/.dsc/plugins/；返回复制的文件名（取消返回 []）
  ipcMain.handle('dsc:plugins-install', async () => {
    if (mainWindow === null) return []
    const outcome = await dialog.showOpenDialog(mainWindow, {
      title: '选择 dsc 插件文件（.js）',
      filters: [{ name: 'dsc 插件', extensions: ['js'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (outcome.canceled || outcome.filePaths.length === 0) return []
    const dir = join(app.getPath('home'), '.dsc', 'plugins')
    mkdirSync(dir, { recursive: true })
    const installed: string[] = []
    for (const src of outcome.filePaths) {
      const dest = join(dir, basename(src))
      copyFileSync(src, dest)
      installed.push(basename(dest))
    }
    return installed
  })

  ipcMain.on('dsc:quit', () => {
    mainWindow?.close()
  })
}

// ── 窗口与应用 ────────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    // 全暗色无边框：Windows 用原生 overlay 窗口控件，renderer 内留出拖拽区
    backgroundColor: '#0d0d0f',
    title: 'dsc',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0d0d0f',
      symbolColor: '#9a9aa2',
      height: 38,
    },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // dock.ts 通过全局引用向 renderer 推送事件（pty 数据 / 浏览器状态）
  ;(globalThis as { __dscMainWindow?: BrowserWindow }).__dscMainWindow = mainWindow

  // 自检截图：DSC_DESKTOP_SHOT=<png 路径> 时，加载完成后截图并退出（自动化验证用）。
  // 必须在 loadFile/loadURL 之前注册，否则会错过 did-finish-load。
  const shotPath = process.env.DSC_DESKTOP_SHOT
  if (shotPath !== undefined && shotPath !== '') {
    mainWindow.webContents.once('did-finish-load', () => {
      const delay = Number.parseInt(process.env.DSC_DESKTOP_SHOT_DELAY ?? '4000', 10)
      setTimeout(() => {
        void mainWindow?.webContents
          .capturePage()
          .then((image) => {
            mkdirSync(resolve(shotPath, '..'), { recursive: true })
            writeFileSync(shotPath, image.toPNG())
          })
          .finally(() => app.exit(0))
      }, Number.isNaN(delay) ? 4000 : delay)
    })
  }

  // electron-vite dev：renderer 走 vite dev server；生产：本地文件
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  const demo = process.env.DSC_DESKTOP_DEMO === '1'
  const search = demo ? '?demo=1' : ''
  if (devServerUrl !== undefined && devServerUrl !== '') {
    void mainWindow.loadURL(`${devServerUrl}/${search}`)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      search: demo ? 'demo=1' : undefined,
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    const state = readState()
    startHost(state.lastCwd ?? app.getPath('home'))
    registerIpc()
    registerDockIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    quitting = true
    stopHost(() => app.quit())
    // 兜底：宿主卡住也最多多等 stopHost 内部 2s 超时
  })
}
