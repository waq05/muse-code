/**
 * 顶层界面：侧栏 + 顶栏（标题/对话轨迹 tab）+ 居中消息流 + 输入区 + 状态栏。
 * 布局对照 dsh 桌面端；空会话显示欢迎态；命令派发复用 dsc 的 runCommand。
 *
 * @module desktop/renderer/App
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ModelChoiceView, PluginInfoView, RuntimeSnapshot, TranscriptEntry } from '@dsc/runtime/contract.js'
import { dsc, createRuntimeProxy, type RuntimeProxy } from './bridge.js'
import { ApprovalCard } from './ApprovalCard.js'
import { ChatView } from './ChatView.js'
import { Composer } from './Composer.js'
import { Dock } from './Dock.js'
import { PluginsView } from './PluginsView.js'
import { SessionPicker } from './SessionPicker.js'
import { Sidebar } from './Sidebar.js'
import { StatusBar } from './StatusBar.js'
import { TraceView } from './TraceView.js'
import { IconSidebar } from './icons.js'

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null)
  const [cwd, setCwd] = useState('')
  const [hostDown, setHostDown] = useState<{ code: number | null } | null>(null)
  const [picker, setPicker] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [models, setModels] = useState<ModelChoiceView[]>([])
  const [plugins, setPlugins] = useState<PluginInfoView[]>([])
  const [tab, setTab] = useState<'chat' | 'trace'>('chat')
  const [view, setView] = useState<'chat' | 'plugins'>('chat')
  const [dockOpen, setDockOpen] = useState(false)
  // dock 宽度（拖拽调宽，持久化到 localStorage）
  const [dockWidth, setDockWidth] = useState(() => {
    const saved = Number(localStorage.getItem('dsc.dockWidth'))
    return Number.isFinite(saved) && saved >= 300 && saved <= 820 ? saved : 420
  })
  const proxy: RuntimeProxy = useMemo(createRuntimeProxy, [])
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const offSnapshot = dsc.onSnapshot(setSnapshot)
    const offExit = dsc.onHostExit((info) => setHostDown(info))
    const offLog = dsc.onHostLog((message) => console.info('[dsc-host]', message))
    // 宿主命令 handler 请求打开会话选择面板（如 /resume）
    const offUi = dsc.onUi((action) => {
      if (action === 'open-picker') openPicker()
    })
    void dsc.getCwd().then(setCwd)
    void proxy.refreshSessions()
    void proxy.listModels().then(setModels)
    return () => {
      offSnapshot()
      offUi()
      offExit()
      offLog()
    }
  }, [proxy])

  const showNotice = (text: string): void => {
    setNotice(text)
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 6000)
  }

  // demo 模式（?demo=1，自动化验证用）：切到可用端点并自动发起一轮真实对话
  const demo = new URLSearchParams(location.search).has('demo')
  useEffect(() => {
    if (!demo) return
    const timers = [
      setTimeout(() => void proxy.setModel('deepseek/deepseek-flash'), 1200),
      setTimeout(() => proxy.submit('你好！请用两句话介绍你自己，并用行内代码格式列出一个工具名'), 1800),
    ]
    return () => timers.forEach(clearTimeout)
  }, [demo, proxy])

  const openPicker = (): void => {
    setPicker(true)
    void proxy.refreshSessions()
  }

  // ---- 插件页动作 ----
  const refreshPlugins = (): void => {
    void proxy.listPlugins().then(setPlugins).catch(() => {})
  }
  useEffect(() => {
    if (view === 'plugins') refreshPlugins()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])
  const togglePlugin = (file: string, next: boolean): void => {
    setPlugins((current) => current.map((p) => (p.file === file ? { ...p, enabled: next } : p)))
    proxy.setPluginEnabled(file, next)
    showNotice(`已${next ? '启用' : '停用'}插件 ${file}（即时生效）`)
    // 热挂载的结果（成功/回滚）随 system 条目与下一次清单刷新回来
    setTimeout(refreshPlugins, 600)
  }
  const installPlugin = (): void => {
    void dsc.installPlugin().then((installed) => {
      if (installed.length === 0) return
      showNotice(`已安装 ${installed.join('、')}（即时生效）`)
      setTimeout(refreshPlugins, 600)
    })
  }
  const restartHost = (): void => {
    void dsc.restartHost().then(() => {
      showNotice('宿主已重启')
      refreshPlugins()
    })
  }

  const handleSubmit = (text: string): void => {
    setNotice(null)
    setTab('chat')
    if (text.startsWith('/')) {
      // / 命令统一派发到宿主命令注册表（内置 + 外部插件命令）；
      // notice 反馈经 transcript 条目、openPicker 经 dsc:ui 事件回到本组件。
      void proxy.runCommand(text)
      return
    }
    proxy.submit(text)
  }

  if (hostDown !== null) {
    return (
      <div className="loading" style={{ flexDirection: 'column', gap: 14 }}>
        <div>dsc 宿主已退出（code {String(hostDown.code)}）</div>
        <button
          className="btn-primary"
          onClick={() => {
            void dsc.restartHost().then(() => setHostDown(null))
          }}
        >
          重新启动宿主
        </button>
      </div>
    )
  }

  if (snapshot === null) {
    return <div className="loading">正在启动 dsc 宿主…</div>
  }

  // 顶栏标题：活动会话的标题（首条用户消息），否则最近一条用户消息，否则「新会话」
  const active = snapshot.sessions.find((s) => s.id.endsWith(`${snapshot.status.sessionId ?? '#'}.jsonl`))
  const lastUser = [...snapshot.entries].reverse().find((entry) => entry.kind === 'user')
  const conversationTitle =
    active?.title ??
    (lastUser !== undefined && lastUser.kind === 'user' ? lastUser.text.slice(0, 40) : '新会话')
  // 空态 = 没有任何用户/回复/工具条目（宿主预写的 system 提示行随欢迎态一起显示）
  const empty =
    !snapshot.entries.some((entry) => entry.kind !== 'system') && snapshot.status.turnState === 'idle'

  const pickSession = (id: string): void => {
    setPicker(false)
    setTab('chat')
    setView('chat')
    void proxy.openSession(id)
  }

  return (
    <div className="app">
      <Sidebar
        sessions={snapshot.sessions}
        activeSessionId={snapshot.status.sessionId}
        cwd={cwd}
        usage={snapshot.status.usage}
        view={view}
        onView={setView}
        onNew={() => {
          setView('chat')
          void proxy.openSession(undefined)
        }}
        onPick={pickSession}
        onChooseDir={() => {
          void dsc.chooseDirectory().then((next) => {
            if (next !== null) setCwd(next)
          })
        }}
      />

      <div className="main">
        {view === 'plugins' ? (
          <>
            <PluginsView
              plugins={plugins}
              notice={notice}
              onToggle={togglePlugin}
              onRefresh={refreshPlugins}
              onInstall={installPlugin}
              onRestartHost={restartHost}
            />
            <StatusBar status={snapshot.status} />
          </>
        ) : (
          <>
            <div className="topbar">
              <span className="title" title={conversationTitle}>
                {conversationTitle}
              </span>
          <nav className="tabs">
            <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
              对话
            </button>
            <button className={tab === 'trace' ? 'on' : ''} onClick={() => setTab('trace')}>
              轨迹
            </button>
          </nav>
          <div className="drag-fill" />
          <button
            className={`icon-btn dock-toggle${dockOpen ? ' on' : ''}`}
            title="工作区面板（终端 / 浏览器 / 文件 / Git）"
            onClick={() => setDockOpen((current) => !current)}
          >
            <IconSidebar size={15} />
          </button>
        </div>

            {tab === 'trace' ? (
              <TraceView entries={snapshot.entries as TranscriptEntry[]} status={snapshot.status} />
            ) : empty ? (
              <Welcome systemEntries={snapshot.entries.filter((entry) => entry.kind === 'system')} />
            ) : (
              <ChatView entries={snapshot.entries as TranscriptEntry[]} turnState={snapshot.status.turnState} />
            )}

            <div className="composer-zone">
              {notice !== null && <div className="notice">{notice}</div>}
              {snapshot.pendingApproval !== null && (
                <ApprovalCard
                  request={snapshot.pendingApproval}
                  onAnswer={(answer) => proxy.answerApproval(answer)}
                />
              )}
              {picker ? (
                <SessionPicker
                  sessions={snapshot.sessions}
                  loading={snapshot.sessionsLoading}
                  onPick={pickSession}
                  onClose={() => setPicker(false)}
                />
              ) : null}
              <Composer
                disabled={snapshot.pendingApproval !== null}
                models={models}
                model={snapshot.status.model}
                effort={snapshot.status.effort}
                policy={snapshot.status.policy}
                working={snapshot.status.turnState !== 'idle'}
                onSubmit={handleSubmit}
                onInterrupt={() => proxy.interrupt()}
                onModelChange={(value) => void proxy.setModel(value)}
                onEffortChange={(value) => void proxy.setEffort(value)}
                onPolicyChange={(value) => proxy.setPolicy(value)}
              />
            </div>

            <StatusBar status={snapshot.status} />
          </>
        )}
      </div>

      {dockOpen && (
        <Dock
          visible
          cwd={cwd}
          proxy={proxy}
          width={dockWidth}
          onResize={(width) => {
            setDockWidth(width)
            localStorage.setItem('dsc.dockWidth', String(width))
          }}
          onClose={() => setDockOpen(false)}
        />
      )}
    </div>
  )
}

/** 空会话欢迎态：居中品牌 + 引导文案 + 宿主预写的 system 提示行。 */
function Welcome({ systemEntries }: { systemEntries: { id: number; text: string }[] }): JSX.Element {
  return (
    <div className="welcome">
      <div className="welcome-mark">dsc</div>
      <h1>有什么可以帮忙的？</h1>
      <p>
        输入 <code>/</code> 查看可用指令 · 消息会携带当前工作目录上下文
      </p>
      {systemEntries.map((entry) => (
        <div key={entry.id} className="welcome-note">
          {entry.text}
        </div>
      ))}
    </div>
  )
}
