import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { Minus, OctagonX, Pin, X } from 'lucide-react'
import { DIRECT, type Group, type GroupRuntime, type NodeHealth, type ProxyNode, type Target } from '../api/types'
import { candidateIds } from '../lib/candidates'
import { cx } from '../lib/cx'
import { joinZh, ms } from '../lib/format'
import { keepNames } from '../lib/keepNames'
import { healthLabel, protocolLabel, selectionLabel, strategyLabel } from '../lib/labels'
import { ScrollFrame } from './ScrollFrame'
import { FloatingTip, useDismiss, type Anchor } from './Tooltip'
import s from './RouteStrip.module.css'

/** idle：手动选择的分组不探测，不知道节点是否可用 */
type PortKind = 'up' | 'down' | 'unknown' | 'idle' | 'disabled' | 'direct'

interface Port {
  id: string
  label: string
  kind: PortKind
  /** 插孔下方的一行小字：延迟、失败计数或状态；手动选择的分组里是地区 */
  sub: string
  health?: NodeHealth
  node?: ProxyNode
}

interface RouteStripProps {
  runtime: GroupRuntime
  group: Group
  nodes: Map<string, ProxyNode>
  targets?: Map<string, Target>
  /** 横向滚动时，读屏软件读出的区域名称；同一页有几台设备时要带上设备名 */
  label?: string
}

/** 挂线区高度：插孔中心以下留给跳线下垂的空间 */
const SAG = 34
const SOCKET_HALF = 12
/** 一列的最小宽度，与 RouteStrip.module.css 里的 --col-min 一致 */
const COL_MIN = 62
/** 一列左右内边距之和 */
const COL_PAD = 4

function subText(h: NodeHealth, node: ProxyNode | undefined, p: Group): string {
  if (node && !node.enabled) return '已停用'
  if (h.state === 'down') {
    return h.consecutiveSuccesses > 0 ? `恢复 ${h.consecutiveSuccesses}/${p.recoverThreshold}` : '不可用'
  }
  if (h.consecutiveFails > 0) return `失败 ${h.consecutiveFails}/${p.failThreshold}`
  if (h.state === 'unknown') return '待探测'
  return ms(h.latencyMs)
}

/** 给读屏软件的节点状态 */
function srState(p: Port): string {
  if (p.kind === 'disabled') return '已停用'
  if (p.kind === 'idle') return '不探测'
  if (!p.health) return ''
  const base = healthLabel[p.health.state]
  return p.sub && p.sub !== base ? `${base}（${p.sub}）` : base
}

function portsOf(runtime: GroupRuntime, group: Group, nodes: Map<string, ProxyNode>): Port[] {
  if (group.selection === 'manual') {
    return candidateIds(group, [...nodes.values()]).map((id) => {
      const node = nodes.get(id)
      const enabled = !!node?.enabled
      return { id, label: node?.tag ?? id, kind: enabled ? 'idle' : 'disabled', sub: enabled ? (node?.region ?? '') : '已停用', node }
    })
  }
  const ports: Port[] = runtime.nodes.map((h) => {
    const node = nodes.get(h.nodeId)
    return {
      id: h.nodeId,
      label: node?.tag ?? h.nodeId,
      kind: node && !node.enabled ? 'disabled' : h.state,
      sub: subText(h, node, group),
      health: h,
      node,
    }
  })
  if (group.onAllFail === 'direct' || runtime.activeNodeId === DIRECT) {
    ports.push({ id: DIRECT, label: '直连', kind: 'direct', sub: '兜底' })
  }
  return ports
}

/** 跳线路径：从左侧插口垂下，再插进当前节点；阻断时悬空 */
function cordPath(jx: number, px: number | null, colW: number): string {
  if (px === null) {
    const end = jx + colW * 0.8
    return `M ${jx} 0 C ${jx} 26 ${jx + colW * 0.2} 30 ${end} 30`
  }
  const depth = Math.min(SAG - 4, 16 + Math.abs(px - jx) * 0.03)
  const c = depth / 0.75
  return `M ${jx} 0 C ${jx} ${c} ${px} ${c} ${px} 0`
}

/**
 * 出口跳线图：左边是 sing-box 里的 selector，右边按优先级排着候选节点，
 * 跳线插在哪个节点上，这个分组的流量就走哪个节点。
 */
