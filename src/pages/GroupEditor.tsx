import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useBeforeUnload, useBlocker, useNavigate, useParams } from 'react-router'
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleMinus,
  Plus,
  Save,
  Split,
  Trash,
  TriangleAlert,
  WifiOff,
  X,
} from 'lucide-react'
import { useCatalog, type Catalog } from '../api/catalog'
import { ApiError, errorMessage } from '../api/errors'
import { useDeleteGroup, useSaveGroup, useSaveTarget } from '../api/hooks'
import type {
  AllFailAction,
  Device,
  Group,
  GroupInput,
  NodeFilter,
  NodeProtocol,
  Selection,
  SniffProtocol,
  Strategy,
  Target,
  TargetKind,
  TrafficMatch,
} from '../api/types'
import { Badge } from '../components/Badge'
import { Button, ButtonLink } from '../components/Button'
import { CodeBlock } from '../components/CodeBlock'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Check, Field, Fieldset, Select, TextArea, TextInput, UnitInput } from '../components/Form'
import { Menu } from '../components/Menu'
import { Notice } from '../components/Notice'
import { PageHeader, Section } from '../components/PageHeader'
import { Segmented } from '../components/Segmented'
import { EmptyState, Loadable } from '../components/States'
import {
  TargetFields,
  emptyDraft,
  inputOf,
  targetKindIcon,
  targetKindItems,
  useTargetDraft,
} from '../components/TargetFields'
import { useToast } from '../components/Toast'
import { Tooltip } from '../components/Tooltip'
import { matchesFilter } from '../lib/candidates'
import { cx } from '../lib/cx'
import { duration, gapBefore, joinZh } from '../lib/format'
import { matchText, targetAddress, targetPassText } from '../lib/groupText'
import { keepNames } from '../lib/keepNames'
import {
  candidateModeLabel,
  platformLabel,
  protocolLabel,
  selectionLabel,
  sniffProtocolLabel,
  targetKindHint,
  targetKindLabel,
} from '../lib/labels'
import { MIN_SINGBOX, buildSnippet, externalRuleSets, toJson, versionAtLeast } from '../lib/singbox'
import page from '../styles/page.module.css'
import s from './GroupEditor.module.css'

export default function GroupEditor() {
  const { id } = useParams()
  const catalog = useCatalog()
  const found = id ? catalog.data?.group.get(id) : undefined
  // 删除成功到跳走之间、或者别处删掉了它，分组会从列表里消失；
  // 这时继续显示编辑器，而不是突然换成“找不到”
  const [last, setLast] = useState(found)
  if (found && found !== last) setLast(found)
  const group = found ?? (id && last?.id === id ? last : undefined)

  return (
    <Loadable data={catalog.data} error={catalog.error} retry={catalog.retry}>
      {(c) =>
        id && !group ? (
          <>
            <PageHeader back={{ to: '/groups', label: '分组' }} title="找不到这个分组" />
            <EmptyState
              icon={Split}
              title="这个分组不存在，或者已经被删除"
              action={<ButtonLink to="/groups">查看所有分组</ButtonLink>}
            />
          </>
        ) : (
          <Editor key={id ?? 'new'} group={group} c={c} />
        )
      }
    </Loadable>
  )
}

/** 表单里的数字和列表先按字符串保存，交给服务端统一校验 */
interface Draft {
  name: string
  selectorTag: string
  deviceIds: string[]
  /** 接管条件 */
  domains: string
  domainKeywords: string
  ipCidrs: string
  ruleSets: string
  protocols: SniffProtocol[]
  ports: string
  processNames: string
  /** 候选节点：两种加入方式的内容都留着，来回切换不丢 */
  candidateMode: 'list' | 'filter'
  nodeIds: string[]
  regions: string[]
  nodeProtocols: NodeProtocol[]
  include: string
  exclude: string
  /** 分组规则：切到手动选择时也留着，切回来还在 */
  selection: Selection
  targetIds: string[]
  targetMode: 'all' | 'any'
  /** 切换设置 */
  strategy: Strategy
  failThreshold: string
  recoverThreshold: string
  probeIntervalSec: string
  toleranceMs: string
  failback: boolean
  interruptExisting: boolean
  onAllFail: AllFailAction
}

const DEFAULT_TOLERANCE = 50

function blankDraft(): Draft {
  return {
    name: '',
    selectorTag: '',
    deviceIds: [],
    domains: '',
    domainKeywords: '',
    ipCidrs: '',
    ruleSets: '',
    protocols: [],
    ports: '',
    processNames: '',
    candidateMode: 'list',
    nodeIds: [],
    regions: [],
    nodeProtocols: [],
    include: '',
    exclude: '',
    selection: 'auto',
    targetIds: [],
    targetMode: 'all',
    strategy: 'priority',
    failThreshold: '3',
    recoverThreshold: '2',
    probeIntervalSec: '15',
    toleranceMs: String(DEFAULT_TOLERANCE),
    failback: true,
    interruptExisting: false,
    onAllFail: 'block',
  }
}

function toDraft(g?: Group): Draft {
  const d = blankDraft()
  if (!g) return d
  const m = g.match
  const cand = g.candidates
  return {
    ...d,
    name: g.name,
    selectorTag: g.selectorTag,
    deviceIds: g.deviceIds,
    domains: m.domains.join('\n'),
    domainKeywords: m.domainKeywords.join(', '),
    ipCidrs: m.ipCidrs.join('\n'),
    ruleSets: m.ruleSets.join(', '),
    protocols: m.protocols,
    ports: m.ports.join(', '),
    processNames: m.processNames.join(', '),
    candidateMode: cand.mode,
    ...(cand.mode === 'list'
      ? { nodeIds: cand.nodeIds }
      : {
          regions: cand.filter.regions,
          nodeProtocols: cand.filter.protocols,
          include: cand.filter.include.join(', '),
          exclude: cand.filter.exclude.join(', '),
        }),
    selection: g.selection,
    targetIds: g.targetIds,
    targetMode: g.targetMode,
    strategy: g.strategy,
    failThreshold: String(g.failThreshold),
    recoverThreshold: String(g.recoverThreshold),
    probeIntervalSec: String(g.probeIntervalSec),
    toleranceMs: String(g.toleranceMs),
    failback: g.failback,
    interruptExisting: g.interruptExisting,
    onAllFail: g.onAllFail,
  }
}

