/**
 * skills 插件：provide `skills` 服务——技能发现、启停、市场浏览与安装，
 * 外加两个消费端：`skill` 工具（模型按需取正文）与 `/技能名` 命令（用户直接调用）。
 *
 * 模型可见目录（`<available_skills>`）由 agent 插件拼进系统提示词，
 * 这里只维护文本缓存：目录里只有名字和一句话说明，技能正文不进上下文。
 *
 * 扩展点：外部插件用 `ctx.skills.registerProvider` 挂远端技能源
 * （返回的条目 `local:false`，只展示不启停），用 `registerMarket` 挂私有市场。
 *
 * @module dsc/plugins/skills
 */
import { dirname } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import type { DscRuntime, MarketSkillView, MarketSource } from '../contract.js'
import {
  DSC_SKILLS_DIR,
  expandSkillDir,
  readDisabledSkills,
  scanSkillRoot,
  skillRoots,
  toSkillInfoView,
  writeSkillEnabled,
  type SkillDefinition,
} from '../core/skills.js'
import {
  browseMarketSource,
  installMarketEntry,
  toMarketSkillView,
  type MarketEntry,
} from '../core/market.js'
import { readConfigDoc } from '../core/config-store.js'
import { readPrefs } from '../core/prefs.js'
import type {
  CommandContext,
  SkillMarketProvider,
  SkillProvider,
  SkillService,
} from '../services/types.js'

const err = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 描述进目录的截断长度（照 dsh 的 catalogDescriptionMaxLength）。 */
const DESCRIPTION_LIMIT = 500

/** 不能占用成命令名的内置命令。 */
const RESERVED_COMMANDS = new Set(['new', 'resume', 'compact', 'model', 'help', 'exit', 'effort', 'plugins', 'skills'])

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** config.yaml 的 `skills:` 段（自定义发现目录，支持 `~` 与相对路径）。 */
function customSkillDirs(cwd: string): string[] {
  const raw = (readConfigDoc() as unknown as { skills?: unknown }).skills
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => expandSkillDir(entry, cwd))
    .filter((entry) => entry !== '')
}

