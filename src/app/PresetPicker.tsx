/**
 * 模式选择浮层（/preset 无参数打开，对齐 dsh 裸命令开 picker）：整屏可点版。
 * 数据来自 runtime.listPresets() 的模式投影（当前会话用的 + 新会话默认的 + 全部
 * 可选），行带「✓ 当前 / 默认 / 内置」标记；输入即筛选（按显示名/名字/说明），
 * Enter 切换当前会话的模式、Esc 关闭。键盘与鼠标路由在 App 顶层，本组件纯展示。
 *
 * @module dsc-tui/app/PresetPicker
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { PresetView } from '../contract.js'
import { ACCENT, BORDER, GAP, MARK, PAD, SEP, STATUS_COLOR, TEXT } from './theme.js'

export function PresetPicker({
  presets,
  current,
  defaultName,
  index,
  query,
}: {
  presets: PresetView[]
  /** 当前会话正在用的模式名。 */
  current: string
  /** 新会话默认用的模式名。 */
  defaultName: string
  index: number
  query: string
}): JSX.Element {
  const safeIndex = Math.min(index, Math.max(0, presets.length - 1))
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
        模式选择（{presets.length} 个）
        <Text {...TEXT.secondary}>{SEP.gap}点击选中、再点切换 · Enter 切换（写进会话记录，恢复会话时跟着回来）</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text {...TEXT.label} color={ACCENT}>
          筛选{' '}
        </Text>
        <Text {...(query === '' ? TEXT.secondary : TEXT.body)}>
          {query === '' ? '（直接输入按显示名/名字/说明过滤）' : query}
          <Text {...TEXT.secondary}>▏</Text>
        </Text>
      </Text>
      {presets.length === 0 ? <Text {...TEXT.secondary}>（没有匹配的模式）</Text> : null}
      {presets.map((preset, position) => {
        const selected = position === safeIndex
        const isCurrent = preset.name === current
        return (
          <Text key={preset.name} color={selected ? ACCENT : undefined} wrap="truncate-end">
            {selected ? MARK.selected : MARK.idle}
            {preset.label}
            <Text {...TEXT.secondary}>{SEP.gap}{preset.name}</Text>
            {isCurrent ? <Text {...TEXT.label} color={STATUS_COLOR.done}>{SEP.gap}✓ 当前</Text> : null}
            {!isCurrent && preset.name === defaultName ? (
              <Text {...TEXT.label} color={STATUS_COLOR.waiting}>{SEP.gap}默认</Text>
            ) : null}
            {preset.builtin ? <Text {...TEXT.secondary}>{SEP.gap}内置</Text> : null}
            <Text {...TEXT.secondary}>{SEP.gap}{preset.description}</Text>
            {preset.problem !== undefined ? (
              <Text {...TEXT.label} color={STATUS_COLOR.failed}>{SEP.gap}注意：{preset.problem}</Text>
            ) : null}
          </Text>
        )
      })}
      <Text {...TEXT.secondary} wrap="truncate-end">
        ↑↓ 选择 · Enter 切换 · Esc 关闭 · 带参数切换走 /preset &lt;名字&gt;
      </Text>
      </Box>
    </Box>
  )
}
