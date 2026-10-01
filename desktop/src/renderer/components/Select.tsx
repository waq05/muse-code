/**
 * 自绘下拉选择（Select），替换原生 `<select>`。
 *
 * 为什么不用原生控件：`<select>` 的选项弹层由 Chromium 原生绘制，页面 CSS 够不着；
 * 主进程的 nativeTheme.themeSource（0.6.15 接的）在 Windows 上管不到这个弹层，
 * 深色主题里弹层照样白底黑字（0.6.21 打包件实测）。把弹层画成 DOM 后，
 * 底色/描边/高亮全走 --dsc-* 令牌，深浅主题自动跟随。
 *
 * 行为对齐 dsh 的 Menu：触发钮显示当前值 + chevron；浮层贴触发钮下缘
 * （下方放不下翻到上缘），宽度不小于触发钮；点外/Escape 关；键盘
 * ↑↓/Home/End 移动、Enter 选中——焦点始终留在触发钮上（combobox 模式，
 * aria-activedescendant 指向候选项），不开浮层就不抢焦点。
 *
 * @module desktop/renderer/components/Select
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconChevronDown } from '../icons.js'

/** 一个候选项：值 + 展示文字。 */
export interface SelectOption<T extends string> {
  value: T
  label: string
}

/** 浮层离触发钮的间隙。 */
const POP_GAP = 4
/** 浮层最高高度：超出就内部滚动（默认模型列表可能有几十项）。 */
const POP_MAX_HEIGHT = 320

export function Select<T extends string>(props: {
  value: T
  options: readonly SelectOption<T>[]
  onPick(value: T): void
  /** 触发钮的语境类（设置页 .setting-select、终端 .term-select 由调用方给）。 */
  className?: string
  disabled?: boolean
  ariaLabel?: string
}): JSX.Element {
  const { value, options, onPick, className, disabled = false, ariaLabel } = props
  const [open, setOpen] = useState(false)
  /** 键盘高亮的候选项；打开时落在当前选中值上。 */
  const [active, setActive] = useState(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  /** 浮层坐标与测量宽度：打开后一帧内量好再上屏，避免先画错位置闪一下。 */
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null)
  const listId = useId()

  const current = options.find((option) => option.value === value)
  const label = current?.label ?? ''

  const close = (refocus = true): void => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }

  const openPop = (): void => {
    if (disabled || options.length === 0) return
    const startIndex = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    )
    setActive(startIndex)
    setOpen(true)
  }

  // 打开后量触发钮与浮层的实际尺寸定坐标：先按默认位置画出来才量得到高度，
  // 量完在浏览器绘制前改坐标（useLayoutEffect），屏幕上看不到中间态。
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null)
      return
    }
    const button = buttonRef.current
    const pop = popRef.current
    if (button === null || pop === null) return
    const rect = button.getBoundingClientRect()
    const height = pop.offsetHeight
    const below = rect.bottom + POP_GAP + height <= window.innerHeight
    const top = below ? rect.bottom + POP_GAP : Math.max(4, rect.top - POP_GAP - height)
    setPlace({ left: rect.left, top, width: rect.width })
    // place 变化不重量：宽度只跟触发钮走，位置只在开合时定一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 点在浮层和触发钮外面就收起；滚轮滚页面时跟着触发钮走会穿帮，直接收。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null
      if (target !== null && (popRef.current?.contains(target) === true || buttonRef.current?.contains(target) === true)) return
      setOpen(false)
    }
    const onWheel = (event: WheelEvent): void => {
      if (popRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('wheel', onWheel, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('wheel', onWheel, true)
    }
  }, [open])

  const pick = (option: SelectOption<T>): void => {
    if (option.value !== value) onPick(option.value)
    close()
  }

  /** 键盘全在触发钮上处理：焦点不进浮层，Tab 序列保持原样。 */
  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openPop()
      }
      return
    }
    const last = options.length - 1
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((index) => Math.min(last, index + 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((index) => Math.max(0, index - 1))
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(last)
        break
      case 'Enter':
        event.preventDefault()
        if (options[active] !== undefined) pick(options[active])
        break
      case 'Escape':
        // 只收浮层，不传给下层（设置面板等）。
        event.stopPropagation()
        close()
        break
      case 'Tab':
        close(false)
        break
    }
  }

  // 键盘移动时把高亮项滚进可视区；scrollIntoView(block:'nearest') 不会抖动页面。
  useEffect(() => {
    if (!open) return
    popRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`select-trigger${className !== undefined ? ` ${className}` : ''}`}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        data-tip={label}
        onClick={() => (open ? close() : openPop())}
        onKeyDown={onButtonKey}
      >
        <span className="select-value">{label}</span>
        <IconChevronDown size={14} className="select-chevron" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={listId}
            className="select-pop"
            role="listbox"
            style={
              place === null
                ? { visibility: 'hidden' }
                : { left: `${place.left}px`, top: `${place.top}px`, minWidth: `${place.width}px` }
            }
          >
            {options.map((option, index) => {
              const selected = option.value === value
              return (
                <button
                  key={option.value}
                  type="button"
                  id={`${listId}-${index}`}
                  role="option"
                  className="select-opt"
                  data-selected={selected || undefined}
                  data-active={index === active || undefined}
                  aria-selected={selected}
                  onPointerEnter={() => setActive(index)}
                  onClick={() => pick(option)}
                >
                  <span className="select-opt-label">{option.label}</span>
                  {selected && <IconCheck size={14} className="select-opt-check" />}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
