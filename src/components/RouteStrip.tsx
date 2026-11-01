import { Pin } from 'lucide-react'
import { DIRECT, type Group, type GroupRuntime, type NodeHealth, type ProxyNode, type Target } from '../api/types'
import { candidateIds } from '../lib/candidates'
import { joinZh, ms } from '../lib/format'
import { keepNames } from '../lib/keepNames'
import { healthLabel, protocolLabel, selectionLabel, strategyLabel } from '../lib/labels'
import { Disclosure } from './Disclosure'
import { Notice } from './Notice'
import s from './RouteStrip.module.css'

type PortKind = 'up' | 'down' | 'unknown' | 'idle' | 'disabled' | 'direct'

interface Port {
  id: string
  label: string
  kind: PortKind
  sub: string
  health?: NodeHealth
  node?: ProxyNode
}

interface RouteStripProps {
  runtime: GroupRuntime
  group: Group
  nodes: Map<string, ProxyNode>
  targets?: Map<string, Target>
  label?: string
}

function subText(h: NodeHealth, node: ProxyNode | undefined, group: Group): string {
  if (node && !node.enabled) return '已停用'
  if (h.state === 'down') return h.consecutiveSuccesses > 0 ? `恢复 ${h.consecutiveSuccesses}/${group.recoverThreshold}` : '不可用'
  if (h.consecutiveFails > 0) return `失败 ${h.consecutiveFails}/${group.failThreshold}`
  if (h.state === 'unknown') return '待探测'
  return `可用 · ${ms(h.latencyMs)}`
}

function portsOf(runtime: GroupRuntime, group: Group, nodes: Map<string, ProxyNode>): Port[] {
  if (group.selection === 'manual') {
    return candidateIds(group, [...nodes.values()]).map((id) => {
      const node = nodes.get(id)
      const enabled = !!node?.enabled
      return { id, label: node?.tag ?? id, kind: enabled ? 'idle' : 'disabled', sub: enabled ? '手动选择，不探测' : '已停用', node }
    })
  }
  const ports: Port[] = runtime.nodes.map((h) => {
    const node = nodes.get(h.nodeId)
    return { id: h.nodeId, label: node?.tag ?? h.nodeId, kind: node && !node.enabled ? 'disabled' : h.state, sub: subText(h, node, group), health: h, node }
  })
  if (group.onAllFail === 'direct' || runtime.activeNodeId === DIRECT) {
    ports.push({ id: DIRECT, label: '直连', kind: 'direct', sub: '兜底' })
  }
  return ports
}

/** 当前出口先给出结论，候选节点及探测详情逐层展开。 */
export function RouteStrip({ runtime, group, nodes, targets, label }: RouteStripProps) {
  const ports = portsOf(runtime, group, nodes)
  const active = ports.find((port) => port.id === runtime.activeNodeId)
  const blocked = runtime.activeNodeId === null
  const manual = group.selection === 'manual'
  const activeName = active?.label ?? nodes.get(runtime.activeNodeId ?? '')?.tag ?? runtime.activeNodeId

  return (
    <div className={s.route} role="group" aria-label={label ?? `「${group.name}」的当前出口`}>
      <p className={s.current}>
        {blocked ? '已阻断 · 新连接会被拒绝' : <>当前出口：{keepNames(activeName ?? '')}</>}
        {!manual && runtime.pinnedNodeId && <span className={s.pinned}><Pin aria-hidden />手动固定</span>}
      </p>
      <p className={s.meta}>selector <span className="mono">{keepNames(group.selectorTag)}</span> · {manual ? selectionLabel.manual : strategyLabel[group.strategy]}</p>
      {runtime.state === 'stale' && <Notice tone="offline" title="设备离线，以上为最后上报的状态" />}
      {active?.kind === 'down' && <Notice tone="crit" title="当前出口不可用" />}
      {runtime.activeNodeId === DIRECT && <Notice tone="warn" title="正在直连">对方会看到设备的真实出口 IP。</Notice>}
      <Disclosure title="候选节点与探测详情" meta={`${ports.length} 个`}>
        {ports.length ? (
          <ol className={s.nodes}>
            {ports.map((port) => (
              <li key={port.id}>
                <Disclosure
                  title={port.label}
                  meta={<><span>{port.id === runtime.activeNodeId ? '当前出口 · ' : ''}{port.sub}</span>{port.id === runtime.pinnedNodeId && <span>已固定</span>}</>}
                >
                  <PortDetail port={port} group={group} targets={targets} />
                </Disclosure>
              </li>
            ))}
          </ol>
        ) : <p className={s.meta}>尚无候选节点状态。</p>}
      </Disclosure>
    </div>
  )
}

function PortDetail({ port, group, targets }: { port: Port; group: Group; targets?: Map<string, Target> }) {
  if (port.kind === 'direct') return <p>所有节点都不可用时改走直连，对方会看到设备的真实出口 IP。</p>
  const h = port.health
  const failing = (h?.failingTargetIds ?? []).map((id) => targets?.get(id)?.name ?? id)
  return (
    <div className={s.detail}>
      {port.node && <p className={s.meta}>{protocolLabel[port.node.protocol]} · {port.node.region}</p>}
      {port.kind === 'disabled' ? (
        <p>{group.selection === 'manual' ? '已停用，不能选择。' : '已停用，不参与切换，也不探测。'}</p>
      ) : port.kind === 'idle' ? (
        <p>手动选择的分组不探测，这里看不到节点是否可用。</p>
      ) : h ? (
        <>
          <p>{healthLabel[h.state]}{h.latencyMs != null && `，延迟中位数 ${ms(h.latencyMs)}`}</p>
          {h.state !== 'down' && h.consecutiveFails > 0 && <p>已连续失败 {h.consecutiveFails} 轮，满 {group.failThreshold} 轮判定为不可用。</p>}
          {h.state === 'down' && h.consecutiveSuccesses > 0 && <p>已连续通过 {h.consecutiveSuccesses} 轮，满 {group.recoverThreshold} 轮恢复可用。</p>}
          {failing.length > 0 && <p>最近一轮未通过：{keepNames(joinZh(failing))}</p>}
        </>
      ) : null}
    </div>
  )
}
