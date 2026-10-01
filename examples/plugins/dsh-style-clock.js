/**
 * dsh 风格插件示例：用 DeepSeek Harness 的工具定义形状（ToolDefinition）注册工具，
 * 经 dsc 的「dsh 兼容层」运行。自包含（不 import 任何 dsh 库），直接可用；
 * 真实的 dsh 插件（import defineTool / z 的那些）走同样的链路，见
 * docs/plugin-development.md 的「dsh 兼容层」一章。
 *
 * 安装与运行：
 *   1. 复制本文件到 ~/.dsc/plugins/；
 *   2. 在插件中心启用「dsh 兼容层」（dsh-compat，默认关）；
 *   3. 启用本插件（dsh-style-clock.js），对话里让模型调 dsh_clock 工具，或 /clock 命令。
 *
 * 与 dsc 原生插件的差异只有两处：ctx.tools.register 收 dsh 的 ToolDefinition
 * （execute 返回规范 JSON 值、output.render 投影模型可见内容），以及 risk 不是
 * dsh 概念——缺省每次调用都过审批卡，可在插件条目配置里用 risk / risks 放宽。
 */
export const name = 'dsh-style-clock'
export const description = 'dsh 风格示例：ToolDefinition 形状的时钟工具（走 dsh 兼容层）'
export const inject = ['tools', 'commands', 'logger']

export function apply(ctx) {
  // dsh 插件习惯用 logger：warn/error 会被 dsh 兼容层转进对话流，info/debug 不落地
  ctx.logger.info('dsh-style-clock 已挂载')

  const definition = {
    name: 'dsh_clock',
    description: 'Get the current local time. Use it whenever the user asks about time or dates.',
    // dsh 的 parameters 是 JSON Schema 对象（defineTool 会从 schemastery spec 编译出这个形状）
    parameters: {
      type: 'object',
      properties: {
        timezone_note: { type: 'string', description: 'Optional note appended to the result.' },
      },
    },
    timeoutMs: 5_000,
    // dsh 约定：execute 返回「规范 JSON 值」，模型看到什么由 output.render 投影
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `${value.iso}${args.timezone_note ? `\n${args.timezone_note}` : ''}` }],
    },
    execute: async (args, exec) => {
      if (exec.signal.aborted) throw new Error('cancelled')
      return { iso: new Date().toISOString() }
    },
  }

  const offTool = ctx.tools.register(definition)
  const offCommand = ctx.commands.register(
    { name: 'clock', args: '', description: 'dsh 风格示例工具的自测入口' },
    ({ ui }) => ui.notice(`当前时间：${new Date().toISOString()}（来自 dsh 风格插件）`),
  )

  // 注册一律返回清理函数：热卸载后不留残留
  return () => {
    offTool()
    offCommand()
  }
}
