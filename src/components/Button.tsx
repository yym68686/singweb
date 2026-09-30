import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Link, type LinkProps } from 'react-router'
import { LoaderCircle, type LucideIcon } from 'lucide-react'
import { cx } from '../lib/cx'
import s from './Button.module.css'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'md' | 'sm'

interface Common {
  variant?: Variant
  size?: Size
  icon?: LucideIcon
  children?: ReactNode
}

interface ButtonProps extends Common, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** 操作进行中：显示转圈，点击无效 */
  pending?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  pending,
  children,
  className,
  type = 'button',
  onClick,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(s.btn, s[variant], s[size], !children && s.iconOnly, className)}
      // 进行中不设 disabled：按钮被禁用时浏览器会把焦点移走，键盘用户就回不到原来的位置了。
      // 取消点击的默认行为，提交按钮也不会再提交一次表单（包括在输入框里按回车）
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      onClick={pending ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {pending ? <LoaderCircle className={s.spin} /> : Icon ? <Icon /> : null}
      {children}
    </button>
  )
}

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  children,
  className,
  ...rest
}: Common & Omit<LinkProps, 'children'>) {
  return (
    <Link className={cx(s.btn, s[variant], s[size], !children && s.iconOnly, className)} {...rest}>
      {Icon ? <Icon /> : null}
      {children}
    </Link>
  )
}
