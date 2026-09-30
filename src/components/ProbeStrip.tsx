import { useCallback, useState, type PointerEvent } from 'react'
import type { ProbeError, ProbeStage } from '../api/types'
import { cx } from '../lib/cx'
import { formatTime, ms } from '../lib/format'
import { probeFailText, probeStageDone } from '../lib/labels'
import { FloatingTip, useDismiss, type Anchor } from './Tooltip'
import s from './ProbeStrip.module.css'

export interface StripSample {
  at: string
  ok: boolean
  latencyMs: number | null
  stage?: ProbeStage | null
  error?: ProbeError
  /** HTTP 探测收到的状态码 */
  status?: number
}

interface ProbeStripProps {
  samples: StripSample[]
  /** 显示多少轮，旧的在左、新的在右 */
  slots?: number
  /** 延迟刻度上限；同一张表里的多条应传同一个值，才能互相比较 */
  maxMs?: number
  size?: 'md' | 'sm'
  /** 容器窄时横向压缩，高度不变 */
  fluid?: boolean
  className?: string
}

const DIM = {
  md: { bar: 4, gap: 2, up: 20, down: 8 },
  sm: { bar: 3, gap: 1, up: 14, down: 6 },
}

/** 压缩时每一轮最少占的宽度（含间隔） */
const FLUID_MIN_STEP = 4

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

export function stripSummary(samples: StripSample[]): string {
  const ok = samples.filter((x) => x.ok)
  const med = median(ok.map((x) => x.latencyMs).filter((v): v is number => v != null))
  return `最近 ${samples.length} 轮：通过 ${ok.length} 轮，失败 ${samples.length - ok.length} 轮${med != null ? `，延迟中位数 ${ms(med)}` : ''}`
}

/** 探测历史条：通过的柱子向上、高度对应延迟；失败的向下，用红色 */
export function ProbeStrip({ samples, slots = 40, maxMs, size = 'md', fluid, className }: ProbeStripProps) {
  const d = DIM[size]
  const step = d.bar + d.gap
  const width = slots * step - d.gap
  const height = d.up + 1 + d.down
  const base = d.up
  const shown = samples.slice(-slots)
  const offset = slots - shown.length
  const scale =
    maxMs ?? Math.max(200, ...shown.map((x) => (x.ok && x.latencyMs != null ? x.latencyMs : 0)))

  const [tip, setTip] = useState<{ anchor: Anchor; i: number } | null>(null)
  const close = useCallback(() => setTip(null), [])
  useDismiss(!!tip, close)

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const slot = Math.floor(((e.clientX - r.left) / r.width) * slots)
    const i = slot - offset
    if (i < 0 || i >= shown.length) return close()
    if (tip?.i === i) return
    const x = r.left + (slot / slots) * r.width
    setTip({ anchor: { left: x, top: r.top, width: d.bar * (r.width / width), height: r.height }, i })
  }

  const hovered = tip ? shown[tip.i] : null

  return (
    <>
      <svg
        className={cx(s.strip, className)}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio={fluid ? 'none' : undefined}
        style={fluid ? { width: '100%', minWidth: slots * FLUID_MIN_STEP, maxWidth: width } : undefined}
        role="img"
        aria-label={stripSummary(shown)}
        onPointerMove={onMove}
        onPointerLeave={close}
      >
        <line className={s.base} x1={0} x2={width} y1={base + 0.5} y2={base + 0.5} />
        {shown.map((x, i) => {
          const px = (offset + i) * step
          if (!x.ok) {
            return <rect key={i} className={cx(s.fail, tip?.i === i && s.hot)} x={px} y={base + 1} width={d.bar} height={d.down} rx={1} />
          }
          const h = Math.max(2, Math.min(1, (x.latencyMs ?? 0) / scale) * d.up)
          return <rect key={i} className={cx(s.pass, tip?.i === i && s.hot)} x={px} y={base - h} width={d.bar} height={h} rx={1} />
        })}
      </svg>
      {tip && hovered && (
        <FloatingTip anchor={tip.anchor}>
          <p className={s.tipTime}>{formatTime(hovered.at)}</p>
          {hovered.ok ? (
            <p>通过，{ms(hovered.latencyMs)}</p>
          ) : (
            <p>
              失败：{hovered.error ? probeFailText(hovered) : '未通过'}
              {hovered.stage !== undefined &&
                (hovered.stage ? `（${probeStageDone[hovered.stage]}）` : '（TCP 没连上）')}
            </p>
          )}
        </FloatingTip>
      )}
    </>
  )
}
