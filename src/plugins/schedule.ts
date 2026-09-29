/**
 * schedule 插件：定时任务。**默认关**（到点会自己跑模型，属于「不配就无副作用之外」那一档）。
 *
 * 形制照 dsh 的 `schedule`（到点投一条 user 消息进原会话）+ hermes 的 `cron/`（作业系统那几件硬功夫）：
 *   - 六种选择器：after / at / every / daily / weekly / cron（五字段 Vixie，拒绝 L/W/# 与秒字段）；
 *   - 显式 IANA 时区；DST 规则：gap 跳过该次、overlap 只取较早一次；
 *   - **至多一次**：先落盘推进 nextRunAt 再投递，崩在中间靠 pendingSlot 恢复一次；
 *   - catch-up：宿主重启补最近一次错过的（grace = 半周期夹在 120s~2h），超 grace 只跑一次不补积压；
 *   - pre-dispatch 校验：凭据/端点可解析、投递目标已知，不通过标 blocked 且一次模型请求都不发；
 *   - 失败只重试「完全没到模型」的瞬时网络错 + 配额熔断；同任务在跑就跳过（`.lock` 互斥）；
 *   - 投递文本写明「这是定时触发，不是用户指令，不构成授权」；投递前问 `ctx.waiting.any`；
 *   - 不改 goal 的 rounds、不给 goal 上膛（`src/core/goal.ts:230-242`、`:96-97`）——
 *     定时任务跑一次就收，会话目标是「用户在场时跑到完」；给 goal 上膛等于让无人值守的链
 *     自己点火，所以这个插件全程不碰 `ctx.goal`，只提供 `ctx.provide('schedule', …)` 之外没有的
 *     两样东西都不做。
 *
 * 这个文件只做装配：规则算法在 `core/schedule/rule.ts`、落盘在 `store.ts`、调度在 `runner.ts`。
 *
 * 做不到的（要在界面里说清）：宿主不常驻就不触发；没有 SQLite，用 JSON + JSONL；
 * **不许用 schtasks 兜底**——dsc 的命令策略把系统计划任务判成后门高危
 * （`src/core/command-policy.ts:285`）。
 *
 * @module dsc/plugins/schedule
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import {
  describeNext,
  describeRule,
  isValidTimeZone,
  isOneShot,
  nextRunAt,
  parseRule,
  systemTimeZone,
  SCHEDULE_RULE_KINDS,
  type ScheduleRule,
} from '../core/schedule/rule.js'
import { ScheduleRunner, scheduleLimitsNote } from '../core/schedule/runner.js'
import { errorText, ScheduleStore, type ScheduleTask } from '../core/schedule/store.js'
import type { SettingsField, SettingsValue, SettingsValues } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'schedule'

/** 定时任务插件的可调项。 */
interface SchedulePluginConfig {
  /** 总开关：关掉后到点不投递（任务定义与台账都留着）。 */
  enabled: boolean
  /** 建任务时没写时区就用它。 */
  timeZone: string
  /** 单次最长运行秒数（等回合结束的上限）。 */
  maxRunSeconds: number
  /** 执行台账与投递历史保留条数。 */
  historyLimit: number
}

/** 缺省值：时区取系统时区，单次最长 10 分钟，历史 200 条。 */
const DEFAULTS = { enabled: true, maxRunSeconds: 600, historyLimit: 200 }

/** 数值夹取：不是数字就回落，越界就夹。 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), min), max) : fallback
}

/**
 * 从插件配置里取可调项并夹到合理区间。
 * @param passed - 装配时直接传进来的配置（内核挂载时的第二参数）
 */
function readConfig(passed?: unknown): SchedulePluginConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const zone = typeof raw.timeZone === 'string' && isValidTimeZone(raw.timeZone) ? raw.timeZone : systemTimeZone()
  return {
    enabled: raw.enabled !== false,
    timeZone: zone,
    maxRunSeconds: clampNumber(raw.maxRunSeconds, 30, 7_200, DEFAULTS.maxRunSeconds),
    historyLimit: clampNumber(raw.historyLimit, 20, 1_000, DEFAULTS.historyLimit),
  }
}

