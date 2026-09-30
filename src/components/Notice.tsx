import type { ReactNode } from 'react'
import { CircleAlert, Info, OctagonAlert, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react'
import { cx } from '../lib/cx'
import { keepNames } from '../lib/keepNames'
import s from './Notice.module.css'

type NoticeTone = 'info' | 'warn' | 'crit' | 'offline'

const icons: Record<NoticeTone, LucideIcon> = {
  info: Info,
  warn: TriangleAlert,
  crit: OctagonAlert,
  offline: WifiOff,
}

interface NoticeProps {
  tone?: NoticeTone
  icon?: LucideIcon
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
}

/** 页面里的一段说明或提醒 */
export function Notice({ tone = 'info', icon, title, children, action, className }: NoticeProps) {
  const Icon = icon ?? icons[tone] ?? CircleAlert
  return (
    <div className={cx(s.notice, s[tone], className)}>
      <Icon className={s.icon} aria-hidden />
      <div className={s.body}>
        {title && <p className={s.title}>{keepNames(title)}</p>}
        {children && <div className={s.text}>{keepNames(children)}</div>}
      </div>
      {action && <div className={s.action}>{action}</div>}
    </div>
  )
}
