/**
 * singweb 前端与管理服务之间的数据约定。
 * 字段含义与 docs/api.md 一致；时间一律为 ISO 8601 字符串。
 */

export type Platform = 'macos' | 'linux' | 'windows'

/** 运行 sing-box 和 singweb Agent 的一台设备 */
export interface Device {
  id: string
  name: string
  hostname: string
  platform: Platform
  /** macOS 上是系统版本号（15.6），Linux 上是 os-release 里的发行版和版本（Ubuntu 24.04），Windows 上是内核版本 */
  osVersion: string
  agentVersion: string
  singboxVersion: string
  online: boolean
  /** Agent 最后一次上报的时间 */
  lastSeenAt: string
  /** sing-box Clash API 地址，Agent 通过它切换 selector */
  clashApi: string
  /** Agent 逐节点探测用的本地 socks 入站 */
  probeInbound: string
  /** Agent 写入阻断规则集等文件的目录 */
  dataDir: string
  /** 本机代理（HTTP 和 SOCKS5）的监听地址，由 Agent 管理的 sing-box 提供；空表示 sing-box 还没起来 */
  proxyListen: string
  /** 本机 sing-box 起不来的原因，比如端口被占、找不到程序；null 表示正常 */
  singboxError: string | null
  note?: string
}

export type NodeProtocol = 'shadowsocks' | 'vmess' | 'vless' | 'trojan' | 'hysteria2' | 'tuic'

/** sing-box 配置里的一个代理出站 */
export interface ProxyNode {
  id: string
  /** sing-box outbound tag */
  tag: string
  protocol: NodeProtocol
  server: string
  port: number
  region: string
  /** 停用后不参与任何分组，也不再探测 */
  enabled: boolean
  /** 来源的名字，显示用 */
  source: string
  /** 来自哪个订阅，手动添加的节点为 null */
  sourceId: string | null
}

/** 一个订阅地址；节点页按来源分组显示，也用来导入节点 */
export interface NodeSource {
  id: string
  name: string
  /** 完整的订阅链接，含 token。只存在管理服务的数据库里，设备不知道它 */
  url: string
  enabled: boolean
  /** 最近一次拉取的结果 */
  lastFetchedAt: string | null
  lastError: string | null
  /** 最近一次拉取解析出的节点数 */
  nodeCount: number
  createdAt: string
}

/** 分组规则的类型，也就是探测目标的类型 */
export type TargetKind = 'ssh' | 'http' | 'tcp'
/** SSH 探测做到哪一步：读到 SSH 标识，或完成 SSH 握手（均不登录） */
export type SshLevel = 'banner' | 'handshake'

interface TargetBase {
  id: string
  name: string
  timeoutMs: number
  note?: string
}

/** 经过节点连接 SSH 服务 */
export interface SshTarget extends TargetBase {
  kind: 'ssh'
  host: string
  port: number
  level: SshLevel
  /** 期望的主机密钥指纹（SHA256:…），仅在 handshake 级别校验；留空不校验 */
  hostKey: string
}

/** 经过节点请求一个网址 */
export interface HttpTarget extends TargetBase {
  kind: 'http'
  url: string
  /** 算作通过的状态码；为空时 200–399 都算通过 */
  expectStatus: number[]
  /** 非空时，响应内容里还要包含这段文字 */
  keyword: string | null
}

/** 只检查能否经过节点连上目标端口 */
export interface TcpTarget extends TargetBase {
  kind: 'tcp'
  host: string
  port: number
}

/** 探测目标：分组规则引用它，同一个目标可以被多个分组使用 */
export type Target = SshTarget | HttpTarget | TcpTarget

/** Omit 不会分别作用到联合类型的每一种，这里逐个处理 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type TargetInput = DistributiveOmit<Target, 'id'>

export type Strategy = 'priority' | 'latency'
export type AllFailAction = 'block' | 'keep-last' | 'direct'

/** sing-box 能嗅探出来的协议 */
export type SniffProtocol = 'http' | 'tls' | 'quic' | 'ssh' | 'rdp' | 'bittorrent'

/**
 * 哪些流量交给这个分组的 selector。
 * 条件分三类：目标地址、协议或端口、进程。同一类里满足任意一项即可，设置了的几类要同时满足
 */
