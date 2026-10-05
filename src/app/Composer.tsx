/**
 * 输入行：ink 6 移除了 TextInput，这里用 useInput 自实现受控输入。
 *
 * 批次三起是「光标模型」：value + caret 两个状态，支持 ←→/Home/End 移动、
 * Ctrl+A/E/U/K/W 编辑键、Shift+Enter / Ctrl+J 换行（多行输入）、粘贴整段插入
 * （粘贴里的换行不再压平——PasteBurst-lite）。
 *
 * 补全面板两类：
 * - `/` 命令补全（命令阶段列命令、`/model ` 参数阶段列模型），仅在行首生效；
 * - `@` 文件提及补全（core/mention 的定位与排序，文件清单经 dock 的 fs-list
 *   异步拉一次缓存），任意位置生效、优先于命令补全。
 * ↑↓ 选择、Tab 补全、Esc 关闭（内容一变自动恢复）；Enter 提交前做命令唯一前缀展开。
 *
 * 历史持久化在 history-store（~/.dsc/.tui-history，新的在前，多行压平存）。
 *
 * @module dsc/app/Composer
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { DOMElement } from 'ink'
import type { JSX } from 'react'
import type { ModelChoiceView } from '../contract.js'
import { completionsFor, expandCommand } from '../core/commands-completion.js'
import {
  collectWorkspaceFiles,
  insertMention,
  mentionQueryAt,
  rankMentionCandidates,
  type MentionQuery,
} from '../core/mention.js'
import { useParkedCursor } from './cursor.js'
import { displayWidth, measuredSpan, useClickRegion, type RegisterClick } from './click.js'
import { loadHistory, recordHistory } from './history-store.js'
import { settingsWindowStart } from './settings-model.js'
import { ACCENT, BORDER, GAP, MARK, PAD, SEP, STATUS_COLOR, TEXT } from './theme.js'

/** 补全面板视口行数：候选再多也只画这行窗口，聊天区不被挤没（选中越缘窗口跟滑）。 */
const PANEL_ROWS = 10

/** fs-list 透传回包的最小形状（desktop-dock 插件定义，这里只认形状）。 */
export type DirLister = (dir: string) => Promise<{ entries: { name: string; dir: boolean }[] }>

/** 输入框上方的图片附件芯片（Ctrl+V 剪贴板贴图；路径不进正文，提交时统一读取）。 */
export interface ComposerAttachment {
  id: number
  path: string
  name: string
}

export interface ComposerProps {
  disabled: boolean
  /** 可切换模型列表（/model 参数阶段的候选）。 */
  models: readonly ModelChoiceView[]
  /** 占位提示（输入为空时以暗淡色显示，例如计划卡的「带反馈退回」模式）。 */
  placeholder?: string
  /** false = 关掉 `/` 命令补全面板（反馈这类自由文本模式用，Esc 的语义归上层）。 */
  completionsEnabled?: boolean
  /** 工作区文件清单的来源（@ 提及补全；dock 不可用时可以不传，@ 补全退化为空）。 */
  lister?: DirLister
  /** 补全面板开合变化（App 需要：Esc 打断与「关面板」的分流）。 */
  onPanelOpenChange?: (open: boolean) => void
  /** 草稿变化上报（App 的双击 Esc 撤回要判断输入框是否为空）。 */
  onDraftChange?: (text: string) => void
  /**
   * 外部灌入的草稿（token 变化即生效）：双击 Esc 撤回把上一轮的原话放回来编辑、
   * 剪贴板读到的是文本时并入草稿。
   */
  preset?: { text: string; token: number }
  /** 图片附件芯片（App 持有状态；省略 = 不渲染芯片行）。 */
  attachments?: ComposerAttachment[]
  onRemoveAttachment?: (id: number) => void
  onPreviewAttachment?: (id: number) => void
  /** 输入框左侧 ⌸ 会话列表按钮（对齐 dsh 的 home 按钮；省略 = 不渲染）。 */
  onOpenSessions?: () => void
  /** 回合跑动中：❯ 提示符变暗（dsh 同语义）。 */
  working?: boolean
  registerClick?: RegisterClick
  onSubmit: (text: string) => void
}

