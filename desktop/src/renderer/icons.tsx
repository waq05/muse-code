/**
 * 线性 SVG 图标集（stroke 1.6 / currentColor），对照 dsh 桌面端的细线风格。
 * 全部为纯函数组件，尺寸由 CSS 或 size 属性控制。
 *
 * @module desktop/renderer/icons
 */
import type { JSX } from 'react'

type IconProps = { size?: number; className?: string }

function base(path: JSX.Element, { size = 16, className }: IconProps, viewBox = '0 0 24 24'): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {path}
    </svg>
  )
}

export function IconPlus(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>,
    props,
  )
}

export function IconFolder(props: IconProps): JSX.Element {
  return base(
    <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2c.4 0 .8.16 1.06.44L11.5 6.7h7A1.5 1.5 0 0 1 20 8.2v9.3a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z" />,
    props,
  )
}

export function IconFolderOpen(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M4 9V6.5A1.5 1.5 0 0 1 5.5 5h3.7c.4 0 .78.16 1.06.44L11.5 6.7h7A1.5 1.5 0 0 1 20 8.2V9" />
      <path d="M2.8 12.6 4.4 8.4A1.2 1.2 0 0 1 5.5 7.6h13a1.2 1.2 0 0 1 1.13 1.55l-1.7 6.1a1.5 1.5 0 0 1-1.44 1.1H4.2a1.5 1.5 0 0 1-1.4-2.05Z" />
    </>,
    props,
  )
}

export function IconSearch(props: IconProps): JSX.Element {
  return base(
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-3.8-3.8" />
    </>,
    props,
  )
}

export function IconChevronDown(props: IconProps): JSX.Element {
  return base(<path d="m6 9.5 6 6 6-6" />, props)
}

export function IconChevronRight(props: IconProps): JSX.Element {
  return base(<path d="m9.5 6 6 6-6 6" />, props)
}

export function IconArrowUp(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </>,
    props,
  )
}

export function IconStop(props: IconProps): JSX.Element {
  return base(<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />, props)
}

export function IconCopy(props: IconProps): JSX.Element {
  return base(
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </>,
    props,
  )
}

export function IconSwap(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M7 4v13" />
      <path d="m3.5 7.5 3.5-3.5 3.5 3.5" />
      <path d="M17 20V7" />
      <path d="m13.5 16.5 3.5 3.5 3.5-3.5" />
    </>,
    props,
  )
}

export function IconSidebar(props: IconProps): JSX.Element {
  return base(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </>,
    props,
  )
}

export function IconClock(props: IconProps): JSX.Element {
  return base(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>,
    props,
  )
}

export function IconShield(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M12 3.5 5 6.2v5.1c0 4.4 3 7.6 7 9.2 4-1.6 7-4.8 7-9.2V6.2Z" />
      <path d="m9 11.8 2.2 2.2L15.5 9.5" />
    </>,
    props,
  )
}

export function IconFlag(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M6 21V4" />
      <path d="M6 4.8h9.4l-1.7 3.6 1.7 3.6H6" />
    </>,
    props,
  )
}

export function IconPuzzle(props: IconProps): JSX.Element {
  return base(
    <path d="M10 3.5a2 2 0 0 1 4 0c0 .4-.12.8-.32 1.1h3.82c.55 0 1 .45 1 1v3.1a2 2 0 1 0 0 3.6v3.1c0 .55-.45 1-1 1h-3.32c.2.3.32.7.32 1.1a2 2 0 0 1-4 0c0-.4.12-.8.32-1.1H7a1 1 0 0 1-1-1v-3.1a2 2 0 1 1 0-3.6V5.6c0-.55.45-1 1-1h3.32A1.99 1.99 0 0 1 10 3.5Z" />,
    props,
  )
}

export function IconRefresh(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 3.5v4h-4" />
    </>,
    props,
  )
}

export function IconRestart(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M12 3v8" />
      <path d="M6.4 6.9a8 8 0 1 0 11.2 0" />
    </>,
    props,
  )
}

export function IconCheck(props: IconProps): JSX.Element {
  return base(<path d="m5 12.5 4.5 4.5L19 7.5" />, props)
}

