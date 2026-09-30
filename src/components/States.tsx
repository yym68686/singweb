import type { ReactNode } from 'react'
import { CircleAlert, LoaderCircle, RotateCcw, type LucideIcon } from 'lucide-react'
import { errorMessage } from '../api/errors'
import { keepNames } from '../lib/keepNames'
import { Button } from './Button'
import s from './States.module.css'

export function LoadingState({ label = '正在加载' }: { label?: string }) {
  return (
    <div className={s.loading} role="status">
      <LoaderCircle className={s.spin} aria-hidden />
      {label}
    </div>
  )
}

export function ErrorState({ error, onRetry, title = '没能加载数据' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className={s.error} role="alert">
      <CircleAlert className={s.errorIcon} aria-hidden />
      <div className={s.errorText}>
        <p className={s.errorTitle}>{title}</p>
        <p>{errorMessage(error)}</p>
        {onRetry && (
          <Button size="sm" icon={RotateCcw} onClick={onRetry}>
            重试
          </Button>
        )}
      </div>
    </div>
  )
}

interface EmptyProps {
  icon?: LucideIcon
  title: string
  children?: ReactNode
  action?: ReactNode
}

/** 空列表：说明为什么是空的，以及下一步做什么 */
export function EmptyState({ icon: Icon, title, children, action }: EmptyProps) {
  return (
    <div className={s.empty}>
      {Icon && <Icon className={s.emptyIcon} aria-hidden />}
      <p className={s.emptyTitle}>{keepNames(title)}</p>
      {children && <div className={s.emptyBody}>{keepNames(children)}</div>}
      {action}
    </div>
  )
}

interface LoadableProps<T> {
  data: T | undefined
  error: unknown
  retry?: () => void
  children: (data: T) => ReactNode
}

/** 数据还没到时显示加载中，出错时显示原因，否则渲染内容 */
export function Loadable<T>({ data, error, retry, children }: LoadableProps<T>) {
  if (data !== undefined) return <>{children(data)}</>
  if (error) return <ErrorState error={error} onRetry={retry} />
  return <LoadingState />
}
