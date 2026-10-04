/**
 * 模型选择浮层（/model 无参数打开）：可切换模型的滚动列表，输入即筛选
 * （按端点/模型名/说明），↑↓ 选择、Enter 切换（下一次请求生效）、Esc 关闭。
 * 键盘路由在 App 顶层统一处理，本组件纯展示。
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
      marginTop={GAP.tight}
      gap={GAP.none}
    >
      <Text {...TEXT.label} color={ACCENT}>
        模型选择（{models.length} 个）
        <Text {...TEXT.secondary}>{SEP.gap}Enter 切换（下一次请求生效）</Text>
      </Text>
      <Text>
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
      <Text {...TEXT.secondary}>↑↓ 选择 · Enter 切换 · Esc 关闭</Text>
    </Box>
  )
}
