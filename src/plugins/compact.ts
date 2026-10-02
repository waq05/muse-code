/**
 * compact 插件：provide `compact` 服务（自动压缩检查 + /compact 手动压缩 + 原样带过去的文本登记）。
 * 逻辑迁自 v2 adapter/core-runtime 的 autoCompact 段与 /compact 命令分支；
 * 结果提示统一经 dsc/notice 事件，注册 /compact 命令进 commands 注册表。
 * 真正压出结果的那条提示带 `'compaction'` 类别：transcript 据此给条目打压缩标记，
 * 轨迹页才能把「压缩历史」画成独立区段；失败与「无需压缩」的提示不带这个类别。
 *
 * 「哪些内容不许被摘要模型改写」由功能点自己登记（`registerCarry`）：任务清单与会话目标
 * 各登记一段文本，这个插件因此不认识任何具体功能。
 *
 * 四个可调值（保留条数、自动压缩触发线、锚点索引字符预算、用户原话字符预算）读自己的插件配置，
 * 并以设置分区的面目交给界面；保存后本插件立刻重读，下一次压缩就用新值。
 *
 * @module dsc/plugins/compact
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { compactSession, DEFAULT_KEEP_RECENT, estimateTokens } from '../core/compact.js'
import type { CompactLimits } from '../core/compact.js'
import { DEFAULT_ANCHOR_BUDGET_CHARS, DEFAULT_USER_QUOTE_BUDGET_CHARS } from '../core/compact-anchors.js'
import { errText } from '../adapter/transcript.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import type { SettingsField, SettingsValues } from '../contract.js'
import type { CompactService, SettingsSectionSpec } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'compact'

/** 压缩的可调值。 */
interface CompactConfig {
  /** 折进摘要之后原样保留的最近消息条数。 */
  keepRecent: number
  /** 估算用量超过模型上下文窗口的这个百分比就自动压缩。 */
  autoCompactPercent: number
  /** 摘要里机械抽取的锚点索引占多少字符。 */
  anchorBudgetChars: number
  /** 摘要里逐字引用的用户原话占多少字符。 */
  userQuoteBudgetChars: number
}

const DEFAULTS: CompactConfig = {
  keepRecent: DEFAULT_KEEP_RECENT,
  autoCompactPercent: 80,
  anchorBudgetChars: DEFAULT_ANCHOR_BUDGET_CHARS,
  userQuoteBudgetChars: DEFAULT_USER_QUOTE_BUDGET_CHARS,
}

/** 两个字符预算的取值区间：低于下限抽不出几条，高于上限摘要本身就没地方放了。 */
const ANCHOR_BUDGET_RANGE = { min: 1000, max: 20000 }
const USER_QUOTE_BUDGET_RANGE = { min: 1000, max: 40000 }

/**
 * 从插件配置取这些可调值，并把区间外的值夹回来。
 * @param passed - 装配时传进来的配置（内核挂载时的第二参数）；没给就读磁盘。
 */
function readConfig(passed?: unknown): CompactConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const num = Number(value)
    return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), min), max) : fallback
  }
  return {
    // 少于 5 条等于没给下一个自己留上下文，多于 200 条基本压不出空间。
    keepRecent: clamp(raw.keepRecent, 5, 200, DEFAULTS.keepRecent),
    // 低于 50% 会在干活时频繁打断，高于 95% 等于等模型报错才压。
    autoCompactPercent: clamp(raw.autoCompactPercent, 50, 95, DEFAULTS.autoCompactPercent),
    anchorBudgetChars: clamp(
      raw.anchorBudgetChars,
      ANCHOR_BUDGET_RANGE.min,
      ANCHOR_BUDGET_RANGE.max,
      DEFAULTS.anchorBudgetChars,
    ),
    userQuoteBudgetChars: clamp(
      raw.userQuoteBudgetChars,
      USER_QUOTE_BUDGET_RANGE.min,
      USER_QUOTE_BUDGET_RANGE.max,
      DEFAULTS.userQuoteBudgetChars,
    ),
  }
}

