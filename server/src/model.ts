/**
 * 服务端用到的类型。
 *
 * 和前端共享的部分放在 shared/types.ts（那边是前端类型文件的镜像）；
 * 这里只放管理服务自己的内部类型：数据库行的形状、API 清单里没有的请求体、
 * 上报时的载荷。时间在库里是 timestamptz，读出来是 Date，对外一律转成 ISO 字符串。
 */

import type {
  AllFailAction,
  AppEvent,
  Candidates,
  Device,
  EventKind,
  Group,
  GroupRuntime,
  HealthState,
  NodeHealth,
  NodeOutbound,
  NodeProtocol,
  NodeSource,
  Platform,
  ProbeDetail,
  ProbeSample,
  ProxyNode,
  RoundSample,
  Selection,
  Severity,
  SniffProtocol,
  StoredNode,
  Strategy,
  SwitchRecord,
  Target,
  TargetKind,
  TrafficMatch,
  UserAccount,
  UserRole,
} from '../../shared/types.ts'

export type {
  AllFailAction,
  AppEvent,
  Candidates,
  Device,
  EventKind,
  Group,
  GroupRuntime,
  HealthState,
  NodeHealth,
  NodeOutbound,
  NodeProtocol,
  NodeSource,
  Platform,
  ProbeDetail,
  ProbeSample,
  ProxyNode,
  RoundSample,
  Selection,
  Severity,
  SniffProtocol,
  StoredNode,
  Strategy,
  SwitchRecord,
  Target,
  TargetKind,
  TrafficMatch,
  UserAccount,
  UserRole,
}

/** jsonb 列在 pg 里是任意值，写之前统一收窄 */
export type Json = unknown

/** 空白的 TrafficMatch，新建分组时的初值 */
export const EMPTY_MATCH: TrafficMatch = {
  domains: [],
  domainKeywords: [],
  ipCidrs: [],
  ruleSets: [],
  protocols: [],
  ports: [],
  processNames: [],
}

/** Agent 离线判定：这么久没上报就当离线 */
export const OFFLINE_AFTER_MS = 90_000

// ---------------------------------------------------------------- 数据库行

/** users 表 */
export interface UserRow {
  id: string
  username: string
  password_hash: string
  role: string
  created_at: Date
}

/** sessions 表 */
export interface SessionRow {
  token_hash: string
  user_id: string
  created_at: Date
  expires_at: Date
}

/** devices 表。secret 只在服务端用，绝不出现在任何响应里 */
export interface DeviceRow {
  id: string
  name: string
  hostname: string
  platform: string
  os_version: string
  agent_version: string
  singbox_version: string
  last_seen_at: Date
  clash_api: string
  probe_inbound: string
  data_dir: string
  note: string | null
  secret: string
  created_at: Date
}

/** node_sources 表。url 含订阅 token，只在这里出现 */
export interface NodeSourceRow {
  id: string
  name: string
  url: string
  enabled: boolean
  last_fetched_at: Date | null
  last_error: string | null
  node_count: number
  /** 有值表示用户在网页上点了「立即刷新」，等设备领走 */
  refresh_requested_at: Date | null
  created_at: Date
}

/** nodes 表 */
export interface NodeRow {
  id: string
  tag: string
  protocol: string
  server: string
  port: number
  region: string
  enabled: boolean
  source: string
  outbound: NodeOutbound
  source_id: string | null
  identity: string
  updated_at: Date
}

/** targets 表。spec 是按 kind 拆开的字段 */
export interface TargetRow {
  id: string
  name: string
  kind: string
  timeout_ms: number
  note: string | null
  spec: Record<string, Json>
  updated_at: Date
}

/** groups 表 */
export interface GroupRow {
  id: string
  name: string
  selector_tag: string
  device_ids: string[]
  match: TrafficMatch
  candidates: Candidates
  selection: string
  target_ids: string[]
  target_mode: string
  strategy: string
  fail_threshold: number
  recover_threshold: number
  probe_interval_sec: number
  tolerance_ms: number
  failback: boolean
  interrupt_existing: boolean
  on_all_fail: string
  updated_at: Date
}

