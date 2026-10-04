/**
 * 提问卡：ask_user 挂起时的模态作答卡（键盘路由在 App 顶层，本组件纯展示）。
 *
 * 一批题目逐题作答、按题序提交（ask 服务按 answerQuestion 次序收答案）：
 * 单选 ↑↓ 高亮 + 空格即作答并推进；多选空格勾选、Enter（空输入）提交勾选项；
 * 自由文本直接打字（卡片底部输入行），Enter 提交；Esc 跳过本题。
 * 设计上刻意不用数字键选项——数字要留给自由文本。
 *
 * @module dsc-tui/app/AskCard
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { AskQuestionItem, AskUserView } from '../contract.js'
import { ACCENT, BORDER, GAP, MARK, PAD, STATUS_COLOR, TEXT } from './theme.js'

/** 跳过一题时替用户写的实话（与桌面端 TaskDock、ask.ts 中断口径一致）。 */
export const SKIPPED_ANSWER = '（用户跳过了这一题）'

export interface AskCardProps {
  ask: AskUserView
  /** 当前作答到第几题（0 基）。 */
  index: number
  /** 多选题已勾选的选项下标。 */
  checked: readonly number[]
  /** 当前高亮的选项下标。 */
  highlight: number
  /** 自由文本草稿。 */
  text: string
}

export function AskCard({ ask, index, checked, highlight, text }: AskCardProps): JSX.Element {
  const questions: AskQuestionItem[] = ask.questions ?? [ask]
  return (
    <Box
      borderStyle="double"
      borderColor={BORDER.alert}
      paddingX={PAD.inline}
      flexDirection="column"
      marginTop={GAP.tight}
      gap={GAP.none}
    >
      <Text {...TEXT.label} color={BORDER.alert}>
        ❓ 模型提问（第 {index + 1}/{questions.length} 题
        {questions.length > 1 ? '，逐题作答统一提交' : ''}）
      </Text>
      {questions.map((item, questionIndex) => {
        const active = questionIndex === index
        const done = questionIndex < index
        return (
          <Box key={questionIndex} flexDirection="column" gap={GAP.none}>
            <Text {...(active ? TEXT.body : TEXT.secondary)}>
              {done ? '✓ ' : active ? '' : '· '}
              {item.header !== undefined && item.header !== '' ? `【${item.header}】` : ''}
              {item.question}
            </Text>
            {active ? (
              <Box flexDirection="column" gap={GAP.none}>
                {item.options.map((option, position) => {
                  const isHighlight = position === highlight
                  const isChecked = checked.includes(position)
                  const mark = item.multiSelect ? (isChecked ? '◉' : '○') : isHighlight ? '◉' : '○'
                  return (
                    <Text key={position} color={isHighlight ? ACCENT : undefined} dimColor={!isHighlight}>
                      {isHighlight ? MARK.selected : MARK.idle}
                      {mark} {option.label}
                      {option.description !== undefined ? (
                        <Text {...TEXT.secondary}> — {option.description}</Text>
                      ) : null}
                    </Text>
                  )
                })}
                <Text>
                  <Text color={ACCENT}>❯ </Text>
                  <Text {...(text === '' ? TEXT.secondary : TEXT.body)}>
                    {text === '' ? '（直接打字可自由作答）' : text}
                  </Text>
                  <Text {...TEXT.secondary}>▏</Text>
                </Text>
                <Text {...TEXT.label} color={STATUS_COLOR.waiting}>
                  {item.multiSelect ? '多选：' : ''}
                  ↑↓ 选择 · 空格 {item.multiSelect ? '勾选' : '选定'} · Enter 提交 · Esc 跳过
                </Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}
