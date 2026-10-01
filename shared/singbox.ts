import type { Device, Group, ProxyNode, StoredNode, TrafficMatch } from './types.ts'
import { DIRECT } from './types.ts'
import { candidateIds } from './candidates.ts'
import { isCatchAll } from './groups.ts'

export const PROBE_INBOUND = 'singweb-probe'
export const SECRET_PLACEHOLDER = '<由 Agent 生成>'
/**
 * 生成的配置需要的最低 sing-box 版本。规则动作（sniff / route / reject）是 1.11 加的，
 * DNS 服务器的 type 写法和出站的 domain_resolver 是 1.12 加的——低于 1.12 时
 * sing-box check 会直接拒绝这份配置
 */
export const MIN_SINGBOX = '1.12.0'

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

/** 设备报上来的 sing-box 版本太旧了。还没报版本（刚接入、sing-box 没起来）不算 */
export function singboxTooOld(version: string): boolean {
  return version !== '' && !versionAtLeast(version, MIN_SINGBOX)
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

/** 阻断规则集文件的两种内容：平时为空，全部不可用时匹配所有 TCP 和 UDP 连接 */
export const blockRuleSetContent = {
  idle: { version: 3, rules: [] },
  blocking: { version: 3, rules: [{ network: ['tcp', 'udp'] }] },
}

export function toJson(v: unknown): string {
  return JSON.stringify(v, null, 2)
}

// ---------------------------------------------------------------- 完整配置
//
// 设备拿到的是 singweb 生成的一整份 sing-box 配置，而不是上游订阅：
// 上游有几个订阅、链接是什么，设备一概不知道。节点池在服务端归一化过，
// 分组在这里变成 selector 和路由规则，其余流量走兜底分组。
// Agent 管理的设备和订阅链接用的是同一个生成函数，区别只在 managed 那一项。

/** 没有兜底分组时，其余流量走的 selector：全部启用的节点，默认交给「自动选择」 */
export const ALL_NODES_TAG = '全部节点'
/** 跟 ALL_NODES_TAG 一起出现的 urltest，由 sing-box 自己测延迟挑节点 */
export const AUTO_TAG = '自动选择'
/** 本机代理入站，HTTP 和 SOCKS5 共用一个端口 */
export const MIXED_INBOUND = 'mixed-in'
export const TUN_INBOUND = 'tun-in'
/** 本机代理默认监听的地址 */
export const DEFAULT_LISTEN = '127.0.0.1:2080'
/** sing-box 自带的 urltest 用这个地址测延迟 */
export const URLTEST_URL = 'https://www.gstatic.com/generate_204'

/** 给加密 DNS 打底的明文 DNS，地址是 IP，不需要别人解析 */
const DNS_BASE = 'dns-base'
/**
 * 解析节点地址和直连域名用的 DNS。显式写一个真实 DNS，不用 type: 'local'：
 * 本机开着别的 TUN 代理时，系统 resolver 会返回 198.18.x.x 这种 fake-IP，
 * 拿着假地址去连节点必然失败（Agent 的探测进程踩过这个坑，见 agent/src/probeconfig.ts）。
 */
const DNS_DIRECT = 'dns-direct'
/** 这里只能写主机名，sing-box 会自己拼 https:// 和 path */
const DNS_SERVER = '223.5.5.5'

/** 生成配置时一定会占用的出站 tag，节点不能跟它们重名 */
const RESERVED_TAGS = [ALL_NODES_TAG, AUTO_TAG, DIRECT]

/** selector tag 不能用这些名字，它们在生成的配置里另有用处（分组重名会被配置覆盖掉） */
export const RESERVED_SELECTOR_TAGS = [DIRECT, 'block', 'dns-out', ALL_NODES_TAG, AUTO_TAG]

/**
 * 给节点分配出站 tag。sing-box 要求 tag 唯一，节点池在服务端已经去过重，
 * 这里再兜一道：跟分组的 selector 或保留名字撞了的，后面加序号。
 * Agent 切 selector 时必须用这里分出来的 tag，所以生成结果里会带上这份对照表。
 */
export function outboundTags(
  nodes: Array<Pick<ProxyNode, 'id' | 'tag' | 'protocol' | 'server' | 'port'>>,
  reserved: Iterable<string>,
): Map<string, string> {
  const used = new Set(reserved)
  const out = new Map<string, string>()
  for (const n of nodes) {
    const base = n.tag.trim() || `${n.protocol} ${n.server}:${n.port}`
    let tag = base
    for (let i = 2; used.has(tag); i++) tag = `${base} ${i}`
    used.add(tag)
    out.set(n.id, tag)
  }
  return out
}

/**
 * 规则集 tag 能认出来的，从 SagerNet 官方仓库下载；认不出来的生成不了。
 * geosite-xxx 和 geoip-xxx 是 sing-box 社区通用的命名。
 */
export function remoteRuleSetUrl(tag: string): string | null {
  if (/^geosite-[A-Za-z0-9!@._-]+$/.test(tag)) {
    return `https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/${tag}.srs`
  }
  if (/^geoip-[A-Za-z0-9._-]+$/.test(tag)) {
    return `https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/${tag}.srs`
  }
  return null
}

export interface ConfigInput {
  /** 节点池。停用的节点不会出现在配置里 */
  nodes: StoredNode[]
  /** 用在这台设备上的分组；订阅链接给的是全部分组 */
  groups: Group[]
  /** 本机代理入站的监听地址，默认 127.0.0.1:2080 */
  listen?: string
  /** 加一个 TUN 入站接管整机流量。Agent 管理的设备不用它，免得跟本机已有的代理抢路由 */
  tun?: boolean
  /**
   * 由 Agent 管理时才有。Clash API 让 Agent 能切 selector；数据目录放阻断规则集和缓存。
   * 没有 Agent 在旁边（订阅链接导入的客户端）时，自动分组改用 sing-box 自带的 urltest。
   */
  managed?: { clashApi: string; clashSecret: string; dataDir: string }
  /**
   * 把生成结果里的密钥换成占位符。只给「配置预览」用：预览要发到浏览器上，
   * 而 clashSecret 是 Agent 在本机随机生成的，不该离开那台设备。
   * 真正下发给设备或订阅链接的配置不带这一项。
   */
  redact?: boolean
}

export interface BuiltConfig {
  config: Record<string, unknown>
  /** 节点 id → 配置里的出站 tag */
  tagOf: Map<string, string>
  /** 兜底分组；没有的话其余流量走 ALL_NODES_TAG */
  catchAll: Group | null
  /** 生成时跳过的内容，写给人看 */
  warnings: string[]
}

/** 生成一整份 sing-box 配置 */
export function buildConfig(input: ConfigInput): BuiltConfig {
  const warnings: string[] = []
  const managed = input.managed
  const enabledNodes = input.nodes.filter((n) => n.enabled)
  // 预览时密钥只留占位符；真下发的配置照旧用真值
  const secret = managed && input.redact ? SECRET_PLACEHOLDER : managed?.clashSecret

  // selector tag 重名或者占了保留名字的分组生成不了，跳过并说明
  const groups: Group[] = []
  const selectorTags = new Set<string>()
  for (const g of input.groups) {
    if (RESERVED_SELECTOR_TAGS.includes(g.selectorTag) || selectorTags.has(g.selectorTag)) {
      warnings.push(`分组「${g.name}」的 selector tag「${g.selectorTag}」重名了，没有生成。`)
      continue
    }
    selectorTags.add(g.selectorTag)
    groups.push(g)
  }

  const tagOf = outboundTags(enabledNodes, [...RESERVED_TAGS, ...selectorTags])
  const candidateTags = (g: Group) =>
    candidateIds(g, enabledNodes)
      .map((id) => tagOf.get(id))
      .filter((t): t is string => !!t)

  const auto = (g: Group) => g.selection === 'auto'
  // 没有 Agent 时没人切 selector，自动分组交给 urltest；直连兜底也只有 Agent 能做
  const outletTags = (g: Group) => {
    const tags = candidateTags(g)
    if (managed && auto(g) && g.onAllFail === 'direct' && tags.length) tags.push(DIRECT)
    return tags
  }
  // 没有可用出口的分组不生成 selector（sing-box 不接受空的 selector），它的流量直接拒绝
  const noOutlet = (g: Group) => outletTags(g).length === 0
  const blocking = (g: Group) => !!managed && auto(g) && g.onAllFail === 'block' && !noOutlet(g)

  const catchAlls = groups.filter((g) => isCatchAll(g.match))
  const catchAll = catchAlls[0] ?? null
  for (const extra of catchAlls.slice(1)) {
    warnings.push(`「${extra.name}」和「${catchAll?.name}」都是兜底分组，其余流量只会走「${catchAll?.name}」。`)
  }

  // ---- 出站
  const outbounds: Record<string, unknown>[] = []
  for (const g of groups) {
    if (noOutlet(g)) continue
    const tags = outletTags(g)
    if (!managed && auto(g)) {
      outbounds.push({
        type: 'urltest',
        tag: g.selectorTag,
        outbounds: tags,
        url: URLTEST_URL,
        interval: '5m',
        tolerance: g.toleranceMs,
        interrupt_exist_connections: g.interruptExisting,
      })
    } else {
      outbounds.push({
        type: 'selector',
        tag: g.selectorTag,
        outbounds: tags,
        default: tags[0],
        interrupt_exist_connections: g.interruptExisting,
      })
    }
  }
  const allTags = enabledNodes.map((n) => tagOf.get(n.id) as string)
  // 没有兜底分组时，所有节点放在一起，默认自动选择
  const fallback = !catchAll && allTags.length > 0
  if (fallback) {
    outbounds.push(
      { type: 'selector', tag: ALL_NODES_TAG, outbounds: [AUTO_TAG, ...allTags], default: AUTO_TAG },
      { type: 'urltest', tag: AUTO_TAG, outbounds: allTags, url: URLTEST_URL, interval: '5m', tolerance: 50 },
    )
  }
  for (const n of enabledNodes) {
    outbounds.push({ ...n.outbound, tag: tagOf.get(n.id) })
  }
  outbounds.push({ type: 'direct', tag: DIRECT })

  // 其余流量的出口；兜底分组一个节点都没有时，用拒绝规则挡住，final 只是占位
  const finalTag = catchAll ? (noOutlet(catchAll) ? null : catchAll.selectorTag) : fallback ? ALL_NODES_TAG : null

  // ---- 规则集：阻断用的本地规则集，加上分组引用的远程规则集
  const ruleSets: Record<string, unknown>[] = []
  if (managed) {
    for (const g of groups.filter(blocking)) {
      ruleSets.push({
        type: 'local',
        tag: blockRuleSetTag(g),
        format: 'source',
        path: blockRuleSetPath(managed, g),
      })
    }
  }
  const knownRuleSets = new Set<string>()
  for (const tag of new Set(groups.flatMap((g) => g.match.ruleSets))) {
    const url = remoteRuleSetUrl(tag)
    if (!url) continue
    knownRuleSets.add(tag)
    ruleSets.push({
      type: 'remote',
      tag,
      format: 'binary',
      url,
      // GitHub 在一些网络里直连不上，下载走代理
      download_detour: finalTag ?? DIRECT,
    })
  }

  // ---- 路由规则
  const inbounds = [MIXED_INBOUND, ...(input.tun ? [TUN_INBOUND] : [])]
  const rules: Record<string, unknown>[] = []
  if (input.tun || groups.some((g) => needsSniff(g.match))) rules.push({ action: 'sniff' })
  if (input.tun) rules.push({ protocol: 'dns', action: 'hijack-dns' })
  // 局域网和本机地址不走代理
  rules.push({ ip_is_private: true, action: 'route', outbound: DIRECT })

  // 条件类别多的分组更具体，先匹配；一样多时有目标地址条件的在前，其余按分组列表的顺序
  const ordered = groups
    .filter((g) => !isCatchAll(g.match))
    .sort(
      (a, b) =>
        categoryCount(b.match) - categoryCount(a.match) || Number(hasDest(b.match)) - Number(hasDest(a.match)),
    )
  for (const g of ordered) {
    const unknown = g.match.ruleSets.filter((t) => !knownRuleSets.has(t))
    if (unknown.length) {
      // 认不出的规则集不能直接丢掉：丢掉之后接管条件变宽，会把不该接管的流量也拉进来
      warnings.push(`分组「${g.name}」引用的规则集 ${unknown.join('、')} 不认识，这个分组的规则没有生成。`)
      continue
    }
    const conditions = matchConditions(g.match)
    if (blocking(g)) {
      // 一条规则里的多个规则集之间是“或”，阻断规则集要用 logical and 和接管条件组合
      for (const c of conditions) {
        rules.push({ type: 'logical', mode: 'and', rules: [{ rule_set: blockRuleSetTag(g) }, c], action: 'reject' })
      }
    }
    for (const c of conditions) {
      rules.push(noOutlet(g) ? { ...c, action: 'reject' } : { ...c, action: 'route', outbound: g.selectorTag })
    }
  }
  if (catchAll && blocking(catchAll)) {
    // 能走到这里的都是兜底流量，阻断规则集里那条 tcp + udp 正好只挡它们
    rules.push({ rule_set: blockRuleSetTag(catchAll), action: 'reject' })
  }
  if (!finalTag) rules.push({ inbound: inbounds, action: 'reject' })

  const [host, port] = splitListenAddress(input.listen || DEFAULT_LISTEN)
  const config: Record<string, unknown> = {
    log: { level: 'warn', timestamp: true },
    dns: {
      servers: [
        { type: 'udp', tag: DNS_BASE, server: DNS_SERVER },
        // 加密 DNS 自己也要有解析器，指回自己会报 circular server dependency
        { type: 'https', tag: DNS_DIRECT, server: DNS_SERVER, path: '/dns-query', domain_resolver: DNS_BASE },
      ],
      final: DNS_DIRECT,
    },
    inbounds: [
      { type: 'mixed', tag: MIXED_INBOUND, listen: host, listen_port: port },
      ...(input.tun
        ? [
            {
              type: 'tun',
              tag: TUN_INBOUND,
              address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
              auto_route: true,
              strict_route: true,
            },
          ]
        : []),
    ],
    outbounds,
    route: {
      rules,
      ...(ruleSets.length ? { rule_set: ruleSets } : {}),
      final: finalTag ?? DIRECT,
      default_domain_resolver: { server: DNS_DIRECT },
      ...(input.tun ? { auto_detect_interface: true } : {}),
    },
    experimental: managed
      ? {
          clash_api: { external_controller: managed.clashApi, secret },
          cache_file: { enabled: true, path: `${managed.dataDir}/cache.db` },
        }
      : { cache_file: { enabled: true } },
  }
  return { config, tagOf, catchAll, warnings }
}

/** 把 "127.0.0.1:2080" 拆成 listen 和 listen_port；IPv6 写成 [::1]:2080 */
export function splitListenAddress(listen: string): [string, number] {
  const i = listen.lastIndexOf(':')
  if (i < 0) return ['127.0.0.1', Number(listen) || 2080]
  const host = listen.slice(0, i).replace(/^\[(.*)\]$/, '$1') || '127.0.0.1'
  const port = Number(listen.slice(i + 1))
  return [host, Number.isInteger(port) && port > 0 ? port : 2080]
}
