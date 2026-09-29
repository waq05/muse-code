/**
 * commands 插件：provide `commands` 服务（斜杠命令注册表 + 派发）。
 * 逻辑迁自 v2 src/commands.ts：内置命令改为注册表条目，外部插件经
 * ctx.commands.register 注入新命令后自动进入 /help、补全与派发。
 * 模块级补全函数（completionsFor 等）保持原签名，Composer 零改动复用。
 *
 * @module dsc/plugins/commands
 */
import type { Plugin } from '@deepseek-ai/cordis'
import type {
  CommandHandler,
  CommandService,
  CommandSpec,
  CompletionItem,
} from '../services/types.js'
import type { DscRuntime, ModelChoiceView } from '../contract.js'

/** 内置命令表（spec 单一真源；handler 在插件 apply 时注册）。 */
export const BUILT_IN_COMMANDS: CommandSpec[] = [
  { name: 'new', args: '', description: '新建会话' },
  { name: 'resume', args: '', description: '恢复历史会话' },
  { name: 'compact', args: '', description: '压缩上下文' },
  { name: 'model', args: '<[端点/]模型名>', description: '切换模型，下一次请求生效' },
  { name: 'help', args: '', description: '查看帮助' },
  { name: 'exit', args: '', description: '退出' },
]

/** 外部插件注册的命令（补全与唯一前缀展开用；模块级单例，进程内唯一注册表）。 */
const extraSpecs: CommandSpec[] = []

const allSpecs = (): CommandSpec[] => [...BUILT_IN_COMMANDS, ...extraSpecs]

/** /help 文本（命令表驱动）。 */
export function helpText(specs: readonly CommandSpec[]): string {
  return specs
    .map((command) => `/${command.name}${command.args === '' ? '' : ` ${command.args}`}\t${command.description}`)
    .join('\n')
}

/** 兼容导出：v2 的 HELP_TEXT（内置表静态快照）。 */
export const HELP_TEXT = helpText(BUILT_IN_COMMANDS)

/**
 * 命令候选（输入 `/` 或 `/mo` 阶段）。
 * 已进入参数阶段（含空格）或非命令输入返回空。
 */
export function commandCompletions(input: string): CompletionItem[] {
  if (!input.startsWith('/')) return []
  const body = input.slice(1)
  if (body.includes(' ')) return []
  const lower = body.toLowerCase()
  return allSpecs()
    .filter((command) => command.name.startsWith(lower))
    .map((command) => ({
      insert: `/${command.name}${command.args === '' ? '' : ' '}`,
      label: `/${command.name}${command.args === '' ? '' : ` ${command.args}`}`,
      description: command.description,
    }))
}

/**
 * 模型候选（`/model ` 参数阶段）：展示全部可切换模型的 `端点/模型名`。
 * 补全到精确匹配后面板自动关闭；`model 名`本身也可前缀匹配（`/model deep`）。
 */
export function modelCompletions(input: string, models: readonly ModelChoiceView[]): CompletionItem[] {
  if (!input.startsWith('/model')) return []
  const body = input.slice('/model'.length)
  if (!body.startsWith(' ')) return [] // 还没打空格：交给命令候选
  const arg = body.slice(1)
  if (arg.includes(' ')) return [] // 参数已完整（带后续参数不适用于 /model）
  const lower = arg.toLowerCase()
  const matched = models.filter(
    (choice) =>
      choice.value.toLowerCase().startsWith(lower) || choice.model.toLowerCase().startsWith(lower),
  )
  if (matched.length === 1 && matched[0].value.toLowerCase() === lower) return []
  return matched.map((choice) => ({
    insert: `/model ${choice.value}`,
    label: choice.value,
    description: choice.description,
  }))
}

/** 统一补全入口：model 参数阶段优先，否则按命令前缀。 */
export function completionsFor(input: string, models: readonly ModelChoiceView[]): CompletionItem[] {
  const byModel = modelCompletions(input, models)
  return byModel.length > 0 ? byModel : commandCompletions(input)
}

/**
 * 命令名唯一前缀自动展开（`/ne` → `/new`）；多候选或已精确匹配时原样返回。
 * 供 Enter 提交前调用，避免"输了一半按回车报未知命令"。
 */
export function expandCommand(input: string): string {
  if (!input.startsWith('/')) return input
  const body = input.slice(1)
  if (body.includes(' ')) return input
  if (allSpecs().some((command) => command.name === body)) return input
  const matches = allSpecs().filter((command) => command.name.startsWith(body.toLowerCase()))
  return matches.length === 1 ? `/${matches[0].name}` : input
}

export const commandsPlugin: Plugin.Object = {
  name: 'commands',
  provide: 'commands',
  apply(ctx) {
    const registry = new Map<string, { spec: CommandSpec; handler: CommandHandler }>()

    const service: CommandService = {
      register(spec, handler) {
        registry.set(spec.name, { spec, handler })
        if (!BUILT_IN_COMMANDS.some((entry) => entry.name === spec.name)) {
          extraSpecs.push(spec)
        }
        return () => {
          if (registry.get(spec.name)?.handler === handler) {
            registry.delete(spec.name)
            const extraIndex = extraSpecs.findIndex((entry) => entry.name === spec.name)
            if (extraIndex >= 0) extraSpecs.splice(extraIndex, 1)
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
