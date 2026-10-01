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
  ModelChoiceView,
  ModelConfigView,
  PluginInfoView,
  PresetDraft,
  PresetFileView,
  PresetSurface,
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
  ToolEntryView,
  TranscriptEntry,
  UiPrefsView,
  UsageStatsView,
} from '@dsc/runtime/contract.js'

/**
 * 会话用量投影：壳进程读 `~/.dsc/usage/usage.jsonl` 后按会话 id 汇总的结果。
 *
 * 形状与 `electron/main/session-usage.ts` 里的 SessionUsageView 一致：
 * 渲染层与壳进程分属两个 tsconfig 子项目（web / node），类型文件互相看不到，
 * 只能各写一份；改一边记得改另一边。
 */
export interface SessionUsageView {
  /** 这个会话的模型请求条数。 */
  requests: number
  inputTokens: number
  outputTokens: number
  /** 最后一次请求的输入 token = 当前上下文占用（服务端真值）。 */
  lastInputTokens: number
  lastAt: number
}

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
  /** 当前会话的累计用量（底部状态栏第二段与上下文卡的数据源；只读）。 */
  sessionUsage(sessionId: string): Promise<SessionUsageView | null>
  installPlugin(): Promise<string[]>
  /** 技能导入（系统选择器 → 复制进 ~/.dsc/skills/）；返回技能名列表。 */
  installSkill(): Promise<string[]>
  /** 在系统文件管理器里打开路径；空串 = 成功，否则是原因。 */
  openPath(path: string): Promise<string>
  /** 用多种方式打开当前工作区（terminal / explorer / vscode；顶栏下拉菜单）。 */
  openWorkspace(kind: 'terminal' | 'explorer' | 'vscode'): Promise<{ ok: boolean; error?: string }>
  /** dock 内置终端（宿主 desktop-dock 服务，管道模式：行缓冲输入）。 */
  dock(op: string, payload?: Record<string, unknown>): Promise<unknown>
  onDockData(listener: (data: { id: string; data: string }) => void): () => void
  /** dock 内置浏览器（WebContentsView 原生层；rect 为 renderer 页面坐标）。 */
  dockBrowser(visible: boolean, rect?: { x: number; y: number; width: number; height: number }): Promise<boolean>
  browserNav(url: string, action: 'load' | 'back' | 'forward' | 'reload'): Promise<{ ok: boolean; url?: string; error?: string }>
  onBrowserState(listener: (state: { url: string }) => void): () => void
  /** 主题切换时同步窗口底色与原生控件区颜色（两个 #rrggbb，不带 alpha）。 */
  setWindowChrome(bar: string, symbol: string): void
  /** 主题切换时同步原生弹出层（select 下拉、右键菜单）的深浅；传 dark / light / system。 */
  setThemeSource(mode: 'dark' | 'light' | 'system'): void
  /** 用系统浏览器打开一个 http/https 链接（检查更新的「打开发布页」）。 */
  openExternal(url: string): Promise<void>
  quit(): void
}

export const dsc: DscBridge = (window as unknown as { dsc: DscBridge }).dsc

/**
 * 协议代理：与 `DscRuntime` 同名、同参数，返回值一律包成 Promise（跨进程必然异步）。
 *
 * 类型直接从 `DscRuntime` 映射出来，不再手写一份方法清单：
 * 内核接口加一个方法，这里就必须给它一个实现，漏写当场编译报错
 * （原先 Omit + 手写签名那份会静静漂掉）。
 * 快照经 `dsc.onSnapshot` 推送，所以 `subscribe` / `getSnapshot` 在代理里没有真身。
 */
export type RuntimeProxy = {
  [K in keyof DscRuntime]: DscRuntime[K] extends (...callArgs: infer A) => infer R
    ? (...callArgs: A) => Promise<Awaited<R>>
    : DscRuntime[K]
}

export function createRuntimeProxy(): RuntimeProxy {
  const callVoid = (method: string, ...args: unknown[]): Promise<void> =>
    dsc.invoke(method, args) as Promise<void>
  const call = <T>(method: string, ...args: unknown[]): Promise<T> => dsc.invoke(method, args) as Promise<T>
  return {
    subscribe: () => Promise.resolve(() => undefined),
    getSnapshot: () => Promise.reject(new Error('快照经 onSnapshot 推送；代理不支持 getSnapshot')),
    submit: (text, images) => callVoid('submit', text, images),
    interrupt: () => callVoid('interrupt'),
    openSession: (id) => callVoid('openSession', id),
    compact: () => callVoid('compact'),
    setModel: (model) => callVoid('setModel', model),
    setEffort: (effort) => callVoid('setEffort', effort),
    refreshSessions: () => callVoid('refreshSessions'),

    // ── 会话库：归档 / 恢复 / 删除 / 改名 / 置顶 / 分叉 / 用量 / 界面偏好 ──
    archiveSessions: (paths) => call<SettingsMutation>('archiveSessions', paths),
    listArchivedSessions: () => call<ArchivedPage>('listArchivedSessions'),
    usageStats: () => call<UsageStatsView>('usageStats'),
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
    // 队友管理两通道：停一个队友、给队友发一句话，回执都是「给用户看的一句话」
    stopTeammate: (name) => call<string>('stopTeammate', name),
    messageTeammate: (name, text) => call<string>('messageTeammate', name, text),
    runCommand: (input) => call<boolean>('runCommand', input),
    setPolicy: (policy) => callVoid('setPolicy', policy),
    setMode: (mode) => callVoid('setMode', mode),
    // 模式（预设）四个通道 + 只读原文
    listPresets: () => call<PresetSurface>('listPresets'),
    readPreset: (name) => call<PresetFileView>('readPreset', name),
    usePreset: (name) => call<SettingsMutation>('usePreset', name),
    savePreset: (draft) => call<SettingsMutation>('savePreset', draft),
    removePreset: (name) => call<SettingsMutation>('removePreset', name),
    setDefaultPreset: (name) => call<SettingsMutation>('setDefaultPreset', name),
    listTools: () => call<ToolEntryView[]>('listTools'),
    clearTodos: () => callVoid('clearTodos'),
    answerQuestion: (answer) => callVoid('answerQuestion', answer),
    answerPlan: (decision) => callVoid('answerPlan', decision),
    goalAction: (action) => call<SettingsMutation>('goalAction', action),
    dock: (op, payload) => call<unknown>('dock', op, payload ?? {}),
    answerApproval: (answer) => callVoid('answerApproval', answer),
    exit: async () => {
      dsc.quit()
    },
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
