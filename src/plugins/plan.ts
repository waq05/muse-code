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
 * 0.6.49 常驻模型：卡跟自己的会话走——多卡并存（每个会话最多一张，互不顶掉），
 * surface 只出「当前查看会话」的卡；切会话不再把挂起的评审按拒收尾（后台会话的卡
 * 继续等它的用户，对齐 dsh 卡只画在发起会话视图里的语义）。
 *
 * @module dsc/plugins/plan
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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

/** 一张活挂起的评审卡。 */
interface PendingPlanCard {
  id: string
  view: PlanView
  /** 提交计划的会话（后台提卡也归属它）：落库、事件归属、surface 认领全靠它。 */
  sessionPath: string
  /** 拒绝时用户附的反馈原文（answerPlan 带进来，经 exit_plan_mode 的结果文案捎给模型）。 */
  rejectionFeedback?: string
  finish(decision: PlanDecision, quiet?: boolean): void
}

export const planPlugin: Plugin.Object = {
  name: 'plan',
  inject: ['session', 'tools', 'mode', 'surfaces', 'waiting'],
  provide: 'plan',
  apply(ctx) {
    /** 当前查看会话的「僵尸」计划卡：状态条目里 decision=pending 的计划（进程重启前留下的）。 */
    const pendingStateOf = (session: { state(name: string): unknown }): PlanView | null => {
      const state = session.state('plan') as PlanView | undefined
      return state?.decision === 'pending' ? state : null
    }
    let restored: PlanView | null = pendingStateOf(ctx.session.current())
    /** 活挂起的评审卡：卡 id → 卡。多卡并存（0.6.49）。 */
    const pendings = new Map<string, PendingPlanCard>()

    const touch = (): void => ctx.emit('dsc/changed')

    /** 当前查看会话的那张活卡（没有就 null）——surface 与应答都只认它。 */
    const cardOfCurrent = (): PendingPlanCard | undefined => {
      const path = ctx.session.current().filePath
      for (const card of pendings.values()) {
        if (card.sessionPath === path) return card
      }
      return undefined
    }

    /** 交一份计划等用户批：挂起直到批准 / 拒绝 / 这一轮被打断。 */
    const propose = (next: PlanView, signal: AbortSignal, sessionPath?: string): Promise<PlanOutcome> =>
      new Promise<PlanOutcome>((resolveDone) => {
        // 提交会话按工具运行身份显式解析（0.6.49 常驻模型：后台回合提卡时
        // ctx.session.current() 是用户正看着的别家会话，落库绝不能跟着它走）。
        const proposed =
          (sessionPath !== undefined ? ctx.get('agent')?.sessionFor(sessionPath) : undefined) ?? ctx.session.current()
        const path = proposed.filePath
        const id = randomUUID()
        const finish = (decision: PlanDecision, quiet = false): void => {
          const card = pendings.get(id)
          if (card === undefined) return
          pendings.delete(id)
          const settled: PlanView = { ...next, decision }
          proposed.appendState('plan', settled)
          ctx.emit('dsc/plan', settled, path)
          // quiet = 退出这类「没人做决定」的清理：卡收掉、状态记成拒绝，不再喊界面。
          if (!quiet) {
            ctx.emit('dsc/notice', decision === 'approved' ? '计划已批准，切回执行模式开工。' : '计划未获批准，留在计划模式。', undefined, path)
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
          // 提卡会话还在跑（决定完工具就返回、回合继续）：状态点从「等审批」翻回 working；
          // quiet 路径交给回合收尾的 turn-end 收口。
          if (!quiet) {
            ctx.emit('dsc/agent-status', { sessionId: proposed.meta.id, path, state: 'working' })
          }
          touch()
          const feedback = card.rejectionFeedback
          resolveDone({
            decision,
            ...(decision === 'rejected' && feedback !== undefined ? { feedback } : {}),
          })
        }
        pendings.set(id, { id, view: next, sessionPath: path, finish })
        ctx.emit('dsc/plan', next, path)
        ctx.emit('dsc/agent-status', { sessionId: proposed.meta.id, path, state: 'awaiting-approval' })
        signal.addEventListener('abort', () => finish('rejected'), { once: true })
        touch()
      })

    const service: PlanService = {
      pendingPlan() {
        // 只出当前查看会话的卡：活卡优先，没有再看这个会话状态里留的僵尸卡。
        return cardOfCurrent()?.view ?? restored
      },
      proposePlan: (input, signal) => propose({ ...input, decision: 'pending' }, signal).then((outcome) => outcome.decision),
      answerPlan(decision, feedback) {
        const card = cardOfCurrent()
        if (card === undefined) return
        if (decision === 'rejected' && typeof feedback === 'string' && feedback.trim() !== '') {
          card.rejectionFeedback = feedback.trim()
        }
        card.finish(decision)
      },
    }
    ctx.provide('plan', service)
    ctx.surfaces.register('pendingPlan', () => service.pendingPlan())
    ctx.waiting.register('plan', () => pendings.size > 0 || restored !== null)

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
        const outcome = await propose({ file, title, text, decision: 'pending' }, runCtx.signal, runCtx.sessionPath)
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
      // 0.6.49 常驻模型：切会话不再收尾挂起的评审（后台会话的卡继续等它的用户，
      // T29 当年的悬 Promise 死锁在常驻模型下不存在了——提卡的 agent 活着）。
      // 这里只换「当前查看会话」的僵尸计划卡：恢复会话时把计划条目放回会话流，
      // 这张卡用户批过也要看得见批了什么。
      restored = pendingStateOf(session)
      if (filePath !== undefined && restored !== null) ctx.emit('dsc/plan', restored)
      touch()
    })

    ctx.on('dsc/exit', () => {
      for (const card of [...pendings.values()]) card.finish('rejected', true)
      pendings.clear()
    })
  },
}
