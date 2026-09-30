import { useRef, type HTMLAttributes } from 'react'
import { cx } from '../lib/cx'
import { useScrollEdges } from '../lib/useScrollEdges'
import s from './ScrollFrame.module.css'

interface ScrollFrameProps extends HTMLAttributes<HTMLDivElement> {
  /** 需要滚动时，读屏软件读出的区域名称 */
  label: string
  /** 里面滚动容器的 class；className 和 style 加在外框上 */
  scrollerClassName?: string
}

/**
 * 横向滚动容器。两边还有看不到的内容时，在那一边画一道阴影，提示可以滚动。
 * 需要滚动时容器可以用 Tab 聚焦，再用左右方向键滚动，里面没有链接和按钮也能看全；
 * 不需要滚动时不占用 Tab 顺序。
 *
 * 外框上的 data-more-start、data-more-end 表示左边、右边还有内容，调用方的样式也可以用
 */
export function ScrollFrame({ label, scrollerClassName, className, style, children, ...rest }: ScrollFrameProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { overflow, start, end } = useScrollEdges(ref)

  return (
    <div
      className={cx(s.frame, className)}
      style={style}
      data-more-start={start || undefined}
      data-more-end={end || undefined}
    >
      <div
        ref={ref}
        className={cx(s.scroller, scrollerClassName)}
        role={overflow ? 'region' : undefined}
        aria-label={overflow ? label : undefined}
        tabIndex={overflow ? 0 : undefined}
        {...rest}
      >
        {children}
      </div>
    </div>
  )
}
