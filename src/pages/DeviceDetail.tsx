import { useId } from 'react'
import { Link, useParams } from 'react-router'
import { ChevronDown, CircleMinus, ClockFading, Laptop, Pencil, Pin, Radar, Split } from 'lucide-react'
import { groupsOf, outletName, useCatalog, type Catalog } from '../api/catalog'
import { errorMessage } from '../api/errors'
import { useEvents, useNow, useProbeCells, useProbeNow, useRuntimes, useSetPin } from '../api/hooks'
import { DIRECT, type Device, type Group, type GroupRuntime, type NodeHealth, type ProbeDetail } from '../api/types'
import { Badge, HealthBadge, RuntimeBadge } from '../components/Badge'
import { Button, ButtonLink } from '../components/Button'
import { CodeBlock } from '../components/CodeBlock'
import { TableScroll } from '../components/DataTable'
import { EventList } from '../components/EventList'
import { Select } from '../components/Form'
import { Notice } from '../components/Notice'
import { PageHeader, Section } from '../components/PageHeader'
import { ProbeStrip } from '../components/ProbeStrip'
import { RouteStrip } from '../components/RouteStrip'
import { EmptyState, ErrorState, Loadable, LoadingState } from '../components/States'
import { useToast } from '../components/Toast'
import { candidateIds, enabledCandidates } from '../lib/candidates'
import { cx } from '../lib/cx'
import { hopText, runtimeNote } from '../lib/explain'
import { formatFull, gapBefore, joinZh, ms, timeAgo } from '../lib/format'
import { rulesText } from '../lib/groupText'
import { keepNames } from '../lib/keepNames'
import { allFailLabel, osText, probeFailText, protocolLabel, strategyLabel } from '../lib/labels'
import { MIN_SINGBOX, buildSnippet, externalRuleSets, toJson, versionAtLeast } from '../lib/singbox'
import t from '../components/DataTable.module.css'
import page from '../styles/page.module.css'
import s from './DeviceDetail.module.css'

/** 切换后多长时间内提醒“已有连接还在走旧节点” */
const RECENT_SWITCH_MS = 15 * 60_000

export default function DeviceDetail() {
  const { id = '' } = useParams()
  const catalog = useCatalog()
  const runtimes = useRuntimes(id)
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
      {({ c, rts }) => {
        const d = c.device.get(id)
        if (!d) {
          return (
            <>
              <PageHeader back={{ to: '/devices', label: '设备' }} title="找不到这台设备" />
              <EmptyState
                icon={Laptop}
                title="这台设备不存在，或者已经被移除"
                action={<ButtonLink to="/devices">查看所有设备</ButtonLink>}
              />
            </>
          )
        }
        return <DeviceBody d={d} c={c} rts={rts} now={now} />
      }}
    </Loadable>
  )
}

interface BodyProps {
  d: Device
  c: Catalog
  rts: GroupRuntime[]
  now: number
}

