/**
 * renderer ⇄ 主进程桥：window.dsc 类型 + DscRuntime 协议代理。
 * 代理使 renderer 能直接复用 dsc 的 commands.runCommand / completionsFor。
 *
 * @module desktop/renderer/bridge
 */
import type { DscRuntime, ModelChoiceView, PluginInfoView, RuntimeSnapshot } from '@dsc/runtime/contract.js'

export interface DscBridge {
  invoke(method: string, args?: unknown[]): Promise<unknown>
  onSnapshot(listener: (snapshot: RuntimeSnapshot) => void): () => void
  onUi(listener: (action: string) => void): () => void
  onHostLog(listener: (message: string) => void): () => void
  onHostExit(listener: (info: { code: number | null }) => void): () => void
  getCwd(): Promise<string>
  chooseDirectory(): Promise<string | null>
  restartHost(): Promise<boolean>
  installPlugin(): Promise<string[]>
  /** dock 内置终端（宿主 desktop-dock 服务，管道模式：行缓冲输入）。 */
  dock(op: string, payload?: Record<string, unknown>): Promise<unknown>
  onDockData(listener: (data: { id: string; data: string }) => void): () => void
  /** dock 内置浏览器（WebContentsView 原生层；rect 为 renderer 页面坐标）。 */
  dockBrowser(visible: boolean, rect?: { x: number; y: number; width: number; height: number }): Promise<boolean>
  browserNav(url: string, action: 'load' | 'back' | 'forward' | 'reload'): Promise<{ ok: boolean; url?: string; error?: string }>
  onBrowserState(listener: (state: { url: string }) => void): () => void
  quit(): void
}

export const dsc: DscBridge = (window as unknown as { dsc: DscBridge }).dsc

/**
 * 协议代理：与 DscRuntime 同形，仅 listModels/listPlugins/runCommand 经协议
 * 必然异步（契约里它们是进程内同步方法）。快照经 onSnapshot 推送，不走
 * subscribe/getSnapshot。
 */
export interface RuntimeProxy extends Omit<DscRuntime, 'listModels' | 'listPlugins' | 'runCommand'> {
  listModels(): Promise<ModelChoiceView[]>
  listPlugins(): Promise<PluginInfoView[]>
  runCommand(input: string): Promise<boolean>
}

export function createRuntimeProxy(): RuntimeProxy {
  const callVoid = (method: string, ...args: unknown[]): Promise<void> =>
    dsc.invoke(method, args) as Promise<void>
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => {
      throw new Error('快照经 onSnapshot 推送；代理不支持 getSnapshot')
    },
    submit: (text) => void dsc.invoke('submit', [text]),
    interrupt: () => void dsc.invoke('interrupt'),
    openSession: (id) => callVoid('openSession', id),
    compact: () => callVoid('compact'),
    setModel: (model) => callVoid('setModel', model),
    setEffort: (effort) => callVoid('setEffort', effort),
    refreshSessions: () => callVoid('refreshSessions'),
    listModels: () => dsc.invoke('listModels') as Promise<ModelChoiceView[]>,
    listPlugins: () => dsc.invoke('listPlugins') as Promise<PluginInfoView[]>,
    setPluginEnabled: (file, enabled) => callVoid('setPluginEnabled', file, enabled),
    runCommand: (input) => dsc.invoke('runCommand', [input]) as Promise<boolean>,
    setPolicy: (policy) => callVoid('setPolicy', policy),
    dock: (op, payload) => dsc.invoke('dock', [op, payload ?? {}]) as Promise<unknown>,
    answerApproval: (answer) => void dsc.invoke('answerApproval', [answer]),
    exit: () => dsc.quit(),
    dispose: () => Promise.resolve(),
  }
}

export type { DscRuntime, RuntimeSnapshot }
