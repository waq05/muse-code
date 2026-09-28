/**
 * renderer ⇄ 主进程桥：window.dsc 类型 + DscRuntime 协议代理。
 * 代理使 renderer 能直接复用 dsc 的 commands.runCommand / completionsFor。
 *
 * 进程内同步的契约方法（listSkills / getModelConfig 等）经协议必然异步，
 * 代理里把它们改成返回 Promise，调用方统一 await。
 *
 * @module desktop/renderer/bridge
 */
import type {
  ArchivedPage,
  DscRuntime,
  MarketBrowseResult,
  MarketSource,
  ModelChoiceView,
  ModelConfigView,
  PluginInfoView,
  ProviderDraft,
  RuntimeSnapshot,
  SessionForkResult,
  SettingsMutation,
  SettingsSectionView,
  SettingsValue,
  SettingsValues,
  SkillInfoView,
  SkillLoadResult,
  TeammateView,
  TranscriptEntry,
  UiPrefsView,
} from '@dsc/runtime/contract.js'

export interface DscBridge {
  invoke(method: string, args?: unknown[]): Promise<unknown>
  onSnapshot(listener: (snapshot: RuntimeSnapshot) => void): () => void
  onUi(listener: (action: string) => void): () => void
  onHostLog(listener: (message: string) => void): () => void
  onHostExit(listener: (info: { code: number | null }) => void): () => void
  getCwd(): Promise<string>
  chooseDirectory(): Promise<string | null>
  restartHost(): Promise<boolean>
  /** 切到指定工作目录（侧栏点工作区名；宿主重启，会话跟着换）。 */
  switchCwd(path: string): Promise<{ ok: true; cwd: string } | { ok: false; error: string }>
  /** 最近用过的工作目录（最新的排最前）。 */
  recentCwds(): Promise<string[]>
  installPlugin(): Promise<string[]>
  /** 技能导入（系统选择器 → 复制进 ~/.dsc/skills/）；返回技能名列表。 */
  installSkill(): Promise<string[]>
  /** 在系统文件管理器里打开路径；空串 = 成功，否则是原因。 */
  openPath(path: string): Promise<string>
  /** dock 内置终端（宿主 desktop-dock 服务，管道模式：行缓冲输入）。 */
  dock(op: string, payload?: Record<string, unknown>): Promise<unknown>
  onDockData(listener: (data: { id: string; data: string }) => void): () => void
  /** dock 内置浏览器（WebContentsView 原生层；rect 为 renderer 页面坐标）。 */
  dockBrowser(visible: boolean, rect?: { x: number; y: number; width: number; height: number }): Promise<boolean>
  browserNav(url: string, action: 'load' | 'back' | 'forward' | 'reload'): Promise<{ ok: boolean; url?: string; error?: string }>
  onBrowserState(listener: (state: { url: string }) => void): () => void
  /** 主题切换时同步窗口底色与原生控件区颜色（两个 #rrggbb，不带 alpha）。 */
  setWindowChrome(bar: string, symbol: string): void
  quit(): void
}

export const dsc: DscBridge = (window as unknown as { dsc: DscBridge }).dsc

/**
 * 协议代理：与 DscRuntime 同形，跨进程方法一律 Promise 化。
 * 快照经 onSnapshot 推送，不走 subscribe/getSnapshot。
 */
export interface RuntimeProxy
  extends Omit<
    DscRuntime,
    | 'listModels'
    | 'listPlugins'
    | 'listTeammates'
    | 'runCommand'
    | 'listSkills'
    | 'getSettingsSections'
    | 'getModelConfig'
    | 'getUiPrefs'
    | 'setSkillEnabled'
    | 'setMarketSources'
  > {
  listModels(): Promise<ModelChoiceView[]>
  listPlugins(): Promise<PluginInfoView[]>
  listTeammates(): Promise<TeammateView[]>
  runCommand(input: string): Promise<boolean>
  listSkills(): Promise<SkillInfoView[]>
  getSettingsSections(): Promise<SettingsSectionView[]>
  getModelConfig(): Promise<ModelConfigView>
  getUiPrefs(): Promise<UiPrefsView>
  setSkillEnabled(name: string, enabled: boolean): Promise<SettingsMutation>
  setMarketSources(sources: MarketSource[]): Promise<SettingsMutation>
}

