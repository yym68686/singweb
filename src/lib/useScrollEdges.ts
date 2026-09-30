import { useEffect, useState, type RefObject } from 'react'

export interface ScrollEdges {
  /** 内容比容器宽，需要横向滚动 */
  overflow: boolean
  /** 左边还有看不到的内容 */
  start: boolean
  /** 右边还有看不到的内容 */
  end: boolean
}

const NONE: ScrollEdges = { overflow: false, start: false, end: false }

/** 横向滚动容器的状态：要不要滚动，两边是否还有看不到的内容 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState(NONE)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const max = el.scrollWidth - el.clientWidth
      // 高分屏上 scrollLeft 可能是小数，两头各留 1px
      const next = { overflow: max > 0, start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 }
      setEdges((prev) =>
        prev.overflow === next.overflow && prev.start === next.start && prev.end === next.end ? prev : next,
      )
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    // 容器宽度不变、内容变宽时（比如表格多了一列）也要重新判断
    for (const child of el.children) ro.observe(child)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [ref])

  return edges
}
