/**
 * 工具契约：与 dsh 工具行同构（name/description/JSONSchema/run），外加
 * 个人版的风险分级 `risk`——read 自动放行，write/exec 必须过审批卡。
 *
 * @module dsc/core/tools
 */

export type ToolRisk = 'read' | 'write' | 'exec'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
}

/** 工具输出：纯文本，或文本 + 附带图像（data URL；需端点支持视觉）。 */
export interface ToolOutput {
  text: string
  images?: string[]
}

export interface ToolEntry {
  name: string
  description: string
  /** JSON Schema（OpenAI function 参数）。 */
  parameters: Record<string, unknown>
  risk: ToolRisk
  /** 执行并返回给模型的结果；失败时抛错（loop 转成 error 结果）。 */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string | ToolOutput>
}
