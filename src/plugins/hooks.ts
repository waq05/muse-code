/**
 * hooks 插件：把用户自己登记的规则与脚本挂到工具守卫链上，作为「防手滑」的那一道闸。
 *
 * 挂在 order 20：协作模式（10）先决定这一轮允许把手伸多远，这里按用户的规矩拦或提醒，
 * 审批（30）最后决定「问出来之后怎么裁」。三道闸互不认识。
 *
 * 三种后果各走各的路：
 *   拦下来 —— 守卫返回 deny，原因原样回给模型，模型看得见为什么被拦；
 *   问一人 —— 带着原因去叫审批卡（`ctx.approval.decide` 的 forceAskReason），
 *             当前权限模式本来会自动放行也照样弹；人批了就返回 pass（这一次不再追问），
 *             人否了返回 deny；
 *   只留话 —— 不拦，把脚本给的那句话写进会话。
 *
 * 每条结论（包括脚本没跑成按拦处理的）都落一行 `~/.dsc/audit.jsonl`，种类是 `hook`。
 *
 * @module dsc/plugins/hooks
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { audit, readAudit } from '../core/audit.js'
import { POLICY_RULES_FILE } from '../core/command-policy.js'
import {
  addRule,
  addScript,
  hookFacts,
  hookReasonForModel,
  HOOKS_FILE,
  HOOK_PATTERN_MAX,
  HOOK_REASON_MAX,
  HOOK_TIMEOUT_MAX,
  HOOK_TIMEOUT_MIN,
  HOOK_TRUST_FILE,
  judgeScriptRun,
  matcherHits,
  patchHookSettings,
  readHooks,
  removeRule,
  removeScript,
  ruleHits,
  ruleJudgement,
  runHookScript,
  setRuleEnabled,
  setScriptEnabled,
  strongestJudgement,
  trustOf,
  trustScript,
  untrustScript,
} from '../core/hooks.js'
import type { HookEvent, HookJudgement, HookRuleAction, HookRuleField, HookScript } from '../core/hooks.js'
import type { ToolGuard, ToolGuardInput } from '../core/tool-guards.js'
import { argsSummary } from '../core/tools.js'
import type { SettingsField, SettingsOption, SettingsValues } from '../contract.js'
import type { HookService, SettingsSectionSpec } from '../services/types.js'

/** 事件名 → 界面上的中文说法（下拉与详情行都用它，两处不会写岔）。 */
const EVENT_LABELS: Record<HookEvent, string> = {
  'pre-tool': '工具动手之前（能拦）',
  'post-tool': '工具干完之后（只观察）',
  'session-start': '会话开始（只观察）',
  'turn-end': '一轮结束（只观察）',
}

/** 规则要比对的字段 → 界面说法。 */
const FIELD_LABELS: Record<HookRuleField, string> = {
  command: '命令原文（bash 跑的那句话）',
  target: '要动的文件路径',
  args: '工具参数（整个 JSON）',
  any: '上面三样都看',
}

/** 规则动作 → 界面说法。 */
const ACTION_LABELS: Record<HookRuleAction, string> = {
  deny: '直接拦下',
  ask: '弹审批卡问人',
}

const FIELD_OPTIONS: SettingsOption[] = optionsOf(['command', 'target', 'args', 'any'] as const, (field) => FIELD_LABELS[field])

const ACTION_OPTIONS: SettingsOption[] = optionsOf(['deny', 'ask'] as const, (action) => ACTION_LABELS[action])

const EVENT_OPTIONS: SettingsOption[] = optionsOf(
  ['pre-tool', 'post-tool', 'session-start', 'turn-end'] as const,
  (event) => EVENT_LABELS[event],
)

/** 设置页表单里那些「还没提交」的输入框的内容（存内存，不落盘）。 */
interface HookForm {
  ruleId: string
  scriptId: string
  ruleTool: string
  ruleField: HookRuleField
  ruleAction: HookRuleAction
  rulePattern: string
  ruleReason: string
  scriptEvent: HookEvent
  scriptMatcher: string
  scriptCommand: string
}

