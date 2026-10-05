/**
 * 设置页（/settings）：整屏浮层、分区卡片 + 字段行，纯展示——焦点、编辑草稿、
 * 回执、滚动窗口全在 App；行几何用 settings-model.ts 的同一份表，App 的鼠标
 * 行号映射与这里画的行永远 1:1。
 *
 * 行规格（对齐 dsh 的 Settings 屏）：卡片顶边 `╭─ 标题 · 副标题 ────╮`、字段行
 * `❯ 标签 … 值右对齐`（switch `[✓]`/`[  ]`、select `‹ 选项 ›`、text/number 编辑态
 * 带 `▌` 光标、button 强调色、info 暗淡），底部恒定两行：notice（成功绿/失败红，
 * 静默时空行防跳动）+ 提示条（聚焦字段的 help + 右侧按键提示）。help 不进卡片行，
 * 聚焦行才在提示条里出现——每行高度恒为 1，行模型才守得住。
 *
 * @module dsc-tui/app/SettingsOverlay
 */
import { Box, Text, useStdout } from 'ink'
import type { JSX } from 'react'
import type { SettingsField, SettingsSectionView, SettingsValues } from '../contract.js'
import { displayWidth } from './click.js'
import { focusableRows, type SettingsRow } from './settings-model.js'
import { ACCENT, BORDER, GAP, MARK, PAD, PALETTE, SEP, STATUS_COLOR, TEXT } from './theme.js'

/** 设置页固定框架行数：外框上下边 2 + 标题 1 + 底部 notice 1 + 提示条 1。 */
export const SETTINGS_CHROME = 5
/** 列表首行距屏幕顶的行数（鼠标行号映射的固定偏移）：顶边框 1 + 标题 1。 */
export const SETTINGS_LIST_TOP = 2

/** 按显示宽度硬截断（超宽补 …）；CJK 记 2 列，代理对不劈开。 */
const clipToWidth = (text: string, max: number): string => {
  if (max <= 2) return ''
  let width = 0
  let out = ''
  for (const char of text) {
    if (width + displayWidth(char) > max - 1) return `${out}…`
    out += char
    width += displayWidth(char)
  }
  return out
}

/** 编辑中的字段：显示草稿加光标（对齐 dsh 的 ▌）。 */
export interface SettingsEdit {
  sectionId: string
  key: string
  draft: string
}

/**
 * 字段值区（右对齐段）的文本；编辑中的 text/number 显示草稿加光标，值表没到时
 * 显示 … 占位（打开设置页后 values 异步装填，只差几毫秒但不能闪「未设置」）。
 */
function fieldValueText(field: SettingsField, values: SettingsValues | undefined, editing: SettingsEdit | null): string {
  if (field.type === 'info') return field.text
  if (field.type === 'button') return field.label
  if (editing !== null && editing.key === field.key) return `${editing.draft}▌`
  if (values === undefined) return '…'
  const current = values[field.key]
  switch (field.type) {
    case 'switch':
      return current === true ? '[✓]' : '[  ]'
    case 'select': {
      const label = field.options.find((option) => option.value === String(current))?.label
      return `‹ ${label ?? String(current ?? '')} ›`
    }
    default:
      // text / number：空值给「未设置」占位（对齐 dsh 的（未设置））
      return current === undefined || current === '' ? '（未设置）' : String(current)
  }
}

/** 值区的颜色：switch 打开是完成绿、button/编辑中是强调系，其余走暗淡档。 */
function fieldValueColor(
  field: SettingsField,
  values: SettingsValues | undefined,
  editing: SettingsEdit | null,
  focused: boolean,
): string | undefined {
  if (field.type === 'button') return ACCENT
  if (field.type === 'info') return undefined
  if (editing !== null && editing.key === field.key) return PALETTE.text
  if (field.type === 'switch') return values?.[field.key] === true ? STATUS_COLOR.done : undefined
  if (field.type === 'select') return focused ? ACCENT : undefined
  return undefined
}

