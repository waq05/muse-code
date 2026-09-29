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
import type { Plugin } from '@deepseek-ai/cordis'
import { streamChat } from '../core/llm.js'
import type { ApprovalDecision, ApprovalRequest } from '../core/approval.js'
import { argsSummary, callFacts } from '../core/tools.js'
import { REJECTED_TOOL_TEXT } from '../core/session.js'
import { resolvePluginConfig } from '../core/plugin-registry.js'
import { toolApprovalGuard, type ToolObserver } from '../core/tool-guards.js'
import type { ApprovalPolicy, ApprovalRequestView, ApprovalService } from '../services/types.js'
import type { ApprovalAnswer, CollaborationMode, PolicySurface, TierOption } from '../contract.js'
import { activeRules, appendRule, classifyCommand, reloadActiveRules } from '../core/command-policy.js'
import { clearReadLedger, isInsideCwd, isProtectedInstruction, writeHardBlockReason } from '../core/path-policy.js'
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
  { id: 'readonly', label: '仅查看', hint: '只读模式：写/执行类工具一律拒绝' },
  { id: 'auto-edit', label: '自动编辑', hint: '工作区内写操作自动放行，其余需审批' },
  { id: 'full-access', label: '完全访问', hint: '全部工具自动放行，谨慎使用' },
  { id: 'ai-review', label: 'AI 审查', hint: '由模型逐次判断是否放行，失败回退人工审批' },
]

/** 写类工具里「目标在工作区内就能自动放行」的那几个。 */
const PATH_WRITE_TOOLS = new Set(['write', 'edit'])

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
    let pending: {
      view: ApprovalRequestView
      grantKey: string
      suggestedRule: string[] | null
      done: (decision: ApprovalDecision, phase?: 'decided' | 'cancelled' | 'timeout') => void
      timer: NodeJS.Timeout
    } | null = null

    /** 规则文件重新读一遍（写在永久规则之后，让下一条判定立刻看到它）。 */
    const reloadRules = (): void => {
      for (const problem of reloadActiveRules().problems) ctx.emit('dsc/notice', `规则文件：${problem}`)
    }
    reloadRules()

    /** 当前会话 id（授权键与审计都挂在它下面）。 */
    const sessionId = (): string => ctx.session.current().meta.id

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
          sessionId: sessionId(),
          cwd: request.cwd,
        })
        const done = (decision: ApprovalDecision, phase: 'decided' | 'cancelled' | 'timeout' = 'decided'): void => {
          if (pending === null || pending.view.id !== id) return
          clearTimeout(pending.timer)
          pending = null
          ctx.emit('dsc/changed')
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
            sessionId: sessionId(),
          })
          resolveDone(decision)
        }
        const timer = setTimeout(() => done('reject', 'timeout'), timeoutMs())
        pending = { view, grantKey: input.grantKey, suggestedRule: input.suggestedRule, done, timer }
        ctx.emit('dsc/changed')
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
        sessionId: sessionId(),
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
        const result = await streamChat(
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
            ? '仅查看（写/执行类工具将被拒绝）'
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
        const suggested = verdict?.prefixRule ?? null
        const grants = sessionGrants.get(sessionId())
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
        return askHuman(request, signal, {
          reason,
          risk,
          suggestedRule: suggested,
          scopes,
          grantKey: key,
          hardline: false,
        })
      },

      surface(): PolicySurface {
        return { current: policy, options: [...POLICY_OPTIONS] }
      },

      pendingView() {
        return pending?.view ?? null
      },

      answer(answer: ApprovalAnswer) {
        const current = pending
        if (current === null) return
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
            sessionId: sessionId(),
          })
          finish('allow-always')
          return
        }
        if (answer === 'allow-session') {
          const id = sessionId()
          const grants = sessionGrants.get(id) ?? new Set<string>()
          grants.add(current.grantKey)
          sessionGrants.set(id, grants)
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
              { toolName: input.toolName, argsSummary: argsSummary(input.args), args: input.args, cwd: input.cwd },
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
    ctx.waiting.register('approval', () => pending !== null)

    ctx.on('dsc/mode-changed', (mode) => {
      modeForCard = mode
    })

    ctx.on('dsc/session-open', () => {
      // 会话级授权不跨会话生效（Hermes 的 _session_yolo 也是按会话 id 键控的）。
      sessionGrants.clear()
      // 「先读过才许改」的账本也一样按会话算：换了会话就得重新读一遍那个文件。
      clearReadLedger()
    })
    ctx.on('dsc/exit', () => {
      if (pending !== null) {
        const current = pending
        pending = null
        clearTimeout(current.timer)
        current.done('reject', 'cancelled')
      }
    })
  },
}
