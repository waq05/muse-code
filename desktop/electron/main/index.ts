/**
 * dsc-desktop 主进程：窗口 + headless 宿主（utilityProcess）生命周期 + IPC。
 *
 * 宿主 = Electron utilityProcess 拉起的 dsc headless 进程（base 插件集 +
 * host-stdio 协议桥的 parentPort 传输，见 dsc 的 src/plugins/host-stdio.ts）。
 * renderer 经 contextBridge 的 window.dsc 与本进程通信。
 *
 * @module desktop/main
 */
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { BrowserWindow, Menu, Notification, Tray, WebContentsView, app, desktopCapturer, dialog, ipcMain, nativeImage, nativeTheme, screen, shell, utilityProcess, type UtilityProcess } from 'electron'
import type { NativeImage } from 'electron'
import { HostProtocol } from './protocol.js'
import { registerDockIpc } from './dock.js'
import { readState, resolveHeadlessEntry, writeState } from './dsc-core.js'
import { readSessionUsage } from './session-usage.js'

let mainWindow: BrowserWindow | null = null
let protocol: HostProtocol | null = null
let quitting = false
/** 计划内重启（插件变更）时抑制 host-exit 事件，避免 renderer 误报崩溃。 */
let suppressHostExit = false

/** 当前宿主工作目录（会话 cwd；desktop.json 记忆）。 */
let hostCwd = ''

/** 原生窗口控件区的高度：renderer 的窗口控件条（caption-bar）是 36px，多给 2px 让按钮命中区不裁边。 */
const CAPTION_HEIGHT = 38
/**
 * 深色主题的窗口底色与控件区配色，取自深色主题下这两个令牌算出来的实际值，
 * 这样选深色时开窗到首帧之间不会看见颜色跳一下。浅色主题由 renderer 在外观
 * 生效时推过来覆盖。
 */
const DARK_CHROME = { bar: '#111421', symbol: '#b7babf' }

/** 能否交给系统给窗口控件着色：只收 #rrggbb，半透明颜色到了那侧会被丢掉。 */
function isChromeColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

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

/**
 * 托盘图标：打包后从 resources 取，dev 从 desktop/build 取。
 *
 * 托盘会把它缩到 16px，主图标（512px 水墨人像）缩到这个尺寸只剩一团灰，
 * 所以单独准备 build/icon-tray.png（只裁头部、压成实墨剪影的 32px 版）。
 * 该文件缺失时回退到主图标，保证托盘永远不会没图标。
 */
function trayIcon(): NativeImage {
  const dir = app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..', 'build')
  const file = [join(dir, 'icon-tray.png'), join(dir, 'icon.png')].find((p) => existsSync(p))
  const image = file ? nativeImage.createFromPath(file) : nativeImage.createEmpty()
  if (image.isEmpty()) {
    const why = file ? (existsSync(file) ? '解码失败' : '文件不存在') : `目录下没有图标文件（${dir}）`
    process.stderr.write(`[dsc] 托盘图标加载失败（${file ?? dir} ${why}），托盘将没有图标\n`)
    return image
  }
  return image.getSize().width > 32 ? image.resize({ width: 16, height: 16 }) : image
}

