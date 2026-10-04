/**
 * commands 插件：provide `commands` 服务（斜杠命令注册表 + 派发）。
 * 内置命令改为注册表条目，外部插件经 ctx.commands.register 注入新命令后
 * 自动进入 /help、补全与派发。
 *
 * spec 表与补全函数都在 core/commands-completion.ts（渲染层直接 import 那份；
 * 本模块顶层的 node 内置模块会把渲染进程炸成白屏——取数走 core/git-info）。
 *
 * @module dsc/plugins/commands
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type {
  CommandHandler,
  CommandService,
  CommandSpec,
} from '../services/types.js'
import type { DscRuntime } from '../contract.js'
import { collectWorkingTree, reviewMessage } from '../core/git-info.js'
import { estimateTokens } from '../core/compact.js'
import { exportSessionMarkdown } from '../core/session-export.js'
import { errText } from '../core/err-text.js'
import {
  addExtraSpec,
  allSpecs,
  BUILT_IN_COMMANDS,
  expandCommand,
  helpText,
  removeExtraSpec,
} from '../core/commands-completion.js'

export const commandsPlugin: Plugin.Object = {
  name: 'commands',
  // /status 要问 llm 服务的窗口大小与当前端点名
  inject: ['session', 'llm'],
  provide: 'commands',
  apply(ctx) {
    const registry = new Map<string, { spec: CommandSpec; handler: CommandHandler }>()

    const service: CommandService = {
      register(spec, handler) {
        registry.set(spec.name, { spec, handler })
        if (!BUILT_IN_COMMANDS.some((entry) => entry.name === spec.name)) addExtraSpec(spec)
        return () => {
          if (registry.get(spec.name)?.handler === handler) {
            registry.delete(spec.name)
            removeExtraSpec(spec)
          }
        }
      },
      specs() {
        return allSpecs()
      },
      run(input, runtime, ui) {
        if (!input.startsWith('/')) return false
        const expanded = expandCommand(input)
        const parts = expanded.slice(1).trim().split(/\s+/)
        const command = parts[0] ?? ''
        const args = parts.slice(1)
        if (command === '') {
          ui.notice(helpText(service.specs()))
          return true
        }
        const entry = registry.get(command)
        if (entry === undefined) {
          ui.notice(`未知命令：/${command}（/help 查看全部）`)
          return true
        }
        // T44：可用性矩阵统一在派发这一闸——回合跑着的时候 deny 的命令挡下，
        // 桌面 / TUI / 远端三端行为一致（以前只有桌面输入框自己禁了字）。
        if (
          entry.spec.duringTask === 'deny' &&
          runtime.getSnapshot().status.turnState !== 'idle'
        ) {
          ui.notice(`/${command} 要等当前回合结束（或先打断）再用`)
          return true
        }
        entry.handler({ args, runtime, ui })
        return true
      },
    }

    // ---- 内置命令注册 ----
    service.register(
      { name: 'help', args: '', description: '查看帮助' },
      ({ ui }) => ui.notice(helpText(service.specs())),
    )
    service.register(
      { name: 'new', args: '', description: '新建会话' },
      ({ runtime }) => void runtime.openSession(undefined),
    )
    service.register(
      { name: 'resume', args: '', description: '恢复历史会话' },
      ({ ui }) => ui.openPicker(),
    )
    service.register(
      { name: 'model', args: '<[端点/]模型名>', description: '切换模型，下一次请求生效' },
      ({ args, runtime, ui }) => {
        const model = args[0]
        if (model === undefined || model === '') {
          ui.notice('用法：/model [端点/]模型名')
          return
        }
        void runtime.setModel(model)
      },
    )
    service.register(
      { name: 'status', args: '', description: '查看上下文占用与压缩余量' },
      ({ ui }) => {
        const session = ctx.session.current()
        const messages = session.messages
        const compact = ctx.get('compact')
        ui.notice(
          statusReport({
            provider: ctx.llm.provider,
            model: ctx.llm.model,
            window: ctx.llm.contextWindow,
            tokens: estimateTokens(messages),
            messageCount: messages.length,
            toolCount: messages.filter((message) => message.role === 'tool').length,
            autoCompactPercent: compact !== undefined ? compact.describe().autoCompactPercent : 80,
          }),
        )
      },
    )
    service.register(
      { name: 'export', args: '[文件路径]', description: '导出当前会话为 markdown' },
      ({ args, ui }) => {
        const session = ctx.session.current()
        if (session.messages.length === 0) {
          ui.notice('这个会话还没有消息，没东西可导出。')
          return
        }
        const stamp = new Date()
        const pad = (value: number): string => String(value).padStart(2, '0')
        const target =
          args[0] ?? join(
            session.meta.cwd || process.cwd(),
            `msc-export-${session.meta.id.slice(0, 8)}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.md`,
          )
        const markdown = exportSessionMarkdown({
          id: session.meta.id,
          cwd: session.meta.cwd,
          createdAt: session.meta.createdAt,
          messages: session.messages,
        })
        try {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, markdown, 'utf8')
        } catch (error) {
          ui.notice(`导出失败：${errText(error)}`)
          return
        }
        ui.notice(`已导出 ${session.messages.length} 条消息 → ${target}`)
      },
    )
    service.register(
      { name: 'review', args: '[关注点]', description: '审查工作区未提交改动' },
      ({ args, runtime, ui }) => {
        const cwd = ctx.session.current().meta.cwd
        const focus = args.join(' ').trim()
        void collectWorkingTree(cwd)
          .then((collected) => {
            if (collected === null) {
              ui.notice('这里不是 git 仓库，/review 没有可审查的改动。')
              return
            }
            if (collected.diff === '' && collected.untracked.length === 0) {
              ui.notice('工作区没有未提交的改动。')
              return
            }
            // T18：subagent 插件开着就走只读审查队友——后台审，findings 直接出卡片，
            // 不占用当前会话的模型轮；插件没开（或额度满）回落 v1 的主会话审查轮。
            const review = ctx.get('review')
            if (review !== undefined) {
              const spawned = review.spawn({ ...collected, focus })
              if (spawned.ok) {
                ui.notice(`已派出只读审查队友 ${spawned.name}，结论出来后直接出现在会话里`)
                return
              }
              ui.notice(`/review 没派出审查队友（${spawned.reason}），改在本会话里审`)
            }
            // 组装一条审查请求走正常对话轮（runtime.submit → agent.followup）：
            // 回复就是审查意见，与用户自己贴着 diff 问「帮我看看」同一条链路。
            runtime.submit(reviewMessage(collected, focus))
          })
          .catch((cause: unknown) => {
            ui.notice(`/review 失败：${cause instanceof Error ? cause.message : String(cause)}`)
          })
      },
    )
    service.register(
      {
        name: 'policy',
        args: '[readonly|auto-edit|full-access|ai-review]',
        description: '查看或切换权限模式',
      },
      ({ args, runtime, ui }) => {
        const surface = runtime.getSnapshot().surfaces.policy
        const query = args[0]?.toLowerCase() ?? ''
        if (query === '') {
          ui.notice(
            [
              `当前权限模式：${surface.current}`,
              ...surface.options.map((option) => `· ${option.id} — ${option.label}：${option.hint}`),
              '用法：/policy <档位>（支持前缀匹配，如 /policy full）',
            ].join('\n'),
          )
          return
        }
        const matches = surface.options.filter((option) => option.id.startsWith(query))
        if (matches.length !== 1) {
          ui.notice(
            matches.length === 0
              ? `未知权限档位：${args[0]}（可选：${surface.options.map((option) => option.id).join(' / ')}）`
              : `「${args[0]}」匹配到 ${matches.length} 个档位，请写全`,
          )
          return
        }
        runtime.setPolicy(matches[0].id)
      },
    )
    service.register(
      { name: 'effort', args: '[default|off|low|high|max]', description: '查看或切换思考强度' },
      ({ args, runtime, ui }) => {
        const levels = [
          { id: 'default', label: '默认（不声明思考字段，跟随端点）' },
          { id: 'off', label: '关闭思考' },
          { id: 'low', label: '低' },
          { id: 'high', label: '高' },
          { id: 'max', label: '最大' },
        ] as const
        const query = args[0]?.toLowerCase() ?? ''
        if (query === '') {
          ui.notice(
            [
              `当前思考强度：${runtime.getSnapshot().status.effort}`,
              ...levels.map((level) => `· ${level.id} — ${level.label}`),
              '用法：/effort <档位>（当前模型不支持的档位会报错）',
            ].join('\n'),
          )
          return
        }
        const matches = levels.filter((level) => level.id.startsWith(query))
        if (matches.length !== 1) {
          ui.notice(
            matches.length === 0
              ? `未知思考档位：${args[0]}（可选：${levels.map((level) => level.id).join(' / ')}）`
              : `「${args[0]}」匹配到 ${matches.length} 个档位，请写全`,
          )
          return
        }
        void runtime.setEffort(matches[0].id)
      },
    )
    service.register(
      { name: 'exit', args: '', description: '退出' },
      ({ runtime }) => runtime.exit(),
    )

    serviceRef = service
    ctx.provide('commands', service)
  },
}

/** 注册表单例引用（App.tsx 的 runCommand 走它，外部命令一并派发）。 */
let serviceRef: CommandService | null = null

