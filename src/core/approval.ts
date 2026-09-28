/**
 * 审批通道：loop 在执行 write/exec 类工具前挂起等待决定。
 * 对齐现有 UI 的 one-shot y/n 语义（对应 dsh user-approval 的 'ask' 策略
 * 的个人版最小实现）。
 *
 * @module dsc/core/approval
 */

export interface ApprovalRequest {
  toolName: string
  /** 单行参数摘要（审批卡展示用）。 */
  argsSummary: string
  /** 解析后的工具参数（权限模式判定用：如 write 类工具的目标路径）。 */
  args?: Record<string, unknown>
  /** 当前工作目录（auto-edit 模式判定「工作区内」用）。 */
  cwd?: string
}

export type ApprovalDecision = 'allow-once' | 'reject'

export interface ApprovalHandler {
  decide(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>
}

/** M1 / 自动化场景用：全部放行。 */
export const allowAllApproval: ApprovalHandler = {
  async decide() {
    return 'allow-once'
  },
}
