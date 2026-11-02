import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { CircleCheck, ClockFading, Laptop, OctagonAlert, TriangleAlert, WifiOff } from 'lucide-react'
import { groupsOf, outletName, useCatalog, type Catalog } from '../api/catalog'
import { useEvents, useNow, useRuntimes } from '../api/hooks'
import type { Device, GroupRuntime } from '../api/types'
import { Badge, RuntimeBadge, ToneIcon } from '../components/Badge'
import { Button, ButtonLink } from '../components/Button'
import { EventList } from '../components/EventList'
import { Dialog } from '../components/Dialog'
import { RecordRow } from '../components/RecordRow'
import { Section } from '../components/PageHeader'
import { RouteStrip } from '../components/RouteStrip'
import { EmptyState, ErrorState, Loadable, LoadingState } from '../components/States'
import { cx } from '../lib/cx'
import { hopText, runtimeHeadline, runtimeNote } from '../lib/explain'
import { formatFull, timeAgo } from '../lib/format'
import { keepNames } from '../lib/keepNames'
import { runtimeLabel } from '../lib/labels'
import { isCritical, runtimeLook, runtimeRank } from '../lib/status'
import { useTitle } from '../lib/useTitle'
import page from '../styles/page.module.css'
import s from './Overview.module.css'

interface Props {
  c: Catalog
  rts: GroupRuntime[]
  now: number
}

const byRank = (a: GroupRuntime, b: GroupRuntime) => runtimeRank[a.state] - runtimeRank[b.state]

export default function Overview() {
  useTitle('总览')
  const catalog = useCatalog()
  const runtimes = useRuntimes()
  const now = useNow()
  const data = catalog.data && runtimes.data ? { c: catalog.data, rts: runtimes.data } : undefined

  return (
    <Loadable
      data={data}
      error={catalog.error ?? runtimes.error}
      retry={() => {
        catalog.retry()
        void runtimes.refetch()
      }}
    >
      {({ c, rts }) => (
        <div className={page.stack}>
          <Hero c={c} rts={rts} now={now} />
          <div className={s.grid}>
            <Attention c={c} rts={rts} now={now} />
            <Outlets c={c} rts={rts} now={now} />
            <RecentEvents c={c} now={now} />
          </div>
        </div>
      )}
    </Loadable>
  )
}

