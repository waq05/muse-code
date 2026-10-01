/**
 * dock（右侧栏）：对照 dsh 右侧栏的多页签面板。
 *
 * 结构（布局真源在 dock-model.ts，纯模型可单测）：
 *   - 页签条：chip（图标 + 标题）可点击聚焦、中键关闭、右键菜单（关闭 / 向右分栏 /
 *     收回分栏）、可拖拽跨窗格；条尾是 chrome 两钮——全屏切换与收起（dsh 同款，
 *     不再有 ✕ 关面板）；格内没有「开始」页时画 `+` 钮（就地开/聚焦一张 guide）。
 *   - 「开始」页（guide）：罗盘 + 入口卡，选中一项就地替换成那个页面——它是门面，
 *     不是常驻内容。
 *   - 页面体挂载规则：终端按页签 keepMounted（切页签/窗格只藏不卸，进程与输出存活；
 *     首次可见才 spawn，卸载才 kill）；浏览器 / 文件 / Git 只在激活页签挂载（浏览器的
 *     WebContentsView 是主进程单例，卸载即收起，URL 记忆在 localStorage）。
 *   - 展示：贴边（占正文轨道）与全屏（盖住顶栏以下、保留轨道宽度）两种，窄视口
 *     （<768px，对齐 dsh）自动全屏；收起是整块滑出右缘，不卸载内容。
 *
 * @module desktop/renderer/Dock
 */
import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { dsc, type RuntimeProxy } from './bridge.js'
import { readTerminalFontSize, readTerminalTheme, watchAppearance } from './components/terminalTheme.js'
import {
  IconBranch,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconGlobe,
  IconRefresh,
  IconSidebar,
  IconTerminal,
} from './icons.js'
import {
  canAddTab,
  type DockActions,
  type DockPane,
  type DockSurface,
  type DockTab,
  type DockTabKind,
} from './dock-model.js'

/** 终端 shell 候选（与宿主 desktop-dock 的白名单一致；prompt 为 renderer 本地提示符）。 */
const SHELL_OPTIONS = [
  { value: 'powershell', label: 'PowerShell', prompt: 'PS>' },
  { value: 'pwsh', label: 'PowerShell 7 (pwsh)', prompt: 'PS>' },
  { value: 'cmd', label: 'CMD', prompt: '>' },
  { value: 'bash', label: 'Git Bash', prompt: '$' },
  { value: 'node', label: 'Node REPL', prompt: '>' },
] as const

type ShellValue = (typeof SHELL_OPTIONS)[number]['value']

const DOCK_MIN_WIDTH = 300
const DOCK_MAX_WIDTH = 820

/** 窄视口自动全屏的阈值（对齐 dsh 的 autoFullscreen）。 */
const NARROW_VIEWPORT = 768

interface FsEntry {
  name: string
  dir: boolean
  size: number
}