export const skillsPlugin: Plugin.Object = {
  name: 'skills',
  provide: 'skills',
  inject: ['session', 'tools', 'commands', 'transcript'],
  apply(ctx) {
    /** 插件注册的技能提供方（rank 500+，不覆盖内置目录）。 */
    const providers: SkillProvider[] = []
    /** 插件注册的私有市场源。 */
    const markets = new Map<string, SkillMarketProvider>()
    /** 提供方贡献的条目缓存（异步拉取，同步读取用）。 */
    let remote = new Map<string, SkillDefinition>()
    let disabled = readDisabledSkills()
    let catalog = ''
    let inFlight: Promise<void> | null = null
    let staleAgain = false
    const commandDisposers = new Map<string, () => void>()

    const cwd = (): string => ctx.session.current().meta.cwd

    /** 扫全部内置目录 + 提供方缓存，重名按 rank 裁决，按名字排序。 */
    function collect(): SkillDefinition[] {
      const candidates: SkillDefinition[] = [...remote.values()]
      for (const root of skillRoots(cwd(), customSkillDirs(cwd()))) {
        try {
          candidates.push(...scanSkillRoot(root))
        } catch (error) {
          ctx.transcript.system(`技能目录 ${root.dir} 读取失败：${err(error)}`)
        }
      }
      const byName = new Map<string, SkillDefinition>()
      for (const definition of candidates.sort((a, b) => a.rank - b.rank)) {
        if (!byName.has(definition.name)) byName.set(definition.name, definition)
      }
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    }

    function buildCatalog(definitions: readonly SkillDefinition[]): string {
      const usable = definitions.filter((item) => item.modelInvocable && !disabled.has(item.name))
      if (usable.length === 0) return ''
      const lines = usable.map((item) => {
        const description =
          item.description.length > DESCRIPTION_LIMIT
            ? `${item.description.slice(0, DESCRIPTION_LIMIT)}…`
            : item.description
        // T47：whenToUse 之前解析了却没进目录——「何时该用」是模型挑技能的关键信号，
        // 照 dsh 的目录形态补渲染；没有就不加（不占预算）。
        const when = item.whenToUse === undefined ? '' : `（何时用：${item.whenToUse}）`
        return `- \`${item.name}\`: ${escapeXml(description)}${when}`
      })
      return (
        // T47：引导语从泛泛的「需要用到时」改成明确的第一判断——任务明显匹配就先调
        // skill 工具取正文，宁可先看一眼目录也别凭印象硬写。
        '以下技能是可直接照做的操作手册：接到任务时先扫一眼下面的目录，任务与某条技能明显' +
        '匹配就先用 skill 工具按名字取回正文、再照着执行；不要凭名字或印象猜内容，也不要在' +
        '没有匹配技能时硬套。\n\n<available_skills>\n' +
        `${lines.join('\n')}\n</available_skills>`
      )
    }

    /** 给每个 user-invocable 且已启用的技能注册 `/技能名` 命令。 */
    function syncCommands(definitions: readonly SkillDefinition[]): void {
      const wanted = new Map<string, SkillDefinition>()
      for (const definition of definitions) {
        if (!definition.userInvocable || disabled.has(definition.name)) continue
        if (RESERVED_COMMANDS.has(definition.name)) continue
        wanted.set(definition.name, definition)
      }
      for (const [name, dispose] of [...commandDisposers]) {
        if (wanted.has(name)) continue
        dispose()
        commandDisposers.delete(name)
      }
      for (const [name, definition] of wanted) {
        if (commandDisposers.has(name)) continue
        commandDisposers.set(
          name,
          ctx.commands.register(
            { name, args: '[需求]', description: `技能：${definition.description.slice(0, 36)}` },
            ({ args, runtime, ui }) => {
              void runSkillCommand(name, args.join(' '), runtime, ui)
            },
          ),
        )
      }
    }

    /** 重算缓存（清单 + 目录文本 + 命令），同一时刻只跑一次，期间的新请求合并成一次补跑。 */
    async function refresh(): Promise<void> {
      if (inFlight !== null) {
        staleAgain = true
        await inFlight
        return
      }
      inFlight = (async () => {
        disabled = readDisabledSkills()
        const fetched = await Promise.all(
          providers.map(async (provider) => {
            try {
              return await provider.list(cwd())
            } catch (error) {
              ctx.transcript.system(`技能源 ${provider.name} 拉取失败：${err(error)}`)
              return []
            }
          }),
        )
        const next = new Map<string, SkillDefinition>()
        for (const [provider, summaries] of providers.map((provider, index) => [provider, fetched[index] ?? []] as const)) {
          for (const summary of summaries) {
            if (next.has(summary.name)) continue
            next.set(summary.name, { ...summary, rank: provider.rank, local: false, content: '' })
          }
        }
        remote = next
        const definitions = collect()
        catalog = buildCatalog(definitions)
        syncCommands(definitions)
      })().catch((error: unknown) => {
        ctx.transcript.system(`技能刷新失败：${err(error)}`)
      })
      await inFlight
      inFlight = null
      if (staleAgain) {
        staleAgain = false
        await refresh()
      }
    }

    async function runSkillCommand(
      name: string,
      request: string,
      runtime: DscRuntime,
      ui: CommandContext,
    ): Promise<void> {
      const loaded = await service.read(name)
      if (!loaded.ok) {
        ui.notice(`技能 ${name} 打不开：${loaded.error}`)
        return
      }
      const head = `请使用技能 ${name} 处理下面的需求，照着技能正文的步骤做。`
      const body = request === '' ? '（用户没有补充需求，按技能正文的默认流程做）' : request
      runtime.submit(`${head}\n\n${body}\n\n<skill_content name="${name}">\n${loaded.skill.content}\n</skill_content>`)
    }

    /** 内置市场源清单（偏好里的 + 插件注册的）。 */
    function marketSources(): { source: MarketSource; plugin?: SkillMarketProvider }[] {
      return [
        ...readPrefs().marketSources.map((source) => ({ source })),
        ...[...markets.values()].map((market) => ({
          source: { name: market.name, url: `plugin:${market.name}` },
          plugin: market,
        })),
      ]
    }

    async function browsePluginEntries(name: string, refreshEntries: boolean): Promise<MarketSkillView[]> {
      const market = markets.get(name)
      if (market === undefined) throw new Error(`没有名为 ${name} 的市场源`)
      return market.browse(refreshEntries)
    }

    /** 内置 HTTP 源的条目缓存（安装时按名字回查取文件清单）。 */
    const entriesCache = new Map<string, MarketEntry[]>()

    const service: SkillService = {
      userDir: DSC_SKILLS_DIR,
      list() {
        return collect().map((definition) => toSkillInfoView(definition, disabled))
      },
      async read(name) {
        const definition = collect().find((item) => item.name === name)
        if (definition === undefined) return { ok: false, error: `没有名为 ${name} 的技能（/skills 看清单）` }
        if (definition.path === undefined) {
          const provider = providers.find((candidate) => candidate.rank === definition.rank)
          if (provider === undefined) return { ok: false, error: `${name} 由插件注册但没有 get 实现` }
          try {
            const fetched = await provider.get(name)
            if (fetched === undefined) return { ok: false, error: `技能源 ${provider.name} 里没有 ${name}` }
            return { ok: true, skill: { ...toSkillInfoView(fetched, disabled), content: fetched.content } }
          } catch (error) {
            return { ok: false, error: err(error) }
          }
        }
        // 正文每次重新读文件：用户可能刚在编辑器里改了技能
        const fresh = scanSkillRoot({
          dir: dirname(definition.path),
          source: definition.source,
          rank: definition.rank,
        }).find((item) => item.name === name)
        if (fresh === undefined) return { ok: false, error: `${definition.path} 已被删除或改名` }
        return { ok: true, skill: { ...toSkillInfoView(fresh, disabled), content: fresh.content } }
      },
      setEnabled(name, enabled) {
        const definition = collect().find((item) => item.name === name)
        if (definition === undefined) return { ok: false, error: `没有名为 ${name} 的技能` }
        if (!definition.local) return { ok: false, error: `${name} 由插件 ${definition.source} 提供，不能在技能中心启停` }
        writeSkillEnabled(name, enabled)
        ctx.emit('dsc/skills-changed')
        return { ok: true, notice: enabled ? `已启用 ${name}` : `已停用 ${name}` }
      },
      registerProvider(provider) {
        providers.push(provider)
        void refresh()
        return () => {
          const index = providers.indexOf(provider)
          if (index >= 0) providers.splice(index, 1)
          void refresh()
        }
      },
      registerMarket(market) {
        markets.set(market.name, market)
        return () => {
          if (markets.get(market.name) === market) markets.delete(market.name)
        }
      },
      async browseMarket(source, refreshEntries) {
        const sources = marketSources()
        const target = source === '' ? sources[0] : sources.find((item) => item.source.name === source)
        if (target === undefined) {
          return { sources: sources.map((item) => ({ ...item.source, ok: false })), source: '', items: [], error: '没有配置技能市场源，去设置里加一个' }
        }
        const sourceViews = sources.map((item) => ({ ...item.source, ok: true }))
        const installed = new Set(service.list().map((item) => item.name))
        try {
          const items =
            target.plugin !== undefined
              ? await browsePluginEntries(target.source.name, refreshEntries === true)
              : (await browseRemote(target.source, refreshEntries === true)).map((entry) =>
                  toMarketSkillView(entry, installed),
                )
          return { sources: sourceViews, source: target.source.name, items }
        } catch (error) {
          return {
            sources: sourceViews.map((item) =>
              item.name === target.source.name ? { ...item, ok: false, error: err(error) } : item,
            ),
            source: target.source.name,
            items: [],
            error: err(error),
          }
        }
      },
      async installMarketSkill(source, name) {
        const market = markets.get(source)
        if (market !== undefined) {
          const notice = await market.install(name)
          ctx.emit('dsc/skills-changed')
          return { ok: true, notice: notice === '' ? undefined : notice }
        }
        const configured = readPrefs().marketSources.find((item) => item.name === source)
        if (configured === undefined) return { ok: false, error: `没有名为 ${source} 的市场源` }
        try {
          const entries = await browseRemote(configured, false)
          const entry = entries.find((item) => item.name === name)
          if (entry === undefined) return { ok: false, error: `${source} 里没有 ${name}` }
          const result = await installMarketEntry(entry, DSC_SKILLS_DIR)
          ctx.emit('dsc/skills-changed')
          return { ok: true, notice: `已安装 ${name}（${result.files} 个文件 → ${result.target}）` }
        } catch (error) {
          return { ok: false, error: err(error) }
        }
      },
      catalogText() {
        return catalog
      },
    }

    /** 浏览内置 HTTP 源（结果按源名缓存，安装时按名字回查）。 */
    async function browseRemote(source: MarketSource, force: boolean): Promise<MarketEntry[]> {
      const cached = entriesCache.get(source.name)
      if (cached !== undefined && !force) return cached
      const entries = await browseMarketSource(source, { refresh: force })
      entriesCache.set(source.name, entries)
      return entries
    }

    // ── `skill` 工具：模型按名字取正文 ──
    ctx.tools.register({
      name: 'skill',
      description:
        '按名字加载一个技能的完整正文（正文里通常包含步骤、脚本路径与注意事项）。' +
        '名字必须来自系统提示里的 <available_skills> 目录，不要猜。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名（kebab-case，来自 <available_skills>）' },
        },
        required: ['name'],
      },
      risk: 'read',
      async run(args) {
        const name = String(args.name ?? '').trim()
        if (name === '') return '缺少 name 参数'
        const loaded = await service.read(name)
        if (!loaded.ok) return `加载技能失败：${loaded.error}`
        if (!loaded.skill.enabled) return `技能 ${name} 已被停用，需要用户先在技能中心启用`
        const location = loaded.skill.path === undefined ? '' : `\n<skill_location>${loaded.skill.path}</skill_location>`
        return `<skill_content name="${name}">\n${loaded.skill.content}\n</skill_content>${location}`
      },
    })

    // ── /skills：清单与用法 ──
    ctx.commands.register({ name: 'skills', args: '', description: '查看技能清单，可在技能中心启停' }, ({ ui }) => {
      const items = service.list()
      if (items.length === 0) {
        ui.notice(
          `还没有技能。\n将 <名字>/SKILL.md 放入 ${DSC_SKILLS_DIR} 或项目的 .dsc/skills 即可，` +
            '桌面端「技能」页也能从市场安装。',
        )
        return
      }
      const lines = items.map((item) => {
        const flags = [item.enabled ? '' : '已停用', item.modelInvocable ? '' : '不进目录'].filter((flag) => flag !== '').join('，')
        return `/${item.name}\t${item.description.slice(0, 46)}${flags === '' ? '' : `（${flags}）`}`
      })
      ui.notice(`技能（${items.length} 个，主目录 ${DSC_SKILLS_DIR}）\n${lines.join('\n')}`)
    })

    ctx.on('dsc/session-open', () => {
      void refresh()
    })
    ctx.on('dsc/skills-changed', () => {
      void refresh()
    })

    ctx.provide('skills', service)
    void refresh()
  },
}
