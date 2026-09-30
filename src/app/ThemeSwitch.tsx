import { useId, useSyncExternalStore } from 'react'
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { getThemePref, setThemePref, subscribeThemePref, type ThemePref } from '../lib/theme'
import s from './ThemeSwitch.module.css'

const OPTIONS: { value: ThemePref; label: string; hidden?: string; icon: LucideIcon }[] = [
  { value: 'system', label: '系统', hidden: '跟随', icon: Monitor },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
]

/** 外观：跟随系统、浅色、深色 */
export function ThemeSwitch() {
  const pref = useSyncExternalStore(subscribeThemePref, getThemePref)
  const name = useId()
  return (
    <fieldset className={s.group}>
      <legend className={s.legend}>外观</legend>
      <div className={s.segs}>
        {OPTIONS.map((o) => (
          <label key={o.value} className={s.seg}>
            <input
              type="radio"
              className={s.radio}
              name={name}
              value={o.value}
              checked={pref === o.value}
              onChange={() => setThemePref(o.value)}
            />
            <o.icon aria-hidden />
            <span>
              {o.hidden && <span className="visually-hidden">{o.hidden}</span>}
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
