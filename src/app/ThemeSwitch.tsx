import { useId, useSyncExternalStore } from 'react'
import { Select } from '../components/Form'
import { getThemePref, setThemePref, subscribeThemePref, type ThemePref } from '../lib/theme'
import s from './ThemeSwitch.module.css'

/** 外观：跟随系统、浅色、深色 */
export function ThemeSwitch() {
  const pref = useSyncExternalStore(subscribeThemePref, getThemePref)
  const id = useId()
  return (
    <div className={s.row}>
      <label htmlFor={id}>外观</label>
      <Select id={id} value={pref} onChange={(event) => setThemePref(event.target.value as ThemePref)}>
        <option value="system">系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </Select>
    </div>
  )
}
