/**
 * 阶段分组的纯函数层（对照 dsh 的 process-groups.ts + process-activity.ts + step-process.ts）。
 *
 * 为什么需要这一层：整轮折叠（见 ChatView 的 roundFold）只给一轮一个开关，且固定画在轮首。
 * 长程任务一轮里会跑出十几个阶段（分析 → 查代码 → 改文件 → 再查 → 再改 → 收尾），用户一旦
 * 展开整轮，几十条过程条目就一起摊开，**中途没有第二个能收起来的地方**——这就是「只在最开始
 * 能折叠」。dsh 的解法是在轮内再切一层「过程组」：
 * - 切分规则 conversation-nodes/process-groups.ts:146-164；
 * - 组头（一行可点的小字）chat/ChatGroupSeat.tsx:91-128；
 * - 组头文案由这一组的工具类别聚合而成，conversation-nodes/step-process.ts:11-27。
 *
 * 本模块只做纯计算，不碰 React：分组口径与文案拼法都能脱离界面直接核对。
 *
 * 切分规则（与 dsh 一一对应）：
 * - **定稿正文是一段阶段的收尾**：遇到它就封组，正文自己不进组（dsh 的 reply 分支，
 *   process-groups.ts:159-162）——一条正文就是「上一阶段干完了」的信号。dsc 的 transcript
 *   里思考与正文本来就是两条独立条目（adapter/transcript.ts:284-298 的 message 分支），
 *   所以这条规则不用解析 assistant-step 就能照搬；
 * - 思考与工具调用进当前组（process-groups.ts:157-163）；
 * - **计划卡单独成界**：封掉前面的组，自己也不进组。它是审批流的一部分（「等你点批准」），
 *   跟过程内容不是一回事；dsh 里 exit_plan_mode 走审批，同属过程之外的一类；
 * - **system 提示既不进组也不封组**：dsc 的 system 混了错误提示、宿主通知、「已恢复会话」
 *   三种东西，拿它当边界会切出莫名其妙的空组；
 * - **尾组只有等这一轮收尾才算「已结束」**：收尾前它一直在长（新工具会并进来），这正是需要
 *   的行为——组序号不变，用户已经展开的那一组不会被直播新增的内容重置。
 *
 * 实时详情（对照 dsh 的 liveToolDetail / liveReasoningDetail，process-activity.ts:23-87）：
 * 组体默认收起之后，屏幕上「现在在干什么」只剩组头这一行，所以未结束的组头除了类别还要带一句
 * 具体任务——「正在运行命令 · pnpm build」。取参数的键序照抄 dsh（命令 → 路径 → 查询 → …），
 * 一个都取不到就退回工具名；没有运行中的工具时取组内最后一段直播尾思考。
 *
 * @module desktop/renderer/process-groups
 */
import type { TranscriptEntry } from '@dsc/runtime/contract.js'
import type { RoundInfo } from './turn-timing.js'

/**
 * 过程类别：把工具名归成十四个行为类（对照 dsh 的 process-activity.ts:7-21）。
 *
 * 为什么要归类而不是按工具名分组：一次「查代码」可能同时用了 grep 和 glob，一次「改文件」
 * 可能 write 完又 edit。用户关心的是「这一阶段干了哪类事」，不是每个工具各算一次。
 */
export type ProcessActivity =
  | 'read' | 'readImage' | 'search' | 'write' | 'edit'
  | 'commands' | 'code' | 'webSearch' | 'webFetch' | 'browser'
  | 'subagents' | 'plan' | 'questions' | 'tools'

/** 一个类别在这一组里出现了几次。 */
export interface ActivityCount {
  kind: ProcessActivity
  count: number
}

/**
 * 一个阶段组：一轮里相邻的过程条目，被一条定稿正文（或计划卡、轮末）收口。
 *
 * 组里只有思考与工具调用；中间那些「阶段性正文」不进组，但仍属于整轮过程范围
 * （整轮收起时它们一起消失，见 ChatView 的 inFold）。
 */
