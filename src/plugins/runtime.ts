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
import { buildUsageStats } from '../core/usage-log.js'
import type { DscRuntime, SettingsMutation } from '../contract.js'

export const runtimePlugin: Plugin.Object = {
  name: 'ui-runtime',
  inject: [
    'agent',
    'session',
    'transcript',
    'approval',
    'llm',
    'commands',
    'dock',
    'skills',
    'settings',
    'compact',
    // 设置 → 模式 的工具多选要读完整工具目录（listTools）
    'tools',
    // 界面上那几块卡片的操作要落到各自的功能点：档位切换、清单、计划卡、提问卡、目标。
    'mode',
    'presets',
    'todo',
    'plan',
    'ask',
    'goal',
  ],
  provide: 'ui',
  apply(ctx) {
    /**
     * 同步写动作的统一包装：功能点那边抛错是有意义的（名字非法、内置删不掉、
     * 文件写不进去），契约要求把失败原因原样交给界面显示，而不是让 IPC 那头收到一个异常。
     */
    function mutateWith(work: () => string): SettingsMutation {
      try {
        return { ok: true, notice: work() }
      } catch (error) {
        return { ok: false, error: errText(error) }
      }
    }

    const runtime: DscRuntime = {
      subscribe(listener) {
        return ctx.transcript.subscribe(listener)
      },

      getSnapshot() {
        return ctx.transcript.getSnapshot()
      },

      submit(text: string, images?: string[]) {
        ctx.agent.followup(text, images)
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
        try {
          ctx.llm.setEffort(effort)
        } catch (error) {
          ctx.transcript.system(errText(error))
          ctx.transcript.touch()
          return
        }
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
          ctx.transcript.system('这一档属于运行内核，构成 dsc 本身，不能停用')
          ctx.transcript.touch()
          return
        }
        const shown = listPluginInfos().find((item) => item.file === file)?.name ?? file
        // 热启停：即时挂载/卸载，写盘持久化；失败回滚（挂载失败自动停用）
        const outcome = await setPluginEnabledHot(file, enabled)
        if (!outcome.ok) {
          ctx.transcript.system(`插件「${shown}」没能启用：${outcome.problem ?? '未知原因'}（已经退回停用状态）`)
        } else {
          ctx.transcript.system(`已${enabled ? '启用' : '停用'}插件「${shown}」，即时生效`)
        }
        ctx.transcript.touch()
      },

      listTeammates() {
        // 「子智能体」没开时这个服务就不存在，侧栏因此看到空列表。
        // 必须走 ctx.get：cordis 的上下文代理对没 inject 的属性是直接抛错的，`ctx.team?.` 也会先抛
        const team = ctx.get('team')
        return team === undefined ? [] : team.list()
      },

      stopTeammate(name) {
        // 与 listTeammates 同一条理由：team 是可选服务，只能 ctx.get
        const team = ctx.get('team')
        if (team === undefined) return Promise.reject(new Error('子智能体插件没开，没有队友可以收掉'))
        return team.stop(name)
      },

      messageTeammate(name, text) {
        const team = ctx.get('team')
        if (team === undefined) return Promise.reject(new Error('子智能体插件没开，没法给队友传话'))
        return team.message(name, text)
      },

      removeTeammate(name) {
        // 与 stopTeammate 同一条理由：team 是可选服务，只能 ctx.get
        const team = ctx.get('team')
        if (team === undefined) return Promise.reject(new Error('子智能体插件没开，名册里没有可移除的队友'))
        return team.remove(name)
      },

      peekTranscript(file) {
        const team = ctx.get('team')
        if (team === undefined) return Promise.reject(new Error('子智能体插件没开，看不到队友的运行记录'))
        return team.peek(file)
      },

      setPolicy(policy) {
        ctx.approval.setPolicy(policy)
      },

      setMode(mode) {
        ctx.mode.setMode(mode)
      },

      // ── 模式（预设）──
      listPresets() {
        return ctx.presets.surface()
      },

      async readPreset(name) {
        try {
          return { ok: true, name, text: ctx.presets.read(name) }
        } catch (error) {
          return { ok: false, error: errText(error) }
        }
      },

      usePreset(name) {
        return mutateWith(() => ctx.presets.use(name))
      },

      savePreset(draft) {
        return mutateWith(() => ctx.presets.save(draft))
      },

      removePreset(name) {
        return mutateWith(() => ctx.presets.remove(name))
      },

      setDefaultPreset(name) {
        return mutateWith(() => ctx.presets.setDefault(name))
      },

      listTools() {
        return ctx.tools.list().map((entry) => ({
          name: entry.name,
          risk: entry.risk,
          description: entry.description,
          ...(entry.presets !== undefined ? { presets: [...entry.presets] } : {}),
        }))
      },

      answerQuestion(answer) {
        ctx.ask.answerQuestion(answer)
      },

      answerPlan(decision, feedback) {
        ctx.plan.answerPlan(decision, feedback)
      },

      goalAction(action) {
        return ctx.goal.goalAction(action)
      },

      clearTodos() {
        ctx.todo.clearTodos()
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

      // ── 技能中心 ──
      listSkills() {
        return ctx.skills.list()
      },

      readSkill(name) {
        return ctx.skills.read(name)
      },

      setSkillEnabled(name, enabled) {
        return ctx.skills.setEnabled(name, enabled)
      },

      browseMarket(source) {
        return ctx.skills.browseMarket(source ?? '')
      },

      installMarketSkill(source, name) {
        return ctx.skills.installMarketSkill(source, name)
      },

      setMarketSources(sources) {
        ctx.settings.setPrefs({ marketSources: sources })
        return { ok: true, notice: `已保存 ${sources.length} 个市场源` }
      },

      // ── 设置界面 ──
      getSettingsSections() {
        return ctx.settings.sections()
      },

      getSectionValues(id) {
        return ctx.settings.values(id)
      },

      setSettingValue(id, key, value) {
        return ctx.settings.save(id, key, value)
      },

      runSettingAction(id, action) {
        return ctx.settings.action(id, action)
      },

      getModelConfig() {
        return ctx.settings.modelConfig()
      },

      async saveProvider(draft) {
        return ctx.settings.saveProvider(draft)
      },

      async discoverModels(provider) {
        return ctx.settings.discoverModels(provider)
      },

      async removeProvider(name) {
        return ctx.settings.removeProvider(name)
      },

      async setProviderKey(name, apiKey) {
        return ctx.settings.setProviderKey(name, apiKey)
      },

      async setDefaultModel(provider, model) {
        return ctx.settings.setDefaultModel(provider, model)
      },

      refreshSessions() {
        return ctx.session.refresh()
      },

      // ── 会话库（归档 / 恢复 / 删除 / 改名 / 置顶 / 分叉） ──
      async archiveSessions(paths) {
        return ctx.session.archive(paths)
      },

      listArchivedSessions() {
        return Promise.resolve(ctx.session.archived())
      },

      usageStats() {
        return Promise.resolve(buildUsageStats())
      },

      async restoreSessions(paths) {
        return ctx.session.restore(paths)
      },

      async purgeSessions(paths) {
        return ctx.session.purge(paths)
      },

      async renameSession(path, title) {
        return ctx.session.rename(path, title)
      },

      async setSessionPinned(path, pinned) {
        return ctx.session.setPinned(path, pinned)
      },

      listUserMessages(path) {
        return Promise.resolve(ctx.session.userMessages(path))
      },

      forkSession(path, index) {
        return Promise.resolve(ctx.session.fork(path, index))
      },

      getUiPrefs() {
        return ctx.settings.prefs().ui
      },

      setUiPrefs(patch) {
        const current = ctx.settings.prefs().ui
        ctx.settings.setPrefs({ ui: { ...current, ...patch } })
        // 分组展开态与会话拖拽顺序是点一下/拖一下就写一次的高频静默写入，
        // 弹回执反而吵：这两类补丁直接返回，不进下面的文案链。
        if (patch.sessionExpansion !== undefined || patch.sessionOrder !== undefined) {
          return Promise.resolve({ ok: true })
        }
        const notice =
          patch.sessionSort !== undefined
            ? patch.sessionSort === 'recent'
              ? '会话改为按最近更新排序（置顶的仍排最前）'
              : patch.sessionSort === 'created'
                ? '会话改为按创建时间排序（置顶的仍排最前）'
                : '会话改为手动排序：工作区按拖动顺序，没拖过就活动区置顶'
            : patch.sessionGroup !== undefined
              ? '已切换会话列表的分组方式'
              : patch.archivedFilter !== undefined
                ? '已切换已归档会话的显隐'
                : patch.workspaceOrder !== undefined
                  ? '已保存工作区顺序'
                  : patch.themeMode !== undefined ||
                      patch.fontSize !== undefined ||
                      patch.density !== undefined ||
                      patch.buttonScale !== undefined
                    ? '已保存外观设置'
                    : patch.processFold !== undefined
                      ? patch.processFold === 'compact'
                        ? '过程折叠程度改为紧凑：整轮收起、阶段分组，思考行不显示摘要，组头不报实时详情'
                        : patch.processFold === 'detailed'
                          ? '过程折叠程度改为详细：整轮照旧收起，但只有历史轮分组，正在跑的那一轮直接摊开'
                          : patch.processFold === 'verbose'
                            ? '过程折叠程度改为逐条摊开：不做整轮折叠，阶段也不分组'
                            : '过程折叠程度改为标准：整轮过程收起，摘要照显，组头带实时详情'
                      : patch.reasoningDefaultOpen !== undefined
                        ? patch.reasoningDefaultOpen
                          ? '定稿的思考行默认展开'
                          : '定稿的思考行默认收起'
                        : patch.toolDefaultOpen !== undefined
                          ? patch.toolDefaultOpen
                            ? '工具卡默认展开'
                            : '工具卡默认收起'
                          : patch.turnCompleteSound !== undefined ||
                              patch.turnCompleteSoundVariant !== undefined ||
                              patch.turnCompleteNotify !== undefined
                            ? '已保存任务完成提醒设置'
                            : '已保存工作区名字'
        return Promise.resolve({ ok: true, notice })
      },

      answerApproval(answer, source) {
        ctx.approval.answer(answer, source)
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
