import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  Grid3x3,
  KeyRound,
  Laptop,
  ShieldCheck,
  Target as TargetIcon,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { groupsOf, useCatalog, type Catalog } from '../api/catalog'
import { useProbeCells, useRuntimes } from '../api/hooks'
import type { Device, Group, GroupRuntime, ProbeCell, ProbeDetail, ProxyNode, Target } from '../api/types'
import { Badge, ToneIcon } from '../components/Badge'
import { ButtonLink } from '../components/Button'
import { TableScroll } from '../components/DataTable'
import { Field, Select } from '../components/Form'
import { Notice } from '../components/Notice'
import { PageHeader } from '../components/PageHeader'
import { ProbeStrip, stripSummary } from '../components/ProbeStrip'
import { Segmented } from '../components/Segmented'
import { EmptyState, ErrorState, Loadable, LoadingState } from '../components/States'
import { targetKindIcon } from '../components/TargetFields'
import { Tooltip } from '../components/Tooltip'
import { candidateIds } from '../lib/candidates'
import { cx } from '../lib/cx'
import { formatTime, joinZh, ms } from '../lib/format'
import { expectStatusText, targetAddress, targetPassText } from '../lib/groupText'
import { groupDeviceIds } from '../lib/groups'
import { keepNames } from '../lib/keepNames'
import { probeFailText, probeStageDone, protocolLabel, targetKindLabel } from '../lib/labels'
import type { Tone } from '../lib/status'
import t from '../components/DataTable.module.css'
import page from '../styles/page.module.css'
import s from './Matrix.module.css'

type View = 'device' | 'target'

export default function Matrix() {
  const catalog = useCatalog()
  return (
    <>
      <PageHeader
        title="连通性"
        description="每台设备经由每个节点探测各个目标的结果，只包括按规则自动切换的分组。探测在设备本地进行，同一个节点在不同设备上的结果可能不一样。"
      />
      <Loadable data={catalog.data} error={catalog.error} retry={catalog.retry}>
        {(c) =>
          c.devices.length ? (
            <MatrixBody c={c} />
          ) : (
            <EmptyState icon={Laptop} title="还没有设备">
              设备上的 Agent 连上管理服务并开始探测后，结果会显示在这里。
            </EmptyState>
          )
        }
      </Loadable>
    </>
  )
}

/** 手动选择的分组不探测 */
const probes = (g: Group) => g.selection === 'auto'

/** 按规则自动切换的分组决定了探测哪些“设备 × 节点 × 目标”组合 */
function probedPairs(c: Catalog) {
  const set = new Set<string>()
  for (const g of c.groups.filter(probes)) {
    const nodeIds = candidateIds(g, c.nodes)
    for (const d of groupDeviceIds(g, c.devices))
      for (const n of nodeIds) for (const tg of g.targetIds) set.add(`${d}|${n}|${tg}`)
  }
  return set
}

/** 会核对主机密钥、可能出现“主机密钥不匹配”的目标 */
const checksHostKey = (x: Target) => x.kind === 'ssh' && x.level === 'handshake' && !!x.hostKey

