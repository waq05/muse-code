/**
 * 会话流：把 TranscriptEntry 序列渲染成终端块。只渲染 App 算好的「可见窗口」切片
 * （整屏视口：根盒恒定高度、底对齐、老条目从顶上裁掉；回看走 Ctrl+O 浮层）。
 *
 * 排版走 theme 的三档文字：助手回答与用户输入是正文（默认前景），思考正文与系统
 * 说明是次要信息（暗淡色），思考标题是状态标签（暗淡色 + 状态色）。条目之间贴排，
 * 纵向间距只在 `ChatView` 这一处声明。
 *
 * 过程节点如实显示：中断/失败的轮有轮尾标记、输出截断与模型重试各有自己的行、
 * 轮尾有「文件已更改」聚合、计划卡带批准状态、插话带 ↩ 徽标、压缩落点画分隔线——
 * 失败轮和成功轮在终端里不再长得一样。
 *
 * @module dsc-tui/app/ChatView
 */
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useStdout } from 'ink'
import type { DOMElement } from 'ink'
import type { JSX, ReactNode } from 'react'
import type { SubagentCardView, TranscriptEntry } from '../contract.js'
import { MarkdownView } from './MarkdownView.js'
import { ToolCard } from './ToolCard.js'
import { displayWidth } from './markdown.js'
import { useClickRegion, type RegisterClick } from './click.js'
import { ACCENT, DIFF_COLOR, GAP, INDENT, PAD, PALETTE, STATUS_COLOR, TEXT } from './theme.js'

/** 流式思考的盲文 spinner 帧（dsh 同款字符，80-120ms 一拍）。 */
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** 盲文 spinner：本地帧状态只重渲染自己，不动会话流的 reconcile。 */
function BrailleSpinner(): JSX.Element {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setFrame((current) => (current + 1) % BRAILLE.length), 120)
    return () => clearInterval(timer)
  }, [])
  return <Text color={PALETTE.accent}>{BRAILLE[frame]}</Text>
}

const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 时长的人话格式（dsh duration 同款）：48s / 3m12s；不足 1 秒返回空串（不显示）。 */
const fmtSeconds = (ms: number): string => {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 1) return ''
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/** token 数的人话格式（与 StatusBar 的 fmtTokens 同口径：988 / 3.4k / 12k / 1.0M）。 */
const fmtTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/**
 * 按显示宽度硬截单行：折行会破坏瀑布的恒定 3 行窗口（dsh clipLine 同款）。
 * 逐码点走，CJK/emoji 宽字符永远不会被劈成两半。
 */
const clipLine = (text: string, maxWidth: number): string => {
  if (maxWidth <= 1) return ''
  let width = 0
  let index = 0
  while (index < text.length) {
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0)
    const charWidth = displayWidth(char)
    if (width + charWidth > maxWidth - 1) return `${text.slice(0, index)}…`
    width += charWidth
    index += char.length
  }
  return text
}

/** 文件路径的末段（显示用）。 */
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** 子代理卡的运行状态词与颜色（对照 dsh SubagentMessage 的 status()）。 */
const SUBAGENT_STATUS: Record<SubagentCardView['state'], { glyph: string; label: string; color: string | undefined }> = {
  working: { glyph: '◐', label: '运行中', color: STATUS_COLOR.pending },
  idle: { glyph: '✓', label: '已完成', color: STATUS_COLOR.done },
  failed: { glyph: '✗', label: '失败', color: STATUS_COLOR.failed },
  stopped: { glyph: '×', label: '已停止', color: STATUS_COLOR.failed },
}

/** 瀑布窗口恒定 3 行（Kimi Code 视觉语言，dsh 同款）：高度不随输出抖动。 */
const WATERFALL_ROWS = 3

/**
 * 子代理内联卡：跑动时 = 头行（状态点 + bold 任务 + 模型/轮数/工具数/耗时/token）
 * + 当前工具行 + 恒定 3 行输出瀑布（dim、`│` 引导）；收工折成头行一行（失败保留
 * 一条错误行）。整卡可点，点了开队友的只读转录浮层。
 */
