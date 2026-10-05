/**
 * 子智能体（官方插件，默认关闭）。
 *
 * 打开后模型多出 `subagent` 工具：派活、传话、打断。关掉后这个工具、它注入的
 * 提示词、以及在跑的队友一起消失——本插件不提供第二套 agent 实现，队友就是
 * 「另一个 MiniAgent 实例 + 它自己的会话文件 + 一张冻结的工牌」。
 *
 * 队友按会话隔离（对照 dsh 的 parentSession 过滤）：每个会话各自一份在队名单与
 * 并发额度，`subagent list` 只报本会话派出的队友；共享任务看板在「智能体团队」
 * 插件里，那是叠在这一层之上的协作层。
 *
 * 工牌（工具白名单 / 审批意愿 / 轮次预算 / 模型）在队友开工那一刻从角色文件复制进
 * 运行时并冻结，所以中途改角色文件只影响下一个新队友，也堵住了「队友跑一半给自己提权」。
 *
 * 审批取「全局上限」与「角色意愿」里更严的那个：全局选「不允许」时谁都别想弹卡；
 * 全局选「仅前台队友」时，后台队友自动退回不允许。弹出来的卡上写明是谁在请求。
 *
 * @module dsc/plugins/subagent
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import { Transcript } from '../adapter/transcript.js'
import {
  builtinRoleNames,
  builtinRole,
  DSC_AGENTS_DIR,
  ensureBuiltinRoles,
  findRole,
  listRoles,
  writeRole,
  type AgentRole,
  type TeammateApproval,
} from '../core/agent-roles.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import { MiniAgent } from '../core/loop.js'
import { REJECTED_TOOL_TEXT, Session, teammateRoot } from '../core/session.js'
import { redact } from '../core/secrets.js'
import { argsSummary, type ToolContext, type ToolEntry } from '../core/tools.js'
import { ToolGuardRegistry, toolApprovalGuard } from '../core/tool-guards.js'
import { inboxAppend } from '../core/team-board.js'
import type { EffortLevel, SettingsField, SettingsValue, TeammateView, TranscriptEntry } from '../contract.js'
import type { ReviewService, ReviewSpawnRequest, ReviewSpawnResult, SettingsSectionSpec, TeamService } from '../services/types.js'
import { reviewMessage } from '../core/git-info.js'

/** 插件配置（存 `~/.dsc/plugins.json` 条目树的 config 里）。 */
interface SubagentConfig {
  /** 允许模型自己派活；关掉后两个工具连同提示词一起撤下。 */
  allowDelegation: boolean
  /** 同时干活的队友上限（满载直接拒绝，不排队；收工的不占额度）。 */
  maxTeammates: number
  /** 允许几层：0 = 只有用户能派队友，Lead 不许再往下派。 */
  maxDepth: number
  /** 审批上限：队友能不能向用户要授权。 */
  approval: TeammateApproval
  /** 后台队友干完：auto = 立刻把汇报接进 Lead 的下一轮；quiet = 只写进会话等用户下次说话。 */
  notify: 'auto' | 'quiet'
  /** 新队友默认模型（`端点/模型`）；空 = 跟随当前模型。角色文件里的 model 优先。 */
  defaultModel: string
}

const CONFIG_KEY = 'subagent'

const DEFAULTS: SubagentConfig = {
  allowDelegation: true,
  maxTeammates: 4,
  maxDepth: 1,
  approval: 'forbid',
  notify: 'auto',
  defaultModel: '',
}

const APPROVAL_RANK: Record<TeammateApproval, number> = { forbid: 0, foreground: 1, ask: 2 }

/** 收工的队友最多在名单里留这么多个，超了就挤掉最老的（不占并发额度，只是别把名单撑爆）。 */
const MAX_LISTED_FINISHED = 12

/** 主会话这一方在任务板上的名字。 */
const LEAD = 'lead'

/** 队友的运行状态（`done` 不算一种状态：干完就是 idle，等人再传话）。 */
type TeammateState = 'working' | 'idle' | 'failed' | 'stopped'

/** 一个在队或收工的队友。 */
interface Teammate {
  name: string
  role: string
  task: string
  /** 冻结的工牌。 */
  badge: {
    tools: string[] | null
    maxTurns: number
    approval: TeammateApproval
    model: string | null
    effort: EffortLevel | null
  }
  session: Session
  agent: MiniAgent
  /** 派它的那一方当时的会话对象：汇报要写回这个文件，而不是「现在界面上打开的那个」。 */
  parentSession: Session
  state: TeammateState
  /** 已经发起过的模型请求轮数。 */
  rounds: number
  toolCalls: number
  depth: number
  /** 谁派的它（主会话是 'lead'）。 */
  parent: string
  background: boolean
  startedAt: number
  finishedAt?: number
  lastText: string
  error?: string
  /** 等下一次 turn/end 的 waiter 队列。 */
  waiters: Array<() => void>
  /** 输出瀑布的行池（最新在后，只留 8 行；正文行与工具结果首行都进）。 */
  outputLines: string[]
  /** 当前（或最后一把）工具，画内联卡的「当前工具行」。 */
  lastTool?: { name: string; args: string; status: 'running' | 'done' | 'failed' }
  /** 累计 token（输入+输出端点真值；内联卡显示用）。 */
  tokens: number
}

/** 调这两个工具的人是谁（决定任务板认领人、信箱署名、能不能再往下派）。 */
interface Caller {
  name: string
  depth: number
  background: boolean
}

