/**
 * 工具契约：与 dsh 工具行同构（name/description/JSONSchema/run），外加
 * 个人版的风险分级 `risk`——read 自动放行，write/exec 必须过审批卡。
 *
 * @module dsc/core/tools
 */
import { isAbsolute, resolve } from 'node:path'

export type ToolRisk = 'read' | 'write' | 'exec'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /**
   * 发起这次调用的队友身份。子智能体插件替队友转发团队类工具（team_task）时塞进来，
   * 工具按它署名（任务板认领人、信箱回信）；主会话的调用没有这一项，按「lead」对待。
   */
  caller?: { name: string; depth: number; background: boolean }
}

/** 工具输出：纯文本，或文本 + 附带图像（data URL；需端点支持视觉）。 */
export interface ToolOutput {
  text: string
  images?: string[]
}

export interface ToolEntry {
  name: string
  description: string
  /** JSON Schema（OpenAI 协议的 function 参数）。 */
  parameters: Record<string, unknown>
  risk: ToolRisk
  /**
   * 这个工具属于哪些模式（模式名清单）。不写 = 所有模式都能看见它。
   *
   * 用途：模式专属的工具不该在标准模式里冒出来——`run_code` 只属于 PTC 模式，
   * `runtime_api` 只属于创造模式。它不是权限声明：模式白名单里显式写了这个工具名
   * 也能看见它；真正的安全边界在守卫链与审批卡，跟这个字段无关。
   */
  presets?: readonly string[]
  /** 执行并返回给模型的结果；失败时抛错（loop 转成 error 结果）。 */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string | ToolOutput>
}

/**
 * 从工具参数里认出「这次调用要动哪个目标 / 跑哪条命令」。
 *
 * 各工具用的参数名不一样（file_path / path / target / file，command / cmd），
 * 这段兜底原先在循环与审批里各写了一份，现在收在工具层——参数名是工具契约的一部分，
 * 只有这一层该认识它们。路径在这里就绝对化，后面的护栏不必各自再拼一次。
 *
 * @param args - 模型给的参数（已 JSON.parse）。
 * @param cwd - 会话工作目录（相对路径按它展开）。
 */
export function callFacts(
  args: Record<string, unknown>,
  cwd: string,
): { target?: string; command?: string } {
  const out: { target?: string; command?: string } = {}
  for (const key of ['file_path', 'path', 'target', 'file']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') {
      out.target = isAbsolute(value) ? resolve(value) : resolve(cwd, value)
      break
    }
  }
  const command = args.command ?? args.cmd
  if (typeof command === 'string' && command.trim() !== '') out.command = command
  return out
}

/** 卡片上那行参数摘要的最长字符数（再长就是把整篇正文塞进按钮旁边）。 */
const ARGS_SUMMARY_MAX = 160

/**
 * 把一次工具调用的参数压成一行文字，给审批卡、审计日志这类给人看的地方用。
 *
 * 参数是 JSON.parse 出来的，不会带循环引用，所以这里不需要兜底。
 *
 * @param args - 模型给的参数（已 JSON.parse）。
 * @returns 扁平 JSON 文本，超过 160 字符截断并补省略号
 */
export function argsSummary(args: Record<string, unknown>): string {
  const text = JSON.stringify(args)
  return text.length > ARGS_SUMMARY_MAX ? `${text.slice(0, ARGS_SUMMARY_MAX)}…` : text
}
