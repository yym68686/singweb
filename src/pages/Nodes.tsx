import { useState } from 'react'
import { Link } from 'react-router'
import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  Hand,
  Pin,
  Plus,
  RotateCw,
  Server,
  Settings2,
  Trash2,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { outletName, useCatalog, type Catalog } from '../api/catalog'
import { absoluteApiUrl } from '../api/client'
import { errorMessage } from '../api/errors'
import {
  useDeleteSource,
  useRefreshSource,
  useResetSubscription,
  useRuntimes,
  useMe,
  useNow,
  useSaveSource,
  useSubscription,
  useUpdateNode,
} from '../api/hooks'
import type { GroupRuntime, HealthState, NodeSource, ProxyNode } from '../api/types'
import { Badge, ToneIcon } from '../components/Badge'
import { Button } from '../components/Button'
import { CopyField } from '../components/CopyField'
import { TableScroll } from '../components/DataTable'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Field, Switch, TextInput } from '../components/Form'
import { PageHeader } from '../components/PageHeader'
import { EmptyState, Loadable } from '../components/States'
import { useToast } from '../components/Toast'
import { candidateIds } from '../lib/candidates'
import { cx } from '../lib/cx'
import { joinZh, timeAgo } from '../lib/format'
import { keepNames } from '../lib/keepNames'
import { allFailLabel, protocolLabel } from '../lib/labels'
import type { Tone } from '../lib/status'
import t from '../components/DataTable.module.css'
import page from '../styles/page.module.css'
import s from './Nodes.module.css'

export default function Nodes() {
  const catalog = useCatalog()
  const runtimes = useRuntimes()
  const me = useMe()
  const [importing, setImporting] = useState(false)
  const data = catalog.data && runtimes.data ? { c: catalog.data, rts: runtimes.data } : undefined
  return (
    <>
      <PageHeader
        title="节点"
        description="singweb 把所有订阅里的节点拉下来、去重后汇总成一个节点池，分组从这里挑节点。设备拿到的是汇总之后的结果，不会看到上游的订阅地址。停用的节点不参与任何分组。"
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
            <SourcesCard c={c} onImport={() => setImporting(true)} />
            {me.data?.role === 'admin' && <SubscriptionCard />}
            {c.nodes.length ? (
              <NodeTable c={c} rts={rts} />
            ) : (
              <EmptyState
                icon={Server}
                title="节点池是空的"
                action={
                  c.sources.length === 0 && (
                    <Button variant="primary" icon={Plus} onClick={() => setImporting(true)}>
                      导入节点
                    </Button>
                  )
                }
              >
                {emptyPoolText(c.sources)}
              </EmptyState>
            )}
            {importing && <ImportDialog onClose={() => setImporting(false)} />}
          </div>
        )}
      </Loadable>
    </>
  )
}