interface GitStatus {
  branch: string
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

/** 页签 chip 上的图标与标题；guide 的图形在 GuideBody 旁边单独画。 */
const KIND_META: Record<DockTabKind, { title: string; icon: (props: { size: number }) => JSX.Element }> = {
  guide: { title: '开始', icon: IconGlobe },
  terminal: { title: '终端', icon: IconTerminal },
  browser: { title: '浏览器', icon: IconGlobe },
  files: { title: '文件', icon: IconFolder },
  git: { title: 'Git', icon: IconBranch },
}

/** 「开始」页的入口卡（对照 dsh 的 guide entries；最多四张，都带描述）。 */
const GUIDE_ENTRIES: { kind: DockTabKind; title: string; description: string; tone: string; shortcut?: string }[] = [
  { kind: 'files', title: '工作区文件', description: '浏览会话工作区的文件', tone: 'tone-folder', shortcut: 'Ctrl + P' },
  { kind: 'terminal', title: '新建终端', description: '在会话工作区运行命令', tone: 'tone-terminal', shortcut: 'Ctrl + `' },
  { kind: 'browser', title: '浏览器', description: '浏览网页', tone: 'tone-browser', shortcut: 'Ctrl + T' },
  { kind: 'git', title: 'Git 管理', description: '分支、暂存与提交', tone: 'tone-git' },
]

export function Dock(props: {
  surface: DockSurface
  actions: DockActions
  cwd: string
  proxy: RuntimeProxy
  width: number
  onResize(width: number): void
}): JSX.Element {
  const { surface, actions } = props
  // 窄视口自动全屏（对齐 dsh）：只影响展示，不写回布局
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_VIEWPORT)
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < NARROW_VIEWPORT)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const fullscreen = narrow || surface.mode === 'fullscreen'

  // 右键菜单：哪张页签 + 弹在屏幕哪个点（fixed 定位贴着指针）
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const setMenuTab = useCallback((tabId: string | null, x?: number, y?: number): void => {
    setMenu(tabId === null ? null : { tabId, x: x ?? 0, y: y ?? 0 })
  }, [])

  // 左边缘拖拽调宽：mousedown 后挂 window 监听，clamp 到 [300, 820]，双击复位
  const startResize = (event: ReactMouseEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = props.width
    const onMove = (move: MouseEvent): void => {
      props.onResize(Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, startWidth - (move.clientX - startX))))
    }
    const onUp = (): void => {
      document.body.classList.remove('resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 分栏拖拽条：按指针在窗格行里的横坐标比例调 fraction
  const panesRef = useRef<HTMLDivElement | null>(null)
  const startSplit = (event: ReactMouseEvent): void => {
    event.preventDefault()
    const host = panesRef.current
    if (host === null) return
    const onMove = (move: MouseEvent): void => {
      const rect = host.getBoundingClientRect()
      if (rect.width === 0) return
      actions.setFraction((move.clientX - rect.left) / rect.width)
    }
    const onUp = (): void => {
      document.body.classList.remove('resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <aside
      className={`dock${fullscreen ? ' mode-fullscreen' : ''}${surface.expanded ? '' : ' collapsed'}`}
      style={fullscreen ? undefined : { width: props.width, marginRight: surface.expanded ? undefined : -props.width }}
      aria-hidden={!surface.expanded || undefined}
    >
      {!fullscreen && (
        <div
          className="dock-resizer"
          data-tip="拖拽调整宽度，双击复位"
          onMouseDown={startResize}
          onDoubleClick={() => props.onResize(420)}
        />
      )}
      <div className="dock-panes" ref={panesRef}>
        {surface.panes.map((item, index) => (
          <Pane
            key={item.id}
            surface={surface}
            pane={item}
            active={item.id === surface.activePaneId}
            actions={actions}
            cwd={props.cwd}
            proxy={props.proxy}
            fraction={surface.fraction}
            first={index === 0}
            chrome={index === surface.panes.length - 1}
            menuTab={menu}
            setMenuTab={setMenuTab}
          />
        ))}
        {surface.panes.length === 2 && (
          <div
            className="dock-split"
            data-tip="拖拽调整分栏，双击收回分栏"
            onMouseDown={startSplit}
            onDoubleClick={actions.unsplit}
          />
        )}
      </div>
      {menu !== null && <div className="menu-backdrop" onClick={() => setMenu(null)} />}
      {menu !== null && (
        <div
          className="row-menu dock-tab-menu"
          style={{ position: 'fixed', left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            className="menu-item"
            onClick={() => {
              actions.splitPane(menu.tabId)
              setMenu(null)
            }}
          >
            向右分栏
          </button>
          <button
            className="menu-item"
            onClick={() => {
              actions.unsplit()
              setMenu(null)
            }}
          >
            收回分栏
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              actions.closeTab(menu.tabId)
              setMenu(null)
            }}
          >
            关闭页签
          </button>
        </div>
      )}
    </aside>
  )
}

/** 一个窗格：页签条（chips + 加号 + chrome）与页面体。 */
function Pane(props: {
  surface: DockSurface
  pane: DockPane
  active: boolean
  actions: DockActions
  cwd: string
  proxy: RuntimeProxy
  fraction: number
  first: boolean
  /** chrome 两钮（全屏/收起）只骑在最右窗格的条尾（对照 dsh 的 top-right pane seat）。 */
  chrome: boolean
  menuTab: { tabId: string; x: number; y: number } | null
  setMenuTab(tabId: string | null, x?: number, y?: number): void
}): JSX.Element {
  const { surface, pane, actions } = props
  return (
    <section
      className="dock-pane"
      style={
        surface.panes.length === 2
          ? { flex: `0 0 calc(${(props.first ? props.fraction : 1 - props.fraction) * 100}% - 4px)` }
          : undefined
      }
      onMouseDown={() => {
        if (!props.active) actions.focusPane(pane.id)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        const tabId = event.dataTransfer.getData('text/plain')
        if (tabId !== '') actions.placeTab(tabId, pane.id)
      }}
    >
      <div className="dock-strip">
        {pane.tabs.map((tab) => (
          <Chip
            key={tab.id}
            tab={tab}
            on={props.active && pane.activeTabId === tab.id}
            actions={actions}
            onMenu={props.setMenuTab}
            menuOpen={props.menuTab?.tabId === tab.id}
          />
        ))}
        {canAddTab(pane) && (
          <button className="dock-add" data-tip="新标签页" onClick={() => actions.openTab('guide')}>
            +
          </button>
        )}
        <span className="dock-strip-fill" />
        {props.chrome && (
          <>
            <button
              className="dock-chrome-btn"
              data-tip={surface.mode === 'fullscreen' ? '退出全屏' : '全屏'}
              onClick={actions.toggleMode}
            >
              {surface.mode === 'fullscreen' ? <ExitFullscreenGlyph /> : <FullscreenGlyph />}
            </button>
            <button className="dock-chrome-btn" data-tip="收起侧边栏" onClick={() => actions.setExpanded(false)}>
              <IconSidebar size={15} />
            </button>
          </>
        )}
      </div>
      <div className="dock-pane-body">
        {pane.tabs.map((tab) => {
          const visible = props.active && pane.activeTabId === tab.id
          if (tab.kind === 'guide') {
            return visible ? <GuideBody key={tab.id} actions={actions} /> : null
          }
          if (tab.kind === 'terminal') {
            // 终端 keepMounted：藏起来不卸载，进程与输出都活着
            return (
              <div key={tab.id} className="dock-tab-body" style={visible ? undefined : { display: 'none' }}>
                <TerminalPane cwd={props.cwd} proxy={props.proxy} visible={visible} />
              </div>
            )
          }
          // 单例页签只在激活时挂载：浏览器是主进程单例 WebContentsView，卸载即收起
          return visible ? (
            <div key={tab.id} className="dock-tab-body">
              {tab.kind === 'browser' && <BrowserPane />}
              {tab.kind === 'files' && <FilesPane cwd={props.cwd} proxy={props.proxy} />}
              {tab.kind === 'git' && <GitPane cwd={props.cwd} proxy={props.proxy} />}
            </div>
          ) : null
        })}
      </div>
    </section>
  )
}

/** 页签 chip：图标 + 标题，hover 出关闭点；中键关闭；拖拽搬移；右键开菜单。 */
function Chip(props: {
  tab: DockTab
  on: boolean
  actions: DockActions
  onMenu(tabId: string | null, x: number, y: number): void
  menuOpen: boolean
}): JSX.Element {
  const meta = KIND_META[props.tab.kind]
  const Icon = meta.icon
  return (
    <button
      className={`dock-chip${props.on ? ' on' : ''}${props.menuOpen ? ' menu' : ''}`}
      onClick={() => props.actions.focusTab(props.tab.id)}
      onAuxClick={(event) => {
        if (event.button === 1) props.actions.closeTab(props.tab.id)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        props.onMenu(props.menuOpen ? null : props.tab.id, event.clientX, event.clientY)
      }}
      draggable
      onDragStart={(event) => event.dataTransfer.setData('text/plain', props.tab.id)}
      title={meta.title}
    >
      <Icon size={13} />
      <span className="dock-chip-label">{meta.title}</span>
      <span
        className="dock-chip-close"
        data-tip="关闭页签"
        onClick={(event) => {
          event.stopPropagation()
          props.actions.closeTab(props.tab.id)
        }}
      >
        ✕
      </span>
    </button>
  )
}

/** 「开始」页：罗盘 + 入口卡；选一项就地替换这张 guide（dsh 的 replaceTab 路径）。 */
function GuideBody(props: { actions: DockActions }): JSX.Element {
  return (
    <div className="dock-guide">
      <span className="dock-guide-hero" aria-hidden="true">
        <CompassGlyph />
      </span>
      <div className="dock-guide-cards">
        {GUIDE_ENTRIES.map((entry) => (
          <button key={entry.kind} className="dock-guide-entry" onClick={() => props.actions.openTab(entry.kind, { replaceGuide: true })}>
            <span className={`dock-guide-icon ${entry.tone}`}>
              {entry.kind === 'files' && <IconFolder size={17} />}
              {entry.kind === 'terminal' && <IconTerminal size={17} />}
              {entry.kind === 'browser' && <IconGlobe size={17} />}
              {entry.kind === 'git' && <IconBranch size={17} />}
            </span>
            <span className="dock-guide-text">
              <span className="dock-guide-title">{entry.title}</span>
              <span className="dock-guide-desc">{entry.description}</span>
            </span>
            {entry.shortcut !== undefined && <kbd className="dock-guide-key">{entry.shortcut}</kbd>}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 罗盘（对照 dsh 开始页的 hero 图形）：圆环 + 指针。 */
function CompassGlyph(): JSX.Element {
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.4" opacity="0.45" />
      <path d="M15.8 8.2 13.4 13.4 8.2 15.8 10.6 10.6Z" fill="currentColor" opacity="0.6" />
    </svg>
  )
}

/** 全屏展开图形（对照 dsh 的 FullscreenGlyph：四角向外的取景框）。 */
function FullscreenGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.33 10.4v2.76c0 .28.22.5.5.5h2.66v1H2.83a1.5 1.5 0 0 1-1.5-1.5V10.4h1Zm12.34 2.76a1.5 1.5 0 0 1-1.5 1.5h-2.67v-1h2.67a.5.5 0 0 0 .5-.5V10.4h1v2.76ZM13.17 1.33a1.5 1.5 0 0 1 1.5 1.5v2.57h-1V2.83a.5.5 0 0 0-.5-.5h-2.67v-1h2.67ZM5.5 2.33H2.83a.5.5 0 0 0-.5.5v2.57h-1V2.83a1.5 1.5 0 0 1 1.5-1.5H5.5v1Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** 退出全屏图形（两个对角的收拢箭头）。 */
function ExitFullscreenGlyph(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9 2.5V6c0 .27.1.52.29.71.19.18.44.29.71.29h3.5" stroke="currentColor" />
      <path d="M7 13.5V10a1 1 0 0 0-1-1H2.5" stroke="currentColor" />
    </svg>
  )
}

// ── 终端（宿主 desktop-dock 服务；管道模式，行缓冲输入） ─────────────────────

function TerminalPane(props: { cwd: string; proxy: RuntimeProxy; visible: boolean }): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const [session, setSession] = useState<{ id: string; exited: boolean } | null>(null)
  const [error, setError] = useState('')
  const [shell, setShell] = useState<ShellValue>(() => {
    const saved = localStorage.getItem('dsc.dockShell')
    return SHELL_OPTIONS.some((option) => option.value === saved) ? (saved as ShellValue) : 'powershell'
  })
  const shellMeta = SHELL_OPTIONS.find((option) => option.value === shell) ?? SHELL_OPTIONS[0]!
  // dock 常驻挂载（收起只是滑出屏幕），不能一开应用就 spawn：首次可见才启动进程
  const [booted, setBooted] = useState(false)
  useEffect(() => {
    if (props.visible && !booted) setBooted(true)
  }, [props.visible, booted])

  useEffect(() => {
    if (!booted || props.cwd === '') return
    const term = new Terminal({
      fontSize: readTerminalFontSize(),
      fontFamily: 'Consolas, "Courier New", monospace',
      cursorBlink: true,
      theme: readTerminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    if (host.current === null) return
    term.open(host.current)
    fit.fit()
    fitRef.current = () => fit.fit()
    // 外观偏好变了就照令牌重算并推给 xterm：appearance.ts 把三项写在 <html> 的
    // data-theme、data-density 与内联 --dsc-font-scale 上，这里只跟着读，不另起一套状态。
    // theme 每轮都得是新对象（xterm 对 theme 按引用比较，同对象赋值会被忽略）。
    const offAppearance = watchAppearance(() => {
      term.options.theme = readTerminalTheme()
      const size = readTerminalFontSize()
      if (size === term.options.fontSize) return
      term.options.fontSize = size
      fit.fit()
    })
    term.writeln(`\x1b[90m${shellMeta.label} · 管道模式：输入命令回车执行，不支持交互式全屏程序\x1b[0m\r\n`)

    let disposed = false
    let currentId = ''
    // 行缓冲：管道 stdin 无行编辑，回车前由 renderer 维护输入行
    let line = ''
    let promptShown = false

    const showPrompt = (): void => {
      if (!promptShown) {
        term.write(`\x1b[90m${shellMeta.prompt}\x1b[0m `)
        promptShown = true
      }
    }
    const sendLine = async (text: string): Promise<void> => {
      promptShown = false
      try {
        await props.proxy.dock('term-input', { id: currentId, data: `${text}\n` })
      } catch (error) {
        term.write(`\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`)
      }
    }

    const offData = dsc.onDockData(({ id, data }) => {
      if (disposed || id !== currentId) return
      // shell 管道模式不回显命令本身，输出后补提示符
      term.write(data.replace(/\n/g, '\r\n'))
      if (data.includes('\n')) showPrompt()
    })

    void props.proxy
      .dock('term-spawn', { cwd: props.cwd, shell })
      .then((result) => {
        const id = String((result as { id?: string }).id ?? '')
        if (id === '') {
          term.write(`\r\n\x1b[31m终端启动失败\x1b[0m\r\n`)
          return
        }
        currentId = id
        setSession({ id, exited: false })
        showPrompt()
      })
      .catch((error: unknown) => {
        // 常见失败：目标 shell 未安装（如 pwsh 未装、Git Bash 不在 PATH）
        setError(error instanceof Error ? error.message : String(error))
        term.write(`\r\n\x1b[31m${shellMeta.label} 启动失败：${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`)
      })

    const dataHandler = term.onData((data) => {
      if (currentId === '') return
      for (const char of data) {
        if (char === '\r') {
          // 回车：本地回显换行，发送整行
          term.write('\r\n')
          const command = line
          line = ''
          if (command.trim() === '') {
            showPrompt()
            void props.proxy.dock('term-input', { id: currentId, data: '\n' })
          } else {
            void sendLine(command)
          }
        } else if (char === '\u007f') {
          // 退格：本地编辑行缓冲
          if (line.length > 0) {
            line = line.slice(0, -1)
            term.write('\b \b')
          }
        } else if (char === '\u0003') {
          // Ctrl+C：取消当前行（管道模式无法中断运行中的命令）
          term.write('^C')
          line = ''
          showPrompt()
        } else {
          line += char
          term.write(char) // 本地回显
        }
      }
    })

    return () => {
      disposed = true
      offAppearance()
      dataHandler.dispose()
      offData()
      fitRef.current = null
      if (currentId !== '') void props.proxy.dock('term-kill', { id: currentId }).catch(() => {})
      term.dispose()
    }
  }, [booted, props.cwd, props.proxy, shell, shellMeta])

  // 重新可见时重排：display:none 期间 xterm 量到的尺寸是 0
  useEffect(() => {
    if (props.visible) fitRef.current?.()
  }, [props.visible])

  const pickShell = (value: ShellValue): void => {
    localStorage.setItem('dsc.dockShell', value)
    setShell(value)
    setError('')
  }

  return (
    <div className="term-pane">
      <div className="term-bar">
        <span className="term-bar-label">Shell</span>
        <select value={shell} onChange={(event) => pickShell(event.target.value as ShellValue)}>
          {SHELL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div ref={host} className="term-host" />
      {session?.exited === true && <div className="term-exited">会话已退出，重新打开面板或切换会话后可新建</div>}
      {error !== '' && <div className="notice">{error}</div>}
    </div>
  )
}

// ── 浏览器 ────────────────────────────────────────────────────────────────────

function BrowserPane(): JSX.Element {
  const holder = useRef<HTMLDivElement | null>(null)
  // URL 记忆在 localStorage：页签切走会卸载这块面板（WebContentsView 是单例），
  // 重开时回到上次浏览的地址，而不是每次都回首页
  const [url, setUrl] = useState(() => localStorage.getItem('dsc.dock.browserUrl') ?? 'https://www.bing.com')
  const [address, setAddress] = useState(() => localStorage.getItem('dsc.dock.browserUrl') ?? 'https://www.bing.com')

  useEffect(() => {
    const element = holder.current
    if (element === null) return
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      void dsc.dockBrowser(true, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    const offState = dsc.onBrowserState((state) => {
      setUrl(state.url)
      setAddress(state.url)
      localStorage.setItem('dsc.dock.browserUrl', state.url)
    })
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      offState()
      void dsc.dockBrowser(false)
    }
  }, [])

  const navigate = (action: 'load' | 'back' | 'forward' | 'reload'): void => {
    void dsc.browserNav(action === 'load' ? address : url, action)
  }

  return (
    <div className="browser-pane">
      <div className="browser-bar">
        <button className="icon-btn" data-tip="后退" onClick={() => navigate('back')}>‹</button>
        <button className="icon-btn" data-tip="前进" onClick={() => navigate('forward')}>›</button>
        <button className="icon-btn" data-tip="刷新" onClick={() => navigate('reload')}>
          <IconRefresh size={13} />
        </button>
        <input
          className="browser-url"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') navigate('load')
          }}
          spellCheck={false}
        />
      </div>
      {/* WebContentsView 原生层渲染在这块区域之上 */}
      <div ref={holder} className="browser-holder" />
    </div>
  )
}

// ── 文件列表 ──────────────────────────────────────────────────────────────────

function FilesPane({ cwd, proxy }: { cwd: string; proxy: RuntimeProxy }): JSX.Element {
  const [dir, setDir] = useState('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [preview, setPreview] = useState<{ path: string; text: string; tooLarge: boolean } | null>(null)
  const [error, setError] = useState('')
  const root = dir === '' ? cwd : dir

  const load = useCallback(
    (target: string): void => {
      void proxy
        .dock('fs-list', { dir: target })
        .then((data) => {
          const result = data as { cwd: string; entries: FsEntry[] }
          setDir(result.cwd)
          setEntries(result.entries)
          setError('')
        })
        .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
    },
    [proxy],
  )

  useEffect(() => {
    if (cwd !== '') load('')
  }, [cwd, load])

  const openFile = (entry: FsEntry): void => {
    void proxy
      .dock('fs-read', { file: `${dir}\\${entry.name}` })
      .then((data) => setPreview(data as { path: string; text: string; tooLarge: boolean }))
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
  }

  const up = (): void => {
    const parent = dir.replace(/[\\/][^\\/]+$/, '')
    if (parent.toLowerCase().startsWith(cwd.toLowerCase())) load(parent)
  }

  return (
    <div className="files-pane">
      <div className="files-bar">
        <button className="icon-btn" data-tip="上一级" onClick={up} disabled={dir === '' || dir.toLowerCase() === cwd.toLowerCase()}>
          ↑
        </button>
        <span className="files-cwd" data-tip={dir || cwd}>
          {(dir || cwd).slice(cwd.length)}
        </span>
      </div>
      {error !== '' && <div className="notice">{error}</div>}
      <div className="files-list">
        {entries.map((entry) => (
          <button
            key={entry.name}
            className="file-row"
            onDoubleClick={() => {
              if (entry.dir) load(`${dir}\\${entry.name}`)
              else openFile(entry)
            }}
            onClick={() => {
              if (entry.dir) load(`${dir}\\${entry.name}`)
            }}
          >
            <span className="file-icon">{entry.dir ? <IconChevronRight size={13} /> : '·'}</span>
            <span className="file-name">{entry.name}</span>
            {!entry.dir && <span className="file-size">{formatSize(entry.size)}</span>}
          </button>
        ))}
      </div>
      {preview !== null && (
        <div className="file-preview">
          <div className="file-preview-head">
            <span>{preview.path.slice(cwd.length)}</span>
            <button className="icon-btn" onClick={() => setPreview(null)}>✕</button>
          </div>
          <pre>{preview.tooLarge ? '文件过大，仅支持预览 512KB 以内的文件' : preview.text.slice(0, 20000)}</pre>
        </div>
      )}
    </div>
  )
}

// ── Git ───────────────────────────────────────────────────────────────────────

function GitPane({ cwd, proxy }: { cwd: string; proxy: RuntimeProxy }): JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback((): void => {
    if (cwd === '') return
    void proxy
      .dock('git-status', {})
      .then((data) => {
        setStatus(data as GitStatus)
        setError('')
      })
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
    void proxy
      .dock('git-log', {})
      .then((data) => setLog(String((data as { log?: string }).log ?? '').split('\n').filter(Boolean)))
      .catch(() => setLog([]))
  }, [cwd, proxy])

  useEffect(() => {
    refresh()
  }, [refresh])

  const act = (op: string, payload: Record<string, unknown>, after?: () => void): void => {
    setBusy(true)
    void proxy
      .dock(op, payload)
      .then(() => {
        setError('')
        after?.()
        refresh()
      })
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false))
  }

  const fileOf = (entry: string): string => entry.replace(/^[AMDRCU?]+\s+/, '')

  return (
    <div className="git-pane">
      {error !== '' && <div className="notice">{error}</div>}
      {status === null ? (
        <div className="trace-empty">{busy ? '读取中…' : '此目录不是 git 仓库，或读取失败。'}</div>
      ) : (
        <>
          <div className="git-branch">
            <span className="round-no">{status.branch}</span>
            <span className="git-count">{status.staged.length + status.unstaged.length + status.untracked.length} 处更改</span>
          </div>
          <GitGroup
            title={`已暂存 (${status.staged.length})`}
            files={status.staged}
            action={{ label: '−', title: '取消暂存', run: (file) => act('git-unstage', { files: [fileOf(file)] }) }}
          />
          <GitGroup
            title={`未暂存 (${status.unstaged.length})`}
            files={status.unstaged}
            action={{ label: '+', title: '暂存', run: (file) => act('git-stage', { files: [fileOf(file)] }) }}
          />
          <GitGroup
            title={`未跟踪 (${status.untracked.length})`}
            files={status.untracked}
            action={{ label: '+', title: '暂存', run: (file) => act('git-stage', { files: [file] }) }}
          />
          <div className="git-commit">
            <textarea
              rows={2}
              placeholder="提交信息，遵循 feat:/fix:/chore: 规范"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              disabled={busy || status.staged.length === 0}
            />
            <button
              className="btn-primary"
              disabled={busy || message.trim() === '' || status.staged.length === 0}
              onClick={() =>
                act('git-commit', { message: message.trim() }, () => setMessage(''))
              }
            >
              提交
            </button>
          </div>
          <div className="git-log">
            {log.map((line) => {
              const [hash, author, date, ...rest] = line.split('\t')
              return (
                <div key={hash} className="git-log-row">
                  <code>{hash}</code>
                  <span className="git-log-msg">{rest.join(' ')}</span>
                  <span className="git-log-meta">
                    {author} · {date}
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function GitGroup(props: {
  title: string
  files: string[]
  action: { label: string; title: string; run(file: string): void }
}): JSX.Element {
  const [open, setOpen] = useState(true)
  if (props.files.length === 0) return <></>
  return (
    <div className="git-group">
      <button className="git-group-head" onClick={() => setOpen((current) => !current)}>
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />} {props.title}
      </button>
      {open &&
        props.files.map((file) => (
          <div key={file} className="git-file">
            <span className="git-file-name" data-tip={file}>
              {file}
            </span>
            <button className="icon-btn" data-tip={props.action.title} onClick={() => props.action.run(file)}>
              {props.action.label}
            </button>
          </div>
        ))}
    </div>
  )
}

function formatSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`
  if (size >= 1024) return `${(size / 1024).toFixed(0)}KB`
  return `${size}B`
}