export interface StepGroup {
  /** 属于哪一轮（与 RoundInfo.index 同源）。 */
  roundIndex: number
  /**
   * 轮内组序号（0 基）。
   *
   * 为什么要它而不是 entries 下标：直播中尾组会不断吸收新工具，组内第一条的下标不变、成员
   * 却在长；而正文封组后新组的序号是确定的。展开态的存档键用它，直播时反复重算也不会把用户
   * 已经点开的那一组算丢（对照 dsh 保组身份的 extendedGroup，process-groups.ts:173-190）。
   */
  seq: number
  /** 组内第一条可折叠条目在 entries 里的下标（组头就画在这里）。 */
  startIndex: number
  /** 组内最后一条可折叠条目在 entries 里的下标（含）。 */
  endIndex: number
  /** 这一组的工具调用按类别计数，按次数降序、同数按首次出现顺序。 */
  counts: ActivityCount[]
  /**
   * 组里最后一个还在跑的工具属于哪一类；没有运行中的工具就是 undefined。
   *
   * 未结束的组头只报它，不报 counts（对照 dsh 的 ProcessActivitySummary.running，
   * contract/process-groups.ts:8 与 conversation-nodes/README.zh.md:158-159）。
   */
  running?: ProcessActivity
  /**
   * 此刻在跑的那个工具还在**准备中**（模型刚吐了名字、参数没到齐，见 contract 的
   * `ToolStatus`）。组头据此在「正在读取文件」与「准备读取文件」之间切。
   *
   * 对照 dsh 的 `ProcessActivitySummary.preparing`（contract/process-groups.ts）。
   */
  preparing?: boolean
  /**
   * 未结束组的实时任务详情（「pnpm build」这种），已结束的组不带。
   *
   * 来源二选一：组里最后一个运行中的工具的某个参数字段；组里没有运行中的工具时，取最后一段
   * 直播尾思考（对照 dsh 的 liveReasoningDetail，它在没有 running 工具时才启用）。
   * 两边都取不到就是 undefined——组头只显示类别，不显示空的分隔点。
   */
  runningDetail?: string
  /**
   * 这一组是不是「已经结束」：后面还有内容，或者这一轮已经收尾。
   *
   * 口径照 dsh 的 GroupSnapshot.data.closed（contract/process-groups.ts:15-19）：它说的是
   * 「这段内容结束了」，不是「界面上收起来了」。组头据此在「正在…」与「已…」两套文案之间切。
   */
  closed: boolean
}

/** 一次分组的结果：组本身，加两张给渲染层用的查找表。 */
export interface StepGrouping {
  /** 所有阶段组，按出现顺序。 */
  readonly groups: readonly StepGroup[]
  /** entries 下标 → 组头画在这一条上的那个组（只有组内第一条有这个表项）。 */
  readonly headAt: ReadonlyMap<number, StepGroup>
  /** entries 下标 → 它属于哪个组（组头与组员都有）。 */
  readonly at: ReadonlyMap<number, StepGroup>
}

/**
 * 不进整轮过程区、也不该被整轮折叠藏起来的条目类型
 * （逐项对照 dsh 的 `TURN_PROCESS_INDEPENDENT_KINDS`，contract/turn-process.ts:20-34）。
 *
 * 两件事共用这一份表，别的地方别再各写一遍：
 * - **整轮折叠**：这些条目落在过程区的下标区间里也不挂 `hidden`（dsh 的
 *   `TURN_PROCESS_INDEPENDENT_KINDS` 就是给整轮折叠用的）；
 * - 渲染层据此把它们排到「过程区之后」那一组，不参与阶段分组。
 *
 * 为什么 `system` 在这里：dsc 的 system 条目混了错误提示、宿主通知、「已恢复会话」三种东西，
 * 收起过程不能把「这一轮出错了」也一起藏掉——用户会以为那一轮只是正常答完了。
 */
export const TURN_PROCESS_INDEPENDENT: ReadonlySet<TranscriptEntry['kind']> = new Set([
  'user',
  'plan',
  'system',
  'turn-end',
  'turn-max-tokens',
])