export const compactPlugin: Plugin.Object = {
  name: 'compact',
  inject: ['llm', 'session', 'commands', 'settings'],
  provide: 'compact',
  apply(ctx) {
    let config = readConfig()
    /** 经 llm 服务适配器表派发的流式请求（压缩摘要用的模型调用从这条缝走）。 */
    const stream = ctx.llm.stream.bind(ctx.llm)
    /** 写盘并立刻重读：下一次压缩就用新值，不必重启宿主。 */
    const applyConfig = (patch: Record<string, unknown | null>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      config = readConfig()
    }
    /** 当前配置里的三个压缩上限，现读 config，保存后下一压就用新值。 */
    const limits = (): CompactLimits => ({
      keepRecent: config.keepRecent,
      anchorChars: config.anchorBudgetChars,
      userQuoteChars: config.userQuoteBudgetChars,
    })

    /** 摘要之外必须原样带过去的文本：由各功能点登记，按登记顺序拼接。 */
    const carries: Array<() => string> = []
    /** 拼出压缩时要原样附在摘要后面的文本。 */
    const carry = (): string =>
      carries
        .map((contribute) => contribute())
        .filter((part) => part !== '')
        .join('\n\n')

    // T41 /compact 运行守卫：回合跑着的时候手动压缩，摘要落库会和进行中的工具
    // 落库交错（jsonl 里 summary 插在 tool 记录中间，重放口径会乱）。数着回合。
    let runningTurns = 0
    ctx.on('dsc/turn-start', () => {
      runningTurns += 1
    })
    ctx.on('dsc/turn-end', () => {
      runningTurns = Math.max(0, runningTurns - 1)
    })

    const service: CompactService = {
      registerCarry(contribute) {
        carries.push(contribute)
        return () => {
          const at = carries.indexOf(contribute)
          if (at >= 0) carries.splice(at, 1)
        }
      },
      /** 当前模型路由 + 配置里的自动压缩触发线（缺省 contextWindow 的 80%）。 */
      async check(signal) {
        const threshold = ctx.llm.contextWindow * (config.autoCompactPercent / 100)
        if (estimateTokens(ctx.session.current().messages) <= threshold) return
        const outcome = await compactSession(
          ctx.session.current(),
          ctx.llm.route(),
          stream,
          signal ?? new AbortController().signal,
          carry(),
          limits(),
        )
        const compacted = outcome === 'compacted'
        // 只有真压出结果才打压缩标记：noop 时这条提示照旧发（文案不动），
        // 但轨迹页不该凭空多出一段「压缩历史」
        ctx.emit('dsc/notice', '上下文接近模型上限，已自动压缩历史', compacted ? 'compaction' : undefined)
        if (compacted) ctx.emit('dsc/compacted')
      },

      /** 请求已经因爆窗失败，强制压一次（2026-09-29）：压出空间返回 true，循环方重试请求。 */
      async forceCompact(signal) {
        const outcome = await compactSession(
          ctx.session.current(),
          ctx.llm.route(),
          stream,
          signal ?? new AbortController().signal,
          carry(),
          limits(),
          true,
        )
        if (outcome === 'compacted') {
          // 打上 'compaction' 类别：transcript 据此把这条通知标成压缩落点（轨迹页切区段）
          ctx.emit('dsc/notice', '上下文超出模型窗口：已自动压缩历史并重试', 'compaction')
          ctx.emit('dsc/compacted')
          return true
        }
        return false
      },

      async run() {
        // T41：回合运行中不许手动压——等这轮结束，或者先打断再压
        if (runningTurns > 0) {
          ctx.emit('dsc/notice', '回合还在跑，等这轮结束（或先打断）再压缩：中途压会让摘要与工具结果的落库交错')
          ctx.emit('dsc/changed')
          return
        }
        try {
          const outcome = await compactSession(
            ctx.session.current(),
            ctx.llm.route(),
            stream,
            new AbortController().signal,
            carry(),
            limits(),
          )
          const compacted = outcome === 'compacted'
          ctx.emit(
            'dsc/notice',
            compacted ? '上下文已压缩（任务清单与目标原样保留）' : '历史不长，无需压缩',
            compacted ? 'compaction' : undefined,
          )
          // 压完等于换了半本历史：加载时冻结的东西该重算了（记忆栏就是这么挂上去的）
          if (compacted) ctx.emit('dsc/compacted')
        } catch (error) {
          ctx.emit('dsc/notice', `压缩失败：${errText(error)}`)
        }
        ctx.emit('dsc/changed')
      },
    }

    ctx.commands.register(
      { name: 'compact', args: '', description: '压缩上下文' },
      ({ runtime }) => void runtime.compact(),
    )
    ctx.provide('compact', service)

    const fields: SettingsField[] = [
      {
        type: 'number',
        key: 'keepRecent',
        label: '压缩后保留最近多少条',
        min: 5,
        max: 200,
        step: 5,
        help: '更早的历史折进摘要，这些条原样留着：数值越大，压缩后模型能看到的原文越多，省出来的上下文越少。',
      },
      {
        type: 'number',
        key: 'autoCompactPercent',
        label: '自动压缩触发线（占模型上下文窗口的百分比）',
        min: 50,
        max: 95,
        step: 5,
        help: '估算用量超过这个比例就自动压缩；/compact 手动压缩不受这条线限制。',
      },
      {
        type: 'number',
        key: 'anchorBudgetChars',
        label: '锚点索引字符预算',
        min: ANCHOR_BUDGET_RANGE.min,
        max: ANCHOR_BUDGET_RANGE.max,
        step: 500,
        help: '摘要里附一份正则抽出来的 PR 号 / SHA / 文件路径 / 报错原文清单，这些标识符不经模型改写。数值越大列得越全，摘要占的上下文越多。',
      },
      {
        type: 'number',
        key: 'userQuoteBudgetChars',
        label: '用户原话引用字符预算',
        min: USER_QUOTE_BUDGET_RANGE.min,
        max: USER_QUOTE_BUDGET_RANGE.max,
        step: 500,
        help: '压缩会把最近若干条真实用户消息逐字抄进摘要，模型改写过的转述可能与原话走样。数值越大抄得越多，摘要占的上下文越多。',
      },
    ]

    const section: SettingsSectionSpec = {
      id: 'compact',
      title: '上下文压缩',
      subtitle: '历史太长时把更早的部分折成一条摘要',
      order: 35,
      fields: () => fields,
      // 每次打开分区都现读磁盘：手改 plugins.json 也能看到真值。
      values: (): SettingsValues => {
        config = readConfig()
        return {
          keepRecent: config.keepRecent,
          autoCompactPercent: config.autoCompactPercent,
          anchorBudgetChars: config.anchorBudgetChars,
          userQuoteBudgetChars: config.userQuoteBudgetChars,
        }
      },
      // 契约：save 返回字符串 = 失败原因。
      save: (key, value): string | void => {
        const num = Number(value)
        if (!Number.isFinite(num)) return '这里要填一个数字'
        if (key === 'keepRecent') applyConfig({ keepRecent: num })
        else if (key === 'autoCompactPercent') applyConfig({ autoCompactPercent: num })
        else if (key === 'anchorBudgetChars') applyConfig({ anchorBudgetChars: num })
        else if (key === 'userQuoteBudgetChars') applyConfig({ userQuoteBudgetChars: num })
        else return `这个分区没有这项：${key}`
      },
    }
    const offSection = ctx.settings.registerSection(section)

    return () => offSection()
  },
}
