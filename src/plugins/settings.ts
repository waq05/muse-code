/**
 * settings 插件：provide `settings` 服务——设置分区注册表 + 模型配置读写 + 界面偏好。
 *
 * 设置界面（桌面端）只有两张渲染表：通用表单控件表（text/number/select/switch/info/button）
 * 和「这块界面由桌面端自己画」的特殊分区（模型、技能）。内置分区「通用」「关于」也走同一张
 * 表注册，插件贡献的分区（`ctx.settings.registerSection`）拿到的是完全相同的入口——
 * 插件给的是 JSON 声明和回调，不提供组件，所以 Electron 的 contextIsolation 不破。
 *
 * 模型配置的写入落 `~/.dsc/config.yaml` 与 `~/.dsc/credentials.yaml`，写完把同一份
 * 内存配置对象刷新一次（llm 插件持有的是同一个引用），所以加端点不用重启宿主。
 *
 * @module dsc/plugins/settings
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type {
  ApprovalPolicy,
  EffortLevel,
  ModelConfigView,
  ProviderDraft,
  SettingsField,
  SettingsMutation,
  SettingsSectionView,
  SettingsValues,
} from '../contract.js'
import type { DscCoreConfig } from '../core/config.js'
import { readConfig } from '../core/config.js'
import {
  CONFIG_FILE,
  CREDENTIALS_FILE,
  deleteProvider,
  readModelConfig,
  upsertProvider,
  writeDefaultModel,
  writeProviderKey,
  writeTemperature,
} from '../core/config-store.js'
import { DSC_SKILLS_DIR } from '../core/skills.js'
import { DEFAULT_MARKET_SOURCES, readPrefs, writePrefs, type DscPrefs } from '../core/prefs.js'
import { KERNEL_API_VERSION } from '../core/plugin-registry.js'
import { DSC_PLUGINS_DIR } from '../core/plugin-loader.js'
import { DSC_VERSION } from '../core/version.js'
import type { SettingsSectionSpec, SettingsService } from '../services/types.js'

const err = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 分区 id → 值。空对象 = 该分区没有控件值。 */
type Values = SettingsValues

/** 温度下拉（避免自由输入数字，也覆盖常见用法）。 */
const TEMPERATURE_OPTIONS = [
  { value: 'follow', label: '跟随端点默认' },
  { value: '0', label: '0，稳定复现' },
  { value: '0.3', label: '0.3，偏严谨' },
  { value: '0.7', label: '0.7，常用' },
  { value: '1', label: '1，偏发散' },
]

const POLICY_OPTIONS = [
  { value: 'readonly', label: '只读，写文件与执行命令均需批准' },
  { value: 'auto-edit', label: '自动放行编辑，执行命令仍需批准' },
  { value: 'full-access', label: '完全访问，不再询问' },
  { value: 'ai-review', label: 'AI 审阅，不确定时询问模型' },
]

