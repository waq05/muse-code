/**
 * 技能选择浮层（/skills 无参数打开，对齐 dsh 的 SkillsPicker）：只读清单 +
 * 回填输入行。数据来自 runtime.listSkills() 的技能投影；行 = /名字 — 描述，
 * 带来源与「已停用 / 不进目录」标记；输入即筛选，Enter 把 `/技能名 ` 灌回输入行
 * （只能回填 userInvocable 的技能——它们才注册成了真命令），Esc 关闭。
 * 启停管理在桌面端「技能」页，这里不提供。键盘与鼠标路由在 App 顶层，纯展示。
 *
 * @module dsc-tui/app/SkillsPicker
 */
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import type { SkillInfoView } from '../contract.js'
import { ACCENT, BORDER, GAP, MARK, PAD, SEP, STATUS_COLOR, TEXT } from './theme.js'

export function SkillsPicker({
  skills,
  index,
  query,
}: {
  skills: SkillInfoView[]
  index: number
  query: string
}): JSX.Element {
  const safeIndex = Math.min(index, Math.max(0, skills.length - 1))
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
        技能（{skills.length} 个）
        <Text {...TEXT.secondary}>{SEP.gap}点击选中、再点回填 · Enter 把 /技能名 灌回输入行 · 启停在桌面端技能中心</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text {...TEXT.label} color={ACCENT}>
          筛选{' '}
        </Text>
        <Text {...(query === '' ? TEXT.secondary : TEXT.body)}>
          {query === '' ? '（直接输入按名字/描述/来源过滤）' : query}
          <Text {...TEXT.secondary}>▏</Text>
        </Text>
      </Text>
      {skills.length === 0 ? <Text {...TEXT.secondary}>（没有匹配的技能）</Text> : null}
      {skills.map((skill, position) => {
        const selected = position === safeIndex
        return (
          <Text key={skill.name} color={selected ? ACCENT : undefined} wrap="truncate-end">
            {selected ? MARK.selected : MARK.idle}
            /{skill.name}
            {!skill.userInvocable ? <Text {...TEXT.secondary}>{SEP.gap}不进目录</Text> : null}
            {!skill.enabled ? (
              <Text {...TEXT.label} color={STATUS_COLOR.waiting}>{SEP.gap}已停用</Text>
            ) : null}
            <Text {...TEXT.secondary}>{SEP.gap}{skill.source}</Text>
            <Text {...TEXT.secondary}>{SEP.gap}{skill.description}</Text>
            {skill.problem !== undefined ? (
              <Text {...TEXT.label} color={STATUS_COLOR.failed}>{SEP.gap}注意：{skill.problem}</Text>
            ) : null}
          </Text>
        )
      })}
      <Text {...TEXT.secondary} wrap="truncate-end">
        ↑↓ 选择 · Enter 回填 · Esc 关闭 · 停用的技能要先在桌面端技能中心启用才会被加载
      </Text>
      </Box>
    </Box>
  )
}