/** 任务一行摘要（命令与设置分区共用）。 */
function renderTaskLine(task: ScheduleTask): string {
  const title = task.title.length > 24 ? `${task.title.slice(0, 24)}…` : task.title
  const state = !task.enabled
    ? isOneShot(task.rule) && task.nextRunAt === null
      ? '已跑完'
      : '暂停'
    : task.lastStatus === 'blocked'
      ? '启用·阻塞'
      : task.lastStatus === 'failed'
        ? '启用·上次失败'
        : '启用'
  const tail =
    task.lastStatus === 'blocked' && task.lastError !== null
      ? `｜阻塞原因：${task.lastError}`
      : task.lastStatus === 'failed' && task.lastError !== null
        ? `｜上次失败：${task.lastError}`
        : ''
  return `${task.id.slice(0, 12)} · ${state} · ${title} · ${describeRule(task.rule, task.timeZone)} · ${task.timeZone} · ${describeNext(task.rule, task.timeZone, task.nextRunAt)}${tail}`
}

/** 整张清单（含页脚：说清「宿主不常驻就不触发」）。 */
function renderTaskList(tasks: readonly ScheduleTask[], problem: string | null, extra = ''): string {
  const lines: string[] = []
  if (problem !== null) lines.push(`⚠ ${problem}`)
  if (tasks.length === 0) {
    lines.push('现在没有定时任务。用法：/schedule add every:30m 起来喝水')
  } else {
    const running = tasks.filter((task) => task.enabled).length
    lines.push(`定时任务 ${tasks.length} 条（${running} 条启用）：`)
    for (const task of tasks) lines.push(`  ${renderTaskLine(task)}`)
  }
  if (extra !== '') lines.push(extra)
  lines.push(`提示：${scheduleLimitsNote()}`)
  return lines.join('\n')
}

/** 建任务时给用户的回报：必须写清「下次几点跑、在哪个时区」。 */
function renderCreated(task: ScheduleTask, config: SchedulePluginConfig): string {
  const head =
    `已建好定时任务 ${task.id.slice(0, 12)}「${task.title}」\n` +
    `规则：${describeRule(task.rule, task.timeZone)}\n` +
    `时区：${task.timeZone}\n` +
    `${describeNext(task.rule, task.timeZone, task.nextRunAt)}` +
    (task.nextRunAt === null ? '（排期由调度器下一轮补算，最多 1 秒）' : '')
  return config.enabled
    ? head
    : `${head}\n⚠ 定时任务总开关现在是关的：去设置 → 定时任务打开，或者用 schedule(action=resume) 打开任务本身`
}

/**
 * 从 `/schedule add` 后面那一串里切出「选择器」和「标题」。
 *
 * 为什么要单独切：命令的 args 是按空白切好的，而 cron 表达式本身含空格、weekly 是「星期几 时刻」两段。
 * 靠关键字决定要吃几段，剩下的都算标题。
 */
