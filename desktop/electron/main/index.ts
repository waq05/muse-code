/**
 * dsc-desktop 主进程：窗口 + headless 宿主（utilityProcess）生命周期 + IPC。
 *
 * 宿主 = Electron utilityProcess 拉起的 dsc headless 进程（base 插件集 +
 * host-stdio 协议桥的 parentPort 传输，见 dsc 的 src/plugins/host-stdio.ts）。
 * renderer 经 contextBridge 的 window.dsc 与本进程通信。
 *
 * @module desktop/main
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { BrowserWindow, Menu, Tray, WebContentsView, app, dialog, ipcMain, nativeImage, shell, utilityProcess, type UtilityProcess } from 'electron'
import type { NativeImage } from 'electron'
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

// ── 系统托盘与退出 ────────────────────────────────────────────────────────────

let tray: Tray | null = null

/**
 * 关窗是缩托盘还是直接退出：现读 `~/.dsc/settings.json` 的 closeToTray（与宿主
 * 的 core/prefs.ts 同一个文件），所以设置里改完开关不用重启就生效。
 */
function closeToTrayEnabled(): boolean {
  try {
    const doc = JSON.parse(
      readFileSync(join(app.getPath('home'), '.dsc', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>
    return doc.closeToTray !== false
  } catch {
    return true
  }
}

/** 托盘图标：打包后从 resources 取，dev 从 desktop/build 取。 */
function trayIcon(): NativeImage {
  const file = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '..', '..', 'build', 'icon.png')
  const image = existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty()
  if (image.isEmpty()) {
    process.stderr.write(`[dsc] 托盘图标加载失败（${file} ${existsSync(file) ? '解码失败' : '文件不存在'}），托盘将没有图标\n`)
    return image
  }
  return image.getSize().width > 32 ? image.resize({ width: 16, height: 16 }) : image
}

/** 托盘图标懒创建：只有真要缩到托盘时才需要它。 */
function ensureTray(): Tray {
  if (tray !== null) return tray
  const created = new Tray(trayIcon())
  created.setToolTip('dsc — 点我回到窗口')
  created.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '完全退出', click: () => quitApp() },
    ]),
  )
  created.on('click', () => showMainWindow())
  created.on('double-click', () => showMainWindow())
  tray = created
  return created
}

