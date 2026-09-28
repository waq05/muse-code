/**
 * dsc 外部插件示例：注册 /ping 命令与 ping 工具。
 *
 * 安装（二选一）：
 *   1. 复制本文件到 ~/.dsc/plugins/（启动时自动发现，按文件名排序加载）；
 *   2. 或在 ~/.dsc/config.yaml 声明：plugins: [ "D:/dsc/examples/plugins/ping.js" ]。
 *
 * 插件形态 = cordis 模块插件：模块的命名导出构成插件定义（inject 声明依赖
 * 服务，apply 里通过 ctx.<服务名> 访问）。可用的内置服务：
 * llm / session / approval / tools / transcript / commands / compact / agent / ui。
 *
 * 可选导出 `name` / `description` 用于桌面端插件管理页的展示（省略时显示文件名）。
 */
export const name = 'Ping'
export const description = '测试插件：注册 /ping 命令与 ping 工具，回复 pong 验证外部插件链路'
export const inject = ['commands', 'tools']

export function apply(ctx) {
  ctx.commands.register(
    { name: 'ping', args: '', description: '测试外部插件（回复 pong）' },
    ({ ui }) => ui.notice('pong（来自外部插件 ping.js）'),
  )

  ctx.tools.register({
    name: 'ping',
    description: 'Ping the dsc host. Returns "pong". Use it to verify external plugins work.',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    async run() {
      return 'pong'
    },
  })
}