export function RouteStrip({ runtime, group, nodes, targets, label }: RouteStripProps) {
  const ref = useRef<HTMLDivElement>(null)
  const jackRef = useRef<HTMLSpanElement>(null)
  // width：整条的宽度；jack：第一列（selector）的宽度，按 selector 名量出来，名字不截断
  const [geo, setGeo] = useState({ width: 0, jack: COL_MIN })
  const [tip, setTip] = useState<{ anchor: Anchor; index: number } | null>(null)
  const close = useCallback(() => setTip(null), [])
  useDismiss(!!tip, close)

  useLayoutEffect(() => {
    const el = ref.current
    const tag = jackRef.current
    if (!el || !tag) return
    const measure = () =>
      setGeo({
        width: el.offsetWidth,
        jack: Math.max(COL_MIN, Math.ceil(tag.getBoundingClientRect().width) + COL_PAD),
      })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // 字体加载完、selector 改名后，名字的宽度会变
    ro.observe(tag)
    return () => ro.disconnect()
  }, [])

  const manual = group.selection === 'manual'
  const ports = portsOf(runtime, group, nodes)
  const portW = (geo.width - geo.jack) / Math.max(1, ports.length)
  const jackX = geo.jack / 2
  const activeIndex = ports.findIndex((p) => p.id === runtime.activeNodeId)
  const active = activeIndex >= 0 ? ports[activeIndex] : null
  const stale = runtime.state === 'stale'
  const brokenLink = active?.kind === 'down'
  const blocked = runtime.activeNodeId === null

  const show = (e: MouseEvent<HTMLElement>, index: number) => {
    const socket = e.currentTarget.querySelector('[data-socket]') ?? e.currentTarget
    const r = socket.getBoundingClientRect()
    setTip({ anchor: { left: r.left, top: r.top, width: r.width, height: r.height }, index })
  }

  const activeName = blocked ? null : (active?.label ?? runtime.activeNodeId)
  const pinnedMark = manual ? '（手动选择）' : runtime.pinnedNodeId ? '（手动固定）' : ''
  const order = manual ? '' : group.strategy === 'priority' ? '按优先级' : '（按延迟挑选）'
  const summary = [
    `${group.selectorTag}：${blocked ? '已断开，新连接会被拒绝' : `当前走 ${activeName}${pinnedMark}`}。`,
    `候选节点${order}：${ports
      .filter((p) => p.kind !== 'direct')
      .map((p) => `${p.label} ${srState(p)}`)
      .join('，')}。`,
  ].join('')

  return (
    <ScrollFrame label={label ?? `「${group.name}」的当前出口`} className={s.frame} scrollerClassName={s.scroller}>
      <p className="visually-hidden">{summary}</p>
      <div
        ref={ref}
        className={cx(s.strip, stale && s.stale, brokenLink && s.broken)}
        style={{ ['--ports' as string]: ports.length, ['--jack' as string]: `${geo.jack}px` }}
        aria-hidden
      >
        <div className={s.col} onMouseEnter={(e) => show(e, -1)} onMouseLeave={close}>
          <span ref={jackRef} className={cx(s.tag, s.jackTag)}>
            {group.selectorTag}
          </span>
          <span className={s.sub}>{manual ? selectionLabel.manual : strategyLabel[group.strategy]}</span>
          <span data-socket className={cx(s.socket, s.jack, s.plugged)} />
        </div>

        {ports.map((p, i) => {
          const isActive = i === activeIndex
          // 手动选择的分组里，选中的节点就是出口，不另外标固定
          const pinned = !manual && p.id === runtime.pinnedNodeId
          return (
            <div
              key={p.id}
              className={cx(s.col, p.kind === 'direct' && s.directCol)}
              onMouseEnter={(e) => show(e, i)}
              onMouseLeave={close}
            >
              <span className={s.tag}>
                {pinned && <Pin className={s.pin} />}
                {p.label}
              </span>
              <span className={s.sub}>{p.sub}</span>
              <span
                data-socket
                className={cx(s.socket, s[p.kind], isActive && s.active, isActive && s.plugged)}
              >
                {!isActive && p.kind === 'down' && <X />}
                {!isActive && p.kind === 'disabled' && <Minus />}
              </span>
            </div>
          )
        })}

        {geo.width > 0 && (
          <svg
            className={s.cord}
            width={geo.width}
            height={SAG + SOCKET_HALF}
            viewBox={`0 0 ${geo.width} ${SAG + SOCKET_HALF}`}
          >
            <path
              className={s.cordPath}
              d={cordPath(jackX, activeIndex >= 0 ? geo.jack + (activeIndex + 0.5) * portW : null, portW)}
            />
            {blocked && <rect className={s.loosePlug} x={jackX + portW * 0.8} y={26} width={12} height={8} rx={2} />}
          </svg>
        )}

        {blocked && geo.width > 0 && (
          <span className={s.cutNote} style={{ left: jackX + portW * 0.8 + 20 }}>
            <OctagonX />
            未接入任何节点
          </span>
        )}
      </div>

      {tip && (
        <FloatingTip anchor={tip.anchor}>
          {tip.index === -1 ? (
            <JackTip group={group} activeName={activeName} pinned={!!runtime.pinnedNodeId} />
          ) : (
            <PortTip
              port={ports[tip.index]}
              group={group}
              active={tip.index === activeIndex}
              pinned={!manual && ports[tip.index].id === runtime.pinnedNodeId}
              targets={targets}
            />
          )}
        </FloatingTip>
      )}
    </ScrollFrame>
  )
}

