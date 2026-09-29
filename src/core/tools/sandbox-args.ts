/**
 * 一次性升权参数：模型在动手类工具里显式请求「这一次放宽沙箱档位」。
 *
 * 形制照 codex 的 `sandbox_permissions` + `justification`：两个字段**必须成对出现**，
 * 且只对这一次调用生效（不留持久授权——dsc 的既定安全选择）。
 * 判定不在工具自己肚子里，而在沙箱插件挂在守卫链 order 8 的那位守卫上：
 * 工具层只负责把这两个参数写进 schema，让模型有地方说清楚「我要写到哪、为什么」。
 *
 * @module dsc/core/tools/sandbox-args
 */

/** 一次调用请求放宽到哪一档。 */
export const SANDBOX_PERMISSION_VALUES = ['workspace-write', 'danger-full-access'] as const

export type SandboxPermission = (typeof SANDBOX_PERMISSION_VALUES)[number]

/**
 * 展开进工具的 `parameters.properties`。
 *
 * 描述刻意写成「只在被沙箱拒了之后才填」：沙箱插件关着时这两个参数没有任何作用，
 * 但模型不该因为看见它们就主动要求放宽——没有任何档位能越过审批卡。
 */
export const sandboxPermissionProperties: Record<string, unknown> = {
  sandbox_permissions: {
    type: 'string',
    enum: [...SANDBOX_PERMISSION_VALUES],
    description:
      '仅当沙箱（sandbox 插件）以「超出可写范围」为由拒绝过这次操作、且这个操作确实必要时才填：' +
      '请求把这一次调用放宽到该档位。必须与 justification 同时给出，且只对这一次生效；' +
      '放宽请求会照常弹审批卡，用户不点同意就不会执行。',
  },
  justification: {
    type: 'string',
    description: '与 sandbox_permissions 成对出现：一句话说明为什么必须写到可写范围之外（用户据此决定批不批）。',
  },
}

/**
 * 读一次工具调用里的升权请求。
 *
 * 三种结果：`none` 没请求；`ok` 请求完整；`malformed` 只给了半截（守卫按拒处理——
 * 单独一个 `sandbox_permissions` 是典型的「想偷偷放宽」，不给理由就不该放过去）。
 */
export function readSandboxRequest(args: Record<string, unknown>):
  | { kind: 'none' }
  | { kind: 'ok'; permission: SandboxPermission; justification: string }
  | { kind: 'malformed'; reason: string } {
  const rawPermission = args.sandbox_permissions
  const rawJustification = args.justification
  const hasPermission = rawPermission !== undefined && rawPermission !== null && rawPermission !== ''
  const justification = typeof rawJustification === 'string' ? rawJustification.trim() : ''
  if (!hasPermission && justification === '') return { kind: 'none' }
  if (!hasPermission) return { kind: 'malformed', reason: '只给了 justification 没给 sandbox_permissions' }
  if (!SANDBOX_PERMISSION_VALUES.includes(String(rawPermission) as SandboxPermission)) {
    return { kind: 'malformed', reason: `sandbox_permissions 只能是 ${SANDBOX_PERMISSION_VALUES.join(' / ')}` }
  }
  if (justification === '') {
    return { kind: 'malformed', reason: '请求放宽沙箱必须同时给出 justification（为什么必须写到范围之外）' }
  }
  return { kind: 'ok', permission: String(rawPermission) as SandboxPermission, justification }
}