const num = (v: string) => (v.trim() === '' ? NaN : Number(v))
/** 域名、IP 段、规则集和端口：空白、逗号、顿号、分号都能分隔 */
const splitList = (v: string) => v.split(/[\s,，、;；]+/).filter(Boolean)
/** 进程名和名称关键字里可能有空格，只按换行、逗号、顿号、分号分隔 */
const splitNames = (v: string) =>
  v
    .split(/[\n,，、;；]+/)
    .map((x) => x.trim())
    .filter(Boolean)
const intIn = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max
const uniq = <T,>(xs: T[]) => [...new Set(xs)]

const sniffProtocols: SniffProtocol[] = ['http', 'tls', 'quic', 'ssh', 'rdp', 'bittorrent']
const noSpell = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const

const draftFilter = (d: Draft): NodeFilter => ({
  regions: d.regions,
  protocols: d.nodeProtocols,
  include: splitNames(d.include),
  exclude: splitNames(d.exclude),
})

function toInput(d: Draft): GroupInput {
  const manual = d.selection === 'manual'
  // 界面上没显示的数字填坏了，不该挡住保存
  const numOr = (v: string, min: number, max: number, fallback: number, hidden: boolean) =>
    hidden && !intIn(num(v), min, max) ? fallback : num(v)
  return {
    name: d.name,
    selectorTag: d.selectorTag,
    deviceIds: d.deviceIds,
    match: {
      domains: splitList(d.domains),
      domainKeywords: splitList(d.domainKeywords),
      ipCidrs: splitList(d.ipCidrs),
      ruleSets: splitList(d.ruleSets),
      protocols: d.protocols,
      ports: splitList(d.ports).map(num),
      processNames: splitNames(d.processNames),
    },
    candidates:
      d.candidateMode === 'list' ? { mode: 'list', nodeIds: d.nodeIds } : { mode: 'filter', filter: draftFilter(d) },
    selection: d.selection,
    targetIds: manual ? [] : d.targetIds,
    targetMode: d.targetMode,
    strategy: d.strategy,
    failThreshold: numOr(d.failThreshold, 1, 10, 3, manual),
    recoverThreshold: numOr(d.recoverThreshold, 1, 10, 2, manual),
    probeIntervalSec: numOr(d.probeIntervalSec, 5, 600, 15, manual),
    toleranceMs: numOr(d.toleranceMs, 0, 1000, DEFAULT_TOLERANCE, manual || d.strategy === 'priority'),
    failback: d.failback,
    interruptExisting: d.interruptExisting,
    onAllFail: d.onAllFail,
  }
}

/** 和服务端一样整理接管条件，用于摘要和预览；填错的端口先不算 */
function normalizeMatch(m: TrafficMatch): TrafficMatch {
  return {
    domains: uniq(m.domains.map((d) => d.toLowerCase().replace(/^\*?\./, '')).filter(Boolean)),
    domainKeywords: uniq(m.domainKeywords.map((k) => k.toLowerCase())),
    ipCidrs: uniq(m.ipCidrs),
    ruleSets: uniq(m.ruleSets),
    protocols: uniq(m.protocols),
    ports: uniq(m.ports.filter((p) => intIn(p, 1, 65535))).sort((a, b) => a - b),
    processNames: uniq(m.processNames),
  }
}

const hasMatch = (m: TrafficMatch) => Object.values(m).some((v) => v.length > 0)

/** 勾选或取消勾选，并保持 order 里的顺序 */
function toggle<T>(list: T[], x: T, on: boolean, order: T[]): T[] {
  return order.filter((v) => (v === x ? on : list.includes(v)))
}

/** 候选节点的顺序有什么用 */
function orderHint(strategy: Strategy, selection: Selection) {
  if (selection === 'manual') return '没有手动选过节点的设备，默认用排在最前面的启用节点。'
  return strategy === 'priority'
    ? '排在前面的节点优先使用。'
    : '按延迟选择时，这里的顺序只在还没测出延迟或者延迟相同时起作用。'
}

/** 草稿字段改动后，要一起清掉的服务端错误字段 */
const errorKeys: Partial<Record<keyof Draft, string[]>> = {
  domains: ['domains', 'match'],
  domainKeywords: ['match'],
  ipCidrs: ['ipCidrs', 'match'],
  ruleSets: ['ruleSets', 'match'],
  protocols: ['match'],
  ports: ['ports', 'match'],
  processNames: ['match'],
  candidateMode: ['candidates'],
  nodeIds: ['candidates'],
  regions: ['candidates'],
  nodeProtocols: ['candidates'],
  include: ['candidates'],
  exclude: ['candidates'],
  selection: ['targetIds', 'failThreshold', 'recoverThreshold', 'probeIntervalSec', 'toleranceMs'],
  strategy: ['strategy', 'toleranceMs'],
}

type Errors = Partial<Record<string, string>>

