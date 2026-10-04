/**
 * 模型选择浮层（/model 无参数打开）：整屏可点版。根盒撑满状态栏之上的全部空间，
 * 列表行从构造位置起排（上边框 + 标题 + 筛选行），屏幕行与候选一一对应——鼠标点击
 * 选中、再点已选中项即切换；滚轮与 ↑↓ 同义（路由在 App 键盘/鼠标顶层）。输入即筛选
 * （按端点/模型名/说明），Enter 切换（下一次请求生效）、Esc 关闭。本组件纯展示。
 *
 * @module dsc-tui/app/ModelPicker
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { ModelChoiceView } from '../contract.js'
import { ACCENT, BORDER, GAP, MARK, PAD, SEP, TEXT } from './theme.js'

export function ModelPicker({
  models,
  index,
  query,
}: {
  models: ModelChoiceView[]
  index: number
  query: string
}): JSX.Element {
  const safeIndex = Math.min(index, Math.max(0, models.length - 1))
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
        模型选择（{models.length} 个）
        <Text {...TEXT.secondary}>{SEP.gap}点击选中、再点应用 · Enter 切换（下一次请求生效）</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text {...TEXT.label} color={ACCENT}>
          筛选{' '}
        </Text>
        <Text {...(query === '' ? TEXT.secondary : TEXT.body)}>
          {query === '' ? '（直接输入按端点/模型/说明过滤）' : query}
          <Text {...TEXT.secondary}>▏</Text>
        </Text>
      </Text>
      {models.length === 0 ? <Text {...TEXT.secondary}>（没有匹配的模型）</Text> : null}
      {models.map((choice, position) => {
        const selected = position === safeIndex
        return (
          <Text key={choice.value} color={selected ? ACCENT : undefined} wrap="truncate-end">
            {selected ? MARK.selected : MARK.idle}
            {choice.value}
            <Text {...TEXT.secondary}>
              {SEP.gap}
              {choice.description}
            </Text>
          </Text>
        )
      })}
      <Text {...TEXT.secondary} wrap="truncate-end">
        ↑↓ 选择 · Enter 切换 · Esc 关闭
      </Text>
      </Box>
    </Box>
  )
}
