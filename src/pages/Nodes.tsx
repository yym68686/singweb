import { useState } from 'react'
import { Link } from 'react-router'
import { CircleCheck, CircleDashed, CircleMinus, CircleX, Hand, Pin, Server, WifiOff, type LucideIcon } from 'lucide-react'
import { outletName, useCatalog, type Catalog } from '../api/catalog'
import { errorMessage } from '../api/errors'
import { useRuntimes, useUpdateNode } from '../api/hooks'
import type { GroupRuntime, HealthState, ProxyNode } from '../api/types'
import { Badge, ToneIcon } from '../components/Badge'
import { TableScroll } from '../components/DataTable'
import { ConfirmDialog } from '../components/Dialog'
import { Switch } from '../components/Form'
import { PageHeader } from '../components/PageHeader'
import { EmptyState, Loadable } from '../components/States'
import { useToast } from '../components/Toast'
import { candidateIds } from '../lib/candidates'
import { cx } from '../lib/cx'
import { joinZh } from '../lib/format'
import { keepNames } from '../lib/keepNames'
import { allFailLabel, protocolLabel } from '../lib/labels'
import type { Tone } from '../lib/status'
import t from '../components/DataTable.module.css'
import page from '../styles/page.module.css'
import s from './Nodes.module.css'

export default function Nodes() {
  const catalog = useCatalog()
  const runtimes = useRuntimes()
  const data = catalog.data && runtimes.data ? { c: catalog.data, rts: runtimes.data } : undefined
  return (
    <>
      <PageHeader
        title="节点"
        description="设备上 sing-box 配置里的代理出站。停用的节点不参与任何分组，Agent 也不再探测它。节点本身的地址和参数仍在 sing-box 配置或订阅里修改。"
      />
      <Loadable
        data={data}
        error={catalog.error ?? runtimes.error}
        retry={() => {
          catalog.retry()
          void runtimes.refetch()
        }}
      >
        {({ c, rts }) =>
          c.nodes.length ? (
            <NodeTable c={c} rts={rts} />
          ) : (
            <EmptyState icon={Server} title="还没有节点">
              Agent 上报设备的 sing-box 配置后，里面的代理出站会出现在这里。
            </EmptyState>
          )
        }
      </Loadable>
    </>
  )
}

/** 健康列按结论把设备分几堆 */
type Bucket = HealthState | 'offline'

const bucketLook: Record<Bucket, { tone: Tone; icon: LucideIcon; label: string }> = {
  down: { tone: 'crit', icon: CircleX, label: '不可用' },
  unknown: { tone: 'neutral', icon: CircleDashed, label: '待探测' },
  up: { tone: 'good', icon: CircleCheck, label: '可用' },
  offline: { tone: 'offline', icon: WifiOff, label: '设备离线' },
}

const worstFirst: HealthState[] = ['down', 'unknown', 'up']

/** 这个节点在各台设备上的探测结论；同一台设备上有多个分组时取最差的。手动选择的分组不探测，没有结论 */
function healthByDevice(n: ProxyNode, c: Catalog, rts: GroupRuntime[]) {
  const per = new Map<string, HealthState>()
  for (const r of rts) {
    const h = r.nodes.find((x) => x.nodeId === n.id)
    if (!h) continue
    const prev = per.get(r.deviceId)
    if (!prev || worstFirst.indexOf(h.state) < worstFirst.indexOf(prev)) per.set(r.deviceId, h.state)
  }
  const buckets: Record<Bucket, string[]> = { down: [], unknown: [], up: [], offline: [] }
  for (const d of c.devices) {
    const st = per.get(d.id)
    if (st) buckets[d.online ? st : 'offline'].push(d.name)
  }
  return buckets
}

/** 节点在哪种分组里做候选：只要有一个按规则自动切换的分组用它，就会被探测 */
type Usage = 'probed' | 'manual'

function usageOf(c: Catalog) {
  const usage = new Map<string, Usage>()
  for (const g of c.groups) {
    for (const id of candidateIds(g, c.nodes)) {
      if (g.selection === 'auto') usage.set(id, 'probed')
      else if (!usage.has(id)) usage.set(id, 'manual')
    }
  }
  return usage
}

interface Impact {
  key: string
  where: string
  after: string
  /** 分组设置了切换时断开已有连接 */
  interrupt: boolean
  offline: boolean
}

/**
 * 停用一个节点会影响哪些出口：正在用它的要切走，固定在它上面的要取消固定；
 * 手动选择的分组选中了它的，会改走第一个启用的候选节点，重新启用后也不会选回它
 */
