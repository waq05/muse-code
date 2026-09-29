/**
 * self-improve 插件：自我改进闭环。**默认关**（默认关的理由是它会写技能文件与提示词面）。
 *
 * 形制照 hermes（回合后复盘 + `skill_manage` + curator 老化 + `read-before-write` +
 * ledger 回滚 + 写入审批门）加 codex（记忆产物的硬格式约束 + 命中计数 + 只归档不删除）。
 *
 * 三条闭环（先立写入门，再谈自写——dsc 的技能原本只读，这是最大的缺口）：
 *   L1 纠正捕获（零模型调用）：`dsc/turn-end` 的 reason 不是 completed 时，或本轮用户原话带
 *      纠正语气（中英关键词表）→ 落 `~/.dsc/learnings/<workspaceKey>/candidates.jsonl`；
 *      `reason === 'error'` 另外记一条 `failure`。**候选正文绝不进系统提示**（外部文本会跟着
 *      用户原话一起被记下来，拼进提示等于给外部文本开一条进提示词的路），只有用户
 *      `/learnings promote <id>` 才生效。
 *   L2 复盘产技能草稿：`turn-end` completed 且本轮工具迭代数 ≥ N（默认 12，对齐 hermes 的
 *      `_iters_since_skill >= _skill_nudge_interval`：按工具迭代数而不是用户轮数）
 *      → `ctx.agent.followup` 起一轮，模型只回一行 JSON，**由插件自己**校验并落盘
 *      `~/.dsc/skills/<name>/SKILL.md`（frontmatter 带 `created_by: agent`、
 *      description ≤60 字符），同时把名字写进 `~/.dsc/skills.json` 的 disabled → **默认停用**。
 *   L3 技能自修 + 审计回滚：`skill_write` 工具（create/patch/write_file/archive，risk='write'），
 *      **强制 read-before-write**、改前 `.bak.<时间戳>` 备份、每次变更 append
 *      `~/.dsc/skills/.ledger.jsonl`（前后 hash），`/skills-ledger rollback <id>` 可回滚；
 *      `archive` 只移进 `.archive/` **永不删**。
 *
 * 红线：新建/改写技能走 `ctx.approval.decide`（设置里可关）；**本插件自己发起的那一轮
 * （复盘轮，模型在那一轮里调 `skill_write` 一律拒）与定时任务、子智能体发起的写直接拒**。
 * 判据只有三个能拿到的事实：会话状态里的 `pluginInitiated` 标记、会话文件在不在
 * `.teammates/` 下、投递文本是不是定时任务的（见 {@link SCHEDULED_MARK}）。**判不出来时
 * 退回「要走审批」这一侧**——那同样是拒绝的一种（没人回答就是拒），宁可多问一次；
 * 老化 active → stale（14 天未命中）→ archived（30 天），pin 挡住自动改写与自动归档，
 * 自动归档只动 `created_by: agent` 的技能；写入后安全扫描不过就还原；
 * 绝不改 `AGENTS.md`（dsc 已把它列为必须当面确认，本插件只写 `~/.dsc/skills/` 与 `~/.dsc/learnings/`）。
 *
 * 系统提示那一段（order 43）只报「有几条待审候选」「技能写入要不要审批」这类当前事实，
 * **候选正文绝不拼进提示词**——候选里存的常常是用户原话，而用户原话可能夹着从网页粘进来的
 * 外部文本，拼进去等于给外部文本开一条进模型上下文的直通车。
 *
 * 支撑模块（本插件独占）：`src/core/learnings/{store,ledger,skill-write}.ts`
 *
 * @module dsc/plugins/self-improve
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import { argsSummary } from '../core/tools.js'
import type { ToolEntry } from '../core/tools.js'
import type { ChatMessage } from '../core/llm.js'
import type { SettingsField, SettingsValues } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'
import { formatLedgerEntry, ledgerFile, ledgerSize, readLedger, rollbackEntry } from '../core/learnings/ledger.js'
import {
  candidatesFile,
  DEFAULT_STORE_OPTIONS,
  formatCandidate,
  learningsRoot,
  normalizeLearningsState,
  readCandidates,
  recordCandidate,
  setCandidateState,
  type LearningCandidate,
  type LearningKind,
  type LearningStoreOptions,
  type LearningsState,
} from '../core/learnings/store.js'
import {
  archiveRoot,
  archivedCount,
  bumpSkillUse,
  createSkill,
  curateSkills,
  DEFAULT_AGING,
  DEFAULT_SKILL_LIMITS,
  isSkillPinned,
  lastAssistantText,
  lastUserText,
  localSkillNames,
  patchSkill,
  previousUserText,
  readBeforeWriteCheck,
  renderSkillMarkdown,
  setSkillPinned,
  skillFileOf,
  skillNamesReadInMessages,
  skillsRoot,
  toolIterationsOfTurn,
  userTurnIndex,
  usageFile,
  validateSkillDraft,
  writeSkillFile,
  archiveSkill as archiveSkillOp,
  type SkillDraft,
  type SkillOpResult,
} from '../core/learnings/skill-write.js'
import { existsSync } from 'node:fs'

/** 配置键（`~/.dsc/plugins.json` 里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'self-improve'

/** 本插件写盘的两处根（自检与设置页显示用）。 */
const TARGET_ROOTS = (): string => `${learningsRoot()} 与 ${skillsRoot()}`

/** 可调配置。 */
interface SelfImproveConfig {
  /** 总开关：关掉之后三条闭环与两个工具全不干活。 */
  enabled: boolean
  /** 复盘触发的工具迭代数下限；0 = 不自动复盘。 */
  reviewMinIterations: number
  /** 技能写入是否要用户点头。 */
  requireApproval: boolean
  /** 候选保留天数。 */
  retentionDays: number
  /** 候选条数上限。 */
  maxCandidates: number
}

const DEFAULT_CONFIG: SelfImproveConfig = {
  enabled: true,
  reviewMinIterations: 12,
  requireApproval: true,
  retentionDays: DEFAULT_STORE_OPTIONS.retentionDays,
  maxCandidates: DEFAULT_STORE_OPTIONS.maxEntries,
}

