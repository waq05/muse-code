/**
 * tools-default 插件：向 tools 注册表注册 6 件套默认工具
 * （bash/read/write/edit/glob/grep）。剔除本插件即可得到纯对话 harness。
 *
 * 超时与输出预算是部署差异的选择，不在代码里钉死：读自己的插件配置
 * （`~/.dsc/plugins.json` 条目树里 `file: "tools-default"` 那条的 config），
 * 并以设置分区交给界面；保存后按新预算重注册工具，下一次调用就用新值。
 *
 * @module dsc/plugins/tools-default
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { createBashTool, BASH_DEFAULT_BUDGETS, createJobTools, JobTable, stopAllBackgroundChildren, type BashBudgets } from '../core/tools/bash.js'
import { createReadTool, editTool, READ_DEFAULT_LINE_LIMIT, writeTool } from '../core/tools/fs-tools.js'
import { globTool, grepTool } from '../core/tools/search-tools.js'
import { resolvePluginConfig, writePluginConfig } from '../core/plugin-registry.js'
import type { SettingsField, SettingsValues } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'tools-default'

/** 可调值的取值区间：超时太小等于没跑，太大等于占着一轮不放。 */
const TIMEOUT_RANGE = { min: 5_000, max: 600_000 }
/** 输出与行数的区间：太小截不出有用信息，太大 spill/审批环节看了也白看。 */
const OUTPUT_RANGE = { min: 1_000, max: 200_000 }
const LINE_RANGE = { min: 100, max: 10_000 }

/** 从插件配置取预算，区间外的值夹回来（配置写错不至于把工具夹死）。 */
function readBudgets(passed?: unknown): BashBudgets & { readLineLimit: number } {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const num = Number(value)
    return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), min), max) : fallback
  }
  return {
    timeoutMs: clamp(raw.bashTimeoutMs, TIMEOUT_RANGE.min, TIMEOUT_RANGE.max, BASH_DEFAULT_BUDGETS.timeoutMs),
    maxTimeoutMs: clamp(raw.bashMaxTimeoutMs, TIMEOUT_RANGE.min, TIMEOUT_RANGE.max, BASH_DEFAULT_BUDGETS.maxTimeoutMs),
    outputChars: clamp(raw.bashOutputChars, OUTPUT_RANGE.min, OUTPUT_RANGE.max, BASH_DEFAULT_BUDGETS.outputChars),
    readLineLimit: clamp(raw.readLineLimit, LINE_RANGE.min, LINE_RANGE.max, READ_DEFAULT_LINE_LIMIT),
  }
}

export const toolsDefaultPlugin: Plugin.Object = {
  name: 'tools-default',
  // T15：完成通知走 agent.followup（排队提交一条消息叫模型回来收结果）
  inject: ['tools', 'settings', 'agent'],
  apply(ctx, passed) {
    let budgets = readBudgets(passed)
    /** 当前注册进注册表的清理函数；换预算时先撤旧的再注册新的。 */
    let disposers: Array<() => void> = []

    // ---- T15 后台作业表 ----
    // 完成通知做 800ms 合并：几个作业同时收尾时合成一条 followup，不炸出一串轮次
    const table = new JobTable({
      notify: (text) => {
        pendingNotices.push(text)
        if (noticeTimer === undefined) {
          noticeTimer = setTimeout(() => {
            noticeTimer = undefined
            const merged = pendingNotices.splice(0)
            if (merged.length > 0) ctx.agent.followup(merged.join('\n'))
          }, 800)
          noticeTimer.unref?.()
        }
      },
    })
    let noticeTimer: NodeJS.Timeout | undefined
    const pendingNotices: string[] = []

    const syncTools = (): void => {
      for (const off of disposers) off()
      disposers = [
        ctx.tools.register(createBashTool(budgets, table)),
        ...createJobTools(table).map((entry) => ctx.tools.register(entry)),
        ctx.tools.register(createReadTool(budgets.readLineLimit)),
        ctx.tools.register(writeTool),
        ctx.tools.register(editTool),
        ctx.tools.register(globTool),
        ctx.tools.register(grepTool),
      ]
    }
    syncTools()

    const applyConfig = (patch: Record<string, unknown | null>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      budgets = readBudgets()
      syncTools()
    }

    const fields: SettingsField[] = [
      {
        type: 'number',
        key: 'bashTimeoutMs',
        label: '命令缺省超时（毫秒）',
        min: TIMEOUT_RANGE.min,
        max: TIMEOUT_RANGE.max,
        step: 5000,
        help: 'bash 不带 timeoutMs 参数时按这个值收进程树。模型自己给了 timeoutMs 就用模型的，但仍受下面那条上限管着。',
      },
      {
        type: 'number',
        key: 'bashMaxTimeoutMs',
        label: '命令超时上限（毫秒）',
        min: TIMEOUT_RANGE.min,
        max: TIMEOUT_RANGE.max,
        step: 5000,
        help: '模型要再久也不放：比这更长的活该拆开跑。改大前想清楚愿不愿意让一轮对话卡这么久。',
      },
      {
        type: 'number',
        key: 'bashOutputChars',
        label: '命令输出封顶（字符）',
        min: OUTPUT_RANGE.min,
        max: OUTPUT_RANGE.max,
        step: 1000,
        help: '超出就截断并注明。大输出溢出插件开着时，超过它的阈值会先落盘只回前几行，这条是没开插件时的兜底。',
      },
      {
        type: 'number',
        key: 'readLineLimit',
        label: 'read 缺省行数',
        min: LINE_RANGE.min,
        max: LINE_RANGE.max,
        step: 100,
        help: 'read 工具一次读多少行；文件更长时模型可以用 offset/limit 续读。',
      },
    ]

    const section: SettingsSectionSpec = {
      id: CONFIG_KEY,
      title: '工具预算',
      subtitle: '内置工具的超时、输出封顶与读取行数',
      order: 36,
      fields: () => fields,
      // 每次打开分区都现读磁盘：手改 plugins.json 也能看到真值。
      values: (): SettingsValues => {
        budgets = readBudgets()
        return {
          bashTimeoutMs: budgets.timeoutMs,
          bashMaxTimeoutMs: budgets.maxTimeoutMs,
          bashOutputChars: budgets.outputChars,
          readLineLimit: budgets.readLineLimit,
        }
      },
      // 契约：save 返回字符串 = 失败原因。
      save: (key, value): string | void => {
        const num = Number(value)
        if (!Number.isFinite(num)) return '这里要填一个数字'
        if (key === 'bashTimeoutMs') applyConfig({ bashTimeoutMs: num })
        else if (key === 'bashMaxTimeoutMs') applyConfig({ bashMaxTimeoutMs: num })
        else if (key === 'bashOutputChars') applyConfig({ bashOutputChars: num })
        else if (key === 'readLineLimit') applyConfig({ readLineLimit: num })
        else return `这个分区没有这项：${key}`
      },
    }
    const offSection = ctx.settings.registerSection(section)

    return () => {
      for (const off of disposers) off()
      disposers = []
      // T15：内核收摊收掉还在跑的后台作业（跨会话存活的另一面是进程得有人收）
      if (noticeTimer !== undefined) clearTimeout(noticeTimer)
      stopAllBackgroundChildren()
      offSection()
    }
  },
}
