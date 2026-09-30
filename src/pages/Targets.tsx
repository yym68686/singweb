import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Pencil,
  Plus,
  ShieldCheck,
  Target as TargetIcon,
  Trash,
  type LucideIcon,
} from 'lucide-react'
import { useCatalog, type Catalog } from '../api/catalog'
import { errorMessage } from '../api/errors'
import { useDeleteTarget, useProbeCells, useSaveTarget } from '../api/hooks'
import type { ProbeCell, Target, TargetKind } from '../api/types'
import { ToneIcon } from '../components/Badge'
import { Button } from '../components/Button'
import { TableScroll } from '../components/DataTable'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Menu } from '../components/Menu'
import { Notice } from '../components/Notice'
import { PageHeader } from '../components/PageHeader'
import { EmptyState, Loadable } from '../components/States'
import {
  TargetFields,
  draftOf,
  emptyDraft,
  inputOf,
  probeChanged,
  targetKindIcon,
  targetKindItems,
  useTargetDraft,
} from '../components/TargetFields'
import { useToast } from '../components/Toast'
import { candidateIds } from '../lib/candidates'
import { cx } from '../lib/cx'
import { gapBefore, joinZh } from '../lib/format'
import { expectStatusText, targetAddress } from '../lib/groupText'
import { keepNames } from '../lib/keepNames'
import { probeFailText, targetKindHint, targetKindLabel } from '../lib/labels'
import type { Tone } from '../lib/status'
import t from '../components/DataTable.module.css'
import s from './Targets.module.css'

