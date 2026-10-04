/**
 * 斜杠命令的注册表与补全（/help 文本、命令与模型参数候选、唯一前缀展开）。
 *
 * 为什么独立成模块：渲染层 Composer 直接 import 这一份拿补全函数——vite 对
 * `node:child_process` 之类内置模块是「externalize 即炸」（顶层 import 一求值就抛，
 * 0.6.26 白屏教训），所以**这个模块的顶层不许出现任何 node 内置模块**。
 * 插件（plugins/commands.ts）从这里 re-export，终端侧的入口不变。
 *
 * @module dsc/core/commands-completion
 */
import type { CommandSpec, CompletionItem } from '../services/types.js'
import type { ModelChoiceView } from '../contract.js'

/** 内置命令表（spec 单一真源；handler 在插件 apply 时注册）。 */
export const BUILT_IN_COMMANDS: CommandSpec[] = [
  // T44：duringTask = 回合跑着的时候还能不能用。new/resume 会打断挂着审批的回合、
  // compact 会和进行中的落库交错，运行中一律挡下；其余随时可用。
  { name: 'new', args: '', description: '新建会话', duringTask: 'deny' },
  { name: 'resume', args: '', description: '恢复历史会话', duringTask: 'deny' },
  { name: 'agents', args: '', description: '查看子代理与后台会话（转录只读）' },
  { name: 'compact', args: '', description: '压缩上下文', duringTask: 'deny' },
  {
    name: 'model',
    args: '<[端点/]模型名>',
    description: '切换模型，下一次请求生效（无参数打开选择器）',
  },
  { name: 'policy', args: '[readonly|auto-edit|full-access|ai-review]', description: '查看或切换权限模式' },
  { name: 'effort', args: '[default|off|low|high|max]', description: '查看或切换思考强度' },
  { name: 'status', args: '', description: '查看上下文占用与压缩余量' },
  { name: 'usage', args: '', description: '查看累计用量统计（含缓存命中率）' },
  { name: 'diff', args: '[文件]', description: '查看工作区未提交改动的 diff' },
  { name: 'copy', args: '', description: '复制上一条回复到剪贴板' },
  { name: 'export', args: '[文件路径]', description: '导出当前会话为 markdown' },
  { name: 'review', args: '[关注点]', description: '审查工作区未提交改动' },
  { name: 'help', args: '', description: '查看帮助' },
  { name: 'exit', args: '', description: '退出' },
]

/** 外部插件注册的命令（补全与唯一前缀展开用；模块级单例，进程内唯一注册表）。 */
const extraSpecs: CommandSpec[] = []

/** 全量 spec：内置 + 外部插件注册的。 */
export const allSpecs = (): CommandSpec[] => [...BUILT_IN_COMMANDS, ...extraSpecs]

/** 外部插件注册成功后把 spec 挂进来（registry 是唯一调用方）。 */
export function addExtraSpec(spec: CommandSpec): void {
  extraSpecs.push(spec)
}

/** 外部插件注销时摘掉。 */
export function removeExtraSpec(spec: CommandSpec): void {
  const at = extraSpecs.findIndex((entry) => entry.name === spec.name)
  if (at >= 0) extraSpecs.splice(at, 1)
}

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