export function SettingsOverlay({
  sections,
  rows,
  values,
  focusRow,
  windowStart,
  viewport,
  editing,
  notice,
}: {
  sections: SettingsSectionView[]
  rows: SettingsRow[]
  /** 分区 id → 值表；分区键缺失 = 值还在装载。 */
  values: Record<string, SettingsValues>
  /** 聚焦的模型行号（buildSettingsRows 下标）。 */
  focusRow: number
  windowStart: number
  viewport: number
  editing: SettingsEdit | null
  notice: { ok: boolean; text: string } | null
}): JSX.Element {
  const { stdout } = useStdout()
  const columns = stdout?.columns ?? 100
  // 内宽 = 终端列 − 整帧页边距 − 外框描边 2 − 框内 padding
  const innerWidth = Math.max(24, columns - PAD.page * 2 - 2 - PAD.inline * 2)
  const sectionById = new Map(sections.map((section) => [section.id, section]))
  const focusables = focusableRows(rows, sections)
  const focusOrdinal = focusables.indexOf(focusRow)
  const visible = rows.slice(windowStart, windowStart + Math.max(1, viewport))

  const renderRow = (row: SettingsRow, index: number): JSX.Element => {
    const focused = index === focusRow
    switch (row.kind) {
      case 'card-top': {
        const base = ` ${row.title} `
        let head = row.subtitle === undefined ? base : ` ${row.title} · ${row.subtitle} `
        if (displayWidth(head) > innerWidth - 4) head = base // 窄终端先丢副标题（dsh 同序）
        const fill = Math.max(1, innerWidth - 3 - displayWidth(head))
        return (
          <Text key={index} wrap="truncate-end">
            <Text color={BORDER.frame}>╭─</Text>
            <Text bold color={PALETTE.text}>
              {head}
            </Text>
            <Text color={BORDER.frame}>{'─'.repeat(fill)}╮</Text>
          </Text>
        )
      }
      case 'card-bottom':
        return (
          <Text key={index} color={BORDER.frame}>
            ╰{'─'.repeat(Math.max(0, innerWidth - 2))}╯
          </Text>
        )
      case 'spacer':
        return <Text key={index}> </Text>
      case 'hint':
        return (
          <Text key={index} wrap="truncate-end">
            {focused ? MARK.selected : MARK.idle}
            <Text
              {...(row.jump === undefined ? TEXT.secondary : {})}
              bold={focused}
              color={row.jump === undefined ? undefined : ACCENT}
            >
              {row.text}
            </Text>
          </Text>
        )
      case 'field': {
        const section = sectionById.get(row.sectionId)
        const field = section?.fields[row.fieldIndex]
        if (field === undefined) return <Text key={index}> </Text>
        const sectionValues = values[row.sectionId]
        const valueText = fieldValueText(field, sectionValues, editing !== null && editing.sectionId === row.sectionId ? editing : null)
        const valueColor = fieldValueColor(field, sectionValues, editing !== null && editing.sectionId === row.sectionId ? editing : null, focused)
        const labelText = clipToWidth(field.label ?? '', Math.max(8, innerWidth - 12))
        const clipped = clipToWidth(valueText, Math.max(4, innerWidth - 2 - displayWidth(labelText) - 1))
        const pad = Math.max(1, innerWidth - 2 - displayWidth(labelText) - displayWidth(clipped))
        return (
          <Text key={index} wrap="truncate-end">
            {focused ? MARK.selected : MARK.idle}
            <Text bold={focused} color={PALETTE.text}>
              {labelText}
            </Text>
            {' '.repeat(pad)}
            <Text color={valueColor} {...(valueColor === undefined ? TEXT.secondary : {})}>
              {clipped}
            </Text>
          </Text>
        )
      }
    }
  }

  // 底部提示条：聚焦字段的 help（可复制的 info 追加复制提示）截断后靠左，按键靠右
  const focusedRow = rows[focusRow]
  const focusedField = focusedRow?.kind === 'field' ? sectionById.get(focusedRow.sectionId)?.fields[focusedRow.fieldIndex] : undefined
  let help = focusedField?.help ?? ''
  if (focusedField?.type === 'info' && focusedField.copyable === true) {
    help = `${help === '' ? '' : `${help} · `}Enter 复制`
  }
  const keys = editing !== null ? 'Enter 确认并保存 · Esc 取消' : 'Enter 切换/编辑 · Esc 关闭'
  const helpText = clipToWidth(help, Math.max(0, innerWidth - displayWidth(keys) - 2))

  return (
    <Box
      borderStyle="round"
      borderColor={BORDER.active}
      paddingX={PAD.inline}
      flexDirection="column"
      flexGrow={1}
      overflowY="hidden"
      gap={GAP.none}
    >
      <Box flexShrink={0} flexDirection="column" gap={GAP.none}>
        <Text {...TEXT.label} color={ACCENT} wrap="truncate-end">
          设置（{sections.length} 个分区）
          {focusOrdinal >= 0 ? (
            <Text {...TEXT.secondary}>
              {SEP.gap}
              {focusOrdinal + 1}/{focusables.length}
            </Text>
          ) : null}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden" gap={GAP.none}>
        {visible.map((row, offset) => renderRow(row, windowStart + offset))}
      </Box>
      <Box flexShrink={0} flexDirection="column" gap={GAP.none}>
        <Text wrap="truncate-end">
          {notice === null ? (
            <Text> </Text>
          ) : (
            <Text color={notice.ok ? STATUS_COLOR.done : STATUS_COLOR.failed}>
              {notice.ok ? '✓' : '✕'} {notice.text}
            </Text>
          )}
        </Text>
        <Text wrap="truncate-end">
          <Text {...TEXT.secondary}>{helpText}</Text>
          <Text {...TEXT.secondary}>{' '.repeat(Math.max(1, innerWidth - displayWidth(helpText) - displayWidth(keys)))}</Text>
          <Text {...TEXT.label} color={ACCENT}>
            {keys}
          </Text>
        </Text>
      </Box>
    </Box>
  )
}
