/**
 * presets 插件：provide `presets` 服务（模式状态 + 三个登记点 + 切换命令）。
 *
 * 模式（模式文件见 `core/presets.ts`）只干三件事，都在自己文件里：
 *   1. 往系统提示里加一段这个模式的话（提示词层，order 15，排在「做事方式」之后、
 *      「工具规范」之前），并登记一个骨架取舍把该摘的叮嘱段摘掉；
 *   2. 给主会话的工具目录过一层投影（`ctx.tools.project`）——极简档因此只把 bash
 *      递给模型，而队友、界面、工具检索看到的仍是完整注册表；
 *   3. 换模式时广播 `dsc/preset-changed`，并把档位写进会话状态（恢复会话时跟着回来）。
 *
 * 三件事都只做减法：工具白名单只能从全量里取子集、drop 只能在名单里去掉提示段。
 * 权限模式（approval 插件）与协作模式（mode 插件）各自是另外两根旋钮，这里一个都不碰——
 * 审批灾难地板与守卫链不看模式，所以再野的模式也放宽不了安全。
 *
 * @module dsc/plugins/presets
 */
import { readFileSync } from 'node:fs'
import type { Plugin } from '@deepseek-ai/cordis'
import type { PresetDraft, PresetSurface, PresetView } from '../contract.js'
import type { PresetService } from '../services/types.js'
import {
  DROPPABLE_LABELS,
  DROPPABLE_SECTIONS,
  STANDARD_PRESET,
  ensureBuiltinPresets,
  findPreset,
  listPresets,
  parsePresetToken,
  removePreset,
  standardPreset,
  writePreset,
  type Preset,
} from '../core/presets.js'
import { audit } from '../core/audit.js'

/** 模式 → 界面投影（IPC 只带这些字段）。 */
function toView(preset: Preset): PresetView {
  return {
    name: preset.name,
    label: preset.label,
    description: preset.description,
    tools: preset.tools,
    drop: preset.drop,
    prompt: preset.prompt,
    builtin: preset.builtin,
    ...(preset.problem !== undefined ? { problem: preset.problem } : {}),
  }
}

