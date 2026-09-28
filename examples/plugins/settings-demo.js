/**
 * settings-demo.js — 演示内核 API v2 的三个界面扩展点。
 *
 * 装好后（放进 ~/.dsc/plugins/ 并在宿主里启用）：
 * 1. 桌面端设置面板左栏多出一个「示例插件」分区，控件由桌面端按声明渲染；
 * 2. 技能中心「已安装」里多一条来源为 settings-demo 的虚拟技能，`/demo-skill` 可直接调用；
 * 3. 技能中心「市场」里多一个 settings-demo 源，点安装会把真的 SKILL.md 写到 ~/.dsc/skills/。
 *
 * 讲解见 docs/plugin-development.md §4.7 / §4.8 / 示例 D。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = '设置与技能示例'
export const description = '演示设置分区、技能来源、市场源三个扩展点（内核 API v2）'
export const apiVersion = 2
export const inject = ['settings', 'skills', 'transcript']

const SKILL_NAME = 'demo-skill'
const SKILL_BODY = `---
name: demo-skill
description: 演示技能：用一句话说清这个技能能做什么
when-to-use: 用户说「演示一下」时
---

# 演示技能

这是一份由 settings-demo 插件写入的技能正文。

模型调用 \`skill(name="demo-skill")\` 时会读到这段文本，所以这里只写真正有用的步骤。
`

/** 虚拟条目的公共字段（SkillSummary 的必填项）。 */
function summary(rank, description) {
  return {
    name: SKILL_NAME,
    description,
    whenToUse: '用户说「演示一下」时',
    source: 'settings-demo',
    rank,
    modelInvocable: true,
    userInvocable: true,
    local: false,
  }
}

export function apply(ctx, config) {
  // 值存在插件内存里；要跨重启保留就自己写文件，或让用户把值放进度条目树 config
  const state = {
    enabled: config?.enabled !== false,
    interval: typeof config?.interval === 'string' ? config.interval : '60',
    note: typeof config?.note === 'string' ? config.note : '',
  }
  const INTERVALS = ['60', '300']

  // ── 1) 设置分区：只声明控件，渲染由桌面端负责 ──────────────────────────────
  const offSection = ctx.settings.registerSection({
    id: 'settings-demo-prefs',
    title: '示例插件',
    subtitle: '演示：控件是数据，不是组件',
    order: 30,
    fields: () => [
      { type: 'switch', key: 'enabled', label: '启用技能来源', help: '关掉后技能中心不再出现这个来源的条目' },
      {
        type: 'select',
        key: 'interval',
        label: '轮询间隔',
        options: [
          { value: '60', label: '1 分钟' },
          { value: '300', label: '5 分钟' },
        ],
      },
      { type: 'text', key: 'note', label: '备注', placeholder: '随便写点什么，保存到本插件' },
      {
        type: 'info',
        label: '技能目录',
        text: ctx.skills.userDir,
        mono: true,
        copyable: true,
        help: '插件贡献的技能不落这里；市场安装才会落',
      },
      { type: 'button', action: 'reset', label: '恢复默认', style: 'ghost' },
    ],
    values: () => ({ enabled: state.enabled, interval: state.interval, note: state.note }),
    save: (key, value) => {
      if (key === 'interval' && !INTERVALS.includes(String(value))) return '间隔只能是 1 分钟或 5 分钟'
      if (key === 'note' && String(value).length > 60) return '备注别超过 60 个字'
      state[key] = value
      // 返回字符串或抛异常 = 失败原因，桌面端就地显示；什么都不返回 = 写入成功
    },
    action: (name) => {
      if (name !== 'reset') return `没有这个动作：${name}`
      state.enabled = true
      state.interval = '60'
      state.note = ''
      ctx.emit('dsc/skills-changed')
      return '已恢复默认设置'
    },
  })

  // ── 2) 技能来源：虚拟条目，本地同名文件优先级更高（rank 小者赢）────────────
  const offProvider = ctx.skills.registerProvider({
    name: 'settings-demo',
    rank: 500,
    list: () => (state.enabled ? [summary(500, '演示技能：用一句话说清这个技能能做什么')] : []),
    get: (name) =>
      name === SKILL_NAME
        ? { ...summary(500, '演示技能：用一句话说清这个技能能做什么'), content: SKILL_BODY }
        : undefined,
  })

  // ── 3) 市场源：browse 给清单，install 落地文件 ────────────────────────────
  const installedPath = () => join(ctx.skills.userDir, SKILL_NAME, 'SKILL.md')
  const offMarket = ctx.skills.registerMarket({
    name: 'settings-demo',
    browse: () => [{ name: SKILL_NAME, description: '演示技能：装成 ~/.dsc/skills 下的本地文件', source: 'settings-demo', installed: existsSync(installedPath()) }],
    install: (name) => {
      if (name !== SKILL_NAME) return `这个源里没有 ${name}`
      mkdirSync(join(ctx.skills.userDir, SKILL_NAME), { recursive: true })
      writeFileSync(installedPath(), SKILL_BODY, 'utf8')
      ctx.emit('dsc/skills-changed')
      return `已写入 ${installedPath()}`
    },
  })

  ctx.transcript.system('[settings-demo] 设置分区与技能源已注册，去「设置」和「技能」页看看')

  return () => {
    offSection()
    offProvider()
    offMarket()
  }
}