/**
 * 工具名 → 过程类别。
 *
 * 匹配顺序与 dsh 的 process-activity.ts:7-21 一致（从上往下首个命中），另加 dsc 自己的几个
 * 工具名：`browser`（图二里那种 navigate / evaluate）、`search` 与 `session_search`（都归
 * 「查代码」）、`skill` 与 `plugin_manager`（归通用工具）。不认识的一律归 `tools`——不猜。
 */
export function activityOf(name: string): ProcessActivity {
  const tool = name.toLowerCase()
  if (tool === 'read') return 'read'
  if (tool === 'read_image') return 'readImage'
  if (tool === 'grep' || tool === 'glob' || tool === 'search' || tool === 'session_search'
    || tool.endsWith('_inspect')) return 'search'
  if (tool === 'write') return 'write'
  if (tool === 'edit' || tool === 'apply_patch') return 'edit'
  if (tool === 'bash' || tool === 'pwsh' || tool === 'exec_command' || tool === 'write_stdin'
    || tool.startsWith('terminal_')) return 'commands'
  if (tool === 'run_code') return 'code'
  if (tool === 'web_search') return 'webSearch'
  if (tool === 'web_fetch') return 'webFetch'
  if (tool === 'browser') return 'browser'
  if (tool === 'subagent' || tool.startsWith('subagent_')) return 'subagents'
  if (tool === 'todo_write' || tool === 'create_goal' || tool === 'update_goal'
    || tool === 'get_goal' || tool === 'exit_plan_mode') return 'plan'
  if (tool === 'ask_user' || tool === 'ask_user_question' || tool === 'request_user_input') return 'questions'
  return 'tools'
}

/**
 * 实时详情优先取哪些参数键，按顺序试，第一个取到非空值的胜出。
 *
 * 顺序照抄 dsh 的 LIVE_TOOL_DETAIL_KEYS（process-activity.ts:25-28）：先把「这件事是什么」
 * 的说明性字段（title / description / objective / task / question / prompt）试完，再试操作对象
 * （command / query / pattern / url / path / target）。为什么不按字母序或按工具自定义：
 * 这份表是跨工具共用的，顺序一变，「正在运行命令 · 删除临时目录」就可能变成「正在运行命令 · 1」。
 */
const DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name', 'question', 'questions', 'prompt', 'message',
  'command', 'cmd', 'queries', 'query', 'pattern', 'url', 'uri', 'file_path', 'path', 'target', 'action', 'status',
] as const

/** 详情一行最多几个字素簇；超出截断并补省略号（对照 dsh 的 LIVE_TOOL_DETAIL_MAX_CHARS）。 */
const DETAIL_MAX_CHARS = 160

/**
 * 按字素簇切字（不是按 UTF-16 码元，也不是按码点）。
 *
 * 为什么要这么讲究：截断点如果落在 emoji 的 ZWJ 序列或带变音符的字母中间，切出来的半个字符
 * 会变成「」，看着像界面坏了。dsh 同样用 Intl.Segmenter（process-activity.ts:24）。
 * 运行环境没有这个 API 时退回按码点切——比按码元切强，至少不会切出半个代理对。
 */
const DETAIL_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined

/** 把一个字符串切成字素簇数组。 */
function graphemes(text: string): string[] {
  if (DETAIL_SEGMENTER === undefined) return Array.from(text)
  return Array.from(DETAIL_SEGMENTER.segment(text), (part) => part.segment)
}

/**
 * 把参数值压成一行详情：只认字符串与「全是字符串的数组」，空白折成一个空格，超长截断。
 *
 * 为什么不认对象与数字：详情要挤在组头这一行里，`{"a":1}` 这种字面量对「现在在干什么」零信息量，
 * 而数字（比如超时毫秒数）脱离了键名根本读不懂。取值失败不算错误，退回工具名即可——
 * 详情是锦上添花，不该让组头变成空白。
 *
 * @param value 参数的原始值（任意类型）
 * @returns 一行详情；压不出内容时返回空字符串
 */
