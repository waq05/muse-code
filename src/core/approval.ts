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
  /** 发起调用的会话 id（meta.id）。0.6.48 常驻多 agent：授权记账与审计按它归属。 */
  sessionId?: string
  /** 发起调用的会话 jsonl 路径（侧栏跨会话状态点按它定位）。 */
  sessionPath?: string
}

/**
 * 审批裁决（内核层）。
 *   allow-once     只放过这一次；
 *   allow-session  同一会话内同类动作不再问；
 *   allow-always   写一条永久前缀规则（危险动作由界面与策略层一起摘掉这一档）；
 *   reject         拒。
 */
export type ApprovalDecision = 'allow-once' | 'allow-session' | 'allow-always' | 'reject'

/** 一次审批裁决的附加要求。 */
export interface ApprovalOptions {
  /**
   * 要求这一次必须问人：卡片上的原因写这句，并且跳过所有自动放行的档位
   * （会话内已授权、规则允许、权限模式自动档、AI 审查自动放行）。
   *
   * 安全钩子用它把「这次得有人看一眼」落实到审批环节。硬地板（灾难命令、关键系统路径）
   * 与说明书类文件那两层照旧优先——它们本来就是连卡都不弹直接拒。
   */
  forceAskReason?: string
}

export interface ApprovalHandler {
  decide(request: ApprovalRequest, signal: AbortSignal, options?: ApprovalOptions): Promise<ApprovalDecision>
}
