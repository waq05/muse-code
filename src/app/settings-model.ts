/**
 * 设置页行模型：SettingsOverlay 画几行、App 的鼠标点击换算成哪一行，共用这一份
 * 几何表——两边都从 buildSettingsRows 拿同一条 flat 行数组，行号永远不错位。
 *
 * 行高恒为 1：卡片顶边/底边各占一行、字段占一行、分区之间空一行，help 文案
 * 不进卡片行（聚焦行的 help 走底部提示条，对齐 dsh 的布局）。
 *
 * @module dsc-tui/app/settings-model
 */
import type { SettingsSectionView } from '../contract.js'

/** 设置页的一行；field/hint 可聚焦，其余是结构行。 */
export type SettingsRow =
  | { kind: 'card-top'; sectionId: string; title: string; subtitle?: string }
  | { kind: 'card-bottom' }
  | { kind: 'spacer' }
  | { kind: 'field'; sectionId: string; fieldIndex: number }
  | { kind: 'hint'; sectionId: string; text: string; jump?: 'model-picker' | 'usage' }

/**
 * custom 分区在 TUI 的指引内容：管理界面在桌面端自己画，TUI 只给入口与去处——
 * 带 jump 的是可聚焦行（Enter 触发跳转），纯文案行只作说明。
 */
const CUSTOM_HINTS: Record<string, { text: string; jump?: 'model-picker' | 'usage' }[]> = {
  models: [
    { text: '打开模型选择器', jump: 'model-picker' },
    { text: '端点与 API key 在桌面端设置或 ~/.dsc/config.yaml 管理' },
  ],
  presets: [{ text: '会话内 /preset <名> 切换；默认模式在桌面端设置' }],
  skills: [{ text: '技能目录 ~/.dsc/skills；开关管理在桌面端' }],
  usage: [{ text: '查看用量统计', jump: 'usage' }],
  archive: [{ text: '/resume 的已归档页可恢复会话' }],
}

/** 分区列表 → flat 行数组（分区之间空一行；字段行带 fieldIndex 供取值与保存）。 */
export function buildSettingsRows(sections: SettingsSectionView[]): SettingsRow[] {
  const rows: SettingsRow[] = []
  sections.forEach((section, index) => {
    if (index > 0) rows.push({ kind: 'spacer' })
    rows.push({ kind: 'card-top', sectionId: section.id, title: section.title, subtitle: section.subtitle })
    const hints = CUSTOM_HINTS[section.id]
    if (section.custom) {
      for (const hint of hints ?? []) rows.push({ kind: 'hint', sectionId: section.id, ...hint })
    } else {
      section.fields.forEach((field, fieldIndex) => {
        rows.push({ kind: 'field', sectionId: section.id, fieldIndex })
      })
    }
    rows.push({ kind: 'card-bottom' })
  })
  return rows
}

/** 该行能不能拿到焦点（有 Enter/←→ 动作才给焦点：info 仅 copyable 可聚焦）。 */
export function isFocusableRow(row: SettingsRow, fields: SettingsSectionView['fields']): boolean {
  if (row.kind === 'field') {
    const field = fields[row.fieldIndex]
    return field !== undefined && (field.type !== 'info' || field.copyable === true)
  }
  return row.kind === 'hint' && row.jump !== undefined
}

/** 焦点可落的行号表（buildSettingsRows 顺序里的下标；↑↓ 与滚轮在其上移动）。 */
export function focusableRows(rows: SettingsRow[], sections: SettingsSectionView[]): number[] {
  const byId = new Map(sections.map((section) => [section.id, section]))
  const result: number[] = []
  rows.forEach((row, index) => {
    if (row.kind !== 'field' && row.kind !== 'hint') return
    const fields = byId.get(row.sectionId)?.fields ?? []
    if (isFocusableRow(row, fields)) result.push(index)
  })
  return result
}

/**
 * 焦点跟随窗口（dsh windowStart 同语义）：保证聚焦行落在视口内，越过下缘窗口
 * 跟进一行、顶回上缘窗口钉住；行数不足一屏时窗口恒为 0。纯函数——组件与
 * App 的鼠标映射各自调用，结果一致。
 */
export function settingsWindowStart(focusRow: number, viewport: number, total: number): number {
  if (viewport <= 0 || total <= viewport) return 0
  return Math.max(0, Math.min(focusRow - viewport + 1, focusRow, total - viewport))
}