/** 一句话说清现在的状况；只有一个出口出问题时直接点名 */
function Hero({ c, rts, now }: Props) {
  const critical = rts.filter((r) => isCritical(r.state)).sort(byRank)
  const degraded = rts.filter((r) => r.state === 'degraded')
  const online = c.devices.filter((d) => d.online).length
  const offline = c.devices.length - online
  const brokenDevices = c.devices.filter((device) => device.online && device.singboxError)

  let tone: 'crit' | 'warn' | 'good'
  let title: string
  let action: ReactNode = null
  if (!c.devices.length) {
    tone = 'good'
    title = '接入第一台设备'
    action = <ButtonLink to="/devices" variant="primary" icon={Laptop}>接入设备</ButtonLink>
  } else if (!online) {
    tone = 'warn'
    title = '所有设备都已离线'
    action = <ButtonLink to="/devices" icon={Laptop}>检查设备</ButtonLink>
  } else if (brokenDevices.length) {
    tone = 'crit'
    title = `${brokenDevices.length} 台设备的 sing-box 未正常运行`
    action = <ButtonLink to={`/devices/${brokenDevices[0].id}`} variant="primary" icon={Laptop}>查看故障设备</ButtonLink>
  } else if (!rts.length) {
    tone = 'warn'
    title = '等待设备上报出口状态'
  } else if (critical.length === 1) {
    const r = critical[0]
    const d = c.device.get(r.deviceId)
    tone = 'crit'
    title = `${d?.name ?? r.deviceId} 的「${c.group.get(r.groupId)?.name ?? r.groupId}」${runtimeHeadline[r.state]}`
    action = (
      <ButtonLink to={`/devices/${r.deviceId}`} variant="primary" icon={Laptop}>
        查看这台设备
      </ButtonLink>
    )
  } else if (critical.length > 1) {
    tone = 'crit'
    title = `有 ${critical.length} 个出口需要处理`
  } else if (degraded.length) {
    tone = 'warn'
    title = `出口都能用，但有 ${degraded.length} 个没有备用节点`
  } else {
    tone = 'good'
    title = offline ? '在线设备的出口都正常' : '所有出口都正常'
  }
  const Icon = tone === 'crit' ? OctagonAlert : tone === 'warn' ? TriangleAlert : CircleCheck

  const last = rts
    .filter((r) => r.lastSwitch)
    .sort((a, b) => Date.parse(b.lastSwitch!.at) - Date.parse(a.lastSwitch!.at))[0]

  return (
    <section className={cx(s.hero, s[tone])} aria-labelledby="overview-title">
      <span className={s.lamp}>
        <Icon aria-hidden />
      </span>
      <div className={s.heroText}>
        <div className={s.heroLine}>
          <h1 id="overview-title" className={s.headline}>{title}</h1>
          {action && <div className={s.heroAction}>{action}</div>}
        </div>
        <p className={s.summary}>
          {online} 在线 · {offline} 离线 · {rts.length} 个出口
          {last?.lastSwitch && (
            <>
              {' '}· 最近切换 {keepNames(c.device.get(last.deviceId)?.name ?? '')} · {keepNames(c.group.get(last.groupId)?.name ?? '')}
              <time dateTime={last.lastSwitch.at} title={formatFull(last.lastSwitch.at)}>
                {timeAgo(last.lastSwitch.at, now)}
              </time>
              {' '}{keepNames(hopText(last.lastSwitch.from, last.lastSwitch.to, c))}
            </>
          )}
        </p>
      </div>
    </section>
  )
}

