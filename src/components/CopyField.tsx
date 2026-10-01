import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, Copy } from 'lucide-react'
import { Button } from './Button'
import { COPY_KEYS, copyText } from '../lib/clipboard'
import { cx } from '../lib/cx'
import s from './CopyField.module.css'

interface CopyFieldProps {
  value: string
  /** 复制按钮的无障碍名称，比如「复制订阅地址」 */
  label: string
  className?: string
}

/**
 * 一整行要原样复制的文字，比如订阅链接。整条显示、按任意字符折行：
 * 链接截断了就没法核对 token 对不对。复制结果写在旁边，原因同 CodeBlock——
 * 它常在模态框里，提示条会被挡在遮罩后面。
 */
export function CopyField({ value, label, className }: CopyFieldProps) {
  const text = useRef<HTMLElement>(null)
  const [copied, setCopied] = useState<{ value: string; ok: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (copied && copied.value !== value) setCopied(null)
  const result = copied ? (copied.ok ? 'copied' : 'failed') : null

  const copy = async () => {
    if (!text.current) return
    const ok = await copyText(value, text.current)
    setCopied({ value, ok })
    clearTimeout(timer.current)
    if (ok) timer.current = setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className={cx(s.field, className)}>
      <div className={s.row}>
        <code ref={text} className={s.value}>
          {value}
        </code>
        <Button size="sm" icon={result === 'copied' ? Check : Copy} aria-label={label} onClick={copy}>
          {result === 'copied' ? '已复制' : '复制'}
        </Button>
        <span className="visually-hidden" role="status">
          {result === 'copied' ? '已复制到剪贴板' : ''}
        </span>
      </div>
      {result === 'failed' && (
        <p className={s.failed} role="alert">
          <CircleAlert aria-hidden />
          浏览器不允许写入剪贴板。已选中整条内容，按 {COPY_KEYS} 复制。
        </p>
      )}
    </div>
  )
}
