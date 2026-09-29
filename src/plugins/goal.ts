/**
 * goal 插件：provide `goal` 服务——会话目标与它的跨轮自动续跑。
 *
 * 功能点自己那几块：
 *   1. 工具 `goal`（建目标 / 报完成 / 报阻塞；暂停恢复只能用户做）与命令 `/goal`；
 *   2. 界面快照里的 `goal` 投影；
 *   3. 会话状态条目 `goal`：恢复历史会话或切会话后一律**卸膛**，要续跑得用户亲自点继续；
 *   4. 自动续跑的驱动：听 `dsc/turn-end`（一轮干净结束）向自己要一轮，再交给 agent 排队补发；
 *   5. 压缩时要原样带过去的目标一句话（`ctx.compact.registerCarry`）。
 *
 * 「有没有卡片挂着等用户」问 `ctx.waiting`——有卡就不许自动往下推，
 * 这条规则原先靠挨个查审批 / 计划 / 提问三个功能点，现在只问登记表。
 *
 * 缺省轮次上限与 `/goal rounds` 每次放宽的幅度是插件配置（`goal.defaultMaxRounds` / `goal.extendRoundsBy`），
 * 也注册成设置分区「会话目标」的两项；保存后本插件立刻重读，下一条目标就用新值。
 *
 * @module dsc/plugins/goal
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { DEFAULT_MAX_GOAL_ROUNDS, GoalStore } from '../core/goal.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import type { SettingsField, SettingsValues } from '../contract.js'
import type { ToolEntry } from '../core/tools.js'
import type { GoalService, SettingsSectionSpec } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'goal'

/** 目标插件的可调项。 */
interface GoalConfig {
  /** 建目标时没写 maxRounds 用的轮次上限。 */
  defaultMaxRounds: number
  /** `/goal rounds` 一次放宽多少轮。 */
  extendRoundsBy: number
}

const DEFAULTS: GoalConfig = { defaultMaxRounds: DEFAULT_MAX_GOAL_ROUNDS, extendRoundsBy: 8 }

/**
 * 从插件配置里取可调项并夹到合理区间。
 * @param passed - 装配时直接传进来的配置（内核挂载时的第二参数）。
 */
function readConfig(passed?: unknown): GoalConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const num = Number(value)
    return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), min), max) : fallback
  }
  return {
    // 上限 256 与 core/goal.ts 的硬顶一致：配置只能在这个范围内放开，不能取消上限。
    defaultMaxRounds: clamp(raw.defaultMaxRounds, 1, 256, DEFAULTS.defaultMaxRounds),
    extendRoundsBy: clamp(raw.extendRoundsBy, 1, 64, DEFAULTS.extendRoundsBy),
  }
}

