/**
 * 宿主协议会话：与 dsc headless 宿主（utilityProcess，host-stdio 插件）经
 * Electron MessagePort 结构化克隆通信。消息形状与 dsc 的
 * src/plugins/host-stdio.ts 对应（协议版本 1）；进程退出后 pending 请求全部拒绝。
 *
 * @module desktop/main/protocol
 */
import { utilityProcess, type UtilityProcess } from 'electron'

/** 协议版本（与 host-stdio 的 HOST_PROTOCOL_VERSION 对应；2 = 增加技能与设置方法）。 */
export const HOST_PROTOCOL_VERSION = 2

export type RuntimeSnapshot = {
  entries: unknown[]
  status: {
    sessionId: string | null
    model: string
    effort: string | null
    turnState: 'idle' | 'thinking' | 'working' | 'awaiting-approval'
    usage: { inputTokens: number; outputTokens: number } | null
  }
  pendingApproval: { id: string; toolName: string; argsSummary: string } | null
  sessions: { id: string; cwd: string; createdAt: number; title?: string }[]
  sessionsLoading: boolean
}

type RuntimeToHostMessage =
  | { type: 'hello'; protocolVersion: number }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'snapshot'; snapshot: RuntimeSnapshot }
  | { type: 'ui'; action: 'open-picker' }
  | { type: 'dock-data'; id: string; data: string }

type HostToRuntimeMessage =
  | { type: 'invoke'; id: number; method: string; args?: unknown[] }
  | { type: 'exit' }

export class HostProtocol {
  private child: UtilityProcess
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private snapshotListeners = new Set<(snapshot: RuntimeSnapshot) => void>()
  private helloListeners = new Set<(protocolVersion: number) => void>()
  private closeListeners = new Set<(info: { code: number | null }) => void>()
  private uiListeners = new Set<(action: 'open-picker') => void>()
  private dockDataListeners = new Set<(data: { id: string; data: string }) => void>()
  private exitForwarded = false

  constructor(entry: string, cwd: string) {
    this.child = utilityProcess.fork(entry, [], { serviceName: 'dsc-host', cwd })
    this.child.on('message', (message: RuntimeToHostMessage) => {
      if (message === null || typeof message !== 'object' || !('type' in message)) return
      if (message.type === 'hello') {
        if (message.protocolVersion !== HOST_PROTOCOL_VERSION) return
        for (const listener of this.helloListeners) listener(message.protocolVersion)
        return
      }
      if (message.type === 'result') {
        const request = this.pending.get(message.id)
        if (request === undefined) return
        this.pending.delete(message.id)
        if (message.ok) request.resolve(message.value)
        else request.reject(new Error(message.error))
        return
      }
      if (message.type === 'snapshot') {
        for (const listener of this.snapshotListeners) listener(message.snapshot)
        return
      }
      if (message.type === 'ui') {
        for (const listener of this.uiListeners) listener(message.action)
        return
      }
      if (message.type === 'dock-data') {
        for (const listener of this.dockDataListeners) listener({ id: message.id, data: message.data })
      }
    })
    this.child.on('exit', (code) => {
      for (const [, request] of this.pending) request.reject(new Error('宿主进程已退出'))
      this.pending.clear()
      if (!this.exitForwarded) {
        for (const listener of this.closeListeners) listener({ code })
      }
    })
  }

  /** 调用 DscRuntime 方法（headless 侧白名单校验）。 */
  invoke(method: string, args: unknown[] = []): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const message: HostToRuntimeMessage = { type: 'invoke', id, method, args }
      this.child.postMessage(message)
    })
  }

  /** 优雅退出：请求宿主自行收尾；exit 事件将被抑制（正常退出不发 host-exit）。 */
  exitGracefully(onSettled?: () => void): void {
    const current = this.child
    current.once('exit', () => {
      this.exitForwarded = true
      onSettled?.()
    })
    try {
      current.postMessage({ type: 'exit' } satisfies HostToRuntimeMessage)
    } catch {
      onSettled?.()
    }
  }

  /** 强杀（优雅退出超时兜底）。 */
  kill(): void {
    this.child.kill()
  }

  onSnapshot(listener: (snapshot: RuntimeSnapshot) => void): void {
    this.snapshotListeners.add(listener)
  }
  onHello(listener: (protocolVersion: number) => void): void {
    this.helloListeners.add(listener)
  }
  onClose(listener: (info: { code: number | null }) => void): void {
    this.closeListeners.add(listener)
  }
  /** 宿主 UI 动作（命令 handler 里的 openPicker 等）。 */
  onUi(listener: (action: 'open-picker') => void): void {
    this.uiListeners.add(listener)
  }
  /** dock 终端输出流（desktop-dock 服务）。 */
  onDockData(listener: (data: { id: string; data: string }) => void): void {
    this.dockDataListeners.add(listener)
  }
}
