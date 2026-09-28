/**
 * approval 插件：provide `approval` 服务——权限模式状态机（沙箱强制层）+ 审批卡。
 *
 * 权限模式（对应 dsh 的 approval policy + 自动授权审查插件）：
 *   readonly     仅查看：write/exec 类工具一律拒绝（软沙箱，不弹审批）；
 *   auto-edit    工作区自动编辑：写类工具目标在工作目录内 → 自动放行，
 *                其余（工作区外写入、exec 类）走人工审批卡；
 *   full-access  完全访问：全部自动放行；
 *   ai-review    AI 自动审查：由当前模型逐次判断放行与否，失败回退人工审批。
 *
 * 人工审批 = 挂起 Promise ↔ UI 审批卡（one-shot，中断即拒绝）。
 *
 * @module dsc/plugins/approval
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import { streamChat } from '../core/llm.js'
import type { ApprovalDecision, ApprovalRequest } from '../core/approval.js'
import type { ApprovalPolicy, ApprovalRequestView, ApprovalService } from '../services/types.js'

/** auto-edit 模式下可依「目标路径在工作区内」自动放行的写类工具。 */
const PATH_WRITE_TOOLS = new Set(['write', 'edit'])

/** 从工具参数里提取目标路径（write/edit 系的常见参数名）。 */
function targetPathOf(args: Record<string, unknown> | undefined): string | null {
  if (args === undefined) return null
  for (const key of ['file_path', 'path', 'target', 'file']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** 目标路径是否落在工作目录内（Windows 大小写归一）。 */
function isInsideCwd(path: string, cwd: string): boolean {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
  const rel = relative(resolve(cwd), resolved).toLowerCase()
  return rel !== '' && !rel.startsWith('..') && !rel.split(/[\\/]/)[0]!.includes(':')
}

export const approvalPlugin: Plugin.Object = {
  name: 'approval',
  inject: ['llm'],
  provide: 'approval',
  apply(ctx) {
    let policy: ApprovalPolicy = 'auto-edit'
    let pending: { view: ApprovalRequestView; resolve: (decision: ApprovalDecision) => void } | null =
      null

    /** 挂起人工审批卡（等待 UI 应答或 abort）。 */
    const askHuman = (request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> =>
      new Promise<ApprovalDecision>((resolveDone) => {
        const id = randomUUID()
        pending = { view: { id, toolName: request.toolName, argsSummary: request.argsSummary }, resolve: resolveDone }
        ctx.emit('dsc/changed')
        signal.addEventListener(
          'abort',
          () => {
            if (pending?.view.id !== id) return
            pending = null
            ctx.emit('dsc/changed')
            resolveDone('reject')
          },
          { once: true },
        )
      })

    /** AI 自动审查：用当前模型判断这次工具调用是否放行；失败返回 null（回退人工）。 */
    const aiReview = async (request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision | null> => {
      try {
        const route = ctx.llm.route()
        const result = await streamChat(
          {
            baseUrl: route.baseUrl,
            apiKey: route.apiKey,
            model: route.model,
            maxTokens: 200,
            thinking: 'disabled',
            signal,
            messages: [
              {
                role: 'system',
                content:
                  '你是工具执行的自动审查器。根据工具名称、参数与工作目录判断该操作是否合理安全。' +
                  '只回答一个词：ALLOW（放行）或 DENY（拒绝）。不要输出其他内容。',
              },
              {
                role: 'user',
                content:
                  `工具：${request.toolName}\n参数：${JSON.stringify(request.args ?? request.argsSummary)}\n` +
                  `工作目录：${request.cwd ?? process.cwd()}`,
              },
            ],
          },
          { onDelta: () => {} },
        )
        const verdict = result.text.trim().toUpperCase()
        if (verdict.includes('ALLOW')) return 'allow-once'
        if (verdict.includes('DENY')) return 'reject'
        return null
      } catch {
        return null
      }
    }

    const service: ApprovalService = {
      get policy() {
        return policy
      },

      setPolicy(next) {
        policy = next
        const label =
          next === 'readonly'
            ? '仅查看（写/执行类工具将被拒绝）'
            : next === 'auto-edit'
              ? '工作区自动编辑（工作区内写操作自动放行，其余审批）'
              : next === 'full-access'
                ? '完全访问（全部工具自动放行）'
                : 'AI 自动审查（由模型逐次判断，失败回退人工审批）'
        // dsc/notice → transcript 写 system 条目（避免与 transcript 的循环依赖）
        ctx.emit('dsc/notice', `权限模式切换为「${label}」`)
      },

      async decide(request: ApprovalRequest, signal): Promise<ApprovalDecision> {
        switch (policy) {
          case 'readonly':
            return 'reject'
          case 'full-access':
            return 'allow-once'
          case 'auto-edit': {
            const path = targetPathOf(request.args)
            if (
              PATH_WRITE_TOOLS.has(request.toolName) &&
              path !== null &&
              request.cwd !== undefined &&
              isInsideCwd(path, request.cwd)
            ) {
              return 'allow-once'
            }
            return askHuman(request, signal)
          }
          case 'ai-review': {
            const verdict = await aiReview(request, signal)
            if (verdict !== null) return verdict
            return askHuman(request, signal)
          }
          default:
            return askHuman(request, signal)
        }
      },

      pendingView() {
        return pending?.view ?? null
      },

      answer(answer) {
        const current = pending
        if (current === null) return
        pending = null
        ctx.emit('dsc/changed')
        current.resolve(answer === 'allow-once' ? 'allow-once' : 'reject')
      },
    }

    ctx.on('dsc/exit', () => {
      if (pending !== null) {
        pending.resolve('reject')
        pending = null
      }
    })
    ctx.provide('approval', service)
  },
}
