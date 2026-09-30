import { useState } from 'react'
import { Link } from 'react-router'
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  Hand,
  Pin,
  Plus,
  RotateCw,
  Server,
  Trash2,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { outletName, useCatalog, type Catalog } from '../api/catalog'
import { errorMessage } from '../api/errors'
import {
  useDeleteSource,
  useRefreshSource,
  useRuntimes,
  useSaveSource,
  useUpdateNode,
} from '../api/hooks'
import type { GroupRuntime, HealthState, NodeSource, ProxyNode } from '../api/types'
import { Badge, ToneIcon } from '../components/Badge'
import { Button } from '../components/Button'
import { TableScroll } from '../components/DataTable'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Field, Switch, TextInput } from '../components/Form'
import { PageHeader } from '../components/PageHeader'
import { EmptyState, Loadable } from '../components/States'
import { useToast } from '../components/Toast'
import { candidateIds } from '../lib/candidates'
import { cx } from '../lib/cx'
import { joinZh, maskUrl, timeAgo } from '../lib/format'
import { keepNames } from '../lib/keepNames'
import { allFailLabel, protocolLabel } from '../lib/labels'
import type { Tone } from '../lib/status'
import t from '../components/DataTable.module.css'
import page from '../styles/page.module.css'
import s from './Nodes.module.css'

export default function Nodes() {
  const catalog = useCatalog()
  const runtimes = useRuntimes()
  const [importing, setImporting] = useState(false)
  const data = catalog.data && runtimes.data ? { c: catalog.data, rts: runtimes.data } : undefined
  return (
    <>
      <PageHeader
        title="节点"
        description="设备上 sing-box 配置里的代理出站。停用的节点不参与任何分组，Agent 也不再探测它。节点可以订阅进来，也可以改 sing-box 配置让 Agent 下次上报时带上来。"
      />
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
            {c.nodes.length ? (
              <NodeTable c={c} rts={rts} />
            ) : (
              <EmptyState icon={Server} title="还没有节点">
                添加一个订阅地址，Agent 下一轮上报时会把它解析出的节点带上来。
              </EmptyState>
            )}
            <SourcesCard c={c} onImport={() => setImporting(true)} />
            {importing && <ImportDialog onClose={() => setImporting(false)} />}
          </div>
        )}
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

/**
 * 订阅来源。
 *
 * 取订阅的一直是设备上的 Agent，不是这台服务器——订阅链接和 token 留在服务端，
 * 由 Agent 在下一轮 bootstrap 时领走，解析出来的节点再报回来。所以这里点「立即刷新」
 * 之后页面上不会立刻有变化，得等设备那一轮跑完。
 */