/** 除了“正常”和“手动选择”以外的出口，按严重程度排列 */
function Attention({ c, rts, now }: Props) {
  const devices = c.devices.filter((d) => !d.online || d.singboxError)
  const items = rts
    .filter((r) => !['ok', 'manual', 'pinned', 'stale'].includes(r.state) && c.device.get(r.deviceId)?.online)
    .sort(byRank)
  const count = devices.length + items.length
  if (!count) return null
  return (
    <Section title={<>需要注意 <span className={s.attentionCount}>{count}</span></>} id="attention" className={s.attention}>
      <ul className={cx(page.panel, s.attnList)}>
        {devices.map((d) => (
          <li key={d.id} className={cx(s.attnItem, d.online ? s.crit : undefined)}>
            <ToneIcon tone={d.online ? 'crit' : 'offline'} icon={d.online ? OctagonAlert : WifiOff} size={18} />
            <div className={s.attnBody}>
              <div className={s.attnLine}>
                <Link to={`/devices/${d.id}`}>{keepNames(d.name)}</Link>
                <span className={s.attnTitle}>{d.online ? 'sing-box 故障' : '设备离线'}</span>
                {!d.online && <time className={s.attnText} dateTime={d.lastSeenAt}>{timeAgo(d.lastSeenAt, now)}</time>}
              </div>
              {d.online && <p className={s.attnText}>{d.singboxError}</p>}
            </div>
          </li>
        ))}
        {items.map((r) => {
          const look = runtimeLook[r.state]
          return (
            <li key={`${r.deviceId}/${r.groupId}`} className={cx(s.attnItem, s[look.tone])}>
              <ToneIcon tone={look.tone} icon={look.icon} size={18} />
              <div className={s.attnBody}>
                <div className={s.attnLine}>
                  <Link to={`/devices/${r.deviceId}`}>{keepNames(c.device.get(r.deviceId)?.name ?? r.deviceId)}</Link>
                  <span>{c.group.get(r.groupId)?.name ?? r.groupId}</span>
                  <span className={s.attnTitle}>{runtimeLabel[r.state]}</span>
                </div>
                <p className={s.attnText}>{keepNames(runtimeNote(r, c, now))}</p>
              </div>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

function Outlets({ c, rts, now }: Props) {
  // 离线设备排在后面，其余保持配置里的顺序，方便每次在同一个位置找到同一台设备
  const devices = [...c.devices].sort((a, b) => Number(b.online) - Number(a.online))
  return (
    <Section
      title="当前出口"
      className={s.outlets}
    >
      {devices.length ? (
        <div className={page.stackSm}>
          {devices.map((d) => (
            <DevicePanel key={d.id} d={d} c={c} rts={rts} now={now} />
          ))}
        </div>
      ) : (
        <EmptyState icon={Laptop} title="暂无设备" />
      )}
    </Section>
  )
}

function DevicePanel({ d, c, rts, now }: Props & { d: Device }) {
  const [detailGroup, setDetailGroup] = useState<string | null>(null)
  const groups = groupsOf(c, d.id)
  const mine = rts.filter((r) => r.deviceId === d.id)
  const selected = groups.find((g) => g.id === detailGroup)
  const selectedRuntime = mine.find((r) => r.groupId === detailGroup)
  const lastRound = mine
    .map((r) => r.lastRoundAt)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1)

  return (
    <section className={s.device} aria-label={d.name}>
      <RecordRow icon={Laptop}
        title={<Link to={`/devices/${d.id}`}>{d.name}</Link>}
        description={d.online && lastRound ? <>上次探测 <time dateTime={lastRound}>{timeAgo(lastRound, now)}</time></> : d.hostname}
        status={<Badge tone={d.online && d.singboxError ? 'crit' : d.online ? 'good' : 'offline'}>{d.online && d.singboxError ? 'sing-box 故障' : d.online ? '在线' : `离线 · ${timeAgo(d.lastSeenAt, now)}`}</Badge>}
        actions={<ButtonLink size="sm" variant="ghost" to={`/devices/${d.id}`}>设备详情</ButtonLink>}
      />
      {groups.length ? (
        <ul className={s.routes}>
          {groups.map((g) => {
            const rt = mine.find((r) => r.groupId === g.id)
            return (
              <li key={g.id}>
                <RecordRow title={g.name}
                  description={rt ? <span className={s.outletName}>{keepNames(outletName(rt.activeNodeId, c))}</span> : '等待 Agent 上报'}
                  status={rt && <RuntimeBadge state={rt.state} />}
                  actions={<Button size="sm" variant="ghost" aria-label={`查看 ${d.name} ${g.name} 出口`} onClick={() => setDetailGroup(g.id)}>查看出口</Button>}
                />
              </li>
            )
          })}
        </ul>
      ) : (
        <p className={cx(page.panelBody, page.sub)}>
          未应用分组 · <Link to="/groups">去分组设置</Link>
        </p>
      )}
      {selected && <Dialog open onClose={() => setDetailGroup(null)} title={`${d.name} · ${selected.name}`} wide>
        {selectedRuntime ? <RouteStrip runtime={selectedRuntime} group={selected} nodes={c.node} targets={c.target} label={`${d.name}「${selected.name}」的当前出口`} /> : <p className={page.sub}>Agent 还没有上报这个分组的状态。</p>}
      </Dialog>}
    </section>
  )
}

function RecentEvents({ c, now }: { c: Catalog; now: number }) {
  const events = useEvents({ limit: 5 })
  const items = events.data?.pages[0]?.items
  return (
    <Section title="最近事件" className={s.events} actions={<Link to="/events">全部事件</Link>}>
      {items ? (
        items.length ? (
          <EventList events={items} catalog={c} now={now} compact />
        ) : (
          <EmptyState icon={ClockFading} title="暂无事件" />
        )
      ) : events.error ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : (
        <LoadingState />
      )}
    </Section>
  )
}
