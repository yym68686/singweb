import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Link, type LinkProps } from 'react-router'
import { LoaderCircle, type LucideIcon } from 'lucide-react'
import { buttonVariants } from '../vendor/beautiful-ui/Button'
import { cx } from '../lib/cx'

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
      className={cx(
        buttonVariants({ variant: variant === 'ghost' ? 'quiet' : variant === 'danger' ? 'primary' : variant, size }),
        'rounded-[var(--r-control)]',
        variant === 'danger' && 'bg-red text-white hover:brightness-95',
        pending && 'opacity-60 cursor-progress',
        !children && 'size-9 !p-0',
        className,
      )}
      // 进行中不设 disabled：按钮被禁用时浏览器会把焦点移走，键盘用户就回不到原来的位置了。
      // 取消点击的默认行为，提交按钮也不会再提交一次表单（包括在输入框里按回车）
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      onClick={pending ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {pending ? <LoaderCircle className="size-4 animate-spin" /> : Icon ? <Icon className="size-4" /> : null}
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
    <Link
      className={cx(
        buttonVariants({ variant: variant === 'ghost' ? 'quiet' : variant === 'danger' ? 'primary' : variant, size }),
        'rounded-[var(--r-control)]',
        variant === 'danger' && 'bg-red text-white hover:brightness-95',
        !children && 'size-9 !p-0',
        className,
      )}
      {...rest}
    >
      {Icon ? <Icon className="size-4" /> : null}
      {children}
    </Link>
  )
}
