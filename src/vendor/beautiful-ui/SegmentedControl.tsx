import type { ReactNode } from 'react'

// Adapted from Beautiful UI's SegmentedControl at the pinned revision.
export function SegmentedControl<T extends string>({ options, value, onChange, name }: { options: { value: T; label: ReactNode }[]; value: T; onChange: (value: T) => void; name: string }) {
  const index = options.findIndex((option) => option.value === value)
  return (
    <div className="relative inline-grid h-8 max-w-full select-none rounded-[var(--r-control)] bg-hover-2 p-0.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <span aria-hidden className="absolute inset-y-0.5 rounded-[calc(var(--r-control)-2px)] bg-surface transition-transform duration-200 motion-reduce:transition-none" style={{ width: `calc((100% - 4px) / ${options.length})`, left: 2, transform: `translateX(${Math.max(0, index) * 100}%)`, transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)' }} />
      {options.map((option) => (
        <label key={option.value} className={`relative z-10 flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-[var(--r-control)] px-2.5 text-[13px] font-medium transition-colors duration-150 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent ${option.value === value ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
          <input type="radio" name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} className="absolute inset-0 m-0 size-full cursor-pointer opacity-0" />
          {option.label}
        </label>
      ))}
    </div>
  )
}