function showMainWindow(): void {
  if (mainWindow === null) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 退出：先让宿主收尾（超时 2 秒强杀），再 app.quit。关窗与托盘菜单共用这条路径。 */
function quitApp(): void {
  quitting = true
  stopHost(() => {
    tray?.destroy()
    tray = null
    app.quit()
  })
}

/** 切换工作目录：停旧宿主 → 以新 cwd 重启（快照清空由宿主侧初始会话保证）。 */
function restartHost(cwd: string): Promise<void> {
  return new Promise((resolveDone) => {
    stopHost(
      () => {
        startHost(cwd)
        // 顺手记一份「最近用过」清单（侧栏切换工作区菜单的数据源），最新的排最前
        const recent = [cwd, ...(readState().recentCwds ?? []).filter((entry) => entry !== cwd)].slice(0, 12)
        writeState({ lastCwd: cwd, recentCwds: recent })
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

  // 切到指定工作目录（侧栏点工作区名走这条，不弹对话框）
  ipcMain.handle('dsc:switch-cwd', async (_event, path: string) => {
    const next = resolve(String(path ?? ''))
    if (!existsSync(next) || !statSync(next).isDirectory()) {
      return { ok: false, error: `目录不存在：${next}` }
    }
    if (next !== hostCwd) await restartHost(next)
    return { ok: true, cwd: hostCwd }
  })

  // 最近用过的工作目录（侧栏切换菜单与「有会话的目录」合并成候选清单）
  ipcMain.handle('dsc:recent-cwds', (): string[] => readState().recentCwds ?? [])

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

  // 选择技能（SKILL.md 所在目录，或扁平 .md 文件）并复制到 ~/.dsc/skills/
  ipcMain.handle('dsc:skills-install', async () => {
    if (mainWindow === null) return []
    const outcome = await dialog.showOpenDialog(mainWindow, {
      title: '选择技能：含 SKILL.md 的目录，或 .md 文件',
      filters: [{ name: '技能文件', extensions: ['md'] }],
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    })
    if (outcome.canceled || outcome.filePaths.length === 0) return []
    const dir = join(app.getPath('home'), '.dsc', 'skills')
    mkdirSync(dir, { recursive: true })
    const installed: string[] = []
    for (const src of outcome.filePaths) {
      const name = basename(src)
      if (statSync(src).isDirectory()) {
        if (existsSync(join(src, 'SKILL.md'))) {
          // 一个技能包：整目录（含 references/、scripts/）复制过去
          cpSync(src, join(dir, name), { recursive: true })
          installed.push(name)
          continue
        }
        // 用户选的是一捆：把里面每个含 SKILL.md 的子目录当作一个技能
        for (const child of readdirSync(src)) {
          const childPath = join(src, child)
          if (existsSync(join(childPath, 'SKILL.md'))) {
            cpSync(childPath, join(dir, child), { recursive: true })
            installed.push(child)
          }
        }
        continue
      }
      if (!name.toLowerCase().endsWith('.md')) continue
      copyFileSync(src, join(dir, name))
      installed.push(name.replace(/\.md$/i, ''))
    }
    return installed
  })

  // 在系统文件管理器里打开路径（设置「关于」里的路径行）；只接受绝对路径
  ipcMain.handle('dsc:open-path', (_event, path: string) => {
    if (typeof path !== 'string' || !isAbsolute(path)) return '只允许打开绝对路径'
    return shell.openPath(path)
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
    const wait = Number.parseInt(process.env.DSC_DESKTOP_SHOT_DELAY ?? '4000', 10)
    const delay = Number.isNaN(wait) ? 4000 : wait
    // capturePage 在 GPU 合成不正常时可能永远不返回，因此挂个看门狗：自动化不能挂在这里
    mainWindow.webContents.once('did-finish-load', () => {
      process.stderr.write(`[selfcheck] 页面加载完成，${delay}ms 后截图 ${shotPath}\n`)
      const watchdog = setTimeout(() => {
        process.stderr.write('[selfcheck] 截图超时，强制退出\n')
        app.exit(1)
      }, delay + 25000)
      setTimeout(() => {
        void mainWindow?.webContents
          .capturePage()
          .then((image) => {
            mkdirSync(resolve(shotPath, '..'), { recursive: true })
            writeFileSync(shotPath, image.toPNG())
            process.stderr.write(`[selfcheck] 已写出 ${shotPath}\n`)
          })
          .catch((error: unknown) => process.stderr.write(`[selfcheck] 截图失败：${String(error)}\n`))
          .finally(() => {
            clearTimeout(watchdog)
            app.exit(0)
          })
      }, delay)
    })
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
      process.stderr.write(`[selfcheck] 页面加载失败：${code} ${description}\n`)
    })
  }

  // 自检参数：DSC_DESKTOP_DEMO=1 自动跑一轮真实对话；DSC_DESKTOP_SEARCH 直接打开某个界面
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  const query = [
    process.env.DSC_DESKTOP_DEMO === '1' ? 'demo=1' : '',
    process.env.DSC_DESKTOP_SEARCH ?? '',
  ]
    .filter((part) => part !== '')
    .join('&')
  if (devServerUrl !== undefined && devServerUrl !== '') {
    void mainWindow.loadURL(`${devServerUrl}/${query === '' ? '' : `?${query}`}`)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      search: query === '' ? undefined : query,
    })
  }

  // 点 X：开关开着就缩到托盘（宿主继续跑），否则正常关窗走退出流程
  mainWindow.on('close', (event) => {
    if (quitting || !closeToTrayEnabled()) return
    event.preventDefault()
    mainWindow?.hide()
    ensureTray()
    const state = readState()
    if (state.trayHintShown !== true && process.platform === 'win32') {
      writeState({ ...state, trayHintShown: true })
      tray?.displayBalloon({
        title: 'dsc 还在后台运行',
        content: '点托盘图标回到窗口，右键图标可以完全退出；这个提示只出现一次，关窗行为可在设置 → 通用里改',
      })
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// 自检/并行实例：换一个 userData 目录，单实例锁与已开着的打包版互不影响
const userDataOverride = process.env.DSC_DESKTOP_USER_DATA
if (userDataOverride !== undefined && userDataOverride !== '') {
  app.setPath('userData', userDataOverride)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 缩到托盘时再点快捷方式：把隐藏的主窗口叫回来
    showMainWindow()
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
    quitApp()
  })
}
