import { useId, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cx } from '../lib/cx'
import { SegmentedControl } from '../vendor/beautiful-ui/SegmentedControl'
import s from './Segmented.module.css'

interface Option<T extends string> {
  value: T
  label: ReactNode
  icon?: LucideIcon
}

interface SegmentedProps<T extends string> {
  legend: ReactNode
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
  className?: string
}

/** 分段选择：一组互斥的单选按钮，用来切换视图 */
export function Segmented<T extends string>({ legend, value, options, onChange, className }: SegmentedProps<T>) {
  const name = useId()
  return (
    <fieldset className={cx(s.group, className)}>
      <legend className={s.legend}>{legend}</legend>
      <SegmentedControl name={name} value={value} onChange={onChange} options={options.map((o) => ({ value: o.value, label: <>{o.icon && <o.icon size={15} aria-hidden />}{o.label}</> }))} />
    </fieldset>
  )
}
