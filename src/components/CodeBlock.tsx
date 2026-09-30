import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert, Copy } from 'lucide-react'
import { Button } from './Button'
import { cx } from '../lib/cx'
import s from './CodeBlock.module.css'

const COPY_KEYS = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘C' : 'Ctrl+C'

/**
 * 写入剪贴板。用 http 加内网 IP 打开管理服务时浏览器不提供 Clipboard API，
 * 这时改为选中文字再执行复制命令；还是不行就保留选中，让用户自己按快捷键。
 */
async function copyText(text: string, source: HTMLElement): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 例如用户拒绝了剪贴板权限，下面换一种方式
    }
  }
  const selection = getSelection()
  selection?.selectAllChildren(source)
  if (document.execCommand('copy')) {
    selection?.removeAllRanges()
    return true
  }
  return false
}

interface CodeBlockProps {
  code: string
  /** 代码块上方的标题，同时作为可滚动区域的名称 */
  title?: ReactNode
  label: string
  copyLabel?: string
  className?: string
  /** 限制高度，超出后滚动 */
  maxHeight?: number
}

/** 原样显示的配置或命令，带复制按钮；复制成功后按钮短暂显示“已复制” */
export function CodeBlock({ code, title, label, copyLabel = '复制', className, maxHeight }: CodeBlockProps) {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState<{ code: string; ok: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  // 内容变了（比如改了主机名），之前的复制结果就不再适用；改回原样时选中的文字也早已不在了
  if (copied && copied.code !== code) setCopied(null)
  const result = copied ? (copied.ok ? 'copied' : 'failed') : null

  // 结果写在代码块旁边而不是弹提示条：代码块可能在模态框里，提示条会被挡在遮罩后面
  const copy = async () => {
    if (!pre.current) return
    const ok = await copyText(code, pre.current)
    setCopied({ code, ok })
    clearTimeout(timer.current)
    if (ok) timer.current = setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className={cx(s.block, className)}>
      <div className={s.head}>
        <span className={s.title}>{title}</span>
        <Button size="sm" icon={result === 'copied' ? Check : Copy} onClick={copy}>
          {result === 'copied' ? '已复制' : copyLabel}
        </Button>
        <span className="visually-hidden" role="status">
          {result === 'copied' ? '已复制到剪贴板' : ''}
        </span>
      </div>
      {result === 'failed' && (
        <p className={s.failed} role="alert">
          <CircleAlert aria-hidden />
          浏览器不允许写入剪贴板。已选中全部内容，按 {COPY_KEYS} 复制。
        </p>
      )}
      <pre ref={pre} className={s.pre} tabIndex={0} aria-label={label} style={maxHeight ? { maxHeight } : undefined}>
        <code>{code}</code>
      </pre>
    </div>
  )
}
