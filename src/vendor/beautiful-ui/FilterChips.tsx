import type { ReactNode } from 'react'

// Extracted from FilterTable.tsx at the pinned Beautiful UI revision.
// Data, translated labels and wrapped overflow replace the upstream demo.
export function FilterChips<T extends string>({ label, options, value, onChange, tabsId }: {
  label: string
  options: { value: T; label: ReactNode; count?: number }[]
  value: T
  onChange: (value: T) => void
  tabsId?: string
}) {
  return (
    <div role={tabsId ? 'tablist' : 'group'} aria-label={label} className="flex flex-wrap items-center gap-1 py-1">
      {options.map((option) => {
        const active = value === option.value
        return (
          <button key={option.value} type="button" role={tabsId ? 'tab' : undefined}
            id={tabsId ? `${tabsId}-${option.value}` : undefined}
            aria-controls={tabsId ? option.value : undefined}
            aria-selected={tabsId ? active : undefined} aria-pressed={tabsId ? undefined : active}
            tabIndex={tabsId && !active ? -1 : undefined}
            onKeyDown={tabsId ? (event) => {
              const index = options.indexOf(option)
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                : event.key === 'ArrowRight' ? (index + 1) % options.length
                  : event.key === 'ArrowLeft' ? (index - 1 + options.length) % options.length : -1
              if (next < 0) return
              event.preventDefault()
              onChange(options[next].value)
              document.getElementById(`${tabsId}-${options[next].value}`)?.focus()
            } : undefined}
            onClick={() => onChange(option.value)}
            className={`flex min-h-8 items-center gap-1.5 rounded-[var(--r-control)] px-3 text-[13px] font-medium transition-colors duration-200 ${active ? 'bg-hover-2 text-ink' : 'text-ink-2 hover:bg-hover'}`}>
            {option.label}
            {option.count !== undefined && <span className="text-[11px] tabular-nums text-ink-2">{option.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
