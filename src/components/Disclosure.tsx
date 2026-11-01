import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cx } from '../lib/cx'
import s from './Disclosure.module.css'

interface DisclosureProps {
  title: ReactNode
  meta?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  id?: string
  className?: string
  labelledBy?: string
  headingLevel?: 2 | 3 | 4
  labelClassName?: string
  lazy?: boolean
}

export function Disclosure({ title, meta, children, defaultOpen = false, id, className, labelledBy, headingLevel, labelClassName, lazy = false }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [activated, setActivated] = useState(defaultOpen)
  useEffect(() => {
    if (defaultOpen) {
      setOpen(true)
      setActivated(true)
    }
  }, [defaultOpen])
  return (
    <details id={id} aria-labelledby={labelledBy} open={open} onToggle={(e) => {
      setOpen(e.currentTarget.open)
      if (e.currentTarget.open) setActivated(true)
    }} className={cx(s.disclosure, className)}>
      <summary className={s.summary}>
        <ChevronRight className={s.chevron} aria-hidden />
        <span id={labelledBy} role={headingLevel ? 'heading' : undefined} aria-level={headingLevel} className={cx(s.label, labelClassName)}>{title}</span>
        {meta && <span className={s.meta}>{meta}</span>}
      </summary>
      <div className={s.content}>{(!lazy || activated) && children}</div>
    </details>
  )
}

export function revealElement(el: Element | null | undefined) {
  for (let parent = el?.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true
  }
}