export function normalizeDetail(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? value.join(', ')
      : ''
  const normalized = text.replace(/\s+/g, ' ').trim()
  const chars = graphemes(normalized)
  if (chars.length <= DETAIL_MAX_CHARS) return normalized
  // 留一个字符的位置给省略号：160 是「含省略号」的总长上限，不是「截 160 再加省略号」。
  return `${chars.slice(0, DETAIL_MAX_CHARS - 1).join('').trimEnd()}…`
}

/**
 * `questions` 参数的详情：取第一个问题对象的 `question` 字段。
 *
 * 为什么要单独一条路：`ask_user` 的参数是「问题对象数组」，直接走 normalizeDetail 只会得到空
 * 字符串（数组元素不是字符串），于是组头退回「等待你的操作」——那一行的信息量就白丢了。
 * 对照 dsh 的 questionDetail（process-activity.ts:43-51）。
 */
function questionDetail(value: unknown): string {
  if (!Array.isArray(value)) return ''
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const detail = normalizeDetail((item as Record<string, unknown>).question)
    if (detail !== '') return detail
  }
  return ''
}

/**
 * 一次工具调用的实时详情：按 {@link DETAIL_KEYS} 顺序取参数的第一个非空值。
 *
 * 三种降级（都对照 dsh 的 liveToolDetail，process-activity.ts:70-87）：参数不是完整 JSON
 * （流式途中的半截参数）→ 退回工具名；解析出来不是对象 → 退回工具名；一个键都没取到值 →
 * 退回工具名。**参数解析失败不算异常**：直播途中大半时间参数本来就不完整。
 *
 * @param name 工具名（read / bash / grep …）
 * @param argsText 模型产出的原始 arguments JSON 字符串
 */
export function liveToolDetail(name: string, argsText: string): string {
  let args: unknown
  try {
    args = JSON.parse(argsText)
  } catch {
    return normalizeDetail(name)
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return normalizeDetail(name)
  const record = args as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    if (!(key in record)) continue
    const detail = key === 'questions' ? questionDetail(record[key]) : normalizeDetail(record[key])
    if (detail !== '') return detail
  }
  return normalizeDetail(name)
}

/**
 * 一段思考里的实时详情：取最后一个非空段落，去掉 `**` 后压成一行。
 *
 * 为什么取「最后一段」而不是首行：直播中思考在往长里写，最后一段才是模型此刻在琢磨的事
 * （对照 dsh 的 liveReasoningDetail，process-activity.ts:53-68 从后往前扫段落）。
 *
 * @param text 思考原文（通常是直播尾那一条）
 * @returns 一行详情；整段都是空白时返回空字符串
 */
export function reasoningDetail(text: string): string {
  const paragraphs = text.split(/\r?\n[\t ]*\r?\n/)
  for (let at = paragraphs.length - 1; at >= 0; at -= 1) {
    const detail = normalizeDetail((paragraphs[at] ?? '').replaceAll('**', ''))
    if (detail !== '') return detail
  }
  return ''
}

/** 已结束组的类别文案（对照 dsh 的中文文案表 locale.ts:35-48）。 */
const DONE_LABEL: Record<ProcessActivity, string> = {
  read: '已读取文件',
  readImage: '已读取图片',
  search: '已搜索代码',
  write: '已写入文件',
  edit: '修改了文件',
  commands: '执行了命令',
  code: '运行了代码',
  webSearch: '已搜索网页',
  webFetch: '已访问网页',
  browser: '已浏览网页',
  subagents: '已协调子智能体',
  plan: '更新了计划',
  questions: '向用户提出了问题',
  tools: '已调用工具',
}

/** 组头的类别与详情之间的分隔点，两边各带一个空格（逐字照抄 dsh 的 message.turnProcess.separator）。 */
export const STEP_TITLE_SEPARATOR = ' · '

