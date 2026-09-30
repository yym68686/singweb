import { useSearchParams } from 'react-router'
import { History, ListFilter, X } from 'lucide-react'
import { useCatalog, type Catalog } from '../api/catalog'
import { errorMessage } from '../api/errors'
import { useEvents, useNow } from '../api/hooks'
import type { EventKind, EventQuery, Severity } from '../api/types'
import { Button } from '../components/Button'
import { EventList } from '../components/EventList'
import { Field, Select } from '../components/Form'
import { PageHeader } from '../components/PageHeader'
import { Segmented } from '../components/Segmented'
import { EmptyState, ErrorState, Loadable, LoadingState } from '../components/States'
import { cx } from '../lib/cx'
import page from '../styles/page.module.css'
import s from './Events.module.css'

type TypeKey = 'switch' | 'fault' | 'recover' | 'manual' | 'device' | 'config'

/** 筛选用的事件类型：把成对的事件归到一起 */
const TYPES: Record<TypeKey, { label: string; kinds: EventKind[] }> = {
  switch: { label: '切换节点', kinds: ['switch'] },
  fault: { label: '节点故障', kinds: ['node-down', 'all-down'] },
  recover: { label: '恢复', kinds: ['node-up', 'recovered'] },
  manual: { label: '手动固定', kinds: ['pin', 'unpin'] },
  device: { label: '设备上下线', kinds: ['device-offline', 'device-online'] },
  config: { label: '配置变更', kinds: ['group-changed', 'node-changed'] },
}

type Level = 'all' | 'attention' | 'crit'

const LEVELS: Record<Level, { label: string; severities?: Severity[] }> = {
  all: { label: '全部' },
  attention: { label: '警告和严重', severities: ['warn', 'crit'] },
  crit: { label: '只看严重', severities: ['crit'] },
}

const PAGE_SIZE = 30

export default function Events() {
  const catalog = useCatalog()
  return (
    <>
      <PageHeader
        title="事件记录"
        description="节点切换、故障和恢复、手动固定、设备上下线和配置变更都记在这里。切换事件会写明从哪个节点切到哪个节点，以及为什么切。"
      />
      <Loadable data={catalog.data} error={catalog.error} retry={catalog.retry}>
        {(c) => <EventsBody c={c} />}
      </Loadable>
    </>
  )
}

function EventsBody({ c }: { c: Catalog }) {
  const [params, setParams] = useSearchParams()
  const now = useNow()

  // 链接里的参数无效时当作没选
  const device = c.device.get(params.get('device') ?? '')
  const group = c.group.get(params.get('group') ?? '')
  const typeParam = params.get('type')
  const type = typeParam && Object.hasOwn(TYPES, typeParam) ? (typeParam as TypeKey) : null
  const levelParam = params.get('level')
  const level: Level = levelParam === 'attention' || levelParam === 'crit' ? levelParam : 'all'
  const filtered = !!(device || group || type || level !== 'all')

  const query: EventQuery = {
    deviceId: device?.id,
    groupId: group?.id,
    kinds: type ? TYPES[type].kinds : undefined,
    severities: LEVELS[level].severities,
    limit: PAGE_SIZE,
  }
  const events = useEvents(query)
  const items = events.data?.pages.flatMap((p) => p.items)

  const set = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true },
    )
  const clear = () => setParams({}, { replace: true })

  return (
    <div className={page.stackSm}>
      <div className={cx(page.toolbar, s.toolbar)}>
        <Field label="设备">
          {(a) => (
            <Select {...a} value={device?.id ?? ''} onChange={(e) => set('device', e.target.value)}>
              <option value="">全部设备</option>
              {c.devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.online ? '' : '（离线）'}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="分组">
          {(a) => (
            <Select {...a} value={group?.id ?? ''} onChange={(e) => set('group', e.target.value)}>
              <option value="">全部分组</option>
              {c.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="类型">
          {(a) => (
            <Select {...a} value={type ?? ''} onChange={(e) => set('type', e.target.value)}>
              <option value="">全部类型</option>
              {(Object.keys(TYPES) as TypeKey[]).map((k) => (
                <option key={k} value={k}>
                  {TYPES[k].label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Segmented<Level>
          legend="级别"
          value={level}
          onChange={(v) => set('level', v === 'all' ? null : v)}
          options={(Object.keys(LEVELS) as Level[]).map((k) => ({ value: k, label: LEVELS[k].label }))}
        />
        {filtered && (
          <Button variant="ghost" icon={X} onClick={clear}>
            清除筛选
          </Button>
        )}
      </div>

      {items === undefined ? (
        events.error ? (
          <ErrorState error={events.error} onRetry={() => void events.refetch()} />
        ) : (
          <LoadingState />
        )
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={ListFilter}
            title="没有符合筛选条件的事件"
            action={
              <Button icon={X} onClick={clear}>
                清除筛选
              </Button>
            }
          >
            换个设备、分组、类型或级别试试。
          </EmptyState>
        ) : (
          <EmptyState icon={History} title="还没有事件">
            Agent 连上控制端之后，节点切换、故障和恢复都会记在这里。
          </EmptyState>
        )
      ) : (
        <div
          className={cx(s.results, events.isPlaceholderData && s.busy)}
          aria-busy={events.isPlaceholderData || undefined}
        >
          <p className={page.sub} role="status">
            {events.hasNextPage ? `显示最近的 ${items.length} 条` : `共 ${items.length} 条`}
          </p>
          <EventList events={items} catalog={c} now={now} groupByDay />
          <div className={s.more}>
            {events.hasNextPage ? (
              <Button onClick={() => void events.fetchNextPage()} pending={events.isFetchingNextPage}>
                加载更早的事件
              </Button>
            ) : (
              <p className={page.sub}>没有更早的事件了。</p>
            )}
            {events.isFetchNextPageError && (
              <p className={s.moreError} role="alert">
                没能加载更早的事件：{errorMessage(events.error)}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
