import type { HTMLAttributes } from 'react'
import { cx } from '../lib/cx'
import { ScrollFrame } from './ScrollFrame'
import s from './DataTable.module.css'

interface TableScrollProps extends HTMLAttributes<HTMLDivElement> {
  /** 需要滚动时，读屏软件读出的区域名称 */
  label: string
  /** 表格的最小宽度，容器比它窄时横向滚动 */
  minWidth: number
  /** 已经在面板里时不再画边框 */
  bare?: boolean
}

/** 表格的横向滚动容器，滚动提示和键盘操作见 ScrollFrame。className 加在外框上 */
export function TableScroll({ minWidth, bare, className, style, ...rest }: TableScrollProps) {
  return (
    <ScrollFrame
      className={cx(!bare && s.wrap, className)}
      style={{ ['--table-min' as string]: `${minWidth}px`, ...style }}
      {...rest}
    />
  )
}