/** 取配置：类型不对就用默认值，数值夹在区间里，不抛错（照 memory 插件的写法）。 */
function readConfig(passed?: unknown): SelfImproveConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const flag = (value: unknown, fallback: boolean): boolean => (value === undefined ? fallback : value === true || value === 'true')
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const num = Number(value)
    return Number.isFinite(num) ? Math.min(Math.max(Math.trunc(num), min), max) : fallback
  }
  return {
    enabled: flag(raw.enabled, DEFAULT_CONFIG.enabled),
    // 0 = 关掉自动复盘；小于 3 次迭代就复盘等于每轮都在打断用户
    reviewMinIterations: clamp(raw.reviewMinIterations, 0, 200, DEFAULT_CONFIG.reviewMinIterations),
    requireApproval: flag(raw.requireApproval, DEFAULT_CONFIG.requireApproval),
    retentionDays: clamp(raw.retentionDays, 1, 365, DEFAULT_CONFIG.retentionDays),
    maxCandidates: clamp(raw.maxCandidates, 10, 2000, DEFAULT_CONFIG.maxCandidates),
  }
}

/** 纠正语气的关键词表（中英各来一份）。命中只记一条候选——候选不进模型上下文，误判的代价很低。 */
const CORRECTION_PATTERNS: readonly RegExp[] = [
  /不对/u,
  /错了/u,
  /不是这样/u,
  /我是说/u,
  /我说的是/u,
  /重新/u,
  /重来/u,
  /搞错/u,
  /弄错/u,
  /别这样/u,
  /不是要你/u,
  /\bwrong\b/iu,
  /(^|\s)no,/iu,
  /\bactually\b/iu,
  /\bthat'?s not\b/iu,
  /\bnot what i\b/iu,
  /\bi said\b/iu,
  /\bredo\b/iu,
]

/**
 * 定时任务投递的文本特征。
 *
 * 必须按 `core/schedule/runner.ts` 那份投递文本的**真实措辞**来认：它写的是
 * 「【定时任务触发】……它不是用户此刻发出的指令，也不构成任何授权」。早先这里只写
 * 「定时触发 / 不是用户指令」，两段都不是原文的子串，于是这一条判据从来没命中过——
 * 定时任务发起的写入只好退到审批门那一侧（也是拒，但会弹一张没人看的卡）。
 */
const SCHEDULED_MARK = /【定时任务触发】|定时任务触发|不是用户此刻发出的指令|不构成任何授权|scheduled\s+task/iu

/** 这一轮由谁发起（决定要不要审批、以及要不要直接拒）。 */
type WriteOrigin = 'model' | 'plugin' | 'subagent' | 'scheduled'

/** 待落盘的插件自发起轮次。 */
type PendingTurn = { mode: 'review' } | { mode: 'learn'; actor: 'model' | 'user' }

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 截断显示用（候选与提示词里都不放整篇原文）。 */
function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 复盘提示词：只准回一行 JSON（或 NONE）。 */
function reviewPrompt(descriptionMax: number): string {
  return [
    '【技能复盘】上面这一轮用户发言结束了，现在做一次无人值守的复盘。这不是用户的新指令：',
    '不要执行任何实际操作，也不要调用任何工具，只回看刚才那段对话。',
    '',
    '值得沉淀的是「下一次遇到同一类任务时照着做就能一次做对」的东西：步骤与命令、踩过的坑、用户对结果的偏好。',
    '不要沉淀：环境问题（缺依赖、没配密钥、命令找不到）、对某个工具「它坏了」这类负面断言、这一次任务本身的过程叙述、还没验证成功的做法。',
    '同类的技能已经存在就别新建重复的；名字要能代表一类任务（例如 git-workflow），不要用今天这件事的编号或报错原文。',
    '',
    `只准输出一行 JSON，不要代码块、不要解释：{"name":"kebab-case 名字","description":"一句话，不超过 ${String(descriptionMax)} 个字符","whenToUse":"什么情况下用","content":"SKILL.md 正文，Markdown，不要写 frontmatter"}`,
    '没有值得沉淀的就只输出一行：NONE',
  ].join('\n')
}

/** `/learn` 与「把候选转成技能」用的沉淀提示词。 */
function authorPrompt(goal: string, candidateText: string, descriptionMax: number): string {
  const subject = goal === '' && candidateText === '' ? '把刚才这段对话里做成的那件事' : goal !== '' ? goal : candidateText
  return [
    '【沉淀技能】请把下面这件事沉淀成一份可复用的技能。这不是要你现在动手做那件事，只回一份技能草稿。',
    '',
    `要沉淀的内容：${subject}`,
    candidateText !== '' && goal !== '' ? `\n候选清单里记下的原话：${candidateText}` : '',
    '',
    '要求：写「下一次照着做就能一次做对」的步骤与命令、踩过的坑、用户对结果的偏好；不要写这次任务的流水账，不要写环境问题，不要写还没验证成功的做法。',
    '',
    `只准输出一行 JSON，不要代码块、不要解释：{"name":"kebab-case 名字","description":"一句话，不超过 ${String(descriptionMax)} 个字符","whenToUse":"什么情况下用","content":"SKILL.md 正文，Markdown，不要写 frontmatter"}`,
  ].join('\n')
}

/** 复盘 / 沉淀那一轮的回答。 */
type DraftAnswer = { kind: 'none' } | { kind: 'invalid'; error: string } | { kind: 'draft'; draft: SkillDraft }

/**
 * 解析模型那一行 JSON。
 *
 * 模型有三种常见走法：规规矩矩一行 JSON、套在 ```json 代码块里、先说一句「好的」再给 JSON。
 * 三种都认（从最后一行往前找，取第一个能解析出四个字段的对象），但**只认第一个**——
 * 认第一个能避免把正文里引用的示例 JSON 当成结果。
 */