const EMPTY_FORM: HookForm = {
  ruleId: '',
  scriptId: '',
  ruleTool: '*',
  ruleField: 'any',
  ruleAction: 'ask',
  rulePattern: '',
  ruleReason: '',
  scriptEvent: 'pre-tool',
  scriptMatcher: '*',
  scriptCommand: '',
}

/** 把事件、字段这类常量拼成下拉要的选项清单。 */
function optionsOf<T extends string>(values: readonly T[], label: (value: T) => string): SettingsOption[] {
  return values.map((value) => ({ value, label: label(value) }))
}

export const hooksPlugin: Plugin.Object = {
  name: 'hooks',
  inject: ['session', 'approval', 'guards', 'settings', 'transcript', 'commands'],
  provide: 'hooks',
  apply(ctx) {
    const form: HookForm = { ...EMPTY_FORM }
    /** 已经提醒过的「这条脚本不能跑」，同一个状态只提醒一次，免得每次工具调用都刷屏。 */
    const warned = new Set<string>()

    const sessionId = (): string => ctx.session.current().meta.id

    /** 落一条钩子审计：谁在什么工具上给了什么结论，一眼能查。 */
    const auditHook = (judgement: HookJudgement, input: ToolGuardInput, decision?: 'blocked' | 'reject' | 'allow-once'): void => {
      audit({
        ts: Date.now(),
        kind: 'hook',
        tool: input.toolName,
        summary: argsSummary(input.args ?? {}).slice(0, 200),
        reason: `${judgement.action}｜${judgement.problem === '' ? judgement.message : judgement.problem}`,
        rule: [judgement.source],
        policy: ctx.approval.policy,
        sessionId: sessionId(),
        cwd: input.cwd,
        decision,
      })
    }

    /** 拼递给脚本的 stdin 载荷。 */
    const payloadOf = (
      event: HookEvent,
      input: { toolName: string; args: Record<string, unknown>; cwd: string; command: string; target: string },
      extra: Record<string, unknown>,
    ): import('../core/hooks.js').HookPayload => ({
      hook_event_name: event,
      tool_name: input.toolName,
      tool_input: input.args,
      args_summary: argsSummary(input.args).slice(0, 200),
      session_id: sessionId(),
      cwd: input.cwd,
      policy: ctx.approval.policy,
      mode: '',
      command: input.command,
      target: input.target,
      extra,
    })

    /**
     * 跑一批观察者事件上的脚本（工具干完之后、会话开始、一轮结束）。
     *
     * 这些事件改不了已经发生的事，所以脚本的结论只有两种用法：把话留在会话里，或者什么也不做。
     * 异步跑，不挡用户的手：观察用的钩子不该让工具调用多等一秒。
     */
    const fireObserve = (
      event: Exclude<HookEvent, 'pre-tool'>,
      input: { toolName: string; args: Record<string, unknown>; cwd: string; command?: string; target?: string },
      extra: Record<string, unknown>,
    ): void => {
      const doc = readHooks()
      if (!doc.settings.enabled) return
      const scripts = doc.scripts.filter(
        (script) => script.enabled && script.event === event && matcherHits(script.matcher, input.toolName),
      )
      for (const script of scripts) {
        const trust = trustOf(script, doc.settings.autoAccept)
        if (!trust.runnable) {
          warnUntrusted(script, trust)
          continue
        }
        void runHookScript(script, payloadOf(event, { ...input, command: input.command ?? '', target: input.target ?? '' }, extra), input.cwd, new AbortController().signal, doc.settings.scriptTimeoutMs)
          .then((run) => {
            const judgement = judgeScriptRun(run, script, doc.settings)
            audit({
              ts: Date.now(),
              kind: 'hook',
              tool: input.toolName,
              reason: `${judgement.action}｜${judgement.problem === '' ? judgement.message : judgement.problem}`,
              rule: [judgement.source],
              policy: ctx.approval.policy,
              sessionId: sessionId(),
              cwd: input.cwd,
            })
            if (judgement.action === 'note' && judgement.message !== '') {
              ctx.emit('dsc/notice', `钩子（${EVENT_LABELS[event]}）：${judgement.message}`)
            } else if (judgement.problem !== '') {
              ctx.emit('dsc/notice', `钩子脚本没跑好：${judgement.problem}`)
            }
          })
          .catch((error: unknown) => {
            ctx.emit('dsc/notice', `钩子脚本执行出错：${error instanceof Error ? error.message : String(error)}`)
          })
      }
    }

    /** 「这条脚本没批准 / 脚本改过了」的提示，每个状态只说一次。 */
    const warnUntrusted = (script: HookScript, trust: ReturnType<typeof trustOf>): void => {
      const key = `${script.id}:${trust.state}`
      if (warned.has(key)) return
      warned.add(key)
      ctx.emit('dsc/notice', `安全钩子有一条没生效：${trust.detail}（命令：${script.command.slice(0, 60)}）`)
    }

    /** 一次工具调用命中了哪些启用中的规则（不跑脚本）。 */
    const hitRules = (input: ToolGuardInput): HookJudgement[] => {
      const doc = readHooks()
      const facts = hookFacts(input)
      return doc.rules.filter((rule) => rule.enabled && ruleHits(rule, facts)).map(ruleJudgement)
    }

    const guard: ToolGuard = {
      id: 'hooks',
      order: 20,
      async decide(input) {
        const doc = readHooks()
        if (!doc.settings.enabled) return { action: 'defer' }
        const judgements = hitRules(input)
        const scripts = doc.scripts.filter(
          (script) => script.enabled && script.event === 'pre-tool' && matcherHits(script.matcher, input.toolName),
        )
        for (const script of scripts) {
          const trust = trustOf(script, doc.settings.autoAccept)
          if (!trust.runnable) {
            warnUntrusted(script, trust)
            continue
          }
          const facts = hookFacts(input)
          const run = await runHookScript(
            script,
            payloadOf('pre-tool', { toolName: input.toolName, args: input.args, cwd: input.cwd, command: facts.command, target: facts.target }, {}),
            input.cwd,
            input.signal,
            doc.settings.scriptTimeoutMs,
          )
          const judgement = judgeScriptRun(run, script, doc.settings)
          judgements.push(judgement)
        }

        const best = strongestJudgement(judgements)
        if (best === null || best.action === 'pass') return { action: 'defer' }
        if (best.action === 'note') {
          auditHook(best, input)
          if (best.message !== '') ctx.emit('dsc/notice', `安全钩子留了一句：${best.message}`)
          return { action: 'defer' }
        }
        if (best.action === 'block') {
          auditHook(best, input, 'blocked')
          return { action: 'deny', reason: hookReasonForModel(best, '这次操作被安全钩子拦下') }
        }
        // ask：叫一张必须有人答的卡。权限模式本来会自动放行也照样弹，
        // 因为这条规矩是用户自己加的，比模式档位更具体。
        const decision = await ctx.approval.decide(
          { toolName: input.toolName, argsSummary: argsSummary(input.args), args: input.args, cwd: input.cwd },
          input.signal,
          { forceAskReason: best.message },
        )
        if (decision === 'reject') {
          auditHook(best, input, 'reject')
          return { action: 'deny', reason: hookReasonForModel(best, '钩子要求确认，用户否掉了这次操作') }
        }
        auditHook(best, input, 'allow-once')
        // 人已经看过这一次了，别再让审批环节问第二遍。
        return { action: 'pass' }
      },
    }

    /** 工具结果加工位上的观察：只负责把结果交给 post-tool 脚本，文本原样返回。 */
    const observer = {
      id: 'hooks',
      order: 40,
      observe(toolName: string, text: string): string {
        fireObserve('post-tool', { toolName, args: {}, cwd: ctx.session.current().meta.cwd }, { result: text.slice(0, 4000) })
        return text
      },
    }

    const service: HookService = {
      doc: () => readHooks(),
      trustOf(id) {
        const script = readHooks().scripts.find((item) => item.id === id)
        return script === undefined ? null : trustOf(script, readHooks().settings.autoAccept)
      },
      previewRules(input) {
        return hitRules({
          toolName: input.toolName,
          risk: 'read',
          cwd: ctx.session.current().meta.cwd,
          args: input.args ?? {},
          command: input.command,
          target: input.target,
          signal: new AbortController().signal,
        })
      },
      recent(limit = 8) {
        return readAudit(400)
          .filter((record) => record.kind === 'hook')
          .slice(0, limit)
      },
    }

    const offGuard = ctx.guards.register(guard)
    const offObserver = ctx.guards.registerObserver(observer)
    ctx.provide('hooks', service)

    ctx.commands.register({ name: 'hooks', args: '', description: '看安全钩子的状态（规则、脚本、批准情况）' }, ({ ui }) => {
      const doc = readHooks()
      const lines: string[] = []
      lines.push(`安全钩子：${doc.settings.enabled ? '开着' : '关着'}｜规则 ${doc.rules.length} 条（启用 ${doc.rules.filter((rule) => rule.enabled).length}）｜脚本 ${doc.scripts.length} 条`)
      for (const script of doc.scripts) {
        const trust = trustOf(script, doc.settings.autoAccept)
        lines.push(`  脚本[${EVENT_LABELS[script.event]}] ${script.command.slice(0, 60)} —— ${script.enabled ? trust.detail : '已停用'}`)
      }
      for (const problem of doc.problems) lines.push(`  ⚠ ${problem}`)
      ui.notice(lines.join('\n'))
    })

    // ── 设置分区 ──────────────────────────────────────────────────────────────

    /** 选中项的定位：选中的被删了就自动落到清单第一条。 */
    const currentRule = () => {
      const rules = readHooks().rules
      const found = rules.find((rule) => rule.id === form.ruleId) ?? rules[0]
      form.ruleId = found?.id ?? ''
      return found ?? null
    }
    const currentScript = () => {
      const scripts = readHooks().scripts
      const found = scripts.find((script) => script.id === form.scriptId) ?? scripts[0]
      form.scriptId = found?.id ?? ''
      return found ?? null
    }

    function fields(): SettingsField[] {
      const doc = readHooks()
      const rule = currentRule()
      const script = currentScript()
      const list: SettingsField[] = [
        {
          type: 'switch',
          key: 'enabled',
          label: '启用安全钩子',
          help: '关掉之后规则和脚本都不再执行（配置保留着，随时能开回来）。',
        },
        {
          type: 'switch',
          key: 'scriptFailClosed',
          label: '脚本没跑成就算拦',
          help: '脚本超时、命令起不来、输出看不懂时按「拦下来」处理。关掉就退回「跑不成当没这条钩子」——出了事更难查，建议留着。',
        },
        {
          type: 'number',
          key: 'scriptTimeoutMs',
          label: '脚本缺省超时（毫秒）',
          min: HOOK_TIMEOUT_MIN,
          max: HOOK_TIMEOUT_MAX,
          step: 500,
          help: `钩子脚本是闸门不是后台任务，超过这个时间就被杀掉。范围 ${HOOK_TIMEOUT_MIN}~${HOOK_TIMEOUT_MAX} 毫秒。`,
        },
        {
          type: 'switch',
          key: 'autoAccept',
          label: '新加的脚本不再询问就执行',
          help: '等于把一个「执行任意代码」的入口完全交给这个配置文件。除非你在自动化里用，否则别开。',
        },
      ]
      if (doc.problems.length > 0) {
        list.push({
          type: 'info',
          label: '配置有问题',
          text: doc.problems.join('；'),
          help: '坏掉的条目被跳过了，其余规则照样生效。',
        })
      }

      // 规则区：一张清单 + 一条添加表单。清单太长时下拉自己会滚动，这里不截断。
      list.push(
        {
          type: 'info',
          label: '界面规则',
          text: `已登记 ${doc.rules.length} 条（最多 200 条）。规则只看「哪个工具、哪个字段、命中什么模式」，不启动任何进程。`,
        },
        {
          type: 'select',
          key: 'ruleId',
          label: '选一条规则',
          options:
            doc.rules.length === 0
              ? [{ value: '', label: '（还没有规则，用下面四个框加一条）' }]
              : doc.rules.map((item) => ({
                  value: item.id,
                  label: `${item.enabled ? '' : '［已停用］'}${ACTION_LABELS[item.action]}｜${item.tool} /${item.pattern}/`,
                })),
        },
        { type: 'switch', key: 'ruleEnabled', label: '启用选中的这条规则' },
        { type: 'button', action: 'ruleDelete', label: '删除选中的这条规则', style: 'ghost' },
        {
          type: 'text',
          key: 'ruleTool',
          label: '新规则：管哪些工具',
          placeholder: '* 或 bash 或 bash|write|edit',
          mono: true,
          help: '填 * 管所有工具；多个工具用竖线或逗号隔开，工具名不区分大小写。',
        },
        { type: 'select', key: 'ruleField', label: '新规则：看哪个字段', options: FIELD_OPTIONS },
        {
          type: 'text',
          key: 'rulePattern',
          label: '新规则：命中什么算（正则，不区分大小写）',
          placeholder: 'git\\s+push.*(-f|--force)|\\.env$',
          mono: true,
          help: `按正则的一部分匹配（不用整串吻合）。最长 ${HOOK_PATTERN_MAX} 字，写错正则会当场告诉你。`,
        },
        { type: 'select', key: 'ruleAction', label: '新规则：命中之后怎么办', options: ACTION_OPTIONS },
        {
          type: 'text',
          key: 'ruleReason',
          label: '新规则：说给模型和用户的理由',
          placeholder: '强推会覆盖别人的提交，必须用户本人确认',
          help: `这句话会原样出现在被拦下的那次工具结果里，模型就靠它改道。最长 ${HOOK_REASON_MAX} 字。`,
        },
        { type: 'button', action: 'ruleAdd', label: '加进规则表', style: 'primary' },
        {
          type: 'info',
          label: '选哪条',
          text: `${rule === undefined || rule === null ? '规则表还是空的' : `${ACTION_LABELS[rule.action]}｜${rule.tool}｜${FIELD_LABELS[rule.field]}｜/${rule.pattern}/｜${rule.reason === '' ? '（没写理由）' : rule.reason}`}`,
        },
      )

      // 脚本区
      const scriptTrust = script === undefined || script === null ? null : trustOf(script, doc.settings.autoAccept)
      list.push(
        {
          type: 'info',
          label: '脚本钩子',
          text: `已登记 ${doc.scripts.length} 条（最多 50 条）。脚本的 stdin 会收到这次调用的 JSON，用退出码 2 或 stdout 的 JSON 回话。`,
        },
        {
          type: 'select',
          key: 'scriptId',
          label: '选一条脚本',
          options:
            doc.scripts.length === 0
              ? [{ value: '', label: '（还没有脚本，用下面三个框加一条）' }]
              : doc.scripts.map((item) => ({
                  value: item.id,
                  label: `${item.enabled ? '' : '［已停用］'}[${EVENT_LABELS[item.event]}] ${item.command.slice(0, 48)}`,
                })),
        },
        { type: 'switch', key: 'scriptEnabled', label: '启用选中的这条脚本' },
        {
          type: 'info',
          label: '这条脚本现在的状态',
          text: scriptTrust === null ? '（没选中脚本）' : scriptTrust.detail,
        },
        {
          type: 'button',
          action: 'scriptTrust',
          label: scriptTrust !== null && scriptTrust.state === 'trusted' ? '照现在的脚本内容重新批准一次' : '批准这条脚本',
          style: scriptTrust !== null && scriptTrust.state === 'trusted' ? 'ghost' : 'primary',
          help: '批准之后会记住脚本文件当时的修改时间：脚本内容一改，这条钩子就停止执行并要求重新批准。',
        },
        { type: 'button', action: 'scriptUntrust', label: '撤销批准', style: 'ghost' },
        { type: 'button', action: 'scriptDelete', label: '删除选中的这条脚本', style: 'ghost' },
        { type: 'select', key: 'scriptEvent', label: '新脚本：挂在哪个事件上', options: EVENT_OPTIONS },
        {
          type: 'text',
          key: 'scriptMatcher',
          label: '新脚本：只管哪些工具（正则）',
          placeholder: '* 或 bash|write',
          mono: true,
          help: '只有「工具动手之前」和「工具干完之后」两个事件看这个框，其余事件每次都跑。',
        },
        {
          type: 'text',
          key: 'scriptCommand',
          label: '新脚本：命令',
          placeholder: 'node C:\\Users\\me\\.dsc\\hooks\\guard.js',
          mono: true,
          help: '交给 shell 执行，所以带参数、带管道都能写。子进程环境里的凭据已被剥掉。',
        },
        { type: 'button', action: 'scriptAdd', label: '加进脚本表', style: 'primary' },
      )

      const recent = service.recent(5)
      list.push({
        type: 'info',
        label: '最近命中',
        text:
          recent.length === 0
            ? '还没有钩子说过话。'
            : recent
                .map((record) => `${new Date(record.ts).toLocaleTimeString()} ${record.tool ?? ''} ${record.reason ?? ''}`)
                .join('\n'),
      })
      list.push(
        {
          type: 'info',
          label: '配置文件',
          text: HOOKS_FILE,
          mono: true,
          copyable: true,
          help: '规则与脚本都存在这里；手改这个文件也生效，下一次工具调用就用新内容。',
        },
        { type: 'info', label: '脚本批准名单', text: HOOK_TRUST_FILE, mono: true, copyable: true },
        {
          type: 'info',
          label: '跟命令危险等级规则的分工',
          text: POLICY_RULES_FILE,
          mono: true,
          copyable: true,
          help: '那份文件管「某条命令算几危险」（只认 bash 的命令文本，能写允许）；这里的钩子管所有工具，且只能加严不能放宽。要放宽请去那份文件写前缀规则。',
        },
      )
      return list
    }

    const section: SettingsSectionSpec = {
      id: 'hooks',
      title: '安全钩子',
      subtitle: '工具动手之前按你自己定的规矩拦一道',
      order: 34,
      fields,
      values(): SettingsValues {
        const doc = readHooks()
        const rule = currentRule()
        const script = currentScript()
        return {
          enabled: doc.settings.enabled,
          scriptFailClosed: doc.settings.scriptFailClosed,
          scriptTimeoutMs: doc.settings.scriptTimeoutMs,
          autoAccept: doc.settings.autoAccept,
          ruleId: form.ruleId,
          ruleEnabled: rule?.enabled ?? false,
          ruleTool: form.ruleTool,
          ruleField: form.ruleField,
          ruleAction: form.ruleAction,
          rulePattern: form.rulePattern,
          ruleReason: form.ruleReason,
          scriptId: form.scriptId,
          scriptEnabled: script?.enabled ?? false,
          scriptEvent: form.scriptEvent,
          scriptMatcher: form.scriptMatcher,
          scriptCommand: form.scriptCommand,
        }
      },
      save(key, value): string | void {
        const text = typeof value === 'string' ? value : String(value)
        switch (key) {
          case 'enabled':
            patchHookSettings({ enabled: value === true })
            return
          case 'scriptFailClosed':
            patchHookSettings({ scriptFailClosed: value === true })
            return
          case 'autoAccept':
            patchHookSettings({ autoAccept: value === true })
            return
          case 'scriptTimeoutMs': {
            const num = Number(value)
            if (!Number.isFinite(num)) return '这里要填一个数字（毫秒）'
            patchHookSettings({ scriptTimeoutMs: num })
            return
          }
          case 'ruleId':
            form.ruleId = text
            return
          case 'scriptId':
            form.scriptId = text
            return
          case 'ruleEnabled': {
            const rule = currentRule()
            if (rule === null) return '规则表是空的，没有可启停的规则'
            setRuleEnabled(rule.id, value === true)
            return
          }
          case 'scriptEnabled': {
            const script = currentScript()
            if (script === null) return '脚本表是空的，没有可启停的脚本'
            setScriptEnabled(script.id, value === true)
            return
          }
          case 'ruleTool':
            form.ruleTool = text
            return
          case 'ruleField':
            form.ruleField = (['command', 'target', 'args', 'any'] as const).includes(text as HookRuleField)
              ? (text as HookRuleField)
              : 'any'
            return
          case 'ruleAction':
            form.ruleAction = text === 'deny' ? 'deny' : 'ask'
            return
          case 'rulePattern':
            form.rulePattern = text
            return
          case 'ruleReason':
            form.ruleReason = text
            return
          case 'scriptEvent':
            form.scriptEvent = (['pre-tool', 'post-tool', 'session-start', 'turn-end'] as const).includes(text as HookEvent)
              ? (text as HookEvent)
              : 'pre-tool'
            return
          case 'scriptMatcher':
            form.scriptMatcher = text
            return
          case 'scriptCommand':
            form.scriptCommand = text
            return
          default:
            return `这个分区没有这项：${key}`
        }
      },
      action(name): string | void {
        switch (name) {
          case 'ruleAdd': {
            const result = addRule({
              tool: form.ruleTool,
              field: form.ruleField,
              pattern: form.rulePattern,
              action: form.ruleAction,
              reason: form.ruleReason,
            })
            if (!result.ok) return result.error
            form.ruleId = result.id
            form.rulePattern = ''
            form.ruleReason = ''
            ctx.emit('dsc/changed')
            return '规则已加进表里（默认启用）'
          }
          case 'ruleDelete': {
            const rule = currentRule()
            if (rule === null) return '规则表是空的'
            removeRule(rule.id)
            form.ruleId = ''
            ctx.emit('dsc/changed')
            return '规则已删除'
          }
          case 'scriptAdd': {
            const result = addScript({
              event: form.scriptEvent,
              matcher: form.scriptMatcher,
              command: form.scriptCommand,
            })
            if (!result.ok) return result.error
            form.scriptId = result.id
            form.scriptCommand = ''
            ctx.emit('dsc/changed')
            return readHooks().settings.autoAccept
              ? '脚本已加入。因为开着「新脚本不再询问」，它会直接执行'
              : '脚本已加入，但还没执行过：在详情里点一次「批准这条脚本」才会生效'
          }
          case 'scriptDelete': {
            const script = currentScript()
            if (script === null) return '脚本表是空的'
            removeScript(script.id)
            untrustScript(script.id)
            form.scriptId = ''
            ctx.emit('dsc/changed')
            return '脚本已删除，批准记录也一并撤掉了'
          }
          case 'scriptTrust': {
            const script = currentScript()
            if (script === null) return '脚本表是空的'
            return trustScript(script.id) ?? '已批准，这条脚本现在会执行'
          }
          case 'scriptUntrust': {
            const script = currentScript()
            if (script === null) return '脚本表是空的'
            untrustScript(script.id)
            return '已撤销批准：这条脚本在重新批准之前不会执行'
          }
          default:
            return `这个分区没有这个按钮：${name}`
        }
      },
    }
    const offSection = ctx.settings.registerSection(section)

    ctx.on('dsc/session-open', ({ session }) => {
      warned.clear()
      fireObserve(
        'session-start',
        { toolName: '', args: {}, cwd: session.meta.cwd },
        { session_id: session.meta.id },
      )
    })
    ctx.on('dsc/turn-end', (reason) => {
      fireObserve('turn-end', { toolName: '', args: {}, cwd: ctx.session.current().meta.cwd }, { reason })
    })

    return () => {
      offSection()
      offObserver()
      offGuard()
    }
  },
}