/**
 * 组头的实时标题：类别 + 具体任务详情两段。
 *
 * 为什么把两段绑成一个对象而不是各传各的：它们必须同源。图标跟着 activity 取（见 StepGroupRow），
 * 文案跟着 detail 拼，两边要是分别来自不同时刻，就会出现「标题说在读文件、图标是终端」
 * （对照 dsh 把两者一起塞进 LiveProcessTitle 再一起防抖，ChatGroupSeat.tsx:31-35）。
 */
export interface LiveProcessTitle {
  /** 此刻在跑的那一类活；一类都没有就是「分析」（thinking）。 */
  activity: ProcessActivity | 'thinking'
  /** 具体任务详情（「pnpm build」）；取不到就是空字符串。 */
  detail: string
  /** 那个工具还在准备中吗（模型吐了名字、参数没到齐）。组头文案据此二选一。 */
  preparing: boolean
}

/** 未结束的组此刻「想要显示」的实时标题（值来自分组结果，不做防抖）。 */
export function liveTitleOf(group: Readonly<StepGroup>): LiveProcessTitle {
  return {
    activity: group.running ?? 'thinking',
    detail: group.runningDetail ?? '',
    preparing: group.preparing === true,
  }
}

/** 两个实时标题是不是同一件事：三项全同才算没变（准备中与正在跑是两句不同的话）。 */
export function sameLiveTitle(left: Readonly<LiveProcessTitle>, right: Readonly<LiveProcessTitle>): boolean {
  return left.activity === right.activity && left.detail === right.detail && left.preparing === right.preparing
}

/** 组头实时标题的最短保留时长（毫秒），逐字照抄 dsh 的 PROCESS_TITLE_MINIMUM_MS。 */
export const PROCESS_TITLE_MINIMUM_MS = 150

/**
 * 这一刻该不该换组头标题（对照 dsh 的 useStableLiveProcessTitle，ChatGroupSeat.tsx:58-81）。
 *
 * 为什么需要它：直播时事件密集，一次多步工具轮里 read → grep → bash 可能在一秒内换三四个标题，
 * 标题一直在跳，用户根本读不出「现在卡在哪一步」。规矩是——**一个标题至少显示 150ms**，
 * 到点再换成那时最新的那一个（中间态直接跳过，不排队，对照 dsh 的 desiredRef.current 取最新）。
 *
 * 拆成纯函数是为了能直接测：真实行为依赖时钟，断言「间隔小于 150ms 时标题不变」需要控制时间，
 * 而纯函数把时钟换成入参 `heldMs` 就能逐格核对。
 *
 * @param shown 当前显示的那个标题
 * @param desired 此刻该显示的那个标题
 * @param heldMs 当前这个标题已经显示了多久（毫秒）
 * @returns `keep` = 保持当前标题；`waitMs` > 0 表示等这么久之后该再判一次
 */
export function liveTitleDecision(
  shown: Readonly<LiveProcessTitle>,
  desired: Readonly<LiveProcessTitle>,
  heldMs: number,
): { keep: boolean; waitMs: number } {
  // 想要的跟显示的一样：没什么可换的，也不必挂定时器
  if (sameLiveTitle(shown, desired)) return { keep: true, waitMs: 0 }
  const remaining = PROCESS_TITLE_MINIMUM_MS - heldMs
  if (remaining <= 0) return { keep: false, waitMs: 0 }
  return { keep: true, waitMs: remaining }
}

/**
 * 把类别标题与实时详情拼成组头的完整一行。
 *
 * 分隔点只在真有详情时才画：取不到详情就是干净的一行类别标题，不留「正在运行命令 ·」这种半截话
 * （对照 dsh 的 `title = label + separator + detail`，ChatGroupSeat.tsx:111-112）。
 *
 * @param label 类别文案（stepGroupTitle 的输出）
 * @param detail 实时详情；空字符串表示没有
 */
export function joinLiveDetail(label: string, detail: string): string {
  return detail === '' ? label : `${label}${STEP_TITLE_SEPARATOR}${detail}`
}