function impactOf(n: ProxyNode, c: Catalog, rts: GroupRuntime[]) {
  const impacts: Impact[] = []
  let pinned = 0
  let chosen = 0
  for (const r of rts) {
    const g = c.group.get(r.groupId)
    if (!g) continue
    if (r.pinnedNodeId === n.id) {
      if (g.selection === 'manual') chosen++
      else pinned++
    }
    const d = c.device.get(r.deviceId)
    if (r.activeNodeId !== n.id || !d) continue
    // 自动分组的 eligibleNodeIds 是可用的候选节点；手动分组的是启用的候选节点，按顺序排
    const others = r.eligibleNodeIds.filter((id) => id !== n.id)
    let next = others[0]
    if (g.selection === 'auto' && g.strategy === 'latency') {
      const lat = (id: string) => r.nodes.find((h) => h.nodeId === id)?.latencyMs ?? Infinity
      next = [...others].sort((a, b) => lat(a) - lat(b))[0]
    }
    let after: string
    if (g.selection === 'manual') {
      after = next ? `会切到 ${outletName(next, c)}` : '没有其他启用的候选节点，会阻断这个分组的新连接'
    } else if (next) {
      after = `预计切到 ${outletName(next, c)}`
    } else {
      after =
        g.onAllFail === 'keep-last'
          ? // 要停用的正是当前节点，没法“保持”
            '没有其他可用节点，新连接很可能失败'
          : `没有其他可用节点，会${allFailLabel[g.onAllFail]}`
    }
    impacts.push({
      key: `${r.deviceId}/${r.groupId}`,
      where: `${d.name} 的「${g.name}」`,
      after,
      interrupt: g.interruptExisting,
      offline: !d.online,
    })
  }
  return { impacts, pinned, chosen, any: impacts.length + pinned + chosen > 0 }
}

