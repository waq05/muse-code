/**
 * spill 插件：工具输出超阈值时落盘，模型拿到的是头几行 + 文件路径 + 续读写法。
 *
 * **为什么观察者排在遮红后面（order 50 > 10）**：标记链按 order 从小到大依次加工，
 * 每一位看到的是前一位的输出。遮红（order 10）先把密钥换成占位符，溢出（order 50）
 * 落盘写下来的才是脱敏文本；如果反序，磁盘上留的是脱敏前的原文，而回给模型的预览却是
 * 脱敏的——泄漏悄无声息，谁都看不出来。shots/spill-check.mjs 把顺序故意反着挂了一次，
 * 断言原密钥真的会落进文件，证明第 4 条验的是顺序而不是巧合。
 *
 * 落盘失败（磁盘满、没有写权限）时保持原文返回：宁可这次输出大一点，也不能把工具结果弄丢；
 * 提醒本次会话只发一次，否则每条长输出都往会话流里刷一行。
 *
 * @module dsc/plugins/spill
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { formatBytes, listSpillFiles, readSpillConfig, SPILL_RANGES, spillText, sweepSpillDir } from '../core/spill.js'
import type { SpillConfig } from '../core/spill.js'
import { writePluginConfig } from '../core/plugin-registry.js'
import type { ToolObserver } from '../core/tool-guards.js'
import type { SettingsField, SettingsValues } from '../contract.js'
import type { SettingsSectionSpec } from '../services/types.js'

/** 插件在条目树里的键，也是设置分区 id。 */
const CONFIG_KEY = 'spill'

/**
 * 溢出观察者的刻度：必须大于遮红的 10。
 * 这个数一旦小于 10，密钥就会以原文形式落盘（理由见模块注释）。
 */
const OBSERVER_ORDER = 50