/** 未结束组的类别文案（对照 dsh 的 locale.ts:8-21）。 */
const RUNNING_LABEL: Record<ProcessActivity, string> = {
  read: '正在读取文件',
  readImage: '正在读取图片',
  search: '正在搜索代码',
  write: '正在写入文件',
  edit: '正在编辑文件',
  commands: '正在运行命令',
  code: '正在运行代码',
  webSearch: '正在搜索网页',
  webFetch: '正在访问网页',
  browser: '正在浏览网页',
  subagents: '正在协调子智能体',
  plan: '正在更新计划',
  questions: '等待你的操作',
  tools: '正在调用工具',
}

/** 类别数为 0 时的两套兜底文案：一组只思考没调工具，就是「分析」。 */
const DONE_THINKING = '已完成分析'
const RUNNING_THINKING = '正在分析请求'

/**
 * 准备中组的类别文案（逐项对照 dsh 的 locale.ts:22-34）。
 *
 * 什么时候用：「模型已经吐了工具名、参数还没到齐」的那一瞬间（contract 的
 * `ToolStatus = 'preparing'`）。它与「正在…」是两件事——「正在读取文件」是工具真的在跑，
 * 「准备读取文件」是模型还在把参数往外吐。长参数（一整段补丁）时这段能持续好几秒，
 * 不给文案用户就只看到界面停着不动。
 */
const PREPARE_LABEL: Record<ProcessActivity, string> = {
  read: '准备读取文件',
  readImage: '准备读取图片',
  search: '准备搜索代码',
  write: '准备写入文件',
  edit: '准备编辑文件',
  commands: '准备运行命令',
  code: '准备运行代码',
  webSearch: '准备搜索网页',
  webFetch: '准备访问网页',
  browser: '准备浏览网页',
  subagents: '准备协调子智能体',
  plan: '准备更新计划',
  questions: '准备提问',
  tools: '准备调用工具',
}

/** 拼接用的连接符（对照 dsh 的 message.stepProcess.comma / joinTwo / more）。 */
const COMMA = '，'
const JOIN_TWO = '并'
const SHARED_PREFIX = '已'
const MORE = '等'

/** 最多列几个类别：dsh 取前三类，多出来的收进「等」（step-process.ts:15,27）。 */
const TITLE_MAX_KINDS = 3

/**
 * 把一组的类别计数拼成组头文案（对照 dsh 的 processTitle + ProcessGroupHeader 的取值分支，
 * step-process.ts:11-27 与 ChatGroupSeat.tsx:108-110）。
 *
 * 已结束与未结束走的是两套完全不同的取法，这是 dsh 有意分开的：
 * - **已结束**报聚合（次数最多的前三类拼成一句话），回答「这一阶段干过哪几类活」；
 * - **未结束**只报此刻在干的那一类，回答「现在卡在哪一步」。没有运行中的工具时一律退回
 *   「正在分析请求」——**即使这一组已经调过几次工具**（README.zh.md:159）。为什么不退回聚合：
 *   那一刻用户要的是「现在在干什么」，报一串已完成的事只会让人以为活停了。
 *
 * @param counts 这一组的类别计数（已按次数降序）
 * @param closed 这一组是否已结束
 * @param running 组里最后一个运行中工具属于哪一类（未结束且没有工具在跑时传 undefined）
 * @param preparing 那个工具还在准备中吗（模型吐了名字、参数没到齐）
 */
