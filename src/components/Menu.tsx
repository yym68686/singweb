import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, type LucideIcon } from 'lucide-react'
import { Button } from './Button'
import { cx } from '../lib/cx'
import { keepNames } from '../lib/keepNames'
import s from './Menu.module.css'

export interface MenuItem<T extends string> {
  value: T
  label: ReactNode
  description?: ReactNode
  icon?: LucideIcon
}

interface MenuProps<T extends string> {
  /** 按钮上的文字 */
  label: ReactNode
  icon?: LucideIcon
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'md' | 'sm'
  items: MenuItem<T>[]
  onSelect: (value: T) => void
  /** 菜单和按钮的哪一边对齐；按钮靠右时用 end，菜单才不会超出屏幕 */
  align?: 'start' | 'end'
  className?: string
}

/**
 * 菜单按钮：点开后列出几项操作。
 * 方向键、Home、End 在各项之间移动；Esc 关闭并回到按钮；点菜单外面或按 Tab 离开时关闭
 */
export function Menu<T extends string>({
  label,
  icon,
  variant = 'secondary',
  size = 'md',
  items,
  onSelect,
  align = 'start',
  className,
}: MenuProps<T>) {
  const id = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 打开时要聚焦的一项：0 是第一项，-1 是最后一项
  const [open, setOpen] = useState<{ focus: number } | null>(null)

  const itemEls = () => [...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]

  useEffect(() => {
    if (!open) return
    const els = itemEls()
    els.at(open.focus)?.focus()
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const close = (refocus: boolean) => {
    setOpen(null)
    if (refocus) buttonRef.current?.focus()
  }

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen({ focus: e.key === 'ArrowDown' ? 0 : -1 })
    }
  }

  const onMenuKey = (e: KeyboardEvent) => {
    const els = itemEls()
    const i = els.indexOf(document.activeElement as HTMLElement)
    const move = (to: number) => {
      e.preventDefault()
      els[(to + els.length) % els.length]?.focus()
    }
    switch (e.key) {
      case 'ArrowDown':
        return move(i + 1)
      case 'ArrowUp':
        return move(i < 0 ? -1 : i - 1)
      case 'Home':
        return move(0)
      case 'End':
        return move(-1)
      case 'Escape':
        e.preventDefault()
        // 菜单在对话框里时，不要让 Esc 连对话框一起关掉
        e.stopPropagation()
        return close(true)
      case 'Tab':
        return close(false)
    }
  }

  const pick = (value: T) => {
    // 先把焦点还给按钮：选项打开的对话框关闭后，焦点会回到这里
    close(true)
    onSelect(value)
  }

  return (
    <div ref={wrapRef} className={cx(s.wrap, className)}>
      <Button
        ref={buttonRef}
        variant={variant}
        size={size}
        icon={icon}
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => (open ? close(false) : setOpen({ focus: 0 }))}
        onKeyDown={onButtonKey}
      >
        {label}
        <ChevronDown className={cx(s.chevron, open && s.up)} aria-hidden />
      </Button>
      {open && (
        <div
          ref={listRef}
          id={`${id}-menu`}
          role="menu"
          className={cx(s.menu, align === 'end' && s.end)}
          onKeyDown={onMenuKey}
        >
          {items.map((it) => (
            <button
              key={it.value}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={s.item}
              onClick={() => pick(it.value)}
            >
              {it.icon && <it.icon className={s.icon} aria-hidden />}
              <span className={s.text}>
                <span className={s.label}>{it.label}</span>
                {it.description && <span className={s.desc}>{keepNames(it.description)}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