function splitRuleAndTitle(rest: string): { ok: true; ruleText: string; title: string } | { ok: false; error: string } {
  const tokens = rest.trim().split(/\s+/).filter((token) => token !== '')
  if (tokens.length === 0) {
    return { ok: false, error: `要写「选择器 标题」。六种选择器：${SCHEDULE_RULE_KINDS.join(' / ')}` }
  }
  const head = tokens[0]!
  const lower = head.toLowerCase()
  if (lower === 'cron' || lower === 'cron:') {
    if (tokens.length < 7) return { ok: false, error: 'cron 要写全五段：/schedule add cron 0 9 * * * 早报' }
    return { ok: true, ruleText: `cron:${tokens.slice(1, 6).join(' ')}`, title: tokens.slice(6).join(' ') }
  }
  if (lower.startsWith('cron:')) {
    if (tokens.length < 6) return { ok: false, error: 'cron 要写全五段：/schedule add cron:0 9 * * * 早报' }
    return { ok: true, ruleText: `cron:${[head.slice(5), ...tokens.slice(1, 5)].join(' ')}`, title: tokens.slice(5).join(' ') }
  }
  if (lower === 'weekly' || lower === 'weekly:') {
    if (tokens.length < 4) return { ok: false, error: 'weekly 要写「星期几 时刻 标题」：/schedule add weekly mon 09:30 站会' }
    return { ok: true, ruleText: `weekly:${tokens[1]} ${tokens[2]}`, title: tokens.slice(3).join(' ') }
  }
  if (lower.startsWith('weekly:')) {
    const colons = (head.match(/:/g) ?? []).length
    if (colons >= 2) return { ok: true, ruleText: head, title: tokens.slice(1).join(' ') }
    if (tokens.length < 3) return { ok: false, error: 'weekly 要写「星期几 时刻 标题」：/schedule add weekly:mon 09:30 站会' }
    return { ok: true, ruleText: `${head} ${tokens[1]}`, title: tokens.slice(2).join(' ') }
  }
  return { ok: true, ruleText: head, title: tokens.slice(1).join(' ') }
}