export function stepGroupTitle(
  counts: readonly ActivityCount[],
  closed: boolean,
  running?: ProcessActivity,
  preparing?: boolean,
): string {
  if (!closed) {
    if (running === undefined) return RUNNING_THINKING
    return preparing === true ? PREPARE_LABEL[running] : RUNNING_LABEL[running]
  }
  const labels = counts.slice(0, TITLE_MAX_KINDS).map((item) => DONE_LABEL[item.kind])
  const first = labels[0]
  // 一组只思考没调工具：类别表是空的，这时用「已完成分析」
  if (first === undefined) return DONE_THINKING
  const second = labels[1]
  if (second === undefined) return first
  if (labels.length === 2) {
    // 两项都以「已」开头时省掉第二个的「已」：中文里「已读取文件并已搜索代码」读着累赘，
    // dsh 的英文版靠首字母小写表达同一件事（step-process.ts:22-25）。
    const shared = first.startsWith(SHARED_PREFIX) && second.startsWith(SHARED_PREFIX)
    const tail = shared ? second.slice(SHARED_PREFIX.length) : second
    return `${first}${JOIN_TWO}${tail}`
  }
  const title = labels.join(COMMA)
  return counts.length > TITLE_MAX_KINDS ? `${title}${MORE}` : title
}

/**
 * 组里最后一个还在跑（或正在准备）的工具：类别 + 实时详情 + 是不是准备中。
 *
 * 口径照 dsh 的 processActivity：它取「开始时间最大的运行中调用」，时间相同时后遍历的胜出
 * （process-activity.ts:97-114）。dsc 的 transcript 是 append-only 的，条目顺序就是开始顺序，
 * 所以直接取组内最后一条运行中的工具即可，不必再比 startedAt——那一位在老会话里还可能缺席。
 */
function runningTool(
  entries: readonly TranscriptEntry[],
  indexes: readonly number[],
): { activity: ProcessActivity; detail: string; preparing: boolean } | undefined {
  let live: { activity: ProcessActivity; detail: string; preparing: boolean } | undefined
  for (const index of indexes) {
    const entry = entries[index]
    if (entry === undefined || entry.kind !== 'tool') continue
    const status = entry.call.status
    // 「准备中」与「运行中」都算「此刻在干什么」：前者是模型刚吐了名字、参数还在路上，
    // 后者是工具真的开跑了。两者都要占用组头那一行，只是文案不同。
    if (status !== 'running' && status !== 'preparing') continue
    const activity = activityOf(entry.call.name)
    const preparing = status === 'preparing'
    live = {
      activity,
      preparing,
      // 准备阶段不解析参数（这会儿参数本来就不完整），只有通用类别才补一句工具名——
      // dsh 的原话是「只有『准备调用工具』在标准模式中追加协议工具名，其他类别不追加」，
      // 因为「准备读取文件 · read」纯属废话。
      detail: preparing
        ? (activity === 'tools' ? normalizeDetail(entry.call.name) : '')
        : liveToolDetail(entry.call.name, entry.call.argsText),
    }
  }
  return live
}

/**
 * 组里最后一条直播尾思考的原文（没有就是空字符串）。
 *
 * 为什么只认 `id < 0`：那是还在往外吐的那一段（见 ChatView 的「直播尾」口径）。定稿的思考条目
 * 不属于「现在在干什么」，拿它当实时详情会把上一阶段的事报成当前的。
 */
function lastLiveThinking(entries: readonly TranscriptEntry[], indexes: readonly number[]): string {
  let text = ''
  for (const index of indexes) {
    const entry = entries[index]
    if (entry === undefined || entry.kind !== 'thinking' || entry.id >= 0) continue
    text = entry.text
  }
  return text
}