/** 不该溢出的工具：read 的结果就是模型点名要的那一段，再落盘只是让它去读另一个文件。 */
const SKIP_TOOLS: ReadonlySet<string> = new Set(['read'])

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const spillPlugin: Plugin.Object = {
  name: 'spill',
  inject: ['guards', 'session', 'settings', 'transcript'],
  apply(ctx, passed) {
    /** 每次都现读：设置里改完立刻生效，不必重启宿主。 */
    const config = (): SpillConfig => readSpillConfig(passed)
    /** 落盘失败只提醒一次（本次挂载内）。 */
    let warned = false
    /** 最近落盘的那份：清理时保住它，模型可能正拿着它的路径在续读。 */
    let lastSpilled: string | undefined

    const usage = (dir: string): { files: number; bytes: number } => {
      const files = listSpillFiles(dir)
      return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }
    }

    const observer: ToolObserver = {
      id: 'spill',
      order: OBSERVER_ORDER,
      observe(toolName: string, text: string): string {
        const cfg = config()
        if (SKIP_TOOLS.has(toolName)) return text
        if (text.length <= cfg.thresholdChars) return text
        try {
          const spilled = spillText(ctx.session.current().meta.id, text, cfg)
          lastSpilled = spilled.written.path
          // 顺手清一次：长会话里总量上限才有意义；刚落盘的这份被 keepPath 保住
          sweepSpillDir(cfg, lastSpilled)
          return spilled.text
        } catch (error) {
          if (!warned) {
            warned = true
            ctx.transcript.system(
              `大输出溢出没能落盘（${errText(error)}），这次仍按原文回给模型。溢出目录：${cfg.dir}（磁盘满或没有写权限时先看它；这条提醒本次会话只说一次）`,
            )
          }
          return text
        }
      },
    }
    const offObserver = ctx.guards.registerObserver(observer)

    // ── 设置分区 ─────────────────────────────────────────────────────────────

    const fields = (): SettingsField[] => {
      const cfg = config()
      const now = usage(cfg.dir)
      return [
        {
          type: 'number',
          key: 'thresholdChars',
          label: '超过多少字符就落盘',
          min: SPILL_RANGES.thresholdChars.min,
          max: SPILL_RANGES.thresholdChars.max,
          step: 500,
          help: '工具输出长于这个数就写进文件，回给模型的只有前几行加一句续读写法。小输出原样通过。',
        },
        {
          type: 'number',
          key: 'keepLines',
          label: '预览保留前几行',
          min: SPILL_RANGES.keepLines.min,
          max: SPILL_RANGES.keepLines.max,
          step: 1,
          help: '头几行通常就能看出这次输出是什么；剩下的让模型自己决定要不要读。',
        },
        {
          type: 'number',
          key: 'readChunkLines',
          label: '续读一次读几行',
          min: SPILL_RANGES.readChunkLines.min,
          max: SPILL_RANGES.readChunkLines.max,
          step: 50,
          help: '预览里那句 read(path=…, offset=…, limit=…) 的 limit 就是它。',
        },
        {
          type: 'number',
          key: 'maxBytes',
          label: '单个文件字节上限',
          min: SPILL_RANGES.maxBytes.min,
          max: SPILL_RANGES.maxBytes.max,
          step: 65_536,
          help: '超了按整行截断，并在文件末尾写明第几行起没写进来。',
        },
        {
          type: 'number',
          key: 'retentionDays',
          label: '保留多少天',
          min: SPILL_RANGES.retentionDays.min,
          max: SPILL_RANGES.retentionDays.max,
          step: 1,
          help: '按文件最后修改时间算；到点的在下一次清理时删掉。',
        },
        {
          type: 'number',
          key: 'maxTotalBytes',
          label: '目录总字节上限',
          min: SPILL_RANGES.maxTotalBytes.min,
          max: SPILL_RANGES.maxTotalBytes.max,
          step: 1_048_576,
          help: '超过就按时间从最旧的开始删，刚落盘的那份不删。',
        },
        {
          type: 'text',
          key: 'dir',
          label: '溢出目录',
          mono: true,
          placeholder: '%USERPROFILE%\\.dsc\\spill',
          help: '目录权限 0700、文件 0600。换成别的盘符也行，目录会在第一次落盘时自动建。',
        },
        {
          type: 'info',
          label: '目录现状',
          mono: true,
          text: `${cfg.dir}\n${String(now.files)} 个文件，共 ${formatBytes(now.bytes)}`,
        },
        {
          type: 'button',
          action: 'cleanup',
          label: '立刻清理溢出目录',
          style: 'ghost',
          help: '按上面的两条策略清一遍：先删过期的，再从最旧的删到总量落回上限内。',
        },
      ]
    }

    const section: SettingsSectionSpec = {
      id: CONFIG_KEY,
      title: '大输出溢出',
      subtitle: '工具输出超阈值时落盘，模型只拿头几行与续读写法',
      order: 37,
      fields,
      values(): SettingsValues {
        const cfg = config()
        return {
          thresholdChars: cfg.thresholdChars,
          keepLines: cfg.keepLines,
          readChunkLines: cfg.readChunkLines,
          maxBytes: cfg.maxBytes,
          retentionDays: cfg.retentionDays,
          maxTotalBytes: cfg.maxTotalBytes,
          dir: cfg.dir,
        }
      },
      save(key, value): string | void {
        switch (key) {
          case 'thresholdChars':
          case 'keepLines':
          case 'readChunkLines':
          case 'maxBytes':
          case 'retentionDays':
          case 'maxTotalBytes': {
            const num = Number(value)
            if (!Number.isFinite(num)) return '这里要填一个数字'
            // 越界的值写进去也没关系：用的时候会被夹回区间（parseSpillConfig）
            writePluginConfig(CONFIG_KEY, { [key]: Math.round(num) })
            return
          }
          case 'dir': {
            const text = String(value).trim()
            if (text === '') return '溢出目录不能空着'
            writePluginConfig(CONFIG_KEY, { dir: text })
            return
          }
          default:
            return `这个分区没有这项：${key}`
        }
      },
      action(name): string | void {
        if (name !== 'cleanup') return `这个分区没有这个按钮：${name}`
        const result = sweepSpillDir(config(), lastSpilled)
        const kept = `还剩 ${String(result.keptFiles)} 个（${formatBytes(result.keptBytes)}）`
        if (result.failed.length > 0) {
          return `清掉 ${String(result.removed.length)} 个（${formatBytes(result.removedBytes)}），${kept}；${String(result.failed.length)} 个没删掉：${result.failed.map((item) => `${item.path}（${item.reason}）`).join('、')}`
        }
        return `清掉 ${String(result.removed.length)} 个（${formatBytes(result.removedBytes)}），${kept}`
      },
    }
    const offSection = ctx.settings.registerSection(section)

    return () => {
      offObserver()
      offSection()
      // 退出时顺手清一遍：只删过期的与超量的，刚落盘的那份照样保住
      sweepSpillDir(config(), lastSpilled)
    }
  },
}