export const presetsPlugin: Plugin.Object = {
  name: 'presets',
  inject: ['session', 'commands', 'prompt', 'tools', 'settings', 'surfaces', 'approval', 'mode'],
  provide: 'presets',
  apply(ctx) {
    // 出厂四个模式：第一次用到时写出去；已存在的一律不覆盖（用户改过的永远留着）
    ensureBuiltinPresets()

    /** 名字解析：文件不在了就回落标准档（模式文件可能刚被删，偏好里还留着旧名字）。 */
    const resolve = (candidate: string): string => (findPreset(candidate) === null ? STANDARD_PRESET : candidate)
    /** 当前模式的规格；任何异常路径最后都落到 standardPreset()（它绝不返回 null）。 */
    const spec = (): Preset => findPreset(name) ?? standardPreset()
    /** 新会话默认模式（读偏好，认不出回落标准档）。 */
    const savedDefault = (): string => resolve(ctx.settings.prefs().defaultPreset)
    /** 打开会话时该用哪个模式：会话记过就跟着会话，没记过就用默认。 */
    const openName = (): string => {
      const stored = ctx.session.current().state('preset')
      return typeof stored === 'string' && stored !== '' ? resolve(stored) : savedDefault()
    }

    let name = openName()

    /**
     * 换档：写会话记录 + 审计 + 广播。
     * @returns 给用户看的一句话（调用方拿去当返回文案；这里同时发一条 dsc/notice，
     *          所以 `/preset` 这类不消费返回值的入口也能在会话流里看到它）。
     */
    const apply = (next: string, opts: { notice?: string } = {}): string => {
      const changed = name !== next
      name = next
      ctx.session.current().appendState('preset', next)
      if (changed) {
        audit({
          ts: Date.now(),
          kind: 'mode-change',
          reason: `模式（预设）→ ${spec().label}`,
          mode: ctx.mode.mode,
          policy: ctx.approval.policy,
          sessionId: ctx.session.current().meta.id,
          cwd: ctx.session.current().meta.cwd,
        })
      }
      const notice = opts.notice ?? `模式切换为「${spec().label}」：${spec().description || '见设置 → 模式'}`
      ctx.emit('dsc/preset-changed', next)
      ctx.emit('dsc/notice', notice)
      ctx.emit('dsc/changed')
      return notice
    }

    const service: PresetService = {
      get name() {
        return name
      },
      get defaultName() {
        return savedDefault()
      },
      surface(): PresetSurface {
        return {
          current: name,
          defaultName: savedDefault(),
          options: listPresets().map(toView),
          droppable: DROPPABLE_SECTIONS.map((id) => ({ id, label: DROPPABLE_LABELS[id] ?? id })),
        }
      },
      use(next) {
        if (findPreset(next) === null) throw new Error(`没有名为「${next}」的模式`)
        return apply(next)
      },
      read(target) {
        const preset = findPreset(target)
        if (preset === null) throw new Error(`没有名为「${target}」的模式`)
        return readFileSync(preset.file, 'utf8')
      },
      save(draft: PresetDraft) {
        const written = writePreset(draft)
        if (written.problem !== undefined) throw new Error(written.problem)
        return draft.oldName === null ? `已创建模式「${written.label}」` : `已保存模式「${written.label}」`
      },
      remove(target) {
        const label = findPreset(target)?.label ?? target
        removePreset(target)
        // 删掉的正是当前这一档时当场回落标准档，别让会话停在一个不存在的模式上
        if (name === target) apply(STANDARD_PRESET, { notice: `模式「${label}」已删除，当前回落到「${spec().label}」` })
        else ctx.emit('dsc/notice', `已删除模式「${label}」`)
        return `已删除模式「${label}」`
      },
      setDefault(target) {
        if (findPreset(target) === null) throw new Error(`没有名为「${target}」的模式`)
        ctx.settings.setPrefs({ defaultPreset: target })
        return `新会话默认模式已设为「${findPreset(target)?.label ?? target}」（当前会话不受影响）`
      },
    }
    ctx.provide('presets', service)

    // 1. 模式自己那段话：排在做事方式（10）之后、工具规范（20）之前。
    // 空正文（标准档）会被 composePrompt 滤掉，所以默认档的系统提示逐字节不变。
    ctx.prompt.register('preset:persona', () => spec().prompt, { order: 15 })

    // 2. 骨架取舍：drop 里那几段整段不进提示词。
    // 只碰提示词文本——审批硬地板、命令策略、路径策略都在代码里，少几段叮嘱不等于放宽安全。
    ctx.prompt.registerSkeletonFilter('preset', (ids) => {
      const drop = spec().drop
      return drop.length === 0 ? ids : ids.filter((id) => !drop.includes(id))
    })

    // 3. 工具目录投影：白名单取交集；带 presets 标签的工具只在它列出的模式里露面。
    // 直接写进白名单的工具名也算「露面」（用户的显式意图优先于标签）。
    ctx.tools.project('preset', (tools) => {
      const allowed = spec().tools
      return tools.filter((entry) => {
        const explicit = allowed !== null && allowed.includes(entry.name)
        if (entry.presets !== undefined && !entry.presets.includes(name) && !explicit) return false
        return allowed === null || explicit
      })
    })

    ctx.surfaces.register('preset', () => service.surface())

    // 恢复历史会话：模式跟着回来（不重复写记录，也不重复播报切换）。
    ctx.on('dsc/session-open', ({ session }) => {
      const stored = session.state('preset')
      name = typeof stored === 'string' && stored !== '' ? resolve(stored) : savedDefault()
      ctx.emit('dsc/preset-changed', name)
      ctx.emit('dsc/changed')
    })
    // 挂载完就播一次：比本插件先挂载的监听者因此不会停在「没听过模式」的状态上。
    ctx.emit('dsc/preset-changed', name)

    /** `/preset <名字>`：支持中文别名（标准 / 极简 / 创造 / 代码）。 */
    ctx.commands.register(
      {
        name: 'preset',
        args: '<名字>',
        description: '切换模式（模式 = 人格 + 工具集 + 提示词；写进会话记录，恢复会话时一起恢复）',
      },
      ({ args, ui }) => {
        const token = args.join(' ').trim()
        if (token === '') {
          ui.notice(`当前模式：${spec().label}。可选：${listPresets().map((item) => `${item.label}（/preset ${item.name}）`).join('、')}`)
          return
        }
        const target = parsePresetToken(token)
        if (target === null) {
          ui.notice(`认不出模式「${token}」。可选：${listPresets().map((item) => `${item.label}（${item.name}）`).join('、')}`)
          return
        }
        service.use(target)
      },
    )
  },
}