/** 托盘图标懒创建：只有真要缩到托盘时才需要它。 */
function ensureTray(): Tray {
  if (tray !== null) return tray
  const created = new Tray(trayIcon())
  created.setToolTip('Muse Code — 点我回到窗口')
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

/** 一次「打开工作区」的结果：失败时带一句能直接看的原因。 */
type WorkspaceOpenResult = { ok: boolean; error?: string }

/**
 * 用多种方式打开当前工作区。terminal：优先 Windows Terminal，没装退回经
 * PowerShell 指定工作目录的 cmd；vscode：借 cmd.exe 调 code 垫片（Node 直接
 * spawn .cmd 会被拦）；explorer：shell.openPath。
 */
function openWorkspace(kind: string): WorkspaceOpenResult | Promise<WorkspaceOpenResult> {
  const dir = hostCwd
  if (dir === '' || !existsSync(dir)) {
    return { ok: false, error: `工作目录不存在：${dir}` }
  }
  if (kind === 'explorer') {
    return shell.openPath(dir).then((problem) => (problem === '' ? { ok: true } : { ok: false, error: problem }))
  }
  if (kind === 'terminal') {
    return new Promise((resolveOpen) => {
      // 没装 Windows Terminal（wt.exe）时退回经典 cmd：
      // 经 PowerShell 的 Start-Process 指定工作目录，避免 cmd start 的转义泥潭。
      const viaCmd = (): void => {
        const psQuote = dir.replace(/'/g, "''")
        const fallback = spawn(
          'powershell.exe',
          ['-NoProfile', '-Command', `Start-Process cmd -WorkingDirectory '${psQuote}'`],
          { stdio: 'ignore' },
        )
        fallback.on('error', (error) => resolveOpen({ ok: false, error: String(error) }))
        fallback.on('close', () => resolveOpen({ ok: true }))
      }
      const child = spawn('wt.exe', ['-d', dir], { stdio: 'ignore' })
      child.on('error', viaCmd)
      child.on('close', () => resolveOpen({ ok: true }))
    })
  }
  if (kind === 'vscode') {
    return new Promise((resolveOpen) => {
      const child = spawn('cmd.exe', ['/d', '/c', 'code', dir], { stdio: 'ignore' })
      child.on('error', () => resolveOpen({ ok: false, error: '启动 cmd 失败' }))
      child.on('close', (codeNum) => {
        if (codeNum === 0) {
          resolveOpen({ ok: true })
        } else {
          resolveOpen({ ok: false, error: `没找到 code 命令（退出码 ${String(codeNum)}）：VS Code 可能没装，或没把 CLI 加进 PATH` })
        }
      })
    })
  }
  return { ok: false, error: `未知的打开方式：${kind}` }
}

function registerIpc(): void {
  ipcMain.handle('dsc:invoke', (_event, method: string, args: unknown[]) => {
    if (protocol === null) throw new Error('宿主进程未运行')
    return protocol.invoke(method, args ?? [])
  })

  ipcMain.handle('dsc:get-cwd', () => hostCwd)

  ipcMain.handle('dsc:choose-directory', async () => {
    if (mainWindow === null) return null
    const outcome = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Muse Code 工作目录',
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

  // 当前会话的累计用量（底部状态栏第二段与上下文悬浮卡的数据源）。
  // 只读宿主写的用量日志，按会话 id 汇总；没有记录时返回 null，由渲染层省略那两段。
  ipcMain.handle('dsc:session-usage', (_event, sessionId: unknown) => readSessionUsage(String(sessionId ?? '')))

  // 选择 .js 插件文件并复制到 ~/.dsc/plugins/；返回复制的文件名（取消返回 []）
  ipcMain.handle('dsc:plugins-install', async () => {
    if (mainWindow === null) return []
    const outcome = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Muse Code 插件文件',
      filters: [{ name: 'Muse Code 插件', extensions: ['js'] }],
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

  // 用系统浏览器打开链接（检查更新的「打开发布页」）；只放行 http/https，
  // 免得 file:/自定义协议被渲染层来的字符串拿着 shell 去开。
  ipcMain.handle('dsc:open-external', (_event, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    void shell.openExternal(url)
  })

  // 系统通知（任务完成提醒）：渲染层在一轮干完且窗口离开前台时打过来。
  // 声音不归这里——渲染层的完成提示音负责发声（开关独立），通知一律 silent，
  // 免得 Windows 的 toast 提示音和我们的音效同一时刻叠两声。
  ipcMain.handle('dsc:notify', (event, payload: unknown) => {
    if (mainWindow === null || event.sender !== mainWindow.webContents) return false
    const title = typeof (payload as { title?: unknown } | null)?.title === 'string' ? (payload as { title: string }).title.trim() : ''
    if (title === '') return false
    const rawBody = typeof (payload as { body?: unknown } | null)?.body === 'string' ? (payload as { body: string }).body.trim() : ''
    const iconDir = app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..', 'build')
    const iconFile = [join(iconDir, 'icon.png'), join(iconDir, 'icon-tray.png')].find((p) => existsSync(p))
    const notification = new Notification({
      title,
      ...(rawBody !== '' ? { body: rawBody } : {}),
      ...(iconFile !== undefined ? { icon: iconFile } : {}),
      silent: true,
    })
    if (process.env.DSC_DESKTOP_SHOT !== undefined && process.env.DSC_DESKTOP_SHOT !== '') {
      process.stderr.write(`[selfcheck] 系统通知：${title}${rawBody === '' ? '' : ` / ${rawBody}`}\n`)
    }
    // 点通知 = 回到主窗口（缩托盘/最小化时尤其实用）
    notification.on('click', () => showMainWindow())
    notification.show()
    return true
  })

  // 原生弹出层（select 的下拉选项列表、右键菜单）的深浅只认 nativeTheme，
  // 页面 CSS 够不着：renderer 在主题生效时把模式报上来。跟随系统就原样透传，
  // 让 OS 自己翻面；值不对就拒收，保持上一次的主题。
  ipcMain.on('dsc:theme-source', (event, mode: unknown) => {
    if (event.sender !== mainWindow?.webContents) return
    if (mode !== 'dark' && mode !== 'light' && mode !== 'system') return
    if (process.env.DSC_DESKTOP_SHOT !== undefined && process.env.DSC_DESKTOP_SHOT !== '') {
      process.stderr.write(`[selfcheck] 原生主题源 ${mode}\n`)
    }
    nativeTheme.themeSource = mode
  })

  // 用多种方式打开当前工作区（顶栏文件夹按钮的下拉；对照 dsh）。
  // 只对宿主记忆里的 hostCwd 生效——它不是用户随手输入的字符串，spawn 参数固定。
  ipcMain.handle('dsc:workspace-open', (_event, kind: string) => openWorkspace(String(kind)))

  ipcMain.on('dsc:quit', () => {
    mainWindow?.close()
  })

  // 原生窗口控件区（最小化/最大化/关闭）由系统画，样式表够不着，只能在主题
  // 切换时由 renderer 把两个颜色报上来。只收 #rrggbb：带 alpha 的颜色到了系统
  // 那侧会被丢掉，宁可拒收也不要在浅色主题下留一块错色的条。
  ipcMain.on('dsc:set-window-chrome', (event, bar: unknown, symbol: unknown) => {
    if (process.env.DSC_DESKTOP_SHOT !== undefined && process.env.DSC_DESKTOP_SHOT !== '') {
      process.stderr.write(`[selfcheck] 控件条颜色 ${String(bar)} ${String(symbol)}，发来自当前窗口=${event.sender === mainWindow?.webContents}\n`)
    }
    if (event.sender !== mainWindow?.webContents) return
    if (!isChromeColor(bar) || !isChromeColor(symbol) || !mainWindow) return
    mainWindow.setTitleBarOverlay({ color: bar, symbolColor: symbol, height: CAPTION_HEIGHT })
    mainWindow.setBackgroundColor(bar)
  })
}

// ── 窗口与应用 ────────────────────────────────────────────────────────────────

/** 记住的「还原态」窗口框：最大化期间不采集（那时 getBounds 是铺满工作区的假尺寸）。 */
let normalBounds: { width: number; height: number; x: number; y: number } | null = null

/**
 * 读记忆的窗口框。宽高不合法（手改坏/旧版本数据）退回默认；位置必须和某台
 * 显示器有交集——拔掉外接屏后残留的旧坐标会让窗口开在看不见的地方，
 * 这时只保留大小、位置交给系统居中。
 */
function loadWindowMemory(): { width: number; height: number; x?: number; y?: number; maximized: boolean } {
  const saved = readState().windowBounds
  const width = typeof saved?.width === 'number' && saved.width >= 960 ? Math.round(saved.width) : 1440
  const height = typeof saved?.height === 'number' && saved.height >= 640 ? Math.round(saved.height) : 940
  const x = typeof saved?.x === 'number' ? Math.round(saved.x) : Number.NaN
  const y = typeof saved?.y === 'number' ? Math.round(saved.y) : Number.NaN
  const onScreen = screen.getAllDisplays().some(
    (display) =>
      x < display.bounds.x + display.bounds.width &&
      x + width > display.bounds.x &&
      y < display.bounds.y + display.bounds.height &&
      y + height > display.bounds.y,
  )
  return {
    width,
    height,
    ...(onScreen ? { x, y } : {}),
    maximized: saved?.maximized === true,
  }
}

/**
 * 挂上 resize/move 采集与 close 落盘。落盘走 desktop.json 的合并写，只动
 * windowBounds 自己的字段；app.exit()（自检截图退出）不触发 close，所以
 * 自检运行不会把窗口记忆覆盖成自检窗口的尺寸。
 */
function rememberWindowBounds(win: BrowserWindow): void {
  normalBounds = win.getBounds()
  const track = (): void => {
    // 最小化时 Windows 会把窗口挪到 -32000,-32000，这份坐标绝不能记
    if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
      normalBounds = win.getBounds()
    }
  }
  win.on('resize', track)
  win.on('move', track)
  win.on('close', () => {
    writeState({ windowBounds: { ...(normalBounds ?? win.getBounds()), maximized: win.isMaximized() } })
  })
}

function createWindow(): void {
  const memory = loadWindowMemory()
  mainWindow = new BrowserWindow({
    width: memory.width,
    height: memory.height,
    ...(memory.x !== undefined ? { x: memory.x, y: memory.y } : {}),
    minWidth: 960,
    minHeight: 640,
    // 无边框：Windows 用原生 overlay 窗口控件，renderer 内留出拖拽区。
    // 窗口底色与控件区按深色主题起步；选浅色主题时 renderer 在外观生效那一刻
    // 把压平后的两个颜色报过来（IPC 频道 dsc:set-window-chrome）。
    backgroundColor: DARK_CHROME.bar,
    title: 'Muse Code',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: DARK_CHROME.bar,
      symbolColor: DARK_CHROME.symbol,
      height: CAPTION_HEIGHT,
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

  // 窗口记忆：先挂采集（种子 = 刚开好的还原态），再按记忆恢复最大化——
  // 顺序反了会把最大化尺寸当成还原态记下来
  rememberWindowBounds(mainWindow)
  if (memory.maximized) mainWindow.maximize()

  // 自检截图：DSC_DESKTOP_SHOT=<png 路径> 时，加载完成后截图并退出（自动化验证用）。
  // 必须在 loadFile/loadURL 之前注册，否则会错过 did-finish-load。
  const shotPath = process.env.DSC_DESKTOP_SHOT
  if (shotPath !== undefined && shotPath !== '') {
    // 原生窗口控件区不进 capturePage，只能整屏抓；抓屏时窗口要盖在别的窗口之上，
    // 所以 DSC_DESKTOP_SHOT_TOPMOST=1 时把它钉在最上层。show() 是被动的：自检常由
    // 脚本启动 exe，脚本给的 STARTUPINFO 里带 SW_HIDE 时窗口会开成隐藏的。
    if (process.env.DSC_DESKTOP_SHOT_TOPMOST === '1') {
      mainWindow.setAlwaysOnTop(true, 'screen-saver')
      mainWindow.show()
      mainWindow.focus()
    }
    const wait = Number.parseInt(process.env.DSC_DESKTOP_SHOT_DELAY ?? '4000', 10)
    const delay = Number.isNaN(wait) ? 4000 : wait
    // capturePage 在 GPU 合成不正常时可能永远不返回，因此挂个看门狗：自动化不能挂在这里
    mainWindow.webContents.once('did-finish-load', () => {
      process.stderr.write(`[selfcheck] 页面加载完成，${delay}ms 后截图 ${shotPath}\n`)
      const watchdog = setTimeout(() => {
        process.stderr.write('[selfcheck] 截图超时，强制退出\n')
        app.exit(1)
      }, delay + 25000)
      // 截图前先在渲染层跑一段脚本（DSC_DESKTOP_SHOT_EVAL）：用来点开一个有内容的
      // 旧会话，否则自检只拍得到启动时的空状态，聊天流和工具行的样式没法验证。
      const preScript = process.env.DSC_DESKTOP_SHOT_EVAL
      if (preScript !== undefined && preScript !== '') {
        // 脚本要赶在截图前跑完，所以默认提前 2 秒；要多会话来回切换的脚本
        // 用 DSC_DESKTOP_SHOT_EVAL_LEAD 把提前量放大。
        const lead = Number.parseInt(process.env.DSC_DESKTOP_SHOT_EVAL_LEAD ?? '2000', 10)
        setTimeout(() => {
          void mainWindow?.webContents
            .executeJavaScript(preScript)
            .then((value: unknown) =>
              process.stderr.write(`[selfcheck] 预跑脚本完成：${JSON.stringify(value) ?? '无返回值'}\n`)
            )
            .catch((error: unknown) => process.stderr.write(`[selfcheck] 预跑脚本失败：${String(error)}\n`))
        }, Math.max(0, delay - (Number.isNaN(lead) ? 2000 : lead)))
      }
      // 原生窗口控件条（最小化/最大化/关闭）由系统画，capturePage 拍不到，只能整屏抓
      // 再裁。坐标换算放在这里做：getBounds 给的是 DIP，乘所在显示器的 scaleFactor 才是
      // 屏幕像素，外部抓屏脚本容易被 DPI 虚拟化绕晕。
      const stripPath = process.env.DSC_DESKTOP_SHOT_STRIP
      if (stripPath !== undefined && stripPath !== '') {
        setTimeout(() => {
          void captureCaptionStrip(stripPath)
        }, Math.max(0, delay - 3000))
      }
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
        title: 'Muse Code 还在后台运行',
        content: '点击托盘图标回到窗口，右键图标可完全退出；此提示仅出现一次，关窗行为可在设置 → 通用中修改',
      })
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * 自检用：整屏抓图后裁出窗口右上角的原生控件条，写出 PNG，并把取样到的颜色打进日志。
 *
 * 三个窗口按钮由系统画，capturePage 只拍网页，拍不到它们；控件条有没有跟着主题换色，
 * 只能靠整屏抓图来看。裁剪坐标用 getBounds()（DIP）乘所在显示器的 scaleFactor 换算，
 * 交给外部脚本换算会被 DPI 虚拟化绕晕。
 *
 * @param stripPath 要写出的 PNG 路径
 */
async function captureCaptionStrip(stripPath: string): Promise<void> {
  const win = mainWindow
  if (!win) return
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const scale = display.scaleFactor
  const [source] = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
  })
  if (!source) {
    process.stderr.write('[selfcheck] 整屏抓图没拿到源\n')
    return
  }
  // 控件条贴着窗口右上角：取右端 260 DIP 宽、70 DIP 高，够装下三个按钮还留点余量
  const image = source.thumbnail.crop({
    x: Math.round((display.bounds.x + bounds.x + bounds.width - 260) * scale),
    y: Math.round((display.bounds.y + bounds.y) * scale),
    width: Math.round(260 * scale),
    height: Math.round(70 * scale),
  })
  mkdirSync(resolve(stripPath, '..'), { recursive: true })
  writeFileSync(stripPath, image.toPNG())
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  // toBitmap() 在 Windows 上的字节序是 BGRA
  const hexAt = (px: number, py: number): string => {
    const i = (py * width + px) * 4
    const part = (offset: number): string => bitmap[i + offset].toString(16).padStart(2, '0')
    return `#${part(2)}${part(1)}${part(0)}`
  }
  const row = new Map<string, number>()
  for (let px = 0; px < width; px += 2) {
    const hex = hexAt(px, 4)
    row.set(hex, (row.get(hex) ?? 0) + 1)
  }
  const bar = [...row.entries()].sort((a, b) => b[1] - a[1])[0]
  let darkest = hexAt(0, 0)
  let darkestLum = Number.POSITIVE_INFINITY
  for (let py = 0; py < height; py += 2) {
    for (let px = 0; px < width; px += 2) {
      const i = (py * width + px) * 4
      const lum = 0.2126 * bitmap[i + 2] + 0.7152 * bitmap[i + 1] + 0.0722 * bitmap[i]
      if (lum < darkestLum) {
        darkestLum = lum
        darkest = hexAt(px, py)
      }
    }
  }
  process.stderr.write(
    `[selfcheck] 控件条 ${width}x${height} 像素已写出 ${stripPath}；窗口可见=${win.isVisible()} 最小化=${win.isMinimized()} 位置=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} 缩放=${scale}；顶行主色 ${bar[0]}（${bar[1]}/${width / 2} 点），最暗像素 ${darkest}\n`,
  )
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
  // Windows 的 toast 通知按 AppUserModelID 归属应用：不设的话通知挂在 Electron
  // 名下（打包版上会被丢进「Windows 通知」杂项，图标也不对）。与 electron-builder.yml 的 appId 一致。
  app.setAppUserModelId('io.dsc.desktop')

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