function SubagentCard({
  sub,
  onOpen,
  registerClick,
}: {
  sub: SubagentCardView
  onOpen?: (file: string) => void
  registerClick?: RegisterClick
}): JSX.Element {
  const { stdout } = useStdout()
  const ref = useRef<DOMElement | null>(null)
  const settled = sub.state !== 'working'
  // 跑动时头部耗时每秒跳一格（本地 setState 只重渲染这张卡）；收工停表
  const [, setTick] = useState(0)
  useEffect(() => {
    if (settled || sub.startedAt === undefined) return
    const timer = setInterval(() => setTick((current) => current + 1), 1000)
    return () => clearInterval(timer)
  }, [settled, sub.startedAt])
  const info = SUBAGENT_STATUS[sub.state]
  const clickable = onOpen !== undefined && sub.file !== undefined
  useClickRegion(
    ref,
    clickable ? registerClick : undefined,
    clickable
      ? (col, row, top, height) => {
          if (row < top || row >= top + height) return false
          onOpen!(sub.file!)
          return true
        }
      : undefined,
  )
  const columns = stdout?.columns ?? 100
  // 卡片缩进 2 + 瀑布引导 `│ ` 前缀 4，与 dsh 的 WATERFALL_GUTTER 同口径
  const rowWidth = Math.max(20, columns - PAD.page * 2 - INDENT.detail - 2)
  const elapsed =
    sub.startedAt === undefined ? undefined : (sub.finishedAt ?? Date.now()) - sub.startedAt
  const seconds = elapsed === undefined ? '' : fmtSeconds(elapsed)
  const activity = settled ? [] : (sub.outputLines ?? []).slice(-WATERFALL_ROWS)
  return (
    <Box ref={ref} flexDirection="column" marginLeft={INDENT.detail} gap={GAP.none}>
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0}>
          <Text color={info.color}>{sub.state === 'working' ? <BrailleSpinner /> : info.glyph}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text bold color={PALETTE.text}>
            {`子代理：${oneLine(sub.task, 42)}`}
          </Text>
        </Box>
        <Box minWidth={0}>
          <Text {...TEXT.secondary} wrap="truncate-end">
            {`· ${sub.model ?? 'default'} · ${sub.rounds}轮 · ${sub.toolCalls}工具`}
            {seconds === '' ? '' : ` · ${seconds}`}
            {sub.tokens === undefined ? '' : ` · ${fmtTokens(sub.tokens)} tok`}
            {` · `}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={info.color}>{info.label}</Text>
        </Box>
      </Box>
      {!settled && sub.lastTool !== undefined ? (
        <Text {...TEXT.secondary} wrap="truncate-end">
          {`  ${sub.lastTool.status === 'done' ? '✓ ' : sub.lastTool.status === 'failed' ? '✗ ' : ''}${sub.lastTool.name}`}
          {sub.lastTool.args !== '' ? ` (${clipLine(sub.lastTool.args, Math.max(10, rowWidth - sub.lastTool.name.length - 6))})` : ''}
        </Text>
      ) : null}
      {!settled
        ? Array.from({ length: WATERFALL_ROWS }, (_, index) => (
            <Text key={`wf-${index}`} {...TEXT.secondary} wrap="truncate-end">
              {`  │ ${clipLine(activity[index] ?? '', rowWidth)}`}
            </Text>
          ))
        : null}
      {settled && sub.state === 'failed' && sub.error !== undefined ? (
        <Text color={STATUS_COLOR.failed} wrap="truncate-end">
          {`  └ ${clipLine(sub.error, rowWidth)}`}
        </Text>
      ) : null}
    </Box>
  )
}

/** 压缩落点的分隔线（system 通知与重放摘要共用一条样式）。 */
function CompactionRule({ count }: { count: number }): JSX.Element {
  return (
    <Text {...TEXT.label} color={ACCENT}>
      ⎯ 已压缩历史 · 第 {count} 次 ⎯
    </Text>
  )
}