/** 记录在案的一个队友（`~/.dsc/team/roster.json`，重启后侧栏仍能看到收工的队友）。 */
interface RosterRecord {
  name: string
  role: string
  state: TeammateState
  task: string
  file: string
  cwd: string
  parent: string
  depth: number
  rounds: number
  startedAt: number
  finishedAt?: number
  /**
   * 出生会话 id（派它的那个会话）。名册是跨重启的台账，所以这一项让队友永久带着
   * 「它是从哪个会话派出去的」。老记录没有这一项，读档时按 undefined 处理。
   */
  sessionId?: string
}

/** 名字合法字符，跟角色名同一套。 */
const NAME_OK = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 工作目录名 → 可当目录名的短名（队友日志按它分堆）。 */
function cwdSlug(cwd: string): string {
  const cleaned = cwd.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned.slice(-40) === '' ? 'cwd' : cleaned.slice(-40)
}

/**
 * 把父会话切到「上一个完整回合」为止的记录行（不含 meta）。
 * 完整回合 = 一条没带工具调用的 assistant 回复；它的后面可能就是正干到一半的活，
 * 那些不要，否则队友一睁眼就看到半截工具调用。
 * @returns null = 这个会话还没有一个完整回合可带。
 */
function forkSeedLines(parentFile: string): string[] | null {
  let raw: string
  try {
    raw = readFileSync(parentFile, 'utf8')
  } catch {
    return null
  }
  const lines = raw.split(/\r?\n/).filter((line) => line !== '')
  let cut = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const record = JSON.parse(lines[index]!) as { type?: string; toolCalls?: unknown }
      if (record.type === 'assistant' && record.toolCalls === undefined) {
        cut = index
        break
      }
    } catch {
      // 坏行：跳过继续往前找，不影响切点
    }
  }
  if (cut < 0) return null
  // 第 0 行是父会话自己的 meta，队友要用自己那条
  return lines.slice(1, cut + 1)
}

