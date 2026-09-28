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
