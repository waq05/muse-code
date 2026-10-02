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
import { collectWorkingTree } from '../core/git-info.js'
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
      { name: 'effort', args: '', description: '推理强度，已移除' },
      ({ ui }) => ui.notice('已移除 /effort，思考强度改在设置页调整'),
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

/**
 * /review 的审查消息组装（独立成函数便于脱离命令体系直测：给一份收集结果与关注点，
 * 回一条可直接 submit 的消息；回复即审查意见，与用户自己贴 diff 问「帮我看看」同链路）。
 */export function reviewMessage(collected: { diff: string; untracked: string[] }, focus: string): string {
  const lines = [
    '请审查当前工作区的未提交改动。逐个文件过 diff：正确性问题、边界条件、安全问题、'
      + '与项目既有约定（如 AGENTS.md）冲突的地方；给出具体文件与行级的意见。没有问题就明说没有。',
  ]
  if (focus !== '') lines.push(`关注点：${focus}`)
  if (collected.diff !== '') {
    lines.push('', '## 未提交改动（git diff HEAD --no-textconv --no-ext-diff）', '', collected.diff)
  } else {
    lines.push('', '## 未提交改动', '', '（没有已跟踪文件的改动，只有未跟踪的新文件）')
  }
  if (collected.untracked.length > 0) {
    lines.push('', '## 未跟踪文件（diff 里没有，逐个 read 后再评）', ...collected.untracked.map((file) => `- ${file}`))
  }
  return lines.join('\n')
}
