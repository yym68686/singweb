/**
 * 输入校验。规则照 docs/api.md 的「目标的校验规则」和「分组的校验规则」两张表来，
 * 出错时的 field 就是表里第一列的字段名，前端靠它把消息标到对应输入框。
 *
 * 校验的同时做规范化：域名转小写、去掉开头的 *. 或 .，端口从小到大排列，
 * 列表去空白去重复，只填一个 IP 时补上 /32 或 /128。写进库的就是规范化之后的值。
 */

import { isCatchAll, sharesDevice } from '../../shared/groups.ts'
import { RESERVED_SELECTOR_TAGS } from '../../shared/singbox.ts'
import type {
  AllFailAction,
  Candidates,
  Group,
  NodeFilter,
  NodeProtocol,
  Selection,
  SniffProtocol,
  Strategy,
  TargetKind,
  TrafficMatch,
} from '../../shared/types.ts'
import { EMPTY_MATCH } from './model.ts'

/** 校验失败。field 为空表示错误不属于某个具体字段 */
export class Invalid extends Error {
  readonly field?: string

  constructor(message: string, field?: string) {
    super(message)
    this.name = 'Invalid'
    this.field = field
  }
}

/** never 返回，让后面的代码不必再写 else。要写成函数声明，TS 才认这条控制流 */
function fail(field: string, message: string): never {
  throw new Invalid(message, field)
}

// ---------------------------------------------------------------- 小工具

const TARGET_KINDS: TargetKind[] = ['ssh', 'http', 'tcp']
const SNIFF_PROTOCOLS: SniffProtocol[] = ['http', 'tls', 'quic', 'ssh', 'rdp', 'bittorrent']
const NODE_PROTOCOLS: NodeProtocol[] = [
  'shadowsocks',
  'vmess',
  'vless',
  'trojan',
  'hysteria2',
  'tuic',
]
const STRATEGIES: Strategy[] = ['priority', 'latency']
const ALL_FAIL: AllFailAction[] = ['block', 'keep-last', 'direct']
const SELECTIONS: Selection[] = ['auto', 'manual']

/**
 * 域名。允许下划线（有些内网域名在用），至少一个点，
 * 每个标签不超过 63 个字符，整体不超过 253 个字符。
 * 中文域名这里不认，需要直连的用 IP 段。
 */
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9_-]{1,63}(?<!-)(\.(?!-)[a-z0-9_-]{1,63}(?<!-))+$/i

/** 域名关键字、进程名：只要非空、不含空白和逗号 */
const SIMPLE_RE = /^[^\s,]+$/

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(field, '这个字段要是字符串。')
  return value
}

function asBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field, '这个字段要是 true 或 false。')
  return value
}

function asInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail(field, `这个字段要是整数。`)
  }
  if (value < min || value > max) fail(field, `这个字段要在 ${min} 到 ${max} 之间。`)
  return value
}

/** 字符串列表：去空白、去空项、去重复，保持原有顺序 */
function asStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail(field, '这个字段要是字符串数组。')
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') fail(field, '这个列表里只能填字符串。')
    const text = item.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** 端口列表：1–65535 的整数，从小到大排列 */
function asPortList(value: unknown, field: string): number[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail(field, '这个字段要是数字数组。')
  const seen = new Set<number>()
  for (const item of value) seen.add(asInt(item, field, 1, 65535))
  return [...seen].sort((a, b) => a - b)
}

/** 存名字之类的文本字段：去掉首尾空白，过长就报错 */
function asName(value: unknown, field: string, label: string, max: number): string {
  const text = asString(value, field).trim()
  if (!text) fail(field, `请填写${label}。`)
  if (text.length > max) fail(field, `${label}最多 ${max} 个字。`)
  return text
}

// ---------------------------------------------------------------- 探测目标

const HOST_KEY_RE = /^SHA256:[A-Za-z0-9+/]{43}$/

/** 主机名或 IP：不能有空白、斜杠和 @ */
function checkHost(host: string, field: string): string {
  const value = host.trim()
  if (!value) fail(field, '请填写主机名或 IP。')
  if (/[\s/@]/.test(value)) fail(field, '这里只填域名或 IP，不要带空格、斜杠和 @。')
  if (value.length > 253) fail(field, '主机名太长了。')
  return value
}

/** HTTP 网址：只允许 http 和 https，且不能带用户名密码 */
function checkUrl(url: string, field: string): string {
  const value = url.trim()
  if (!value) fail(field, '请填写要请求的网址。')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    fail(field, '网址格式不对，要以 http:// 或 https:// 开头。')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(field, '网址只能以 http:// 或 https:// 开头。')
  }
  if (parsed.username || parsed.password) fail(field, '网址里不要带用户名和密码。')
  if (!parsed.hostname) fail(field, '网址里要有主机名。')
  return value
}

