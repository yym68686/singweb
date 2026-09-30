import type { Device, Group, ProxyNode, TrafficMatch } from './types.ts'
import { DIRECT } from './types.ts'
import { candidateIds } from './candidates.ts'

export const PROBE_INBOUND = 'singweb-probe'
export const SECRET_PLACEHOLDER = '<由 Agent 生成>'
/** 规则动作（sniff / route / reject）需要 sing-box 1.11 及以上 */
export const MIN_SINGBOX = '1.11.0'

export const blockRuleSetTag = (g: Pick<Group, 'selectorTag'>) => `singweb-block-${g.selectorTag}`
export const blockRuleSetPath = (d: Pick<Device, 'dataDir'>, g: Pick<Group, 'selectorTag'>) =>
  `${d.dataDir}/block-${g.selectorTag}.json`

export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map((x) => parseInt(x, 10) || 0)
  const b = min.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

function splitHostPort(addr: string): { host: string; port: number } {
  const i = addr.lastIndexOf(':')
  return { host: addr.slice(0, i), port: Number(addr.slice(i + 1)) }
}

const hasDest = (m: TrafficMatch) =>
  m.domains.length + m.domainKeywords.length + m.ipCidrs.length + m.ruleSets.length > 0

/** 设置了几类接管条件：目标地址、协议或端口、进程 */
const categoryCount = (m: TrafficMatch) =>
  Number(hasDest(m)) + Number(m.protocols.length + m.ports.length > 0) + Number(m.processNames.length > 0)

/** 按协议、域名匹配都要先嗅探；规则集里通常也是域名 */
const needsSniff = (m: TrafficMatch) =>
  m.protocols.length + m.domains.length + m.domainKeywords.length + m.ruleSets.length > 0

/**
 * 把接管条件写成路由规则。
 * 同一条规则里，域名、域名关键字、IP 段和规则集同属目标地址，满足任一即可；
 * 协议和端口是两类字段，写进同一条规则就要同时满足，所以按协议、按端口各写一条。
 * 进程名和其他字段要同时满足。
 */
export function matchConditions(m: TrafficMatch): Record<string, unknown>[] {
  const dest: Record<string, unknown> = {}
  if (m.domains.length) dest.domain_suffix = m.domains
  if (m.domainKeywords.length) dest.domain_keyword = m.domainKeywords
  if (m.ipCidrs.length) dest.ip_cidr = m.ipCidrs
  if (m.ruleSets.length) dest.rule_set = m.ruleSets
  const proc = m.processNames.length ? { process_name: m.processNames } : {}
  const either: Record<string, unknown>[] = []
  if (m.protocols.length) either.push({ protocol: m.protocols })
  if (m.ports.length) either.push({ port: m.ports })
  return (either.length ? either : [{}]).map((e) => ({ ...dest, ...e, ...proc }))
}

/** 分组引用的规则集：要在设备的 sing-box 配置里已经定义 */
export function externalRuleSets(groups: Group[]): string[] {
  return [...new Set(groups.flatMap((g) => g.match.ruleSets))]
}

interface SnippetInput {
  device: Device
  /** 应用到这台设备的分组 */
  groups: Group[]
  nodes: ProxyNode[]
}

/** 生成 singweb 需要合并进设备 sing-box 配置的部分 */
export function buildSnippet({ device, groups, nodes }: SnippetInput) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const auto = (g: Group) => g.selection === 'auto'
  const candidates = (g: Group) =>
    candidateIds(g, nodes)
      .map((id) => byId.get(id))
      .filter((n): n is ProxyNode => !!n && n.enabled)
  const selectorTags = (g: Group) => {
    const tags = candidates(g).map((n) => n.tag)
    if (auto(g) && g.onAllFail === 'direct') tags.push(DIRECT)
    return tags
  }
  // 没有可选出口的分组不生成 selector（sing-box 不接受空的 selector），它的流量直接拒绝
  const noOutlet = (g: Group) => selectorTags(g).length === 0
  // 全部不可用时阻断：Agent 往这个规则集里写入匹配所有连接的规则
  const blocking = (g: Group) => auto(g) && g.onAllFail === 'block' && !noOutlet(g)

  // 手动选择的分组不探测，不需要探测用户
  const probing = groups.some(auto)
  const probeTags = [...new Set(groups.filter(auto).flatMap((g) => candidates(g).map((n) => n.tag)))]
  const { host, port } = splitHostPort(device.probeInbound)
  // 条件类别多的分组更具体，先匹配；一样多时有目标地址条件的在前，其余按分组列表的顺序
  const ordered = [...groups].sort(
    (a, b) => categoryCount(b.match) - categoryCount(a.match) || Number(hasDest(b.match)) - Number(hasDest(a.match)),
  )

  const rules: Record<string, unknown>[] = probing
    ? [
        ...probeTags.map((tag) => ({
          inbound: PROBE_INBOUND,
          auth_user: `probe-${tag}`,
          action: 'route',
          outbound: tag,
        })),
        { inbound: PROBE_INBOUND, action: 'reject' },
      ]
    : []
  if (groups.some((g) => needsSniff(g.match))) rules.push({ action: 'sniff' })
  for (const g of ordered) {
    for (const c of matchConditions(g.match)) {
      // 一条规则里的多个规则集之间是“或”，阻断规则集要用 logical and 和接管条件组合
      if (blocking(g)) {
        rules.push({ type: 'logical', mode: 'and', rules: [{ rule_set: blockRuleSetTag(g) }, c], action: 'reject' })
      }
    }
    for (const c of matchConditions(g.match)) {
      rules.push(noOutlet(g) ? { ...c, action: 'reject' } : { ...c, action: 'route', outbound: g.selectorTag })
    }
  }

  const outbounds: Record<string, unknown>[] = groups
    .filter((g) => !noOutlet(g))
    .map((g) => {
      const tags = selectorTags(g)
      return {
        type: 'selector',
        tag: g.selectorTag,
        outbounds: tags,
        default: tags[0],
        interrupt_exist_connections: g.interruptExisting,
      }
    })
  if (groups.some((g) => auto(g) && g.onAllFail === 'direct' && !noOutlet(g))) {
    outbounds.push({ type: 'direct', tag: DIRECT })
  }

  const ruleSets = groups.filter(blocking).map((g) => ({
    type: 'local',
    tag: blockRuleSetTag(g),
    format: 'source',
    path: blockRuleSetPath(device, g),
  }))

  return {
    ...(probing
      ? {
          inbounds: [
            {
              type: 'socks',
              tag: PROBE_INBOUND,
              listen: host,
              listen_port: port,
              users: probeTags.map((tag) => ({ username: `probe-${tag}`, password: SECRET_PLACEHOLDER })),
            },
          ],
        }
      : {}),
    outbounds,
    route: {
      rules,
      ...(ruleSets.length ? { rule_set: ruleSets } : {}),
    },
    experimental: {
      clash_api: {
        external_controller: device.clashApi,
        secret: SECRET_PLACEHOLDER,
      },
    },
  }
}

/** 阻断规则集文件的两种内容：平时为空，全部不可用时匹配所有 TCP 和 UDP 连接 */
export const blockRuleSetContent = {
  idle: { version: 3, rules: [] },
  blocking: { version: 3, rules: [{ network: ['tcp', 'udp'] }] },
}

export function toJson(v: unknown): string {
  return JSON.stringify(v, null, 2)
}
