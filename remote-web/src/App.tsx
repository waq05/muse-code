import { useEffect, useState, type ReactNode } from 'react'
import { ConnBar } from './components/ConnBar.js'
import { RemoteClient } from './lib/client.js'
import { useClientState } from './lib/hooks.js'
import { clearCreds, loadCreds, type DeviceCreds } from './lib/storage.js'
import { ChatPage } from './pages/ChatPage.js'
import { LoginPage } from './pages/LoginPage.js'
import { SessionsPage } from './pages/SessionsPage.js'

/**
 * 应用外壳：两层。
 *   1. 没凭据 → 登录页；有凭据 → 遥控外壳（这一层不会来回切，除非 token 被吊销）；
 *   2. 外壳里是两页的阶梯导航：聊天页 ⇄ 会话列表页。
 *
 * 连接状态只有一条真相：RemoteClient。这里不复制它的状态，只订阅。
 */
export function App(): ReactNode {
  const [creds, setCreds] = useState<DeviceCreds | null>(() => loadCreds())
  const [notice, setNotice] = useState<string | null>(null)

  if (creds === null) {
    return (
      <LoginPage
        notice={notice}
        onPaired={(next) => {
          setNotice(null)
          setCreds(next)
        }}
      />
    )
  }

  return (
    <RemoteShell
      creds={creds}
      onSignOut={(reason) => {
        clearCreds()
        setNotice(reason)
        setCreds(null)
      }}
    />
  )
}

function RemoteShell({
  creds,
  onSignOut,
}: {
  creds: DeviceCreds
  onSignOut: (reason: string | null) => void
}): ReactNode {
  const [client] = useState(
    () =>
      new RemoteClient({
        token: creds.token,
        onUnauthorized: () => onSignOut('登录已失效，请重新配对设备'),
      }),
  )
  const state = useClientState(client)
  const [page, setPage] = useState<'chat' | 'sessions'>('chat')

  useEffect(() => {
    client.start()
    return () => client.stop()
  }, [client])

  // 宿主发 open-picker（它自己弹不出界面）：这里换算成「打开会话列表」。
  useEffect(() => {
    if (state.uiRequest === null) return
    if (state.uiRequest.method === 'open-picker') {
      setPage('sessions')
      client.acknowledgeUiRequest()
    }
  }, [state.uiRequest, client])

  // 手机锁屏回来 / 网络恢复：不等退避到点，立刻试一次。
  useEffect(() => {
    const retryIfDown = (): void => {
      if (client.getState().conn !== 'open') client.retryNow()
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') retryIfDown()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', retryIfDown)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', retryIfDown)
    }
  }, [client])

  return (
    <div className="app">
      <ConnBar
        conn={state.conn}
        attempt={state.attempt}
        retryAt={state.retryAt}
        lastError={state.lastError}
        onRetry={() => client.retryNow()}
      />
      {page === 'sessions' ? (
        <SessionsPage
          client={client}
          snapshot={state.snapshot}
          epoch={state.epoch}
          connected={state.conn === 'open'}
          onPick={() => setPage('chat')}
          onSignOut={() => onSignOut(null)}
          deviceName={creds.deviceName}
          pushPublicKey={state.pushPublicKey}
        />
      ) : (
        <ChatPage client={client} state={state} onOpenSessions={() => setPage('sessions')} />
      )}
    </div>
  )
}