function DeviceBody({ d, c, rts, now }: BodyProps) {
  const probe = useProbeNow()
  const toast = useToast()
  const groups = groupsOf(c, d.id)
  // 只有手动选择的分组时，没有要探测的
  const probing = groups.some((g) => g.selection === 'auto')
  const oldSingbox = !versionAtLeast(d.singboxVersion, MIN_SINGBOX)
  const offlineAgo = timeAgo(d.lastSeenAt, now)

  return (
    <>
      <PageHeader
        back={{ to: '/devices', label: '设备' }}
        title={d.name}
        description={
          <>
            <span className="mono">{d.hostname}</span>，{osText(d)}
          </>
        }
        actions={
          probing && (
            <Button
              icon={Radar}
              pending={probe.isPending}
              disabled={!d.online}
              onClick={() =>
                probe.mutate(d.id, {
                  onSuccess: () => toast('已完成一轮探测'),
                  onError: (e) => toast(errorMessage(e), 'crit'),
                })
              }
            >
              立即探测
            </Button>
          )
        }
      />

      <div className={page.stack}>
        {(!d.online || oldSingbox) && (
          <div className={page.stackSm}>
            {!d.online && (
              <Notice tone="offline" title={`设备${gapBefore(offlineAgo)}${offlineAgo}离线`}>
                管理服务收不到这台设备的上报，下面是它最后上报的状态。设备重新连上之前，不能从这里探测、固定或选择节点。Agent
                如果还在运行，会继续在本地探测和切换，重新连上后再同步。
              </Notice>
            )}
            {oldSingbox && (
              <Notice tone="warn" title="sing-box 版本过低">
                这台设备的 <span className="nowrap">sing-box</span> 是 {d.singboxVersion}，singweb 生成的路由规则需要 {MIN_SINGBOX} 或更新的版本。
              </Notice>
            )}
          </div>
        )}

        <div className={page.split}>
          <div className={page.stack}>
            {groups.length ? (
              groups.map((g) => (
                <GroupPanel key={g.id} d={d} g={g} rt={rts.find((r) => r.groupId === g.id)} c={c} now={now} />
              ))
            ) : (
              <EmptyState
                icon={Split}
                title="这台设备还没有应用分组"
                action={<ButtonLink to="/groups">去设置分组</ButtonLink>}
              >
                在分组里勾选这台设备后，Agent 才会开始探测和切换。
              </EmptyState>
            )}
            {groups.length > 0 && <Snippet d={d} groups={groups} c={c} />}
          </div>

          <div className={page.stack}>
            <DeviceInfo d={d} now={now} />
            <DeviceEvents d={d} c={c} now={now} />
          </div>
        </div>
      </div>
    </>
  )
}

interface PanelProps {
  d: Device
  g: Group
  rt: GroupRuntime
  c: Catalog
}

function GroupPanel({ d, g, rt, c, now }: Omit<PanelProps, 'rt'> & { rt?: GroupRuntime; now: number }) {
  const manual = g.selection === 'manual'
  return (
    <Section
      id={`group-${g.id}`}
      title={g.name}
      description={
        <>
          selector <span className="mono">{keepNames(g.selectorTag)}</span>，
          {manual ? (
            '手动选择，不探测。'
          ) : (
            <>
              {strategyLabel[g.strategy]}，全部不可用时{allFailLabel[g.onAllFail]}。分组规则：{keepNames(rulesText(g, c.target))}。
            </>
          )}
        </>
      }
      actions={
        <ButtonLink to={`/groups/${g.id}`} size="sm" variant="ghost" icon={Pencil}>
          编辑分组
        </ButtonLink>
      }
    >
      {rt ? (
        <div className={page.panel}>
          <div className={s.state}>
            <div className={s.stateText}>
              <RuntimeBadge state={rt.state} />
              <p>{keepNames(runtimeNote(rt, c, now))}</p>
            </div>
            {manual ? <NodePicker d={d} g={g} rt={rt} c={c} /> : <PinControl d={d} g={g} rt={rt} c={c} />}
          </div>
          <div className={s.strip}>
            <RouteStrip runtime={rt} group={g} nodes={c.node} targets={c.target} />
          </div>
          <ConnectionNote g={g} rt={rt} c={c} now={now} />
          {manual ? <CandidateTable g={g} rt={rt} c={c} /> : <NodeTable d={d} g={g} rt={rt} c={c} />}
        </div>
      ) : (
        <p className={page.sub}>Agent 还没有上报这个分组的状态。</p>
      )}
    </Section>
  )
}

/** 自动分组：固定到某个节点，或者恢复自动切换 */
function PinControl({ d, g, rt, c }: PanelProps) {
  const setPin = useSetPin()
  const toast = useToast()
  const id = useId()
  const health = new Map(rt.nodes.map((h) => [h.nodeId, h]))
  const candidates = enabledCandidates(g, c.nodes)
  // 请求进行中先显示刚选的值，等刷新后的状态回来。不禁用下拉框：禁用会把焦点移走
  const value = setPin.isPending ? (setPin.variables.nodeId ?? '') : (rt.pinnedNodeId ?? '')

  return (
    <div className={s.pin}>
      <label htmlFor={id} className={s.pinLabel}>
        出口选择
      </label>
      <Select
        id={id}
        value={value}
        disabled={!d.online}
        aria-busy={setPin.isPending || undefined}
        aria-describedby={d.online ? undefined : `${id}-off`}
        onChange={(e) => {
          const nodeId = e.target.value || null
          setPin.mutate(
            { deviceId: d.id, groupId: g.id, nodeId },
            {
              onSuccess: () =>
                toast(nodeId ? `已固定到 ${outletName(nodeId, c)}，不会再自动切换` : '已恢复自动切换'),
              onError: (err) => toast(errorMessage(err), 'crit'),
            },
          )
        }}
      >
        <option value="">自动切换</option>
        {candidates.map((n) => (
          <option key={n.id} value={n.id}>
            固定到 {n.tag}
            {health.get(n.id)?.state === 'down' ? '（不可用）' : ''}
          </option>
        ))}
      </Select>
      {!d.online && (
        <span id={`${id}-off`} className="visually-hidden">
          设备离线，暂时不能更改
        </span>
      )}
    </div>
  )
}

