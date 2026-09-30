import { Link } from 'react-router'
import { ArrowRight, Laptop, Split } from 'lucide-react'
import type { AppEvent } from '../api/types'
import { outletName, type Catalog } from '../api/catalog'
import { cx } from '../lib/cx'
import { formatDay, formatFull, formatTime, localDay, timeAgo } from '../lib/format'
import { keepNames } from '../lib/keepNames'
import { eventKindLabel, severityLabel } from '../lib/labels'
import { eventIcon, severityLook } from '../lib/status'
import { ToneIcon } from './Badge'
import s from './EventList.module.css'

/** 这几类事件带有“从哪个节点到哪个节点” */
const HOP_KINDS = new Set<AppEvent['kind']>(['switch', 'all-down', 'recovered'])

interface EventListProps {
  events: AppEvent[]
  catalog: Catalog
  now: number
  /** 紧凑模式：相对时间，不显示设备和分组的链接 */
  compact?: boolean
  /** 按天分组（完整事件页） */
  groupByDay?: boolean
}

export function EventList({ events, catalog, now, compact, groupByDay }: EventListProps) {
  if (!groupByDay) {
    return (
      <ol className={cx(s.list, compact && s.compact)}>
        {events.map((e) => (
          <EventRow key={e.id} event={e} catalog={catalog} now={now} compact={compact} />
        ))}
      </ol>
    )
  }

  const days: { key: string; items: AppEvent[] }[] = []
  for (const e of events) {
    const key = localDay(e.at)
    const last = days[days.length - 1]
    if (last?.key === key) last.items.push(e)
    else days.push({ key, items: [e] })
  }

  return (
    <div className={s.days}>
      {days.map((d) => (
        <section key={d.key} className={s.day}>
          <h2 className={s.dayTitle}>{formatDay(d.items[0].at, now)}</h2>
          <ol className={s.list}>
            {d.items.map((e) => (
              <EventRow key={e.id} event={e} catalog={catalog} now={now} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}

function EventRow({ event: e, catalog, now, compact }: { event: AppEvent; catalog: Catalog; now: number; compact?: boolean }) {
  const look = severityLook[e.severity]
  const device = e.deviceId ? catalog.device.get(e.deviceId) : undefined
  const group = e.groupId ? catalog.group.get(e.groupId) : undefined
  // 全部不可用但按分组设置保持原节点时，起止相同，消息里已经写了“保持 JP-01”
  const hop = HOP_KINDS.has(e.kind) && (e.from !== undefined || e.to !== undefined) && e.from !== e.to

  return (
    <li className={cx(s.row, s[look.tone])}>
      <time className={s.time} dateTime={e.at} title={formatFull(e.at)}>
        {compact ? timeAgo(e.at, now) : formatTime(e.at)}
      </time>
      <span className={s.icon}>
        <ToneIcon tone={look.tone} icon={eventIcon[e.kind]} size={16} />
      </span>
      <div className={s.body}>
        <p className={s.head}>
          <span className={s.kind}>{eventKindLabel[e.kind]}</span>
          {e.severity !== 'info' && <span className="visually-hidden">（{severityLabel[e.severity]}）</span>}
          {hop && (
            <span className={s.hop}>
              <span className="nowrap">{outletName(e.from, catalog)}</span>
              <ArrowRight aria-label="到" role="img" />
              <span className="nowrap">{outletName(e.to, catalog)}</span>
            </span>
          )}
        </p>
        <p className={s.message}>{keepNames(e.message)}</p>
        {!compact && (device || group) && (
          <p className={s.context}>
            {device && (
              <Link to={`/devices/${device.id}`}>
                <Laptop aria-hidden />
                {device.name}
              </Link>
            )}
            {group && (
              <Link to={`/groups/${group.id}`}>
                <Split aria-hidden />
                {group.name}
              </Link>
            )}
          </p>
        )}
        {compact && device && <p className={s.contextPlain}>{keepNames(group ? `${device.name}，${group.name}` : device.name)}</p>}
      </div>
    </li>
  )
}
