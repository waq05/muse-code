/**
 * 输入行：ink 6 移除了 TextInput，这里用 useInput 自实现单行受控输入
 * （退格 / 回车发送 / 空输入时 ↑↓ 翻历史）。
 *
 * 输入以 `/` 开头时，输入框上方弹出候选面板：命令阶段列命令、`/model `
 * 参数阶段列可用模型（数据来自 runtime.listModels）。↑↓ 选择、Tab 补全、
 * Esc 关闭（直到输入变化）；Enter 提交前做命令名唯一前缀自动展开。
 *
 * @module dsc/app/Composer
 */
import { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { JSX } from 'react'
import type { ModelChoiceView } from '../contract.js'
import { completionsFor, expandCommand } from '../core/commands-completion.js'
import { ACCENT, BORDER, GAP, MARK, PAD, SEP, TEXT } from './theme.js'

export interface ComposerProps {
  disabled: boolean
  /** 可切换模型列表（/model 参数阶段的候选）。 */
  models: readonly ModelChoiceView[]
  onSubmit: (text: string) => void
}

/** 可打印输入统一压成单行。 */
const flatten = (text: string): string => text.replace(/[\r\n]+/g, ' ')

export function Composer({ disabled, models, onSubmit }: ComposerProps): JSX.Element {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [completionIndex, setCompletionIndex] = useState(0)
  /** Esc 关闭面板后记住被抑制的输入；内容一变自动恢复。 */
  const [suppressedFor, setSuppressedFor] = useState<string | null>(null)

  const completions = useMemo(
    () => (value === suppressedFor ? [] : completionsFor(value, models)),
    [value, suppressedFor, models],
  )
  const panelOpen = completions.length > 0
  const safeIndex = Math.max(0, Math.min(completionIndex, completions.length - 1))

  /** 修改输入并重置补全选中项（函数式更新：同批多次按键不丢状态）。 */
  const updateValue = (next: string | ((previous: string) => string)): void => {
    setValue(next)
    setCompletionIndex(0)
  }

  /** Tab：把选中候选项填进输入框。 */
  const applyCompletion = (): void => {
    const item = completions[safeIndex]
    if (item === undefined) return
    setHistoryIndex(-1)
    updateValue(item.insert)
  }

  useInput((input, key) => {
    if (disabled) return

    // 补全面板打开时，导航键归面板（不与"空输入翻历史"冲突）
    if (panelOpen) {
      if (key.upArrow) {
        setCompletionIndex((current) => Math.max(0, Math.min(current, completions.length - 1) - 1))
        return
      }
      if (key.downArrow) {
        setCompletionIndex((current) =>
          Math.min(completions.length - 1, Math.min(current, completions.length - 1) + 1),
        )
        return
      }
      if (key.tab) {
        applyCompletion()
        return
      }
      if (key.escape) {
        setSuppressedFor(value)
        return
      }
    }

    if (key.return) {
      // 面板打开时 Enter 采用当前选中项（`/mo`+Enter → `/model `；
      // `/model deep`+Enter → `/model ark/deepseek-v4-pro`），否则按前缀展开。
      const chosen = panelOpen ? completions[safeIndex]?.insert : undefined
      const text = expandCommand((chosen ?? value).trim())
      if (text === '') return
      setHistory((previous) => [text, ...previous])
      setHistoryIndex(-1)
      setSuppressedFor(null)
      setValue('')
      onSubmit(text)
      return
    }
    if (key.backspace || key.delete) {
      updateValue((previous) => previous.slice(0, -1))
      return
    }
    if (key.upArrow && value === '' && history.length > 0) {
      const next = historyIndex < 0 ? 0 : Math.min(historyIndex + 1, history.length - 1)
      setHistoryIndex(next)
      setValue(history[next] ?? '')
      return
    }
    if (key.downArrow && historyIndex >= 0) {
      const next = historyIndex - 1
      setHistoryIndex(next)
      setValue(next < 0 ? '' : history[next] ?? '')
      return
    }
    if (key.ctrl || key.meta || key.leftArrow || key.rightArrow || key.home || key.end) return
    if (key.tab || key.escape) return
    const printable = flatten(input)
    if (printable !== '') {
      setHistoryIndex(-1)
      updateValue((previous) => previous + printable)
    }
  })

  return (
    <Box flexDirection="column" gap={GAP.none}>
      {panelOpen ? (
        <Box borderStyle="single" borderColor={BORDER.frame} paddingX={PAD.inline} flexDirection="column" gap={GAP.none}>
          {completions.map((item, position) => {
            const selected = position === safeIndex
            return (
              <Text key={item.label} color={selected ? ACCENT : undefined}>
                {selected ? MARK.selected : MARK.idle}
                {item.label}
                <Text {...TEXT.secondary}>
                  {SEP.gap}
                  {item.description}
                </Text>
              </Text>
            )
          })}
          <Text {...TEXT.secondary}>↑↓ 选择 · Tab 补全 · Esc 关闭</Text>
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor={disabled ? BORDER.frame : BORDER.active} paddingX={PAD.inline}>
        <Text color={ACCENT}>
          ❯{' '}
        </Text>
        <Text {...TEXT.body}>{value}</Text>
        <Text {...TEXT.secondary}>▏</Text>
      </Box>
    </Box>
  )
}
