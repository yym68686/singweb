import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cx } from '../lib/cx'
import s from './RecordRow.module.css'

/** One record, with a clear action leading to its detail page or dialog. */
export function RecordRow({ title, description, status, actions, icon: Icon, children, className }: {
  title: ReactNode
  description?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  icon?: LucideIcon
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cx(s.row, className)}>
      {Icon && <span className={s.icon}><Icon size={18} aria-hidden /></span>}
      <div className={s.identity}>
        <div className={s.title}>{title}</div>
        {description && <div className={s.description}>{description}</div>}
        {children}
      </div>
      {status && <div className={s.status}>{status}</div>}
      {actions && <div className={s.actions}>{actions}</div>}
    </div>
  )
}