/** 期望的状态码：100–599，去重复，从小到大 */
function checkStatusList(value: unknown, field: string): number[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail(field, '这里要是数字数组，或者留空表示 200 到 399。')
  const seen = new Set<number>()
  for (const item of value) seen.add(asInt(item, field, 100, 599))
  return [...seen].sort((a, b) => a - b)
}

export interface TargetShape {
  name: string
  kind: TargetKind
  timeoutMs: number
  note: string | null
  /** 按 kind 拆开的字段，写进 targets.spec */
  spec: Record<string, unknown>
}

/** 校验并规范化一个探测目标。返回可以直接写库的形状 */
export function checkTarget(input: unknown): TargetShape {
  if (!input || typeof input !== 'object') fail('name', '请求内容不是有效的探测目标。')
  const raw = input as Record<string, unknown>

  const kindText = asString(raw.kind, 'kind')
  if (!TARGET_KINDS.includes(kindText as TargetKind)) {
    fail('kind', '目标的类型只能是 SSH、HTTP 或 TCP 探测。')
  }
  const kind = kindText as TargetKind

  const name = asName(raw.name, 'name', '目标名称', 60)
  const timeoutMs = raw.timeoutMs === undefined ? 5000 : asInt(raw.timeoutMs, 'timeoutMs', 500, 30000)
  const noteText = typeof raw.note === 'string' ? raw.note.trim() : ''
  if (noteText.length > 200) fail('note', '备注最多 200 个字。')
  const note = noteText || null

  switch (kind) {
    case 'ssh': {
      const host = checkHost(asString(raw.host, 'host'), 'host')
      const port = asInt(raw.port, 'port', 1, 65535)
      const level = raw.level === 'handshake' ? 'handshake' : 'banner'
      // 指纹只在握手级别有意义，其他级别一律存空
      const hostKeyRaw = typeof raw.hostKey === 'string' ? raw.hostKey.trim() : ''
      const hostKey = level === 'handshake' ? hostKeyRaw : ''
      if (hostKey && !HOST_KEY_RE.test(hostKey)) {
        fail('hostKey', '主机密钥指纹形如 SHA256: 后面跟 43 个字符，可以留空不校验。')
      }
      return { name, kind, timeoutMs, note, spec: { host, port, level, hostKey } }
    }
    case 'http': {
      const url = checkUrl(asString(raw.url, 'url'), 'url')
      const expectStatus = checkStatusList(raw.expectStatus, 'expectStatus')
      const keywordText = typeof raw.keyword === 'string' ? raw.keyword.trim() : ''
      if (keywordText.length > 100) fail('keyword', '关键字最多 100 个字符。')
      return {
        name,
        kind,
        timeoutMs,
        note,
        spec: { url, expectStatus, keyword: keywordText || null },
      }
    }
    default: {
      const host = checkHost(asString(raw.host, 'host'), 'host')
      const port = asInt(raw.port, 'port', 1, 65535)
      return { name, kind, timeoutMs, note, spec: { host, port } }
    }
  }
}

// ---------------------------------------------------------------- 分组

/** IPv4 或 IPv6 的 IP 段；只填一个 IP 时补上 /32 或 /128 */
function normalizeCidr(value: string, field: string): string {
  const text = value.trim()
  const slash = text.lastIndexOf('/')
  const addr = slash < 0 ? text : text.slice(0, slash)
  const v4 = addr.includes('.') && !addr.includes(':')
  if (!isIp(addr, v4)) fail(field, `「${text}」不是有效的 IP 段。`)
  if (slash < 0) return `${addr}/${v4 ? 32 : 128}`
  const bits = text.slice(slash + 1)
  if (!/^\d+$/.test(bits)) fail(field, `「${text}」的掩码位数要是数字。`)
  const n = Number(bits)
  const max = v4 ? 32 : 128
  if (n > max) fail(field, `IPv${v4 ? 4 : 6} 的掩码位数要在 0 到 ${max} 之间。`)
  return `${addr}/${n}`
}