export function parseDraftAnswer(text: string, descriptionMax = DEFAULT_SKILL_LIMITS.descriptionMax): DraftAnswer {
  const stripped = text.replace(/```(?:json)?/gi, '').trim()
  if (stripped === '') return { kind: 'invalid', error: '这一轮没有输出任何内容' }
  const lines = stripped.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  const last = lines[lines.length - 1] ?? ''
  if (/^NONE\b/iu.test(last)) return { kind: 'none' }
  const candidates: string[] = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    if (line.startsWith('{')) candidates.push(line)
  }
  const head = stripped.indexOf('{')
  const tail = stripped.lastIndexOf('}')
  if (head >= 0 && tail > head) candidates.push(stripped.slice(head, tail + 1))
  for (const candidate of candidates) {
    let doc: unknown
    try {
      doc = JSON.parse(candidate)
    } catch {
      continue
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) continue
    const raw = doc as Record<string, unknown>
    const pick = (...keys: string[]): string => {
      for (const key of keys) {
        const value = raw[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
      return ''
    }
    const name = pick('name')
    const content = pick('content', 'body')
    if (name === '' || content === '') continue
    const draft: SkillDraft = {
      name,
      description: pick('description'),
      whenToUse: pick('whenToUse', 'when_to_use', 'when-to-use'),
      content,
    }
    const validated = validateSkillDraft(draft, { ...DEFAULT_SKILL_LIMITS, descriptionMax })
    if (!validated.ok) return { kind: 'invalid', error: validated.error }
    return { kind: 'draft', draft }
  }
  return { kind: 'invalid', error: '没找到形如 {"name":…,"description":…,"whenToUse":…,"content":…} 的一行 JSON' }
}

export const selfImprovePlugin: Plugin.Object = {
  name: 'self-improve',
  inject: ['tools', 'commands', 'settings', 'transcript', 'skills', 'approval', 'session', 'agent', 'prompt', 'memory'],
  apply(ctx, passed: unknown) {
    let config = readConfig(passed)
    /** 写盘并立刻重读：设置改完下一轮就用新值，不用重启宿主。 */
    const applyConfig = (patch: Record<string, unknown>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      config = readConfig()
    }
    const limits = DEFAULT_SKILL_LIMITS
    const storeOptions = (): Partial<LearningStoreOptions> => ({
      retentionDays: config.retentionDays,
      maxEntries: config.maxCandidates,
    })
    const cwd = (): string => ctx.session.current().meta.cwd
    const say = (text: string): void => {
      ctx.transcript.system(`[self-improve] ${text}`)
    }

    /** 所有注册的退订函数都攒在这里，apply 的 disposer 一次清干净。 */
    const disposers: (() => void)[] = []

    // ── 会话状态 ────────────────────────────────────────────────────────────────

    const stateOf = (): LearningsState => normalizeLearningsState(ctx.session.current().state('learnings'))
    const writeState = (patch: Partial<LearningsState>): LearningsState => {
      const next = { ...stateOf(), ...patch }
      try {
        ctx.session.current().appendState('learnings', next)
      } catch (error) {
        // 会话日志写不进去不致命：本轮照样跑，只是重启后认不出「这一轮是插件发起的」
        say(`会话状态没能记下来（${errText(error)}），重启后可能重复复盘一次`)
      }
      return next
    }

    /** 插件自己发起的那一轮：复盘或沉淀。 */
    let pending: PendingTurn | null = null

    /**
     * 审批用的中断信号。
     *
     * 工具那条路的审批信号来自 `scope.signal`（那一轮被取消就跟着取消）；但插件自己
     * followup 起来的那一轮没有工具作用域，所以在这里自备一个：插件被热卸载时打断它，
     * 别让一张再也等不到答案的审批卡把复盘轮挂在那里。
     */
    const pluginAbort = new AbortController()

    /** 本轮的轮次标识（会话 id 前 8 位 + 第几条用户消息）。 */
    function turnRefOf(messages: readonly ChatMessage[]): string {
      return `${ctx.session.current().meta.id.slice(0, 8)}#${String(userTurnIndex(messages) + 1)}`
    }

    // ── 发起方判定（红线：自动化发起的写直接拒）──────────────────────────────────

    /**
     * 这一轮是谁发起的。
     *
     * 判据只有三个能拿到的事实：会话状态里的 `pluginInitiated`（本插件自己 followup 起来的那一轮）、
     * 会话文件是不是落在 `.teammates/` 下（队友的运行记录）、最后一条用户消息是不是定时任务
     * 投递的（schedule 的投递文本带着「【定时任务触发】……不是用户此刻发出的指令」这句声明）。
     *
     * **子智能体这一支今天是兜底，不是主判据**：队友的每一轮跑在自己的 `Session` 上，而
     * `ctx.session.current()` 在队友干活时仍然指着主会话（队友没走会话服务切档），所以从
     * 这个函数里通常分辨不出「这次 skill_write 是队友调的」。好在那条路上照样有两道闸：
     * 队友自己的守卫链先要一次授权（审批卡上写着「队友 X（角色）· skill_write」），
     * 然后回到这里——判不出来就返回 `model`，于是**再走一次审批门**。
     *
     * **判不出来时返回 `model` 不是放行**，而是「按正常模型写入处理」：后面照样过审批门
     * （设置里默认开，没人回答就是拒），宁可多问一次也不默默放过。
     */
    function detectOrigin(): { origin: WriteOrigin; reason: string } {
      const session = ctx.session.current()
      if (stateOf().pluginInitiated) {
        return { origin: 'plugin', reason: '这一轮由自我改进插件自己发起（复盘/沉淀轮），写入交给插件自己落盘' }
      }
      const file = session.filePath.replace(/\\/g, '/')
      if (file.includes('/.teammates/')) {
        return { origin: 'subagent', reason: '这是子智能体的运行记录，自动化写入不许动技能库' }
      }
      if (SCHEDULED_MARK.test(lastUserText(session.messages))) {
        return { origin: 'scheduled', reason: '这一轮是定时任务投递的（没有人看着），写入一律拒' }
      }
      return { origin: 'model', reason: '' }
    }

    /** 审批门：拿不到答案一律按拒处理（宁严不松）。 */
    async function askSkillWrite(summary: string, args: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
      try {
        // 卡片上两段都写：前一段是人话（要动哪个技能、为什么），后一段是参数的机械摘要，
        // 用户想核对「到底写了什么」时不用去翻会话日志。
        const decision = await ctx.approval.decide(
          {
            toolName: 'skill_write',
            argsSummary: `${summary} · ${argsSummary(args)}`.slice(0, 160),
            args,
            cwd: cwd(),
          },
          signal,
        )
        return decision !== 'reject'
      } catch (error) {
        say(`审批没走通（${errText(error)}），这次写入按拒处理`)
        return false
      }
    }

    /** read-before-write 判定：本会话读过这个技能（或它就是本会话建的）才准动。 */
    function readConfirmedOf(name: string): { ok: boolean; error: string } {
      const state = stateOf()
      return readBeforeWriteCheck({
        readSkills: state.readSkills,
        createdSkills: state.createdSkills,
        messages: ctx.session.current().messages,
        name,
      })
    }

    /** 写成功的统一收尾：广播技能清单变化 + 记一条 system 反馈。 */
    function announce(result: SkillOpResult): void {
      if (!result.ok) {
        say(result.error)
        return
      }
      ctx.emit('dsc/skills-changed')
      say(result.notice)
    }

    // ── L1：纠正捕获（零模型调用）───────────────────────────────────────────────

    /** 本轮的 `skill` 工具读出来的技能名（命中计数与 read-before-write 的记账都靠它）。 */
    function turnReadSkillNames(messages: readonly ChatMessage[]): string[] {
      // 只把**本轮**那一段消息喂给 skillNamesReadInMessages：它会扫完整个数组，直接喂全量
      // 会把前几轮读过的技能每一次都再记一遍命中（计数虚高，老化判定跟着失真）。
      // 从最后一条 user 消息切到末尾就是本轮，切出来的那段里 assistant 的 tool_calls 正好是本轮的调用。
      let start = 0
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') {
          start = index
          break
        }
      }
      return skillNamesReadInMessages(messages.slice(start))
    }

    /** 记一条候选，回一句给用户看的话（候选本身绝不进模型上下文）。 */
    function capture(kind: LearningKind, text: string, turnRef: string): void {
      const result = recordCandidate(cwd(), { kind, text, turnRef }, storeOptions())
      if (result.error !== '') return
      if (result.deduped) say(`这条候选又出现了一次（命中 ${String(result.candidate?.hits ?? 0)}）：/learnings list`)
      else say(`记了一条候选（${kind}，不进口模型上下文）：/learnings list 看，promote 才会生效`)
    }

    /**
     * L1 主体：非正常结束的轮次，或本轮用户原话带纠正语气。
     *
     * 三种情况分开：
     *   - `error` → 一条 `failure`，原话一起存下来（复盘时要看得到用户当时在要什么）；
     *   - 用户原话命中纠正语气表 → 一条 `correction`，并把**上一轮**用户原话附在后面给复盘当背景；
     *   - `aborted` 且没带纠正语气 → 什么都不记。用户按 Esc 多半只是改主意，把它记成
     *     「失败」会把候选清单灌满噪音，真正该看的纠正反而被埋掉。
     *
     * 纠正语气这一支**不看 reason**：用户说过「不对，改成 pnpm」之后助手改对了、这一轮
     * `completed`，这条纠正照样是最值得沉淀的东西；只在非正常结束时才查会漏掉大多数纠正。
     */
    function captureCorrections(reason: 'completed' | 'aborted' | 'error'): void {
      const messages = ctx.session.current().messages
      const last = lastUserText(messages)
      const previous = previousUserText(messages)
      const turnRef = turnRefOf(messages)
      if (reason === 'error') {
        capture('failure', `上一轮以 error 结束，用户原话：${last === '' ? '（没有用户消息）' : clip(last, 240)}`, turnRef)
      }
      if (last !== '' && CORRECTION_PATTERNS.some((pattern) => pattern.test(last))) {
        const background = previous === '' ? '' : `（上一轮用户说的是：${clip(previous, 160)}）`
        capture('correction', `用户纠正：${clip(last, 360)}${background}`, turnRef)
      }
    }

    // ── L2：复盘产技能草稿 ─────────────────────────────────────────────────────

    /** 落一份技能草稿：校验 → 审批门（模型发起时）→ 落盘；任何一步不过就存回候选清单，不丢东西。 */
    async function landDraft(draft: SkillDraft, actor: 'model' | 'user'): Promise<string> {
      const turnRef = turnRefOf(ctx.session.current().messages)
      const keepAsCandidate = (why: string): string => {
        const saved = recordCandidate(cwd(), { kind: 'skill-draft', text: JSON.stringify(draft), turnRef }, storeOptions())
        return `${why}。草稿已经存进候选清单（${saved.candidate === null ? '但没存成' : `/learnings promote ${saved.candidate.id}`} 可以再拿出来落盘）`
      }
      const validated = validateSkillDraft(draft, limits)
      if (!validated.ok) return keepAsCandidate(`这份草稿过不了硬校验：${validated.error}`)
      if (actor === 'model' && config.requireApproval) {
        const approved = await askSkillWrite(
          `新建技能 ${draft.name}：${clip(draft.description, 60)}`,
          { action: 'create', name: draft.name, description: draft.description, whenToUse: draft.whenToUse, content: draft.content },
          pluginAbort.signal,
        )
        if (!approved) return keepAsCandidate('用户没有批这次技能写入')
      }
      const result = createSkill({ name: draft.name, markdown: renderSkillMarkdown(draft), actor, limits })
      if (!result.ok) return keepAsCandidate(`技能没落盘：${result.error}`)
      // createSkill 已经把名字写进停用名单；这里再经技能服务停用一次，让技能清单缓存当场刷新
      // （技能服务自己会 emit dsc/skills-changed，下面那次是给别的监听方兜底）。
      const disabled = ctx.skills.setEnabled(draft.name, false)
      if (!disabled.ok) {
        say(`技能 ${draft.name} 的停用状态没能刷新（${disabled.error}）：请到 /skills 里确认它没进模型可见目录`)
      }
      ctx.emit('dsc/skills-changed')
      writeState({ createdSkills: [...new Set([...stateOf().createdSkills, draft.name])] })
      return result.notice
    }

    /** 复盘轮结束：读它最后那条 assistant 消息，就是那一行 JSON。 */
    function finishReview(reason: 'completed' | 'aborted' | 'error'): void {
      if (reason !== 'completed') {
        say(`复盘轮以 ${reason} 结束，这次不落技能`)
        return
      }
      const answer = parseDraftAnswer(lastAssistantText(ctx.session.current().messages), limits.descriptionMax)
      if (answer.kind === 'none') {
        say('复盘看过了：这一轮没有值得沉淀的技能')
        return
      }
      if (answer.kind === 'invalid') {
        say(`复盘输出没法解析成技能草稿（${answer.error}），这次不落盘`)
        return
      }
      void landDraft(answer.draft, 'model').then((message) => {
        say(message)
      })
    }

    /** 沉淀轮结束（`/learn` 与「把候选转成技能」共用）。 */
    function finishLearn(reason: 'completed' | 'aborted' | 'error', actor: 'model' | 'user'): void {
      if (reason !== 'completed') {
        say(`沉淀轮以 ${reason} 结束，这次不落技能`)
        return
      }
      const answer = parseDraftAnswer(lastAssistantText(ctx.session.current().messages), limits.descriptionMax)
      if (answer.kind === 'none') {
        say('这一轮没沉淀出技能')
        return
      }
      if (answer.kind === 'invalid') {
        say(`输出没法解析成技能草稿（${answer.error}）`)
        return
      }
      void landDraft(answer.draft, actor).then((message) => {
        say(message)
      })
    }

    /** 起一轮插件自发起的轮次（复盘 / 沉淀）：先写状态再投递，崩在中间也不会重复发起。 */
    function startPluginTurn(prompt: string, what: PendingTurn): string {
      writeState({ pluginInitiated: true })
      pending = what
      try {
        ctx.agent.followup(prompt)
      } catch (error) {
        pending = null
        writeState({ pluginInitiated: false })
        return `${what.mode === 'review' ? '复盘' : '沉淀'}没能启动：${errText(error)}`
      }
      return what.mode === 'review'
        ? `已起一轮技能复盘（本轮工具迭代够多）：有值得沉淀的会写成技能草稿，默认停用`
        : '已起一轮技能沉淀：模型只回一行 JSON，由插件校验后落盘'
    }

    /** 本轮工具迭代数够不够触发复盘。 */
    function maybeReview(): void {
      if (!config.enabled || config.reviewMinIterations <= 0) return
      const session = ctx.session.current()
      const messages = session.messages
      const state = stateOf()
      const turnIndex = userTurnIndex(messages)
      if (turnIndex < 0 || turnIndex <= state.lastReviewedTurn) return
      const iterations = toolIterationsOfTurn(messages)
      if (iterations < config.reviewMinIterations) return
      // 先把「这一轮复盘过了」写进会话状态：崩在中间也只丢这一次复盘，不会每次重启都重来
      writeState({ lastReviewedTurn: turnIndex })
      const message = startPluginTurn(reviewPrompt(limits.descriptionMax), { mode: 'review' })
      say(message)
    }

    // ── 一轮结束的总入口 ───────────────────────────────────────────────────────

    function handleTurnEnd(reason: 'completed' | 'aborted' | 'error'): void {
      const state = stateOf()
      if (state.pluginInitiated) {
        // 这一轮是插件自己发起的：先摘标记，再按它是什么轮次收尾（不做 L1/L2，避免自己复盘自己）
        const current = pending
        pending = null
        writeState({ pluginInitiated: false })
        if (current === null) return
        if (current.mode === 'review') finishReview(reason)
        else finishLearn(reason, current.actor)
        return
      }
      if (!config.enabled) return
      const messages = ctx.session.current().messages
      const read = turnReadSkillNames(messages)
      if (read.length > 0) {
        for (const name of read) bumpSkillUse(name)
        writeState({ readSkills: [...new Set([...stateOf().readSkills, ...read])] })
      }
      captureCorrections(reason)
      if (reason === 'completed') maybeReview()
    }

    disposers.push(ctx.on('dsc/turn-end', (reason) => { handleTurnEnd(reason) }))

    // ── L3：skill_write 工具 ───────────────────────────────────────────────────

    const skillWriteTool: ToolEntry = {
      name: 'skill_write',
      description: [
        '改技能库：新建、改一处、加附属文件、归档。',
        '改之前必须在本会话里用 skill 工具读过那个技能（read-before-write，没读过会被拒）；新建不需要先读。',
        'action：create（name + content，content 是完整 SKILL.md，第一行必须是 --- 开头的 frontmatter，含 name/description/whenToUse）；',
        'patch（name + old_string + new_string，片段要在 SKILL.md 里唯一命中）；',
        'write_file（name + file_path + file_content，file_path 必须在 references/ templates/ scripts/ assets/ 之下）；',
        'archive（name，整目录搬进 ~/.dsc/skills/.archive/，只搬不删）。',
        `硬校验：description 不超过 ${String(limits.descriptionMax)} 个字符（超了直接拒，不截断——技能目录只显示前 ${String(limits.descriptionMax)} 个字符，砍掉就再也不会被选中）、正文不能空、整份不超过 ${String(limits.bodyMax)} 字符。`,
        '新建的技能默认停用，用户在 /skills 里启用后才进模型可见目录；每次变更都记进 ~/.dsc/skills/.ledger.jsonl，用户可以用 /skills-ledger rollback <id> 回滚。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'create | patch | write_file | archive' },
          name: { type: 'string', description: '技能名（kebab-case，例如 git-workflow）' },
          content: { type: 'string', description: 'create：完整 SKILL.md 全文（含 frontmatter）' },
          description: { type: 'string', description: 'create：一句话说明（≤60 字符），配合 body 使用时由插件拼 frontmatter' },
          when_to_use: { type: 'string', description: 'create：什么情况下用这个技能' },
          body: { type: 'string', description: 'create：只给正文（Markdown），frontmatter 由插件拼' },
          old_string: { type: 'string', description: 'patch：要替换的原片段' },
          new_string: { type: 'string', description: 'patch：替换成什么（空串表示删掉这段）' },
          replace_all: { type: 'boolean', description: 'patch：片段命中多处时是否全部替换（默认 false，命中多处会拒）' },
          file_path: { type: 'string', description: 'write_file：相对技能目录的路径，例如 references/example.md' },
          file_content: { type: 'string', description: 'write_file：附属文件全文' },
        },
        required: ['action', 'name'],
      },
      risk: 'write',
      async run(args, scope) {
        if (!config.enabled) return '自我改进现在是关着的（设置 → 插件 → 自我改进 里可以打开）。'
        const action = String(args.action ?? '').trim()
        const name = String(args.name ?? '').trim()
        if (!['create', 'patch', 'write_file', 'archive'].includes(action)) {
          return 'action 只能是 create / patch / write_file / archive'
        }
        if (name === '') return '缺少 name（kebab-case 技能名）'
        const origin = detectOrigin()
        if (origin.origin !== 'model') {
          return `这次写入被拒：${origin.reason}。技能库只接受用户会话里发起的写入（或者由插件自己在复盘后落盘）。`
        }
        if (action !== 'create') {
          // 钉住的技能挡住一切自动改写；用户要先 /skills-ledger unpin <名字>
          if (isSkillPinned(name)) {
            return `技能 ${name} 被钉住了（pinned）：钉住是「不许自动化动它」的意思，先让用户 /skills-ledger unpin ${name} 再改。`
          }
          const readOk = readConfirmedOf(name)
          if (!readOk.ok) return `${readOk.error}（read-before-write：本会话没读过的技能不许改）`
        }
        if (config.requireApproval) {
          const summary = `${action} ${name}：${clip(String(args.description ?? args.old_string ?? args.file_path ?? ''), 60)}`
          const approved = await askSkillWrite(summary, args, scope.signal)
          if (!approved) return `用户没有批这次技能写入（${action} ${name}）。要改的话请用户当面同意，或者把理由说清楚再来一次。`
        }
        if (action === 'create') {
          const content = typeof args.content === 'string' && args.content.trim() !== '' ? args.content : ''
          const body = typeof args.body === 'string' ? args.body : ''
          if (content === '' && body === '') {
            return 'create 要给 content（完整 SKILL.md），或者给 body + description + when_to_use 由插件拼 frontmatter'
          }
          const markdown =
            content !== ''
              ? content
              : renderSkillMarkdown({
                  name,
                  description: String(args.description ?? '').trim(),
                  whenToUse: String(args.when_to_use ?? '').trim(),
                  content: body,
                })
          const result = createSkill({ name, markdown, actor: 'model', limits })
          if (result.ok) writeState({ createdSkills: [...new Set([...stateOf().createdSkills, name])] })
          announce(result)
          return result.ok ? result.notice : result.error
        }
        if (action === 'patch') {
          const result = patchSkill({
            name,
            oldString: typeof args.old_string === 'string' ? args.old_string : '',
            newString: typeof args.new_string === 'string' ? args.new_string : '',
            actor: 'model',
            limits,
            replaceAll: args.replace_all === true,
            readConfirmed: true,
          })
          announce(result)
          return result.ok ? result.notice : result.error
        }
        if (action === 'write_file') {
          const result = writeSkillFile({
            name,
            filePath: String(args.file_path ?? ''),
            content: typeof args.file_content === 'string' ? args.file_content : '',
            actor: 'model',
            limits,
            readConfirmed: true,
          })
          announce(result)
          return result.ok ? result.notice : result.error
        }
        const result = archiveSkillOp(name, 'model')
        announce(result)
        return result.ok ? result.notice : result.error
      },
    }
    disposers.push(ctx.tools.register(skillWriteTool))

    // ── L1/L3：learning 工具（候选清单）────────────────────────────────────────

    /** 把候选转成技能（skill-draft 直接落盘，其余起一轮沉淀）。 */
    async function promoteToSkill(candidate: LearningCandidate, actor: 'model' | 'user'): Promise<string> {
      if (candidate.kind === 'skill-draft') {
        let draft: SkillDraft | null = null
        try {
          const parsed = JSON.parse(candidate.text) as Partial<SkillDraft>
          if (typeof parsed.name === 'string' && typeof parsed.content === 'string') {
            draft = {
              name: parsed.name,
              description: typeof parsed.description === 'string' ? parsed.description : '',
              whenToUse: typeof parsed.whenToUse === 'string' ? parsed.whenToUse : '',
              content: parsed.content,
            }
          }
        } catch {
          draft = null
        }
        if (draft === null) return `候选 ${candidate.id} 里存的草稿读不出来，先用 /learnings drop ${candidate.id} 清掉它`
        const message = await landDraft(draft, actor)
        setCandidateState(cwd(), candidate.id, 'promoted')
        return message
      }
      setCandidateState(cwd(), candidate.id, 'promoted')
      return startPluginTurn(authorPrompt('', candidate.text, limits.descriptionMax), { mode: 'learn', actor })
    }

    /** 把候选写进长期记忆（走 memory 服务的额度与安检，一道都不少）。 */
    function promoteToMemory(candidate: LearningCandidate, target: string): string {
      // memory 是内核常驻插件（BUILTIN_PLUGINS 之一，不可停用），所以走 inject 拿；
      // 它不是「可能没挂」的可选服务，不该用 ctx.get（那是 modes-security 自检里点名要守的规矩）。
      const wanted = target === 'global' || target === 'user' || target === 'workspace' ? target : 'workspace'
      const result = ctx.memory.write([{ action: 'add', target: wanted, content: candidate.text }], cwd())
      if (!result.ok) return `写进记忆没成：${result.error}`
      setCandidateState(cwd(), candidate.id, 'promoted')
      return `已把候选 ${candidate.id} 写进「${wanted}」这一格记忆（模型下一次会话才看得到）`
    }

    async function promoteCandidate(id: string, as: string, actor: 'model' | 'user', target = ''): Promise<string> {
      const candidate = readCandidates(cwd()).find((item) => item.id === id)
      if (candidate === undefined) return `没有 id 为 ${id} 的候选（/learnings list 看清单）`
      if (candidate.state === 'promoted') return `候选 ${id} 已经 promote 过了`
      const mode = as === 'memory' || as === 'skill' ? as : candidate.kind === 'skill-draft' ? 'skill' : 'memory'
      return mode === 'skill' ? promoteToSkill(candidate, actor) : promoteToMemory(candidate, target)
    }

    const learningTool: ToolEntry = {
      name: 'learning',
      description: [
        '处理自我改进的候选清单（`~/.dsc/learnings/`）。候选**不进你的上下文**，只有用户 promote 才会变成记忆或技能。',
        'action：propose 记一条候选（text + kind：correction | failure | note | skill-draft）；',
        'list 看清单（状态、命中次数）；promote 把候选 promoted（as=memory 写进长期记忆，as=skill 转成技能草稿）；drop 丢掉一条。',
        '什么时候用 propose：用户在对话里纠正了你的做法、或者你发现了一条以后还用得上的经验，但这些还没到「该写成技能」的程度——先记成候选，让用户决定。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'propose | list | promote | drop' },
          text: { type: 'string', description: 'propose：候选内容（一句话说清那条经验）' },
          kind: { type: 'string', description: 'propose：correction | failure | note | skill-draft（默认 note）' },
          id: { type: 'string', description: 'promote / drop：候选 id' },
          as: { type: 'string', description: 'promote：memory 写进记忆，skill 转成技能草稿' },
          target: { type: 'string', description: 'promote as=memory：global | user | workspace（默认 workspace）' },
        },
        required: ['action'],
      },
      risk: 'write',
      async run(args) {
        if (!config.enabled) return '自我改进现在是关着的（设置 → 插件 → 自我改进 里可以打开）。'
        const action = String(args.action ?? 'list').trim()
        if (action === 'propose') {
          const text = String(args.text ?? '').trim()
          if (text === '') return 'propose 要给 text（一句话说清那条经验）'
          const kindRaw = String(args.kind ?? 'note')
          const kind: LearningKind =
            kindRaw === 'correction' || kindRaw === 'failure' || kindRaw === 'skill-draft' ? kindRaw : 'note'
          const result = recordCandidate(cwd(), { kind, text, turnRef: turnRefOf(ctx.session.current().messages) }, storeOptions())
          if (result.error !== '') return result.error
          return result.deduped
            ? `这条候选已经在了（id ${result.candidate?.id ?? ''}，命中 ${String(result.candidate?.hits ?? 0)} 次）`
            : `已记候选 ${result.candidate?.id ?? ''}（不进你的上下文，用户 /learnings promote ${result.candidate?.id ?? ''} 才生效）`
        }
        if (action === 'list') {
          const all = readCandidates(cwd())
          if (all.length === 0) return `候选清单是空的（${candidatesFile(cwd())}）`
          const lines = all.slice(0, 20).map((item, index) => formatCandidate(item, index))
          return `候选清单（${String(all.length)} 条，文件 ${candidatesFile(cwd())}）：\n${lines.join('\n')}`
        }
        if (action === 'promote' || action === 'drop') {
          const id = String(args.id ?? '').trim()
          if (id === '') return `${action} 要给 id（/learnings list 看清单）`
          if (action === 'drop') {
            const result = setCandidateState(cwd(), id, 'dropped')
            return result.ok ? `已丢掉候选 ${id}` : result.error
          }
          return promoteCandidate(id, String(args.as ?? ''), 'model', String(args.target ?? ''))
        }
        return 'action 只能是 propose / list / promote / drop'
      },
    }
    disposers.push(ctx.tools.register(learningTool))

    // ── 命令 ────────────────────────────────────────────────────────────────────

    disposers.push(
      ctx.commands.register(
        { name: 'learn', args: '[目标]', description: '把刚才这件事（或指定目标）沉淀成一个技能草稿' },
        ({ args, ui }) => {
          if (!config.enabled) {
            ui.notice('自我改进现在是关着的（设置 → 插件 → 自我改进 里可以打开）')
            return
          }
          const goal = args.join(' ').trim()
          ui.notice(startPluginTurn(authorPrompt(goal, '', limits.descriptionMax), { mode: 'learn', actor: 'user' }))
        },
      ),
    )

    disposers.push(
      ctx.commands.register(
        { name: 'learnings', args: '[list | promote <id> [memory|skill] | drop <id> | clean]', description: '看纠正候选清单：候选不进模型上下文，promote 才生效' },
        ({ args, ui }) => {
          const sub = (args[0] ?? 'list').toLowerCase()
          if (sub === 'clean') {
            const report = readCandidates(cwd())
            const kept = report.filter((item) => item.state !== 'dropped')
            for (const item of report) {
              if (item.state === 'dropped') setCandidateState(cwd(), item.id, 'dropped')
            }
            ui.notice(`候选清单：${String(report.length)} 条里 ${String(kept.length)} 条留着（drop 掉的还留在文件里做历史，读的时候照样会列出来）`)
            return
          }
          if (sub === 'promote' || sub === 'drop') {
            const id = args[1] ?? ''
            if (id === '') {
              ui.notice(`${sub} 要给候选 id：/learnings list 看清单`)
              return
            }
            if (sub === 'drop') {
              const result = setCandidateState(cwd(), id, 'dropped')
              ui.notice(result.ok ? `已丢掉候选 ${id}` : result.error)
              return
            }
            const as = (args[2] ?? '').toLowerCase()
            void promoteCandidate(id, as, 'user', (args[3] ?? '').toLowerCase()).then((message) => {
              ui.notice(message)
            })
            return
          }
          const all = readCandidates(cwd())
          if (all.length === 0) {
            ui.notice(`候选清单是空的。文件位置：${candidatesFile(cwd())}（纠正与非正常结束的轮次会自动记在这里）`)
            return
          }
          const lines = all.slice(0, 20).map((item, index) => formatCandidate(item, index))
          ui.notice(
            `纠正候选（${String(all.length)} 条；文件 ${candidatesFile(cwd())}；不进模型上下文，promote 才生效；保留 ${String(config.retentionDays)} 天、最多 ${String(config.maxCandidates)} 条）\n${lines.join('\n')}\n用法：/learnings promote <id> [memory|skill]、/learnings drop <id>`,
          )
        },
      ),
    )

    /** 整理一次并回一句话（命令与设置按钮共用）。 */
    function runCurate(): string {
      const report = curateSkills(Date.now(), DEFAULT_AGING)
      const parts = [`技能 ${String(report.total)} 个`]
      if (report.stale.length > 0) parts.push(`${String(report.stale.length)} 个降为 stale（${report.stale.join('、')}）`)
      if (report.archived.length > 0) parts.push(`${String(report.archived.length)} 个搬进归档区（${report.archived.join('、')}）`)
      if (report.stale.length === 0 && report.archived.length === 0) parts.push('这一轮没有需要降级或归档的')
      parts.push('只动 created_by: agent 且没钉住的技能；归档是搬走不是删除')
      return parts.join('；')
    }

    disposers.push(
      ctx.commands.register(
        { name: 'skills-ledger', args: '[n | rollback <id> | pin <name> | unpin <name> | curate]', description: '技能变更台账：看最近几条、按 id 回滚、钉住技能、立刻整理' },
        ({ args, ui }) => {
          const sub = (args[0] ?? '').toLowerCase()
          if (sub === 'rollback') {
            const id = args[1] ?? ''
            if (id === '') {
              ui.notice('rollback 要给台账 id：/skills-ledger 看最近几条')
              return
            }
            const result = rollbackEntry(id)
            ui.notice(result.ok ? result.notice : `回滚没成：${result.error}`)
            if (result.ok) ctx.emit('dsc/skills-changed')
            return
          }
          if (sub === 'pin' || sub === 'unpin') {
            const name = args[1] ?? ''
            if (name === '') {
              ui.notice(`${sub} 要给技能名`)
              return
            }
            if (!existsSync(skillFileOf(name))) {
              ui.notice(`没有名为 ${name} 的本地技能`)
              return
            }
            setSkillPinned(name, sub === 'pin')
            ui.notice(sub === 'pin' ? `已钉住 ${name}：自动改写与自动归档都不会再动它` : `已取消钉住 ${name}`)
            return
          }
          if (sub === 'curate') {
            ui.notice(runCurate())
            return
          }
          const limit = Number.isFinite(Number(sub)) && sub !== '' ? Math.max(1, Math.trunc(Number(sub))) : 10
          const entries = readLedger(limit)
          if (entries.length === 0) {
            ui.notice(`台账还是空的（${ledgerFile()}）。技能由 skill_write 改过之后这里就会有记录。`)
            return
          }
          ui.notice(
            `技能变更台账（最近 ${String(entries.length)} 条，共 ${String(ledgerSize())} 字符；回滚用 /skills-ledger rollback <id>）\n${entries.map(formatLedgerEntry).join('\n')}`,
          )
        },
      ),
    )

    // ── 系统提示 ────────────────────────────────────────────────────────────────

    /**
     * 进系统提示的那一段：只报「有几条待审候选」「技能写入要不要审批」这种当前事实。
     *
     * **绝不把候选正文拼进来**——这是本插件的关键安全属性。候选里存的常常是用户原话，
     * 而用户原话里可能夹着从网页或别的程序粘进来的外部文本；拼进系统提示等于给外部文本
     * 开了一条进模型上下文的直通车。这里只说条数，想看内容由用户 `/learnings list` 决定。
     */
    function promptText(): string {
      if (!config.enabled) return ''
      let pending = 0
      try {
        pending = readCandidates(cwd()).filter((item) => item.state === 'candidate').length
      } catch {
        // 候选清单读不出来不该拖累每一轮请求：这一段就当没有（提示词少了它，功能照跑）
        return ''
      }
      const lines: string[] = []
      if (pending > 0) {
        lines.push(
          `候选清单里有 ${String(pending)} 条待审经验（正文不在你的上下文里，用户 /learnings list 才看得到；要变成记忆或技能得由用户 promote）。`,
          '你在对话里被用户纠正了、或自己发现一条以后还用得上的经验时，可以用 learning 工具 propose 记一条候选，让用户决定要不要留下。',
        )
      }
      if (config.requireApproval) {
        lines.push('技能写入（skill_write 工具）要走审批：用户点头才落盘；新建的技能默认停用，等用户在 /skills 里启用。')
      }
      if (lines.length === 0) return ''
      return `【自我改进】${lines.join('')}`
    }

    disposers.push(ctx.prompt.register('self-improve', promptText, { order: 43 }))

    // ── 设置分区 ────────────────────────────────────────────────────────────────

    function sectionFields(): SettingsField[] {
      const local = localSkillNames()
      const usage = readLedger(1)
      return [
        {
          type: 'switch',
          key: 'enabled',
          label: '启用自我改进',
          help: '关掉之后：不再捕获纠正候选、不再自动复盘、两个工具也不再写盘。已经写在盘上的候选与技能原样留着。',
        },
        {
          type: 'number',
          key: 'reviewMinIterations',
          label: '复盘触发：本轮工具迭代数不低于',
          min: 0,
          max: 200,
          step: 1,
          help: `按「本轮工具调用的次数」算，不按用户轮数（对齐 hermes 的口径）。填 0 等于不自动复盘。默认 ${String(DEFAULT_CONFIG.reviewMinIterations)}。`,
        },
        {
          type: 'switch',
          key: 'requireApproval',
          label: '技能写入要我点一次头',
          help: '开了之后模型每次新建/改写技能都要弹一张审批卡；没人能回答时按拒处理，草稿会存进候选清单等你 promote。',
        },
        {
          type: 'number',
          key: 'retentionDays',
          label: '候选保留天数',
          min: 1,
          max: 365,
          step: 1,
          help: `超过这个天数的候选在下次写入时被裁掉。默认 ${String(DEFAULT_CONFIG.retentionDays)} 天。`,
        },
        {
          type: 'number',
          key: 'maxCandidates',
          label: '候选条数上限',
          min: 10,
          max: 2000,
          step: 10,
          help: `超了先裁最老的。默认 ${String(DEFAULT_CONFIG.maxCandidates)} 条。`,
        },
        {
          type: 'info',
          label: '技能目录',
          text: skillsRoot(),
          mono: true,
          copyable: true,
          help: `技能写在这里（归档区 ${archiveRoot()}，现在堆了 ${String(archivedCount())} 个，只进不出）；路径可以点一下复制。`,
        },
        {
          type: 'info',
          label: '候选与台账',
          text: [
            `候选清单：${candidatesFile(cwd())}`,
            `使用台账：${usageFile()}`,
            `变更台账：${ledgerFile()}（${usage.length === 0 ? '还没有记录' : `最近一条 ${usage[0]?.id ?? ''}`}）`,
          ].join('\n'),
          mono: true,
          copyable: true,
          help: `只写这两个根，别的什么都不碰：${TARGET_ROOTS()}。`,
        },
        {
          type: 'info',
          label: '技能现状',
          text: `本地技能 ${String(local.length)} 个：${local.slice(0, 12).join('、')}${local.length > 12 ? ' …' : ''}`,
          help: '老化是 active → stale（14 天没命中）→ archived（30 天，只搬不删）；只动 created_by: agent 且没钉住的技能。',
        },
        { type: 'button', action: 'curate', label: '立即整理', style: 'ghost', help: '马上跑一次老化分级与归档，不用等下一次触发。' },
      ]
    }

    const section: SettingsSectionSpec = {
      id: 'self-improve',
      title: '自我改进',
      subtitle: '从纠正与复盘里沉淀经验：候选清单、技能草稿、技能自修与审计回滚',
      order: 35,
      fields: sectionFields,
      values(): SettingsValues {
        return {
          enabled: config.enabled,
          reviewMinIterations: config.reviewMinIterations,
          requireApproval: config.requireApproval,
          retentionDays: config.retentionDays,
          maxCandidates: config.maxCandidates,
        }
      },
      save(key, value): string | void {
        switch (key) {
          case 'enabled':
            applyConfig({ enabled: value === true })
            return
          case 'requireApproval':
            applyConfig({ requireApproval: value === true })
            return
          case 'reviewMinIterations': {
            const num = Number(value)
            if (!Number.isFinite(num) || num < 0 || num > 200) return '这里要填 0 到 200 之间的整数（0 = 不自动复盘）'
            applyConfig({ reviewMinIterations: Math.trunc(num) })
            return
          }
          case 'retentionDays': {
            const num = Number(value)
            if (!Number.isFinite(num) || num < 1 || num > 365) return '保留天数要填 1 到 365 之间的整数'
            applyConfig({ retentionDays: Math.trunc(num) })
            return
          }
          case 'maxCandidates': {
            const num = Number(value)
            if (!Number.isFinite(num) || num < 10 || num > 2000) return '条数上限要填 10 到 2000 之间的整数'
            applyConfig({ maxCandidates: Math.trunc(num) })
            return
          }
          default:
            return `这个分区没有这项：${key}`
        }
      },
      action(name): string | void {
        if (name !== 'curate') return `这个分区没有这个按钮：${name}`
        const message = runCurate()
        ctx.emit('dsc/skills-changed')
        return message
      },
    }
    disposers.push(ctx.settings.registerSection(section))

    // ── 收尾 ────────────────────────────────────────────────────────────────────

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          // 卸载路径上不许抛：一个退订失败不该拦住其余的清理
          void error
        }
      }
      pending = null
      // 还挂着的审批卡跟着这一次热卸载一起结束，别让它挂在界面上等一个不会来的答案
      pluginAbort.abort()
    }
  },
}