/** 手动选择的分组：选中哪个节点就切到哪个 */
function NodePicker({ d, g, rt, c }: PanelProps) {
  const setPin = useSetPin()
  const toast = useToast()
  const id = useId()
  const nodes = enabledCandidates(g, c.nodes)
  const value = setPin.isPending ? (setPin.variables.nodeId ?? '') : (rt.activeNodeId ?? '')
  // 设备离线时上报的出口可能已经停用：照实显示，但不能再选它
  const stale = value && !nodes.some((n) => n.id === value) ? value : null
  const hint = !d.online ? '设备离线，暂时不能更改' : !nodes.length ? '没有启用的候选节点' : null

  return (
    <div className={s.pin}>
      <label htmlFor={id} className={s.pinLabel}>
        选择节点
      </label>
      <Select
        id={id}
        value={value}
        disabled={!d.online || !nodes.length}
        aria-busy={setPin.isPending || undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => {
          const nodeId = e.target.value
          setPin.mutate(
            { deviceId: d.id, groupId: g.id, nodeId },
            {
              onSuccess: () => toast(`已切到 ${outletName(nodeId, c)}`),
              onError: (err) => toast(errorMessage(err), 'crit'),
            },
          )
        }}
      >
        {!value && <option value="">没有可选的节点</option>}
        {stale && (
          <option value={stale} disabled>
            {outletName(stale, c)}（不能选择）
          </option>
        )}
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.tag}
          </option>
        ))}
      </Select>
      {hint && (
        <span id={`${id}-hint`} className="visually-hidden">
          {hint}
        </span>
      )}
    </div>
  )
}

/** 切换只影响新连接：提醒已经打开的长连接要重连 */
function ConnectionNote({ g, rt, c, now }: Omit<PanelProps, 'd'> & { now: number }) {
  const sw = rt.lastSwitch
  if (!sw || sw.from === null || sw.to === null || rt.state === 'stale') return null
  if (now - Date.parse(sw.at) > RECENT_SWITCH_MS) return null
  // “直连”本身是中文，前后不留空格；节点 tag 两边留空格
  const at = (id: string) => (id === DIRECT ? outletName(id, c) : ` ${outletName(id, c)} `)
  const ago = timeAgo(sw.at, now)
  return (
    <div className={s.note}>
      {g.interruptExisting ? (
        <Notice title={`${ago}切换时，经过${at(sw.from)}的连接已被断开`}>
          正在使用的长连接（比如 SSH 会话、WebSocket）会掉线，重新连接后会走{keepNames(at(sw.to).trimEnd())}。
        </Notice>
      ) : (
        <Notice tone="warn" title={`切换前建立的连接可能还在走${at(sw.from).trimEnd()}`}>
          {keepNames(`${ago}${hopText(sw.from, sw.to, c)}`)}，切换只影响新连接。长连接（比如 SSH 会话、WebSocket）要断开重连才会走
          {keepNames(at(sw.to).trimEnd())}。如果希望切换时自动断开旧连接，可以在
          <Link to={`/groups/${g.id}#switching`}>分组设置</Link>里打开“切换时断开已有连接”。
        </Notice>
      )}
    </div>
  )
}

function counterText(h: NodeHealth, g: Group): string | null {
  if (h.state === 'down' && h.consecutiveSuccesses > 0) return `恢复 ${h.consecutiveSuccesses}/${g.recoverThreshold}`
  if (h.state !== 'down' && h.consecutiveFails > 0) return `失败 ${h.consecutiveFails}/${g.failThreshold}`
  return null
}