/** group_runtime 表 */
export interface RuntimeRow {
  device_id: string
  group_id: string
  active_node_id: string | null
  pinned_node_id: string | null
  nodes: NodeHealth[]
  /** 设备上 selector 实际认得的节点。null 表示没读出来，跟空数组不是一回事 */
  available_node_ids: string[] | null
  last_round_at: Date | null
  last_switch: SwitchRecord | null
  reported_at: Date
}

/** probes 表 */
export interface ProbeRow {
  device_id: string
  node_id: string
  target_id: string
  last: ProbeDetail | null
  history: ProbeSample[]
  updated_at: Date
}

/** events 表 */
export interface EventRow {
  id: string
  at: Date
  kind: string
  severity: string
  device_id: string | null
  group_id: string | null
  node_id: string | null
  from_id: string | null
  to_id: string | null
  message: string
}

/** pending_switches 表 */
export interface PendingSwitchRow {
  id: string
  device_id: string
  group_id: string
  node_id: string | null
  reason: string
  /** Agent 试过几次。失败一次加一，到上限就不再下发 */
  attempts: number
  /** 最近一次失败的原因，Agent 报上来的原文 */
  last_error: string | null
  /** 有值表示已经放弃重试，网页上显示为失败 */
  failed_at: Date | null
  created_at: Date
}

// ---------------------------------------------------------------- 行 → 接口类型

export function toDevice(row: DeviceRow, now = Date.now()): Device {
  const device: Device = {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    platform: row.platform as Platform,
    osVersion: row.os_version,
    agentVersion: row.agent_version,
    singboxVersion: row.singbox_version,
    online: now - row.last_seen_at.getTime() < OFFLINE_AFTER_MS,
    lastSeenAt: row.last_seen_at.toISOString(),
    clashApi: row.clash_api,
    probeInbound: row.probe_inbound,
    dataDir: row.data_dir,
  }
  if (row.note) device.note = row.note
  return device
}

/** 设备在线判断，单独拎出来给路由用 */
export function isOnline(row: DeviceRow, now = Date.now()): boolean {
  return now - row.last_seen_at.getTime() < OFFLINE_AFTER_MS
}

/** 下发给前端的节点：不带出站内容和订阅 id */
export function toProxyNode(row: NodeRow): ProxyNode {
  return {
    id: row.id,
    tag: row.tag,
    protocol: row.protocol as NodeProtocol,
    server: row.server,
    port: row.port,
    region: row.region,
    enabled: row.enabled,
    source: row.source,
  }
}

/** 完整的节点记录，只有 Agent 用得到 */
export function toStoredNode(row: NodeRow): StoredNode {
  return {
    ...toProxyNode(row),
    outbound: row.outbound,
    sourceId: row.source_id,
  }
}

export function toNodeSource(row: NodeSourceRow): NodeSource {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    lastFetchedAt: row.last_fetched_at ? row.last_fetched_at.toISOString() : null,
    lastError: row.last_error,
    nodeCount: row.node_count,
    createdAt: row.created_at.toISOString(),
    refreshRequested: Boolean(row.refresh_requested_at),
  }
}

export function toTarget(row: TargetRow): Target {
  const base = { id: row.id, name: row.name, timeoutMs: row.timeout_ms }
  const note = row.note
  const spec = row.spec
  switch (row.kind as TargetKind) {
    case 'ssh':
      return {
        ...base,
        kind: 'ssh',
        host: String(spec.host ?? ''),
        port: Number(spec.port ?? 22),
        level: spec.level === 'handshake' ? 'handshake' : 'banner',
        hostKey: typeof spec.hostKey === 'string' ? spec.hostKey : '',
        ...(note ? { note } : {}),
      }
    case 'http':
      return {
        ...base,
        kind: 'http',
        url: String(spec.url ?? ''),
        expectStatus: Array.isArray(spec.expectStatus) ? (spec.expectStatus as number[]) : [],
        keyword: typeof spec.keyword === 'string' ? spec.keyword : null,
        ...(note ? { note } : {}),
      }
    default:
      return {
        ...base,
        kind: 'tcp',
        host: String(spec.host ?? ''),
        port: Number(spec.port ?? 0),
        ...(note ? { note } : {}),
      }
  }
}

