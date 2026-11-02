// Search input extracted from Beautiful UI's SearchList at the pinned revision.
export function SearchField({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-[var(--r-control)] bg-inset px-2 transition-colors duration-100 hover:bg-hover focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeLinecap="round" className="shrink-0" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
      <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={label} aria-label={label} className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3" />
      {value && <button aria-label="清除搜索" type="button" onClick={() => onChange('')} className="flex size-6 items-center justify-center rounded-[var(--r-control)] text-ink-3 transition-colors duration-100 hover:bg-line/70 hover:text-ink"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg></button>}
    </div>
  )
}