/** 数一数这一组里的工具调用各属哪一类（对照 dsh 的 processActivity，process-activity.ts:94-128）。 */
function countActivities(
  entries: readonly TranscriptEntry[],
  indexes: readonly number[],
): ActivityCount[] {
  const counts = new Map<ProcessActivity, number>()
  for (const index of indexes) {
    const entry = entries[index]
    if (entry === undefined || entry.kind !== 'tool') continue
    const kind = activityOf(entry.call.name)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  // Map 保持插入顺序，sort 是稳定排序：同次数时留下的是「第一次出现」的先后，
  // 与 dsh 的类别排名口径一致（process-activity.ts:124）
  return [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => right.count - left.count)
}

/**
 * 把一轮一轮的条目切成阶段组。
 *
 * @param entries 当前 transcript（含直播尾，负 id）
 * @param rounds 轮次划分（见 turn-timing.ts 的 roundInfos）
 * @param isRunning 这一轮还在跑吗（口径与 ChatView 的 RoundFold.running 一致）
 * @param settledOnly 只给「已收尾的轮」分组（对照 dsh 的 `stepGrouping: 'history'`，
 *   ChatGroupSeat.tsx:143-144）。详细档用它：**运行中的那轮直接摊开、历史轮才折**——
 *   那一档要的是「看细节」，而正在跑的那一轮细节本来就该摊着。
 * @returns 组列表与两张查找表；没有任何过程条目时 groups 为空
 */
export function groupSteps(
  entries: readonly TranscriptEntry[],
  rounds: readonly RoundInfo[],
  isRunning: (roundIndex: number) => boolean,
  settledOnly = false,
): StepGrouping {
  const groups: StepGroup[] = []
  for (const round of rounds) {
    // 只给历史轮分组：运行中的那一轮整轮摊开，连组头都不画
    if (settledOnly && isRunning(round.index)) continue
    /** 当前组的条目下标（收口时一次性结算成 StepGroup）。 */
    let pending: number[] = []
    let seq = 0
    /** 收口：把 pending 结算成一组，closed 说明这段内容后面还有没有东西。 */
    const flush = (closed: boolean): void => {
      const first = pending[0]
      const last = pending[pending.length - 1]
      if (first === undefined || last === undefined) return
      const group: StepGroup = {
        roundIndex: round.index,
        seq,
        startIndex: first,
        endIndex: last,
        counts: countActivities(entries, pending),
        closed,
      }
      // 已结束的组不带实时类别与详情：dsh 的组收口时会把 running 与 detail 一起清空
      // （conversation-nodes/README.zh.md:310），组头随后改用聚合文案。
      if (!closed) {
        const live = runningTool(entries, pending)
        if (live !== undefined) {
          group.running = live.activity
          if (live.preparing) group.preparing = true
        }
        const detail = live?.detail ?? reasoningDetail(lastLiveThinking(entries, pending))
        if (detail !== '') group.runningDetail = detail
      }
      groups.push(group)
      seq += 1
      pending = []
    }
    for (let at = round.startIndex + 1; at <= round.endIndex; at += 1) {
      const entry = entries[at]
      if (entry === undefined) continue
      if (entry.kind === 'thinking' || entry.kind === 'tool') {
        pending.push(at)
        continue
      }
      // 下面这几种都是**独立节点**：封掉前面的组，自己不进组。
      // - 定稿正文：这一阶段到此收口（dsh 的 reply 分支）。直播尾的 text 同样是收口信号——
      //   模型开始写正文，就说明前一段工具活干完了；
      // - 计划卡：审批流的一部分（「等你点批准」）；
      // - user：轮中途插话（steering），它是这一轮里一个真实的边界；
      // - turn-end / turn-max-tokens：轮尾标记与长度上限提示，都是轮级的独立事件；
      // - model-retry：模型重试。它是二级分组的边界，但**整轮折叠仍然包含它**
      //   （dsh 的原话：「二级分组把模型重试视为分隔节点，但整轮折叠仍包含重试行」）——
      //   所以它不在 TURN_PROCESS_INDEPENDENT 那张表里。
      if (
        entry.kind === 'text'
        || entry.kind === 'plan'
        || entry.kind === 'user'
        || entry.kind === 'turn-end'
        || entry.kind === 'turn-max-tokens'
        || entry.kind === 'model-retry'
      ) {
        flush(true)
        continue
      }
      // system：既不进组也不封组（见模块注释）
    }
    // 尾组：这一轮收尾了才算结束。没收尾时它一直是「正在…」，因为新工具还会并进来
    flush(!isRunning(round.index))
  }
  const headAt = new Map<number, StepGroup>()
  const at = new Map<number, StepGroup>()
  for (const group of groups) {
    headAt.set(group.startIndex, group)
    for (let index = group.startIndex; index <= group.endIndex; index += 1) at.set(index, group)
  }
  return { groups, headAt, at }
}
