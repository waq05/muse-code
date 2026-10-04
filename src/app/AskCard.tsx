/**
 * 提问卡：ask_user 挂起时的模态作答卡（键盘与鼠标路由在 App 顶层，本组件纯展示）。
 *
 * 一批题目逐题作答、按题序提交（ask 服务按 answerQuestion 次序收答案）：
 * 单选 ↑↓ 高亮 + 空格即作答并推进；多选空格勾选、Enter（空输入）提交勾选项；
 * 自由文本直接打字（卡片底部输入行），Enter 提交；Esc 跳过本题。设计上刻意不用
 * 数字键选项——数字要留给自由文本。鼠标点选项行与空格等价（单选即答、多选勾选）；
 * 问题与选项行一律单行截断——行号是点击命中的几何。
 *
 * @module dsc-tui/app/AskCard
 */
import { useRef } from 'react'
import { Box, Text } from 'ink'
import type { DOMElement } from 'ink'
import type { JSX } from 'react'
import type { AskQuestionItem, AskUserView } from '../contract.js'
import { ACCENT, BORDER, GAP, MARK, PAD, STATUS_COLOR, TEXT } from './theme.js'
import { useClickRegion, type RegisterClick } from './click.js'

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
  /** 鼠标点中当前题的选项行时派发（单选=作答推进，多选=切换勾选）。 */
  onOptionClick?: (option: number) => void
  registerClick?: RegisterClick
}

export function AskCard({
  ask,
  index,
  checked,
  highlight,
  text,
  onOptionClick,
  registerClick,
}: AskCardProps): JSX.Element {
  const questions: AskQuestionItem[] = ask.questions ?? [ask]
  const rootRef = useRef<DOMElement | null>(null)
  const active = questions[index]

  // 行构造：顶边框(1) + 标题(1) + 前面各题各 1 行 + 当前题干 1 行 → 选项从这里起。
  // 几何点击时现量（避免节流渲染导致的滞后）。
  useClickRegion(
    rootRef,
    registerClick,
    onOptionClick === undefined || active === undefined
      ? undefined
      : (col, row, top, height) => {
          const firstOptionRow = top + 3 + index
          const option = row - firstOptionRow
          if (option < 0 || option >= active.options.length) return false
          onOptionClick(option)
          return true
        },
  )

  return (
    <Box
      ref={rootRef}
      borderStyle="double"
      borderColor={BORDER.alert}
      paddingX={PAD.inline}
      flexDirection="column"
      marginTop={GAP.tight}
      gap={GAP.none}
    >
      <Text {...TEXT.label} color={BORDER.alert} wrap="truncate-end">
        ❓ 模型提问（第 {index + 1}/{questions.length} 题
        {questions.length > 1 ? '，逐题作答统一提交' : ''}）
      </Text>
      {questions.map((item, questionIndex) => {
        const isActive = questionIndex === index
        const done = questionIndex < index
        return (
          <Box key={questionIndex} flexDirection="column" gap={GAP.none}>
            <Text {...(isActive ? TEXT.body : TEXT.secondary)} wrap="truncate-end">
              {done ? '✓ ' : isActive ? '' : '· '}
              {item.header !== undefined && item.header !== '' ? `【${item.header}】` : ''}
              {item.question}
            </Text>
            {isActive ? (
              <Box flexDirection="column" gap={GAP.none}>
                {item.options.map((option, position) => {
                  const isHighlight = position === highlight
                  const isChecked = checked.includes(position)
                  const mark = item.multiSelect ? (isChecked ? '◉' : '○') : isHighlight ? '◉' : '○'
                  return (
                    <Text
                      key={position}
                      color={isHighlight ? ACCENT : undefined}
                      dimColor={!isHighlight}
                      wrap="truncate-end"
                    >
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
                <Text {...TEXT.label} color={STATUS_COLOR.waiting} wrap="truncate-end">
                  {item.multiSelect ? '多选：' : ''}
                  ↑↓ 选择 · 空格 {item.multiSelect ? '勾选' : '选定'} · 鼠标点选项同空格 · Enter 提交 · Esc 跳过
                </Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}