function isIp(addr: string, v4: boolean): boolean {
  if (v4) {
    const parts = addr.split('.')
    if (parts.length !== 4) return false
    return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  }
  // 允许 ::ffff:1.2.3.4 这种内嵌 IPv4 的写法，先把尾巴换成一个普通的组
  let text = addr
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':')
    if (cut < 0) return false
    const parts = text.slice(cut + 1).split('.')
    if (parts.length !== 4) return false
    if (!parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false
    text = `${text.slice(0, cut + 1)}0:0`
  }
  if (!text.includes(':') || !/^[0-9a-f:]+$/i.test(text)) return false
  if (text.split('::').length > 2) return false
  const groups = text.split(':').filter(Boolean)
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return false
  // 没有 :: 时必须写满 8 组；有 :: 时可以少写
  return text.includes('::') ? groups.length <= 7 : groups.length === 8
}

/** 接管的流量，返回规范化之后的值。一类都不设的是兜底分组 */
export function checkMatch(value: unknown): TrafficMatch {
  if (!value || typeof value !== 'object') fail('match', '接管条件的格式不对。')
  const raw = value as Record<string, unknown>

  const domains = asStringList(raw.domains, 'domains').map((d) => {
    const text = d.toLowerCase().replace(/^\*?\./, '')
    if (!DOMAIN_RE.test(text)) fail('domains', `「${d}」不是有效的域名。`)
    return text
  })

  const domainKeywords = asStringList(raw.domainKeywords, 'domainKeywords').map((k) => {
    if (!SIMPLE_RE.test(k)) fail('domainKeywords', '域名关键字里不要有空格和逗号。')
    return k.toLowerCase()
  })

  const ipCidrs = asStringList(raw.ipCidrs, 'ipCidrs').map((c) => normalizeCidr(c, 'ipCidrs'))

  const ruleSets = asStringList(raw.ruleSets, 'ruleSets').map((t) => {
    if (!/^[A-Za-z0-9._-]+$/.test(t)) {
      fail('ruleSets', `规则集 tag「${t}」只能包含字母、数字、. - 和 _。`)
    }
    return t
  })

  const protocols: SniffProtocol[] = []
  for (const p of asStringList(raw.protocols, 'protocols')) {
    if (!SNIFF_PROTOCOLS.includes(p as SniffProtocol)) fail('protocols', `不认识的协议「${p}」。`)
    protocols.push(p as SniffProtocol)
  }

  const ports = asPortList(raw.ports, 'ports')

  const processNames = asStringList(raw.processNames, 'processNames').map((p) => {
    if (!SIMPLE_RE.test(p)) fail('processNames', '进程名里不要有空格和逗号。')
    return p
  })

  // 一类条件都不设，就是兜底分组：别的分组没接管的流量都归它
  return { domains, domainKeywords, ipCidrs, ruleSets, protocols, ports, processNames }
}

function checkNodeFilter(value: unknown): NodeFilter {
  const field = 'candidates'
  if (!value || typeof value !== 'object') fail(field, '请设置候选节点的挑选条件。')
  const raw = value as Record<string, unknown>
  const protocols: NodeProtocol[] = []
  for (const p of asStringList(raw.protocols, field)) {
    if (!NODE_PROTOCOLS.includes(p as NodeProtocol)) fail(field, `不认识的协议「${p}」。`)
    protocols.push(p as NodeProtocol)
  }
  return {
    regions: asStringList(raw.regions, field),
    protocols,
    include: asStringList(raw.include, field),
    exclude: asStringList(raw.exclude, field),
  }
}

export function checkCandidates(value: unknown): Candidates {
  const field = 'candidates'
  if (!value || typeof value !== 'object') fail(field, '请设置候选节点。')
  const raw = value as Record<string, unknown>
  if (raw.mode === 'list') {
    const nodeIds = asStringList(raw.nodeIds, field)
    if (!nodeIds.length) fail(field, '逐个挑选时至少要选一个节点。')
    return { mode: 'list', nodeIds }
  }
  if (raw.mode === 'filter') return { mode: 'filter', filter: checkNodeFilter(raw.filter) }
  return fail(field, '候选节点要么逐个挑选，要么按条件自动加入。')
}

/** 分组的形状，和 shared/types.ts 的 Group 去掉 id 和 updatedAt 一致 */
export interface GroupShape {
  name: string
  selectorTag: string
  deviceIds: string[]
  match: TrafficMatch
  candidates: Candidates
  selection: Selection
  targetIds: string[]
  targetMode: 'all' | 'any'
  strategy: Strategy
  failThreshold: number
  recoverThreshold: number
  probeIntervalSec: number
  toleranceMs: number
  failback: boolean
  interruptExisting: boolean
  onAllFail: AllFailAction
}

/**
 * 校验并规范化一个分组。
 *
 * knownTargetIds 用来查规则引用的目标还在不在：目标是人手工建的，引用没了就是错，
 * 要报错让人重选。knownNodeIds 不同——节点跟着订阅来去，选中的节点消失了就悄悄去掉，
 * 只有整个列表被清空才算错。
 */
