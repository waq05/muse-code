/**
 * runtime 插件：provide `runtime` 服务（DscRuntime 适配器）。
 * 把各服务织成 contract.ts 的 DscRuntime 契约——TUI（ink）与桌面端 renderer
 * 消费同一接口；/ 前缀命令派发仍在 UI 层（commands.runCommand）。
 * exit 语义：发出 dsc/exit（各插件同步收尾）后立即退进程，与 v2 行为一致。
 *
 * @module dsc/plugins/runtime
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { errText } from '../adapter/transcript.js'
import { listPluginInfos, writePluginEnabled } from '../core/plugin-registry.js'
import { setPluginEnabledHot } from '../core/plugin-loader.js'
import type { DscRuntime } from '../contract.js'

export const runtimePlugin: Plugin.Object = {
  name: 'ui-runtime',
  inject: ['agent', 'session', 'transcript', 'approval', 'llm', 'commands', 'dock'],
  provide: 'ui',
  apply(ctx) {
    const runtime: DscRuntime = {
      subscribe(listener) {
        return ctx.transcript.subscribe(listener)
      },

      getSnapshot() {
        return ctx.transcript.getSnapshot()
      },

      submit(text: string) {
        ctx.agent.followup(text)
      },

      interrupt() {
        ctx.agent.interrupt()
      },

      openSession(filePath?: string) {
        return ctx.session.open(filePath)
      },

      async compact() {
        await ctx.compact.run()
      },

      async setModel(model: string) {
        const [providerPart, modelPart] = model.includes('/')
          ? (model.split('/', 2) as [string, string])
          : [ctx.llm.provider, model]
        try {
          ctx.llm.setModel(providerPart, modelPart)
          ctx.transcript.system(`模型切换为 ${ctx.llm.provider}/${ctx.llm.model}（下一次请求生效）`)
        } catch (error) {
          ctx.transcript.system(errText(error))
        }
        ctx.transcript.touch()
      },

      async setEffort(effort) {
        ctx.llm.setEffort(effort)
        const label =
          effort === 'default'
            ? '默认（不声明思考）'
            : effort === 'off'
              ? '关闭'
              : { low: '低', high: '高', max: '最大' }[effort]
        ctx.transcript.system(`思考强度设为「${label}」（下一次请求生效）`)
        ctx.transcript.touch()
      },

      listPlugins() {
        return listPluginInfos()
      },

      async setPluginEnabled(file, enabled) {
        if (!writePluginEnabled(file, enabled)) {
          ctx.transcript.system('内置插件不可停用（它们构成运行内核）')
          ctx.transcript.touch()
          return
        }
        // 热启停：即时挂载/卸载，写盘持久化；失败回滚（挂载失败自动停用）
        const outcome = await setPluginEnabledHot(file, enabled)
        if (!outcome.ok) {
          ctx.transcript.system(`插件 ${file} 未能启用：${outcome.problem ?? '未知原因'}（已回滚为停用）`)
        } else {
          ctx.transcript.system(`已${enabled ? '启用' : '停用'}插件 ${file}（即时生效）`)
        }
        ctx.transcript.touch()
      },

      setPolicy(policy) {
        ctx.approval.setPolicy(policy)
      },

      dock(op, payload) {
        return ctx.dock.handle(op, payload ?? {})
      },

      runCommand(input) {
        // / 命令统一在宿主命令注册表派发（内置 + 外部插件命令）；
        // notice 反馈写 transcript 条目，openPicker 经事件转发给宿主壳。
        return ctx.commands.run(input, this, {
          notice: (text) => ctx.transcript.system(text),
          openPicker: () => ctx.emit('dsc/open-picker'),
        })
      },

      listModels() {
        return ctx.llm.listModels()
      },

      refreshSessions() {
        return ctx.session.refresh()
      },

      answerApproval(answer) {
        ctx.approval.answer(answer)
      },

      exit(): void {
        ctx.emit('dsc/exit')
        process.exit(0)
      },

      async dispose() {
        ctx.emit('dsc/exit')
      },
    }

    ctx.provide('ui', runtime)
  },
}