export const subagentPlugin: Plugin.Object = {
  name: 'subagent',
  inject: ['session', 'tools', 'llm', 'approval', 'transcript', 'prompt', 'settings', 'agent'],
  apply(ctx, passed) {
    ensureBuiltinRoles()

    // ── 配置 ────────────────────────────────────────────────────────────────
    const readConfig = (): SubagentConfig => {
      const raw = resolvePluginConfig(CONFIG_KEY, passed)
      const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
        const num = Number(value)
        return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), min), max) : fallback
      }
      const approval = APPROVAL_RANK[String(raw.approval) as TeammateApproval] === undefined
        ? DEFAULTS.approval
        : (String(raw.approval) as TeammateApproval)
      return {
        allowDelegation: raw.allowDelegation !== false && raw.allowDelegation !== 'false',
        maxTeammates: clamp(raw.maxTeammates, 1, 8, DEFAULTS.maxTeammates),
        maxDepth: clamp(raw.maxDepth, 0, 2, DEFAULTS.maxDepth),
        approval,
        notify: raw.notify === 'quiet' ? 'quiet' : 'auto',
        defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel.trim() : '',
      }
    }
    let config = readConfig()
    const applyConfig = (patch: Record<string, unknown | null>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      config = readConfig()
    }

    // ── 名册持久化 ──────────────────────────────────────────────────────────
    const rosterFile = join(ctx.settings.about().home, 'team', 'roster.json')
    const readRoster = (): RosterRecord[] => {
      try {
        const doc = JSON.parse(readFileSync(rosterFile, 'utf8')) as { teammates?: unknown }
        return Array.isArray(doc.teammates) ? (doc.teammates as RosterRecord[]) : []
      } catch {
        return []
      }
    }
    const writeRoster = (records: RosterRecord[]): void => {
      try {
        mkdirSync(join(ctx.settings.about().home, 'team'), { recursive: true })
        writeFileSync(rosterFile, `${JSON.stringify({ teammates: records }, null, 2)}\n`, 'utf8')
      } catch {
        // 名册写不下去只影响重启后侧栏看不到收工的队友，不该让派活失败
      }
    }
    const remember = (teammate: Teammate): void => {
      const record: RosterRecord = {
        name: teammate.name,
        role: teammate.role,
        state: teammate.state,
        task: teammate.task,
        file: teammate.session.filePath,
        cwd: teammate.session.meta.cwd,
        parent: teammate.parent,
        depth: teammate.depth,
        rounds: teammate.rounds,
        startedAt: teammate.startedAt,
        // 出生会话：队友从哪个会话派出去的，名册上永久记着（用户切走会话也认得出它属于谁）
        sessionId: teammate.parentSession.meta.id,
        ...(teammate.finishedAt !== undefined ? { finishedAt: teammate.finishedAt } : {}),
      }
      const rest = readRoster().filter((entry) => entry.name !== teammate.name)
      writeRoster([...rest, record].slice(-200))
    }

    // ── 队友运行时 ──────────────────────────────────────────────────────────
    const teammates = new Map<string, Teammate>()
    /** 正在干活的队友（并发额度按会话各计各的，对照 dsh 的 per-session 团队）：收工的不占坑。 */
    const busyFor = (sessionId: string): Teammate[] =>
      [...teammates.values()].filter(
        (entry) => entry.state === 'working' && entry.parentSession.meta.id === sessionId,
      )

    const waitForIdle = (teammate: Teammate): Promise<void> =>
      teammate.state !== 'working'
        ? Promise.resolve()
        : new Promise<void>((resolve) => teammate.waiters.push(resolve))

    const settle = (teammate: Teammate, reason: 'completed' | 'aborted' | 'error', error?: string): void => {
      teammate.finishedAt = Date.now()
      const tail = [...teammate.session.messages].reverse().find((message) => message.role === 'assistant')
      teammate.lastText = typeof tail?.content === 'string' ? tail.content : ''
      if (reason === 'completed') teammate.state = 'idle'
      else if (reason === 'aborted') teammate.state = 'stopped'
      else {
        teammate.state = 'failed'
        teammate.error = error
      }
      remember(teammate)
      // T21：队友状态进了快照的跨会话状态面，动一下要跟着失效
      ctx.transcript.touch()
      const waiters = teammate.waiters.splice(0)
      for (const resolve of waiters) resolve()
    }

    /** 队友的工具表：按工牌白名单筛。subagent 换成它自己的署名；team_task（智能体团队
     * 插件注册的）保留原实现，只把自己的身份塞进上下文，看板认领人才不会都算成 lead。 */
    const toolsFor = (teammate: Teammate): ToolEntry[] => {
      const all = ctx.tools.list()
      const allowed = teammate.badge.tools === null ? all : all.filter((entry) => teammate.badge.tools!.includes(entry.name))
      const self = (): Caller => ({ name: teammate.name, depth: teammate.depth, background: teammate.background })
      return allowed.map((entry) => {
        if (entry.name === 'subagent') {
          return { ...entry, run: (args: Record<string, unknown>, runCtx: ToolContext) => runSubagent(args, runCtx, self()) }
        }
        if (entry.name === 'team_task') {
          return { ...entry, run: (args: Record<string, unknown>, runCtx: ToolContext) => entry.run(args, { ...runCtx, caller: self() }) }
        }
        return entry
      })
    }

    /**
     * 队友自己那条工具守卫链：全局上限与角色意愿取更严的那个，通过的请求在卡上署名。
     * 每条链只有一位审批守卫——队友不该被主会话的协作模式闸门管着，也不该跟主会话共用一条链。
     */
    const guardsFor = (teammate: Teammate): ToolGuardRegistry => {
      const chain = new ToolGuardRegistry()
      chain.register(
        toolApprovalGuard({
          id: `teammate:${teammate.name}`,
          async approve(input) {
            const rank = Math.min(APPROVAL_RANK[config.approval], APPROVAL_RANK[teammate.badge.approval])
            const canAsk = rank >= APPROVAL_RANK.foreground && (rank === APPROVAL_RANK.ask || !teammate.background)
            if (!canAsk) return false
            const decision = await ctx.approval.decide(
              {
                toolName: `队友 ${teammate.name}（${teammate.role}）· ${input.toolName}`,
                argsSummary: argsSummary(input.args),
                args: input.args,
                cwd: input.cwd,
              },
              input.signal,
            )
            return decision !== 'reject'
          },
          deniedReason: REJECTED_TOOL_TEXT,
        }),
      )
      chain.registerObserver({ id: 'redact', order: 10, observe: (_toolName, text) => redact(text) })
      return chain
    }

    function startTeammate(input: {
      name: string
      role: AgentRole
      task: string
      caller: Caller
      background: boolean
      seed: string[] | null
      parentSession: Session
    }): Teammate {
      const cwd = input.parentSession.meta.cwd
      const file = join(teammateRoot(), cwdSlug(cwd), `${randomUUID()}.jsonl`)
      mkdirSync(join(teammateRoot(), cwdSlug(cwd)), { recursive: true })
      const id = randomUUID()
      let session: Session
      if (input.seed === null) {
        session = Session.create(cwd, file)
      } else {
        const meta = JSON.stringify({ type: 'meta', id, cwd, createdAt: Date.now() })
        writeFileSync(file, [meta, ...input.seed].join('\n') + '\n', 'utf8')
        session = Session.load(file, true)
      }

      const model = input.role.model ?? (config.defaultModel === '' ? null : config.defaultModel)
      const effort = input.role.effort
      const teammate: Teammate = {
        name: input.name,
        role: input.role.name,
        task: input.task,
        // 工牌在此刻冻结：此后改角色文件不影响它
        badge: {
          tools: input.role.tools,
          maxTurns: input.role.maxTurns,
          approval: input.role.approval,
          model,
          effort,
        },
        session,
        parentSession: input.parentSession,
        state: 'working',
        rounds: 0,
        toolCalls: 0,
        depth: input.caller.depth + 1,
        parent: input.caller.name,
        background: input.background,
        startedAt: Date.now(),
        lastText: '',
        waiters: [],
        outputLines: [],
        tokens: 0,
        agent: undefined as unknown as MiniAgent,
      }

      /** 正文按行攒的缓冲（delta 碎片凑整行进瀑布）。 */
      let lineBuffer = ''
      teammate.agent = new MiniAgent(
        {
          route: () => {
            if (teammate.badge.model === null) return ctx.llm.route()
            const at = teammate.badge.model.indexOf('/')
            const provider = at > 0 ? teammate.badge.model.slice(0, at) : teammate.badge.model
            const modelId = at > 0 ? teammate.badge.model.slice(at + 1) : ''
            return ctx.llm.routeTo(provider, modelId, teammate.badge.effort ?? 'default')
          },
          systemPrompt: () =>
            `${input.role.prompt}

# 你在团队里的位置
你是队友「${teammate.name}」（角色 ${teammate.role}），派你活的是「${teammate.parent}」。
你最多能发 ${teammate.badge.maxTurns} 次模型请求，用完会被自动收手，请把力气花在关键处。
${teammate.badge.tools === null ? '' : `你只被授权这些工具：${teammate.badge.tools.join('、')}。用别的办法办不成就在最后一段说清楚，让 ${teammate.parent} 决定。`}
${teammate.badge.approval === 'forbid' ? '你不能向用户请求授权：需要授权的操作会被直接拒绝，不要反复尝试。' : '需要授权的操作可以向用户请求，审批卡上会写明是你（' + teammate.name + '）在请求。'}
干完活用一段话交结果：做了什么、看到什么证据（文件名:行号）、还有什么没做。`,
          tools: () => toolsFor(teammate),
          guards: guardsFor(teammate),
          stream: (api, request, handlers) => ctx.llm.stream(api, request, handlers),
          emit: (event) => {
            if (event.type === 'message') {
              teammate.rounds += 1
              // 轮次预算到点就收手：这就是「子智能体不许无限自转」的闸门
              if (teammate.rounds >= teammate.badge.maxTurns) teammate.agent.cancel()
            } else if (event.type === 'tool/call') {
              teammate.toolCalls += 1
              teammate.lastTool = {
                name: event.name,
                args: event.args.replace(/\s+/g, ' ').trim().slice(0, 60),
                status: 'running',
              }
            } else if (event.type === 'tool/result') {
              if (teammate.lastTool !== undefined) {
                teammate.lastTool = {
                  ...teammate.lastTool,
                  status: event.error !== undefined && event.error !== 'rejected' ? 'failed' : 'done',
                }
              }
              // 工具结果首行进瀑布：跑动期间 teammate 说话少、动手多，结果行才是活信号
              const firstLine = event.text.split('\n').map((line) => line.trim()).find((line) => line !== '')
              if (firstLine !== undefined) pushLines(teammate.outputLines, firstLine)
            } else if (event.type === 'delta' && event.kind === 'text') {
              // 正文增量按行攒：成行的推进瀑布（跟主会话直播尾同一节奏，不需要节流器）
              lineBuffer += event.text
              let newline = lineBuffer.indexOf('\n')
              while (newline >= 0) {
                pushLines(teammate.outputLines, lineBuffer.slice(0, newline))
                lineBuffer = lineBuffer.slice(newline + 1)
                newline = lineBuffer.indexOf('\n')
              }
            } else if (event.type === 'usage') {
              teammate.tokens += event.inputTokens + event.outputTokens
            } else if (event.type === 'turn/end') {
              if (lineBuffer.trim() !== '') pushLines(teammate.outputLines, lineBuffer)
              lineBuffer = ''
              settle(teammate, event.reason, lastError.get(teammate.name))
            } else if (event.type === 'error') {
              lastError.set(teammate.name, event.message)
            }
            forwardSubagent()
          },
        },
        session,
      )

      teammates.set(teammate.name, teammate)
      remember(teammate)
      // T21：新队友一上场就是 working，快照的状态面跟着失效
      ctx.transcript.touch()
      teammate.agent.followup(input.task)
      // 开卡先落一张头行（事件流到达前的 0 空窗），之后每次事件原位刷新
      forwardSubagent()
      return teammate

      /** 正文行进瀑布：只留最后 8 行，瀑布永远显示「最新发生的事」。 */
      function pushLines(pool: string[], line: string): void {
        const trimmed = line.trim()
        if (trimmed === '') return
        pool.push(trimmed)
        if (pool.length > 8) pool.splice(0, pool.length - 8)
      }

      /**
       * 把队友的当前快照转发给父会话的内联卡。只在父会话正被查看时投递——
       * 转录是「当前查看会话」的那一份，往里折别家会话的卡就是串台；切回时
       * 转录插件按名册种回头行卡，之后的转发接上原位刷新。
       */
      function forwardSubagent(): void {
        if (ctx.session.current() !== teammate.parentSession) return
        ctx.transcript.emit({
          type: 'subagent',
          row: {
            name: teammate.name,
            role: teammate.role,
            task: teammate.task,
            state: teammate.state,
            model: teammate.badge.model ?? ctx.llm.model,
            rounds: teammate.rounds,
            toolCalls: teammate.toolCalls,
            startedAt: teammate.startedAt,
            ...(teammate.finishedAt !== undefined ? { finishedAt: teammate.finishedAt } : {}),
            ...(teammate.lastTool !== undefined ? { lastTool: { ...teammate.lastTool } } : {}),
            ...(teammate.outputLines.length > 0 ? { outputLines: [...teammate.outputLines] } : {}),
            ...(teammate.tokens > 0 ? { tokens: teammate.tokens } : {}),
            ...(teammate.error !== undefined ? { error: teammate.error } : {}),
            file: teammate.session.filePath,
          },
        })
      }
    }

    /** 队友报错文本暂存（emit 的 error 事件比 turn/end 早一步）。 */
    const lastError = new Map<string, string>()

    /** 后台队友干完，把汇报交给派它的那一方。 */
    const reportHome = (teammate: Teammate): void => {
      const state = teammate.state === 'idle' ? '已完成' : teammate.state === 'stopped' ? '已停止' : '已失败'
      const body =
        teammate.state === 'failed'
          ? `（它失败了：${teammate.error ?? '未知错误'}）`
          : teammate.lastText === ''
            ? '（它没留下文字结论）'
            : teammate.lastText
      const notice = `<teammate-report from="${teammate.name}" role="${teammate.role}" state="${state}">
派给它的任务：${teammate.task}
它的汇报：
${body}
</teammate-report>`
      if (teammate.parent !== LEAD) {
        // 派它的是另一个队友：直接投进它的信箱并叫醒它
        const parent = teammates.get(teammate.parent)
        if (parent !== undefined) {
          inboxAppend(parent.name, notice)
          parent.agent.followup(notice)
          return
        }
      }
      const line = `队友 ${teammate.name}，角色 ${teammate.role}，${state}`
      const live = ctx.session.current() === teammate.parentSession
      // 0.6.48 常驻多 agent：父会话正被查看、或它的 agent 还常驻（后台跑着/刚切走），
      // 汇报都投给那个 agent（跑动中进收件箱，闲置的唤起一轮后台回合）；已经收摊的
      // 才写文件等用户回去看到——不打断也不抢跑。
      const parentResident = ctx.agent.hasAgent(teammate.parentSession.meta.id)
      if (config.notify === 'auto' && (live || parentResident)) {
        ctx.agent.followup(notice, undefined, teammate.parentSession.meta.id)
        ctx.transcript.system(`${line}，汇报已${live ? '并入下一轮' : '投进后台会话'}`)
      } else {
        // 静默，或者父会话的 agent 已收摊：话写进它所属的那个会话文件，
        // 等用户回到那个会话再说话时模型自然看到，不打断也不抢跑。
        teammate.parentSession.appendUser(notice)
        ctx.transcript.system(
          live
            ? `${line}，汇报已写入会话，下一条消息时模型会看到`
            : `${line}，汇报写入了派出它的会话`,
        )
      }
    }

    // ── 侧栏要的服务 ────────────────────────────────────────────────────────
    // 队友清单、只读查看与两条管理通道：UI 因此不必知道队友文件放在哪，
    // 插件关着时这个服务也不存在。
    const teamService: TeamService = {
      list: (): TeammateView[] => {
        const views: TeammateView[] = []
        for (const record of readRoster()) {
          // 在队的队友以内存为准（轮数、状态都在动），收工的以名册为准
          const live = teammates.get(record.name)
          const finishedAt = live?.finishedAt ?? record.finishedAt
          // 出生会话同理：在队的问内存里那个会话对象，收工的问名册（老记录没有这一项）
          const sessionId = live?.parentSession.meta.id ?? record.sessionId
          views.push({
            name: record.name,
            role: record.role,
            // 本进程里它并不活着，却按名册残留报「working」就是撒谎（上次进程没
            // settle 就退了）——僵尸读作 stopped；远程待命的双进程共享名册，
            // 所以只修读路径、不做启动清写，避免误标宿主进程的活队友。
            state: live !== undefined ? live.state : record.state === 'working' ? 'stopped' : record.state,
            task: record.task,
            file: live === undefined ? record.file : live.session.filePath,
            parent: record.parent,
            depth: record.depth,
            rounds: live === undefined ? record.rounds : live.rounds,
            startedAt: record.startedAt,
            ...(finishedAt === undefined ? {} : { finishedAt }),
            ...(sessionId === undefined ? {} : { sessionId }),
          })
        }
        return views.sort((a, b) => b.startedAt - a.startedAt)
      },
      peek: async (file: string): Promise<TranscriptEntry[]> => {
        const resolved = resolve(file)
        if (!resolved.startsWith(resolve(teammateRoot()))) {
          throw new Error('这里只能看队友的运行记录（其它会话请在左侧打开）')
        }
        // 只读：载入内存重放，不往那个文件写任何东西（也不拿写租约——队友可能正活着写它）
        const session = Session.load(resolved, true, { lease: false })
        const replay = new Transcript()
        replay.replayHistory(session.messages, session.toolErrors, session.fileChanges)
        return [...replay.entries, ...replay.liveEntries()]
      },
      // 用户从界面上管理队友的两条通道：与模型用的 subagent 工具走同一段逻辑，
      // 只是署名换成 user（队友信箱里看得出这句话是人说的）；
      // 名字不存在时返回的那句话本身就是给用户看的错误说明。
      stop: async (name: string): Promise<string> => stopTeammate(name, 'stop'),
      message: async (name: string, text: string): Promise<string> => messageTeammate(name, text, 'user'),
      remove: async (name: string): Promise<string> => {
        // 还在干活的先停止（文件正被流式写入，删了也会被重建）；收工的才许移除
        const live = teammates.get(name)
        if (live !== undefined && live.state === 'working') {
          return `队友「${name}」还在干活：先停止，再从名册移除。`
        }
        const record = readRoster().find((entry) => entry.name === name)
        if (live === undefined && record === undefined) return `名册里没有叫「${name}」的队友。`
        teammates.delete(name)
        writeRoster(readRoster().filter((entry) => entry.name !== name))
        // 运行记录文件一并删：它只在名册里可达，留着就是孤儿。只认 teammateRoot 下的路径，
        // 删不动（被占用等）不算失败——名册已经摘掉，孤儿文件不影响任何列表。
        const file = live?.session.filePath ?? record?.file
        let removedFile = false
        if (typeof file === 'string' && file !== '') {
          const resolvedFile = resolve(file)
          if (resolvedFile.startsWith(resolve(teammateRoot()))) {
            try {
              // rmSync 的 force 对不存在的文件也算成功：如实报告文件本来就在不在
              const existed = existsSync(resolvedFile)
              rmSync(resolvedFile, { force: true })
              rmSync(`${resolvedFile}.lock`, { force: true })
              removedFile = existed
            } catch {
              // 文件被占用：下次同位置的记录不冲突（uuid 命名），孤儿文件无害
            }
          }
        }
        // T21：队友名册进了快照的跨会话状态面，摘掉也要让侧栏/面板立刻知道
        ctx.transcript.touch()
        return removedFile
          ? `已把「${name}」从名册移除，运行记录一并删除。`
          : `已把「${name}」从名册移除（它的运行记录文件不在了，跳过删除）。`
      },
    }
    ctx.provide('team', teamService)

    // ── 只读代码审查通道（T18）─────────────────────────────────────────────
    // /review 的升级路径：派一个工牌被强制压到只读交集的队友（工具 = read/glob/grep，
    // 审批 = forbid，与角色文件怎么改无关），后台审查，findings 以 <review-findings>
    // 包裹写回发起会话——渲染层解析成卡片，主会话不吃模型轮。
    const READONLY_TOOLS = ['read', 'glob', 'grep']

    const spawnReviewer = (request: ReviewSpawnRequest): ReviewSpawnResult => {
      const parentSession = ctx.session.current()
      const working = busyFor(parentSession.meta.id)
      if (working.length >= config.maxTeammates) {
        return {
          ok: false,
          reason: `正在干活的队友已到上限 ${config.maxTeammates} 个（${working.map((entry) => entry.name).join('、')}），等一个收工再 /review`,
        }
      }
      // 角色文件被用户删掉也照常可审：从出厂定义就地取（不落盘）；无论来自哪个文件，
      // 工牌都再压一次只读交集——审查通道的「天然安全」不依赖用户配置。
      const base = findRole('reviewer') ?? builtinRole('reviewer')
      if (base === null) return { ok: false, reason: 'reviewer 角色定义不可用（内置角色缺失）' }
      const role: AgentRole = { ...base, tools: [...READONLY_TOOLS], approval: 'forbid' }
      const teammate = startTeammate({
        name: uniqueName('reviewer'),
        role,
        task: reviewMessage(request, request.focus),
        caller: { name: LEAD, depth: 0, background: true },
        background: true,
        seed: null,
        parentSession,
      })
      void waitForIdle(teammate).then(() => deliverReview(teammate))
      return { ok: true, name: teammate.name }
    }

    /** 审查收工：findings（或失败原因）写进发起会话，渲染层认 <review-findings> 标记出卡。 */
    const deliverReview = (teammate: Teammate): void => {
      const state = teammate.state === 'idle' ? '已完成' : teammate.state === 'stopped' ? '已停止' : '已失败'
      const body =
        teammate.state === 'failed'
          ? `审查没有完成：${teammate.error ?? '未知错误'}`
          : teammate.state === 'stopped'
            ? '审查被停止，没有交回结论。'
            : teammate.lastText === ''
              ? '审查没有留下文字结论。'
              : teammate.lastText
      const notice = `<review-findings teammate="${teammate.name}" state="${state}">\n${body}\n</review-findings>`
      const line = `审查队友 ${teammate.name}，${state}`
      teammate.parentSession.appendUser(notice)
      const live = ctx.session.current() === teammate.parentSession
      ctx.transcript.system(live ? `${line}，findings 已写进会话` : `${line}，findings 写入了派出它的会话`)
      ctx.transcript.touch()
    }

    const reviewService: ReviewService = { spawn: spawnReviewer }
    ctx.provide('review', reviewService)

    // ── 模型侧工具 ──────────────────────────────────────────────────────────
    function uniqueName(role: string): string {
      // 收工队友的名字也占着（名册里），不然两次启动会撞名
      const remembered = new Set(readRoster().map((entry) => entry.name))
      for (let index = 1; index < 100; index += 1) {
        const candidate = `${role}-${index}`
        if (!teammates.has(candidate) && !remembered.has(candidate)) return candidate
      }
      return `${role}-${Date.now()}`
    }

    /**
     * `subagent` 的 interrupt/stop 与界面管理通道（TeamService.stop）共用的那一条。
     * 两条路的话术刻意保持一字不差：模型与用户看到的是同一件事。
     */
    function stopTeammate(name: string, mode: 'interrupt' | 'stop'): string {
      const teammate = teammates.get(name)
      if (teammate === undefined) return `没有叫 ${name} 的队友（subagent list 看现役名单）`
      teammate.agent.cancel()
      if (mode === 'stop') teammates.delete(name)
      return `${name} ${mode === 'interrupt' ? '这一轮被打断了（信箱里的话还在，可以再传话叫醒它）' : '被收掉了'}`
    }

    /**
     * `subagent` 的 message 与界面传话通道（TeamService.message）共用的那一条。
     * @param from - 署名：模型派话是派它的那一方，用户传话是 'user'。
     */
    function messageTeammate(name: string, text: string, from: string): string {
      const trimmed = text.trim()
      if (trimmed === '') return 'message 要带上 text（想传的话）'
      const teammate = teammates.get(name)
      const wrapped = `<message from="${from}"> ${trimmed} </message>`
      inboxAppend(name === '' ? 'unknown' : name, wrapped)
      if (teammate === undefined) return `没有叫 ${name} 的队友，话写进了它的信箱（${join(ctx.settings.about().home, 'team', 'inbox')}）但没人会读`
      teammate.agent.followup(wrapped)
      return `话已投给 ${name}${teammate.state === 'working' ? '（它正在干，会在这轮结束后看到）' : '（已把它叫醒）'}`
    }

    async function runSubagent(
      args: Record<string, unknown>,
      runCtx: { cwd: string; signal: AbortSignal },
      caller: Caller,
    ): Promise<string> {
      const action = String(args.action ?? '')
      const roster = listRoles()
      // 名单按会话隔离（对照 dsh 的 parentSession 过滤）：本会话只能看见自己派出的队友，
      // 别的会话的在队名单不外漏；跨会话管理请回到派出它的那个会话。
      const currentId = ctx.session.current().meta.id
      const mine = [...teammates.values()].filter((entry) => entry.parentSession.meta.id === currentId)
      if (action === 'list') {
        const lines = mine.map(
          (entry) =>
            `- ${entry.name}（角色 ${entry.role}，${entry.state}，第 ${entry.rounds} 轮，${entry.toolCalls} 次工具调用）派给它的任务：${entry.task.slice(0, 60)}`,
        )
        const roles = roster.map((role) => `- ${role.name}${role.enabled ? '' : '（已停用）'}：${role.description || '（没写 description）'}`).join('\n')
        return lines.length === 0
          ? `本会话没有在队或收工的队友。\n\n可用角色：\n${roles}`
          : `本会话在队/收工的队友：\n${lines.join('\n')}\n\n可用角色：\n${roles}`
      }
      if (action === 'interrupt' || action === 'stop') {
        return stopTeammate(String(args.name ?? ''), action)
      }
      if (action === 'message') {
        return messageTeammate(String(args.name ?? ''), String(args.text ?? ''), caller.name)
      }
      if (action !== 'spawn') {
        return `不认识的 action「${action}」。要用的值：spawn / list / message / interrupt / stop`
      }

      if (caller.depth >= config.maxDepth) {
        return `你在第 ${caller.depth} 层，设置只允许到 ${config.maxDepth} 层，不能再往下派队友（要放开去设置「子智能体」调「允许层数」）`
      }
      const roleName = String(args.role ?? '').trim()
      const role = findRole(roleName)
      if (role === null) {
        const available = roster.filter((entry) => entry.enabled).map((entry) => entry.name)
        return `角色 ${roleName || '（没填）'} 不可用。可用角色：${available.join('、') || '（无，去 ' + DSC_AGENTS_DIR + ' 建一个）'}${roster.some((entry) => entry.name === roleName && !entry.enabled) ? `；${roleName} 存在但被停用了，在设置「子智能体」里打开` : ''}`
      }
      const task = String(args.task ?? '').trim()
      if (task.length < 8) return '任务描述太短：队友看不到你和用户的对话，请把背景、目标、交付格式写清楚'
      const working = busyFor(currentId)
      if (working.length >= config.maxTeammates) {
        return `本会话正在干活的队友已到上限 ${config.maxTeammates} 个（${working.map((entry) => entry.name).join('、')}）。等一个收工，或去设置「子智能体」里提高上限`
      }
      // 收工的队友留着可以被追问，但攒太多就把最老的挤出名单（磁盘上的运行记录不动）
      const finished = [...teammates.values()].filter((entry) => entry.state !== 'working')
      if (finished.length > MAX_LISTED_FINISHED) {
        for (const entry of finished
          .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt))
          .slice(0, finished.length - MAX_LISTED_FINISHED)) {
          teammates.delete(entry.name)
        }
      }
      const requested = String(args.name ?? '').trim()
      if (requested !== '' && !NAME_OK.test(requested)) {
        return `队友名「${requested}」不合法：只能用小写字母、数字、连字符`
      }
      const name = requested === '' ? uniqueName(role.name) : requested
      if (teammates.has(name)) return `队友名 ${name} 已经在用，换一个`

      const context = String(args.context ?? 'fresh')
      let seed: string[] | null = null
      if (context === 'fork') {
        const parent = ctx.session.current()
        seed = parent.persisted ? forkSeedLines(parent.filePath) : null
        if (seed === null) {
          return `带不上父会话的内容：这个会话还没有一个完整回合（它得先完整回答过一次），改用 context="fresh" 把背景写进任务描述`
        }
      } else if (context !== 'fresh') {
        return `不认识的 context「${context}」。要用的值：fresh / fork`
      }

      const background = args.background === true || args.background === 'true'
      const teammate = startTeammate({
        name,
        role,
        task,
        caller,
        background,
        seed,
        parentSession: ctx.session.current(),
      })

      if (!background) {
        // 用户取消这一轮就等于把队友也停下：先挂监听，再等它空下来
        const onStop = (): void => teammate.agent.cancel()
        runCtx.signal.addEventListener('abort', onStop, { once: true })
        await waitForIdle(teammate)
        runCtx.signal.removeEventListener('abort', onStop)
        const head = `${teammate.name}（${teammate.role}）${teammate.state === 'idle' ? '干完了' : teammate.state === 'stopped' ? '被打断' : '失败'}：第 ${teammate.rounds} 轮、${teammate.toolCalls} 次工具调用。运行记录：${teammate.session.filePath}`
        return teammate.lastText === '' && teammate.state !== 'idle'
          ? `${head}\n${teammate.error ?? '它没留下文字结论'}`
          : `${head}\n\n${teammate.lastText === '' ? '（它没留下文字结论）' : teammate.lastText}`
      }

      void waitForIdle(teammate).then(() => reportHome(teammate))
      return `已派给 ${teammate.name}（角色 ${teammate.role}，${teammate.badge.tools === null ? '不限工具' : `工具 ${teammate.badge.tools.join('、')}`}）。它在后台干，不用等也不用问：干完我会把汇报接进来。你现在可以继续做别的，或者再派一个。`
    }

    const subagentTool = (): ToolEntry => ({
      name: 'subagent',
      description:
        '把一件可以独立完成的活派给一个有明确授权的队友（角色见 ~/.dsc/agents），或者给在队队友传话、打断它。' +
        'background=true 时立刻返回，它干完后汇报会自己接进你的下一轮；background=false 时你这一轮会等它的结果。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['spawn', 'list', 'message', 'interrupt', 'stop'], description: '要做什么' },
          role: { type: 'string', description: 'spawn 必填：角色名，例如 explorer / writer / critic' },
          task: { type: 'string', description: 'spawn 必填：交给它的活。队友看不到你和用户的对话，把背景、目标、交付格式写全' },
          name: { type: 'string', description: '队友名；不填自动生成「角色名-序号」。message/interrupt/stop 用它指定对象' },
          context: { type: 'string', enum: ['fresh', 'fork'], description: 'fresh = 只知道这条任务；fork = 额外带上父会话到上一个完整回合为止的内容' },
          background: { type: 'boolean', description: 'true = 后台干（推荐，可并行多个）；false = 这一轮等它结果' },
          text: { type: 'string', description: 'message 必填：要传的话' },
        },
        required: ['action'],
      },
      risk: 'read',
      run: (args, runCtx) => runSubagent(args, runCtx, { name: LEAD, depth: 0, background: false }),
    })

    /** 委派开关注释：关掉时工具和名册提示一起撤下，模型看不到子智能体这件事。 */
    let disposers: Array<() => void> = []
    const syncTools = (): void => {
      for (const off of disposers) off()
      disposers = []
      if (!config.allowDelegation) return
      disposers.push(ctx.tools.register(subagentTool()))
      disposers.push(
        ctx.prompt.register('subagent', () => {
          const roles = listRoles().filter((role) => role.enabled)
          const lines = roles.map((role) => {
            const tools = role.tools === null ? '不限工具' : role.tools.length === 0 ? '不带工具' : role.tools.join('/')
            return `- ${role.name}：${role.description || '（没写 description）'}（${tools}，最多 ${role.maxTurns} 轮）`
          })
          return `# 子智能体
你可以用 subagent 工具把能独立完成的活派给队友。
可用角色（文件在 ${DSC_AGENTS_DIR}，用户可以自己加）：
${lines.join('\n') || '- （没有启用中的角色，先在设置「子智能体」里打开或新建）'}

派活的规矩：
1. 队友看不到你和用户的对话（context="fork" 只能带到上一个完整回合为止），所以任务描述里必须写清背景、目标、交付格式。
2. 本会话同时干活上限 ${config.maxTeammates} 个（收工的不占额度）。后台队友干完后汇报会自己接进你的下一轮，不要反复去问它好了没。
3. 只读角色改不了文件；要落地代码用 writer 或者你自己动手。
4. 派完活自己接着干别的，别闲着等。`
        }),
      )
    }
    syncTools()

    // ── 设置分区 ────────────────────────────────────────────────────────────
    const fields = (): SettingsField[] => [
      {
        type: 'switch',
        key: 'allowDelegation',
        label: '允许模型自主分派任务给队友',
        help: '关闭后 subagent 工具连同提示词一并撤下，运行中的队友会被停止。',
      },
      { type: 'number', key: 'maxTeammates', label: '并行数量', min: 1, max: 8, step: 1, help: '每个会话各自的同时干活上限；已完成的队友不占额度，满了再派会被直接拒绝，不排队。' },
      { type: 'number', key: 'maxDepth', label: '递归层级', min: 0, max: 2, step: 1, help: '0 = 仅主会话可派队友，Lead 不可再下派；1 = Lead 可派队友，队友不可再下派。' },
      {
        type: 'select',
        key: 'approval',
        label: '队友是否可以请求授权',
        options: [
          { value: 'forbid', label: '不允许，需要授权的操作直接失败并写入汇报' },
          { value: 'foreground', label: '仅前台队友，即正在等待结果的队友' },
          { value: 'ask', label: '允许，审批卡片标明请求的队友' },
        ],
        help: '此为上限：角色文件中声明的 approval 只会更严，不会更松。',
      },
      {
        type: 'select',
        key: 'notify',
        label: '后台队友完成后的汇报方式',
        options: [
          { value: 'auto', label: '汇报自动并入 Lead 的下一轮' },
          { value: 'quiet', label: '仅写入会话，下次对话时模型可见' },
        ],
      },
      { type: 'text', key: 'defaultModel', label: '队友默认模型', placeholder: '留空 = 跟随当前模型；形如 deepseek/deepseek-chat', help: '角色文件里写了 model 的角色用它自己的。' },
      { type: 'info', label: '角色目录', text: DSC_AGENTS_DIR, mono: true, copyable: true, help: `内置角色：${builtinRoleNames().join('、')}。修改文件仅影响之后创建的队友。` },
      { type: 'button', action: 'new-role', label: '新建示例角色', style: 'ghost', help: '在角色目录创建 starter.md 供参考修改。' },
    ]

    const section: SettingsSectionSpec = {
      id: 'subagent',
      title: '子智能体',
      subtitle: '设置子智能体的递归层级、数量和模型',
      order: 40,
      fields,
      values: (): Record<string, SettingsValue> => ({
        allowDelegation: config.allowDelegation,
        maxTeammates: config.maxTeammates,
        maxDepth: config.maxDepth,
        approval: config.approval,
        notify: config.notify,
        defaultModel: config.defaultModel,
      }),
      // 契约：save 返回字符串 = 失败原因；action 返回字符串 = 完成后的提示文案，失败直接抛
      save: (key, value): string | void => {
        switch (key) {
          case 'allowDelegation':
            applyConfig({ allowDelegation: value === true || value === 'true' })
            break
          case 'maxTeammates':
            applyConfig({ maxTeammates: Number(value) })
            break
          case 'maxDepth':
            applyConfig({ maxDepth: Number(value) })
            break
          case 'approval': {
            const next = String(value) as TeammateApproval
            if (next !== 'forbid' && next !== 'ask' && next !== 'foreground') {
              return `不认识的值 ${String(value)}`
            }
            applyConfig({ approval: next })
            break
          }
          case 'notify':
            applyConfig({ notify: String(value) === 'quiet' ? 'quiet' : 'auto' })
            break
          case 'defaultModel': {
            const text = String(value).trim()
            if (text !== '' && !text.includes('/')) {
              return '要写成「端点名/模型名」，例如 deepseek/deepseek-chat；留空表示跟随当前模型'
            }
            applyConfig({ defaultModel: text })
            break
          }
          default:
            return `这个分区没有这项：${key}`
        }
        // 开关会影响工具与名册提示在不在场，改完立刻重挂一次
        syncTools()
      },
      action: (name): string => {
        if (name === 'new-role') {
          const file = writeRole('starter', {
            description: '我在这个角色里干什么（一句话，模型据此决定要不要派它）',
            prompt: '把这一段改成这个角色的职责与做事步骤。它是模型看到的唯一说明书。',
          })
          return `已写好 ${file}，改完保存就能被派活`
        }
        throw new Error(`这个分区没有这个按钮：${name}`)
      },
    }
    const offSection = ctx.settings.registerSection(section)

    // ── 卸载 ────────────────────────────────────────────────────────────────
    return () => {
      offSection()
      for (const off of disposers) off()
      disposers = []
      for (const teammate of teammates.values()) teammate.agent.cancel()
      for (const teammate of teammates.values()) teammate.session.close()
      teammates.clear()
    }
  },
}