export interface TrafficMatch {
  /** 域名，含子域名 */
  domains: string[]
  /** 域名里包含这些文字 */
  domainKeywords: string[]
  /** 目标 IP 段 */
  ipCidrs: string[]
  /** 设备 sing-box 配置里已经定义的规则集 tag */
  ruleSets: string[]
  /** 按嗅探到的协议 */
  protocols: SniffProtocol[]
  /** 按目标端口 */
  ports: number[]
  /** 发起连接的进程名 */
  processNames: string[]
}

/** 按条件挑候选节点；每一项为空表示不限 */
export interface NodeFilter {
  regions: string[]
  protocols: NodeProtocol[]
  /** 节点名称包含其中任意一个（不区分大小写） */
  include: string[]
  /** 节点名称包含其中任意一个就排除 */
  exclude: string[]
}

/** 候选节点：逐个挑选并排好优先级，或者按条件自动加入（顺序跟节点列表一致） */
export type Candidates = { mode: 'list'; nodeIds: string[] } | { mode: 'filter'; filter: NodeFilter }

/** auto：按分组规则探测、自动切换；manual：不探测，在设备页手动选择 */
export type Selection = 'auto' | 'manual'

/** 一个分组，对应设备上 sing-box 的一个 selector 出站 */
export interface Group {
  id: string
  name: string
  selectorTag: string
  /** 用在哪些设备上；空数组表示所有设备，包括以后接入的 */
  deviceIds: string[]
  /** 一项条件都没设的是兜底分组，接管别的分组没接管的流量 */
  match: TrafficMatch
  candidates: Candidates
  selection: Selection
  /** 分组规则：每条规则引用一个探测目标。手动选择的分组没有规则 */
  targetIds: string[]
  /** all：所有规则都通过才算可用；any：任一规则通过即可 */
  targetMode: 'all' | 'any'
  strategy: Strategy
  /** 连续失败多少轮判定为不可用 */
  failThreshold: number
  /** 不可用节点连续成功多少轮才重新可用 */
  recoverThreshold: number
  probeIntervalSec: number
  /** 按延迟选择时，新节点至少要快这么多毫秒才切换 */
  toleranceMs: number
  /** 按优先级选择时，更高优先级节点恢复后是否切回 */
  failback: boolean
  /** 切换时是否断开经过旧节点的已有连接 */
  interruptExisting: boolean
  onAllFail: AllFailAction
  updatedAt: string
}

export type GroupInput = Omit<Group, 'id' | 'updatedAt'>

/** 表示 selector 选中了直连出站 */
export const DIRECT = 'direct'

export type HealthState = 'up' | 'down' | 'unknown'

/** 一轮探测对某节点的判定（按分组规则和判定方式） */
export interface RoundSample {
  at: string
  ok: boolean
  latencyMs: number | null
}

/** 某设备上、某分组里一个候选节点的健康状态 */
export interface NodeHealth {
  nodeId: string
  state: HealthState
  consecutiveFails: number
  consecutiveSuccesses: number
  /** 近 5 轮通过时的延迟中位数 */
  latencyMs: number | null
  lastRoundOk: boolean | null
  /** 最近一轮没通过的规则（探测目标） */
  failingTargetIds: string[]
  changedAt: string | null
  history: RoundSample[]
}

export type RuntimeState =
  | 'ok'
  | 'degraded'
  | 'pinned'
  | 'pinned-down'
  | 'failing'
  | 'blocked'
  | 'direct'
  | 'manual'
  | 'unknown'
  | 'stale'

export interface SwitchRecord {
  at: string
  from: string | null
  to: string | null
  reason: string
}

/** 某设备上某分组的实时状态 */
export interface GroupRuntime {
  deviceId: string
  groupId: string
  /** selector 当前选中的节点；null 表示已阻断，DIRECT 表示直连 */
  activeNodeId: string | null
  /** 自动分组里手动固定的节点；手动分组里手动选择的节点 */
  pinnedNodeId: string | null
  state: RuntimeState
  /** 当前可用、组成分组的节点，按优先级排序；手动分组里是所有启用的候选节点 */
  eligibleNodeIds: string[]
  /** 各候选节点的健康状态；手动分组不探测，为空 */
  nodes: NodeHealth[]
  /**
   * 设备上这个 selector 实际认得的节点，Agent 从 Clash API 读出来上报。
   * 网页上的候选列表来自数据库，设备上的来自 sing-box 配置文件，两边可能对不上；
   * 切换只能切到设备认得的节点上，所以它是校验依据。
   * null 表示没读出来（Clash API 不通），空数组表示设备上确实一个都没有——两者不能混。
   */
  availableNodeIds: string[] | null
  lastRoundAt: string | null
  lastSwitch: SwitchRecord | null
  /**
   * 排队中或已失败的切换。
   *
   * 点完节点网页只能显示"正在切换"，设备要是没执行，用户没别的办法知道。
   * 这里把队列里那条待办带出来：还在等设备时显示进度，放弃重试后显示失败原因和重试按钮。
   */
  pendingSwitch: PendingSwitch | null
}

