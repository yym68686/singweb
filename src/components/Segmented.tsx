import { useId, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cx } from '../lib/cx'
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
      <div className={s.segs} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(max-content, 1fr))` }}>
        {options.map((o) => (
          <label key={o.value} className={s.seg}>
            <input
              type="radio"
              className={s.radio}
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            {o.icon && <o.icon aria-hidden />}
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
