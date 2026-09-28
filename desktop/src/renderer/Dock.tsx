/**
 * dock：主区右侧活动面板——内置终端（xterm + node-pty）、内置浏览器
 * （WebContentsView 原生层，renderer 提供 rect）、工作区文件列表、Git 管理
 * （数据经宿主 desktop-dock 服务）。
 *
 * @module desktop/renderer/Dock
 */
import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { dsc, type RuntimeProxy } from './bridge.js'
import { IconChevronDown, IconChevronRight, IconRefresh } from './icons.js'

type DockTab = 'terminal' | 'browser' | 'files' | 'git'

const TABS: { value: DockTab; label: string }[] = [
  { value: 'terminal', label: '终端' },
  { value: 'browser', label: '浏览器' },
  { value: 'files', label: '文件' },
  { value: 'git', label: 'Git' },
]

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

export function Dock(props: {
  visible: boolean
  cwd: string
  proxy: RuntimeProxy
  width: number
  onResize(width: number): void
  onClose(): void
}): JSX.Element {
  const [tab, setTab] = useState<DockTab>('terminal')
  const { cwd, proxy } = props

  // 左边缘拖拽调宽：mousedown 后挂 window 监听，clamp 到 [300, 820]，双击复位
  const startResize = (event: ReactMouseEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = props.width
    const onMove = (move: MouseEvent): void => {
      props.onResize(Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, startWidth + (startX - move.clientX))))
    }
    const onUp = (): void => {
      document.body.classList.remove('dock-resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    document.body.classList.add('dock-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <aside className="dock" style={{ width: props.width }}>
      <div
        className="dock-resizer"
        title="拖拽调整宽度（双击复位）"
        onMouseDown={startResize}
        onDoubleClick={() => props.onResize(420)}
      />
      <div className="dock-tabs">
        {TABS.map((item) => (
          <button key={item.value} className={tab === item.value ? 'on' : ''} onClick={() => setTab(item.value)}>
            {item.label}
          </button>
        ))}
        <button className="dock-close" title="收起面板" onClick={props.onClose}>
          ✕
        </button>
      </div>
      <div className="dock-body">
        {tab === 'terminal' && <TerminalPane cwd={cwd} proxy={proxy} />}
        {tab === 'browser' && <BrowserPane />}
        {tab === 'files' && <FilesPane cwd={props.cwd} proxy={props.proxy} />}
        {tab === 'git' && <GitPane cwd={props.cwd} proxy={props.proxy} />}
      </div>
    </aside>
  )
}

// ── 终端（宿主 desktop-dock 服务；管道模式，行缓冲输入） ─────────────────────

function TerminalPane({ cwd, proxy }: { cwd: string; proxy: RuntimeProxy }): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const [session, setSession] = useState<{ id: string; exited: boolean } | null>(null)
  const [error, setError] = useState('')
  const [shell, setShell] = useState<ShellValue>(() => {
    const saved = localStorage.getItem('dsc.dockShell')
    return SHELL_OPTIONS.some((option) => option.value === saved) ? (saved as ShellValue) : 'powershell'
  })
  const shellMeta = SHELL_OPTIONS.find((option) => option.value === shell) ?? SHELL_OPTIONS[0]!

  useEffect(() => {
    if (cwd === '') return
    const term = new Terminal({
      fontSize: 12.5,
      fontFamily: 'Consolas, "Courier New", monospace',
      cursorBlink: true,
      theme: { background: '#101013', foreground: '#cfd3d6', cursor: '#8ea1ff', selectionBackground: 'rgba(77,107,254,0.3)' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    if (host.current === null) return
    term.open(host.current)
    fit.fit()
    term.writeln(`\x1b[90m${shellMeta.label} · 管道模式：输入命令回车执行（不支持交互式全屏程序）\x1b[0m\r\n`)

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
        await proxy.dock('term-input', { id: currentId, data: `${text}\n` })
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

    void proxy
      .dock('term-spawn', { cwd, shell })
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
            void proxy.dock('term-input', { id: currentId, data: '\n' })
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
      dataHandler.dispose()
      offData()
      if (currentId !== '') void proxy.dock('term-kill', { id: currentId }).catch(() => {})
      term.dispose()
    }
  }, [cwd, proxy, shell, shellMeta])

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
      {session?.exited === true && <div className="term-exited">会话已退出（切换 tab 或收起面板后重开可新建）</div>}
      {error !== '' && <div className="notice">{error}</div>}
    </div>
  )
}

// ── 浏览器 ────────────────────────────────────────────────────────────────────

function BrowserPane(): JSX.Element {
  const holder = useRef<HTMLDivElement | null>(null)
  const [url, setUrl] = useState('https://www.bing.com')
  const [address, setAddress] = useState('https://www.bing.com')

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
        <button className="icon-btn" title="后退" onClick={() => navigate('back')}>‹</button>
        <button className="icon-btn" title="前进" onClick={() => navigate('forward')}>›</button>
        <button className="icon-btn" title="刷新" onClick={() => navigate('reload')}>
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
        <button className="icon-btn" title="上一级" onClick={up} disabled={dir === '' || dir.toLowerCase() === cwd.toLowerCase()}>
          ↑
        </button>
        <span className="files-cwd" title={dir || cwd}>
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
          <pre>{preview.tooLarge ? '（文件过大，仅支持 ≤512KB 预览）' : preview.text.slice(0, 20000)}</pre>
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
        <div className="trace-empty">{busy ? '读取中…' : '此目录不是 git 仓库（或读取失败）。'}</div>
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
              placeholder="提交信息（feat:/fix:/chore: ...）"
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
            <span className="git-file-name" title={file}>
              {file}
            </span>
            <button className="icon-btn" title={props.action.title} onClick={() => props.action.run(file)}>
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
