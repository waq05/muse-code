import type { ReactNode } from 'react'

/** 顶部导航条：返回键 + 两级标题 + 右侧动作。阶梯式导航的「一阶」。 */
export interface TopBarProps {
  title: string
  subtitle?: string
  onBack?: () => void
  right?: ReactNode
}

export function TopBar({ title, subtitle, onBack, right }: TopBarProps): ReactNode {
  return (
    <header className="topbar">
      {onBack !== undefined ? (
        <button type="button" className="topbar-back" onClick={onBack} aria-label="返回">
          ‹
        </button>
      ) : (
        <span className="topbar-back is-placeholder" aria-hidden="true" />
      )}
      <div className="topbar-title">
        <span className="topbar-title-main">{title}</span>
        {subtitle !== undefined && subtitle !== '' ? (
          <span className="topbar-title-sub">{subtitle}</span>
        ) : null}
      </div>
      <div className="topbar-right">{right}</div>
    </header>
  )
}