/** 节点池为空时说清楚是哪一种空：没有订阅、订阅都停了、还是拉取失败 */
function emptyPoolText(sources: NodeSource[]): string {
  if (!sources.length) return '添加一个订阅地址，singweb 会马上拉取并把节点解析到这里。'
  const enabled = sources.filter((src) => src.enabled)
  if (!enabled.length) return '订阅都停用了，停用的订阅的节点不在节点池里。打开任意一个订阅就会马上拉取。'
  if (enabled.every((src) => src.lastError)) return '订阅都拉取失败了，原因写在上面的订阅里。'
  return '订阅里没有解析出能用的节点。'
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
 * 拉订阅的是这台服务器，不是设备：添加、立即刷新、重新启用都会当场拉一次，
 * 接口返回时节点池就已经是新的了。之后每 6 小时自动拉一次。
 */
function SourcesCard({ c, onImport }: { c: Catalog; onImport: () => void }) {
  const refresh = useRefreshSource()
  const toast = useToast()
  const [editing, setEditing] = useState<string | null>(null)
  const { sources } = c
  const current = editing ? c.source.get(editing) : undefined

  const doRefresh = (src: NodeSource) =>
    refresh.mutate(src.id, {
      onSuccess: (r) =>
        r.ok
          ? toast(`「${src.name}」已刷新，解析出 ${r.nodeCount} 个节点`)
          : toast(`拉取「${src.name}」失败：${r.error ?? '原因未知'}。节点池里还是上次的 ${r.nodeCount} 个节点`, 'crit'),
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
          <p className={page.sub}>还没有订阅。添加一个订阅地址，singweb 会马上拉取并解析出节点。</p>
        ) : (
          <ul className={s.sources}>
            {sources.map((src) => (
              <li key={src.id} className={cx(s.source, !src.enabled && s.sourceOff)}>
                <div className={s.sourceHead}>
                  <span className={t.name}>{src.name}</span>
                  <SourceBadge src={src} />
                </div>
                <CopyField value={src.url} label={`复制「${src.name}」的订阅地址`} />
                <p className={s.sourceMeta}>
                  <SourceMeta src={src} />
                </p>
                <div className={s.sourceActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={RotateCw}
                    disabled={!src.enabled}
                    title={src.enabled ? undefined : '订阅停用中，先在设置里打开'}
                    pending={refresh.isPending && refresh.variables === src.id}
                    onClick={() => doRefresh(src)}
                  >
                    立即刷新
                  </Button>
                  <Button size="sm" variant="ghost" icon={Settings2} onClick={() => setEditing(src.id)}>
                    设置
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* 对话框拿的是缓存里最新的那份：开关一拨，列表刷新，对话框里看到的也跟着变 */}
      {current && <EditDialog c={c} source={current} onClose={() => setEditing(null)} />}
    </section>
  )
}

function SourceBadge({ src }: { src: NodeSource }) {
  if (!src.enabled) {
    return (
      <Badge tone="offline" icon={CircleMinus}>
        已停用
      </Badge>
    )
  }
  if (src.lastError) {
    return (
      <Badge tone="crit" icon={CircleAlert}>
        拉取失败
      </Badge>
    )
  }
  if (!src.lastFetchedAt) {
    return (
      <Badge tone="neutral" icon={CircleDashed}>
        还没拉取
      </Badge>
    )
  }
  return null
}

function SourceMeta({ src }: { src: NodeSource }) {
  useNow(30_000)
  const fetched = src.lastFetchedAt ? `，上次拉取 ${timeAgo(src.lastFetchedAt)}` : ''
  if (!src.enabled) {
    return <>停用中，它的 {src.nodeCount} 个节点不在节点池里</>
  }
  return (
    <>
      {src.nodeCount ? `${src.nodeCount} 个节点` : '没有节点'}
      {fetched}
      {src.lastError && <span className={s.sourceError}>拉取失败：{src.lastError}</span>}
    </>
  )
}

/** 修改已有订阅：改名、启用停用、删除。开关即时生效，对话框不关 */
function EditDialog({ c, source, onClose }: { c: Catalog; source: NodeSource; onClose: () => void }) {
  const save = useSaveSource()
  const remove = useDeleteSource()
  const toast = useToast()
  const [name, setName] = useState(source.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // 对话框盖在页面上，提示条会被遮罩挡住，开关的结果写在开关下面
  const [result, setResult] = useState<{ tone: 'good' | 'crit'; text: string } | null>(null)

  const usedNodes = c.nodes.filter((n) => n.sourceId === source.id)
  const inUse = usedNodes.filter((n) => c.groups.some((g) => candidateIds(g, c.nodes).includes(n.id)))
  const toggling = save.isPending && save.variables?.enabled !== undefined

  const toggle = (enabled: boolean) => {
    setResult(null)
    save.mutate(
      { id: source.id, enabled },
      {
        onSuccess: (src) => {
          if (!enabled) {
            setResult({ tone: 'good', text: `已停用。它的 ${src.nodeCount} 个节点移出了节点池，分组和设备配置里都不再有它们。` })
          } else if (src.lastError) {
            setResult({ tone: 'crit', text: `已启用，但这次没拉到：${src.lastError}` })
          } else {
            setResult({ tone: 'good', text: `已启用，刚拉取了一次，解析出 ${src.nodeCount} 个节点。` })
          }
        },
        onError: (e) => setResult({ tone: 'crit', text: errorMessage(e) }),
      },
    )
  }

  const rename = () =>
    save.mutate(
      { id: source.id, name: name.trim() },
      {
        onSuccess: () => {
          toast(`已改名为「${name.trim()}」`)
          onClose()
        },
        onError: (e) => setResult({ tone: 'crit', text: errorMessage(e) }),
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
              关闭
            </Button>
            <Button
              pending={save.isPending && save.variables?.name !== undefined}
              disabled={!name.trim() || name.trim() === source.name}
              onClick={rename}
            >
              保存名称
            </Button>
          </>
        }
      >
        <div className={s.dialogForm}>
          <Field label="名称" hint="只用于在网页上区分，不影响节点本身">
            {(a) => (
              <TextInput
                {...a}
                value={name}
                maxLength={60}
                data-autofocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && name.trim() && name.trim() !== source.name) rename()
                }}
              />
            )}
          </Field>
          <div className={s.urlField}>
            <span className={s.urlLabel}>订阅地址</span>
            <CopyField value={source.url} label="复制订阅地址" />
            <span className={s.urlHint}>要换地址就重新导入一个，已经导入的节点来源不会被改掉。</span>
          </div>
          <div className={s.toggleBlock}>
            <div className={s.toggleRow}>
              <Switch
                checked={source.enabled}
                label={`启用订阅「${source.name}」`}
                pending={toggling}
                onChange={toggle}
              />
              <span className={s.toggleText}>{source.enabled ? '启用中' : '已停用'}</span>
            </div>
            {/* 一直留着这一段，读屏软件才会念出进度和结果 */}
            <p
              className={result && !toggling ? cx(s.toggleResult, result.tone === 'crit' && s.toggleResultCrit) : page.sub}
              role="status"
            >
              {toggling ? (
                source.enabled ? (
                  '正在停用……'
                ) : (
                  '正在启用并拉取，最多等一分钟……'
                )
              ) : result ? (
                <>
                  {result.tone === 'crit' ? <CircleAlert aria-hidden /> : <Check aria-hidden />}
                  {result.text}
                </>
              ) : source.enabled ? (
                '关掉之后，这个订阅的节点会马上移出节点池：节点页、分组候选、设备配置和订阅链接里都不再有它们。数据还留着，重新打开会马上再拉一次。'
              ) : (
                '停用中，它的节点不在节点池里，也不会定时拉取。打开后会马上拉一次。'
              )}
            </p>
          </div>
        </div>
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
          <p>它导入的 {source.nodeCount} 个节点会一起删掉。</p>
          {inUse.length > 0 && (
            <p>其中 {inUse.length} 个正在被分组当候选节点用，删掉之后这些分组会少掉这些出口。</p>
          )}
        </ConfirmDialog>
      )}
    </>
  )
}

/** 通过订阅地址导入节点。添加时服务端当场拉一次，返回时节点已经在节点池里了 */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const save = useSaveSource()
  const toast = useToast()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')

  const submit = () =>
    save.mutate(
      { id: null, name: name.trim(), url: url.trim() },
      {
        onSuccess: (src) => {
          if (src.lastError) toast(`已添加「${src.name}」，但这次没拉到：${src.lastError}`, 'crit')
          else toast(`已添加「${src.name}」，解析出 ${src.nodeCount} 个节点`)
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
      description="支持 base64 分享链接列表（vmess、vless、trojan、ss、hysteria2 等）、Clash 和 sing-box 格式的订阅地址。整条链接只存在 singweb 的数据库里，设备拿不到它。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button pending={save.isPending} disabled={!name.trim() || !url.trim()} onClick={submit}>
            添加订阅
          </Button>
        </>
      }
    >
      <div className={s.dialogForm}>
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
        <Field label="订阅地址" hint="整条链接，包含 token">
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
        <p className={page.sub} role="status">
          {save.isPending
            ? '正在拉取并解析订阅，最多等一分钟……'
            : '添加后 singweb 会马上拉取一次，解析出的节点直接出现在节点池里，之后每 6 小时自动更新。'}
        </p>
      </div>
    </Dialog>
  )
}

/**
 * singweb 自己的订阅链接：节点池按分组整理成的一整份 sing-box 配置。
 *
 * 装了 Agent 的设备不用它（Agent 用设备密钥直接拿同一份数据），
 * 这条是给手机上的 sing-box 这类只能导入链接的客户端的。
 */
function SubscriptionCard() {
  const sub = useSubscription()
  const reset = useResetSubscription()
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
  const url = sub.data ? absoluteApiUrl(`/subscribe/${sub.data}`) : ''

  return (
    <section className={page.panel}>
      <header className={page.panelHead}>
        <h2 className={page.panelTitle}>singweb 订阅链接</h2>
        <Button variant="ghost" size="sm" icon={RotateCw} disabled={!sub.data} onClick={() => setConfirm(true)}>
          重置链接
        </Button>
      </header>
      <div className={cx(page.panelBody, s.subscription)}>
        <p className={page.sub}>
          节点池按分组整理成的一整份 sing-box 配置。装了 Agent 的设备会自动同步，不需要它；手机上的 sing-box
          这类只能导入链接的客户端，导入这一条就行。链接等同于密码，拿到它就能拿到全部节点。
        </p>
        {sub.data ? (
          <CopyField value={url} label="复制 singweb 订阅链接" />
        ) : sub.error ? (
          <p className={s.sourceError}>读不到订阅链接：{errorMessage(sub.error)}</p>
        ) : (
          <p className={page.sub}>正在读取……</p>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(false)}
          title="重置订阅链接？"
          confirmLabel="重置"
          danger
          pending={reset.isPending}
          onConfirm={() =>
            reset.mutate(undefined, {
              onSuccess: () => {
                toast('已重置订阅链接，旧链接已经失效')
                setConfirm(false)
              },
              onError: (e) => toast(errorMessage(e), 'crit'),
            })
          }
        >
          <p>旧链接马上失效，已经导入它的客户端要重新导入新链接。装了 Agent 的设备不受影响。</p>
        </ConfirmDialog>
      )}
    </section>
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
