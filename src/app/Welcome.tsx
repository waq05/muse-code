/**
 * 启动欢迎页（0.6.57）：挂在会话流最顶上的头部块——对齐 codex 的 session header
 * （`>_ OpenAI Codex (vX)` + 工作目录 + 命令提示）与 dsh-TUI 的 LogoHeader：不独占
 * 整屏、不是独立路由，而是聊天内容的第 0 条，内容一多就从顶上自然滚走。
 *
 * 只在短会话（条目 < 30）时挂载——resume 长会话再画头部只是把历史往下顶（dsh 的
 * skipIntro 同款取舍）。纯展示，颜色全部走暗淡档，让位给正文。
 *
 * @module dsc-tui/app/Welcome
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import { DSC_VERSION } from '../core/version.js'
import { GAP, TEXT } from './theme.js'

/** cwd 尾部显示：太长时只留最后两段（与 StatusBar 同一规则，不互相 import 常量）。 */
const shortCwd = (cwd: string): string => {
  const parts = cwd.split(/[\\/]/).filter((part) => part !== '')
  return parts.length <= 2 ? cwd : `…${parts.slice(-2).join('/')}`
}

export function Welcome({
  model,
  effort,
  cwd,
}: {
  model: string
  effort: string
  cwd?: string
}): JSX.Element {
  return (
    <Box flexDirection="column" gap={GAP.none} marginBottom={GAP.tight}>
      <Text bold>
        ◆ Muse Code <Text {...TEXT.secondary}>v{DSC_VERSION}</Text>
      </Text>
      <Text {...TEXT.secondary} wrap="truncate-end">
        {cwd !== undefined && cwd !== '' ? `${shortCwd(cwd)} · ` : ''}模型 {model} · effort {effort}
      </Text>
      <Text {...TEXT.secondary} wrap="truncate-end">
        /help 看命令 · 双击 Esc 撤回上一轮 · Ctrl+O 回看全文 · Ctrl+T 展开思考 · Ctrl+V 贴图
      </Text>
      <Text {...TEXT.secondary} wrap="truncate-end">
        有活直接说；@ 提文件，/ 或 @ 唤出补全，Shift+Enter 换行。
      </Text>
    </Box>
  )
}
