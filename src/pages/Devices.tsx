import { Link } from 'react-router'
import { Laptop, TriangleAlert, Wifi, WifiOff } from 'lucide-react'
import { groupsOf, outletName, useCatalog, type Catalog } from '../api/catalog'
import { useNow, useRuntimes } from '../api/hooks'
import type { Device, GroupRuntime } from '../api/types'
import { Badge, RuntimeBadge } from '../components/Badge'
import { TableScroll } from '../components/DataTable'
import { PageHeader } from '../components/PageHeader'
import { EmptyState, Loadable } from '../components/States'
import { Tooltip } from '../components/Tooltip'
import { cx } from '../lib/cx'
import { formatFull, timeAgo } from '../lib/format'
import { osText } from '../lib/labels'
import { MIN_SINGBOX, versionAtLeast } from '../lib/singbox'
import t from '../components/DataTable.module.css'
import s from './Devices.module.css'

export default function Devices() {
  const catalog = useCatalog()
  const runtimes = useRuntimes()
  const now = useNow()
  const data = catalog.data && runtimes.data ? { c: catalog.data, rts: runtimes.data } : undefined

  return (
    <>
      <PageHeader
        title="设备"
        description="装了 singweb Agent 的设备。Agent 在设备本地按分组规则逐个节点探测，并通过 sing-box 的 Clash API 切换各分组的节点。"
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
          c.devices.length ? (
            <DeviceTable c={c} rts={rts} now={now} />
          ) : (
            <EmptyState icon={Laptop} title="还没有设备">
              在设备上启动 singweb Agent 并指向这个管理服务，设备会自动出现在这里。
            </EmptyState>
          )
        }
      </Loadable>
    </>
  )
}

function DeviceTable({ c, rts, now }: { c: Catalog; rts: GroupRuntime[]; now: number }) {
  return (
    <TableScroll label="设备" minWidth={820}>
      <table className={t.table}>
        <thead>
          <tr>
            <th>设备</th>
            <th>连接</th>
            <th>各分组的出口</th>
            <th>系统和版本</th>
          </tr>
        </thead>
        <tbody>
          {c.devices.map((d) => (
            <tr key={d.id}>
              <td>
                <Link to={`/devices/${d.id}`} className={t.name}>
                  {d.name}
                </Link>
                <div className={cx(t.sub, 'mono')}>{d.hostname}</div>
                {d.note && <div className={t.sub}>{d.note}</div>}
              </td>
              <td className={t.nowrap}>
                <Presence d={d} now={now} />
              </td>
              <td>
                <Outlets d={d} c={c} rts={rts} />
              </td>
              <td>
                <Versions d={d} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  )
}

export function Presence({ d, now }: { d: Device; now: number }) {
  return (
    <>
      {d.online ? (
        <Badge tone="good" icon={Wifi}>
          在线
        </Badge>
      ) : (
        <Badge tone="offline" icon={WifiOff}>
          离线
        </Badge>
      )}
      <div className={t.sub}>
        <time dateTime={d.lastSeenAt} title={formatFull(d.lastSeenAt)}>
          {timeAgo(d.lastSeenAt, now)}
        </time>
        上报
      </div>
    </>
  )
}

function Outlets({ d, c, rts }: { d: Device; c: Catalog; rts: GroupRuntime[] }) {
  const groups = groupsOf(c, d.id)
  if (!groups.length) return <span className={t.dim}>没有应用分组</span>
  return (
    <ul className={s.outlets}>
      {groups.map((g) => {
        const rt = rts.find((r) => r.deviceId === d.id && r.groupId === g.id)
        return (
          <li key={g.id} className={s.outlet}>
            <span className={s.group}>{g.name}</span>
            <span className={s.node}>{rt && rt.activeNodeId !== null ? outletName(rt.activeNodeId, c) : '—'}</span>
            {rt && <RuntimeBadge state={rt.state} />}
          </li>
        )
      })}
    </ul>
  )
}

function Versions({ d }: { d: Device }) {
  const old = !versionAtLeast(d.singboxVersion, MIN_SINGBOX)
  return (
    <>
      <div>{osText(d)}</div>
      <div className={cx(t.sub, s.versions)}>
        <span>sing-box {d.singboxVersion}</span>
        {old && (
          <Tooltip content={`singweb 生成的路由规则需要 sing-box ${MIN_SINGBOX} 或更新的版本。`} focusable>
            <span className={s.old}>
              <TriangleAlert aria-hidden />
              版本过低
            </span>
          </Tooltip>
        )}
        <span>Agent {d.agentVersion}</span>
      </div>
    </>
  )
}