function NodeTable({ d, g, rt, c }: PanelProps) {
  const noteId = useId()
  const cells = useProbeCells(d.id)
  // 各规则最近一次的结果，用来写出失败原因，比如“返回 403”
  const lastProbe = new Map<string, ProbeDetail | null>(
    cells.data?.map((x) => [`${x.nodeId}|${x.targetId}`, x.last] as const),
  )
  // 同一张表里的探测条用同一个延迟刻度，才能互相比较
  const maxMs = Math.max(
    200,
    ...rt.nodes.flatMap((h) => h.history.map((x) => (x.ok && x.latencyMs != null ? x.latencyMs : 0))),
  )

  return (
    <div className={s.nodes}>
      <TableScroll bare label={`「${g.name}」的候选节点`} minWidth={560}>
        <table className={t.table} aria-describedby={noteId}>
          <caption className="visually-hidden">「{g.name}」的候选节点</caption>
          <thead>
            <tr>
              <th className={t.num}>顺序</th>
              <th>节点</th>
              <th>状态</th>
              <th className={t.num}>延迟</th>
              <th>最近 40 轮</th>
            </tr>
          </thead>
          <tbody>
            {rt.nodes.map((h, i) => {
              const n = c.node.get(h.nodeId)
              const active = h.nodeId === rt.activeNodeId
              const counter = counterText(h, g)
              const failing = h.failingTargetIds.map((id) => {
                const name = c.target.get(id)?.name ?? id
                const last = lastProbe.get(`${h.nodeId}|${id}`)
                return last && !last.ok ? `${name}（${probeFailText(last)}）` : name
              })
              return (
                <tr key={h.nodeId} className={cx(active && s.activeRow)}>
                  <td className={t.num}>{i + 1}</td>
                  <td>
                    <div className={s.nodeName}>
                      <span className={t.name}>{n?.tag ?? h.nodeId}</span>
                      {active && <span className={s.activeTag}>当前出口</span>}
                      {h.nodeId === rt.pinnedNodeId && (
                        <span className={s.pinned}>
                          <Pin aria-hidden />
                          已固定
                        </span>
                      )}
                    </div>
                    {n && (
                      <div className={cx(t.sub, t.nowrap)}>
                        {protocolLabel[n.protocol]}，{n.region}
                      </div>
                    )}
                  </td>
                  <td className={t.nowrap}>
                    {n && !n.enabled ? (
                      <Badge tone="offline" icon={CircleMinus}>
                        已停用
                      </Badge>
                    ) : (
                      <HealthBadge state={h.state} />
                    )}
                    {counter && <div className={t.sub}>{counter}</div>}
                  </td>
                  <td className={t.num}>{ms(h.latencyMs)}</td>
                  <td>
                    <ProbeStrip samples={h.history} maxMs={maxMs} fluid />
                    {failing.length > 0 && <div className={cx(t.sub, s.failing)}>最近一轮未通过：{keepNames(joinZh(failing))}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableScroll>
      {/* 说明放在滚动区外面：表格横向滚动时也能读全 */}
      <p id={noteId} className={s.tableNote}>
        {g.strategy === 'priority' ? '候选节点，按优先级排列。' : '候选节点，按分组里的顺序排列，实际按延迟挑选。'}
        状态按分组规则判定：连续失败 {g.failThreshold} 轮算不可用，不可用的节点要连续成功 {g.recoverThreshold}{' '}
        轮才恢复。探测不会登录，也不带任何账号或凭据，通过只说明经过这个节点能连到这些服务。
      </p>
    </div>
  )
}

/** 手动选择的分组不探测：只列出候选节点，以及能不能选 */
function CandidateTable({ g, rt, c }: Omit<PanelProps, 'd'>) {
  const noteId = useId()
  return (
    <div className={s.nodes}>
      <TableScroll bare label={`「${g.name}」的候选节点`} minWidth={420}>
        <table className={t.table} aria-describedby={noteId}>
          <caption className="visually-hidden">「{g.name}」的候选节点</caption>
          <thead>
            <tr>
              <th className={t.num}>顺序</th>
              <th>节点</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {candidateIds(g, c.nodes).map((id, i) => {
              const n = c.node.get(id)
              const active = id === rt.activeNodeId
              return (
                <tr key={id} className={cx(active && s.activeRow)}>
                  <td className={t.num}>{i + 1}</td>
                  <td>
                    <div className={s.nodeName}>
                      <span className={t.name}>{n?.tag ?? id}</span>
                      {active && <span className={s.activeTag}>当前出口</span>}
                    </div>
                    {n && (
                      <div className={cx(t.sub, t.nowrap)}>
                        {protocolLabel[n.protocol]}，{n.region}
                      </div>
                    )}
                  </td>
                  <td className={t.nowrap}>
                    {n && !n.enabled ? (
                      <Badge tone="offline" icon={CircleMinus}>
                        已停用
                      </Badge>
                    ) : (
                      <span className={t.sub}>可以选择</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableScroll>
      <p id={noteId} className={s.tableNote}>
        候选节点，按分组里的顺序排列。没有选过节点，或者选中的节点停用了，就走第一个启用的节点。手动选择的分组不探测，这里看不到节点是否可用。
      </p>
    </div>
  )
}

function Snippet({ d, groups, c }: { d: Device; groups: Group[]; c: Catalog }) {
  const code = toJson(buildSnippet({ device: d, groups, nodes: c.nodes }))
  const external = externalRuleSets(groups)
  return (
    <Section
      id="snippet"
      title="sing-box 配置片段"
      description="Agent 会把这些内容合并进设备的 sing-box 配置；密码和 Clash API 密钥由 Agent 在本机生成。节点本身的出站配置保持不变。"
    >
      <div className={page.stackSm}>
        {external.length > 0 && (
          <Notice tone="warn" title="需要先定义规则集">
            {keepNames(`${joinZh(external)} 要先在这台设备的 sing-box 配置里定义好，否则合并后的配置会加载失败。`)}
          </Notice>
        )}
        <details className={s.details}>
          <summary>
            <ChevronDown aria-hidden />
            查看配置片段
          </summary>
          <CodeBlock code={code} title={`${d.name} 的配置片段`} label={`${d.name} 的 sing-box 配置片段`} maxHeight={480} />
        </details>
      </div>
    </Section>
  )
}

function DeviceInfo({ d, now }: { d: Device; now: number }) {
  return (
    <Section title="设备信息" id="device-info">
      <div className={cx(page.panel, page.panelBody)}>
        <dl className={page.meta}>
          <dt>主机名</dt>
          <dd className="mono">{d.hostname}</dd>
          <dt>系统</dt>
          <dd>
            {osText(d)}
          </dd>
          <dt>sing-box</dt>
          <dd>{d.singboxVersion}</dd>
          <dt>Agent</dt>
          <dd>{d.agentVersion}</dd>
          <dt>Clash API</dt>
          <dd className="mono">{d.clashApi}</dd>
          <dt>探测入站</dt>
          <dd className="mono">{d.probeInbound}</dd>
          <dt>数据目录</dt>
          <dd className="mono">{d.dataDir}</dd>
          <dt>最后上报</dt>
          <dd>
            <time dateTime={d.lastSeenAt} title={formatFull(d.lastSeenAt)}>
              {timeAgo(d.lastSeenAt, now)}
            </time>
          </dd>
          {d.note && (
            <>
              <dt>备注</dt>
              <dd>{d.note}</dd>
            </>
          )}
        </dl>
      </div>
    </Section>
  )
}

function DeviceEvents({ d, c, now }: { d: Device; c: Catalog; now: number }) {
  const events = useEvents({ deviceId: d.id, limit: 10 })
  const items = events.data?.pages[0]?.items
  return (
    <Section
      title="这台设备的事件"
      id="device-events"
      actions={<Link to={`/events?device=${encodeURIComponent(d.id)}`}>查看全部</Link>}
    >
      {items ? (
        items.length ? (
          <EventList events={items} catalog={c} now={now} compact />
        ) : (
          <EmptyState icon={ClockFading} title="还没有事件" />
        )
      ) : events.error ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : (
        <LoadingState />
      )}
    </Section>
  )
}
