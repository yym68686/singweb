import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { CircleCheck, ClockFading, Laptop, OctagonAlert, TriangleAlert, WifiOff } from 'lucide-react'
import { groupsOf, useCatalog, type Catalog } from '../api/catalog'
import { useEvents, useNow, useRuntimes } from '../api/hooks'
import type { Device, GroupRuntime } from '../api/types'
import { Badge, RuntimeBadge, ToneIcon } from '../components/Badge'
import { ButtonLink } from '../components/Button'
import { EventList } from '../components/EventList'
import { Section } from '../components/PageHeader'
import { RouteLegend, RouteStrip } from '../components/RouteStrip'
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

  let tone: 'crit' | 'warn' | 'good'
  let title: string
  let action: ReactNode = null
  if (critical.length === 1) {
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
        <h1 id="overview-title" className={s.headline}>
          {title}
        </h1>
        <p className={s.summary}>
          {online} 台设备在线{offline > 0 && `，${offline} 台离线`}，共 {rts.length} 个出口。
          {last?.lastSwitch && (
            <>
              最近一次切换：{keepNames(c.device.get(last.deviceId)?.name ?? '')} 的「{c.group.get(last.groupId)?.name}」
              <time dateTime={last.lastSwitch.at} title={formatFull(last.lastSwitch.at)}>
                {timeAgo(last.lastSwitch.at, now)}
              </time>
              {keepNames(hopText(last.lastSwitch.from, last.lastSwitch.to, c))}。
            </>
          )}
        </p>
        {action && <div className={s.heroAction}>{action}</div>}
      </div>
    </section>
  )
}

/** 除了“正常”和“手动选择”以外的出口，按严重程度排列 */
function Attention({ c, rts, now }: Props) {
  const items = rts.filter((r) => r.state !== 'ok' && r.state !== 'manual').sort(byRank)
  if (!items.length) return null
  return (
    <Section title="需要注意" id="attention" className={s.attention}>
      <ul className={cx(page.panel, s.attnList)}>
        {items.map((r) => {
          const look = runtimeLook[r.state]
          return (
            <li key={`${r.deviceId}/${r.groupId}`} className={cx(s.attnItem, s[look.tone])}>
              <ToneIcon tone={look.tone} icon={look.icon} size={18} />
              <div className={s.attnBody}>
                <p className={s.attnTitle}>{runtimeLabel[r.state]}</p>
                <p className={s.attnWhere}>
                  <Link to={`/devices/${r.deviceId}`}>{keepNames(c.device.get(r.deviceId)?.name ?? r.deviceId)}</Link>
                  ，{c.group.get(r.groupId)?.name ?? r.groupId}
                </p>
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
      description="每一行是设备上的一个分组：跳线插在哪个节点上，这个分组接管的流量就从哪个节点出去。把鼠标移到节点上可以看到探测详情。"
      actions={<RouteLegend />}
      className={s.outlets}
    >
      {devices.length ? (
        <div className={page.stackSm}>
          {devices.map((d) => (
            <DevicePanel key={d.id} d={d} c={c} rts={rts} now={now} />
          ))}
        </div>
      ) : (
        <EmptyState icon={Laptop} title="还没有设备">
          在设备上安装并启动 singweb Agent，它会自动出现在这里。
        </EmptyState>
      )}
    </Section>
  )
}

function DevicePanel({ d, c, rts, now }: Props & { d: Device }) {
  const groups = groupsOf(c, d.id)
  const mine = rts.filter((r) => r.deviceId === d.id)
  const lastRound = mine
    .map((r) => r.lastRoundAt)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1)

  return (
    <article className={page.panel} aria-labelledby={`dev-${d.id}`}>
      <header className={page.panelHead}>
        <h3 id={`dev-${d.id}`} className={page.panelTitle}>
          <Link to={`/devices/${d.id}`}>{d.name}</Link>
          <span className={cx('mono', page.sub)}>{d.hostname}</span>
        </h3>
        {d.online ? (
          lastRound && (
            <span className={page.sub}>
              上一轮探测：<time dateTime={lastRound}>{timeAgo(lastRound, now)}</time>
            </span>
          )
        ) : (
          <Badge tone="offline" icon={WifiOff}>
            {timeAgo(d.lastSeenAt, now)}离线
          </Badge>
        )}
      </header>
      {groups.length ? (
        <ul className={s.routes}>
          {groups.map((g) => {
            const rt = mine.find((r) => r.groupId === g.id)
            return (
              <li key={g.id} className={s.route}>
                <div className={s.routeHead}>
                  <span className={s.group}>{g.name}</span>
                  {rt && <RuntimeBadge state={rt.state} />}
                  {rt?.lastSwitch && (
                    <span className={s.lastSwitch}>
                      <time dateTime={rt.lastSwitch.at} title={formatFull(rt.lastSwitch.at)}>
                        {timeAgo(rt.lastSwitch.at, now)}
                      </time>
                      {keepNames(hopText(rt.lastSwitch.from, rt.lastSwitch.to, c))}
                    </span>
                  )}
                </div>
                {rt ? (
                  <RouteStrip
                    runtime={rt}
                    group={g}
                    nodes={c.node}
                    targets={c.target}
                    label={`${d.name}「${g.name}」的当前出口`}
                  />
                ) : (
                  <p className={page.sub}>Agent 还没有上报这个分组的状态。</p>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className={cx(page.panelBody, page.sub)}>
          这台设备还没有应用任何分组。到<Link to="/groups">分组</Link>里把它加进去。
        </p>
      )}
    </article>
  )
}

function RecentEvents({ c, now }: { c: Catalog; now: number }) {
  const events = useEvents({ limit: 8 })
  const items = events.data?.pages[0]?.items
  return (
    <Section title="最近事件" className={s.events} actions={<Link to="/events">查看全部事件</Link>}>
      {items ? (
        items.length ? (
          <EventList events={items} catalog={c} now={now} compact />
        ) : (
          <EmptyState icon={ClockFading} title="还没有事件">
            切换节点、节点故障和恢复都会记录在这里。
          </EmptyState>
        )
      ) : events.error ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : (
        <LoadingState />
      )}
    </Section>
  )
}
