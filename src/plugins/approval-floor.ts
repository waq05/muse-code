/**
 * approval-floor 插件：把审批灾难地板挂到守卫链的 order 5 上（官方可开关插件）。
 *
 * 判定逻辑全在 `core/approval-floor.ts`，这个文件只做四件装配的事：
 *   1. 把守卫注册进守卫链；
 *   2. 把白名单的结论以 `approvalFloor` 服务交出去，由审批层免卡放行（地板自己不 return pass，
 *      否则排在 order 20 / 25 的安全钩子会被一起跳掉）；
 *   3. 每次判定现读配置（`resolvePluginConfig('approval-floor', passed)` + 磁盘），
 *      设置页改完立刻生效；
 *   4. 注册 `/floor` 命令与设置分区，把当前规则与熔断状态摆给用户看。
 *
 * 这个插件不认识协作模式：模式闸门（order 10）排在地板后面，它会自己拦该拦的档位，
 * 地板只要保证「不拒的时候不越权替别人放行」就够了。
 *
 * @module dsc/plugins/approval-floor
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import {
  createApprovalFloor,
  FLOOR_CONFIG_KEY,
  FLOOR_LIMITS,
  parseGlobListText,
  parsePrefixListText,
  resolveFloorConfig,
  type FloorConfig,
} from '../core/approval-floor.js'
import { activeRules } from '../core/command-policy.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import type { SettingsField, SettingsValue, SettingsValues } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'

/** 配置与设置提示里要写清的来源文件（手改它同样生效）。 */
const PLUGINS_FILE = join(homedir(), '.dsc', 'plugins.json')

/** 前缀清单的多行文本形式（设置页那个框读写的就是它）。 */
function prefixText(config: FloorConfig): string {
  return config.allowPrefixes.map((pattern) => pattern.join(' ')).join('\n')
}

/** 一份数值字段的区间校验，失败返回给用户看的原因。 */
function checkInt(value: SettingsValue, limits: { min: number; max: number }, label: string): string | null {
  const num = Number(value)
  if (!Number.isFinite(num) || !Number.isInteger(num)) return `${label}要填一个整数`
  if (num < limits.min || num > limits.max) return `${label}要在 ${limits.min}~${limits.max} 之间`
  return null
}

