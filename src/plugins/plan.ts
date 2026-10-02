/**
 * plan 插件：provide `plan` 服务——`exit_plan_mode` 工具与它的评审卡。
 *
 * 功能点自己那四块：
 *   1. 工具 `exit_plan_mode`（把计划写进 `.dsc/plans/` 并弹卡等用户批）；
 *   2. 界面快照里的 `pendingPlan` 投影 + 「正在等人」登记（有卡挂着时别自动往下推）；
 *   3. 会话状态条目 `plan`（恢复会话时那张卡还在）；
 *   4. 批准后切回执行档——这是模式服务的事，所以这里声明 `inject: ['mode']` 调它，
 *      而不是反过来让模式偷偷查计划（依赖方向只有一条，依赖图上没有环）。
 *
 * @module dsc/plugins/plan
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import { planFilePath } from '../core/modes.js'
import { audit } from '../core/audit.js'
import type { ToolEntry } from '../core/tools.js'
import type { PlanDecision, PlanView } from '../contract.js'
import type { PlanService } from '../services/types.js'

/** propose 的结果：决定本身 + 拒绝时用户附的反馈原话（仅 rejected 且用户填了才有）。 */
interface PlanOutcome {
  decision: PlanDecision
  feedback?: string
}

export const planPlugin: Plugin.Object = {
  name: 'plan',
  inject: ['session', 'tools', 'mode', 'surfaces', 'waiting'],
  provide: 'plan',
  apply(ctx) {
    const initial = ctx.session.current().state('plan')
    let plan: PlanView | null = initial?.decision === 'pending' ? initial : null
    let planDone: ((decision: PlanDecision, quiet?: boolean) => void) | null = null
    /** 拒绝时用户附的反馈原文（answerPlan 带进来，经 exit_plan_mode 的结果文案捎给模型）。 */
    let rejectionFeedback: string | undefined

    const touch = (): void => ctx.emit('dsc/changed')

    /** 交一份计划等用户批：挂起直到批准 / 拒绝 / 这一轮被打断。 */
    const propose = (next: PlanView, signal: AbortSignal): Promise<PlanOutcome> =>
      new Promise<PlanOutcome>((resolveDone) => {
        // 评审可能比提交它的回合活得久（挂起时切走会话，T29）：落库与审计必须用
        // 「提交时」的那个会话——session-open 先于 agent 的 abort 到（插件顺序），
        // 那时 ctx.session.current() 已经是新会话了。
        const proposed = ctx.session.current()
        plan = next
        ctx.emit('dsc/plan', next)
        const finish = (decision: PlanDecision, quiet = false): void => {
          if (planDone === null) return
          planDone = null
          plan = plan === null ? null : { ...plan, decision }
          if (plan !== null) {
            proposed.appendState('plan', plan)
            ctx.emit('dsc/plan', plan)
          }
          // quiet = 切会话 / 退出这类「没人做决定」的清理：卡收掉、状态记成拒绝，
          // 但不再往（可能已经切走的）界面上喊一嗓子。
          if (!quiet) {
            ctx.emit('dsc/notice', decision === 'approved' ? '计划已批准，切回执行模式开工。' : '计划未获批准，留在计划模式。')
          }
          // 批准之后该由哪一档继续干活，是模式服务自己的事：这里只是把结果告诉它。
          if (decision === 'approved') ctx.mode.setMode('build')
          audit({
            ts: Date.now(),
            kind: 'mode-change',
            reason: `计划评审：${decision === 'approved' ? '批准' : '拒绝'}`,
            sessionId: proposed.meta.id,
            cwd: proposed.meta.cwd,
          })
          touch()
          const feedback = rejectionFeedback
          rejectionFeedback = undefined
          resolveDone({
            decision,
            ...(decision === 'rejected' && feedback !== undefined ? { feedback } : {}),
          })
        }
        planDone = finish
        signal.addEventListener('abort', () => finish('rejected'), { once: true })
        touch()
      })

    const service: PlanService = {
      pendingPlan() {
        return plan
      },
      proposePlan: (input, signal) => propose({ ...input, decision: 'pending' }, signal).then((outcome) => outcome.decision),
      answerPlan(decision, feedback) {
        if (planDone === null) return
        if (decision === 'rejected' && typeof feedback === 'string' && feedback.trim() !== '') {
          rejectionFeedback = feedback.trim()
        }
        planDone(decision)
      },
    }
    ctx.provide('plan', service)
    ctx.surfaces.register('pendingPlan', () => service.pendingPlan())
    ctx.waiting.register('plan', () => plan !== null)

    const exitPlanTool: ToolEntry = {
      name: 'exit_plan_mode',
      description:
        '把你写好的计划交给用户批。参数 plan 是计划全文（markdown，第一行是 # 标题）。' +
        '本工具会把计划写进 .dsc/plans/ 下的文件，并弹出一张评审卡：用户批准就自动切回执行模式开始干活，' +
        '拒绝就留在计划模式继续改方案。一次回答最多交一份计划；改方案要交完整的新版本，不要交补丁。',
      parameters: {
        type: 'object',
        properties: {
          plan: { type: 'string', description: '计划全文（markdown）' },
          title: { type: 'string', description: '计划标题（可省略，默认取正文第一个 # 标题）' },
        },
        required: ['plan'],
      },
      risk: 'read',
      async run(args, runCtx) {
        const text = typeof args.plan === 'string' ? args.plan.trim() : ''
        if (text === '') throw new Error('plan 不能是空的')
        const heading = /^#\s+(.+)$/m.exec(text)
        const title =
          typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : (heading?.[1] ?? '本次改动计划')
        const file = planFilePath(runCtx.cwd, title)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, `${text}\n`, 'utf8')
        const outcome = await propose({ file, title, text, decision: 'pending' }, runCtx.signal)
        if (outcome.decision === 'approved') {
          return (
            `用户已批准这份计划（${file}）。现在按计划开工：` +
            '先用 todo_write 把计划里的分步任务立成清单，再一步步做完并实时更新状态。' +
            '计划模式已退出，写操作按权限模式与审批卡走。'
          )
        }
        // T40：拒绝反馈现在有通道了——用户在评审卡里填的原话原样捎给模型，不再让它盲猜。
        const feedback = outcome.feedback === undefined ? '' : `用户的反馈原话：${outcome.feedback}\n`
        return `用户没有批准这份计划（${file}）。${feedback}留在计划模式：把用户的反馈吸收进方案，改完再交一份完整的新计划。`
      },
    }
    ctx.tools.register(exitPlanTool)

    ctx.on('dsc/session-open', ({ session, filePath }) => {
      // T29：挂起的评审先收尾再清场。只置空不 resolve 的话，exit_plan_mode 的 await
      // 永远不返回，agent 循环的 running 永远为真——此后所有消息都变成轮中途插话，
      // 宿主只能重启。落库走 propose 时捕获的那个会话，不会写进切换后的新会话。
      planDone?.('rejected', true)
      const restored = session.state('plan')
      plan = restored?.decision === 'pending' ? restored : null
      // 恢复会话时把计划条目放回会话流（这张卡用户批过也要看得见批了什么）。
      if (filePath !== undefined && restored !== undefined) ctx.emit('dsc/plan', restored)
      touch()
    })

    ctx.on('dsc/exit', () => {
      planDone?.('rejected', true)
    })
  },
}
