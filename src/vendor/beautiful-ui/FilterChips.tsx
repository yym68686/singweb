import type { ReactNode } from 'react'

// Extracted from FilterTable.tsx at the pinned Beautiful UI revision.
// Data, translated labels and wrapped overflow replace the upstream demo.
export function FilterChips<T extends string>({ label, options, value, onChange }: {
  label: string
  options: { value: T; label: ReactNode; count?: number }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1 py-1">
      {options.map((option) => {
        const active = value === option.value
        return (
          <button key={option.value} type="button" aria-pressed={active} onClick={() => onChange(option.value)}
            className={`flex min-h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-[background-color,box-shadow,color] duration-200 ${active ? 'bg-surface text-ink shadow-btn' : 'text-ink-2 hover:bg-hover'}`}>
            {option.label}
            {option.count !== undefined && <span className={`rounded-[4px] px-1 text-[11px] tabular-nums ${active ? 'bg-field text-ink-2' : 'text-ink-3'}`}>{option.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
