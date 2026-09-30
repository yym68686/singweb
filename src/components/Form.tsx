import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { ChevronDown, CircleAlert } from 'lucide-react'
import { cx } from '../lib/cx'
import { keepNames } from '../lib/keepNames'
import s from './Form.module.css'

interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  /** 渲染控件；参数是控件需要的 id 和 aria 属性 */
  children: (a: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode
  className?: string
}

/** 表单字段：标签、控件、说明和错误信息，自动关联无障碍属性 */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined
  return (
    <div className={cx(s.field, className)}>
      <label htmlFor={id} className={s.label}>
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error && (
        <p id={errorId} className={s.error}>
          <CircleAlert aria-hidden />
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className={s.hint}>
          {keepNames(hint)}
        </p>
      )}
    </div>
  )
}

interface FieldsetProps {
  legend: ReactNode
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  className?: string
}

/** 一组相关的选项（复选框、单选） */
export function Fieldset({ legend, hint, error, children, className }: FieldsetProps) {
  const id = useId()
  return (
    <fieldset
      className={cx(s.fieldset, className)}
      aria-describedby={[error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined}
    >
      <legend className={s.label}>{legend}</legend>
      {hint && (
        <p id={`${id}-hint`} className={s.hint}>
          {keepNames(hint)}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className={s.error}>
          <CircleAlert aria-hidden />
          {error}
        </p>
      )}
      {children}
    </fieldset>
  )
}

export function TextInput({ className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={cx(s.input, mono && s.mono, className)} {...rest} />
}

export function TextArea({ className, mono, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={cx(s.input, s.textarea, mono && s.mono, className)} {...rest} />
}

interface UnitInputProps extends InputHTMLAttributes<HTMLInputElement> {
  unit: string
}

/** 带单位的数字输入框 */
export function UnitInput({ unit, className, ...rest }: UnitInputProps) {
  return (
    <span className={cx(s.unitWrap, className)}>
      <input type="number" inputMode="numeric" className={cx(s.input, s.unitInput)} {...rest} />
      <span className={s.unit} aria-hidden>
        {unit}
      </span>
    </span>
  )
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx(s.selectWrap, className)}>
      <select className={cx(s.input, s.select)} {...rest}>
        {children}
      </select>
      <ChevronDown className={s.chevron} aria-hidden />
    </span>
  )
}

interface CheckProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  type?: 'checkbox' | 'radio'
  label: ReactNode
  description?: ReactNode
  /** 右侧附加信息，如版本提示 */
  aside?: ReactNode
  card?: boolean
}

/** 复选框 / 单选框，带标题和说明 */
export function Check({ type = 'checkbox', label, description, aside, card, className, disabled, ...rest }: CheckProps) {
  const id = useId()
  return (
    <label className={cx(s.check, card && s.card, disabled && s.disabled, className)} htmlFor={id}>
      <input
        id={id}
        type={type}
        className={s.checkInput}
        disabled={disabled}
        aria-describedby={description ? `${id}-desc` : undefined}
        {...rest}
      />
      <span className={s.checkText}>
        <span className={s.checkLabel}>{label}</span>
        {description && (
          <span id={`${id}-desc`} className={s.checkDesc}>
            {keepNames(description)}
          </span>
        )}
      </span>
      {aside && <span className={s.checkAside}>{aside}</span>}
    </label>
  )
}

interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  pending?: boolean
}

/** 开关；label 只给读屏软件，旁边的可见文字由调用方提供 */
export function Switch({ checked, onChange, label, disabled, pending }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      // 进行中不设 disabled，焦点才不会被移走，见 Button
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      disabled={disabled}
      className={cx(s.switch, checked && s.on)}
      onClick={() => {
        if (!pending) onChange(!checked)
      }}
    >
      <span className={s.thumb} />
    </button>
  )
}

/** 表单顶部的错误摘要 */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <div className={s.formError} role="alert">
      <CircleAlert aria-hidden />
      <div>{children}</div>
    </div>
  )
}