/** 用户消息的图片行：整行可点，点了开半块真彩预览（没有回调时退化为纯说明）。 */
function ImageLine({
  count,
  onPreview,
  registerClick,
}: {
  count: number
  onPreview?: () => void
  registerClick?: RegisterClick
}): JSX.Element {
  const ref = useRef<DOMElement | null>(null)
  useClickRegion(
    ref,
    onPreview === undefined ? undefined : registerClick,
    onPreview === undefined
      ? undefined
      : (col, row, top, height) => {
          if (row < top || row >= top + height) return false
          onPreview()
          return true
        },
  )
  return (
    <Box ref={ref} marginLeft={INDENT.detail}>
      <Text {...TEXT.secondary} color={onPreview === undefined ? undefined : ACCENT}>
        🖼 {count} 张图片{onPreview === undefined ? '' : ' · 点击预览'}
      </Text>
    </Box>
  )
}

/** 单条条目的渲染（回看浮层复用同一份，直播光标由 streaming 控制）。 */
export function Entry({
  entry,
  streaming,
  expandThinking,
  onPreviewImages,
  onOpenAgent,
  registerClick,
}: {
  entry: TranscriptEntry
  streaming: boolean
  expandThinking: boolean
  /** 用户消息图片行的点击回调（省略 = 图片行不可点）。 */
  onPreviewImages?: (images: string[]) => void
  /** 子代理卡的点击回调（省略 = 卡片不可点）：打开队友的只读转录浮层。 */
  onOpenAgent?: (file: string) => void
  registerClick?: RegisterClick
}): JSX.Element | null {
  switch (entry.kind) {
    case 'user':
      return (
        <Box flexDirection="column" gap={GAP.none}>
          {entry.compaction !== undefined ? <CompactionRule count={entry.compaction.count} /> : null}
          {/* 用户行金色粗体（dsh userPromptLabel），自然折行续行对齐文字列 */}
          <Box>
            <Text color={PALETTE.userPrompt} bold>
              ❯{entry.steering === true ? ' ↩' : ''}{' '}
            </Text>
            <Text color={PALETTE.userPrompt} bold>
              {entry.text}
            </Text>
          </Box>
          {entry.images !== undefined && entry.images.length > 0 ? (
            <ImageLine
              count={entry.images.length}
              onPreview={
                onPreviewImages === undefined ? undefined : () => onPreviewImages(entry.images ?? [])
              }
              registerClick={registerClick}
            />
          ) : null}
        </Box>
      )
    case 'thinking': {
      // 标签与内容分行（0.6.57）；0.6.59 对齐 dsh：⚓ + 整行斜体，流式时盲文 spinner；
      // 0.6.60 补时长（≥1s 才显示 · Ns，重放老日志没有这一项就自然不显示）。
      const seconds = entry.durationMs === undefined ? '' : fmtSeconds(entry.durationMs)
      return (
        <Box flexDirection="column" gap={GAP.none}>
          <Text italic {...TEXT.secondary}>
            {streaming ? <BrailleSpinner /> : <Text color={STATUS_COLOR.pending}>⚓</Text>}{' '}
            {streaming ? '思考中' : '思考'}
            {seconds === '' ? '' : ` · ${seconds}`}
            {expandThinking ? '' : '（ctrl+t 展开）'}
          </Text>
          <Box marginLeft={INDENT.detail}>
            <Text {...TEXT.secondary} italic>
              {expandThinking ? entry.text : oneLine(entry.text, 100)}
            </Text>
          </Box>
        </Box>
      )
    }
    case 'text':
      return (
        <Box>
          <MarkdownView source={entry.text} cursor={streaming} />
        </Box>
      )
    case 'tool':
      return <ToolCard call={entry.call} />
    case 'subagent':
      return <SubagentCard sub={entry.sub} onOpen={onOpenAgent} registerClick={registerClick} />
    case 'plan': {
      const state =
        entry.plan.decision === 'approved'
          ? { text: '已批准', color: STATUS_COLOR.done }
          : entry.plan.decision === 'rejected'
            ? { text: '未批准', color: STATUS_COLOR.failed }
            : { text: '待评审', color: STATUS_COLOR.waiting }
      return (
        <Box flexDirection="column" marginLeft={INDENT.tool} gap={GAP.none}>
          <Text>
            <Text {...TEXT.secondary}>📋 计划 </Text>
            <Text {...TEXT.body}>{oneLine(entry.plan.title, 60)}</Text>
            <Text {...TEXT.label} color={state.color}>
              {' '}
              · {state.text}
            </Text>
          </Text>
          <Box marginLeft={INDENT.detail}>
            <Text {...TEXT.secondary}>{entry.plan.file}</Text>
          </Box>
        </Box>
      )
    }
    case 'system':
      return (
        <Box flexDirection="column" gap={GAP.none}>
          {entry.compaction !== undefined ? <CompactionRule count={entry.compaction.count} /> : null}
          <Text {...TEXT.secondary}>ⓘ {entry.text}</Text>
        </Box>
      )
    case 'turn-end':
      return (
        <Text {...TEXT.label} color={entry.reason === 'error' ? STATUS_COLOR.failed : STATUS_COLOR.waiting}>
          {entry.reason === 'error' ? '✗ 过程失败' : '⏹ 已停止'}
        </Text>
      )
    case 'turn-max-tokens':
      return (
        <Text {...TEXT.label} color={STATUS_COLOR.waiting}>
          ⚠ 输出达到长度上限，本轮被截断
        </Text>
      )
    case 'model-retry':
      return (
        <Text {...TEXT.secondary}>
          ↻ 第 {entry.attempt} 次重试：{oneLine(entry.text, 120)}
        </Text>
      )
    case 'changes':
      return (
        <Text {...TEXT.secondary}>
          ✎ {baseName(entry.file.path)}{' '}
          <Text color={DIFF_COLOR.add}>+{entry.file.added}</Text>{' '}
          <Text color={DIFF_COLOR.del}>−{entry.file.removed}</Text>
        </Text>
      )
    case 'turnDiff': {
      const added = entry.files.reduce((sum, file) => sum + file.added, 0)
      const removed = entry.files.reduce((sum, file) => sum + file.removed, 0)
      const names = entry.files
        .slice(0, 3)
        .map((file) => baseName(file.path))
        .join('、')
      return (
        <Text {...TEXT.label}>
          ✎ 本轮改动 {entry.files.length} 个文件（+{added} −{removed}）
          {names !== '' ? `：${names}${entry.files.length > 3 ? '…' : ''}` : ''}
        </Text>
      )
    }
    default:
      return null
  }
}

