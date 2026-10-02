/**
 * 远程控制的服务端契约：协议常量、宿主能力（deps）、快照与句柄类型。
 *
 * 为什么要单独一个模块：`remote.ts`（插件装配）、`server.ts`（HTTP+WS 传输）、
 * `routes.ts`（HTTP 路由）三方都要认这些形状——放任何一方都会让另外两方反向依赖
 * 插件文件。协议常量也在这里：白名单与方法表是「契约」而不是实现细节。
 *
 * @module dsc/plugins/remote/types
 */
import { INVOKABLE_METHODS } from '../../core/host-methods.js'
import type { RuntimeSnapshot } from '../../contract.js'
import type { PushSubscribeOutcome } from '../../core/remote/push.js'
import type { RemotePairing } from '../../core/remote/pairing.js'
import type { TicketStore } from '../../core/remote/tickets.js'
import type { RemoteUploads } from '../../core/remote/uploads.js'

/** WS 协议版本：批 B 的界面按它认版本，破坏性变更时递增（v3 = 全局 seq + 增量帧 + 补帧）。 */
export const REMOTE_PROTOCOL_VERSION = 3

/**
 * 远程开放的 `DscRuntime` 方法：只是共享白名单（core/host-methods.ts）里的一个子集。
 *
 * 没开的那几类，以及为什么：
 *   - saveProvider / removeProvider / setProviderKey / setDefaultModel / getModelConfig：
 *     凭据与端点写入不开放给浏览器（token 泄了就是泄了，别再让它能改端点）；
 *   - setSettingValue / runSettingAction：能改设置就等于能改权限模式与沙箱档位，
 *     浏览端要改设置请到电脑上改；
 *   - installMarketSkill / setSkillEnabled / setMarketSources / readSkill：往本机装东西的动作；
 *   - dock / runCommand / goalAction / forkSession / purgeSessions / restoreSessions：
 *     宿主生命周期与不可逆的会话操作；
 *   - setPluginEnabled / setPolicy / setUiPrefs / setModel / runCommand 之外的管理动作同理。
 *
 * 上传（POST /api/upload）与推送订阅（POST /api/push-subscribe）不在这一份里：
 * 它们是 HTTP 路由，不是 RPC 方法。
 */
export const REMOTE_METHODS = [
  'submit',
  'interrupt',
  'openSession',
  'compact',
  'setModel',
  'setEffort',
  'refreshSessions',
  'listModels',
  'listSkills',
  'listPlugins',
  'getUiPrefs',
  'getSettingsSections',
  'getSectionValues',
  'usageStats',
  'listArchivedSessions',
  'archiveSessions',
  'renameSession',
  'setSessionPinned',
  'answerApproval',
  'answerPlan',
  'answerQuestion',
  'setMode',
  'clearTodos',
  'peekTranscript',
  'listUserMessages',
] as const satisfies readonly (typeof INVOKABLE_METHODS)[number][]

/** 远程白名单里有没有协议根本不认识的方法：有就报下面那个元组类型，编不过。 */
type NotInvokableRemotely = Exclude<(typeof REMOTE_METHODS)[number], (typeof INVOKABLE_METHODS)[number]>
const REMOTE_COVERAGE: NotInvokableRemotely extends never
  ? true
  : ['远程白名单里有协议不认识的方法：', NotInvokableRemotely] = true
void REMOTE_COVERAGE

/** 查表用的集合。 */
export const REMOTE_SET: ReadonlySet<string> = new Set<string>(REMOTE_METHODS)

/** 一个 WebSocket 会话要的宿主能力（由插件闭包提供，这里不认识 cordis）。 */
export interface RemoteServerDeps {
  port: number
  lan: boolean
  throttleMs: number
  /** 静态资源目录（默认 `lib/remote/assets`，配置可改）。 */
  assetsDir: string
  pairing: RemotePairing
  tickets: TicketStore
  /** 上传落盘（POST /api/upload）。 */
  uploads: RemoteUploads
  /** 派发一个白名单方法（调用方已做过白名单与来源标注）。 */
  invoke(method: string, args: unknown[]): Promise<unknown>
  /** 当前全量快照（批 B 契约的形状：entries 已定稿 + liveEntries 直播尾分开给）。 */
  snapshot(): RemoteSnapshot
  /** 订阅会话流变化（返回退订函数）。 */
  subscribe(listener: () => void): () => void
  /** 往桌面端的对话流写一句话（配对、吊销、上传这类事件）。 */
  notice(text: string): void
  /** Web Push 总开关（关着时订阅端点回 403、hello 里的公钥报 null）。 */
  pushEnabled(): boolean
  /** VAPID 公钥（Web Push 关着或不可用时 null）。 */
  pushPublicKey(): string | null
  /** 浏览器订阅入库（按 endpoint 去重）。 */
  pushSubscribe(payload: unknown, deviceId: string): PushSubscribeOutcome
  /** 按 endpoint 删订阅。 */
  pushUnsubscribe(endpoint: string): boolean
}

/** 批 B 契约里的快照：宿主 RuntimeSnapshot 加上会话身份，并把直播尾拆出来。 */
export interface RemoteSnapshot extends RuntimeSnapshot {
  sessionId: string
  cwd: string
  /** 已定稿条目。 */
  entries: RuntimeSnapshot['entries']
  /** 还在长的直播尾（core 里用负 id 标记）。 */
  liveEntries: RuntimeSnapshot['entries']
}

export interface RemoteServerHandle {
  readonly port: number
  readonly lan: boolean
  /** listen 成功与否；失败时 reject（调用方据此回收主控位）。 */
  readonly ready: Promise<void>
  close(): void
  /** 给全部连接推一条消息（例如 dsc/open-picker 转成 {type:'ui'}）。 */
  broadcast(message: Record<string, unknown>): void
  /**
   * 断开连接。
   * @param deviceId - 只断这台设备的；省略 = 全部断开（吊销全部设备时用）
   * @returns 断开了几条
   */
  closeDevices(deviceId?: string): number
}
