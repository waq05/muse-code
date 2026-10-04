/**
 * 图片预览浮层（0.6.57）：半块真彩字符画居中展示，←→ 在同一批图片里切换，
 * Esc / 点击图片关闭。数据（渲染好的字符画）由 App 现算传入——渲染走 PowerShell
 * 的 System.Drawing（见 image-blocks），本组件纯展示。
 *
 * @module dsc-tui/app/PreviewOverlay
 */
import { useRef } from 'react'
import { Box, Text } from 'ink'
import type { DOMElement } from 'ink'
import type { JSX } from 'react'
import { useClickRegion, type RegisterClick } from './click.js'
import { ACCENT, BORDER, GAP, PAD, STATUS_COLOR, TEXT } from './theme.js'

export function PreviewOverlay({
  title,
  index,
  total,
  block,
  loading,
  error,
  registerClick,
  onClose,
}: {
  title: string
  /** 当前是第几张（0 基）。 */
  index: number
  total: number
  /** 渲染好的半块字符画（多行，无尾随换行）；null = 还在渲染。 */
  block: string | null
  loading: boolean
  error: string | null
  registerClick?: RegisterClick
  onClose: () => void
}): JSX.Element {
  const ref = useRef<DOMElement | null>(null)
  useClickRegion(ref, registerClick, (col, row, top, height) => {
    if (row < top || row >= top + height) return false
    onClose()
    return true
  })
  return (
    <Box
      ref={ref}
      borderStyle="round"
      borderColor={BORDER.active}
      paddingX={PAD.inline}
      flexDirection="column"
      flexGrow={1}
      justifyContent="center"
      alignItems="center"
      gap={GAP.tight}
    >
      <Text {...TEXT.label} color={ACCENT} wrap="truncate-end">
        {title}
        {total > 1 ? `（${index + 1}/${total}）` : ''}
      </Text>
      {loading ? (
        <Text {...TEXT.secondary}>正在渲染预览…</Text>
      ) : error !== null ? (
        <Text {...TEXT.label} color={STATUS_COLOR.failed}>
          预览失败：{error}
        </Text>
      ) : (
        <Box flexDirection="column">
          {(block ?? '').split('\n').map((line, position) => (
            <Text key={position}>{line}</Text>
          ))}
        </Box>
      )}
      <Text {...TEXT.secondary} wrap="truncate-end">
        {total > 1 ? '←→ 切换 · ' : ''}点击图片或 Esc 关闭
      </Text>
    </Box>
  )
}