export default function Targets() {
  const catalog = useCatalog()
  const cells = useProbeCells()
  const [editing, setEditing] = useState<{ kind: TargetKind; target?: Target } | null>(null)
  const [deleting, setDeleting] = useState<Target | null>(null)

  // 删掉的那一行连同按钮一起消失，焦点会掉到页面开头。等对话框关闭、列表刷新后，
  // 把焦点放到相邻一行的“编辑”按钮上；一行都不剩时放到主内容区
  const deleted = useRef<{ id: string; next?: string } | null>(null)
  const onDeleted = (id: string) => {
    const ids = catalog.data?.targets.map((tg) => tg.id) ?? []
    const i = ids.indexOf(id)
    deleted.current = { id, next: ids[i + 1] ?? ids[i - 1] }
  }
  useEffect(() => {
    const d = deleted.current
    if (!d || deleting || catalog.data?.target.has(d.id)) return
    deleted.current = null
    const next = d.next ? document.querySelector<HTMLElement>(`[data-edit="${CSS.escape(d.next)}"]`) : null
    ;(next ?? document.getElementById('main'))?.focus()
  }, [deleting, catalog.data])

  const addMenu = (align: 'start' | 'end') => (
    <Menu
      label="添加目标"
      icon={Plus}
      variant="primary"
      align={align}
      items={targetKindItems}
      onSelect={(kind) => setEditing({ kind })}
    />
  )

  return (
    <>
      <PageHeader
        title="探测目标"
        description="分组规则用这些目标判断节点能不能用：Agent 经过每个候选节点去连它们，比如完成 SSH 握手、请求一个网址、连上一个端口。探测不会登录，也不带任何账号或凭据。"
        actions={addMenu('end')}
      />
      <Loadable data={catalog.data} error={catalog.error} retry={catalog.retry}>
        {(c) =>
          c.targets.length ? (
            <TargetTable
              c={c}
              cells={cells.data}
              onEdit={(tg) => setEditing({ kind: tg.kind, target: tg })}
              onDelete={setDeleting}
            />
          ) : (
            <EmptyState icon={TargetIcon} title="还没有探测目标" action={addMenu('start')}>
              添加你关心的服务，比如 github.com:22 或 https://api.openai.com。分组规则会用它们判断每个节点能不能用。
            </EmptyState>
          )
        }
      </Loadable>

      {editing && catalog.data && (
        <TargetDialog
          kind={editing.kind}
          target={editing.target}
          c={catalog.data}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && catalog.data && (
        <DeleteDialog target={deleting} c={catalog.data} onDeleted={onDeleted} onClose={() => setDeleting(null)} />
      )}
    </>
  )
}

const usersOf = (c: Catalog, id: string) => c.groups.filter((g) => g.targetIds.includes(id))

function timeoutText(ms: number) {
  return ms % 1000 === 0 ? `${ms / 1000} 秒` : `${ms} ms`
}

interface TableProps {
  c: Catalog
  cells?: ProbeCell[]
  onEdit: (tg: Target) => void
  onDelete: (tg: Target) => void
}

function TargetTable({ c, cells, onEdit, onDelete }: TableProps) {
  return (
    <TableScroll label="探测目标" minWidth={1040}>
      <table className={t.table}>
        <thead>
          <tr>
            <th>名称</th>
            <th>类型</th>
            <th>地址</th>
            <th>通过条件</th>
            <th className={t.num}>超时</th>
            <th>在用的分组</th>
            <th>最近一轮</th>
            <th className={t.actions}>
              <span className="visually-hidden">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {c.targets.map((tg) => {
            const users = usersOf(c, tg.id)
            const KindIcon = targetKindIcon[tg.kind]
            return (
              <tr key={tg.id}>
                <td>
                  <div className={t.name}>{tg.name}</div>
                  {tg.note && <div className={t.sub}>{tg.note}</div>}
                </td>
                <td>
                  <span className={s.kind}>
                    <KindIcon aria-hidden />
                    {targetKindLabel[tg.kind]}
                  </span>
                </td>
                <td className={cx('mono', s.addr)}>{targetAddress(tg)}</td>
                <td>
                  <PassCondition tg={tg} />
                </td>
                <td className={t.num}>{timeoutText(tg.timeoutMs)}</td>
                <td>
                  {users.length ? (
                    <ul className={t.inline}>
                      {users.map((g) => (
                        <li key={g.id}>
                          <Link to={`/groups/${g.id}`}>{g.name}</Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className={t.sub}>没有分组使用</span>
                  )}
                </td>
                <td>
                  <Recent tg={tg} c={c} cells={cells} />
                </td>
                <td className={t.actions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Pencil}
                    aria-label={`编辑 ${tg.name}`}
                    data-edit={tg.id}
                    onClick={() => onEdit(tg)}
                  >
                    编辑
                  </Button>
                  <Button size="sm" variant="ghost" icon={Trash} aria-label={`删除 ${tg.name}`} onClick={() => onDelete(tg)}>
                    删除
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableScroll>
  )
}

/** 怎样算通过：主要条件一行，附加条件（指纹、关键字）一行 */
function PassCondition({ tg }: { tg: Target }) {
  switch (tg.kind) {
    case 'ssh':
      return (
        <>
          <div>{tg.level === 'handshake' ? '完成 SSH 握手' : '收到 SSH 标识'}</div>
          {tg.level === 'handshake' && (
            <div className={cx(t.sub, s.key)}>
              {tg.hostKey ? (
                <>
                  <ShieldCheck aria-hidden />
                  核对主机密钥
                </>
              ) : (
                '不核对主机密钥'
              )}
            </div>
          )}
        </>
      )
    case 'http':
      return (
        <>
          <div>{expectStatusText(tg.expectStatus)}</div>
          {tg.keyword && <div className={t.sub}>响应里包含“{tg.keyword}”</div>}
        </>
      )
    case 'tcp':
      return <div>端口能连上</div>
  }
}

/** 最近一轮里，这个目标经由各设备、各节点的探测有多少通过 */
function Recent({ tg, c, cells }: { tg: Target; c: Catalog; cells?: ProbeCell[] }) {
  if (!cells) return <span className={t.dim}>加载中</span>

  // 只统计在线设备、启用节点上、确实有分组要求探测的组合
  const pairs = new Set<string>()
  for (const g of usersOf(c, tg.id)) {
    if (g.selection !== 'auto') continue
    const nodeIds = candidateIds(g, c.nodes)
    for (const d of g.deviceIds)
      for (const n of nodeIds) if (c.device.get(d)?.online && c.node.get(n)?.enabled) pairs.add(`${d}|${n}`)
  }
  if (!pairs.size) return <span className={t.sub}>没有在探测</span>

  let ok = 0
  let fail = 0
  const reasons = new Set<string>()
  for (const cell of cells) {
    if (cell.targetId !== tg.id || !cell.last || !pairs.has(`${cell.deviceId}|${cell.nodeId}`)) continue
    if (cell.last.ok) ok++
    else {
      fail++
      reasons.add(probeFailText(cell.last))
    }
  }

  const look: { tone: Tone; icon: LucideIcon; text: string } =
    ok + fail === 0
      ? { tone: 'neutral', icon: CircleDashed, text: '等待探测' }
      : fail === 0
        ? { tone: 'good', icon: CircleCheck, text: `全部通过（${ok}）` }
        : ok === 0
          ? { tone: 'crit', icon: CircleX, text: `全部失败（${fail}）` }
          : { tone: 'warn', icon: CircleAlert, text: `通过 ${ok}，失败 ${fail}` }

  return (
    <div className={s.recent}>
      <ToneIcon tone={look.tone} icon={look.icon} size={15} />
      <div>
        <Link to={`/matrix?view=target&target=${encodeURIComponent(tg.id)}`}>{look.text}</Link>
        {reasons.size > 0 && <div className={t.sub}>{joinZh([...reasons])}</div>}
      </div>
    </div>
  )
}

interface TargetDialogProps {
  kind: TargetKind
  target?: Target
  c: Catalog
  onClose: () => void
}

function TargetDialog({ kind, target, c, onClose }: TargetDialogProps) {
  const formId = useId()
  const save = useSaveTarget()
  const toast = useToast()
  const form = useTargetDraft(() => (target ? draftOf(target) : emptyDraft(kind)))

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (save.isPending) return
    const root = e.currentTarget
    save.mutate(
      { id: target?.id ?? null, input: inputOf(form.draft) },
      {
        onSuccess: (saved) => {
          toast(target ? `已保存目标「${saved.name}」` : `已添加目标「${saved.name}」`)
          onClose()
        },
        onError: (err) => form.fail(err, root),
      },
    )
  }

  const used = target ? usersOf(c, target.id) : []
  const label = targetKindLabel[kind]

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={target ? `编辑「${target.name}」` : `添加${gapBefore(label)}${label}目标`}
      description={target ? `${label}：${targetKindHint[kind]}` : targetKindHint[kind]}
      footer={
        <>
          {form.formError && (
            <p className={s.formError} role="alert">
              <CircleAlert aria-hidden />
              {form.formError}
            </p>
          )}
          <Button onClick={onClose}>取消</Button>
          <Button type="submit" form={formId} variant="primary" pending={save.isPending}>
            {target ? '保存修改' : '添加目标'}
          </Button>
        </>
      }
    >
      <form id={formId} className={s.form} onSubmit={submit} noValidate>
        <TargetFields draft={form.draft} errors={form.errors} onChange={form.update} />

        {target && used.length > 0 && probeChanged(form.initial, form.draft) && (
          <Notice tone="info" title="保存后会重新探测">
            {keepNames(joinZh(used.map((g) => `「${g.name}」`)))}正在用这个目标。改了探测的地址或通过条件后，它之前的探测结果会清空，Agent
            从下一轮重新探测。
          </Notice>
        )}
      </form>
    </Dialog>
  )
}

interface DeleteDialogProps {
  target: Target
  c: Catalog
  onDeleted: (id: string) => void
  onClose: () => void
}

function DeleteDialog({ target, c, onDeleted, onClose }: DeleteDialogProps) {
  const del = useDeleteTarget()
  const toast = useToast()
  const users = usersOf(c, target.id)

  // 还有分组在用时，删除一定会失败，直接说明怎么处理
  if (users.length && !del.isPending && !del.isSuccess) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={`不能删除「${target.name}」`}
        description={
          <>
            <p>
              下面的分组正在用它作为分组规则：
              {users.map((g, i) => (
                <span key={g.id}>
                  {i > 0 && '、'}
                  <Link to={`/groups/${g.id}#rules`}>「{g.name}」</Link>
                </span>
              ))}
              。
            </p>
            <p>先在这些分组里移除这条规则，再回来删除。</p>
          </>
        }
        footer={
          <Button variant="primary" onClick={onClose}>
            知道了
          </Button>
        }
      />
    )
  }

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`删除目标「${target.name}」？`}
      confirmLabel="删除"
      danger
      pending={del.isPending}
      error={del.error ? errorMessage(del.error) : null}
      onConfirm={() =>
        del.mutate(target.id, {
          onSuccess: () => {
            toast(`已删除目标「${target.name}」`)
            onDeleted(target.id)
            onClose()
          },
        })
      }
    >
      <p>没有分组在用它，删除后不影响节点切换。</p>
    </ConfirmDialog>
  )
}
