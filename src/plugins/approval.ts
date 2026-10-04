/**
 * approval 插件：provide `approval` 服务——工具执行的裁决引擎 + 审批卡。
 *
 * 一次判定按这个顺序走，前面的层一旦说话，后面的层不再有机会放宽：
 *   1. 硬地板   —— 灾难性命令与关键系统路径，任何权限模式都拒（含完全访问）；
 *   2. 路径护栏 —— 说明书类文件（AGENTS.md、dsc 配置）必须当面确认一次，不许任何自动档代劳；
 *   3. 命令策略 —— 用户前缀规则 + 内置危险模式（`~/.dsc/policy.rules`）；
 *   4. 已给授权 —— 本会话内的同类授权（按会话 id 键控，切会话即失效）；
 *   5. 权限模式 —— readonly / auto-edit / full-access / ai-review 的自动裁决；
 *   6. 人工审批卡 —— 四档决定（这次允许 / 本会话允许 / 永久允许 / 拒绝），超时按拒处理。
 *
 * 两个前置判断插在中间：命中灾难地板白名单的命令免卡放行（地板自己不 return pass，
 * 那样会跳掉 order 20 / 25 的安全钩子，所以免卡这一步落在这里）；没有人能回答审批卡时
 * 直接按拒处理，不白等一次超时——脚本与 CI 场景没人会来点那张卡。
 *
 * 顺序照两家成熟做法：Hermes 的 hardline 与用户 deny 表在 yolo 之前求值
 * （`tools/approval_floors.py:5`），Codex 的命令分段与 `PermissionGrantScope{Turn,Session}`
 * 决定授权档位（`protocol/src/request_permissions.rs:12`）。DSH 的
 * `approval/asked` + `approval/decided` 成对审计也照搬（`user-approval/src/index.ts:215-234`）。
 *
 * 这一整套裁决挂在守卫链的 order 30 上（协作模式那道闸门排在 order 10，先问模式再问审批），
 * 所以循环不必认识「审批」这件事。等卡期间这张卡登记在「正在等人」的表里。
 * 等多久没人答算超时是插件配置（`approval.approvalTimeoutMs`）。
 *
 * @module dsc/plugins/approval
 */
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type { ApprovalDecision, ApprovalRequest } from '../core/approval.js'
import { argsSummary, callFacts, stripBaseline } from '../core/tools.js'
import { summarizeChange } from '../core/tools/fs-tools.js'
import { REJECTED_TOOL_TEXT } from '../core/session.js'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import { toolApprovalGuard, type ToolObserver } from '../core/tool-guards.js'
import type { ApprovalPolicy, ApprovalRequestView, ApprovalService } from '../services/types.js'
import type { ApprovalAnswer, ApprovalDiffView, CollaborationMode, PolicySurface, TierOption } from '../contract.js'
import { activeRules, appendRule, classifyCommand, reloadActiveRules } from '../core/command-policy.js'
import { isInsideCwd, isProtectedInstruction, writeHardBlockReason } from '../core/path-policy.js'
import { audit } from '../core/audit.js'
import { redact } from '../core/secrets.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'approval'

/** 审批卡等多久没人答就按拒处理（抄 Hermes 的 approvals.timeout 默认 300s）；配置没给时用这个。 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000

/**
 * 取审批卡的等待时限：夹在 10 秒到 1 小时之间（再短一点就来不及答，再长等于不超时）。
 * @param passed - 装配时直接传进来的配置（内核挂载时的第二参数）。
 */
function readTimeout(passed: unknown): number {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const num = Number(raw.approvalTimeoutMs)
  if (!Number.isFinite(num)) return DEFAULT_APPROVAL_TIMEOUT_MS
  return Math.min(Math.max(Math.round(num), 10_000), 3_600_000)
}