export function IconCoins(props: IconProps): JSX.Element {
  return base(
    <>
      <ellipse cx="12" cy="6.5" rx="7" ry="3" />
      <path d="M5 6.5v5c0 1.66 3.13 3 7 3s7-1.34 7-3v-5" />
      <path d="M5 11.5v5c0 1.66 3.13 3 7 3s7-1.34 7-3v-5" />
    </>,
    props,
  )
}

export function IconGear(props: IconProps): JSX.Element {
  return base(
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.4M12 18.8v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7" />
    </>,
    props,
  )
}

export function IconSpark(props: IconProps): JSX.Element {
  return base(<path d="M12 2.8 14.2 9l6.2 2.2-6.2 2.2L12 19.6 9.8 13.4 3.6 11.2 9.8 9Z" />, props)
}

export function IconBolt(props: IconProps): JSX.Element {
  return base(<path d="M13.2 2.8 5.4 13.4h5l-1.2 7.8 7.8-10.6h-5Z" />, props)
}

export function IconInfo(props: IconProps): JSX.Element {
  return base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.9" r="0.9" fill="currentColor" stroke="none" />
    </>,
    props,
  )
}

export function IconStore(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M4 9.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9.5" />
      <path d="M3.2 9.5 5 4.2h14l1.8 5.3a3 3 0 0 1-5.6 1.6 3 3 0 0 1-5.4 0 3 3 0 0 1-5.6-1.6Z" />
      <path d="M9.6 20v-4.6h4.8V20" />
    </>,
    props,
  )
}

export function IconClose(props: IconProps): JSX.Element {
  return base(<path d="M6 6l12 12M18 6 6 18" />, props)
}

export function IconTrash(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M4.5 6.8h15" />
      <path d="M9.5 6.8V4.6h5v2.2" />
      <path d="M6.6 6.8 7.5 20a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l.9-13.2" />
      <path d="M10.4 10.5v6.4M13.6 10.5v6.4" />
    </>,
    props,
  )
}

export function IconEdit(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10Z" />
      <path d="M13.5 6.5l3 3" />
    </>,
    props,
  )
}

export function IconKey(props: IconProps): JSX.Element {
  return base(
    <>
      <circle cx="8.2" cy="12" r="3.4" />
      <path d="M11.6 12H20" />
      <path d="M17 12v3M14.3 12v2.2" />
    </>,
    props,
  )
}

/** 更多操作（水平三点）。 */
export function IconMore(props: IconProps): JSX.Element {
  return base(
    <g fill="currentColor" stroke="none">
      <circle cx="5.5" cy="12" r="1.15" />
      <circle cx="12" cy="12" r="1.15" />
      <circle cx="18.5" cy="12" r="1.15" />
    </g>,
    props,
  )
}

/** 排序（两条滑轨 + 两个把手，对照 dsh 头部那个图标）。 */
export function IconSort(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M4 7.5h8.5" />
      <circle cx="16.2" cy="7.5" r="2" />
      <path d="M20.5 7.5h-.3" />
      <path d="M20 16.5h-8.5" />
      <circle cx="12.2" cy="16.5" r="2" />
      <path d="M4 16.5h4.3" />
    </>,
    props,
  )
}

/** 归档（箱子）。 */
export function IconArchive(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M3.8 4.8h16.4a.8.8 0 0 1 .8.8v2.4H3v-2.4a.8.8 0 0 1 .8-.8Z" />
      <path d="M5 8v9.4a1.6 1.6 0 0 0 1.6 1.6h10.8A1.6 1.6 0 0 0 19 17.4V8" />
      <path d="M9.8 11.6h4.4" />
    </>,
    props,
  )
}

/** 置顶（图钉）。 */
export function IconPin(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M14.2 3.6 20.4 9.8" />
      <path d="M16.4 5.6 12 11.4l-5.6 2.4 3.8 3.8 2.4-5.6 5.8-4.4Z" />
      <path d="M9.6 17.4 6.4 20.6" />
    </>,
    props,
  )
}

/** 拖动手柄（两列三点，用于可拖动的工作区行）。 */
export function IconGrip(props: IconProps): JSX.Element {
  return base(
    <g fill="currentColor" stroke="none">
      <circle cx="9.5" cy="6.5" r="1.05" />
      <circle cx="9.5" cy="12" r="1.05" />
      <circle cx="9.5" cy="17.5" r="1.05" />
      <circle cx="14.5" cy="6.5" r="1.05" />
      <circle cx="14.5" cy="12" r="1.05" />
      <circle cx="14.5" cy="17.5" r="1.05" />
    </g>,
    props,
  )
}

