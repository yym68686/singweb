import { useState } from 'react'
import { Link, Outlet } from 'react-router'
import { Pencil, Plus, Split } from 'lucide-react'
import { outletName, useCatalog, type Catalog } from '../api/catalog'
import { useNow, useRuntimes } from '../api/hooks'
import type { Group, GroupRuntime } from '../api/types'
import { RuntimeBadge } from '../components/Badge'
import { Button, ButtonLink } from '../components/Button'
import { PageHeader } from '../components/PageHeader'
import { Dialog } from '../components/Dialog'
import { RecordRow } from '../components/RecordRow'
import { EmptyState, Loadable } from '../components/States'
import { candidateIds } from '../lib/candidates'
import { cx } from '../lib/cx'
import { formatFull, gapBefore, timeAgo } from '../lib/format'
import { filterText, matchText, rulesText, switchText } from '../lib/groupText'
import { groupDeviceIds } from '../lib/groups'
import { keepNames } from '../lib/keepNames'
import { allFailLabel, strategyLabel } from '../lib/labels'
import page from '../styles/page.module.css'
import s from './Groups.module.css'

export default function Groups() {
  const catalog = useCatalog()
  const runtimes = useRuntimes()
  const now = useNow()
  const data = catalog.data && runtimes.data ? { c: catalog.data, rts: runtimes.data } : undefined

  return (
    <>
      <PageHeader
        title="分组"
        metadata={catalog.data && `${catalog.data.groups.length} 个分组`}
        actions={
          <ButtonLink to="/groups/new" preventScrollReset variant="primary" icon={Plus}>
            新建分组
          </ButtonLink>
        }
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
          c.groups.length ? (
            <div className={page.stack}>
              {c.groups.map((g) => (
                <GroupCard key={g.id} g={g} c={c} rts={rts} now={now} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Split}
              title="还没有分组"
              action={
                <ButtonLink to="/groups/new" preventScrollReset variant="primary" icon={Plus}>
                  新建分组
                </ButtonLink>
              }
            />
          )
        }
      </Loadable>
      <Outlet />
    </>
  )
}

function GroupCard({ g, c, rts, now }: { g: Group; c: Catalog; rts: GroupRuntime[]; now: number }) {
  const [details, setDetails] = useState(false)
  const auto = g.selection === 'auto'
  const tags = candidateIds(g, c.nodes).map((id) => {
    const n = c.node.get(id)
    return n ? `${n.tag}${n.enabled ? '' : '（已停用）'}` : id
  })
  const strategy = auto ? `${strategyLabel[g.strategy]}：` : ''

  return (
    <>
      <RecordRow
        icon={Split}
        title={<Link to={`/groups/${g.id}`} preventScrollReset>{g.name}</Link>}
        description={<>{auto ? strategyLabel[g.strategy] : '手动选择'} · {tags.length} 节点 · {groupDeviceIds(g, c.devices).length} 设备</>}
        actions={<><Button variant="ghost" size="sm" onClick={() => setDetails(true)} aria-label={`详情 ${g.name}`}>详情</Button><ButtonLink to={`/groups/${g.id}`} preventScrollReset size="sm" icon={Pencil} aria-label={`编辑${gapBefore(g.name)}${g.name}`}>编辑</ButtonLink></>}
      />
      <Dialog open={details} onClose={() => setDetails(false)} title={g.name} wide>
      <header className={page.panelHead}>
        <span className={page.sub}>
          <time dateTime={g.updatedAt} title={formatFull(g.updatedAt)}>{timeAgo(g.updatedAt, now)}</time> 修改
        </span>
        <ButtonLink
          to={`/groups/${g.id}`}
          preventScrollReset
          onClick={() => setDetails(false)}
          size="sm"
          variant="ghost"
          icon={Pencil}
          aria-label={`编辑${gapBefore(g.name)}${g.name}`}
        >
          编辑
        </ButtonLink>
      </header>

      <div className={s.body}>
        <dl className={cx(page.meta, s.rules)}>
          <dt>selector</dt>
          <dd className="mono">{keepNames(g.selectorTag)}</dd>
          <dt>接管的流量</dt>
          <dd>{keepNames(matchText(g.match))}</dd>
          <dt>候选节点</dt>
          <dd>
            {g.candidates.mode === 'list' ? (
              <>
                {strategy}
                {tags.length ? keepNames(tags.join('、')) : '没有节点'}
              </>
            ) : (
              <>
                {strategy}
                {keepNames(filterText(g.candidates.filter))}
                <div className={page.sub}>
                  {tags.length ? (
                    <>
                      现在 {tags.length} 个：{keepNames(tags.join('、'))}
                    </>
                  ) : (
                    '现在没有节点符合条件'
                  )}
                </div>
              </>
            )}
          </dd>
          <dt>分组规则</dt>
          <dd>{keepNames(rulesText(g, c.target))}</dd>
          <dt>切换方式</dt>
          <dd>
            {auto
              ? switchText(g)
              : `在设备页选节点，${g.interruptExisting ? '切换时断开已有连接' : '已有连接不断开'}`}
          </dd>
          {auto && (
            <>
              <dt>全部不可用时</dt>
              <dd>{allFailLabel[g.onAllFail]}</dd>
            </>
          )}
        </dl>

        <div className={s.devices}>
          <h3 className={s.devicesTitle}>各设备上的出口</h3>
          <DeviceStatus g={g} c={c} rts={rts} />
        </div>
      </div>
      </Dialog>
    </>
  )
}

function DeviceStatus({ g, c, rts }: { g: Group; c: Catalog; rts: GroupRuntime[] }) {
  const ids = groupDeviceIds(g, c.devices)
  if (!ids.length) {
    return (
      <p className={page.sub}>
        {g.deviceIds.length ? '选中的设备都已经删除了。' : '应用到所有设备，现在还没有设备接入。'}
      </p>
    )
  }
  return (
    <ul className={s.deviceList}>
      {ids.map((id) => {
        const d = c.device.get(id)
        const rt = rts.find((r) => r.deviceId === id && r.groupId === g.id)
        return (
          <li key={id} className={s.device}>
            <Link to={`/devices/${id}#group-${g.id}`} className={s.deviceName}>
              {keepNames(d?.name ?? id)}
            </Link>
            <span className={s.outlet}>{rt ? keepNames(outletName(rt.activeNodeId, c)) : '—'}</span>
            {rt ? <RuntimeBadge state={rt.state} /> : <span className={page.sub}>等待 Agent 上报</span>}
          </li>
        )
      })}
    </ul>
  )
}
