import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { ChevronLeft } from 'lucide-react'
import { useTitle } from '../lib/useTitle'
import { keepNames } from '../lib/keepNames'
import s from './PageHeader.module.css'

interface PageHeaderProps {
  title: ReactNode
  /** 浏览器标签页标题；不填时用 title（需为字符串） */
  docTitle?: string
  description?: ReactNode
  actions?: ReactNode
  back?: { to: string; label: string }
}

export function PageHeader({ title, docTitle, description, actions, back }: PageHeaderProps) {
  useTitle(docTitle ?? (typeof title === 'string' ? title : undefined))
  return (
    <header className={s.header}>
      {back && (
        <Link to={back.to} className={s.back}>
          <ChevronLeft aria-hidden />
          {back.label}
        </Link>
      )}
      <div className={s.row}>
        <div className={s.text}>
          <h1 className={s.title}>{title}</h1>
          {description && <div className={s.desc}>{keepNames(description)}</div>}
        </div>
        {actions && <div className={s.actions}>{actions}</div>}
      </div>
    </header>
  )
}

interface SectionProps {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}

/** 页面里的一个区块：二级标题、说明和右侧操作 */
export function Section({ title, description, actions, children, className, id }: SectionProps) {
  return (
    <section id={id} className={className} aria-labelledby={id ? `${id}-title` : undefined}>
      <div className={s.sectionHead}>
        <div className={s.text}>
          <h2 id={id ? `${id}-title` : undefined} className={s.sectionTitle}>
            {title}
          </h2>
          {description && <div className={s.sectionDesc}>{keepNames(description)}</div>}
        </div>
        {actions && <div className={s.actions}>{actions}</div>}
      </div>
      {children}
    </section>
  )
}