/** 终端（方框 + 提示符）。 */
export function IconTerminal(props: IconProps): JSX.Element {
  return base(
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="m7 9.5 3 2.5-3 2.5" />
      <path d="M12.5 15H17" />
    </>,
    props,
  )
}

/** 代码（尖括号对，VS Code 打开目录菜单用）。 */
export function IconCode(props: IconProps): JSX.Element {
  return base(<path d="m9 8-4 4 4 4M15 8l4 4-4 4" />, props)
}

/** 用量统计（柱状图）。 */
export function IconChart(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M4 20h16" />
      <path d="M7.5 20v-6" />
      <path d="M12 20V7.5" />
      <path d="M16.5 20v-9" />
    </>,
    props,
  )
}

/** 工作区树（层级线 + 两个节点框）：视图选项里的「按工作区树」。 */
export function IconTree(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M4.2 4.5v14" />
      <path d="M4.2 8h4.3" />
      <path d="M4.2 15h4.3" />
      <rect x="8.5" y="5.6" width="11.3" height="4.8" rx="1.4" />
      <rect x="8.5" y="12.6" width="11.3" height="4.8" rx="1.4" />
    </>,
    props,
  )
}

/** 单列表（三条等长横线）：视图选项里的「单列表」与「全部对话」。 */
export function IconFlatList(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </>,
    props,
  )
}

/** 创建时间（日历）。 */
export function IconCalendar(props: IconProps): JSX.Element {
  return base(
    <>
      <rect x="3.8" y="5.4" width="16.4" height="14.2" rx="2" />
      <path d="M3.8 9.8h16.4" />
      <path d="M8.4 3.6v3.4M15.6 3.6v3.4" />
    </>,
    props,
  )
}

/** 隐藏已归档（归档箱划掉）。 */
export function IconArchiveOff(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M3.8 4.8h16.4a.8.8 0 0 1 .8.8v2.4H3v-2.4a.8.8 0 0 1 .8-.8Z" />
      <path d="M5 8v9.4a1.6 1.6 0 0 0 1.6 1.6h10.8A1.6 1.6 0 0 0 19 17.4V8" />
      <path d="M4 3.6 20 19.6" />
    </>,
    props,
  )
}

/** 展开成完整清单（列表 + 向下箭头）：筛选会话里的「全部对话」。 */
export function IconQueue(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M4 6.5h9.5M4 12h9.5M4 17.5h6" />
      <path d="M17.5 6.5v11" />
      <path d="m14.6 14.8 2.9 2.9 2.9-2.9" />
    </>,
    props,
  )
}

/** 轮次（圆环 + 中心点）：状态栏第一段「N 轮 M 步」。 */
export function IconActivity(props: IconProps): JSX.Element {
  return base(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3" />
    </>,
    props,
  )
}

/** 累计用量（数据库柱体）：状态栏第二段「N tok」。 */
export function IconDatabase(props: IconProps): JSX.Element {
  return base(
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6" />
      <path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
    </>,
    props,
  )
}

/** 赞（拇指向上）：消息底部的本机评价。 */
export function IconThumbUp(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M7 10.5 10.8 3.6a2 2 0 0 1 2.7 2.5L12.6 9.6h4.9a1.8 1.8 0 0 1 1.74 2.28l-1.3 5.2A2 2 0 0 1 16 18.6H7" />
      <rect x="3.4" y="10.5" width="3.6" height="8.1" rx="1" />
    </>,
    props,
  )
}

/** 踩（拇指向下）：同一对评价的否定那半。 */
export function IconThumbDown(props: IconProps): JSX.Element {
  return base(
    <>
      <path d="M17 13.5 13.2 20.4a2 2 0 0 1-2.7-2.5l.9-3.5H6.5a1.8 1.8 0 0 1-1.74-2.28l1.3-5.2A2 2 0 0 1 8 5.4h9" />
      <rect x="17" y="5.4" width="3.6" height="8.1" rx="1" />
    </>,
    props,
  )
}