/** 附件芯片：主体点击 = 预览，尾部的 ✕ 点击 = 摘下。 */
function AttachmentChip({
  att,
  onRemove,
  onPreview,
  registerClick,
}: {
  att: ComposerAttachment
  onRemove?: (id: number) => void
  onPreview?: (id: number) => void
  registerClick?: RegisterClick
}): JSX.Element {
  const bodyRef = useRef<DOMElement | null>(null)
  const closeRef = useRef<DOMElement | null>(null)
  useClickRegion(
    bodyRef,
    onPreview === undefined ? undefined : registerClick,
    onPreview === undefined
      ? undefined
      : (col, row, top, height) => {
          if (row < top || row >= top + height) return false
          const span = measuredSpan(bodyRef.current)
          if (span === null || col < span.left || col >= span.left + span.width) return false
          onPreview(att.id)
          return true
        },
  )
  useClickRegion(
    closeRef,
    onRemove === undefined ? undefined : registerClick,
    onRemove === undefined
      ? undefined
      : (col, row, top, height) => {
          if (row < top || row >= top + height) return false
          const span = measuredSpan(closeRef.current)
          if (span === null || col < span.left || col >= span.left + span.width) return false
          onRemove(att.id)
          return true
        },
  )
  return (
    <Box>
      <Box ref={bodyRef}>
        <Text color={ACCENT} wrap="truncate-end">
          [图#{att.id}] {att.name}
        </Text>
      </Box>
      <Box ref={closeRef}>
        <Text {...TEXT.label} color={STATUS_COLOR.failed}>
          {' '}
          ✕
        </Text>
      </Box>
    </Box>
  )
}

export function Composer({
  disabled,
  models,
  placeholder,
  completionsEnabled = true,
  lister,
  onPanelOpenChange,
  onDraftChange,
  preset,
  attachments,
  onRemoveAttachment,
  onPreviewAttachment,
  onOpenSessions,
  working = false,
  registerClick,
  onSubmit,
}: ComposerProps): JSX.Element {
  const [value, setValue] = useState('')
  const [caret, setCaret] = useState(0)
  const [history, setHistory] = useState<string[]>(() => loadHistory())
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [completionIndex, setCompletionIndex] = useState(0)
  /** @ 提及的工作区文件清单：第一次敲 @ 时拉一次，进程内缓存。 */
  const [mentionFiles, setMentionFiles] = useState<string[]>([])
  const mentionLoaded = useRef(false)
  /** Esc 关闭面板后记住被抑制的输入；内容一变自动恢复。 */
  const [suppressedFor, setSuppressedFor] = useState<string | null>(null)

  /** 光标处的 @ 提及查询（null = 不在 @ 补全态）。 */
  const mention = useMemo(() => mentionQueryAt(value, caret), [value, caret])

  const completions = useMemo(() => {
    if (value === suppressedFor) return []
    if (mention !== null) {
      return rankMentionCandidates(mentionFiles, mention.token, 8).map((path) => ({
        insert: path,
        label: path,
        description: '文件提及',
      }))
    }
    if (!completionsEnabled) return []
    // 命令候选全量（内置 + 插件 + 技能命令，40+ 条）；面板只画 PANEL_ROWS 行窗口，
    // 选中项越缘窗口跟着滑（settingsWindowStart 焦点跟随语义，与设置页同款）。
    return completionsFor(value, models)
  }, [value, suppressedFor, mention, mentionFiles, completionsEnabled, models])

  const panelOpen = completions.length > 0
  const safeIndex = Math.max(0, Math.min(completionIndex, completions.length - 1))
  /** 面板视口：候选超过 PANEL_ROWS 时只画选中项附近的窗口（纯派生，无新状态）。 */
  const panelStart = settingsWindowStart(safeIndex, PANEL_ROWS, completions.length)
  const panelVisible = completions.slice(panelStart, panelStart + PANEL_ROWS)

  useEffect(() => {
    onPanelOpenChange?.(panelOpen)
  }, [panelOpen, onPanelOpenChange])

  /** 第一次需要 @ 候选时才拉工作区文件清单（异步递归，失败当空表——补全只是锦上添花）。 */
  useEffect(() => {
    if (mention === null || mentionLoaded.current || lister === undefined) return
    mentionLoaded.current = true
    void collectWorkspaceFiles(lister)
      .then((files) => setMentionFiles(files))
      .catch(() => setMentionFiles([]))
  }, [mention, lister])

  // 草稿上报（App 判断「输入框为空」的依据）；preset 灌入（撤回文本回框）。
  useEffect(() => {
    onDraftChange?.(value)
  }, [value, onDraftChange])
  useEffect(() => {
    if (preset === undefined || preset.token === 0) return
    setValue(preset.text)
    setCaret(preset.text.length)
    setHistoryIndex(-1)
    setSuppressedFor(null)
  }, [preset])

  // IME 光标停靠（0.6.57，ink useCursor）：声明 caret 的逻辑行列，帧尾光标停到
  // 输入框内——Windows Terminal 的拼音预览因此画在输入框里。
  const inputBoxRef = useRef<DOMElement | null>(null)
  const homeRef = useRef<DOMElement | null>(null)
  useClickRegion(
    homeRef,
    onOpenSessions === undefined ? undefined : registerClick,
    onOpenSessions === undefined
      ? undefined
      : (col, row, top, height) => {
          if (row < top || row >= top + height) return false
          onOpenSessions()
          return true
        },
  )
  const caretBefore = value.slice(0, caret).split('\n')
  // 列原点：边框 1 + padding 1 + 「⌸ 」2（可选）+「❯ 」2
  const promptCols = 2 + (onOpenSessions !== undefined ? 2 : 0)
  useParkedCursor(
    inputBoxRef,
    caretBefore.length - 1,
    displayWidth(caretBefore[caretBefore.length - 1] ?? ''),
    !disabled,
    promptCols,
  )

  /** 修改输入并把光标带到位（函数式更新：同批多次按键不丢状态）。 */
  const update = (next: string, nextCaret: number): void => {
    setValue(next)
    setCaret(Math.max(0, Math.min(nextCaret, next.length)))
    setCompletionIndex(0)
  }

  const insert = (text: string): void => {
    update(value.slice(0, caret) + text + value.slice(caret), caret + text.length)
  }

  /** Tab / Enter（面板开时）：把选中候选项填进输入框。 */
  const applyCompletion = (): boolean => {
    const item = completions[safeIndex]
    if (item === undefined) return false
    setHistoryIndex(-1)
    if (mention !== null) {
      const next = insertMention(value, mention, item.insert)
      update(next.text, next.caret)
    } else {
      update(item.insert, item.insert.length)
    }
    return true
  }

  useInput((input, key) => {
    if (disabled) return
    // SGR 鼠标事件（App 顶层已消费，这里兜底吞掉）绝不能当成打字灌进输入框。
    if (/^\[<\d+;\d+;\d+[Mm]$/.test(input)) return

    // 补全面板打开时，导航键归面板（不与历史翻阅冲突）
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
      if (key.return) {
        // @ 提及：Enter 采纳候选；命令/模型：Enter 采纳（唯一前缀展开在下面统一做）。
        if (mention !== null) {
          applyCompletion()
          return
        }
      }
    }

    if (key.return && !key.shift && !(key.ctrl && input === 'j')) {
      if (panelOpen && mention !== null) return // 上面已处理
      // 面板打开时 Enter 采用当前选中项（`/mo`+Enter → `/model `），否则按前缀展开。
      const chosen = panelOpen ? completions[safeIndex]?.insert : undefined
      const text = expandCommand((chosen ?? value).trim())
      if (text === '') return
      setHistory((previous) => recordHistory(previous, text))
      setHistoryIndex(-1)
      setSuppressedFor(null)
      setValue('')
      setCaret(0)
      onSubmit(text)
      return
    }
    // 换行：Shift+Enter 或 Ctrl+J（ink 把 Shift+Enter 交成 key.return + key.shift）。
    if ((key.return && key.shift) || (key.ctrl && input === 'j')) {
      insert('\n')
      return
    }
    if (key.backspace || key.delete) {
      if (key.delete && caret < value.length && !key.backspace) {
        update(value.slice(0, caret) + value.slice(caret + 1), caret)
        return
      }
      if (caret > 0) update(value.slice(0, caret - 1) + value.slice(caret), caret - 1)
      return
    }
    if (key.leftArrow) {
      setCaret((current) => Math.max(0, current - 1))
      return
    }
    if (key.rightArrow) {
      setCaret((current) => Math.min(value.length, current + 1))
      return
    }
    if (key.home || (key.ctrl && input === 'a')) {
      setCaret(0)
      return
    }
    if (key.end || (key.ctrl && input === 'e')) {
      setCaret(value.length)
      return
    }
    if (key.ctrl && input === 'u') {
      update(value.slice(caret), 0)
      return
    }
    if (key.ctrl && input === 'k') {
      update(value.slice(0, caret), caret)
      return
    }
    if (key.ctrl && input === 'w') {
      // 删光标前的一个词（空白分词，吃掉前导空白）
      const head = value.slice(0, caret)
      const trimmed = head.replace(/\s+$/, '').replace(/\S*$/, '')
      update(trimmed + value.slice(caret), trimmed.length)
      return
    }
    if (key.upArrow && value === '' && history.length > 0) {
      const next = historyIndex < 0 ? 0 : Math.min(historyIndex + 1, history.length - 1)
      setHistoryIndex(next)
      const recalled = history[next] ?? ''
      update(recalled, recalled.length)
      return
    }
    if (key.downArrow && historyIndex >= 0) {
      const next = historyIndex - 1
      setHistoryIndex(next)
      const recalled = next < 0 ? '' : history[next] ?? ''
      update(recalled, recalled.length)
      return
    }
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) return
    if (key.tab || key.escape) return
    if (key.ctrl || key.meta) return
    // 粘贴整段（带换行）原样插入（只去 \r）；普通输入照旧。
    const printable = input.includes('\n') ? input.replace(/\r/g, '') : input.replace(/[\r\n]+/g, '')
    if (printable !== '') {
      setHistoryIndex(-1)
      insert(printable)
    }
  })

  return (
    <Box flexDirection="column" gap={GAP.none}>
      {panelOpen ? (
        <Box borderStyle="single" borderColor={BORDER.frame} paddingX={PAD.inline} flexDirection="column" gap={GAP.none}>
          {panelVisible.map((item, position) => {
            const selected = panelStart + position === safeIndex
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
          <Text {...TEXT.secondary}>
            {completions.length > panelVisible.length
              ? `${panelStart + 1}–${panelStart + panelVisible.length}/${completions.length} 条 · `
              : ''}
            ↑↓ 选择 · Tab 补全 · Esc 关闭
          </Text>
        </Box>
      ) : null}
      {attachments !== undefined && attachments.length > 0 ? (
        <Box gap={PAD.field} flexWrap="wrap">
          {attachments.map((att) => (
            <AttachmentChip
              key={att.id}
              att={att}
              onRemove={onRemoveAttachment}
              onPreview={onPreviewAttachment}
              registerClick={registerClick}
            />
          ))}
        </Box>
      ) : null}
      <Box ref={inputBoxRef} borderStyle="round" borderColor={disabled ? BORDER.frame : BORDER.active} paddingX={PAD.inline}>
        {onOpenSessions !== undefined ? (
          <Box ref={homeRef}>
            <Text {...TEXT.secondary}>⌸ </Text>
          </Box>
        ) : null}
        <Text color={working && !disabled ? BORDER.frame : ACCENT}>
          ❯{' '}
        </Text>
        {value === '' && placeholder !== undefined ? (
          <Text {...TEXT.secondary}>{placeholder}</Text>
        ) : (
          <Text {...TEXT.body}>{value}</Text>
        )}
      </Box>
    </Box>
  )
}