function MatrixBody({ c }: { c: Catalog }) {
  const [params, setParams] = useSearchParams()
  const view: View = params.get('view') === 'target' ? 'target' : 'device'

  // 参数无效时退回到第一台在线设备 / 第一个在用的目标
  const device =
    c.device.get(params.get('device') ?? '') ?? c.devices.find((d) => d.online) ?? c.devices[0]
  const used = new Set(c.groups.filter(probes).flatMap((g) => g.targetIds))
  const target = c.target.get(params.get('target') ?? '') ?? c.targets.find((x) => used.has(x.id)) ?? c.targets[0]

  const cells = useProbeCells(view === 'device' ? device.id : undefined)
  const runtimes = useRuntimes()

  const set = (patch: Record<string, string>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(patch)) next.set(k, v)
        return next
      },
      { replace: true },
    )

  return (
    <div className={page.stackSm}>
      <div className={cx(page.toolbar, s.toolbar)}>
        <Segmented<View>
          legend="查看方式"
          value={view}
          onChange={(v) => set({ view: v })}
          options={[
            { value: 'device', label: '按设备', icon: Laptop },
            { value: 'target', label: '按目标', icon: TargetIcon },
          ]}
        />
        {view === 'device' ? (
          <Field label="设备">
            {(a) => (
              <Select {...a} value={device.id} onChange={(e) => set({ device: e.target.value })}>
                {c.devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.online ? '' : '（离线）'}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <Field label="探测目标">
            {(a) => (
              <Select {...a} value={target?.id ?? ''} onChange={(e) => set({ target: e.target.value })}>
                {c.targets.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {used.has(x.id) ? '' : '（没有分组使用）'}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>

      <Notice icon={ShieldCheck} title="“通过”不代表能登录">
        Agent 探测时只做到目标设定的那一步（比如完成 SSH 握手、收到 HTTP 响应或连上端口），不会发送任何账号、密钥或凭据。能不能登录还要看账号和服务器自己的访问限制。
      </Notice>

      {cells.data ? (
        view === 'device' ? (
          <DeviceMatrix c={c} d={device} cells={cells.data} rts={runtimes.data ?? []} busy={cells.isPlaceholderData} />
        ) : target ? (
          <TargetMatrix c={c} tg={target} cells={cells.data} rts={runtimes.data ?? []} busy={cells.isPlaceholderData} />
        ) : (
          <EmptyState icon={TargetIcon} title="还没有探测目标">
            <Link to="/targets">添加探测目标</Link>并把它加进分组规则后，Agent 才知道要探测什么。
          </EmptyState>
        )
      ) : cells.error ? (
        <ErrorState error={cells.error} onRetry={() => void cells.refetch()} />
      ) : (
        <LoadingState />
      )}
    </div>
  )
}

interface MatrixProps {
  c: Catalog
  cells: ProbeCell[]
  rts: GroupRuntime[]
  busy: boolean
}

/** 一台设备：行是节点，列是目标 */
function DeviceMatrix({ c, d, cells, rts, busy }: MatrixProps & { d: Device }) {
  const applied = groupsOf(c, d.id)
  const groups = applied.filter(probes)
  if (!groups.length) {
    return (
      <EmptyState
        icon={Grid3x3}
        title={applied.length ? `${d.name} 上的分组都是手动选择` : `${d.name} 还没有应用分组`}
        action={<ButtonLink to="/groups">去设置分组</ButtonLink>}
      >
        {applied.length
          ? '手动选择的分组不探测。把分组改成按规则自动切换后，Agent 才会在这台设备上探测。'
          : '分组里的候选节点和分组规则，决定了 Agent 在这台设备上探测哪些组合。'}
      </EmptyState>
    )
  }
  const nodeIds = new Set(groups.flatMap((g) => candidateIds(g, c.nodes)))
  const targetIds = new Set(groups.flatMap((g) => g.targetIds))
  const nodes = c.nodes.filter((n) => nodeIds.has(n.id))
  const targets = c.targets.filter((x) => targetIds.has(x.id))
  const probed = probedPairs(c)
  const byKey = new Map(
    cells
      .filter((x) => x.deviceId === d.id && probed.has(`${d.id}|${x.nodeId}|${x.targetId}`))
      .map((x) => [`${x.nodeId}|${x.targetId}`, x]),
  )
  // 手动选择的分组也标出来：节点正在承载它的流量
  const mine = rts.filter((r) => r.deviceId === d.id)

  return (
    <Grid
      caption={`${d.name} 经由各节点探测各目标的结果`}
      corner="节点"
      busy={busy}
      cells={[...byKey.values()]}
      hostKey={targets.some(checksHostKey)}
      minWidth={200 + targets.length * 190}
      cols={targets.map((x) => ({ key: x.id, head: <TargetHead tg={x} /> }))}
      rows={nodes.map((n) => {
        const outletOf = mine.filter((r) => r.activeNodeId === n.id).map((r) => c.group.get(r.groupId)?.name ?? r.groupId)
        return {
          key: n.id,
          head: <NodeHead n={n} note={outletOf.length ? `当前出口：${joinZh(outletOf)}` : null} />,
          cells: targets.map((x) => (
            <CellView
              key={x.id}
              cell={byKey.get(`${n.id}|${x.id}`)}
              probed={probed.has(`${d.id}|${n.id}|${x.id}`)}
              node={n}
              tg={x}
              offline={!d.online}
            />
          )),
        }
      })}
    />
  )
}

/** 一个目标：行是节点，列是设备 */
function TargetMatrix({ c, tg, cells, rts, busy }: MatrixProps & { tg: Target }) {
  const groups = c.groups.filter((g) => probes(g) && g.targetIds.includes(tg.id))
  if (!groups.length) {
    return (
      <EmptyState
        icon={TargetIcon}
        title={`没有分组使用「${tg.name}」`}
        action={<ButtonLink to="/groups">去设置分组</ButtonLink>}
      >
        把它加进某个分组的规则后，相关设备才会开始探测它。
      </EmptyState>
    )
  }
  const deviceIds = new Set(groups.flatMap((g) => groupDeviceIds(g, c.devices)))
  const nodeIds = new Set(groups.flatMap((g) => candidateIds(g, c.nodes)))
  const devices = c.devices.filter((d) => deviceIds.has(d.id))
  const nodes = c.nodes.filter((n) => nodeIds.has(n.id))
  const probed = probedPairs(c)
  const mineCells = cells.filter((x) => x.targetId === tg.id && probed.has(`${x.deviceId}|${x.nodeId}|${tg.id}`))
  const byKey = new Map(mineCells.map((x) => [`${x.deviceId}|${x.nodeId}`, x]))
  // 某台设备上，这个节点是不是某个（用到这个目标的）分组的当前出口
  const active = new Set(
    rts.filter((r) => groups.some((g) => g.id === r.groupId)).map((r) => `${r.deviceId}|${r.activeNodeId}`),
  )

  return (
    <Grid
      caption={`各设备经由各节点探测「${tg.name}」的结果`}
      corner="节点"
      busy={busy}
      cells={mineCells}
      hostKey={checksHostKey(tg)}
      minWidth={200 + devices.length * 190}
      cols={devices.map((d) => ({ key: d.id, head: <DeviceHead d={d} /> }))}
      rows={nodes.map((n) => ({
        key: n.id,
        head: <NodeHead n={n} />,
        cells: devices.map((d) => (
          <CellView
            key={d.id}
            cell={byKey.get(`${d.id}|${n.id}`)}
            probed={probed.has(`${d.id}|${n.id}|${tg.id}`)}
            node={n}
            tg={tg}
            offline={!d.online}
            outlet={active.has(`${d.id}|${n.id}`)}
          />
        )),
      }))}
    />
  )
}

interface GridProps {
  caption: string
  corner: string
  busy: boolean
  cells: ProbeCell[]
  /** 图例里要不要列出“主机密钥不匹配” */
  hostKey: boolean
  minWidth: number
  cols: { key: string; head: ReactNode }[]
  rows: { key: string; head: ReactNode; cells: ReactNode[] }[]
}

function Grid({ caption, corner, busy, cells, hostKey, minWidth, cols, rows }: GridProps) {
  const pass = cells.filter((x) => x.last?.ok).length
  const fail = cells.filter((x) => x.last && !x.last.ok).length
  return (
    <div className={page.stackSm}>
      <div className={s.summaryRow}>
        <p className={page.sub}>
          {pass + fail ? `最近一轮：${pass} 个组合通过，${fail} 个失败。` : '还没有探测结果。'}
        </p>
        <Legend hostKey={hostKey} />
      </div>
      <TableScroll
        label={caption}
        minWidth={minWidth}
        className={cx(s.scroll, busy && s.busy)}
        aria-busy={busy || undefined}
      >
        <table className={cx(t.table, s.matrix)}>
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className={s.corner}>
                {corner}
              </th>
              {cols.map((col) => (
                <th key={col.key} scope="col">
                  {col.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" className={s.rowHead}>
                  {r.head}
                </th>
                {r.cells}
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </div>
  )
}

function Legend({ hostKey }: { hostKey: boolean }) {
  const items: { tone: Tone; icon: LucideIcon; label: string }[] = [
    { tone: 'good', icon: CircleCheck, label: '通过' },
    { tone: 'crit', icon: CircleX, label: '失败' },
    ...(hostKey ? [{ tone: 'crit' as const, icon: KeyRound, label: '主机密钥不匹配' }] : []),
    { tone: 'neutral', icon: CircleDashed, label: '待探测' },
  ]
  return (
    <ul className={s.legend} aria-label="图例">
      {items.map((x) => (
        <li key={x.label}>
          <ToneIcon tone={x.tone} icon={x.icon} size={14} />
          {x.label}
        </li>
      ))}
      <li>
        <span className={s.dash} aria-hidden>
          —
        </span>
        不探测
      </li>
    </ul>
  )
}

function NodeHead({ n, note }: { n: ProxyNode; note?: string | null }) {
  return (
    <>
      <div className={s.nodeTop}>
        <span className={t.name}>{n.tag}</span>
        {!n.enabled && (
          <Badge tone="offline" icon={CircleMinus}>
            已停用
          </Badge>
        )}
      </div>
      <div className={t.sub}>
        {protocolLabel[n.protocol]}，{n.region}
      </div>
      {note && <div className={s.outletNote}>{note}</div>}
    </>
  )
}

function TargetHead({ tg }: { tg: Target }) {
  const KindIcon = targetKindIcon[tg.kind]
  return (
    <div className={s.colHead}>
      <span className={s.colName}>{tg.name}</span>
      <span className={s.kind}>
        <KindIcon aria-hidden />
        {targetKindLabel[tg.kind]}
      </span>
      <span className="mono">{targetAddress(tg)}</span>
      <span>{targetPassText(tg)}</span>
    </div>
  )
}

function DeviceHead({ d }: { d: Device }) {
  return (
    <div className={s.colHead}>
      <Link to={`/devices/${d.id}`} className={s.colName}>
        {d.name}
      </Link>
      {d.online ? (
        <span className="mono">{d.hostname}</span>
      ) : (
        <span className={s.offline}>
          <WifiOff aria-hidden />
          离线，显示离线前的结果
        </span>
      )}
    </div>
  )
}

interface CellProps {
  cell?: ProbeCell
  /** 有分组要求探测这个组合 */
  probed: boolean
  node: ProxyNode
  tg: Target
  offline: boolean
  outlet?: boolean
}

function CellView({ cell, probed, node, tg, offline, outlet }: CellProps) {
  if (!cell && !probed) {
    return (
      <td className={s.cell}>
        <span className={s.dash} aria-hidden>
          —
        </span>
        <span className="visually-hidden">不探测</span>
      </td>
    )
  }
  const last = cell?.last ?? null
  let tone: Tone = 'neutral'
  let icon: LucideIcon = CircleDashed
  let text = node.enabled ? '待探测' : '已停用，不再探测'
  if (last?.ok) {
    tone = 'good'
    icon = CircleCheck
    text = `通过 ${ms(last.latencyMs)}`
  } else if (last) {
    tone = 'crit'
    icon = last.error === 'hostkey' ? KeyRound : CircleX
    text = probeFailText(last)
  }

  return (
    <td className={cx(s.cell, last && !last.ok && s.failed, offline && s.stale)}>
      <div className={s.cellInner}>
        <div className={s.resultRow}>
          <Tooltip focusable content={<CellTip cell={cell} node={node} tg={tg} offline={offline} />}>
            <span className={s.result}>
              <ToneIcon tone={tone} icon={icon} size={15} />
              {text}
            </span>
          </Tooltip>
          {outlet && <span className={s.outletTag}>当前出口</span>}
        </div>
        {cell && cell.history.length > 0 && <ProbeStrip samples={cell.history} size="sm" />}
      </div>
    </td>
  )
}

/** 做到了哪一步：HTTP 探测直接写出收到的状态码 */
function reachedText(d: ProbeDetail) {
  if (d.status !== undefined) return `返回 ${d.status}`
  if (d.stage) return probeStageDone[d.stage]
  return d.ok ? '已连通' : 'TCP 没连上'
}

function resultText(d: ProbeDetail) {
  if (d.ok) return `通过：${reachedText(d)}，用时 ${ms(d.latencyMs)}`
  // “返回 403”已经说明了做到哪一步
  if (d.error === 'status') return `失败：${probeFailText(d)}`
  return `失败：${probeFailText(d)}（${reachedText(d)}）`
}

function CellTip({ cell, node, tg, offline }: { cell?: ProbeCell; node: ProxyNode; tg: Target; offline: boolean }) {
  const last = cell?.last
  return (
    <div className={s.tip}>
      <p className={s.tipHead}>
        经由 {keepNames(node.tag)} 探测「{keepNames(tg.name)}」
      </p>
      {last ? (
        <>
          <p>
            <span className="num">{formatTime(last.at)}</span> {resultText(last)}
          </p>
          {last.error === 'status' && tg.kind === 'http' && <p>期望{expectStatusText(tg.expectStatus)}</p>}
          {last.error === 'keyword' && tg.kind === 'http' && tg.keyword && <p>期望响应里包含“{tg.keyword}”</p>}
          {last.banner && (
            <p>
              SSH 标识：<span className="mono">{last.banner}</span>
            </p>
          )}
          {last.hostKey && (
            <p>
              主机密钥：<span className="mono">{last.hostKey}</span>
            </p>
          )}
          {last.error === 'hostkey' && tg.kind === 'ssh' && tg.hostKey && (
            <p>
              期望的密钥：<span className="mono">{tg.hostKey}</span>
            </p>
          )}
        </>
      ) : (
        <p>{node.enabled ? '还没有探测结果。' : '节点已停用，不再探测。'}</p>
      )}
      {cell && cell.history.length > 0 && <p className={s.tipMuted}>{stripSummary(cell.history)}</p>}
      {offline && <p className={s.tipMuted}>设备离线，这是离线前的结果。</p>}
    </div>
  )
}
