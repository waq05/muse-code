/**
 * lifecycle-hooks 插件（官方可开关）：把 codex 那十二个生命周期事件名接到 dsc 的扩展点上。
 *
 * 与内置的「安全钩子」（`plugins/hooks.ts`，读 `~/.dsc/hooks.json`）是两回事：
 * 那个是 dsc 自己的四个事件，这个是 codex 的十二个名字，配置在
 * `~/.dsc/lifecycle-hooks.json`，**两份配置各读各的**。两者会同时挂在守卫链上（安全钩子 20、
 * 这里 25，都在审批 30 之前），互不认识。
 *
 * 挂法（每条事件为什么只能做到这个档，见 `core/lifecycle-hooks.ts` 的能力表）：
 *   PreToolUse       → 守卫 order 25，可 deny；
 *   PostToolUse      → 观察者 order 45（同步点，钩子挂后台跑，话进下一次请求）；
 *   SessionStart     → `dsc/session-open` + 请求末尾补 system；
 *   UserPromptSubmit → 在 user-prompt-submit 投影里认出新的用户消息；
 *   PostCompact      → `dsc/compacted`；
 *   Stop / Interrupt → `dsc/turn-end` 的 completed / aborted；
 *   SessionEnd       → `dsc/exit`（退出不等钩子跑完）；
 *   其余四个（PermissionRequest / PreCompact / SubagentStart / SubagentStop）dsc 没有对应扩展点，
 *   配了也不执行，只把原因写进能力清单的 problems。
 *
 * 钩子脚本的话进模型之前一律过 `wrapUntrusted`（来源 `hook:<事件名>`），
 * 它说的话是数据，不是指令。
 *
 * @module dsc/plugins/lifecycle-hooks
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { HOOK_TIMEOUT_MAX, HOOK_TIMEOUT_MIN } from '../core/hooks.js'
import {
  commandAllowed,
  denyReasonFor,
  judgeBlockedByAllowlist,
  judgeLifecycleRun,
  lifecycleReport,
  readLifecycleDoc,
  resolveLifecycleConfig,
  runLifecycleCommand,
  subjectHits,
  wrapHookOutput,
} from '../core/lifecycle-hooks.js'
import type { LifecycleEvent, LifecycleHooksConfig, LifecyclePayload } from '../core/lifecycle-hooks.js'
import { contentText } from '../core/llm.js'
import type { ChatMessage } from '../core/llm.js'
import { writePluginConfig } from '../core/plugin-registry.js'
import type { ToolGuard, ToolGuardInput, ToolObserver } from '../core/tool-guards.js'
import type { HookJudgement } from '../core/hooks.js'
import type { SettingsField, SettingsValue } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'

/** 插件在条目树里的键，也是设置分区 id。 */
const CONFIG_KEY = 'lifecycle-hooks'

/** 事件档位在界面上的说法。 */
const TIER_LABELS = { wired: '已接通', partial: '部分接通', unwired: '未接通' } as const

/** 载荷里除公共字段之外、由各事件自己补的那部分。 */
type PayloadExtra = Omit<
  Partial<LifecyclePayload>,
  'session_id' | 'transcript_path' | 'cwd' | 'hook_event_name' | 'model' | 'permission_mode'