function NodeTable({ c, rts }: { c: Catalog; rts: GroupRuntime[] }) {
  const update = useUpdateNode()
  const toast = useToast()
  const [confirm, setConfirm] = useState<ProxyNode | null>(null)

  const usage = usageOf(c)

  const apply = (n: ProxyNode, enabled: boolean) =>
    update.mutate(
      { id: n.id, enabled },
      {
        onSuccess: () => {
          setConfirm(null)
          const probed = usage.get(n.id) === 'probed'
          toast(enabled ? `已启用 ${n.tag}${probed ? '，Agent 下一轮开始探测它' : ''}` : `已停用 ${n.tag}`)
        },
        onError: (e) => toast(errorMessage(e), 'crit'),
      },
    )

  const toggle = (n: ProxyNode, enabled: boolean) => {
    if (!enabled && impactOf(n, c, rts).any) setConfirm(n)
    else apply(n, enabled)
  }

  const enabled = c.nodes.filter((n) => n.enabled).length
  const inUse = new Set(rts.map((r) => r.activeNodeId).filter((id) => id !== null)).size

  return (
    <div className={page.stackSm}>
      <p className={page.sub}>
        共 {c.nodes.length} 个节点，{enabled} 个启用，{inUse} 个正在作为出口。
      </p>
      <TableScroll label="节点" minWidth={960}>
        <table className={t.table}>
          <thead>
            <tr>
              <th>节点</th>
              <th>协议和地区</th>
              <th>各设备上的探测</th>
              <th>正在作为出口</th>
              <th>来源</th>
              <th className={t.actions}>启用</th>
            </tr>
          </thead>
          <tbody>
            {c.nodes.map((n) => (
              <tr key={n.id}>
                <td>
                  <div className={s.tag}>
                    <span className={t.name}>{n.tag}</span>
                    {!n.enabled && (
                      <Badge tone="offline" icon={CircleMinus}>
                        已停用
                      </Badge>
                    )}
                  </div>
                  <div className={cx(t.sub, 'mono')}>
                    {n.server}:{n.port}
                  </div>
                </td>
                <td>
                  <div>{protocolLabel[n.protocol]}</div>
                  <div className={t.sub}>{n.region}</div>
                </td>
                <td>
                  <Health n={n} c={c} rts={rts} usage={usage.get(n.id)} />
                </td>
                <td>
                  <Outlets n={n} c={c} rts={rts} />
                </td>
                <td className={t.sub}>{n.source}</td>
                <td className={t.actions}>
                  <Switch
                    checked={n.enabled}
                    label={`启用 ${n.tag}`}
                    pending={update.isPending && update.variables?.id === n.id}
                    onChange={(v) => toggle(n, v)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      {confirm && (
        <DisableDialog
          n={confirm}
          c={c}
          rts={rts}
          probed={usage.get(confirm.id) === 'probed'}
          pending={update.isPending}
          onClose={() => setConfirm(null)}
          onConfirm={() => apply(confirm, false)}
        />
      )}
    </div>
  )
}

interface HealthProps {
  n: ProxyNode
  c: Catalog
  rts: GroupRuntime[]
  usage?: Usage
}

function Health({ n, c, rts, usage }: HealthProps) {
  if (!n.enabled) return <span className={t.dim}>已停用，不再探测</span>
  if (!usage) {
    return (
      <span className={t.dim}>
        没有分组使用，<Link to="/groups">去分组里添加</Link>
      </span>
    )
  }
  if (usage === 'manual') return <span className={t.dim}>只用在手动选择的分组里，不探测</span>
  const buckets = healthByDevice(n, c, rts)
  const shown = (Object.keys(bucketLook) as Bucket[]).filter((b) => buckets[b].length)
  if (!shown.length) return <span className={t.dim}>待探测</span>
  return (
    <ul className={s.buckets}>
      {shown.map((b) => (
        <li key={b}>
          <ToneIcon tone={bucketLook[b].tone} icon={bucketLook[b].icon} size={15} />
          <span>
            <span className={s.bucketLabel}>{bucketLook[b].label}：</span>
            {keepNames(joinZh(buckets[b]))}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Outlets({ n, c, rts }: { n: ProxyNode; c: Catalog; rts: GroupRuntime[] }) {
  const mine = rts.filter((r) => r.activeNodeId === n.id)
  if (!mine.length) return <span className={t.dim}>—</span>
  return (
    <ul className={s.outlets}>
      {mine.map((r) => {
        const d = c.device.get(r.deviceId)
        const g = c.group.get(r.groupId)
        return (
          <li key={`${r.deviceId}/${r.groupId}`}>
            <Link to={`/devices/${r.deviceId}#group-${r.groupId}`}>{keepNames(d?.name ?? r.deviceId)}</Link>
            <span className={s.group}>「{g?.name ?? r.groupId}」</span>
            {g?.selection === 'manual' ? (
              <span className={s.flag}>
                <Hand aria-hidden />
                手动选择
              </span>
            ) : (
              r.pinnedNodeId === n.id && (
                <span className={s.flag}>
                  <Pin aria-hidden />
                  已固定
                </span>
              )
            )}
            {d && !d.online && <span className={s.flag}>离线前</span>}
          </li>
        )
      })}
    </ul>
  )
}

interface DisableProps {
  n: ProxyNode
  c: Catalog
  rts: GroupRuntime[]
  /** 有按规则自动切换的分组在探测它 */
  probed: boolean
  pending: boolean
  onClose: () => void
  onConfirm: () => void
}

function DisableDialog({ n, c, rts, probed, pending, onClose, onConfirm }: DisableProps) {
  const { impacts, pinned, chosen } = impactOf(n, c, rts)
  const cut = impacts.filter((x) => x.interrupt).length
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`停用 ${n.tag}？`}
      confirmLabel="停用"
      danger
      pending={pending}
      onConfirm={onConfirm}
    >
      {impacts.length > 0 && (
        <>
          <p>它是下面这些出口的当前节点，停用后会马上切走：</p>
          <ul className={s.impacts}>
            {impacts.map((x) => (
              <li key={x.key}>
                <span className={s.where}>{keepNames(x.where)}</span>
                {keepNames(x.after)}
                {x.interrupt && '，已有连接会断开'}
                {x.offline && '（设备离线，重新连上后生效）'}
              </li>
            ))}
          </ul>
          {cut < impacts.length && (
            <p>
              {cut ? '其余出口切换' : '切换'}只影响新连接，经过 {keepNames(n.tag)}{' '}
              的长连接（比如 SSH 会话、WebSocket）要断开重连才会走新的出口。
            </p>
          )}
        </>
      )}
      {pinned > 0 && <p>有 {pinned} 个出口手动固定在这个节点上，停用后会取消固定，恢复自动切换。</p>}
      <p>
        之后可以随时重新启用{probed ? '，Agent 会从下一轮开始重新探测它' : ''}。
        {chosen > 0 && `有 ${chosen} 个出口是在设备页手动选中它的，重新启用后不会自动选回。`}
      </p>
    </ConfirmDialog>
  )
}