function Editor({ group, c }: { group?: Group; c: Catalog }) {
  const isNew = !group
  const navigate = useNavigate()
  const toast = useToast()
  const save = useSaveGroup()
  const del = useDeleteGroup()
  const formRef = useRef<HTMLFormElement>(null)

  const [initial] = useState(() => toDraft(group))
  const [draft, setDraft] = useState(initial)
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [addingRule, setAddingRule] = useState<TargetKind | null>(null)
  const [ruleSaid, setRuleSaid] = useState('')
  const focusNext = useRef<string | null>(null)

  const input = toInput(draft)
  // 比较整理后的内容：切换加入方式再切回来、或者多敲了一个空行，都不算修改
  const dirty = JSON.stringify(input) !== JSON.stringify(toInput(initial))
  /** 保存或删除成功后跳走，不再拦截 */
  const leaving = useRef(false)

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  )
  useBeforeUnload(
    useCallback(
      (e: BeforeUnloadEvent) => {
        if (dirty && !leaving.current) e.preventDefault()
      },
      [dirty],
    ),
  )

  // 等错误信息渲染出来再聚焦：读屏软件读到输入框时，会连同错误一起读出来
  useEffect(() => {
    const field = focusNext.current
    if (!field) return
    focusNext.current = null
    const box = formRef.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`)
    const el = box?.querySelector<HTMLElement>(
      'input:not(:disabled), select:not(:disabled), textarea, button:not(:disabled)',
    )
    el?.focus({ preventScroll: true })
    box?.scrollIntoView({
      block: 'center',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [errors])

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    const cleared = Object.keys(patch).flatMap((k) => errorKeys[k as keyof Draft] ?? [k])
    if (cleared.some((k) => errors[k])) {
      setErrors((e) => {
        const next = { ...e }
        for (const k of cleared) delete next[k]
        return next
      })
    }
    setFormError(null)
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (save.isPending) return
    save.mutate(
      { id: group?.id ?? null, input },
      {
        onSuccess: (g) => {
          leaving.current = true
          toast(
            !isNew
              ? `已保存分组「${g.name}」`
              : g.selection === 'auto'
                ? `已创建分组「${g.name}」，Agent 下一轮开始探测`
                : `已创建分组「${g.name}」`,
          )
          navigate('/groups')
        },
        onError: (err) => {
          const msg = errorMessage(err)
          setFormError(`没有保存：${msg}`)
          if (err instanceof ApiError && err.field) {
            focusNext.current = err.field
            setErrors({ [err.field]: msg })
          }
        },
      },
    )
  }

  const onDelete = () => {
    if (!group) return
    del.mutate(group.id, {
      onSuccess: () => {
        leaving.current = true
        setConfirmDelete(false)
        toast(`已删除分组「${group.name}」`)
        navigate('/groups')
      },
    })
  }

  /** 从“按条件自动加入”切到“手动挑选”、列表还空着时，先放进现在符合条件的启用节点 */
  const setMode = (mode: Draft['candidateMode']) => {
    const f = draftFilter(draft)
    const hasFilter = f.regions.length + f.protocols.length + f.include.length + f.exclude.length > 0
    const nodeIds =
      mode === 'list' && !draft.nodeIds.length && hasFilter
        ? c.nodes.filter((n) => n.enabled && matchesFilter(n, f)).map((n) => n.id)
        : draft.nodeIds
    update({ candidateMode: mode, nodeIds })
  }

  const addRule = (t: Target) => {
    update({ targetIds: [...draft.targetIds, t.id] })
    setRuleSaid(`已添加规则「${t.name}」`)
    setAddingRule(null)
  }

  const removeRule = (i: number) => {
    const id = draft.targetIds[i]
    update({ targetIds: draft.targetIds.filter((_, j) => j !== i) })
    setRuleSaid(`已移除规则「${c.target.get(id)?.name ?? id}」`)
  }

  const devices = draft.deviceIds.map((id) => c.device.get(id)).filter((d): d is Device => !!d)
  const oldDevices = devices.filter((d) => !versionAtLeast(d.singboxVersion, MIN_SINGBOX))
  const match = normalizeMatch(input.match)
  const auto = draft.selection === 'auto'

  return (
    <>
      <PageHeader
        back={{ to: '/groups', label: '分组' }}
        title={group ? group.name : '新建分组'}
        docTitle={group ? `编辑 ${group.name}` : '新建分组'}
        description={
          isNew
            ? '选好要接管的流量、候选节点和选择方式。保存后，Agent 会在设备上创建对应的 selector；按规则自动切换的分组会开始探测。'
            : '修改会同步给应用这个分组的所有设备，Agent 从下一轮开始按新设置执行。'
        }
      />

      <div className={s.layout}>
        <div className={page.stack}>
          <form ref={formRef} className={page.stack} onSubmit={onSubmit} noValidate>
            <Section title="基本信息" id="basics">
              <div className={cx(page.panel, s.body)}>
                <div className={s.row2}>
                  <div data-field="name">
                    <Field label="名称" error={errors.name}>
                      {(a) => (
                        <TextInput
                          {...a}
                          value={draft.name}
                          maxLength={40}
                          placeholder="例如 AI 服务"
                          onChange={(e) => update({ name: e.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                  <div data-field="selectorTag">
                    <Field
                      label="selector tag"
                      error={errors.selectorTag}
                      hint="设备上 sing-box 里这个 selector 出站的 tag，Agent 通过 Clash API 切换它。只能用字母、数字、- 和 _。"
                    >
                      {(a) => (
                        <TextInput
                          {...a}
                          mono
                          value={draft.selectorTag}
                          placeholder="ai-out"
                          {...noSpell}
                          onChange={(e) => update({ selectorTag: e.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                </div>

                <div data-field="deviceIds">
                  <Fieldset
                    legend="应用到哪些设备"
                    hint="离线的设备会在重新连上后收到这个分组。"
                    error={errors.deviceIds}
                  >
                    <div className={s.cards}>
                      {c.devices.map((d) => (
                        <DeviceCheck
                          key={d.id}
                          d={d}
                          checked={draft.deviceIds.includes(d.id)}
                          onChange={(on) =>
                            update({
                              deviceIds: toggle(
                                draft.deviceIds,
                                d.id,
                                on,
                                c.devices.map((x) => x.id),
                              ),
                            })
                          }
                        />
                      ))}
                    </div>
                  </Fieldset>
                </div>
                {oldDevices.length > 0 && (
                  <Notice tone="warn" title={`sing-box 低于 ${MIN_SINGBOX}：${joinZh(oldDevices.map((d) => d.name))}`}>
                    旧版本不支持这个分组要用的路由规则。先在这些设备上升级 sing-box，Agent 才能应用它。
                  </Notice>
                )}
              </div>
            </Section>

            <Section
              title="接管哪些流量"
              id="match"
              description="符合条件的连接交给这个分组的 selector，其余流量不受影响。"
            >
              <div className={cx(page.panel, s.body)}>
                <div data-field="match">
                  <Fieldset
                    legend="接管条件"
                    hint="条件分三类。同一类里满足任意一项即可，设置了的几类要同时满足。"
                    error={errors.match}
                  >
                    <div className={s.categories}>
                      <Category title="目标地址">
                        <div className={s.row2}>
                          <div data-field="domains">
                            <Field
                              label="域名"
                              error={errors.domains}
                              hint="每行一个，包含子域名。SSH、数据库等协议的连接里没有域名，只有 sing-box 用 FakeIP 解析这些域名、或者程序经代理连接时，才能按域名接管。"
                            >
                              {(a) => (
                                <TextArea
                                  {...a}
                                  mono
                                  rows={3}
                                  value={draft.domains}
                                  placeholder="github.com"
                                  {...noSpell}
                                  onChange={(e) => update({ domains: e.target.value })}
                                />
                              )}
                            </Field>
                          </div>
                          <div data-field="ipCidrs">
                            <Field label="IP 段" error={errors.ipCidrs} hint="每行一个，例如 10.0.0.0/8 或 2001:db8::/32。">
                              {(a) => (
                                <TextArea
                                  {...a}
                                  mono
                                  rows={3}
                                  value={draft.ipCidrs}
                                  {...noSpell}
                                  onChange={(e) => update({ ipCidrs: e.target.value })}
                                />
                              )}
                            </Field>
                          </div>
                        </div>
                        <div className={s.row2}>
                          <Field label="域名关键字" hint="域名里包含这些文字就接管，多个用逗号分开。">
                            {(a) => (
                              <TextInput
                                {...a}
                                mono
                                value={draft.domainKeywords}
                                {...noSpell}
                                onChange={(e) => update({ domainKeywords: e.target.value })}
                              />
                            )}
                          </Field>
                          <div data-field="ruleSets">
                            <Field
                              label="规则集"
                              error={errors.ruleSets}
                              hint="填写设备 sing-box 配置里已经定义的规则集 tag，多个用逗号分开。"
                            >
                              {(a) => (
                                <TextInput
                                  {...a}
                                  mono
                                  value={draft.ruleSets}
                                  placeholder="geosite-openai"
                                  {...noSpell}
                                  onChange={(e) => update({ ruleSets: e.target.value })}
                                />
                              )}
                            </Field>
                          </div>
                        </div>
                      </Category>

                      <Category title="协议或端口">
                        <Fieldset legend="协议" hint="sing-box 嗅探连接开头的数据来识别协议，不管端口是多少。">
                          <div className={s.checkGrid}>
                            {sniffProtocols.map((p) => (
                              <Check
                                key={p}
                                label={sniffProtocolLabel[p]}
                                checked={draft.protocols.includes(p)}
                                onChange={(e) =>
                                  update({ protocols: toggle(draft.protocols, p, e.target.checked, sniffProtocols) })
                                }
                              />
                            ))}
                          </div>
                        </Fieldset>
                        <div data-field="ports">
                          <Field label="端口" error={errors.ports} hint="多个端口用逗号或空格隔开。">
                            {(a) => (
                              <TextInput
                                {...a}
                                className={s.short}
                                inputMode="numeric"
                                value={draft.ports}
                                placeholder="22, 2222"
                                onChange={(e) => update({ ports: e.target.value })}
                              />
                            )}
                          </Field>
                        </div>
                      </Category>

                      <Category title="进程">
                        <Field label="进程名" hint="发起连接的程序名，比如 ssh、git。多个用逗号分开。">
                          {(a) => (
                            <TextInput
                              {...a}
                              mono
                              value={draft.processNames}
                              {...noSpell}
                              onChange={(e) => update({ processNames: e.target.value })}
                            />
                          )}
                        </Field>
                      </Category>
                    </div>
                  </Fieldset>
                </div>
                <p className={s.summary}>
                  {hasMatch(match) ? <>现在接管：{keepNames(matchText(match))}</> : '还没有设置接管条件。'}
                </p>
              </div>
            </Section>

            <Section title="候选节点" id="nodes" description="selector 只在这些节点之间切换。停用的节点会被跳过。">
              <div className={cx(page.panel, s.body)}>
                <Segmented
                  legend="加入方式"
                  className={s.modes}
                  value={draft.candidateMode}
                  options={[
                    { value: 'list', label: candidateModeLabel.list },
                    { value: 'filter', label: candidateModeLabel.filter },
                  ]}
                  onChange={setMode}
                />
                <div data-field="candidates">
                  {draft.candidateMode === 'list' ? (
                    <NodeOrder
                      ids={draft.nodeIds}
                      c={c}
                      strategy={draft.strategy}
                      selection={draft.selection}
                      error={errors.candidates}
                      onChange={(nodeIds) => update({ nodeIds })}
                    />
                  ) : (
                    <NodeFilterFields draft={draft} c={c} error={errors.candidates} onChange={update} />
                  )}
                </div>
              </div>
            </Section>

            <Section
              title="分组规则"
              id="rules"
              description={
                <>
                  按规则自动切换时，Agent 经过每个候选节点检查这些规则，只选用通过的节点。规则用到的目标在
                  <Link to="/targets">探测目标</Link>页面管理。
                </>
              }
            >
              <div className={cx(page.panel, s.body)}>
                <Fieldset legend="选择方式">
                  <div className={s.cards}>
                    <Check
                      type="radio"
                      card
                      name="selection"
                      label={selectionLabel.auto}
                      description="Agent 按分组规则探测候选节点，自动选出可用的节点。"
                      checked={auto}
                      onChange={() => update({ selection: 'auto' })}
                    />
                    <Check
                      type="radio"
                      card
                      name="selection"
                      label={selectionLabel.manual}
                      description="不探测、不自动切换，在设备页手动选节点。"
                      checked={!auto}
                      onChange={() => update({ selection: 'manual' })}
                    />
                  </div>
                </Fieldset>

                {auto ? (
                  <>
                    <div data-field="targetIds">
                      <RuleList
                        ids={draft.targetIds}
                        c={c}
                        error={errors.targetIds}
                        said={ruleSaid}
                        onAdd={setAddingRule}
                        onRemove={removeRule}
                      />
                    </div>
                    {draft.targetIds.length >= 2 && (
                      <Fieldset legend="节点要通过哪些规则才算可用">
                        <div className={s.cards}>
                          <Check
                            type="radio"
                            card
                            name="targetMode"
                            label="全部规则"
                            description="每条规则都通过才算可用。适合要同时连好几个服务的情况。"
                            checked={draft.targetMode === 'all'}
                            onChange={() => update({ targetMode: 'all' })}
                          />
                          <Check
                            type="radio"
                            card
                            name="targetMode"
                            label="任意一条规则"
                            description="有一条通过就算可用。适合几个目标互为备用，比如同一台服务器的 22 和 443 端口。"
                            checked={draft.targetMode === 'any'}
                            onChange={() => update({ targetMode: 'any' })}
                          />
                        </div>
                      </Fieldset>
                    )}
                    {group?.selection === 'manual' && (
                      <Notice tone="info" title="手动选的节点不再保留">
                        保存后，Agent 按分组规则探测候选节点并自动选择，设备页里手动选的节点会被清除。
                      </Notice>
                    )}
                  </>
                ) : (
                  draft.targetIds.length > 0 && (
                    <Notice tone="info" title={`保存时会移除 ${draft.targetIds.length} 条分组规则`}>
                      手动选择的分组不探测。探测目标还留在探测目标页面，以后可以再加回来。
                      {group?.selection === 'auto' &&
                        '各设备现在用的节点会记成手动选择的节点，流量不受影响；正在阻断或直连的设备改走第一个启用的候选节点。'}
                    </Notice>
                  )
                )}
              </div>
            </Section>

            <Section
              title="切换设置"
              id="switching"
              description={auto ? undefined : '手动选择的分组不探测，只需要决定切换时要不要断开已有连接。'}
            >
              <div className={cx(page.panel, s.body)}>
                {auto && (
                  <>
                    <Fieldset legend="怎样选节点">
                      <div className={s.cards}>
                        <Check
                          type="radio"
                          card
                          name="strategy"
                          label="按优先级"
                          description="用排在最前面的可用节点。当前节点一直可用就不换。"
                          checked={draft.strategy === 'priority'}
                          onChange={() => update({ strategy: 'priority' })}
                        />
                        <Check
                          type="radio"
                          card
                          name="strategy"
                          label="按延迟"
                          description="用延迟最低的可用节点。新节点要快出容差才换，避免来回跳。"
                          checked={draft.strategy === 'latency'}
                          onChange={() => update({ strategy: 'latency' })}
                        />
                      </div>
                    </Fieldset>

                    <div className={s.numbers}>
                      <NumberField
                        field="failThreshold"
                        label="判定不可用"
                        unit="轮"
                        hint="连续失败这么多轮，才认为节点不可用。1–10。"
                        min={1}
                        max={10}
                        value={draft.failThreshold}
                        error={errors.failThreshold}
                        onChange={(v) => update({ failThreshold: v })}
                      />
                      <NumberField
                        field="recoverThreshold"
                        label="判定恢复"
                        unit="轮"
                        hint="不可用的节点连续成功这么多轮，才重新参与选择。1–10。"
                        min={1}
                        max={10}
                        value={draft.recoverThreshold}
                        error={errors.recoverThreshold}
                        onChange={(v) => update({ recoverThreshold: v })}
                      />
                      <NumberField
                        field="probeIntervalSec"
                        label="探测间隔"
                        unit="秒"
                        hint="5–600 秒。"
                        min={5}
                        max={600}
                        value={draft.probeIntervalSec}
                        error={errors.probeIntervalSec}
                        onChange={(v) => update({ probeIntervalSec: v })}
                      />
                      {draft.strategy === 'latency' && (
                        <NumberField
                          field="toleranceMs"
                          label="延迟容差"
                          unit="ms"
                          hint="新节点至少快这么多才切过去。0–1000。"
                          min={0}
                          max={1000}
                          value={draft.toleranceMs}
                          error={errors.toleranceMs}
                          onChange={(v) => update({ toleranceMs: v })}
                        />
                      )}
                    </div>
                    <Timing draft={draft} />
                  </>
                )}

                <div className={s.checks}>
                  {auto && draft.strategy === 'priority' && (
                    <Check
                      label="更靠前的节点恢复后切回去"
                      description="关掉后，只要当前节点可用就一直用它，切换次数更少。"
                      checked={draft.failback}
                      onChange={(e) => update({ failback: e.target.checked })}
                    />
                  )}
                  <Check
                    label="切换时断开已有连接"
                    description="关掉时，切换只影响新连接：已经打开的连接（比如 SSH 会话、WebSocket）继续走旧节点，断开重连后才走新节点。打开后，切换时会断开经过旧节点的连接，正在进行的传输会中断。"
                    checked={draft.interruptExisting}
                    onChange={(e) => update({ interruptExisting: e.target.checked })}
                  />
                </div>
              </div>
            </Section>

            {auto && (
              <Section
                title="全部节点都不可用时"
                id="all-fail"
                description="无论选哪种，都会记一条严重事件并在总览页提醒。"
              >
                <div className={cx(page.panel, s.body)}>
                  <Fieldset legend="怎样处理这些连接">
                    <div className={s.stackCards}>
                      <Check
                        type="radio"
                        card
                        name="onAllFail"
                        label="阻断"
                        aside="推荐"
                        description="拒绝这些连接，程序会马上报错，不会悄悄换一条路。有节点恢复后自动解除。"
                        checked={draft.onAllFail === 'block'}
                        onChange={() => update({ onAllFail: 'block' })}
                      />
                      <Check
                        type="radio"
                        card
                        name="onAllFail"
                        label="保持当前节点"
                        description="继续用最后选中的节点，新连接多半会超时。"
                        checked={draft.onAllFail === 'keep-last'}
                        onChange={() => update({ onAllFail: 'keep-last' })}
                      />
                      <Check
                        type="radio"
                        card
                        name="onAllFail"
                        label="改走直连"
                        description="不经过代理直接连接。对方会看到这台设备的真实 IP，连接也可能被所在网络拦截。"
                        checked={draft.onAllFail === 'direct'}
                        onChange={() => update({ onAllFail: 'direct' })}
                      />
                    </div>
                  </Fieldset>
                </div>
              </Section>
            )}

            <div className={s.footer}>
              <div className={s.footerStatus}>
                {formError ? (
                  <p className={s.footerError} role="alert">
                    <CircleAlert aria-hidden />
                    {formError}
                  </p>
                ) : (
                  <p className={page.sub}>{dirty ? '有未保存的修改' : isNew ? '' : '没有修改'}</p>
                )}
              </div>
              <div className={s.footerActions}>
                <ButtonLink to="/groups">取消</ButtonLink>
                <Button type="submit" variant="primary" icon={Save} pending={save.isPending}>
                  {isNew ? '创建分组' : '保存修改'}
                </Button>
              </div>
            </div>
          </form>

          {group && (
            <Section title="删除分组" id="delete">
              <div className={cx(page.panel, s.body, s.danger)}>
                <p>
                  删除后，应用它的设备会移除 selector <span className="mono">{keepNames(group.selectorTag)}</span>{' '}
                  和相关路由规则，这些连接改由 <span className="nowrap">sing-box</span> 的默认出站处理。
                </p>
                <div>
                  <Button variant="danger" icon={Trash} onClick={() => setConfirmDelete(true)}>
                    删除分组
                  </Button>
                </div>
              </div>
            </Section>
          )}
        </div>

        <aside className={s.aside} aria-labelledby="preview-title">
          <Preview input={input} devices={devices} c={c} groupId={group?.id} />
        </aside>
      </div>

      {group && (
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => {
            setConfirmDelete(false)
            del.reset()
          }}
          title={`删除分组「${group.name}」？`}
          confirmLabel="删除"
          danger
          pending={del.isPending}
          error={del.error ? errorMessage(del.error) : null}
          onConfirm={onDelete}
        >
          <p>
            {group.deviceIds.length ? (
              <>
                {group.deviceIds.length} 台设备上的 selector <span className="mono">{keepNames(group.selectorTag)}</span>{' '}
                会被移除，相关连接改由 <span className="nowrap">sing-box</span> 的默认出站处理。
              </>
            ) : (
              '这个分组没有应用到任何设备。'
            )}
          </p>
          <p>{group.selection === 'auto' ? '探测结果会一起删除，事件记录保留。' : '事件记录会保留。'}</p>
        </ConfirmDialog>
      )}

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="放弃未保存的修改？"
        confirmLabel="放弃修改"
        danger
        onConfirm={() => blocker.proceed?.()}
      >
        <p>这个分组还有没保存的修改，离开这个页面后会丢失。</p>
      </ConfirmDialog>

      {/* 对话框里有自己的表单，不能放进上面的 form */}
      {addingRule && (
        <AddRuleDialog
          kind={addingRule}
          c={c}
          taken={draft.targetIds}
          onAdd={addRule}
          onClose={() => setAddingRule(null)}
        />
      )}
    </>
  )
}

/** 接管条件、筛选条件里的一类：小标题加一组输入 */
function Category({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className={s.category}>
      <h3 id={id} className={s.categoryTitle}>
        {title}
      </h3>
      {children}
    </div>
  )
}

function DeviceCheck({ d, checked, onChange }: { d: Device; checked: boolean; onChange: (on: boolean) => void }) {
  const old = !versionAtLeast(d.singboxVersion, MIN_SINGBOX)
  return (
    <Check
      card
      label={d.name}
      description={
        <>
          <span className="mono">{d.hostname}</span>，{platformLabel[d.platform]}，<span className="nowrap">sing-box {d.singboxVersion}</span>
        </>
      }
      aside={
        !d.online ? (
          <span className={s.status}>
            <WifiOff aria-hidden />
            离线
          </span>
        ) : old ? (
          <span className={s.status}>
            <TriangleAlert aria-hidden className={s.warnIcon} />
            版本过低
          </span>
        ) : null
      }
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

interface NumberFieldProps {
  field: string
  label: string
  unit: string
  hint: string
  min: number
  max: number
  value: string
  error?: string
  onChange: (v: string) => void
}

function NumberField({ field, label, unit, hint, min, max, value, error, onChange }: NumberFieldProps) {
  return (
    <div data-field={field}>
      <Field label={label} hint={hint} error={error}>
        {(a) => (
          <UnitInput {...a} unit={unit} min={min} max={max} step={1} value={value} onChange={(e) => onChange(e.target.value)} />
        )}
      </Field>
    </div>
  )
}

/** 把阈值和间隔换算成大概的切换时间 */
function Timing({ draft }: { draft: Draft }) {
  const f = num(draft.failThreshold)
  const r = num(draft.recoverThreshold)
  const iv = num(draft.probeIntervalSec)
  if (![f, r, iv].every((x) => Number.isInteger(x) && x > 0)) return null
  return (
    <p className={s.timing}>
      按现在的设置，当前节点出问题后大约 {duration(f * iv)}切走；不可用的节点恢复后，至少过 {duration(r * iv)}
      才会重新参与选择。
    </p>
  )
}

interface NodeOrderProps {
  ids: string[]
  c: Catalog
  strategy: Strategy
  selection: Selection
  error?: string
  onChange: (ids: string[]) => void
}

/** 候选节点的排序列表：上移、下移、移除，焦点跟着节点走 */
function NodeOrder({ ids, c, strategy, selection, error, onChange }: NodeOrderProps) {
  const [adding, setAdding] = useState('')
  const [said, setSaid] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const focusNext = useRef<string | null>(null)

  useEffect(() => {
    if (!focusNext.current) return
    root.current?.querySelector<HTMLElement>(focusNext.current)?.focus()
    focusNext.current = null
  })

  const tag = (id: string) => c.node.get(id)?.tag ?? id
  const rest = c.nodes.filter((n) => !ids.includes(n.id))
  const addable = rest.filter((n) => n.enabled)
  const pick = addable.some((n) => n.id === adding) ? adding : (addable[0]?.id ?? '')
  const at = (id: string, act: string) => `[data-node="${CSS.escape(id)}"] [data-act="${act}"]`

  const move = (i: number, dir: -1 | 1) => {
    const next = [...ids]
    const [x] = next.splice(i, 1)
    const to = i + dir
    next.splice(to, 0, x)
    onChange(next)
    setSaid(`${tag(x)} 移到第 ${to + 1} 位`)
    // 移到头或尾时，同方向的按钮会变成不可用，焦点换到另一个
    const act = to === 0 ? 'down' : to === next.length - 1 ? 'up' : dir === -1 ? 'up' : 'down'
    focusNext.current = at(x, act)
  }

  const remove = (i: number) => {
    const x = ids[i]
    const next = ids.filter((_, j) => j !== i)
    onChange(next)
    setSaid(`已移除 ${tag(x)}`)
    const neighbor = next[i] ?? next[i - 1]
    focusNext.current = neighbor ? at(neighbor, 'remove') : '[data-act="add"]'
  }

  const add = () => {
    if (!pick) return
    onChange([...ids, pick])
    setSaid(`已添加 ${tag(pick)}，排在第 ${ids.length + 1} 位`)
    if (addable.length <= 1) focusNext.current = at(pick, 'remove')
  }

  return (
    <div ref={root}>
      <Fieldset legend="候选节点和顺序" hint={orderHint(strategy, selection)} error={error}>
        {ids.length ? (
          <ol className={s.order}>
            {ids.map((id, i) => {
              const n = c.node.get(id)
              const name = tag(id)
              return (
                <li key={id} data-node={id} className={s.orderItem}>
                  <span className={s.rank} aria-hidden>
                    {i + 1}
                  </span>
                  <span className={s.orderName}>
                    <span className={s.orderTag}>{name}</span>
                    {n && (
                      <span className={page.sub}>
                        {protocolLabel[n.protocol]}，{n.region}
                      </span>
                    )}
                  </span>
                  {n && !n.enabled && (
                    <Badge tone="offline" icon={CircleMinus}>
                      已停用
                    </Badge>
                  )}
                  <span className={s.orderActions}>
                    <Tooltip content="上移">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={ArrowUp}
                        aria-label={`上移 ${name}`}
                        data-act="up"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      />
                    </Tooltip>
                    <Tooltip content="下移">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={ArrowDown}
                        aria-label={`下移 ${name}`}
                        data-act="down"
                        disabled={i === ids.length - 1}
                        onClick={() => move(i, 1)}
                      />
                    </Tooltip>
                    <Tooltip content="移除">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={X}
                        aria-label={`移除 ${name}`}
                        data-act="remove"
                        onClick={() => remove(i)}
                      />
                    </Tooltip>
                  </span>
                </li>
              )
            })}
          </ol>
        ) : (
          <p className={s.orderEmpty}>还没有候选节点，从下面添加。</p>
        )}
      </Fieldset>

      <div className={s.addRow}>
        <Field label="添加节点">
          {(a) => (
            <Select
              {...a}
              data-act="add"
              value={pick}
              disabled={!addable.length}
              onChange={(e) => setAdding(e.target.value)}
            >
              {!addable.length && <option value="">没有可以添加的节点</option>}
              {addable.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.tag}（{protocolLabel[n.protocol]}，{n.region}）
                </option>
              ))}
              {rest
                .filter((n) => !n.enabled)
                .map((n) => (
                  <option key={n.id} value={n.id} disabled>
                    {n.tag}（已停用）
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Button icon={Plus} disabled={!pick} onClick={add}>
          添加
        </Button>
      </div>
      <p className="visually-hidden" role="status">
        {said}
      </p>
    </div>
  )
}

interface NodeFilterFieldsProps {
  draft: Draft
  c: Catalog
  error?: string
  onChange: (patch: Partial<Draft>) => void
}

/** 按条件自动加入：地区、协议、名称关键字，下面实时列出现在符合条件的节点 */
function NodeFilterFields({ draft, c, error, onChange: update }: NodeFilterFieldsProps) {
  // 已经勾选、但节点列表里暂时没有的值也列出来，才能取消勾选
  const regions = uniq([...c.nodes.map((n) => n.region), ...draft.regions])
  const protocols = uniq([...c.nodes.map((n) => n.protocol), ...draft.nodeProtocols])
  const matched = c.nodes.filter((n) => matchesFilter(n, draftFilter(draft)))

  return (
    <>
      <Fieldset legend="筛选条件" hint="每一项不填表示不限。订阅里新增的节点符合条件就会自动加入。" error={error}>
        <div className={s.categories}>
          <Category title="地区">
            <div className={s.checkGrid}>
              {regions.map((r) => (
                <Check
                  key={r}
                  label={r}
                  checked={draft.regions.includes(r)}
                  onChange={(e) => update({ regions: toggle(draft.regions, r, e.target.checked, regions) })}
                />
              ))}
            </div>
          </Category>
          <Category title="协议">
            <div className={s.checkGrid}>
              {protocols.map((p) => (
                <Check
                  key={p}
                  label={protocolLabel[p]}
                  checked={draft.nodeProtocols.includes(p)}
                  onChange={(e) =>
                    update({ nodeProtocols: toggle(draft.nodeProtocols, p, e.target.checked, protocols) })
                  }
                />
              ))}
            </div>
          </Category>
          <Category title="名称">
            <div className={s.row2}>
              <Field label="名称包含" hint="包含其中任意一个就加入，不区分大小写。多个用逗号分开。">
                {(a) => (
                  <TextInput
                    {...a}
                    value={draft.include}
                    {...noSpell}
                    onChange={(e) => update({ include: e.target.value })}
                  />
                )}
              </Field>
              <Field label="名称不含" hint="包含其中任意一个就排除。">
                {(a) => (
                  <TextInput
                    {...a}
                    value={draft.exclude}
                    {...noSpell}
                    onChange={(e) => update({ exclude: e.target.value })}
                  />
                )}
              </Field>
            </div>
          </Category>
        </div>
      </Fieldset>

      <div className={s.matched}>
        <h3 className={s.matchedTitle}>现在符合条件的节点（{matched.length}）</h3>
        <p className={page.sub}>顺序跟节点页一致。{orderHint(draft.strategy, draft.selection)}</p>
        {matched.length ? (
          <ul className={s.order}>
            {matched.map((n) => (
              <li key={n.id} className={s.orderItem}>
                <span className={s.orderName}>
                  <span className={s.orderTag}>{keepNames(n.tag)}</span>
                  <span className={page.sub}>
                    {protocolLabel[n.protocol]}，{n.region}
                  </span>
                </span>
                {!n.enabled && (
                  <Badge tone="offline" icon={CircleMinus}>
                    已停用
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.orderEmpty}>现在没有节点符合这些条件。</p>
        )}
      </div>
      <p className="visually-hidden" role="status">
        符合条件的节点：{matched.length} 个
      </p>
    </>
  )
}

interface RuleListProps {
  ids: string[]
  c: Catalog
  error?: string
  said: string
  onAdd: (kind: TargetKind) => void
  onRemove: (i: number) => void
}

/** 分组规则：每条引用一个探测目标。移除后焦点落到相邻一条，没有了就落到“添加规则” */
function RuleList({ ids, c, error, said, onAdd, onRemove }: RuleListProps) {
  const root = useRef<HTMLDivElement>(null)
  const focusNext = useRef<string | null>(null)

  useEffect(() => {
    if (!focusNext.current) return
    root.current?.querySelector<HTMLElement>(focusNext.current)?.focus()
    focusNext.current = null
  })

  const remove = (i: number) => {
    const next = ids.filter((_, j) => j !== i)
    const neighbor = next[i] ?? next[i - 1]
    focusNext.current = neighbor
      ? `[data-rule="${CSS.escape(neighbor)}"] [data-act="remove"]`
      : '[data-act="add-rule"] button'
    onRemove(i)
  }

  return (
    <div ref={root}>
      <Fieldset legend="规则" hint="每条规则让 Agent 经过候选节点探测一个目标。" error={error}>
        {ids.length ? (
          <ul className={s.order}>
            {ids.map((id, i) => {
              const t = c.target.get(id)
              const Icon = t ? targetKindIcon[t.kind] : TriangleAlert
              const name = t?.name ?? id
              return (
                <li key={id} data-rule={id} className={s.orderItem}>
                  <Icon aria-hidden className={cx(s.ruleIcon, !t && s.warnIcon)} />
                  <span className={s.ruleText}>
                    <span className={cx(s.ruleName, !t && 'mono')}>{name}</span>
                    <span className={page.sub}>
                      {t ? (
                        <>
                          {targetKindLabel[t.kind]}：<span className="mono">{keepNames(targetAddress(t))}</span>，
                          {targetPassText(t)}
                        </>
                      ) : (
                        '这个探测目标已经被删除，保存时会自动去掉。'
                      )}
                    </span>
                  </span>
                  <span className={s.orderActions}>
                    <Tooltip content="移除">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={X}
                        aria-label={`移除规则「${name}」`}
                        data-act="remove"
                        onClick={() => remove(i)}
                      />
                    </Tooltip>
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className={s.orderEmpty}>还没有规则，从下面添加。</p>
        )}
        <div data-act="add-rule">
          <Menu label="添加规则" icon={Plus} items={targetKindItems} onSelect={onAdd} />
        </div>
      </Fieldset>
      <p className="visually-hidden" role="status">
        {said}
      </p>
    </div>
  )
}

interface AddRuleDialogProps {
  kind: TargetKind
  c: Catalog
  /** 已经加进这个分组的目标 */
  taken: string[]
  onAdd: (t: Target) => void
  onClose: () => void
}

/** 添加一条规则：用目标库里已有的目标，或者新建一个（马上存进目标库） */
function AddRuleDialog({ kind, c, taken, onAdd, onClose }: AddRuleDialogProps) {
  const formId = useId()
  const save = useSaveTarget()
  const form = useTargetDraft(() => emptyDraft(kind))
  const unused = c.targets.filter((t) => t.kind === kind && !taken.includes(t.id))
  // 打开时就定下给不给“用已有的目标”：新建的目标存进目标库后，这个选项不该突然冒出来
  const [offerExisting] = useState(unused.length > 0)
  const [source, setSource] = useState<'existing' | 'new'>(offerExisting ? 'existing' : 'new')
  const [picked, setPicked] = useState<string>()
  const src = offerExisting && unused.length ? source : 'new'
  const pick = unused.find((t) => t.id === picked) ?? unused[0]
  const label = targetKindLabel[kind]

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (src === 'existing') {
      if (pick) onAdd(pick)
      return
    }
    if (save.isPending) return
    const root = e.currentTarget
    save.mutate(
      { id: null, input: inputOf(form.draft) },
      { onSuccess: (saved) => onAdd(saved), onError: (err) => form.fail(err, root) },
    )
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`添加${gapBefore(label)}${label}规则`}
      description={targetKindHint[kind]}
      footer={
        <>
          {src === 'new' && form.formError && (
            <p className={s.formError} role="alert">
              <CircleAlert aria-hidden />
              {form.formError}
            </p>
          )}
          <Button onClick={onClose}>取消</Button>
          <Button type="submit" form={formId} variant="primary" pending={save.isPending}>
            添加规则
          </Button>
        </>
      }
    >
      <form id={formId} className={s.dialogForm} onSubmit={submit} noValidate>
        {offerExisting && unused.length > 0 && (
          <Segmented
            legend="探测目标"
            className={s.modes}
            value={src}
            options={[
              { value: 'existing', label: '用已有的目标' },
              { value: 'new', label: '新建目标' },
            ]}
            onChange={setSource}
          />
        )}
        {src === 'existing' ? (
          <Fieldset legend={`选择${gapBefore(label)}${label}目标`}>
            <div className={s.pickList}>
              {unused.map((t) => (
                <Check
                  key={t.id}
                  type="radio"
                  card
                  name="rule-target"
                  label={t.name}
                  description={
                    <>
                      <span className="mono">{keepNames(targetAddress(t))}</span>，{targetPassText(t)}
                    </>
                  }
                  checked={pick?.id === t.id}
                  data-autofocus={pick?.id === t.id || undefined}
                  onChange={() => setPicked(t.id)}
                />
              ))}
            </div>
          </Fieldset>
        ) : (
          <>
            <TargetFields draft={form.draft} errors={form.errors} onChange={form.update} />
            <p className={page.sub}>新目标会马上存进探测目标库，其他分组也能用。分组规则要保存分组后才生效。</p>
          </>
        )}
      </form>
    </Dialog>
  )
}

interface PreviewProps {
  input: GroupInput
  devices: Device[]
  c: Catalog
  groupId?: string
}

function Preview({ input, devices, c, groupId }: PreviewProps) {
  const [picked, setPicked] = useState<string>()
  const device = devices.find((d) => d.id === picked) ?? devices[0]
  // 和服务端一样整理一遍再生成片段
  const asGroup: Group = {
    ...input,
    id: groupId ?? 'new',
    selectorTag: input.selectorTag.trim() || 'group-out',
    match: normalizeMatch(input.match),
    targetIds: input.targetIds.filter((id) => c.target.has(id)),
    updatedAt: '',
  }
  const external = externalRuleSets([asGroup])

  return (
    <div className={s.preview}>
      <div>
        <h2 id="preview-title" className={s.previewTitle}>
          配置预览
        </h2>
        <p className={page.sub}>
          保存后，Agent 会把这些内容合并进设备的 <span className="nowrap">sing-box</span> 配置。这里只包含这个分组。
        </p>
      </div>
      {!device ? (
        <p className={s.previewEmpty}>
          选择设备后，这里会显示要合并进它的 <span className="nowrap">sing-box</span> 配置。
        </p>
      ) : (
        <>
          {devices.length > 1 && (
            <Field label="设备">
              {(a) => (
                <Select {...a} value={device.id} onChange={(e) => setPicked(e.target.value)}>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {/* 没有接管条件时生成的规则会匹配全部流量，不能拿来当预览 */}
          {hasMatch(asGroup.match) ? (
            <>
              <CodeBlock
                code={toJson(buildSnippet({ device, groups: [asGroup], nodes: c.nodes }))}
                label={`${device.name} 的 sing-box 配置预览`}
                className={s.code}
              />
              {external.length > 0 && (
                <Notice tone="warn" title="需要先定义规则集">
                  {`${joinZh(external)} 要先在「${device.name}」的 sing-box 配置里定义好，否则合并后的配置会加载失败。`}
                </Notice>
              )}
            </>
          ) : (
            <p className={s.previewEmpty}>
              设置了接管条件后，这里会显示要合并进「{device.name}」的 <span className="nowrap">sing-box</span> 配置。
            </p>
          )}
        </>
      )}
    </div>
  )
}
