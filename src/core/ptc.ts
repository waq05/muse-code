/**
 * PTC（用代码组织工具调用）的纯逻辑：脚本产出的整形、调用日志、限额。
 *
 * 这一层不认识 ctx，也不认识 vm——它只管「一段脚本跑完之后，交回给模型的那段文字
 * 长什么样」。真正跑脚本、过守卫链、弹审批卡的那部分在 `plugins/ptc.ts`。
 *
 * 为什么要单独一层：整形规则（截断、调用日志、控制台输出）是模型实际看到的正文，
 * 值得能单独拿出来测；而 vm 与守卫链那半边必须带着 ctx 才成立。
 *
 * @module dsc/core/ptc
 */
import type { ToolEntry } from './tools.js'

/** 一次脚本里发生的内部调用（进结果正文的调用日志）。 */
export interface PtcCallRecord {
  /** 工具真名。 */
  name: string
  /** 参数摘要（单行、已截断）。 */
  args: string
  /** 耗时毫秒。 */
  ms: number
  /** true = 跑完了；false = 被守卫链拒绝或执行失败。 */
  ok: boolean
  /** 失败或被拒时的说明；成功时不写。 */
  note?: string
}

/** 额度与截断（都写在这里，自检脚本照着它断言）。 */
export const PTC_LIMITS = {
  /** 一段脚本最多能发起多少次内部工具调用（防止脚本自转把宿主拖住）。 */
  maxCalls: 200,
  /** 同步执行的时间上限（死循环 `while(true){}` 靠它掐断）。 */
  syncTimeoutMs: 15_000,
  /** 整段脚本（含所有 await）的时间上限。 */
  deadlineMs: 120_000,
  /** 交回给模型的正文上限（超了从尾部截断并说明）。 */
  resultMax: 20_000,
  /** 控制台输出保留的最后多少行。 */
  consoleLines: 50,
} as const

/** 工具的 SDK 调用签名（写进 run_code 的说明里，让人和模型都看得懂）。 */
export const PTC_SDK_SIGNATURE = 'await sdk.<工具名>({ ...工具原来的参数 })'

/**
 * 把脚本的返回值整形成交回模型的文字。
 *
 * 字符串原样交回；undefined / null 明确说「什么都没交回来」（比给模型一片空白强，
 * 它至少知道自己忘了 return）；其余一律 JSON（缩进两格，好读）。
 */
export function ptcResultText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return '（脚本没有 return，什么也没交回来）'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value) // 循环引用之类：给个能看的字符串，别让整轮请求失败
  }
}

/**
 * 组装交回给模型的那段正文：脚本输出 + 调用日志 + 返回值。
 *
 * 调用日志是**必须**的：脚本里的每次工具调用都不各自成为一条 tool 记录
 * （jsonl 里 tool 记录必须与 assistant 的 tool_call 成对，凭空插一条会让重放出来的
 * 请求 400），所以「这一轮到底调了什么、参数是什么、成没成」只能靠这段日志留底 ——
 * 模型看到的和日志里存的是同一份。
 */
export function ptcResultBody(input: {
  value: unknown
  calls: readonly PtcCallRecord[]
  logs: readonly string[]
  /** 被截断的额外说明（例如调用次数超限），没有就不写。 */
  trouble?: string
}): string {
  const parts: string[] = []
  if (input.trouble !== undefined) parts.push(`【脚本没跑完】${input.trouble}`)
  if (input.logs.length > 0) {
    parts.push(`脚本输出（最后 ${input.logs.length} 行）：\n${input.logs.join('\n')}`)
  }
  parts.push(`返回值：\n${ptcResultText(input.value)}`)
  if (input.calls.length > 0) {
    const rows = input.calls.map(
      (call, index) =>
        `${index + 1}. ${call.ok ? '✓' : '✗'} ${call.name}(${call.args}) ${call.ms}ms${call.note === undefined ? '' : ` —— ${call.note}`}`,
    )
    parts.push(`这一轮调了 ${input.calls.length} 次工具：\n${rows.join('\n')}`)
  } else {
    parts.push('这一轮没有调用任何工具。')
  }
  return truncate(parts.join('\n\n'))
}

/** 超长正文从尾部截断（尾巴通常是日志，返回值在最前面）。 */
export function truncate(text: string, max = PTC_LIMITS.resultMax): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（正文超过 ${max} 字符，后面截掉了：先用代码把结果压小，再 return 摘要）`
}

/** 一个工具在脚本里怎么用（`sdk.describe` 的返回值）。 */
export function ptcDescribe(tool: ToolEntry): string {
  return [`工具 ${tool.name}（风险：${tool.risk}）`, tool.description, `参数 schema：${JSON.stringify(tool.parameters)}`].join('\n')
}
