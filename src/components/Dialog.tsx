import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from './Button'
import { cx } from '../lib/cx'
import { keepNames } from '../lib/keepNames'
import s from './Dialog.module.css'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  wide?: boolean
}

/**
 * 基于原生 <dialog> 的模态框：Esc 和点击遮罩都会关闭。
 * 打开时焦点落在第一个可以聚焦的元素上（通常是关闭按钮）；
 * 内容里有 data-autofocus 的元素时改为落在它上面，比如表单的第一个输入框
 */
export function Dialog({ open, onClose, title, description, children, footer, wide }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descId = useId()

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    }
    if (!open && d.open) d.close()
  }, [open])

  // 调用方直接卸载对话框时，也在节点移除前正常关闭它，浏览器才会把焦点还给打开它的按钮
  useLayoutEffect(() => {
    const d = ref.current
    return () => {
      if (d?.open) d.close()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className={cx(s.dialog, wide && s.wide)}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {open && (
        <div className={s.inner}>
          <header className={s.header}>
            <h2 id={titleId} className={s.title}>
              {keepNames(title)}
            </h2>
            <Button variant="ghost" size="sm" icon={X} aria-label="关闭" onClick={onClose} />
          </header>
          {description && (
            <div id={descId} className={s.description}>
              {keepNames(description)}
            </div>
          )}
          {children && <div className={s.body}>{keepNames(children)}</div>}
          {footer && <footer className={s.footer}>{footer}</footer>}
        </div>
      )}
    </dialog>
  )
}

interface ConfirmProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  pending?: boolean
  danger?: boolean
  error?: string | null
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  onConfirm,
  pending,
  danger,
  error,
}: ConfirmProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={children}
      footer={
        <>
          {error && (
            <p className={s.error} role="alert">
              {error}
            </p>
          )}
          <Button onClick={onClose}>取消</Button>
          <Button variant={danger ? 'danger' : 'primary'} pending={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  )
}