/** 网页上显示的待办状态；重试的次数上限由服务端决定 */
export interface PendingSwitch {
  id: string
  /** 要切到的节点；null 表示恢复自动选择 */
  nodeId: string | null
  /** 设备试过几次 */
  attempts: number
  /** 最近一次失败的原因，设备报上来的原文 */
  lastError: string | null
  /** 有值表示服务端已经放弃重试，网页上显示为失败 */
  failedAt: string | null
}

/**
 * 探测完成到哪一步。
 * SSH：tcp → banner → handshake；HTTP：tcp → tls（仅 https）→ response；TCP：tcp
 */
export type ProbeStage = 'tcp' | 'banner' | 'handshake' | 'tls' | 'response'

export type ProbeError =
  | 'timeout'
  | 'refused'
  | 'reset'
  | 'proxy'
  | 'dns'
  | 'banner'
  | 'hostkey'
  | 'tls'
  | 'status'
  | 'keyword'

export interface ProbeSample {
  at: string
  ok: boolean
  /** 成功时为完成探测的耗时；失败时为出错前的耗时 */
  latencyMs: number | null
  /** 实际完成到哪一步；null 表示 TCP 都没连上 */
  stage: ProbeStage | null
  error?: ProbeError
}

export interface ProbeDetail extends ProbeSample {
  /** SSH 探测收到的标识 */
  banner?: string
  /** SSH 握手拿到的主机密钥指纹 */
  hostKey?: string
  /** HTTP 探测收到的状态码 */
  status?: number
}

/** 设备 → 节点 → 目标 的探测结果 */
export interface ProbeCell {
  deviceId: string
  nodeId: string
  targetId: string
  last: ProbeDetail | null
  /** 从旧到新，最多 40 条 */
  history: ProbeSample[]
}

export type EventKind =
  | 'switch'
  | 'switch-failed'
  | 'node-down'
  | 'node-up'
  | 'all-down'
  | 'recovered'
  | 'pin'
  | 'unpin'
  | 'device-offline'
  | 'device-online'
  /** 有人拿着别的设备的 id 和密钥想要接入，被拒了 */
  | 'device-rejected'
  | 'group-changed'
  | 'node-changed'

export type Severity = 'info' | 'good' | 'warn' | 'crit'

export interface AppEvent {
  id: string
  at: string
  kind: EventKind
  severity: Severity
  deviceId: string | null
  groupId: string | null
  nodeId: string | null
  from?: string | null
  to?: string | null
  /** 一句话说明发生了什么、为什么 */
  message: string
}

export interface EventQuery {
  deviceId?: string
  groupId?: string
  kinds?: EventKind[]
  severities?: Severity[]
  since?: string
  cursor?: string
  limit?: number
}

export interface EventPage {
  items: AppEvent[]
  nextCursor: string | null
}

export type UpdateScope =
  | 'devices'
  | 'nodes'
  | 'sources'
  | 'targets'
  | 'groups'
  | 'runtimes'
  | 'probes'
  | 'events'

/** 服务端推送：告诉前端哪些数据变了 */
export type LiveMessage = { type: 'update'; scopes: UpdateScope[] } | { type: 'reset' }

export type Role = 'admin' | 'viewer'

/** 一份生成好的 sing-box 配置。密钥位置是占位符，不是真值 */
export interface ConfigPreview {
  config: Record<string, unknown>
  /** 生成时跳过的内容，写给人看 */
  warnings: string[]
}

/** 登录的账号。密码只在登录请求里出现，服务端从不回传 */
export interface User {
  id: string
  username: string
  role: Role
  createdAt: string
}