/** 权限模式四档的界面文案（界面画档位按钮时读这份，不再自己抄一份）。 */
const POLICY_OPTIONS: ReadonlyArray<TierOption<ApprovalPolicy>> = [
  { id: 'readonly', label: '仅查看', hint: '只读模式：读类操作放行，写/执行类一律拒绝' },
  { id: 'auto-edit', label: '自动编辑', hint: '工作区内写操作自动放行，其余需审批' },
  { id: 'full-access', label: '完全访问', hint: '全部工具自动放行，谨慎使用' },
  { id: 'ai-review', label: 'AI 审查', hint: '由模型逐次判断是否放行，失败回退人工审批' },
]

/** 写类工具里「目标在工作区内就能自动放行」的那几个。 */
const PATH_WRITE_TOOLS = new Set(['write', 'edit'])

/**
 * write / edit 审批卡的「将做的改动」（codex 审批弹窗内嵌 diff 的同位能力）：
 * 读盘上现值、按工具语义推演写后的全文、走 summarizeChange 同一套算法截断。
 * 与渲染层工具卡的推演（intended-diff.ts）同一套语义，两处分头实现——宿主这份
 * 在弹卡前算好随视图下发，渲染层那份等服务期里自己读盘，环境不同没有共享面。
 *
 * 三种降级：盘上读不到（工作区外 / 文件还不存在）→ write 从空串、edit 用 old→new
 * 的参数差异，标 `fellBack`；edit 的 old 对不上盘（missing / 多处）→ 执行必然失败，
 * 给参数差异并标 `mismatch`，卡片上要提示；完全算不出（非这两类工具、参数不齐、
 * 内容一致）→ null，卡片回到只有参数摘要的常态。
 */
export async function approvalDiffOf(request: ApprovalRequest): Promise<ApprovalDiffView | null> {
  if (request.toolName !== 'write' && request.toolName !== 'edit') return null
  const args = request.args ?? {}
  const rawPath = typeof args.path === 'string' ? args.path : ''
  if (rawPath === '') return null
  const cwd = request.cwd ?? process.cwd()
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
  const content = typeof args.content === 'string' ? args.content : null
  const oldText = typeof args.old === 'string' ? args.old : null
  const newText = typeof args.new === 'string' ? args.new : null
  if (request.toolName === 'write' ? content === null : oldText === null || newText === null) return null
  const read = await fsp.readFile(abs, 'utf8').catch(() => null)
  let effectiveBefore: string
  let after: string
  let mismatch: ApprovalDiffView['mismatch']
  if (request.toolName === 'write') {
    effectiveBefore = read ?? ''
    after = content!
  } else if (read === null) {
    effectiveBefore = oldText!
    after = newText!
  } else {
    const at = read.indexOf(oldText!)
    if (at < 0) {
      mismatch = 'missing'
      effectiveBefore = oldText!
      after = newText!
    } else if (read.indexOf(oldText!, at + 1) >= 0) {
      mismatch = 'ambiguous'
      effectiveBefore = oldText!
      after = newText!
    } else {
      effectiveBefore = read
      after = read.slice(0, at) + newText! + read.slice(at + oldText!.length)
    }
  }
  const changes = summarizeChange(abs, effectiveBefore, after)
  // 内容一致（覆盖写了个寂寞）也给一份空 diff：卡片上「不会有实际改动」比「没有信息」好。
  const clean =
    changes === undefined
      ? { path: abs, added: 0, removed: 0, hunks: [], status: 'modified' as const }
      : stripBaseline(changes)
  return {
    ...clean,
    // hunks 的行文本会摊到卡上：密钥形状的字符串过一遍遮红，别让审批动作本身泄密
    hunks: clean.hunks.map((hunk) => ({
      ...hunk,
      lines: hunk.lines.map((line) => ({ ...line, text: redact(line.text) })),
    })),
    ...(read === null ? { fellBack: true } : {}),
    ...(mismatch !== undefined ? { mismatch } : {}),
  }
}

/** 一张卡允许出现的授权档位。 */
type GrantScope = 'once' | 'session' | 'always'

