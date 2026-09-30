import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { cx } from '../lib/cx'
import { keepNames } from '../lib/keepNames'
import s from './Toast.module.css'

type ToastTone = 'good' | 'crit' | 'neutral'

interface ToastItem {
  id: number
  message: string
  tone: ToastTone
}

const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => {})

const icons = { good: CircleCheck, crit: CircleAlert, neutral: Info }
let seq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), [])
  const push = useCallback(
    (message: string, tone: ToastTone = 'good') => {
      const id = ++seq
      setItems((xs) => [...xs.slice(-2), { id, message, tone }])
      setTimeout(() => dismiss(id), tone === 'crit' ? 8000 : 4000)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className={s.region} role="status" aria-live="polite">
        {items.map((t) => {
          const Icon = icons[t.tone]
          return (
            <div key={t.id} className={cx(s.toast, s[t.tone])}>
              <Icon className={s.icon} />
              <span className={s.message}>{keepNames(t.message)}</span>
              <button type="button" className={s.close} aria-label="关闭提示" onClick={() => dismiss(t.id)}>
                <X />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