function JackTip({ group, activeName, pinned }: { group: Group; activeName: string | null; pinned: boolean }) {
  const how =
    group.selection === 'manual' ? '，手动选择' : pinned ? '，手动固定中' : `，${strategyLabel[group.strategy]}自动选择`
  return (
    <>
      <p className={s.tipTitle}>
        selector <span className="mono">{keepNames(group.selectorTag)}</span>
      </p>
      <p>
        {activeName ? keepNames(`当前走 ${activeName}`) : '已断开，新连接会被拒绝'}
        {activeName && how}。
      </p>
    </>
  )
}

interface PortTipProps {
  port: Port
  group: Group
  active: boolean
  pinned: boolean
  targets?: Map<string, Target>
}

function PortTip({ port, group, active, pinned, targets }: PortTipProps) {
  if (port.kind === 'direct') {
    return (
      <>
        <p className={s.tipTitle}>直连</p>
        <p>所有节点都不可用时改走直连，对方会看到设备的真实出口 IP。</p>
        {active && <p className={s.tipStrong}>正在直连。</p>}
      </>
    )
  }
  const h = port.health
  const failing = (h?.failingTargetIds ?? []).map((id) => targets?.get(id)?.name ?? id)
  return (
    <>
      <p className={s.tipTitle}>{port.label}</p>
      {port.node && (
        <p className={s.tipMeta}>
          {protocolLabel[port.node.protocol]}，{port.node.region}
        </p>
      )}
      {port.kind === 'disabled' ? (
        <p>{group.selection === 'manual' ? '已停用，不能选择。' : '已停用，不参与切换，也不探测。'}</p>
      ) : port.kind === 'idle' ? (
        <p>手动选择的分组不探测，这里看不到节点是否可用。</p>
      ) : (
        h && (
          <>
            <p>
              {healthLabel[h.state]}
              {h.latencyMs != null && `，延迟中位数 ${ms(h.latencyMs)}`}
            </p>
            {h.state !== 'down' && h.consecutiveFails > 0 && (
              <p>
                已连续失败 {h.consecutiveFails} 轮，满 {group.failThreshold} 轮判定为不可用。
              </p>
            )}
            {h.state === 'down' && h.consecutiveSuccesses > 0 && (
              <p>
                已连续通过 {h.consecutiveSuccesses} 轮，满 {group.recoverThreshold} 轮恢复可用。
              </p>
            )}
            {failing.length > 0 && <p>最近一轮未通过：{keepNames(joinZh(failing))}</p>}
          </>
        )
      )}
      {active && <p className={s.tipStrong}>{pinned ? '当前出口（手动固定）' : '当前出口'}</p>}
      {!active && pinned && <p className={s.tipStrong}>已固定</p>}
    </>
  )
}

/** 跳线图例 */
export function RouteLegend() {
  return (
    <ul className={s.legend} aria-label="图例">
      <li>
        <span className={cx(s.socket, s.mini, s.up, s.active, s.plugged)} />
        当前出口
      </li>
      <li>
        <span className={cx(s.socket, s.mini, s.up)} />
        可用
      </li>
      <li>
        <span className={cx(s.socket, s.mini, s.down)}>
          <X />
        </span>
        不可用
      </li>
      <li>
        <span className={cx(s.socket, s.mini, s.unknown)} />
        待探测
      </li>
    </ul>
  )
}