/** 兼容导出：v2 的 runCommand（App.tsx 零逻辑改动，仅 import 路径变化）。 */
export function runCommand(
  input: string,
  runtime: DscRuntime,
  ui: import('../services/types.js').CommandContext,
): boolean {
  return serviceRef !== null ? serviceRef.run(input, runtime, ui) : false
}

/**
 * /status 的文本组装（独立成函数便于脱离命令体系直测）。
 * tokens 由调用方用 core/compact 的 estimateTokens 算——数字与自动压缩触发判定同源。
 */
export function statusReport(input: {
  provider: string
  model: string
  window: number
  tokens: number
  messageCount: number
  toolCount: number
  autoCompactPercent: number
}): string {
  const threshold = Math.round(input.window * (input.autoCompactPercent / 100))
  const share = input.window > 0 ? Math.round((input.tokens / input.window) * 100) : 0
  return [
    '上下文占用',
    `· 模型：${input.provider}/${input.model}（窗口 ${input.window.toLocaleString('zh-CN')} tokens）`,
    `· 消息：${input.messageCount} 条（其中工具结果 ${input.toolCount} 条）`,
    `· 估算用量：${input.tokens.toLocaleString('zh-CN')} tokens，约占窗口 ${share}%`,
    `· 自动压缩触发线：${input.autoCompactPercent}%（≈${threshold.toLocaleString('zh-CN')} tokens，还差 ${Math.max(0, threshold - input.tokens).toLocaleString('zh-CN')}）`,
    '· 估算口径与自动压缩同源（中文 0.65、其余 0.33 tokens/字符）',
  ].join('\n')
}
