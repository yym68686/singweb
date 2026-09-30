import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../lib/cx'
import { keepNames } from '../lib/keepNames'
import s from './Tooltip.module.css'

export interface Anchor {
  left: number
  top: number
  width: number
  height: number
}

interface FloatingTipProps {
  anchor: Anchor
  id?: string
  children: ReactNode
}

/** 浮在页面最上层的提示框，优先显示在锚点上方，放不下时显示在下方 */
export function FloatingTip({ anchor, id, children }: FloatingTipProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = anchor.left + anchor.width / 2 - w / 2
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin))
    let top = anchor.top - h - 8
    if (top < margin) top = anchor.top + anchor.height + 8
    setPos({ left, top })
  }, [anchor.left, anchor.top, anchor.width, anchor.height])

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={s.tip}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** 滚动或按 Esc 时关闭浮层 */
export function useDismiss(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])
}

interface TooltipProps {
  content: ReactNode
  children: ReactNode
  /** 内容本身不可聚焦时，让它可以用 Tab 聚焦以便键盘用户查看提示 */
  focusable?: boolean
  className?: string
}

/** 悬停或聚焦时显示的提示；提示内容只做补充，关键信息要在页面上直接可见 */
export function Tooltip({ content, children, focusable, className }: TooltipProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const id = useId()
  const [close] = useState(() => () => setAnchor(null))
  useDismiss(!!anchor, close)

  const open = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setAnchor({ left: r.left, top: r.top, width: r.width, height: r.height })
  }

  return (
    <span
      ref={ref}
      className={cx(s.trigger, focusable && s.focusable, className)}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={anchor ? id : undefined}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      {children}
      {anchor && (
        <FloatingTip anchor={anchor} id={id}>
          {keepNames(content)}
        </FloatingTip>
      )}
    </span>
  )
}
