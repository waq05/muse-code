/**
 * 启动欢迎块（0.6.58 对齐 dsh-TUI LogoV2 的规格）：「MUSE CODE」两行 5 行点阵大字
 * （行色按 品牌蓝→冰蓝→浅冰 渐变）+ `✦ Muse Code vX` 词标 + model/cwd/tips 信息行 +
 * tagline，**挂在会话流最顶上、随内容从顶上自然滚走**（codex session header /
 * dsh LogoHeader 同构），不是独立路由。
 *
 * 阶梯降级（对齐 dsh splashLayout）：终端行数 ≥ 30 且列数 ≥ 40 → 全块；行数 ≥ 12 →
 * 只留词标+信息行；其余一行式。resume 长会话（条目 ≥ 30）直接不画——再画只是把
 * 历史往下顶。纯展示，信息行的暗淡档让位给正文。
 *
 * @module dsc-tui/app/Welcome
 */
import { Box, Text, useStdout } from 'ink'
import type { JSX } from 'react'
import { DSC_VERSION } from '../core/version.js'
import { GAP, PALETTE, TEXT } from './theme.js'

/** 5 行 × 5 列点阵字形（方块字，参照 dsh splashFonts 的 bold 款）。 */
const GLYPHS: Record<string, string[]> = {
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  U: ['█   █', '█   █', '█   █', '█   █', '▀▀▀▀▀'],
  S: ['▀▀▀▀█', '█    ', '▀▀▀▀ ', '    █', '▀▀▀▀▀'],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  C: ['█████', '█    ', '█    ', '█    ', '█████'],
  O: ['█████', '█   █', '█   █', '█   █', '█████'],
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  ' ': ['   ', '   ', '   ', '   ', '   '],
}

/** 一个词的 5 行点阵（字形间 1 列空隙）。 */
const wordRows = (word: string): string[] => {
  const rows = ['', '', '', '', '']
  for (const char of word) {
    const glyph = GLYPHS[char] ?? GLYPHS[' ']
    for (let r = 0; r < 5; r += 1) rows[r] += `${glyph[r]} `
  }
  return rows.map((row) => row.trimEnd())
}

/** hex → rgb → 线性插值 → hex（大字的行渐变）。 */
const lerpColor = (from: string, to: string, t: number): string => {
  const channel = (text: string, offset: number): number =>
    Number.parseInt(text.slice(offset, offset + 2), 16)
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * t)
  const r = mix(channel(from, 1), channel(to, 1))
  const g = mix(channel(from, 3), channel(to, 3))
  const b = mix(channel(from, 5), channel(to, 5))
  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`
}

/** 一行点阵按渐变色渲染。 */
function BigWord({ rows, from, to }: { rows: string[]; from: string; to: string }): JSX.Element {
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <Text key={index} bold color={lerpColor(from, to, index / 4)}>
          {row}
        </Text>
      ))}
    </Box>
  )
}

/** cwd 尾部显示：太长时只留最后两段（与 StatusBar 同一规则）。 */
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
  const { stdout } = useStdout()
  const columns = stdout?.columns ?? 100
  const rows = stdout?.rows ?? 24
  const info = (
    <>
      <Text {...TEXT.secondary} wrap="truncate-end">
        {cwd !== undefined && cwd !== '' ? `${shortCwd(cwd)} · ` : ''}模型 {model} · effort {effort}
      </Text>
      <Text {...TEXT.secondary} wrap="truncate-end">
        /help 看命令 · 双击 Esc 撤回上一轮 · Ctrl+O 回看全文 · Ctrl+T 展开思考 · Ctrl+V 贴图
      </Text>
      <Text {...TEXT.secondary} wrap="truncate-end">
        有活直接说；@ 提文件，/ 或 @ 唤出补全，Shift+Enter 换行。
      </Text>
    </>
  )
  // 阶梯降级：矮终端/窄终端退到词标版（块体 ~17 行要 ≥30 行才放得下）
  if (rows >= 30 && columns >= 40) {
    return (
      <Box flexDirection="column" gap={GAP.none} marginBottom={GAP.tight}>
        <Text>
          <Text color={PALETTE.accent}>✦ </Text>
          <Text bold>Muse Code</Text>
          <Text {...TEXT.secondary}> v{DSC_VERSION}</Text>
        </Text>
        <BigWord rows={wordRows('MUSE')} from={PALETTE.brand} to={PALETTE.ice} />
        <Text> </Text>
        <BigWord rows={wordRows('CODE')} from={PALETTE.ice} to={PALETTE.pale} />
        <Text color={PALETTE.accent}>✦ 把想法变成代码</Text>
        {info}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" gap={GAP.none} marginBottom={GAP.tight}>
      <Text>
        <Text color={PALETTE.accent}>✦ </Text>
        <Text bold>Muse Code</Text>
        <Text {...TEXT.secondary}> v{DSC_VERSION}</Text>
      </Text>
      {info}
    </Box>
  )
}