export const approvalFloorPlugin: Plugin.Object = {
  name: 'approval-floor',
  inject: ['guards', 'commands', 'settings'],
  apply(ctx, passed) {
    const readConfig = () => resolveFloorConfig(resolvePluginConfig(FLOOR_CONFIG_KEY, passed))
    const floor = createApprovalFloor({
      readConfig,
      rules: () => activeRules(),
    })
    const offGuard = ctx.guards.register(floor.guard)

    // 白名单的结论交给审批层执行：地板不自己 pass，因此排在中间的钩子照常被问到。
    const offService = ctx.provide('approvalFloor', {
      whitelist: (command: string) => floor.whitelist(command),
      count: () => readConfig().config.allowPrefixes.length,
    })

    // 换会话把熔断清掉：上一个会话连着撞的坑不该让新会话一开局就被熔断拦住。
    ctx.on('dsc/session-open', () => floor.reset())

    /** `/floor` 与设置分区共用的那段说明。 */
    const describe = (): string => {
      const { config, problems } = readConfig()
      const breaker = floor.breaker()
      const lines: string[] = []
      lines.push('审批灾难地板：守卫链 order 5（先于模式 10、安全钩子 20、审批 30）')
      lines.push(`白名单（命中由审批层免卡放行，共 ${config.allowPrefixes.length} 条）：`)
      for (const pattern of config.allowPrefixes) lines.push(`  ${pattern.join(' ')}`)
      lines.push(`deny 黑名单（命中即拒，共 ${config.denyGlobs.length} 条）：`)
      for (const glob of config.denyGlobs) lines.push(`  ${glob}`)
      lines.push(`命令长度上限：${config.maxCommandLength} 字符｜无人值守：${config.unattended ? '开（ask 级命令与工作区外的写一律拒）' : '关'}`)
      lines.push(
        config.circuitBreakerEnabled
          ? `熔断：开｜连续被拒 ${config.circuitBreakerThreshold} 次后冷却 ${Math.round(config.circuitBreakerCooldownMs / 1000)} 秒｜当前连续 ${breaker.consecutiveDenies} 次${breaker.tripped ? '，正在熔断中' : ''}`
          : '熔断：关',
      )
      lines.push(`配置文件：${PLUGINS_FILE} 的 ${FLOOR_CONFIG_KEY} 条目（设置页也能改）`)
      if (problems.length > 0) {
        lines.push('⚠ 配置有问题，现在一律拒：')
        for (const problem of problems) lines.push(`  ${problem}`)
      }
      return lines.join('\n')
    }

    const offCommand = ctx.commands.register(
      { name: 'floor', args: '', description: '看审批灾难地板的规则、白名单与熔断状态' },
      ({ ui }) => {
        ui.notice(describe())
      },
    )

    // ── 设置分区 ──────────────────────────────────────────────────────────────

    const section: SettingsSectionSpec = {
      id: FLOOR_CONFIG_KEY,
      title: '审批灾难地板',
      subtitle: '先于模式与审批的一道硬闸：灾难命令、deny 黑名单、可无人值守',
      order: 33,
      fields(): SettingsField[] {
        const { config, problems } = readConfig()
        const list: SettingsField[] = [
          {
            type: 'info',
            label: '它在链上的位置',
            text: 'order 5：模式闸门（10）、安全钩子（20）、审批（30）之前。所以它说拒的时候，任何权限模式都救不回来；它说放行的时候，模式该拒的还是照拒。',
          },
          {
            type: 'info',
            label: '求值顺序',
            text: '结构不可验证 → 灾难地板 → 用户 deny 黑名单 → 危险模式（无人值守才拒）→ 命令白名单 → 交给后面的守卫。',
          },
          {
            type: 'text',
            key: 'allowPrefixes',
            label: '命令白名单（一行一条，逗号也行）',
            placeholder: 'pnpm run build',
            mono: true,
            help: '命中就不弹审批卡。前缀按词元逐个匹配，`*` 只能放末尾。命令里有管道、分号、子 shell、变量、重定向、引号时一律不走白名单。',
          },
          {
            type: 'text',
            key: 'denyGlobs',
            label: 'deny 黑名单（一行一条，glob）',
            placeholder: '*etc/passwd*',
            mono: true,
            help: '出现在命令原文、命令词元或写目标路径里就拒，先于完全访问生效。`*` 配任意字符，`?` 配一个字符。',
          },
          {
            type: 'number',
            key: 'maxCommandLength',
            label: '命令长度上限（字符）',
            min: FLOOR_LIMITS.maxCommandLength.min,
            max: FLOOR_LIMITS.maxCommandLength.max,
            step: 500,
            help: `更长的命令按「看不清要跑什么」拒。范围 ${FLOOR_LIMITS.maxCommandLength.min}~${FLOOR_LIMITS.maxCommandLength.max}。`,
          },
          {
            type: 'switch',
            key: 'unattended',
            label: '无人值守',
            help: '定时任务、脚本这类没人点卡的场景打开：ask 级命令与工作区外的写一律拒，不再指望有人来回答。桌面端没有可靠的交互信号，所以这一项只能手开。',
          },
          { type: 'switch', key: 'circuitBreakerEnabled', label: '连续被拒就熔断' },
          {
            type: 'number',
            key: 'circuitBreakerThreshold',
            label: '熔断阈值（连续被拒几次）',
            min: FLOOR_LIMITS.circuitBreakerThreshold.min,
            max: FLOOR_LIMITS.circuitBreakerThreshold.max,
            step: 1,
            help: '只统计地板自己的拒：审批最后怎么裁，地板看不到。',
          },
          {
            type: 'number',
            key: 'circuitBreakerCooldownMs',
            label: '熔断冷却（毫秒）',
            min: FLOOR_LIMITS.circuitBreakerCooldownMs.min,
            max: FLOOR_LIMITS.circuitBreakerCooldownMs.max,
            step: 1000,
            help: '冷却过后自动恢复判定；恢复不是放宽规则，只是让模型有机会换个做法。',
          },
          { type: 'info', label: '当前白名单条数', text: String(config.allowPrefixes.length) },
          { type: 'info', label: '当前黑名单条数', text: String(config.denyGlobs.length) },
        ]
        if (problems.length > 0) {
          list.push({
            type: 'info',
            label: '配置有问题，现在一律拒',
            text: problems.join('；'),
            help: '改好上面的控件（或手改配置文件）立刻恢复。地板读不到配置时不会静默放过。',
          })
        }
        return list
      },
      values(): SettingsValues {
        const { config } = readConfig()
        return {
          allowPrefixes: prefixText(config),
          denyGlobs: config.denyGlobs.join('\n'),
          maxCommandLength: config.maxCommandLength,
          unattended: config.unattended,
          circuitBreakerEnabled: config.circuitBreakerEnabled,
          circuitBreakerThreshold: config.circuitBreakerThreshold,
          circuitBreakerCooldownMs: config.circuitBreakerCooldownMs,
        }
      },
      save(key, value): string | void {
        switch (key) {
          case 'allowPrefixes': {
            const parsed = parsePrefixListText(typeof value === 'string' ? value : String(value))
            if (!parsed.ok) return parsed.error
            writePluginConfig(FLOOR_CONFIG_KEY, { allowPrefixes: parsed.values })
            break
          }
          case 'denyGlobs': {
            const parsed = parseGlobListText(typeof value === 'string' ? value : String(value))
            if (!parsed.ok) return parsed.error
            writePluginConfig(FLOOR_CONFIG_KEY, { denyGlobs: parsed.values })
            break
          }
          case 'maxCommandLength': {
            const problem = checkInt(value, FLOOR_LIMITS.maxCommandLength, '命令长度上限')
            if (problem !== null) return problem
            writePluginConfig(FLOOR_CONFIG_KEY, { maxCommandLength: Number(value) })
            break
          }
          case 'circuitBreakerThreshold': {
            const problem = checkInt(value, FLOOR_LIMITS.circuitBreakerThreshold, '熔断阈值')
            if (problem !== null) return problem
            writePluginConfig(FLOOR_CONFIG_KEY, { circuitBreakerThreshold: Number(value) })
            break
          }
          case 'circuitBreakerCooldownMs': {
            const problem = checkInt(value, FLOOR_LIMITS.circuitBreakerCooldownMs, '熔断冷却')
            if (problem !== null) return problem
            writePluginConfig(FLOOR_CONFIG_KEY, { circuitBreakerCooldownMs: Number(value) })
            break
          }
          case 'unattended':
            writePluginConfig(FLOOR_CONFIG_KEY, { unattended: value === true })
            break
          case 'circuitBreakerEnabled':
            writePluginConfig(FLOOR_CONFIG_KEY, { circuitBreakerEnabled: value === true })
            break
          default:
            return `这个分区没有这项：${key}`
        }
        // 值改完可能把熔断打开或关掉，顺手清一次计数，让新配置从干净状态开始。
        floor.reset()
        ctx.emit('dsc/changed')
      },
    }
    const offSection = ctx.settings.registerSection(section)

    // 配置坏掉时说一次：地板会一律拒，用户得知道去改哪儿。
    const problems = readConfig().problems
    if (problems.length > 0) {
      ctx.emit('dsc/notice', `审批灾难地板配置有问题，现在一律拒：${problems.join('；')}（改 ${FLOOR_CONFIG_KEY} 的配置后立刻恢复）`)
    }

    // 注册一律返回清理函数，这里把四份合成一份。
    return () => {
      offSection()
      offCommand()
      offService()
      offGuard()
    }
  },
}
