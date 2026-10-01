/**
 * 智能体团队（官方插件，默认关闭）。
 *
 * 叠在「子智能体」之上的协作层（对照 dsh 的团队档：成员列表 + 共享任务看板）：
 * 打开后模型多出 `team_task` 工具——共享任务板，登记要做的事、看谁在做什么、
 * 认领和结项。看板按会话各一块（`~/.dsc/team/boards/<会话 id>.json`）：
 * 切到别的会话就是另一块板（对照 dsh 团队挂在 lead 会话之下）。
 *
 * 只开本插件不开子智能体也能用：一块只有 lead 在写的看板，就是一份共享 todo。
 * 两个都开时，队友（子智能体插件派出的）转发 team_task 会带上自己的名字，
 * 认领人因此记得住是谁，lead 一眼能看出哪条活在谁手里。
 *
 * @module dsc/plugins/team
 */
import type { Plugin } from '@deepseek-ai/cordis'
import {
  BOARDS_DIR,
  boardCreate,
  boardUpdate,
  isReady,
  readBoard,
  resetBoard,
  type BoardAction,
} from '../core/team-board.js'
import type { ToolContext, ToolEntry } from '../core/tools.js'
import type { SettingsField, SettingsValue } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'

/** 主会话这一方在任务板上的名字。 */
const LEAD = 'lead'

/** 这次调用的署名：队友转发来的带 caller，主会话自己调就是 lead。 */
function callerOf(runCtx: ToolContext): string {
  return runCtx.caller?.name ?? LEAD
}

