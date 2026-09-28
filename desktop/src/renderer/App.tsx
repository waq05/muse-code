/**
 * 顶层界面：侧栏 + 顶栏（标题/对话轨迹 tab）+ 居中消息流 + 输入区 + 状态栏。
 * 布局对照 dsh 桌面端；空会话显示欢迎态；命令派发复用 dsc 的 runCommand。
 *
 * @module desktop/renderer/App
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import type { ModelChoiceView, PluginInfoView, RuntimeSnapshot, TeammateView, TranscriptEntry, UiPrefsView } from '@dsc/runtime/contract.js'
import { applyAppearance, saveCachedAppearance } from './appearance.js'
import { toastErr, toastOk } from './components/toast.js'
import { dsc, createRuntimeProxy, type RuntimeProxy } from './bridge.js'
import { ApprovalCard } from './ApprovalCard.js'
import { ChatView } from './ChatView.js'
import { Composer } from './Composer.js'
import { Dock } from './Dock.js'
import { PluginsView } from './PluginsView.js'
import { SessionPicker } from './SessionPicker.js'
import { SettingsModal } from './SettingsModal.js'
import { Sidebar } from './Sidebar.js'
import { SkillsView } from './SkillsView.js'
import { StatusBar } from './StatusBar.js'
import { TeammatePeek } from './TeammatePeek.js'
import { TraceView } from './TraceView.js'
import { IconSidebar } from './icons.js'

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null)
  const [cwd, setCwd] = useState('')
  const [hostDown, setHostDown] = useState<{ code: number | null } | null>(null)
  const [picker, setPicker] = useState(false)
  const [models, setModels] = useState<ModelChoiceView[]>([])
  const [plugins, setPlugins] = useState<PluginInfoView[]>([])
  const [tab, setTab] = useState<'chat' | 'trace'>('chat')
  const [view, setView] = useState<'chat' | 'plugins' | 'skills'>('chat')
  // 设置面板：open 控制遮罩，section 是打开时定位的分区（技能页右上也用它）
  const [settings, setSettings] = useState<{ open: boolean; section: string }>({ open: false, section: 'general' })
  // 正在只读查看的队友（侧栏「队友」那一档点开）；它不是当前会话，切不走也改不了
  const [peek, setPeek] = useState<TeammateView | null>(null)
  const [peekEntries, setPeekEntries] = useState<TranscriptEntry[]>([])
  const [dockOpen, setDockOpen] = useState(false)
  // dock 宽度（拖拽调宽，持久化到 localStorage）
  const [dockWidth, setDockWidth] = useState(() => {
    const saved = Number(localStorage.getItem('dsc.dockWidth'))
    return Number.isFinite(saved) && saved >= 300 && saved <= 820 ? saved : 420
  })
  const proxy: RuntimeProxy = useMemo(createRuntimeProxy, [])
  // 侧栏界面偏好（排序方式、工作区顺序与别名、外观三项），存在宿主的 ~/.dsc/settings.json
  const [uiPrefs, setUiPrefs] = useState<UiPrefsView>({ sessionSort: 'created', workspaceOrder: [], workspaceAliases: {}, themeMode: 'dark', fontSize: 'md', density: 'standard' })
  // 最近用过的工作目录：切过去但还没发过消息的工作区也要能在侧栏看到
  const [recentCwds, setRecentCwds] = useState<string[]>([])

  useEffect(() => {
    const offSnapshot = dsc.onSnapshot(setSnapshot)
    const offExit = dsc.onHostExit((info) => setHostDown(info))
    const offLog = dsc.onHostLog((message) => console.info('[dsc-host]', message))
    // 宿主命令 handler 请求打开会话选择面板（如 /resume）
    const offUi = dsc.onUi((action) => {
      if (action === 'open-picker') openPicker()
    })
    void dsc.getCwd().then(setCwd)
    void dsc.recentCwds().then(setRecentCwds)
    void proxy.getUiPrefs().then(setUiPrefs)
    void proxy.refreshSessions()
    void proxy.listModels().then(setModels)
    return () => {
      offSnapshot()
      offUi()
      offExit()
      offLog()
    }
  }, [proxy])

  // 外观三项落到 <html> 的 data 属性和 --dsc-font-scale 上，样式表据此换色。
  // 同时写一份 localStorage 镜像，下次冷启动的首帧就能按老设置上色，不闪默认深色。
  useEffect(() => {
    const appearance = { themeMode: uiPrefs.themeMode, fontSize: uiPrefs.fontSize, density: uiPrefs.density }
    applyAppearance(appearance)
    saveCachedAppearance(appearance)
  }, [uiPrefs.themeMode, uiPrefs.fontSize, uiPrefs.density])

  // 一次性反馈统一走右下角 Toast（components/toast.ts），这里不再有输入区上方的提示条。

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

  // 自检钩子（截图/自动化用）：?view=skills 直接切页，?settings=models 直接开面板到某分区，
  // ?reveal=1 让只在 hover 时出现的行内按钮常驻，好拍清 hover 态
  const shotParams = useMemo(() => new URLSearchParams(location.search), [])
  useEffect(() => {
    const page = shotParams.get('view')
    if (page === 'plugins' || page === 'skills') setView(page)
    const section = shotParams.get('settings')
    if (section !== null && section !== '') setSettings({ open: true, section })
    if (shotParams.has('reveal')) document.body.classList.add('shot-reveal')
    // ?dropline=1 给第二个工作区块画上真实的落点线，好拍清拖动指示长什么样
    const dropLine = shotParams.has('dropline')
    if (dropLine) {
      const timer = setTimeout(() => {
        document.querySelector('.group:nth-child(2)')?.classList.add('drop-below')
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [shotParams])

  // ?peek=1 自动打开队友清单里的第一个（自检截图用；队友名册在磁盘上，不依赖模型）
  useEffect(() => {
    if (!shotParams.has('peek')) return
    let alive = true
    void proxy
      .listTeammates()
      .then((mates) => {
        if (alive && mates.length > 0) setPeek(mates[0]!)
      })
      .catch(() => {
        /* 没开子智能体团队时这个调用会失败，自检环境里不必管 */
      })
    return () => {
      alive = false
    }
  }, [shotParams, proxy])

  const openPicker = (): void => {
    setPicker(true)
    void proxy.refreshSessions()
  }

  // 队友的运行记录是活的：这条视图开着时每两秒重读一次那个文件（只读，不动它）
  useEffect(() => {
    if (peek === null) return
    const file = peek.file
    let alive = true
    const pull = (): void => {
      proxy
        .peekTranscript(file)
        .then((entries) => {
          if (alive) setPeekEntries(entries)
        })
        .catch(() => {})
    }
    setPeekEntries([])
    pull()
    const timer = setInterval(pull, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [peek, proxy])

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
    toastOk(`已${next ? '启用' : '停用'}插件 ${file}（即时生效）`)
    // 热挂载的结果（成功/回滚）随 system 条目与下一次清单刷新回来
    setTimeout(refreshPlugins, 600)
  }
  const installPlugin = (): void => {
    void dsc.installPlugin().then((installed) => {
      if (installed.length === 0) return
      toastOk(`已安装 ${installed.join('、')}（即时生效）`)
      setTimeout(refreshPlugins, 600)
    })
  }
  const restartHost = (): void => {
    void dsc.restartHost().then(() => {
      toastOk('宿主已重启')
      refreshPlugins()
    })
  }

  // ---- 侧栏动作：切工作区、存界面偏好 ----
  const switchCwd = (dir: string): void => {
    void dsc.switchCwd(dir).then((outcome) => {
      if (!outcome.ok) {
        toastErr(`切不过去：${outcome.error}`)
        return
      }
      setCwd(outcome.cwd)
      setRecentCwds((current) => [outcome.cwd, ...current.filter((entry) => entry !== outcome.cwd)].slice(0, 12))
      setView('chat')
      // 宿主刚换过进程，会话清单要从新宿主重新读一遍
      void proxy.refreshSessions()
      toastOk(`已切到 ${outcome.cwd}`)
    })
  }

  /** 写侧栏偏好（排序方式、工作区顺序、显示名别名），成功后把新值读回来。 */
  const saveUiPrefs = (patch: Partial<UiPrefsView>): void => {
    void proxy.setUiPrefs(patch).then((result) => {
      if (!result.ok) {
        toastErr(`没改成：${result.error}`)
        return
      }
      if (result.notice !== undefined) toastOk(result.notice)
      void proxy.getUiPrefs().then(setUiPrefs)
    })
  }

  const handleSubmit = (text: string): void => {
    setTab('chat')
    if (text.startsWith('/')) {
      // / 命令统一派发到宿主命令注册表（内置 + 外部插件命令）；
      // 命令的反馈经 transcript 条目、openPicker 经 dsc:ui 事件回到本组件。
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
    // 换自己的会话就退出队友视图，别让标题还写着别人的名字
    setPeek(null)
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
        onOpenSettings={(section) => setSettings({ open: true, section })}
        onNew={() => {
          setView('chat')
          setPeek(null)
          void proxy.openSession(undefined)
        }}
        onPick={pickSession}
        onChooseDir={() => {
          void dsc.chooseDirectory().then((next) => {
            if (next !== null) setCwd(next)
          })
        }}
        recentCwds={recentCwds}
        uiPrefs={uiPrefs}
        proxy={proxy}
        onSwitchCwd={switchCwd}
        onUiPrefs={saveUiPrefs}
        onPeekTeammate={(mate) => {
          setView('chat')
          setTab('chat')
          setPeek(mate)
        }}
        peekFile={peek?.file ?? null}
      />

      <div className="main">
        {view === 'plugins' ? (
          <>
            <PluginsView
              plugins={plugins}
              onToggle={togglePlugin}
              onRefresh={refreshPlugins}
              onInstall={installPlugin}
              onRestartHost={restartHost}
              onOpenSettings={(section) => setSettings({ open: true, section })}
            />
            <StatusBar status={snapshot.status} />
          </>
        ) : view === 'skills' ? (
          <>
            <SkillsView proxy={proxy} />
            <StatusBar status={snapshot.status} />
          </>
        ) : (
          <>
            <div className="topbar">
              <span className="title" data-tip={peek === null ? conversationTitle : `队友 ${peek.name} 的运行记录（只读）`}>
                {peek === null ? conversationTitle : `队友 ${peek.name}`}
              </span>
              {peek === null && (
                <nav className="tabs">
                  <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
                    对话
                  </button>
                  <button className={tab === 'trace' ? 'on' : ''} onClick={() => setTab('trace')}>
                    轨迹
                  </button>
                </nav>
              )}
          <div className="drag-fill" />
          <button
            className={`icon-btn dock-toggle${dockOpen ? ' on' : ''}`}
            data-tip="工作区面板（终端 / 浏览器 / 文件 / Git）"
            onClick={() => setDockOpen((current) => !current)}
          >
            <IconSidebar size={15} />
          </button>
        </div>

            {peek !== null ? (
              <TeammatePeek teammate={peek} entries={peekEntries} onClose={() => setPeek(null)} />
            ) : tab === 'trace' ? (
              <TraceView entries={snapshot.entries as TranscriptEntry[]} status={snapshot.status} />
            ) : empty ? (
              <Welcome systemEntries={snapshot.entries.filter((entry) => entry.kind === 'system')} />
            ) : (
              <ChatView entries={snapshot.entries as TranscriptEntry[]} turnState={snapshot.status.turnState} />
            )}

            <div className="composer-zone">
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
              {peek === null ? (
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
              ) : (
                <div className="peek-lock">
                  你在看队友 {peek.name} 的运行记录，这里不能发言。要给它的活得由派它的那一方用
                  <code>subagent</code> 工具传话；你用自己的账号插手会打乱它的上下文。
                </div>
              )}
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

      <SettingsModal
        open={settings.open}
        proxy={proxy}
        initial={settings.section}
        uiPrefs={uiPrefs}
        onUiPrefs={saveUiPrefs}
        onClose={() => setSettings((current) => ({ ...current, open: false }))}
      />
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