export function ChatView({
  entries,
  turnState,
  expandThinking,
  empty,
  header,
  onPreviewImages,
  onOpenAgent,
  registerClick,
}: {
  /** 可见窗口切片（App 按「帧底对齐 + 顶部裁剪」算好传入）。 */
  entries: TranscriptEntry[]
  turnState: 'idle' | 'thinking' | 'working' | 'awaiting-approval'
  expandThinking: boolean
  /** 全会话一条都没有（和「窗口恰好翻空」区分开，只有前者画开场提示）。 */
  empty: boolean
  /**
   * 挂在会话流最顶上的头部（启动欢迎页）：随内容一起从顶上滚走（对齐 codex 的
   * session header / dsh 的 LogoHeader——不独占屏幕，也不永久占位）。
   */
  header?: ReactNode
  /** 用户消息图片行的点击预览回调（省略 = 图片行不可点）。 */
  onPreviewImages?: (images: string[]) => void
  /** 子代理卡点击回调（省略 = 卡片不可点）：打开队友的只读转录浮层。 */
  onOpenAgent?: (file: string) => void
  registerClick?: RegisterClick
}): JSX.Element {
  const tail = entries
  // 直播尾（负 id）与最后定稿 text 条目才带光标闪烁位。
  const lastId = tail[tail.length - 1]?.id
  return (
    <Box flexDirection="column" flexShrink={0} gap={GAP.tight}>
      {header}
      {tail.map((entry) => (
        <Entry
          key={entry.id}
          entry={entry}
          streaming={
            entry.id === lastId &&
            entry.id < 0 &&
            (turnState === 'thinking' || turnState === 'working')
          }
          expandThinking={expandThinking}
          onPreviewImages={onPreviewImages}
          onOpenAgent={onOpenAgent}
          registerClick={registerClick}
        />
      ))}
      {empty ? (
        <Box marginLeft={INDENT.detail}>
          <Text {...TEXT.secondary}>输入消息开始对话；/help 查看命令，Esc 打断回合，Ctrl+O 回看全文。</Text>
        </Box>
      ) : null}
    </Box>
  )
}