export const goalPlugin: Plugin.Object = {
  name: 'goal',
  inject: ['session', 'tools', 'commands', 'agent', 'transcript', 'surfaces', 'waiting', 'compact', 'settings'],
  provide: 'goal',
  apply(ctx, passed) {
    let config = readConfig(passed)
    /** 写盘并立刻重读：新建的目标就用新值。 */
    const applyConfig = (patch: Record<string, unknown | null>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      config = readConfig(passed)
    }
    // 缺省轮次交给一个取值函数：设置里改了数值，下一条目标立刻跟着变，不必重启宿主。
    const goals = new GoalStore({ defaultMaxRounds: () => config.defaultMaxRounds })
    const restored = ctx.session.current().state('goal')
    if (restored !== undefined) goals.restore(restored)

    const touch = (): void => ctx.emit('dsc/changed')
    /** 把当前目标快照写进会话日志（恢复会话时靠它）并让快照失效。 */
    const persist = (): void => {
      const snapshot = goals.snapshot
      if (snapshot !== null) ctx.session.current().appendState('goal', snapshot)
      touch()
    }

    const service: GoalService = {
      goalView() {
        const snapshot = goals.snapshot
        if (snapshot === null) return null
        return {
          objective: snapshot.objective,
          phase: snapshot.phase,
          rounds: snapshot.rounds,
          maxRounds: snapshot.maxRounds,
          ...(snapshot.blockedReason !== undefined ? { blockedReason: snapshot.blockedReason } : {}),
          armed: goals.armed,
        }
      },
      goals,
      goalAction(action) {
        config = readConfig(passed)
        const result =
          action === 'pause'
            ? goals.pauseByUser()
            : action === 'resume'
              ? goals.resumeByUser()
              : action === 'clear'
                ? goals.clearByUser()
                : goals.editByUser({ maxRounds: (goals.snapshot?.maxRounds ?? config.defaultMaxRounds) + config.extendRoundsBy })
        if (!result.ok) return { ok: false, error: result.error ?? '目标操作失败' }
        persist()
        ctx.emit(
          'dsc/notice',
          `目标：${action === 'pause' ? '已暂停' : action === 'resume' ? '已继续' : action === 'clear' ? '已清空' : '轮次上限已放宽'}`,
        )
        return { ok: true }
      },
      takeGoalRound() {
        if (!goals.shouldContinue) return null
        // 有任何一张卡在等用户做决定就不许自动往下推：人的决定排在机器前面。
        if (ctx.waiting.any) return null
        const snapshot = goals.countRound()
        persist()
        if (snapshot === null || snapshot.phase !== 'active') {
          ctx.emit('dsc/notice', `目标跑满 ${snapshot?.maxRounds ?? 0} 轮上限，自动停下等用户处理`)
          return null
        }
        return (
          `（目标自动续跑：第 ${snapshot.rounds}/${snapshot.maxRounds} 轮）目标还没做完：${snapshot.objective}\n` +
          '对照目标看还差什么，继续往下推进；全部做完并用证据验证过，才调用 goal(action=complete)；' +
          '真的卡住了就 goal(action=blocked, reason=…) 说清需要什么。别因为已经跑了几轮就收手。'
        )
      },
    }
    ctx.provide('goal', service)
    ctx.surfaces.register('goal', () => service.goalView())

    const goalTool: ToolEntry = {
      name: 'goal',
      description:
        '设置或收尾一个跨轮次的会话目标。目标一旦建立，这一轮做完后系统会自动接着往下跑，直到完成、被你标记阻塞、或跑满轮次上限。' +
        'action=create 建目标（一句话说清要交付什么，可选 maxRounds 放宽轮次上限）；' +
        'action=complete 只在目标真的全部做完并用证据验证过时用；action=blocked 必须写清卡在哪里。' +
        '暂停、恢复、改目标、放宽上限这些只能由用户操作（/goal pause 等），你不能自己给自己续命。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'create | complete | blocked' },
          objective: { type: 'string', description: 'create 时必填：目标一句话' },
          maxRounds: {
            type: 'number',
            description: `create 时可选：自动续跑的轮次上限（默认 ${DEFAULTS.defaultMaxRounds}）`,
          },
          reason: { type: 'string', description: 'blocked 时必填：卡在哪里、需要用户提供什么' },
        },
        required: ['action'],
      },
      risk: 'read',
      async run(args) {
        const action = String(args.action ?? '')
        if (action === 'create') {
          const result = goals.create(
            String(args.objective ?? ''),
            typeof args.maxRounds === 'number' ? args.maxRounds : undefined,
          )
          persist()
          if (!result.ok) throw new Error(result.error)
          return `目标已建立：${result.snapshot.objective}（上限 ${result.snapshot.maxRounds} 轮，到点自动 blocked）`
        }
        if (action === 'complete') {
          const result = goals.complete()
          persist()
          if (!result.ok) throw new Error(result.error)
          return '目标已标记完成，自动续跑已停止。'
        }
        if (action === 'blocked') {
          const result = goals.block(String(args.reason ?? ''))
          persist()
          if (!result.ok) throw new Error(result.error)
          return '目标已标记阻塞，自动续跑已停止，等用户处理。'
        }
        throw new Error('action 只能是 create / complete / blocked（暂停恢复由用户用 /goal 命令做）')
      },
    }
    ctx.tools.register(goalTool)

    // 摘要模型会把目标改写成另一句话，所以目标原文要原样带进压缩后的上下文。
    ctx.compact.registerCarry(() => {
      const view = service.goalView()
      if (view === null) return ''
      return `会话目标：${view.objective}（已跑 ${view.rounds}/${view.maxRounds} 轮，阶段 ${view.phase}）`
    })

    // /goal：用户侧的目标操作（模型不能自己续命）。
    ctx.commands.register(
      { name: 'goal', args: '<目标 | pause | resume | clear | rounds>', description: '设置或控制会话目标（跨轮自动续跑）' },
      ({ args, ui }) => {
        const head = args[0] ?? ''
        if (head === '') {
          const view = service.goalView()
          ui.notice(
            view === null
              ? '当前没有目标。用法：/goal <一句话说清要交付什么>'
              : `当前目标：${view.objective}（${view.rounds}/${view.maxRounds} 轮，${view.phase}）`,
          )
          return
        }
        if (head === 'pause' || head === 'resume' || head === 'clear' || head === 'rounds') {
          const result = service.goalAction(head as 'pause' | 'resume' | 'clear' | 'extend')
          if (!result.ok) ui.notice(result.error ?? '目标操作失败')
          return
        }
        const result = goals.create(args.join(' '))
        if (!result.ok) {
          ui.notice(result.error ?? '目标建立失败')
          return
        }
        persist()
        ui.notice(`目标已建立：${result.snapshot.objective}（上限 ${result.snapshot.maxRounds} 轮）`)
      },
    )

    /**
     * 目标自动续跑：本轮干净结束后，目标还开着就自己补一条消息接着跑。
     * 走 agent 的排队通道，所以不会跟用户刚发的消息抢；有卡挂着时 takeGoalRound 会挡下来。
     */
    ctx.on('dsc/turn-end', (reason) => {
      if (reason !== 'completed') return
      setTimeout(() => {
        const reminder = service.takeGoalRound()
        if (reminder === null) return
        ctx.transcript.system(`目标自动续跑：继续推进「${service.goalView()?.objective ?? ''}」`)
        ctx.agent.followup(reminder)
      }, 0)
    })

    ctx.on('dsc/session-open', ({ session }) => {
      // 切会话：目标跟着新会话回来，自动续跑一律先卸膛（不隔会话点火）。
      goals.restore(session.state('goal') ?? null)
      touch()
    })

    const fields: SettingsField[] = [
      {
        type: 'number',
        key: 'defaultMaxRounds',
        label: '新目标缺省给多少轮自动续跑',
        min: 1,
        max: 256,
        step: 1,
        help: '一次自动续跑算一轮。用户点目标条上的「加轮次」是在这个数往上加；256 是硬顶，改不掉。',
      },
      {
        type: 'number',
        key: 'extendRoundsBy',
        label: '点一次「加轮次」加多少轮',
        min: 1,
        max: 64,
        step: 1,
        help: '轮次用完后由用户决定要不要继续，每次点按钮就按这个数放宽。',
      },
    ]

    const section: SettingsSectionSpec = {
      id: 'goal',
      title: '会话目标',
      subtitle: '一轮干净结束后自动往下推的轮次预算',
      order: 36,
      fields: () => fields,
      // 每次打开分区现读磁盘：手改 plugins.json 也能看到真值。
      values: (): SettingsValues => {
        config = readConfig(passed)
        return { defaultMaxRounds: config.defaultMaxRounds, extendRoundsBy: config.extendRoundsBy }
      },
      // 契约：save 返回字符串 = 失败原因。
      save: (key, value): string | void => {
        const num = Number(value)
        if (!Number.isFinite(num)) return '这里要填一个数字'
        if (key === 'defaultMaxRounds') applyConfig({ defaultMaxRounds: num })
        else if (key === 'extendRoundsBy') applyConfig({ extendRoundsBy: num })
        else return `这个分区没有这项：${key}`
      },
    }
    const offSection = ctx.settings.registerSection(section)

    return () => offSection()
  },
}
