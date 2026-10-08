/**
 * 宿主协议的方法白名单：`DscRuntime` 上哪几个方法允许被宿主进程从协议那头调。
 *
 * 为什么单独落在 core：这份清单原先长在 host-stdio 里，而远程控制（remote 插件）
 * 还要从里面再挑一个更小的子集给浏览端用。两份清单同源，加一个方法时两边都不会
 * 静默漏掉——`INVOKE_COVERAGE` 这一行会在编译期把漏掉的那个方法名报出来。
 *
 * @module dsc/core/host-methods
 */
import type { DscRuntime } from '../contract.js'

/**
 * 只能在宿主进程里成立、不经协议转发的方法：
 * 订阅与快照走 `snapshot` 消息流，退出与清理由宿主动手（进程就是这么关掉的）。
 */
type LocalOnlyMethod = 'subscribe' | 'getSnapshot' | 'exit' | 'dispose'

/** 协议允许调用的方法 = `DscRuntime` 去掉那几个本地方法，不另立一份接口。 */
export type InvokableMethod = Exclude<keyof DscRuntime, LocalOnlyMethod>

/**
 * 这份清单就是协议的全部可调用面：写成 `satisfies` 是为了让编译器逐条核对方法名，
 * 拼错一个字母当场报错，而不是等到运行时才「协议不允许调用」。
 */
export const INVOKABLE_METHODS = [
  'submit',
  'interrupt',
  // 排队输入（0.6.67）：队列条上的编辑 / 删除 / 插话
  'editQueued',
  'removeQueued',
  'steerQueued',
  'openSession',
  'compact',
  'setModel',
  'setEffort',
  'refreshSessions',
  'listModels',
  'listPlugins',
  'setPluginEnabled',
  'listTeammates',
  // 队友的界面管理通道（等价于 subagent 工具的 stop / message；远程白名单里没有它们）
  'stopTeammate',
  'messageTeammate',
  'removeTeammate',
  'peekTranscript',
  'runCommand',
  'setPolicy',
  'dock',
  'answerApproval',
  // 协作模式、任务清单、计划评审、目标、模型提问
  'setMode',
  // 模式（预设）：人格 + 工具集 + 提示词那根旋钮（设置页「模式」分区与输入框旋钮走这几条）
  'listPresets',
  'readPreset',
  'usePreset',
  'savePreset',
  'removePreset',
  'setDefaultPreset',
  'listTools',
  'clearTodos',
  'goalAction',
  'answerQuestion',
  'answerPlan',
  // 会话库：归档 / 恢复 / 删除 / 改名 / 置顶 / 分叉 / 用量 / 界面偏好
  'archiveSessions',
  'listArchivedSessions',
  'usageStats',
  'restoreSessions',
  'purgeSessions',
  'renameSession',
  'setSessionPinned',
  'listUserMessages',
  'forkSession',
  'getUiPrefs',
  'setUiPrefs',
  // 技能中心
  'listSkills',
  'readSkill',
  'setSkillEnabled',
  'browseMarket',
  'installMarketSkill',
  'setMarketSources',
  // 设置界面
  'getSettingsSections',
  'getSectionValues',
  'setSettingValue',
  'runSettingAction',
  'getModelConfig',
  'saveProvider',
  'discoverModels',
  'removeProvider',
  'setProviderKey',
  'setDefaultModel',
] as const satisfies readonly InvokableMethod[]

/** 这份清单漏了哪个方法（本地那几样之外）：漏一个就报下面那个元组类型，编不过。 */
type UnlistedInvokable = Exclude<InvokableMethod, (typeof INVOKABLE_METHODS)[number]>

/**
 * 编译期兜底：往 `DscRuntime` 加一个方法而这份清单没跟上时，这里报错。
 * 没有这一行，新方法会静静地在协议上不通（渲染器调它得到「不允许调用」），很难查。
 */
const INVOKE_COVERAGE: UnlistedInvokable extends never ? true : ['这些方法还没进协议白名单：', UnlistedInvokable] =
  true
void INVOKE_COVERAGE

/** 查表用的集合（`isInvokableMethod` 拿它把线上来的字符串收窄成方法名）。 */
const INVOKABLE_SET: ReadonlySet<string> = new Set<string>(INVOKABLE_METHODS)

/** 把线上来的方法名收窄成「协议允许调用的方法」。 */
export const isInvokableMethod = (method: string): method is InvokableMethod => INVOKABLE_SET.has(method)