/** 风险档位：给审批卡上色，也决定 AI 审查能不能替用户做主。 */
type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export const approvalPlugin: Plugin.Object = {
  name: 'approval',
  inject: ['llm', 'session', 'guards', 'surfaces', 'waiting'],
  provide: 'approval',
  apply(ctx, passed) {
    let policy: ApprovalPolicy = 'auto-edit'
    // 每次弹卡现读：改了等待时限不必重启宿主，下一张卡就用新值。
    const timeoutMs = (): number => readTimeout(passed)
    /**
     * 当前协作模式，只进审批卡的说明文字与审计记录。
     * 听 `dsc/mode-changed` 而不是反过来依赖模式服务：mode 已经依赖 approval（审计要写当时的权限模式），
     * 两头互相依赖在依赖图上就是环。
     */
    let modeForCard: CollaborationMode = 'build'
    /** 本会话内的同类授权：sessionId → 授权键集合。 */
    const sessionGrants = new Map<string, Set<string>>()

    /** 一张挂着等人答的审批卡。0.6.48 起多卡并存（常驻多 agent：后台会话也会弹卡）。 */
    interface PendingCard {
      view: ApprovalRequestView
      grantKey: string
      suggestedRule: string[] | null
      done: (decision: ApprovalDecision, phase?: 'decided' | 'cancelled' | 'timeout') => void
      timer: NodeJS.Timeout
      /** 这个答案是从哪儿点下来的（'app' 宿主界面 / 'web' 手机浏览器）；没人答过时 undefined。 */
      source?: 'app' | 'web'
      /** 这张卡属于哪个会话：授权记账、审计与侧栏状态点都按它归属。 */
      sessionId: string
      sessionPath: string
    }
    /** 卡 id → 卡。插入序 = 弹卡序；界面取最老的一张展示。 */
    const pendings = new Map<string, PendingCard>()

    /** 规则文件重新读一遍（写在永久规则之后，让下一条判定立刻看到它）。 */
    const reloadRules = (): void => {
      for (const problem of reloadActiveRules().problems) ctx.emit('dsc/notice', `规则文件：${problem}`)
    }
    reloadRules()

    /** 当前会话 id（授权键与审计都挂在它下面）。 */
    const sessionId = (): string => ctx.session.current().meta.id

    /** 这次判定属于哪个会话：请求带了发起方就按发起方（0.6.48 多 agent），否则看当前查看的。 */
    const sidOf = (request: ApprovalRequest): string => request.sessionId ?? sessionId()

    /** 这次判定的会话 jsonl 路径（侧栏状态点的键口径）。 */
    const pathOf = (request: ApprovalRequest): string => request.sessionPath ?? ctx.session.current().filePath

    /** 这次调用属于哪个「同类」：同一会话里再出现就不再问的粒度。 */
    function grantKeyOf(toolName: string, suggested: string[] | null, insideCwd: boolean): string {
      if (suggested !== null) return `${toolName}:${suggested.join(' ')}`
      if (PATH_WRITE_TOOLS.has(toolName)) return `${toolName}:${insideCwd ? 'inside-cwd' : 'outside-cwd'}`
      return toolName
    }

    /**
     * 现在有没有人能回答审批卡。
     *
     * 有界面入口登记（tui / host-stdio）就以它为准；没有登记时看这一进程是不是终端直连。
     * 两者都没有就是脚本、CI、无头调用——没人能点那张卡，等满超时只是白等 5 分钟。
     */
    const someoneCanAnswer = (): boolean => {
      const ui = ctx.get('interactive')
      if (ui !== undefined) return ui.reachable()
      return process.stdin.isTTY === true
    }

    /** 挂起人工审批卡：等到答案、等到超时、或等到本轮被打断。 */
    const askHuman = (
      request: ApprovalRequest,
      signal: AbortSignal,
      input: {
        reason: string
        risk: RiskLevel
        suggestedRule: string[] | null
        scopes: GrantScope[]
        grantKey: string
        hardline: boolean
        /** write/edit 的「将做的改动」；算不出来时 null，卡上就不画。 */
        diff: ApprovalDiffView | null
      },
    ): Promise<ApprovalDecision> =>
      new Promise<ApprovalDecision>((resolveDone) => {
        // 没人能回答就不弹卡：超时按拒是同一条结论，只是早 300 秒给出，并且理由说清了为什么。
        if (!someoneCanAnswer()) {
          autoLog('auto-deny', request, '当前没有界面能回答审批卡（没有终端界面，也没有桌面客户端），按拒处理')
          resolveDone('reject')
          return
        }
        const id = randomUUID()
        const sid = sidOf(request)
        const view: ApprovalRequestView = {
          id,
          toolName: request.toolName,
          argsSummary: redact(request.argsSummary),
          reason: input.reason,
          risk: input.risk,
          suggestedRule: input.suggestedRule,
          hardline: input.hardline,
          scopes: input.scopes,
          policy,
          mode: modeForCard,
          // 发起会话归属（0.6.49）：卡片是全局渲染的，后台会话的卡弹出来时界面要标得清是谁家的
          sessionPath: pathOf(request),
          ...(input.diff === null ? {} : { diff: input.diff }),
        }
        audit({
          ts: Date.now(),
          kind: 'approval',
          id,
          phase: 'asked',
          tool: request.toolName,
          summary: view.argsSummary,
          reason: input.reason,
          policy,
          mode: view.mode,
          sessionId: sid,
          cwd: request.cwd,
        })
        const done = (decision: ApprovalDecision, phase: 'decided' | 'cancelled' | 'timeout' = 'decided'): void => {
          const card = pendings.get(id)
          if (card === undefined) return
          pendings.delete(id)
          // 来源要在清掉挂起之前取出来：下面这行之后这个对象就没人持有了。
          // 超时与被打断没人答过，card.source 还是 undefined，审计里就不写这一栏。
          const source = card.source
          clearTimeout(card.timer)
          ctx.emit('dsc/changed')
          // 卡收了，那个会话要是还在跑回合就回到 working（转录层的状态点跟着翻回来）
          ctx.emit('dsc/agent-status', { sessionId: sid, path: card.sessionPath, state: 'working' })
          audit({
            ts: Date.now(),
            kind: 'approval',
            id,
            phase,
            tool: request.toolName,
            summary: view.argsSummary,
            decision: decision === 'reject' ? (phase === 'decided' ? 'reject' : phase) : decision,
            reason: input.reason,
            policy,
            mode: view.mode,
            sessionId: sid,
            ...(source === undefined ? {} : { source }),
          })
          resolveDone(decision)
        }
        const timer = setTimeout(() => done('reject', 'timeout'), timeoutMs())
        pendings.set(id, { view, grantKey: input.grantKey, suggestedRule: input.suggestedRule, done, timer, sessionId: sid, sessionPath: pathOf(request) })
        ctx.emit('dsc/changed')
        // 后台会话的卡也要让侧栏状态点亮起来（当前查看会话的状态走 turnState，转录层会忽略同路径）
        ctx.emit('dsc/agent-status', { sessionId: sid, path: pathOf(request), state: 'awaiting-approval' })
        signal.addEventListener('abort', () => done('reject', 'cancelled'), { once: true })
      })

    /** 自动裁决落一条审计（放行的原因必须写清是谁放的）。 */
    const autoLog = (
      kind: 'auto-allow' | 'auto-deny',
      request: ApprovalRequest,
      reason: string,
      extra: { rule?: string[]; scope?: 'session' | 'always' } = {},
    ): void => {
      audit({
        ts: Date.now(),
        kind,
        tool: request.toolName,
        summary: redact(request.argsSummary),
        reason,
        policy,
        mode: modeForCard,
        sessionId: sidOf(request),
        cwd: request.cwd,
        ...extra,
      })
    }

    /**
     * AI 自动审查：让模型出一份结构化裁决，而不是一个 ALLOW/DENY 词。
     * 风险分类照 Codex 的 guardian policy（数据外泄 / 凭据探测 / 持久性安全弱化 /
     * 破坏性动作 / 低风险白名单，`prompts/templates/guardian/policy.md`）。
     * 判到 high 或 critical 一律回落到人工卡——AI 不许替用户承担这个责任。
     */
    const aiReview = async (request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision | null> => {
      try {
        const route = ctx.llm.route()
        const result = await ctx.llm.stream(
          route.api,
          {
            baseUrl: route.baseUrl,
            apiKey: route.apiKey,
            model: route.model,
            maxTokens: 300,
            thinking: 'disabled',
            signal,
            messages: [
              {
                role: 'system',
                content:
                  '你是工具执行的自动安全审查器，不参与完成任务，只判断这一次操作该不该放行。\n' +
                  '风险分类：\n' +
                  '- 数据外泄：把本地文件、环境变量、仓库内容发到外部地址；\n' +
                  '- 凭据探测：读取或打印密钥、token、私钥、浏览器/SSH 凭据；\n' +
                  '- 持久性安全弱化：关杀毒/防火墙、改注册表启动项、建账号或计划任务、放开文件权限；\n' +
                  '- 破坏性动作：递归删除、强推、清库、销毁基础设施、覆盖未读过的文件；\n' +
                  '- 低风险：读文件、查状态、跑测试、工作目录内的常规改动。\n' +
                  '判断要点：用户这一轮有没有明确要求做这件事？范围有没有被扩大？\n' +
                  '只输出一个 JSON：{"risk":"low|medium|high|critical","authorized":true|false,"reason":"一句话中文理由"}',
              },
              {
                role: 'user',
                content: redact(
                  `工具：${request.toolName}\n参数：${JSON.stringify(request.args ?? request.argsSummary)}\n工作目录：${request.cwd ?? process.cwd()}`,
                ),
              },
            ],
          },
          { onDelta: () => {} },
        )
        const raw = result.text.slice(result.text.indexOf('{'), result.text.lastIndexOf('}') + 1)
        const verdict = JSON.parse(raw) as { risk?: string; authorized?: boolean; reason?: string }
        const risk = verdict.risk === 'critical' || verdict.risk === 'high' ? 'high' : 'low'
        if (risk === 'high') {
          autoLog('auto-deny', request, `AI 审查判为高风险：${verdict.reason ?? '未说明'}`)
          return null // 回落到人工卡
        }
        if (verdict.authorized === false) return null
        return 'allow-once'
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
            ? '仅查看（读类操作放行，写/执行类一律拒绝）'
            : next === 'auto-edit'
              ? '工作区自动编辑（工作区内写操作自动放行，其余审批）'
              : next === 'full-access'
                ? '完全访问（全部工具自动放行，灾难性命令仍然拒）'
                : 'AI 自动审查（由模型逐次判断，判到高风险回退人工审批）'
        // dsc/notice → transcript 写 system 条目（避免与 transcript 的循环依赖）
        ctx.emit('dsc/notice', `权限模式切换为「${label}」`)
        audit({
          ts: Date.now(),
          kind: 'mode-change',
          reason: `权限模式 → ${next}`,
          policy: next,
          mode: modeForCard,
          sessionId: sessionId(),
        })
      },

      async decide(request: ApprovalRequest, signal, options): Promise<ApprovalDecision> {
        const cwd = request.cwd ?? process.cwd()
        // 安全钩子可以要求「这一次必须问人」：非空时下面所有自动放行档一律跳过。
        const forced = options?.forceAskReason?.trim() ?? ''
        const facts = callFacts(request.args ?? {}, cwd)
        const target = facts.target ?? null
        const command = facts.command ?? null
        const insideCwd = target !== null && isInsideCwd(cwd, target)
        const verdict = command === null ? null : classifyCommand(command, { rules: activeRules() })

        // 第 1 层：硬地板。灾难性命令与关键系统路径，任何模式都拒，连卡都不弹。
        if (target !== null) {
          const hard = writeHardBlockReason(target)
          if (hard !== null) {
            autoLog('auto-deny', request, hard)
            return 'reject'
          }
        }
        if (verdict !== null && verdict.hardline) {
          autoLog('auto-deny', request, `硬地板拒绝：${verdict.reason}`)
          return 'reject'
        }

        // 第 2 层：说明书类文件（AGENTS.md / CLAUDE.md / .cursorrules / dsc 配置）。
        // 模型改自己的规则是最省事的作弊路径，所以这一条压过所有自动档。
        const protectedWhy = target === null ? null : isProtectedInstruction(target, cwd)

        // 第 3 层：已给授权。同会话同类动作不再问第二次；永久规则命中 exec 时也在此放行。
        // 0.6.48：按发起调用的会话记账（后台 agent 的授权不看当前查看的会话）。
        const suggested = verdict?.prefixRule ?? null
        const grants = sessionGrants.get(sidOf(request))
        const key = grantKeyOf(request.toolName, suggested, insideCwd)
        const grantHit = protectedWhy === null && forced === '' && (grants?.has(key) ?? false)
        if (grantHit) {
          autoLog('auto-allow', request, '本会话已允许同类操作', { scope: 'session' })
          return 'allow-once'
        }
        if (
          forced === '' &&
          verdict !== null &&
          verdict.decision === 'allow' &&
          verdict.matchedRule !== null &&
          protectedWhy === null
        ) {
          autoLog('auto-allow', request, `规则允许：${verdict.reason}`, { rule: verdict.matchedRule.pattern })
          return 'allow-once'
        }

        // 灾难地板的白名单：地板判过「这条命令不需要有人回答」，但它自己不 return pass
        // （那样会把 order 20 的安全钩子与 order 25 的生命周期钩子一起跳掉），免卡这一步落在审批层。
        // 钩子要求当面看一次（forced）或目标是指明书类文件（protectedWhy）时白名单不生效。
        const floor = ctx.get('approvalFloor')
        if (forced === '' && protectedWhy === null && command !== null && floor !== undefined) {
          const prefix = floor.whitelist(command)
          if (prefix !== null) {
            autoLog('auto-allow', request, `命中审批灾难地板白名单「${prefix.join(' ')}」，免审批卡`)
            return 'allow-once'
          }
        }

        // 第 5 层：权限模式自己的裁决（protected 文件不参与，强制走人工卡）。
        if (protectedWhy === null && forced === '') {
          if (policy === 'readonly') {
            // 「仅查看」的字面意思就是只读：策略引擎判成 allow 的命令（查看目录、看 git 状态、
            // 管道里只做筛选与格式化）原样放行，只有写与执行类才一律拒。
            // 少了这一条，`Get-ChildItem | Format-Table` 这种纯查看也会被这档拒掉，用户要读代码都没法读。
            if (verdict !== null && verdict.decision === 'allow') {
              autoLog('auto-allow', request, '仅查看模式：只读命令放行')
              return 'allow-once'
            }
            autoLog('auto-deny', request, '当前是「仅查看」权限模式，写与执行类工具一律拒绝')
            return 'reject'
          }
          if (policy === 'full-access') {
            autoLog('auto-allow', request, '当前是「完全访问」权限模式')
            return 'allow-once'
          }
          if (policy === 'auto-edit') {
            if (PATH_WRITE_TOOLS.has(request.toolName) && insideCwd) {
              autoLog('auto-allow', request, '工作区内的文件改动，按「工作区自动编辑」放行')
              return 'allow-once'
            }
            if (verdict !== null && verdict.decision === 'allow') {
              autoLog('auto-allow', request, `只读命令：${verdict.reason}`)
              return 'allow-once'
            }
          }
          if (policy === 'ai-review') {
            const verdict2 = await aiReview(request, signal)
            if (verdict2 !== null) {
              autoLog('auto-allow', request, 'AI 审查放行')
              return verdict2
            }
          }
        }

        // 第 6 层：人工审批卡。钩子要求确认时卡片上的原因就用它，用户才知道这张卡为什么非弹不可。
        const reason =
          forced !== ''
            ? forced
            : protectedWhy !== null
              ? protectedWhy
              : (verdict?.reason ?? (insideCwd ? '工作区内的改动需要确认' : '工作区外的改动需要确认'))
        const risk: RiskLevel =
          protectedWhy !== null ? 'high' : forced !== '' ? 'medium' : verdict?.decision === 'ask' ? 'medium' : insideCwd ? 'low' : 'medium'
        const scopes: GrantScope[] = ['once']
        if (protectedWhy === null) scopes.push('session')
        if (suggested !== null && protectedWhy === null) scopes.push('always')
        // 弹卡前把「将做的改动」算好随视图下发（write/edit 才有；一次读盘 + LCS，
        // 只有真要等人点卡的时刻才付这个成本）。
        const diff = await approvalDiffOf(request)
        return askHuman(request, signal, {
          reason,
          risk,
          suggestedRule: suggested,
          scopes,
          grantKey: key,
          hardline: false,
          diff,
        })
      },

      surface(): PolicySurface {
        return { current: policy, options: [...POLICY_OPTIONS] }
      },

      pendingView() {
        // 多卡并存时取最老的一张（插入序）：答完一张，下一张自动顶上来。
        const oldest = pendings.values().next()
        return oldest.done === true ? null : oldest.value.view
      },

      answer(answer: ApprovalAnswer, source: 'app' | 'web' = 'app') {
        const oldest = pendings.values().next()
        if (oldest.done === true) return
        const current = oldest.value
        // 来源挂在挂起对象上，`done` 里落审计时取用；手机浏览器点的那一下因此查得到（source='web'）。
        current.source = source
        const finish = current.done
        if (answer === 'allow-always' && current.suggestedRule !== null) {
          appendRule({
            pattern: current.suggestedRule,
            decision: 'allow',
            justification: `用户在审批卡上选了永久允许（${current.view.toolName}）`,
          })
          reloadRules()
          audit({
            ts: Date.now(),
            kind: 'rule-added',
            tool: current.view.toolName,
            rule: current.suggestedRule,
            reason: '用户在审批卡上永久允许',
            policy,
            sessionId: current.sessionId,
            source,
          })
          finish('allow-always')
          return
        }
        if (answer === 'allow-session') {
          // 授权记在卡片所属的那个会话名下（0.6.48：卡的归属不再跟着「当前查看」走）
          const grants = sessionGrants.get(current.sessionId) ?? new Set<string>()
          grants.add(current.grantKey)
          sessionGrants.set(current.sessionId, grants)
          finish('allow-session')
          return
        }
        finish(answer === 'reject' ? 'reject' : 'allow-once')
      },
    }

    ctx.provide('approval', service)

    // 这套裁决挂在守卫链上（模式那道闸门在先，审批在後），循环因此不认识「审批」这个功能。
    ctx.guards.register(
      toolApprovalGuard({
        id: 'approval',
        approve: (input) =>
          service
            .decide(
              {
                toolName: input.toolName,
                argsSummary: argsSummary(input.args),
                args: input.args,
                cwd: input.cwd,
                // 发起调用的会话身份：授权记账、审计与卡片归属都按它（0.6.48 多 agent）
                sessionId: input.sessionId,
                sessionPath: input.sessionPath,
              },
              input.signal,
            )
            .then((decision) => decision !== 'reject'),
        // 用户点「拒绝」时回给模型的原话：老会话日志按这句话认「被拒」，不能改。
        deniedReason: REJECTED_TOOL_TEXT,
      }),
    )
    // 工具结果里的密钥形状字符串不落盘、不进上下文：遮红挂在结果观察者链上。
    const redactObserver: ToolObserver = { id: 'approval', order: 10, observe: (_toolName, text) => redact(text) }
    ctx.guards.registerObserver(redactObserver)

    ctx.surfaces.register('policy', () => service.surface())
    ctx.surfaces.register('pendingApproval', () => service.pendingView())
    ctx.waiting.register('approval', () => pendings.size > 0)

    ctx.on('dsc/mode-changed', (mode) => {
      modeForCard = mode
    })

    // 0.6.48 起切换会话不再清授权与读取台账：它们本来就按会话 id 键控，天然互不串台；
    // 后台常驻 agent 正跑着的时候清它的账，反而会把跑到一半的授权状态抹掉。

    ctx.on('dsc/exit', () => {
      for (const card of [...pendings.values()]) {
        clearTimeout(card.timer)
        card.done('reject', 'cancelled')
      }
    })
  },
}
