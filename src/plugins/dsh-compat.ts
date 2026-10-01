/**
 * dsh-compat 插件：dsh（DeepSeek Harness）外部插件的兼容层，官方可开关、默认关。
 *
 * dsh 的外部插件与本仓库同为 cordis 模块插件（命名导出 inject/apply），cordis 版本
 * 也一致；差异只在三处，这个插件补齐两处，第三处在 loader：
 *
 * 1. **logger 服务**：dsh 插件习惯 `inject: ['logger']`。npm 发布的 cordis 把内置
 *    logger 做成原型属性而不是可注入服务（dsh 的 vendor 版本是服务），插件一声明
 *    inject 就永远等不到、apply 不执行。这里 provide 一个委托到内置 logger 管道的
 *    门面：可调用（named logger）、四种级别都在，warn/error 同时镜像进 transcript，
 *    用户在对话流里看得见。
 * 2. **模块解析钩子**：插件目录里的 dsh 插件 import `@deepseek-ai/*`（defineTool、
 *    schemastery 的 z、cordis 本体）时，重定向到 dsc 自带的 node_modules 与 dsh-tools
 *    的传递依赖，cordis 保证单实例。钩子只对插件目录里的导入方生效。
 * 3. **工具形状适配**：ctx.tools 的兼容面在 core/dsh-compat/tools-facade——loader 在
 *    本插件开着时给外部插件的 ctx 换上它，dsh 的 ToolDefinition 与 dsc 的 ToolEntry
 *    都能注册；risk 映射（dsh 没有这个概念）按插件条目配置，缺省每次调用都过审批卡。
 *
 * 兼容边界（明确不支持，挂载时响亮报错）：inject 里出现 `sessionProjections`、`agents`、
 * `goals`、`systemPrompt` 等 dsh 服务名的插件——那要整个 dsh 会话语义，个人版不背。
 *
 * @module dsc/plugins/dsh-compat
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { Logger, defaultFormatters } from '@deepseek-ai/cordis'
import { ensureResolveHook } from '../core/dsh-compat/resolve-hook.js'
import { DSC_PLUGINS_DIR } from '../core/plugin-loader.js'

export const dshCompatPlugin: Plugin.Object = {
  name: 'dsh-compat',
  inject: ['transcript'],
  provide: 'logger',
  apply(ctx) {
    // 钩子注册同步生效；loader 在挂载外部插件前还会调一次（幂等），这里兜底
    void ensureResolveHook([DSC_PLUGINS_DIR])

    // 内置 logger 管道上的桥：warn/error 镜像进 transcript（info/debug 不转，防刷屏）。
    // levels 显式放到 debug(3)：exporter 缺省阈值是 info(1)，warn/error 会被默认滤掉。
    // 文案经 Logger.format 还原 printf 占位符（dsh 插件习惯 warn('failed: %s', err)）。
    const offExporter = ctx.logger.exporter({
      levels: { default: 3 },
      export: (message) => {
        if (message.type !== 'warn' && message.type !== 'error') return
        const text = Logger.format({ formatters: defaultFormatters, export() {} }, message)
        ctx.transcript.system(`[dsh 插件${message.name === '' ? '' : `·${message.name}`}] ${text}`)
      },
    })

    // 可注入的 logger 门面：可调用（ctx.logger('名字')）、四种级别都委托内置管道，
    // 于是 named logger 的 warn/error 同样被上面的桥镜像进 transcript。
    const builtin = ctx.logger
    const service = Object.assign((name?: string) => builtin(name), {
      debug: (format: unknown, ...rest: unknown[]) => builtin.debug(format, ...rest),
      info: (format: unknown, ...rest: unknown[]) => builtin.info(format, ...rest),
      warn: (format: unknown, ...rest: unknown[]) => builtin.warn(format, ...rest),
      error: (format: unknown, ...rest: unknown[]) => builtin.error(format, ...rest),
    })
    ctx.provide('logger', service)
    return () => {
      void offExporter()
    }
  },
}