/** 目标里影响探测结果的字段。改了这些就清掉原来的探测结果 */
export function probeRelevant(target: Target): string {
  switch (target.kind) {
    case 'ssh':
      return [target.host, target.port, target.level, target.hostKey].join('\u0000')
    case 'http':
      return [target.url, target.expectStatus.join(','), target.keyword ?? ''].join('\u0000')
    case 'tcp':
      return [target.host, target.port].join('\u0000')
  }
}

export function toGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    selectorTag: row.selector_tag,
    deviceIds: row.device_ids,
    match: row.match,
    candidates: row.candidates,
    selection: row.selection as Selection,
    targetIds: row.target_ids,
    targetMode: row.target_mode === 'any' ? 'any' : 'all',
    strategy: row.strategy as Strategy,
    failThreshold: row.fail_threshold,
    recoverThreshold: row.recover_threshold,
    probeIntervalSec: row.probe_interval_sec,
    toleranceMs: row.tolerance_ms,
    failback: row.failback,
    interruptExisting: row.interrupt_existing,
    onAllFail: row.on_all_fail as AllFailAction,
    updatedAt: row.updated_at.toISOString(),
  }
}

export function toEvent(row: EventRow): AppEvent {
  const event: AppEvent = {
    id: row.id,
    at: row.at.toISOString(),
    kind: row.kind as EventKind,
    severity: row.severity as Severity,
    deviceId: row.device_id,
    groupId: row.group_id,
    nodeId: row.node_id,
    message: row.message,
  }
  if (row.from_id !== null || row.to_id !== null) {
    event.from = row.from_id
    event.to = row.to_id
  }
  return event
}

export function toProbeCell(row: ProbeRow) {
  return {
    deviceId: row.device_id,
    nodeId: row.node_id,
    targetId: row.target_id,
    last: row.last,
    history: row.history,
  }
}

// ---------------------------------------------------------------- 上报载荷

/**
 * Agent 上报的一份快照。一次请求里可以带多个设备，正常只有一台。
 * 分组运行状态和探测结果都按设备分组，省得每台设备发一次请求。
 */
export interface ReportPayload {
  device: {
    id: string
    name: string
    hostname: string
    platform: Platform
    osVersion?: string
    agentVersion?: string
    singboxVersion?: string
    clashApi?: string
    probeInbound?: string
    dataDir?: string
    secret?: string
  }
  /** Agent 本机 sing-box 配置里的节点；有订阅时订阅里的节点也一并上报 */
  nodes?: ReportedNode[]
  runtime?: ReportedRuntime[]
  probes?: ReportedProbe[]
  events?: ReportedEvent[]
  /** 请求完成后要让 Agent 执行的操作，见 pendingSwitch 的返回 */
  pending?: PendingSwitchRow[]
}

export interface ReportedNode {
  tag: string
  protocol: NodeProtocol
  server: string
  port: number
  region: string
  outbound: NodeOutbound
  /** 同一个订阅里用来合并重复节点；自己配置里的节点留空 */
  identity?: string
}

export interface ReportedRuntime {
  groupId: string
  activeNodeId: string | null
  pinnedNodeId?: string | null
  nodes: NodeHealth[]
  /**
   * 设备上这个 selector 实际列在 outbounds 里的节点。
   * Agent 读不到时（Clash API 不通、selector 不存在）留空，服务端存成 null
   */
  availableNodeIds?: string[] | null
  lastRoundAt?: string | null
  lastSwitch?: SwitchRecord | null
}

export interface ReportedProbe {
  nodeId: string
  targetId: string
  last: ProbeDetail
  history?: ProbeSample[]
}

export interface ReportedEvent {
  kind: EventKind
  severity: Severity
  at?: string
  groupId?: string | null
  nodeId?: string | null
  from?: string | null
  to?: string | null
  message: string
}

/** 探测历史最多留这么多条 */
export const PROBE_HISTORY_MAX = 40
