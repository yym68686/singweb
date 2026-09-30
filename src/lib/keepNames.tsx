import type { ReactNode } from 'react'

/** 带连字符的名字：HK-01、ssh-out、sing-box、mbp-work.local */
const NAME = /[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)+/g

/** 更长的名字（比如很长的主机名）照常换行，免得把窄屏撑宽 */
const MAX = 24

/**
 * 把文字里带连字符的名字包成不换行的片段。
 * Chrome 会在“HK-”后面换行，line-break、word-break、lang 都管不了，只能这样。
 * 不是字符串时原样返回，组件可以直接用在 ReactNode 类型的属性上
 */
export function keepNames(text: ReactNode): ReactNode {
  if (typeof text !== 'string') return text
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(NAME)) {
    if (m[0].length > MAX) continue
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      <span key={m.index} className="nowrap">
        {m[0]}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (!parts.length) return text
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
