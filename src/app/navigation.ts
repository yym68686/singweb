import { useEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'

/** 换页后把焦点移到主内容区，读屏软件从新页面的开头读起 */
export function useFocusMainOnNavigate() {
  const { pathname } = useLocation()
  const last = useRef(pathname)
  useEffect(() => {
    if (last.current === pathname) return
    last.current = pathname
    document.getElementById('main')?.focus({ preventScroll: true })
  }, [pathname])
}

/**
 * 跳到链接里的 #锚点。
 * 页面内容常要等数据到了才渲染，ScrollRestoration 当时找不到元素就回到顶部了，
 * 这里等元素出现后再滚过去，最多等 3 秒。后退时交给 ScrollRestoration 恢复原来的位置。
 */
export function useHashScroll() {
  const { hash, key } = useLocation()
  const type = useNavigationType()
  // 直接打开带锚点的地址时也要滚动；只处理一次，之后后退回来不再抢位置
  const initialKey = useRef(key)
  const initialDone = useRef(false)

  useEffect(() => {
    const initial = key === initialKey.current && !initialDone.current
    if (!hash || (type === 'POP' && !initial)) return
    const id = decodeURIComponent(hash.slice(1))
    const smooth = !initial && !matchMedia('(prefers-reduced-motion: reduce)').matches

    const go = () => {
      const el = document.getElementById(id)
      if (!el) return false
      el.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' })
      if (initial) initialDone.current = true
      return true
    }
    if (go()) return

    const observer = new MutationObserver(() => {
      if (go()) stop()
    })
    const timer = setTimeout(() => stop(), 3000)
    function stop() {
      observer.disconnect()
      clearTimeout(timer)
    }
    observer.observe(document.body, { childList: true, subtree: true })
    return stop
  }, [hash, key, type])
}