export function createRuntimeProxy(): RuntimeProxy {
  const callVoid = (method: string, ...args: unknown[]): Promise<void> =>
    dsc.invoke(method, args) as Promise<void>
  const call = <T>(method: string, ...args: unknown[]): Promise<T> => dsc.invoke(method, args) as Promise<T>
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

    // ── 会话库：归档 / 恢复 / 删除 / 改名 / 置顶 / 分叉 / 界面偏好 ──
    archiveSessions: (paths) => call<SettingsMutation>('archiveSessions', paths),
    listArchivedSessions: () => call<ArchivedPage>('listArchivedSessions'),
    restoreSessions: (paths) => call<SettingsMutation>('restoreSessions', paths),
    purgeSessions: (paths) => call<SettingsMutation>('purgeSessions', paths),
    renameSession: (path, title) => call<SettingsMutation>('renameSession', path, title),
    setSessionPinned: (path, pinned) => call<SettingsMutation>('setSessionPinned', path, pinned),
    listUserMessages: (path) => call<string[]>('listUserMessages', path),
    forkSession: (path, index) => call<SessionForkResult>('forkSession', path, index),
    getUiPrefs: () => call<UiPrefsView>('getUiPrefs'),
    setUiPrefs: (patch) => call<SettingsMutation>('setUiPrefs', patch),

    listModels: () => call<ModelChoiceView[]>('listModels'),
    listPlugins: () => call<PluginInfoView[]>('listPlugins'),
    setPluginEnabled: (file, enabled) => callVoid('setPluginEnabled', file, enabled),
    listTeammates: () => call<TeammateView[]>('listTeammates'),
    peekTranscript: (file) => call<TranscriptEntry[]>('peekTranscript', file),
    runCommand: (input) => call<boolean>('runCommand', input),
    setPolicy: (policy) => callVoid('setPolicy', policy),
    dock: (op, payload) => call<unknown>('dock', op, payload ?? {}),
    answerApproval: (answer) => void dsc.invoke('answerApproval', [answer]),
    exit: () => dsc.quit(),
    dispose: () => Promise.resolve(),

    // ── 技能中心 ──
    listSkills: () => call<SkillInfoView[]>('listSkills'),
    readSkill: (name) => call<SkillLoadResult>('readSkill', name),
    setSkillEnabled: (name, enabled) => call<SettingsMutation>('setSkillEnabled', name, enabled),
    browseMarket: (source) => call<MarketBrowseResult>('browseMarket', source),
    installMarketSkill: (source, name) =>
      call<SettingsMutation>('installMarketSkill', source, name),
    setMarketSources: (sources) => call<SettingsMutation>('setMarketSources', sources),

    // ── 设置界面 ──
    getSettingsSections: () => call<SettingsSectionView[]>('getSettingsSections'),
    getSectionValues: (id) => call<SettingsValues>('getSectionValues', id),
    setSettingValue: (id, key, value) =>
      call<SettingsMutation>('setSettingValue', id, key, value),
    runSettingAction: (id, action) => call<SettingsMutation>('runSettingAction', id, action),
    getModelConfig: () => call<ModelConfigView>('getModelConfig'),
    saveProvider: (draft: ProviderDraft) => call<SettingsMutation>('saveProvider', draft),
    removeProvider: (name) => call<SettingsMutation>('removeProvider', name),
    setProviderKey: (name, apiKey) => call<SettingsMutation>('setProviderKey', name, apiKey),
    setDefaultModel: (provider, model) => call<SettingsMutation>('setDefaultModel', provider, model),
  }
}

export type { DscRuntime, RuntimeSnapshot }