>

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const lifecycleHooksPlugin: Plugin.Object = {
  name: 'lifecycle-hooks',
  inject: ['session', 'llm', 'approval', 'guards', 'prompt', 'settings', 'commands'],
  apply(ctx, passed) {
    /** 每次都现读：设置里改完不必重启宿主。 */
    const config = (): LifecycleHooksConfig => resolveLifecycleConfig(passed)
    const cwdOf = (): string => ctx.session.current().meta.cwd
    /** 后台跑的钩子统一挂这个信号：插件卸载时一起掐掉，不留悬挂的子进程。 */
    const lifetime = new AbortController()
    /** 攒着等下一次请求的围栏文本（只能「留话」的那几类事件都往这儿放）。 */
    let pending: string[] = []
    /** 上一次见过的用户消息原文：变了才算新提交，同一轮里问一次不重复触发。 */
    let lastPrompt = ''
    /** 同一句提示只说一次，不然每次工具调用都刷屏。 */
    const announced = new Set<string>()

    const notify = (key: string, text: string): void => {
      if (announced.has(key)) return
      announced.add(key)
      ctx.emit('dsc/notice', text)
    }

    /** 载荷的公共字段，字段名照 codex。 */
    const basePayload = (event: LifecycleEvent, cwd: string): LifecyclePayload => ({
      session_id: ctx.session.current().meta.id,
      // dsc 的 Session 上取不到自己的 jsonl 路径，这一项恒为 null（钩子脚本读它是 null，不是空串）
      transcript_path: null,
      cwd,
      hook_event_name: event,
      model: ctx.llm.model,
      permission_mode: ctx.approval.policy,
    })

    /**
     * 跑一条事件上全部命中的钩子，按配置里的顺序依次跑完（不并行：这些命令要读同一份现场）。
     * 只执行与裁决，不碰上下文——调用方决定结论怎么用。
     */
    const runHooks = async (
      event: LifecycleEvent,
      subject: string,
      extra: PayloadExtra,
      cwd: string,
      signal: AbortSignal,
    ): Promise<HookJudgement[]> => {
      const cfg = config()
      if (!cfg.enabled) return []
      const judgements: HookJudgement[] = []
      for (const hook of readLifecycleDoc(cfg.configPath).hooks) {
        if (!hook.enabled || hook.event !== event) continue
        if (!subjectHits(event, hook.matcher, subject)) continue
        if (!commandAllowed(hook.command, cfg.commandAllowlist)) {
          const blocked = judgeBlockedByAllowlist(hook, cfg)
          notify(`allowlist:${hook.id}`, `生命周期钩子（${event}）有一条没生效：${blocked.problem}`)
          judgements.push(blocked)
          continue
        }
        const run = await runLifecycleCommand(
          hook.command,
          hook.timeoutMs > 0 ? hook.timeoutMs : cfg.timeoutMs,
          { ...basePayload(event, cwd), ...extra },
          cwd,
          signal,
        )
        judgements.push(judgeLifecycleRun(run, hook, cfg))
      }
      return judgements
    }

    /** 只能「留话」的事件：把裁决里的话与毛病收下（话等下一次请求带出去）。 */
    const absorb = (event: LifecycleEvent, judgements: readonly HookJudgement[]): void => {
      for (const judgement of judgements) {
        if (judgement.problem !== '') notify(`${event}:${judgement.source}:${judgement.problem}`, `生命周期钩子（${event}）没跑好：${judgement.problem}`)
        if (judgement.message !== '') pending.push(wrapHookOutput(event, judgement.message))
      }
    }

    /** 后台跑一条观察型事件，不挡当前这一步。 */
    const fire = (event: LifecycleEvent, subject: string, extra: PayloadExtra, cwd = cwdOf()): void => {
      void runHooks(event, subject, extra, cwd, lifetime.signal)
        .then((judgements) => absorb(event, judgements))
        .catch((error: unknown) => {
          // runHooks 自己把所有执行失败都摊在返回值里，走到这儿的是读配置之类的意外：说一句，别变成未处理的拒绝
          notify(`fire:${event}`, `生命周期钩子（${event}）执行出错：${errText(error)}`)
        })
    }

    /** 最后一条 assistant 消息的正文（Stop 事件要带上它，钩子才知道刚说完什么）。 */
    const lastAssistantText = (): string | null => {
      const messages = ctx.session.current().messages
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!
        if (message.role === 'assistant') return contentText(message.content)
      }
      return null
    }

    // ── PreToolUse：守卫 order 25（协作模式 10 之后、审批 30 之前） ──────────────

    const guard: ToolGuard = {
      id: 'lifecycle-hooks',
      order: 25,
      async decide(input: ToolGuardInput) {
        if (!config().enabled) return { action: 'defer' }
        const judgements = await runHooks(
          'PreToolUse',
          input.toolName,
          { tool_name: input.toolName, tool_input: input.args },
          input.cwd,
          input.signal,
        )
        for (const judgement of judgements) {
          if (judgement.problem !== '') notify(`PreToolUse:${judgement.source}:${judgement.problem}`, `生命周期钩子（PreToolUse）没跑好：${judgement.problem}`)
        }
        const blocker = judgements.find((judgement) => judgement.action === 'block')
        if (blocker !== undefined) return { action: 'deny', reason: denyReasonFor('PreToolUse', blocker) }
        const asker = judgements.find((judgement) => judgement.action === 'ask')
        if (asker !== undefined) {
          // 这个位置在审批环节之前，没有卡可弹；钩子要人确认就先按拒绝回话，让模型去问用户
          return {
            action: 'deny',
            reason: denyReasonFor('PreToolUse', {
              ...asker,
              message: `钩子要求有人确认，但工具动手之前这个位置没有审批卡可弹，先按拒绝处理。${asker.message}`,
            }),
          }
        }
        for (const judgement of judgements) {
          if (judgement.action === 'note' && judgement.message !== '') pending.push(wrapHookOutput('PreToolUse', judgement.message))
        }
        return { action: 'defer' }
      },
    }

    // ── PostToolUse：观察者 order 45（同步点，钩子挂后台，话进下一次请求） ───────

    const observer: ToolObserver = {
      id: 'lifecycle-hooks',
      order: 45,
      observe(toolName: string, text: string): string {
        fire('PostToolUse', toolName, { tool_name: toolName, tool_response: text })
        return text
      },
    }

    // ── 请求组装：UserPromptSubmit 认新消息 + 把攒下的话补在末尾 ─────────────────

    // 钩子产出不在会话日志里，塞进请求的同时必须落一条 note（Model-visible ⟺ logged）：
    // 只投给主会话——队友的请求不走投影链，不会错拿主会话的 pending。
    const offProjection = ctx.prompt.registerProjection('user-prompt-submit', (messages: ChatMessage[]): ChatMessage[] => {
      submitIfNewPrompt(messages)
      if (pending.length === 0) return messages
      const blocks = pending
      pending = []
      // 补在末尾、user 角色（2026-10-03）：system 段会被 fold-system 并进头部、改写前缀缓存；
      // user 只往历史尾巴追加。内容自带 <external_content source="hook:…"> 围栏，出处已标明。
      ctx.session.current().appendNote('lifecycle-hooks', blocks.join('\n\n'))
      return [...messages, { role: 'user', content: blocks.join('\n\n') }]
    })

    /** 认出这次请求里新的那条用户消息，跑一遍 UserPromptSubmit（只能把话留到下一次请求）。 */
    function submitIfNewPrompt(messages: readonly ChatMessage[]): void {
      let prompt = ''
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!
        if (message.role === 'user') {
          prompt = contentText(message.content)
          break
        }
      }
      if (prompt === '' || prompt === lastPrompt) return
      lastPrompt = prompt
      fire('UserPromptSubmit', '', { prompt })
    }

    // ── 事件监听 ─────────────────────────────────────────────────────────────

    const offs: Array<() => void> = [ctx.guards.register(guard), ctx.guards.registerObserver(observer), offProjection]

    offs.push(
      ctx.on('dsc/session-open', ({ session, filePath }) => {
        announced.clear()
        lastPrompt = ''
        // codex 的 SessionStart matcher 比的来源：新开是 startup，接着老的跑是 resume
        const source = filePath === undefined ? 'startup' : 'resume'
        fire('SessionStart', source, { source }, session.meta.cwd)
      }),
    )
    offs.push(ctx.on('dsc/compacted', () => fire('PostCompact', '', {})))
    offs.push(ctx.on('dsc/exit', () => fire('SessionEnd', '', { reason: 'exit' })))
    offs.push(
      ctx.on('dsc/turn-end', (reason, signal) => {
        // 0.6.48：只认当前查看会话的回合。Stop/Interrupt 钩子取的
        // lastAssistantText 来自当前会话，后台 agent 收工时触发会拿错文本。
        // 载荷缺省（老式直接 emit）按当前会话算。
        if (signal !== undefined && signal.sessionId !== ctx.session.current().meta.id) return
        if (reason === 'completed') {
          fire('Stop', '', {
            reason,
            // dsc 没有 codex 的「这已经是钩子推起来的续跑」这个标记，恒为 false（不再二次刹车）
            stop_hook_active: false,
            last_assistant_message: lastAssistantText(),
          })
          return
        }
        if (reason === 'aborted') fire('Interrupt', '', { reason })
      }),
    )

    // ── 设置分区 ─────────────────────────────────────────────────────────────

    const fields = (): SettingsField[] => {
      const cfg = config()
      const report = lifecycleReport(cfg.configPath)
      const list: SettingsField[] = [
        {
          type: 'switch',
          key: 'enabled',
          label: '启用生命周期钩子',
          help: '关掉之后一个钩子都不跑（配置文件留着，随时开回来）。',
        },
        {
          type: 'text',
          key: 'configPath',
          label: '钩子配置文件',
          mono: true,
          placeholder: 'C:\\Users\\me\\.dsc\\lifecycle-hooks.json',
          help: 'codex 形态的 JSON：`{ "hooks": { "PreToolUse": [{ "matcher": "bash", "hooks": [{ "type": "command", "command": "node guard.js", "timeout": 5 }] }] } }`。timeout 按秒算。',
        },
        {
          type: 'number',
          key: 'timeoutMs',
          label: '钩子缺省超时（毫秒）',
          min: HOOK_TIMEOUT_MIN,
          max: HOOK_TIMEOUT_MAX,
          step: 500,
          help: `钩子自己没写 timeout 时给多少。范围 ${HOOK_TIMEOUT_MIN}~${HOOK_TIMEOUT_MAX} 毫秒。`,
        },
        {
          type: 'switch',
          key: 'failClosed',
          label: '钩子没跑成就算拦',
          help: '超时、命令起不来、输出看不懂、退出码非 0 时按「拦下来」处理。关掉就退回「跑不成当没这条钩子」——出了事更难查，建议留着。',
        },
        {
          type: 'text',
          key: 'commandAllowlist',
          label: '命令白名单',
          mono: true,
          placeholder: '留空 = 不限制；例如 node, uv',
          help: '填了之后只有入口在白名单里的钩子会执行，按命令的第一个词比（`node` 放行 `node guard.js`，不放行 `nodejs-evil`）。被挡下的钩子按「没跑成」处理。',
        },
        {
          type: 'info',
          label: '十二个事件的接通情况',
          mono: true,
          text: report.capabilities.map((item) => `${item.event}｜${TIER_LABELS[item.tier]}｜${item.extension}`).join('\n'),
          help: '「未接通」的事件 dsc 现在没有可挂的扩展点，配了钩子也不会执行，原因见下面那条。',
        },
        {
          type: 'info',
          label: '已加载的钩子',
          mono: true,
          text:
            report.hooks.length === 0
              ? '（配置文件里还没有钩子）'
              : report.hooks
                  .map((hook) => `[${hook.event}]${hook.enabled ? '' : '［已停用］'} ${hook.command.slice(0, 60)}`)
                  .join('\n'),
        },
      ]
      if (report.problems.length > 0) {
        list.push({
          type: 'info',
          label: '没接通与没生效的部分',
          text: report.problems.join('\n'),
          help: '坏掉的条目被跳过了，其余钩子照样生效。',
        })
      }
      list.push({ type: 'info', label: '配置文件', text: cfg.configPath, mono: true, copyable: true })
      return list
    }

    const section: SettingsSectionSpec = {
      id: CONFIG_KEY,
      title: '生命周期钩子',
      subtitle: '按 codex 的事件名跑外部命令钩子',
      order: 36,
      fields,
      values(): Record<string, SettingsValue> {
        const cfg = config()
        return {
          enabled: cfg.enabled,
          configPath: cfg.configPath,
          timeoutMs: cfg.timeoutMs,
          failClosed: cfg.failClosed,
          commandAllowlist: cfg.commandAllowlist,
        }
      },
      save(key, value): string | void {
        switch (key) {
          case 'enabled':
            writePluginConfig(CONFIG_KEY, { enabled: value === true })
            return
          case 'failClosed':
            writePluginConfig(CONFIG_KEY, { failClosed: value === true })
            return
          case 'timeoutMs': {
            const num = Number(value)
            if (!Number.isFinite(num)) return '这里要填一个数字（毫秒）'
            writePluginConfig(CONFIG_KEY, { timeoutMs: Math.min(Math.max(Math.round(num), HOOK_TIMEOUT_MIN), HOOK_TIMEOUT_MAX) })
            return
          }
          case 'configPath': {
            const text = String(value).trim()
            if (text === '') return '钩子配置文件路径不能空着'
            writePluginConfig(CONFIG_KEY, { configPath: text })
            return
          }
          case 'commandAllowlist':
            writePluginConfig(CONFIG_KEY, { commandAllowlist: String(value).trim() })
            return
          default:
            return `这个分区没有这项：${key}`
        }
      },
    }
    offs.push(ctx.settings.registerSection(section))

    // ── /lifecycle-hooks 命令 ────────────────────────────────────────────────

    offs.push(
      ctx.commands.register(
        { name: 'lifecycle-hooks', args: '', description: '看生命周期钩子的能力清单与已加载的钩子' },
        ({ ui }) => {
          const cfg = config()
          const report = lifecycleReport(cfg.configPath)
          const lines: string[] = [
            `生命周期钩子：${cfg.enabled ? '开着' : '关着'}｜配置文件 ${cfg.configPath}`,
            `十二个事件（${report.capabilities.length} 个）：`,
          ]
          for (const item of report.capabilities) lines.push(`  ${item.event}｜${TIER_LABELS[item.tier]}｜${item.extension}`)
          lines.push(`已加载钩子 ${report.hooks.length} 条：`)
          for (const hook of report.hooks) {
            lines.push(`  [${hook.event}]${hook.enabled ? '' : '［已停用］'} ${hook.command.slice(0, 60)}`)
          }
          for (const problem of report.problems) lines.push(`  ⚠ ${problem}`)
          ui.notice(lines.join('\n'))
        },
      ),
    )

    return () => {
      lifetime.abort()
      for (const off of offs) off()
    }
  },
}