function SourcesCard({ c, onImport }: { c: Catalog; onImport: () => void }) {
  const refresh = useRefreshSource()
  const toast = useToast()
  const { sources } = c

  const doRefresh = (src: NodeSource) =>
    refresh.mutate(src.id, {
      onSuccess: () => toast(`已让设备重新拉取「${src.name}」，结果要等下一轮上报`),
      onError: (e) => toast(errorMessage(e), 'crit'),
    })

  return (
    <section className={page.panel}>
      <header className={page.panelHead}>
        <h2 className={page.panelTitle}>
          订阅来源
          {sources.length > 0 && <span className={t.dim}>共 {sources.length} 个</span>}
        </h2>
        <Button variant="ghost" size="sm" icon={Plus} onClick={onImport}>
          导入节点
        </Button>
      </header>
      <div className={page.panelBody}>
        {sources.length === 0 ? (
          <p className={page.sub}>
            还没有订阅。添加一个订阅地址，设备上的 Agent 会解析它并把节点报上来。
          </p>
        ) : (
          <ul className={s.sources}>
            {sources.map((src) => (
              <li key={src.id} className={cx(s.source, !src.enabled && s.sourceOff)}>
                <div className={s.sourceHead}>
                  <span className={t.name}>{src.name}</span>
                  {!src.enabled && (
                    <Badge tone="offline" icon={CircleMinus}>
                      已停用
                    </Badge>
                  )}
                  {src.enabled && src.refreshRequested && (
                    <Badge tone="warn" icon={RotateCw}>
                      等待设备拉取
                    </Badge>
                  )}
                </div>
                <p className={cx(s.sourceUrl, 'mono')} title={maskUrl(src.url)}>
                  {maskUrl(src.url)}
                </p>
                <p className={s.sourceMeta}>
                  {src.nodeCount ? `${src.nodeCount} 个节点` : '还没有节点'}
                  {src.lastFetchedAt && <>，上次拉取 {timeAgo(src.lastFetchedAt)}</>}
                  {src.lastError && <span className={s.sourceError}>拉取失败：{src.lastError}</span>}
                </p>
                <div className={s.sourceActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={RotateCw}
                    disabled={!src.enabled}
                    pending={refresh.isPending && refresh.variables === src.id}
                    onClick={() => doRefresh(src)}
                  >
                    立即刷新
                  </Button>
                  <SourceDialog c={c} source={src} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** 修改已有订阅：改名、换地址、启用停用、删除 */
function SourceDialog({ c, source }: { c: Catalog; source: NodeSource }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        设置
      </Button>
      {open && <EditDialog c={c} source={source} onClose={() => setOpen(false)} />}
    </>
  )
}

function EditDialog({ c, source, onClose }: { c: Catalog; source: NodeSource; onClose: () => void }) {
  const save = useSaveSource()
  const remove = useDeleteSource()
  const toast = useToast()
  const [name, setName] = useState(source.name)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const usedNodes = c.nodes.filter((n) => n.source === source.name)
  const inUse = usedNodes.filter((n) => c.groups.some((g) => candidateIds(g, c.nodes).includes(n.id)))

  const apply = (patch: { name?: string; enabled?: boolean }) =>
    save.mutate(
      { id: source.id, ...patch },
      {
        onSuccess: () => {
          toast('已保存')
          onClose()
        },
        onError: (e) => toast(errorMessage(e), 'crit'),
      },
    )

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={`设置「${source.name}」`}
        footer={
          <>
            <Button variant="ghost" icon={Trash2} onClick={() => setConfirmDelete(true)}>
              删除订阅
            </Button>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              pending={save.isPending}
              disabled={!name.trim() || name.trim() === source.name}
              onClick={() => apply({ name: name.trim() })}
            >
              保存名称
            </Button>
          </>
        }
      >
        <Field label="名称" hint="只用于在网页上区分，不影响节点本身">
          {(a) => <TextInput {...a} value={name} maxLength={60} data-autofocus onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field
          label="订阅地址"
          hint="要换地址就重新导入一个，避免改动已有节点的来源。这里隐去了 token，实际存的还是完整链接"
        >
          {(a) => <TextInput {...a} value={maskUrl(source.url)} readOnly mono title={maskUrl(source.url)} />}
        </Field>
        <Switch
          checked={source.enabled}
          label={`启用订阅 ${source.name}`}
          pending={save.isPending}
          onChange={(v) => apply({ enabled: v })}
        />
        <p className={page.sub}>
          {source.enabled
            ? '停用后设备不再拉取这个订阅，已经导入的节点会保留，但要手动停用它们才会退出分组。'
            : '现在不会拉取这个订阅。已经导入的节点还在节点列表里。'}
        </p>
      </Dialog>
      {confirmDelete && (
        <ConfirmDialog
          open
          onClose={() => setConfirmDelete(false)}
          title={`删除订阅「${source.name}」？`}
          confirmLabel="删除"
          danger
          pending={remove.isPending}
          onConfirm={() =>
            remove.mutate(source.id, {
              onSuccess: () => {
                toast(`已删除「${source.name}」`)
                setConfirmDelete(false)
                onClose()
              },
              onError: (e) => toast(errorMessage(e), 'crit'),
            })
          }
        >
          <p>它导入的 {usedNodes.length} 个节点会一起删掉。</p>
          {inUse.length > 0 && (
            <p>
              其中 {inUse.length} 个正在被分组当候选节点用，删掉之后那些分组在这台设备上会少一截出口。
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  )
}

/** 通过订阅地址导入节点 */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const save = useSaveSource()
  const toast = useToast()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')

  const submit = () =>
    save.mutate(
      { id: null, name: name.trim(), url: url.trim(), refresh: true },
      {
        onSuccess: () => {
          toast('已添加订阅，设备下一轮会把它解析成节点')
          onClose()
        },
        onError: (e) => toast(errorMessage(e), 'crit'),
      },
    )

  return (
    <Dialog
      open
      onClose={onClose}
      title="导入节点"
      description="支持 sing-box、Clash 等格式的订阅地址。整条链接（含 token）只存进数据库，页面之后只显示隐去 token 的版本，也只有设备上的 Agent 会去访问它。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            pending={save.isPending}
            disabled={!name.trim() || !url.trim()}
            onClick={submit}
          >
            添加订阅
          </Button>
        </>
      }
    >
      <Field label="名称" hint="比如「主力订阅」">
        {(a) => (
          <TextInput
            {...a}
            value={name}
            maxLength={60}
            data-autofocus
            placeholder="主力订阅"
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field label="订阅地址" hint="整条链接，包含 token；粘贴后不会显示在别的地方">
        {(a) => (
          <TextInput
            {...a}
            value={url}
            mono
            placeholder="https://example.com/api/v1/client/subscribe?token=…"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim() && url.trim()) submit()
            }}
          />
        )}
      </Field>
      <p className={page.sub}>
        添加之后设备要等下一轮上报才会去拉取，解析出来的节点会出现在上面的表格里。
      </p>
    </Dialog>
  )
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
