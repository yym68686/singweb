export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'singweb.theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

function apply(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && media.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

export function setThemePref(pref: ThemePref) {
  if (pref === 'system') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, pref)
  apply(pref)
  for (const l of listeners) l()
}

/** 侧栏和手机导航里各有一个外观开关，改了其中一个，另一个也要跟着变 */
export function subscribeThemePref(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

media.addEventListener('change', () => apply(getThemePref()))