export const teamPlugin: Plugin.Object = {
  name: 'team',
  inject: ['session', 'tools', 'prompt', 'settings'],
  apply(ctx, _passed) {
    async function runTeamTask(args: Record<string, unknown>, runCtx: ToolContext): Promise<string> {
      const sessionId = ctx.session.current().meta.id
      const caller = callerOf(runCtx)
      const action = String(args.action ?? '')
      const board = readBoard(sessionId)
      const id = String(args.id ?? '')
      const revision = Number(args.expected_revision ?? board.revision)
      const ownerDefault = caller
      try {
        switch (action) {
          case 'create': {
            const scopes = Array.isArray(args.write_scopes) ? args.write_scopes.map(String) : []
            const blocked = Array.isArray(args.blocked_by) ? args.blocked_by.map(String) : []
            const created = boardCreate(sessionId, {
              subject: String(args.subject ?? ''),
              description: String(args.description ?? ''),
              blockedBy: blocked,
              writeScopes: scopes,
            })
            const warnings = created.warnings.length === 0 ? '' : `\n提醒（不拦你，最后看 diff 裁决）：\n${created.warnings.map((line) => `- ${line}`).join('\n')}`
            if (args.claim_now !== true) return `已建 ${created.task.id}：${created.task.subject}${warnings}`
            // 认领走正常的 claim：依赖没做完一样会被拦下，正好复用同一套校验
            try {
              boardUpdate(sessionId, created.task.id, created.board.revision, 'claim', { owner: ownerDefault })
            } catch (error) {
              return `已建 ${created.task.id}：${created.task.subject}，但没能认领：${error instanceof Error ? error.message : String(error)}${warnings}`
            }
            return `已建 ${created.task.id}：${created.task.subject}，状态直接进 in_progress（认领人 ${ownerDefault}）${warnings}`
          }
          case 'list': {
            if (board.tasks.length === 0) return '本会话的任务板是空的（team_task action=create 建第一条）'
            const lines = board.tasks.map((task) => {
              const ready = isReady(board, task)
              return `- ${task.id} [${task.status}${ready ? ' · 可开工' : ''}] ${task.subject}${task.owner === null ? '' : ` @${task.owner}`}${task.blockedBy.length === 0 ? '' : ` 依赖 ${task.blockedBy.join('、')}`}${task.writeScopes.length === 0 ? '' : ` 作用域 ${task.writeScopes.join(', ')}`}`
            })
            return `本会话任务板第 ${board.revision} 版：\n${lines.join('\n')}\n（改状态要带 expected_revision=${board.revision}）`
          }
          case 'get': {
            const task = board.tasks.find((entry) => entry.id === id)
            if (task === undefined) return `任务板上没有 ${id}`
            return `第 ${board.revision} 版里的 ${task.id}：\n标题：${task.subject}\n说明：${task.description || '（空）'}\n状态：${task.status}，认领人 ${task.owner ?? '（无）'}\n依赖：${task.blockedBy.join('、') || '（无）'}\n作用域：${task.writeScopes.join(', ') || '（未声明）'}`
          }
          case 'claim':
          case 'release':
          case 'complete':
          case 'reopen':
          case 'delete':
          case 'set_dependencies': {
            const payload: { owner?: string; blockedBy?: string[] } = {}
            if (action === 'claim') payload.owner = String(args.owner ?? ownerDefault)
            if (action === 'set_dependencies') {
              payload.blockedBy = Array.isArray(args.blocked_by) ? args.blocked_by.map(String) : []
            }
            const result = boardUpdate(sessionId, id, revision, action as BoardAction, payload)
            const ready = result.board.tasks.filter((task) => isReady(result.board, task)).map((task) => task.id)
            return `${id} → ${result.task.status}${result.task.owner === null ? '' : `（${result.task.owner}）`}，任务板第 ${result.board.revision} 版。现在可开工：${ready.join('、') || '（无）'}`
          }
          default:
            return `不认识的 action「${action}」。要用的值：create / list / get / claim / release / complete / reopen / set_dependencies / delete`
        }
      } catch (error) {
        return `任务板操作没做成：${error instanceof Error ? error.message : String(error)}`
      }
    }

    const teamTaskTool = (): ToolEntry => ({
      name: 'team_task',
      description:
        '共享任务板（本会话）：登记要做的事、看谁在做什么、认领和结项。' +
        '改状态要带 expected_revision（list 返回的那一版），别人抢先改过就会失败，重来一次即可。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'list', 'get', 'claim', 'release', 'complete', 'reopen', 'set_dependencies', 'delete'],
            description: '要做什么',
          },
          subject: { type: 'string', description: 'create 必填：任务标题' },
          description: { type: 'string', description: 'create：任务的详细说明（背景、验收口径）' },
          id: { type: 'string', description: '除 create/list 外必填：任务 id，例如 t3' },
          expected_revision: { type: 'number', description: '你看到的任务板版本号，来自上一次 list/create' },
          owner: { type: 'string', description: 'claim 时的认领人；不填就是你自己' },
          claim_now: { type: 'boolean', description: 'create：true = 建完直接算你认领（状态直接进 in_progress）' },
          write_scopes: { type: 'array', items: { type: 'string' }, description: 'create：这个任务打算改的路径前缀，用于提醒别人别撞车' },
          blocked_by: { type: 'array', items: { type: 'string' }, description: 'create/set_dependencies：依赖哪些任务 id' },
        },
        required: ['action'],
      },
      risk: 'read',
      run: (args, runCtx) => runTeamTask(args, runCtx),
    })

    const offTool = ctx.tools.register(teamTaskTool())
    const offPrompt = ctx.prompt.register('team', () => {
      const board = readBoard(ctx.session.current().meta.id)
      const lines = board.tasks.slice(0, 20).map((task) => {
        const ready = isReady(board, task)
        return `- ${task.id} [${task.status}${ready ? ' · 可开工' : ''}] ${task.subject}${task.owner === null ? '' : ` @${task.owner}`}`
      })
      return `# 智能体团队（共享任务板）
本会话有一块共享任务板，你可以用 team_task 工具登记要做的事、认领和结项；队友和你看到的是同一块板。
${lines.length === 0 ? '板上还没有任务。' : `板上的任务：\n${lines.join('\n')}`}

任务板的规矩：
1. 多人协作先上任务板：create 时写清 write_scopes（打算改哪些路径），别人 claim 时才抢不过你；改状态要带 expected_revision。
2. 认领前先 list：依赖没完成的任务开不了工；完成一条，等它的人就能开工。`
    })

    // ── 设置分区 ────────────────────────────────────────────────────────────
    const fields = (): SettingsField[] => [
      { type: 'info', label: '任务板目录', text: BOARDS_DIR, mono: true, copyable: true, help: '每个会话各一块板（<会话 id>.json），切会话就是另一块板。' },
      { type: 'button', action: 'clear-board', label: '清空本会话任务板', style: 'ghost', help: '仅清空当前会话的任务条目，不影响其他会话与队友运行记录。' },
    ]

    const section: SettingsSectionSpec = {
      id: 'team',
      title: '智能体团队',
      subtitle: '启用团队协作、共享任务看板；成员列表跟随「子智能体」插件',
      fields,
      values: (): Record<string, SettingsValue> => ({}),
      action: (name): string => {
        if (name === 'clear-board') {
          return `本会话的任务板清空了（去掉 ${resetBoard(ctx.session.current().meta.id)} 条）`
        }
        throw new Error(`这个分区没有这个按钮：${name}`)
      },
    }
    const offSection = ctx.settings.registerSection(section)

    // ── 卸载 ────────────────────────────────────────────────────────────────
    return () => {
      offSection()
      offPrompt()
      offTool()
    }
  },
}
