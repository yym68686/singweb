import type {
  AllFailAction,
  Device,
  EventKind,
  HealthState,
  NodeProtocol,
  Platform,
  ProbeDetail,
  ProbeError,
  ProbeStage,
  RuntimeState,
  Selection,
  Severity,
  SniffProtocol,
  SshLevel,
  Strategy,
  TargetKind,
} from '../api/types'

export const platformLabel: Record<Platform, string> = { macos: 'macOS', linux: 'Linux' }

/** “macOS 15.6”“Ubuntu 24.04”：Linux 的发行版名称已经说明了系统 */
export function osText(d: Pick<Device, 'platform' | 'osVersion'>): string {
  if (!d.osVersion) return platformLabel[d.platform]
  return d.platform === 'macos' ? `macOS ${d.osVersion}` : d.osVersion
}

export const protocolLabel: Record<NodeProtocol, string> = {
  shadowsocks: 'Shadowsocks',
  vmess: 'VMess',
  vless: 'VLESS',
  trojan: 'Trojan',
  hysteria2: 'Hysteria2',
  tuic: 'TUIC',
}

export const targetKindLabel: Record<TargetKind, string> = {
  ssh: 'SSH 探测',
  http: 'HTTP 探测',
  tcp: 'TCP 探测',
}

export const targetKindHint: Record<TargetKind, string> = {
  ssh: '经过节点连接 SSH 服务，检查标识或完成握手，不会登录。',
  http: '经过节点请求一个网址，检查状态码和响应内容，能发现某些节点被网站拒绝。',
  tcp: '只检查能否经过节点连上目标端口，适合数据库、远程桌面等。',
}

export const sshLevelLabel: Record<SshLevel, string> = {
  banner: 'SSH 标识',
  handshake: 'SSH 握手',
}

export const sshLevelHint: Record<SshLevel, string> = {
  banner: '连上后读取服务端发来的 SSH-2.0 标识，能区分 SSH 服务和其他服务。',
  handshake: '完成密钥交换，填了指纹时还会核对主机密钥，能发现中间人。不会登录。',
}

export const sniffProtocolLabel: Record<SniffProtocol, string> = {
  http: 'HTTP',
  tls: 'TLS（HTTPS 等）',
  quic: 'QUIC（HTTP/3 等）',
  ssh: 'SSH',
  rdp: '远程桌面（RDP）',
  bittorrent: 'BitTorrent',
}

/** 摘要里用的短名称 */
export const sniffProtocolShort: Record<SniffProtocol, string> = {
  http: 'HTTP',
  tls: 'TLS',
  quic: 'QUIC',
  ssh: 'SSH',
  rdp: 'RDP',
  bittorrent: 'BitTorrent',
}

export const selectionLabel: Record<Selection, string> = {
  auto: '按规则自动切换',
  manual: '手动选择',
}

export const candidateModeLabel = {
  list: '手动挑选',
  filter: '按条件自动加入',
} as const

export const probeErrorLabel: Record<ProbeError, string> = {
  timeout: '超时',
  refused: '连接被拒绝',
  reset: '连接被重置',
  proxy: '连不上节点',
  dns: '域名解析失败',
  banner: '没收到 SSH 标识',
  hostkey: '主机密钥不匹配',
  tls: 'TLS 握手失败',
  status: '状态码不符',
  keyword: '响应里没有关键字',
}

/** 一次失败的探测怎么称呼：状态码不符时直接写出收到的状态码 */
export function probeFailText(d: Pick<ProbeDetail, 'error' | 'status'>): string {
  if (d.error === 'status' && d.status !== undefined) return `返回 ${d.status}`
  return d.error ? probeErrorLabel[d.error] : '失败'
}

export const healthLabel: Record<HealthState, string> = {
  up: '可用',
  down: '不可用',
  unknown: '待探测',
}

export const runtimeLabel: Record<RuntimeState, string> = {
  ok: '正常',
  degraded: '没有备用节点',
  pinned: '已手动固定',
  'pinned-down': '固定的节点不可用',
  failing: '没有可用节点',
  blocked: '已阻断',
  direct: '已改走直连',
  manual: '手动选择',
  unknown: '等待首轮探测',
  stale: '设备离线',
}

export const eventKindLabel: Record<EventKind, string> = {
  switch: '切换节点',
  'node-down': '节点不可用',
  'node-up': '节点恢复',
  'all-down': '全部不可用',
  recovered: '出口恢复',
  pin: '手动固定',
  unpin: '取消固定',
  'device-offline': '设备离线',
  'device-online': '设备上线',
  'group-changed': '分组变更',
  'node-changed': '节点变更',
}

export const severityLabel: Record<Severity, string> = {
  info: '信息',
  good: '恢复',
  warn: '警告',
  crit: '严重',
}

export const strategyLabel: Record<Strategy, string> = {
  priority: '按优先级',
  latency: '按延迟',
}

export const allFailLabel: Record<AllFailAction, string> = {
  block: '阻断并告警',
  'keep-last': '保持当前节点并告警',
  direct: '改走直连并告警',
}

/** 探测失败时，已经走到了哪一步 */
export const probeStageDone: Record<ProbeStage, string> = {
  tcp: 'TCP 已连通',
  banner: '已收到 SSH 标识',
  handshake: 'SSH 握手已完成',
  tls: 'TLS 握手已完成',
  response: '已收到 HTTP 响应',
}