const EFFORT_OPTIONS = [
  { value: 'default', label: '跟随端点默认' },
  { value: 'off', label: '关闭思考' },
  { value: 'low', label: '低' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最高' },
]

/** dsc 的家目录（关于分区）。 */
const DSC_HOME = join(homedir(), '.dsc')

/** 读一个包版本号（失败返回 unknown，绝不因为读版本而崩）。 */
function packageVersion(): string {
  return DSC_VERSION
}

export const settingsPlugin: Plugin.Object<DscCoreConfig> = {
  name: 'settings',
  provide: 'settings',
  inject: ['llm', 'approval', 'transcript'],
  apply(ctx, config) {
    /** 分区注册表（id → 声明）。 */
    const sections = new Map<string, SettingsSectionSpec>()
    /** 内核自己注册的分区（UI 上标「内置」，插件贡献的不标）。 */
    const builtinIds = new Set<string>()
    /** 偏好快照（读盘一次，写盘后更新）。 */
    let prefs = readPrefs()
    /** 偏好写盘后的监听者（远程控制这类「改了就起停服务」的功能点）。 */
    const prefListeners = new Set<(prefs: DscPrefs) => void>()

    /**
     * 写盘并广播。所有偏好写入都走这里，别直接调 writePrefs：
     * 绕过去的话监听者收不到通知，界面上改了开关而服务没跟着起停。
     */
    function savePrefs(patch: Partial<DscPrefs>): DscPrefs {
      prefs = writePrefs(patch)
      for (const listener of [...prefListeners]) {
        try {
          listener(prefs)
        } catch (error) {
          // 监听者是别人家的功能点，它自己炸了不能把「保存设置」这条链带下水
          ctx.transcript.system(`偏好变更处理失败：${err(error)}`)
        }
      }
      return prefs
    }

    /** 把磁盘上的模型配置刷进 llm 插件持有的那个对象。 */
    function reloadLive(): void {
      const fresh = readConfig()
      for (const name of Object.keys(config.providers)) delete config.providers[name]
      Object.assign(config.providers, fresh.providers)
      config.defaultProvider = fresh.defaultProvider
      config.defaultModel = fresh.defaultModel
      config.temperature = fresh.temperature
      const current = config.providers[ctx.llm.provider]
      const stillUsable = current !== undefined && current.models.some((model) => model.id === ctx.llm.model)
      if (!stillUsable && fresh.defaultProvider !== '') {
        try {
          ctx.llm.setModel(fresh.defaultProvider, fresh.defaultModel)
        } catch (error) {
          ctx.transcript.system(`模型配置已更新，但当前模型不可用了：${err(error)}`)
        }
      }
    }

    async function mutate(work: () => string | void | Promise<string | void>): Promise<SettingsMutation> {
      try {
        const notice = await work()
        return { ok: true, notice: typeof notice === 'string' && notice !== '' ? notice : undefined }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    }

    /**
     * 分区 `save()` 专用的那一条：返回值含义与 {@link mutate} 相反。
     *
     * 契约见 `SettingsSectionSpec.save`——「抛错或返回字符串 = 失败原因」，而字符串当
     * 成功提示是 `action()` 与 `saveProvider()` 那几条路的规矩。两条共用一个 mutate，
     * 校验失败会显示成绿色的成功提示条，错值还会被存进去。
     */
    async function mutateSave(work: () => string | void | Promise<string | void>): Promise<SettingsMutation> {
      try {
        const failure = await work()
        if (typeof failure === 'string' && failure !== '') return { ok: false, error: failure }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    }

    // ── 内置分区：通用 ────────────────────────────────────────────────────────
    const general: SettingsSectionSpec = {
      id: 'general',
      title: '通用',
      subtitle: '权限模式、思考强度与采样温度',
      order: 0,
      fields(): SettingsField[] {
        return [
          { type: 'select', key: 'policy', label: '权限模式', options: POLICY_OPTIONS, help: '决定工具执行前是否需要人工授权；修改后同时作为下次启动的默认值' },
          { type: 'select', key: 'effort', label: '思考强度', options: EFFORT_OPTIONS, help: '发给端点的 thinking 开关与档位' },
          { type: 'select', key: 'temperature', label: '采样温度', options: TEMPERATURE_OPTIONS, help: `写入 ${CONFIG_FILE} 的 temperature` },
          {
            type: 'switch',
            key: 'closeToTray',
            label: '关窗缩到托盘',
            help: '点击窗口关闭按钮时仅隐藏窗口，应用继续在后台运行；关闭该开关后点击关闭按钮即退出应用',
          },
          { type: 'info', label: '配置文件', text: CONFIG_FILE, mono: true, copyable: true },
        ]
      },
      values(): Values {
        return {
          policy: ctx.approval.policy,
          effort: ctx.llm.effort,
          temperature: config.temperature === undefined ? 'follow' : String(config.temperature),
          closeToTray: prefs.closeToTray,
        }
      },
      async save(key, value) {
        if (key === 'policy') {
          const policy = String(value) as ApprovalPolicy
          if (!POLICY_OPTIONS.some((option) => option.value === policy)) throw new Error(`未知的权限模式 ${value}`)
          ctx.approval.setPolicy(policy)
          savePrefs({ defaultPolicy: policy })
          return `权限模式已设为「${POLICY_OPTIONS.find((option) => option.value === policy)?.label ?? policy}」，下次启动沿用`
        }
        if (key === 'effort') {
          const effort = String(value) as EffortLevel
          if (!EFFORT_OPTIONS.some((option) => option.value === effort)) throw new Error(`未知的思考强度 ${value}`)
          ctx.llm.setEffort(effort)
          savePrefs({ defaultEffort: effort })
          return `思考强度已设为「${EFFORT_OPTIONS.find((option) => option.value === effort)?.label ?? effort}」，下次启动沿用`
        }
        if (key === 'temperature') {
          writeTemperature(value === 'follow' ? null : Number(value))
          reloadLive()
          return value === 'follow' ? '已改为跟随端点默认' : `温度已设为 ${value}`
        }
        if (key === 'closeToTray') {
          savePrefs({ closeToTray: value === true })
          return value === true
            ? '已设为关窗缩到托盘，托盘图标可以唤起或退出'
            : '已设为关窗直接退出（宿主收尾最多 2 秒）'
        }
        throw new Error(`未知的设置项 ${key}`)
      },
    }

    // ── 内置分区：模型（结构化界面由桌面端画） ─────────────────────────────────
    const models: SettingsSectionSpec = {
      id: 'models',
      title: '模型',
      subtitle: '端点、默认模型与 API key',
      order: 10,
      custom: true,
      fields: () => [],
      values: () => ({}),
    }

    // ── 内置分区：技能（同上，数据走 SkillService） ────────────────────────────
    const skillsSection: SettingsSectionSpec = {
      id: 'skills',
      title: '技能',
      subtitle: '技能开关与市场源',
      order: 20,
      custom: true,
      fields: () => [],
      values: () => ({}),
    }

    // ── 内置分区：归档（会话恢复与永久删除由桌面端画，数据走 session 服务） ────
    const archiveSection: SettingsSectionSpec = {
      id: 'archive',
      title: '归档',
      subtitle: '已归档会话的恢复与永久删除',
      order: 30,
      custom: true,
      fields: () => [],
      values: () => ({}),
    }

    // ── 内置分区：用量统计（热力图 / 趋势 / 模型占比由桌面端画，数据走 usageStats） ──
    const usageSection: SettingsSectionSpec = {
      id: 'usage',
      title: '用量统计',
      subtitle: 'Token 活动热力图、趋势与模型占比',
      order: 25,
      custom: true,
      fields: () => [],
      values: () => ({}),
    }

    // ── 内置分区：关于 ────────────────────────────────────────────────────────
    const about: SettingsSectionSpec = {
      id: 'about',
      title: '关于',
      subtitle: '版本与本机路径',
      order: 900,
      fields(): SettingsField[] {
        return [
          { type: 'info', label: 'Muse Code 版本', text: packageVersion() },
          { type: 'info', label: '内核 API 版本', text: String(KERNEL_API_VERSION), help: '外部插件声明的 apiVersion 高于此值时会被自动停用' },
          { type: 'info', label: '配置目录', text: DSC_HOME, mono: true, copyable: true },
          { type: 'info', label: '模型配置', text: CONFIG_FILE, mono: true, copyable: true },
          { type: 'info', label: '凭据库', text: CREDENTIALS_FILE, mono: true, copyable: true, help: 'API key 仅存储于此，界面不回显' },
          { type: 'info', label: '技能目录', text: DSC_SKILLS_DIR, mono: true, copyable: true },
          { type: 'info', label: '插件目录', text: DSC_PLUGINS_DIR, mono: true, copyable: true },
        ]
      },
      values: () => ({}),
    }

    function register(section: SettingsSectionSpec, builtin: boolean): () => void {
      sections.set(section.id, section)
      if (builtin) builtinIds.add(section.id)
      ctx.transcript.touch()
      return () => {
        if (sections.get(section.id) === section) sections.delete(section.id)
        builtinIds.delete(section.id)
      }
    }

    for (const section of [general, models, skillsSection, archiveSection, usageSection, about]) register(section, true)

    const service: SettingsService = {
      kernelApiVersion: KERNEL_API_VERSION,
      registerSection(section) {
        if (builtinIds.has(section.id)) {
          ctx.transcript.system(`插件试图覆盖内置设置分区 ${section.id}，已忽略`)
          return () => {}
        }
        return register(section, false)
      },
      sections(): SettingsSectionView[] {
        return [...sections.values()]
          .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title))
          .map((section) => ({
            id: section.id,
            title: section.title,
            subtitle: section.subtitle,
            order: section.order ?? 100,
            builtin: builtinIds.has(section.id),
            custom: section.custom === true,
            fields: section.fields(),
          }))
      },
      async values(id) {
        const section = sections.get(id)
        if (section === undefined) throw new Error(`没有名为 ${id} 的设置分区`)
        return section.values()
      },
      async save(id, key, value) {
        const section = sections.get(id)
        if (section === undefined) return { ok: false, error: `没有名为 ${id} 的设置分区` }
        if (builtinIds.has(id) && section.save === undefined) return { ok: false, error: `${id} 分区不接受写入` }
        if (section.save === undefined) return { ok: false, error: `${section.title} 分区没有实现写入` }
        return mutateSave(async () => {
          const result = await section.save?.(key, value)
          ctx.transcript.touch()
          return result
        })
      },
      async action(id, name) {
        const section = sections.get(id)
        if (section === undefined) return { ok: false, error: `没有名为 ${id} 的设置分区` }
        if (section.action === undefined) return { ok: false, error: `${section.title} 分区没有实现动作 ${name}` }
        return mutate(async () => {
          const result = await section.action?.(name)
          ctx.transcript.touch()
          return result
        })
      },
      modelConfig(): ModelConfigView {
        return readModelConfig()
      },
      saveProvider(draft: ProviderDraft): SettingsMutation {
        return mutateWith(() => {
          const name = upsertProvider(draft.oldName, draft)
          reloadLive()
          return draft.oldName === null ? `已添加端点 ${name}` : `已保存端点 ${name}`
        })
      },
      removeProvider(name: string): SettingsMutation {
        return mutateWith(() => {
          deleteProvider(name)
          reloadLive()
          return `已删除端点 ${name}`
        })
      },
      setProviderKey(name: string, apiKey: string | null): SettingsMutation {
        return mutateWith(() => {
          const doc = readModelConfig().providers.find((entry) => entry.name === name)
          if (doc === undefined) throw new Error(`没有名为 ${name} 的端点`)
          const notice = writeProviderKey(doc.keyRef, apiKey)
          reloadLive()
          return notice
        })
      },
      setDefaultModel(provider: string, model: string): SettingsMutation {
        return mutateWith(() => {
          writeDefaultModel(provider, model)
          reloadLive()
          ctx.llm.setModel(provider, model)
          return `默认模型已设为 ${provider}/${model}`
        })
      },
      prefs() {
        return prefs
      },
      setPrefs(patch: Partial<DscPrefs>) {
        const next = savePrefs(patch)
        if (patch.defaultPolicy !== undefined && patch.defaultPolicy !== null) {
          ctx.approval.setPolicy(next.defaultPolicy ?? 'readonly')
        }
        if (patch.defaultEffort !== undefined && patch.defaultEffort !== null) {
          ctx.llm.setEffort(next.defaultEffort ?? 'default')
        }
        return next
      },
      watchPrefs(listener: (prefs: DscPrefs) => void) {
        prefListeners.add(listener)
        return () => {
          prefListeners.delete(listener)
        }
      },
      about() {
        return {
          version: packageVersion(),
          apiVersion: KERNEL_API_VERSION,
          home: DSC_HOME,
          skillsDir: DSC_SKILLS_DIR,
          pluginsDir: DSC_PLUGINS_DIR,
        }
      },
    }

    /** 同步 mutate（契约里模型方法返回同步值，内部仍要兜住异常）。 */
    function mutateWith(work: () => string): SettingsMutation {
      try {
        const notice = work()
        ctx.transcript.touch()
        return { ok: true, notice }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    }

    // 启动时应用偏好里的默认档位（没设置就保持内核默认）
    if (prefs.defaultPolicy !== null) {
      try {
        ctx.approval.setPolicy(prefs.defaultPolicy)
      } catch (error) {
        ctx.transcript.system(`默认权限模式没生效：${err(error)}`)
      }
    }
    if (prefs.defaultEffort !== null && prefs.defaultEffort !== 'default') {
      try {
        ctx.llm.setEffort(prefs.defaultEffort)
      } catch (error) {
        ctx.transcript.system(`默认思考强度没生效：${err(error)}`)
      }
    }
    if (prefs.marketSources.length === 0) {
      // 首次使用给一份默认市场源，技能中心的「市场」tab 才不是空的
      savePrefs({ marketSources: [...DEFAULT_MARKET_SOURCES] })
    }

    ctx.provide('settings', service)
  },
}