export const schedulePlugin: Plugin.Object = {
  name: 'schedule',
  inject: ['tools', 'commands', 'settings', 'transcript', 'agent', 'session', 'waiting', 'llm', 'prompt'],
  apply(ctx, passed: unknown) {
    let config = readConfig(passed)
    /** 写盘并立刻重读：设置页保存后下一次用值就是新值，不必重启宿主。 */
    const applyConfig = (patch: Record<string, unknown | null>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      config = readConfig(passed)
    }

    const store = new ScheduleStore({ historyLimit: config.historyLimit })
    const loaded = store.load()

    /** 建好 / 改完任务后把排期立刻补算出来，回报里才写得出准的「下次几点跑」。 */
    const ensureSchedule = async (id: string): Promise<ScheduleTask | undefined> => {
      const task = store.get(id)
      if (task === undefined) return undefined
      if (!task.enabled || task.nextRunAt !== null || task.pendingSlot !== null) return task
      await store.setNextRunAt(id, nextRunAt(task.rule, task.timeZone, Date.now()))
      return store.get(id)
    }

    const runner = new ScheduleRunner({
      store,
      config: () => {
        const current = readConfig(passed)
        return { enabled: current.enabled, timeZone: current.timeZone, maxRunSeconds: current.maxRunSeconds }
      },
      // 端点凭据能不能解析出来，是 pre-dispatch 的第一道；返回值含 apiKey，只判空、绝不外带。
      route: () => {
        const route = ctx.llm.route()
        return { baseUrl: route.baseUrl, apiKey: route.apiKey, model: route.model }
      },
      deliver: (text) => {
        ctx.agent.followup(text)
      },
      waiting: () => ctx.waiting.any,
      sessionId: () => ctx.session.current().meta.id,
      // 可选服务：读不到就当没有沙箱插件。绝不写 `ctx.sandbox?.`——属性访问本身会抛。
      canWriteDir: () => {
        const sandbox = ctx.get('sandbox')
        if (sandbox === undefined) return null
        const check = sandbox.canWrite(store.dir)
        return check.reason === undefined ? { allowed: check.allowed } : { allowed: check.allowed, reason: check.reason }
      },
      // `agent.followup` 不回传结果，回合结束时从会话流里捡最近一条「错误：…」当失败原文。
      lastErrorText: () => {
        const entries = ctx.transcript.getSnapshot().entries
        for (let index = entries.length - 1; index >= Math.max(0, entries.length - 6); index -= 1) {
          const entry = entries[index]!
          if (entry.kind === 'system' && entry.text.startsWith('错误：')) return entry.text.slice(3)
        }
        return ''
      },
      notice: (text) => ctx.transcript.system(text),
    })

    // ── 工具：schedule（单工具按 action 分发）──────────────────────────────────
    const toolDisposer = ctx.tools.register({
      name: 'schedule',
      description:
        '管理定时任务：到点把任务描述投回会话，跑一次完整回合。' +
        'action=create（要 title/prompt/rule，可选 timeZone）；list 看清单与下次时间；' +
        'update 改 title/prompt/rule/timeZone/enabled（要 id）；run 立即跑一次；' +
        'delete 删掉；pause / resume 暂停或恢复。' +
        `rule 六种写法：after:5m（多久后一次）/ at:2026-03-09T09:30（绝对时刻一次）/ every:30m（间隔，至少 60 秒）/ daily:09:30 / weekly:mon 09:30 / cron:0 9 * * *（五字段 Vixie，拒绝 L/W/# 与秒字段）。` +
        '用户要「每天/每周/过一会儿提醒我」这类需求时用这个工具建任务，别自己起定时器。' +
        '注意：宿主不常驻就不会触发，这一点要如实告诉用户。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'create | list | update | run | delete | pause | resume',
          },
          id: { type: 'string', description: 'update / run / delete / pause / resume 要给的 id（或它的前缀）' },
          title: { type: 'string', description: 'create 必填：一句话标题（清单与投递文本里都显示）' },
          prompt: { type: 'string', description: 'create 必填：到点后按它做事的那段任务描述' },
          rule: {
            type: 'string',
            description: 'create 必填；update 可选。例：every:30m、daily:09:30、weekly:mon 09:30、cron:0 9 * * *、after:5m、at:2026-03-09T09:30',
          },
          timeZone: {
            type: 'string',
            description: '可选：IANA 时区（如 Asia/Shanghai）；不写就用设置里的默认时区',
          },
          enabled: { type: 'boolean', description: 'update 可选：true 恢复 / false 暂停' },
        },
        required: ['action'],
      },
      risk: 'write',
      async run(args) {
        const action = String(args.action ?? '').trim().toLowerCase()
        config = readConfig(passed)
        store.reload()
        const zone = typeof args.timeZone === 'string' && args.timeZone !== '' ? args.timeZone : config.timeZone
        switch (action) {
          case 'create': {
            const title = String(args.title ?? '').trim()
            const prompt = String(args.prompt ?? '').trim()
            const ruleText = String(args.rule ?? '').trim()
            if (title === '') throw new Error('create 要给 title（一句话标题）')
            if (prompt === '') throw new Error('create 要给 prompt（到点后按它做事的任务描述）')
            if (ruleText === '') throw new Error(`create 要给 rule，六种写法：${SCHEDULE_RULE_KINDS.join(' / ')}`)
            if (!isValidTimeZone(zone)) throw new Error(`时区「${zone}」不认识，请写 IANA 名字，例如 Asia/Shanghai`)
            const parsed = parseRule(ruleText, zone, Date.now())
            if (!parsed.ok) throw new Error(parsed.error)
            const task = await store.create({
              title,
              prompt,
              rule: parsed.rule,
              timeZone: zone,
              createdBy: 'model',
              sessionId: ctx.session.current().meta.id,
            })
            return renderCreated((await ensureSchedule(task.id)) ?? task, readConfig(passed))
          }
          case 'list': {
            const tasks = store.list()
            return renderTaskList(tasks, store.problem, runner.describeState())
          }
          case 'update': {
            const found = store.findByPrefix(String(args.id ?? ''))
            if (!found.ok) throw new Error(found.error)
            const patch: { title?: string; prompt?: string; rule?: ScheduleRule; timeZone?: string; enabled?: boolean } = {}
            if (typeof args.title === 'string' && args.title.trim() !== '') patch.title = args.title
            if (typeof args.prompt === 'string' && args.prompt.trim() !== '') patch.prompt = args.prompt
            if (typeof args.timeZone === 'string' && args.timeZone !== '') {
              if (!isValidTimeZone(args.timeZone)) throw new Error(`时区「${args.timeZone}」不认识`)
              patch.timeZone = args.timeZone
            }
            if (typeof args.enabled === 'boolean') patch.enabled = args.enabled
            if (typeof args.rule === 'string' && args.rule.trim() !== '') {
              const parsed = parseRule(args.rule.trim(), patch.timeZone ?? found.task.timeZone, Date.now())
              if (!parsed.ok) throw new Error(parsed.error)
              patch.rule = parsed.rule
            }
            const updated = await store.update(found.task.id, patch)
            if (updated === null) throw new Error('这条任务刚刚被删掉了')
            // 规则 / 时区变了要把排期补算出来，回报里才写得出「下次几点跑」。
            const fresh = (await ensureSchedule(updated.id)) ?? updated
            return (
              `已更新「${fresh.title}」\n` +
              `规则：${describeRule(fresh.rule, fresh.timeZone)}｜时区：${fresh.timeZone}\n` +
              (fresh.enabled ? describeNext(fresh.rule, fresh.timeZone, fresh.nextRunAt) : '这条任务现在是暂停的（enabled=false）')
            )
          }
          case 'run': {
            const found = store.findByPrefix(String(args.id ?? ''))
            if (!found.ok) throw new Error(found.error)
            return runner.fireNow(found.task.id)
          }
          case 'delete': {
            const found = store.findByPrefix(String(args.id ?? ''))
            if (!found.ok) throw new Error(found.error)
            const removed = await store.remove(found.task.id)
            if (!removed) throw new Error('这条任务刚刚已经被删掉了')
            return `已删除定时任务「${found.task.title}」（${found.task.id.slice(0, 12)}）`
          }
          case 'pause':
          case 'resume': {
            const found = store.findByPrefix(String(args.id ?? ''))
            if (!found.ok) throw new Error(found.error)
            const updated = await store.update(found.task.id, { enabled: action === 'resume' })
            if (updated === null) throw new Error('这条任务刚刚被删掉了')
            return `${action === 'resume' ? '已恢复' : '已暂停'}「${updated.title}」｜${describeNext(updated.rule, updated.timeZone, updated.nextRunAt)}`
          }
          default:
            throw new Error(`action 只能是 create / list / update / run / delete / pause / resume（收到「${action}」）`)
        }
      },
    })

    // ── 命令：/schedule ────────────────────────────────────────────────────────
    const commandDisposer = ctx.commands.register(
      { name: 'schedule', args: '[list | add <选择器> <标题> | pause|resume|run|remove <id前缀>]', description: '管理定时任务（到点把任务描述投回会话）' },
      ({ args, ui }) => {
        const head = (args[0] ?? '').trim().toLowerCase()
        config = readConfig(passed)
        store.reload()
        const usage =
          '用法：\n' +
          '  /schedule list                       看清单与下次时间\n' +
          '  /schedule add every:30m 起来喝水      建任务（标题同时也是发给模型的描述）\n' +
          `  选择器六种：${SCHEDULE_RULE_KINDS.join(' / ')}\n` +
          '  /schedule pause|resume|run|remove <id前缀>'
        if (head === '' || head === 'list') {
          ui.notice(renderTaskList(store.list(), store.problem, runner.describeState()))
          return
        }
        if (head === 'add' || head === 'create') {
          const split = splitRuleAndTitle(args.slice(1).join(' '))
          if (!split.ok) {
            ui.notice(split.error)
            return
          }
          if (split.title.trim() === '') {
            ui.notice('还要给个标题（它同时也是发给模型的描述）：/schedule add every:30m 起来喝水')
            return
          }
          const parsed = parseRule(split.ruleText, config.timeZone, Date.now())
          if (!parsed.ok) {
            ui.notice(parsed.error)
            return
          }
          void store
            .create({
              title: split.title.trim(),
              prompt: split.title.trim(),
              rule: parsed.rule,
              timeZone: config.timeZone,
              createdBy: 'user',
              sessionId: ctx.session.current().meta.id,
            })
            .then((task) => ensureSchedule(task.id))
            .then((task) => ui.notice(task === undefined ? '任务建好但读不回来了，请用 /schedule list 确认' : renderCreated(task, readConfig(passed))))
            .catch((error: unknown) => ui.notice(`建任务失败：${errorText(error)}`))
          return
        }
        if (head === 'pause' || head === 'resume' || head === 'run' || head === 'remove' || head === 'delete') {
          const found = store.findByPrefix(args.slice(1).join(' '))
          if (!found.ok) {
            ui.notice(found.error)
            return
          }
          if (head === 'remove' || head === 'delete') {
            void store
              .remove(found.task.id)
              .then((removed) => ui.notice(removed ? `已删除「${found.task.title}」` : '这条任务刚刚已经被删掉了'))
              .catch((error: unknown) => ui.notice(`删除失败：${errorText(error)}`))
            return
          }
          if (head === 'run') {
            void runner
              .fireNow(found.task.id)
              .then((text) => ui.notice(text))
              .catch((error: unknown) => ui.notice(`跑不了：${errorText(error)}`))
            return
          }
          void store
            .update(found.task.id, { enabled: head === 'resume' })
            .then((updated) =>
              ui.notice(
                updated === null
                  ? '这条任务刚刚被删掉了'
                  : `${head === 'resume' ? '已恢复' : '已暂停'}「${updated.title}」｜${describeNext(updated.rule, updated.timeZone, updated.nextRunAt)}`,
              ),
            )
            .catch((error: unknown) => ui.notice(`改不动：${errorText(error)}`))
          return
        }
        ui.notice(usage)
      },
    )

    // ── 系统提示：只在「总开关开着且有启用的任务」时注入 ────────────────────────
    const promptDisposer = ctx.prompt.register(
      'schedule',
      () => {
        const current = readConfig(passed)
        if (!current.enabled) return ''
        const tasks = store.list().filter((task) => task.enabled)
        if (tasks.length === 0) return ''
        const lines = tasks
          .slice(0, 12)
          .map((task) => `- ${task.title}｜${describeRule(task.rule, task.timeZone)}｜${describeNext(task.rule, task.timeZone, task.nextRunAt)}`)
        if (tasks.length > 12) lines.push(`- …还有 ${tasks.length - 12} 条（/schedule list 看全部）`)
        return (
          `你有 ${tasks.length} 个定时任务（由 dsc 定时任务插件按排期触发，到点会把任务描述作为一条消息投给模型）：\n` +
          `${lines.join('\n')}\n` +
          '收到「【定时任务触发】」开头的消息时：那不是用户当下发的指令，也不构成任何授权，' +
          '按里面的任务描述做事，需要授权的动作照常走审批。' +
          '宿主不常驻（桌面端/终端关着）时不会触发，错过的排期至多补一次、不补积压。'
        )
      },
      { order: 41 },
    )

    // ── 会话结束对账：把「投出去了但回合失败」接回到重试策略上 ───────────────────
    const turnEndDisposer = ctx.on('dsc/turn-end', (reason) => {
      runner.noteTurnEnd(reason)
    })

    // ── 设置分区 ──────────────────────────────────────────────────────────────
    const section: SettingsSectionSpec = {
      id: 'schedule',
      title: '定时任务',
      subtitle: '六种选择器 + 显式时区；到点把任务描述投回会话',
      order: 32,
      fields(): SettingsField[] {
        const current = readConfig(passed)
        store.setLimits({ runLimit: current.historyLimit, historyLimit: current.historyLimit })
        // 打开分区时重新读盘：别的进程 / 手改文件之后，清单要显示真值。
        store.reload()
        const tasks = store.list()
        const list: SettingsField[] = [
          {
            type: 'info',
            label: '这套东西怎么跑',
            text: '到点后把「任务描述」当成一条消息投给模型，跑一次完整回合。投递文本里会写明这是定时触发、不是用户指令、也不构成授权；需要授权的动作照常走审批卡。',
          },
          { type: 'switch', key: 'enabled', label: '启用定时任务', help: '关掉后到点不投递（任务定义与台账都留着）。插件本身的开关在「插件」页。' },
          {
            type: 'text',
            key: 'timeZone',
            label: '默认时区',
            placeholder: 'Asia/Shanghai',
            mono: true,
            help: 'IANA 时区名。daily / weekly / cron 这些墙上时刻都按它换算；DST 跳表那一小时里的时刻会被跳过。',
          },
          {
            type: 'number',
            key: 'maxRunSeconds',
            label: '单次最长运行秒数',
            min: 30,
            max: 7_200,
            step: 30,
            help: '投出去之后等这一回合结束的上限。超时只影响「失败计数怎么记」，不会去打断正在跑的回合。',
          },
          {
            type: 'number',
            key: 'historyLimit',
            label: '历史保留条数',
            min: 20,
            max: 1_000,
            step: 20,
            help: '执行台账（runs.jsonl）与每条任务的投递历史各留多少条；投递历史另有 30 天上限。',
          },
          {
            type: 'info',
            label: `任务清单（${tasks.length} 条）`,
            text: tasks.length === 0 ? '现在没有定时任务。用 /schedule add every:30m 起来喝水 建一个。' : tasks.map((task) => renderTaskLine(task)).join('\n'),
            mono: true,
            copyable: true,
          },
          { type: 'button', action: 'check', label: '立即检查一次', style: 'ghost', help: '立刻跑一遍到点判定（补投悬空槽位、处理错过的排期），并把结果打回会话。' },
          { type: 'info', label: '状态', text: runner.describeState() },
          { type: 'info', label: '数据目录', text: store.dir, mono: true, copyable: true, help: 'tasks.json 是任务定义，runs.jsonl 是执行台账，.lock 是跨进程的调度锁。' },
          { type: 'info', label: '做不到的事', text: scheduleLimitsNote() },
        ]
        return list
      },
      values(): SettingsValues {
        const current = readConfig(passed)
        config = current
        store.reload()
        return {
          enabled: current.enabled,
          timeZone: current.timeZone,
          maxRunSeconds: current.maxRunSeconds,
          historyLimit: current.historyLimit,
        }
      },
      save(key: string, value: SettingsValue): string | void {
        switch (key) {
          case 'enabled':
            applyConfig({ enabled: value === true })
            break
          case 'timeZone': {
            const zone = String(value).trim()
            if (!isValidTimeZone(zone)) return `时区「${zone}」不认识，请写 IANA 名字，例如 Asia/Shanghai`
            applyConfig({ timeZone: zone })
            break
          }
          case 'maxRunSeconds': {
            const num = Number(value)
            if (!Number.isFinite(num) || !Number.isInteger(num)) return '单次最长运行秒数要填一个整数'
            if (num < 30 || num > 7_200) return '单次最长运行秒数要在 30~7200 之间'
            applyConfig({ maxRunSeconds: num })
            break
          }
          case 'historyLimit': {
            const num = Number(value)
            if (!Number.isFinite(num) || !Number.isInteger(num)) return '历史保留条数要填一个整数'
            if (num < 20 || num > 1_000) return '历史保留条数要在 20~1000 之间'
            applyConfig({ historyLimit: num })
            store.setLimits({ runLimit: num, historyLimit: num })
            break
          }
          default:
            return `这个分区没有这项：${key}`
        }
      },
      action(name: string): string | Promise<string> {
        if (name !== 'check') return `没有这个按钮：${name}`
        config = readConfig(passed)
        return runner.checkNow()
      },
    }
    const sectionDisposer = ctx.settings.registerSection(section)

    // 启动：拿锁 + 先跑一次 catch-up + 排下一次唤醒（内部是 unref 的单个定时器）。
    runner.start()
    if (loaded.problem !== null) ctx.transcript.system(`定时任务：${loaded.problem}`)

    /** 退订一切、清掉定时器、放掉调度锁；一个都不能漏（停用是热卸载）。 */
    return () => {
      runner.stop()
      promptDisposer()
      turnEndDisposer()
      sectionDisposer()
      commandDisposer()
      toolDisposer()
    }
  },
}