export function checkGroup(
  input: unknown,
  knownTargetIds: Set<string>,
  knownNodeIds: Set<string>,
): GroupShape {
  if (!input || typeof input !== 'object') fail('name', '请求内容不是有效的分组。')
  const raw = input as Record<string, unknown>

  const name = asName(raw.name, 'name', '分组名称', 60)

  const selectorTag = asString(raw.selectorTag, 'selectorTag').trim()
  if (!selectorTag) fail('selectorTag', '请填写 selector tag。')
  if (!/^[A-Za-z0-9_-]+$/.test(selectorTag)) {
    fail('selectorTag', 'selector tag 只能包含字母、数字、- 和 _。')
  }
  if (selectorTag.length > 60) fail('selectorTag', 'selector tag 最多 60 个字符。')
  if (RESERVED_SELECTOR_TAGS.includes(selectorTag)) {
    fail('selectorTag', `「${selectorTag}」在生成的 sing-box 配置里另有用处，换一个名字。`)
  }

  // 一台都不选表示用在所有设备上，包括以后接入的
  const deviceIds = asStringList(raw.deviceIds, 'deviceIds')

  const match = checkMatch(raw.match ?? EMPTY_MATCH)

  let candidates = checkCandidates(raw.candidates)
  if (candidates.mode === 'list') {
    const nodeIds = candidates.nodeIds.filter((id) => knownNodeIds.has(id))
    if (!nodeIds.length) fail('candidates', '选中的节点都不在了，请重新挑选候选节点。')
    candidates = { mode: 'list', nodeIds }
  }

  const selectionText = asString(raw.selection ?? 'auto', 'selection')
  if (!SELECTIONS.includes(selectionText as Selection)) {
    fail('selection', '选择方式只能是按规则自动切换或手动选择。')
  }
  const selection = selectionText as Selection

  let targetIds = asStringList(raw.targetIds, 'targetIds')
  if (selection === 'manual') {
    // 手动选择不探测，保存时清空规则
    targetIds = []
  } else {
    if (!targetIds.length) fail('targetIds', '按规则自动切换时至少要有一条分组规则。')
    if (targetIds.some((id) => !knownTargetIds.has(id))) {
      fail('targetIds', '有分组规则引用的探测目标已经不存在了，请重新选择。')
    }
  }

  const strategyText = asString(raw.strategy ?? 'priority', 'strategy')
  if (!STRATEGIES.includes(strategyText as Strategy)) {
    fail('strategy', '选择方式只能是按优先级或按延迟。')
  }

  const allFailText = asString(raw.onAllFail ?? 'block', 'onAllFail')
  if (!ALL_FAIL.includes(allFailText as AllFailAction)) {
    fail('onAllFail', '全部不可用时只能选阻断、保持当前节点或改走直连。')
  }

  const num = (key: string, min: number, max: number, fallback: number) =>
    raw[key] === undefined ? fallback : asInt(raw[key], key, min, max)

  return {
    name,
    selectorTag,
    deviceIds,
    match,
    candidates,
    selection,
    targetIds,
    targetMode: raw.targetMode === 'any' ? 'any' : 'all',
    strategy: strategyText as Strategy,
    failThreshold: num('failThreshold', 1, 10, 3),
    recoverThreshold: num('recoverThreshold', 1, 10, 2),
    probeIntervalSec: num('probeIntervalSec', 5, 600, 60),
    toleranceMs: num('toleranceMs', 0, 1000, 150),
    failback: raw.failback === undefined ? true : asBool(raw.failback, 'failback'),
    interruptExisting:
      raw.interruptExisting === undefined
        ? false
        : asBool(raw.interruptExisting, 'interruptExisting'),
    onAllFail: allFailText as AllFailAction,
  }
}

/**
 * 兜底分组在同一台设备上只能有一个：sing-box 的 route.final 只有一个出口，
 * 两个兜底分组同时用在一台设备上，后一个永远接不到流量。
 */
export function checkCatchAll(shape: GroupShape, others: Group[]): void {
  if (!isCatchAll(shape.match)) return
  const clash = others.find((g) => isCatchAll(g.match) && sharesDevice(g, shape))
  if (!clash) return
  const where = shape.deviceIds.length && clash.deviceIds.length ? '同一台设备上' : '所有设备上'
  fail(
    'match',
    `「${clash.name}」已经是${where}的兜底分组了。给这个分组设一类接管条件，或者把它用在别的设备上。`,
  )
}
