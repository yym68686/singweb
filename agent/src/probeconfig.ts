/**
 * 生成探测用的 sing-box 配置。
 *
 * 探测要走的路径必须和真实流量一致：从本机出发、由被探测的那个节点出去。
 * 单独起一个 sing-box 进程、用一套只监听本机的入站，主配置一点都不用动。
 * 探测时按「节点 tag」选 SOCKS5 用户，节点就自动变成对应的出站。
 */

import type { ProxyNode, StoredNode } from '../../shared/types.ts'
import { MIN_SINGBOX } from '../../shared/singbox.ts'

export const PROBE_INBOUND = 'singweb-probe'
export const PROBE_SOCKS = 'singweb-probe-socks'
export const PROBE_SELECTOR = 'singweb-probe-selector'

/** socks 用户名 -> 节点 tag。用户名必须是 socks 里合法的字符，所以 tag 要做映射 */
const MAX_USERNAME = 40

/**
 * 节点 tag 直接当 SOCKS5 用户名用会有两个问题：中文 tag 和超长 tag。
 * 中文在 SOCKS5 的用户名里能过，但为了通用性还是编码成安全字符；
 * 超过 40 个字符的（RFC 1929 的实际上限）截断后加序号，保证不同节点不撞车。
 */
export function probeUsers(nodes: StoredNode[]): Map<string, string> {
  const used = new Set<string>()
  const map = new Map<string, string>()
  for (const node of nodes) {
    let user = safeUser(node.tag)
    if (used.has(user)) {
      let n = 2
      while (used.has(`${user}-${n}`) && n < 1000) n += 1
      user = `${user}-${n}`
    }
    used.add(user)
    map.set(user, node.tag)
  }
  return map
}

function safeUser(tag: string): string {
  // 只留下肯定安全的字符，其余用 UTF-8 十六进制，避免转移/引号之类的问题
  const cleaned = tag.replace(/[^A-Za-z0-9._-]+/g, (chunk) =>
    Array.from(new TextEncoder().encode(chunk), (b) => b.toString(16))
      .join('')
      .slice(0, 12),
  )
  return cleaned.slice(0, MAX_USERNAME) || 'node'
}

export interface ProbeConfigInput {
  nodes: StoredNode[]
  /** 探测进程自己的 Clash API 端口，只监听 127.0.0.1 */
  apiPort: number
  /** 探测用的 SOCKS5 密码，每次启动随机一个 */
  password: string
  /**
   * 探测入站的监听地址，默认 127.0.0.1:0 由系统分配。
   * 实际调用方都会自己选好端口再传进来：Clash API 的 /configs 问不出真实端口，
   * 交给系统分配就找不回来了。
   */
  listen?: string
}

/** 走节点出去的 DNS，用来解析探测目标（域名） */
const DNS_REMOTE = 'remote'
/**
 * 解析节点自身服务器地址用的 DNS。这一条不能写成 type: 'local'。
 *
 * sing-box 的 'local' 是"跟着系统走"，系统 resolver 是什么它就用什么。
 * 本机上 MacPacket 开着 TUN，系统 resolver 被指到它自己的 fake-IP DNS（198.18.0.2），
 * 于是所有订阅域名都解析回 198.18.0.x 这种假地址；假地址只有 TUN 自己认得，
 * 探测进程不是那份流量的发起方、不给它兜底，拿着假地址往外连必然失败。
 * 现场表现就是一批节点集体报连接失败，而 server 写裸 IP 的那个节点照常通过。
 *
 * 所以这里显式指定一个真实 DNS，绕开系统 resolver，也绕开 fake-IP。
 * 它解析的是机场的落地域名，本来就会进本机 DNS 缓存，比让探测误判划算。
 */
const DNS_LOCAL = 'resolve'
/**
 * 解析节点地址用的真实 DNS。明文 53 端口容易被中间设备插手，用加密查询。
 *
 * 这里只能写主机名，不能写完整 URL：sing-box 会自己套上 https:// 和 path，
 * 写全了会拼成 https://https:%2F%2F223.5.5.5%2Fdns-query/dns-query 这种废地址。
 */
const RESOLVE_SERVER = '223.5.5.5'
/** 加密查询的路径 */
const RESOLVE_PATH = '/dns-query'
/** 给上面那个加密 DNS 打底的明文 DNS，它自己地址是 IP，不需要别人解析 */
const RESOLVE_BASE = '223.5.5.5'
/** 打底 DNS 的 tag，只在这里用 */
const DNS_BASE = 'resolve-base'

/**
 * 探测进程的完整配置。这里不引入用户的其它配置：
 * 探测只需要"从这个节点出去"这一件事，路由规则和规则集都不需要。
 */

export function buildProbeConfig(input: ProbeConfigInput): Record<string, unknown> {
  const users = probeUsers(input.nodes)
  const outbounds: Record<string, unknown>[] = input.nodes.map((node) => ({
    ...node.outbound,
    tag: node.tag,
    // 节点自己的服务器地址必须走 DNS_LOCAL 解析。
    // 不写的话会落到 route.default_domain_resolver（那个走节点出去），
    // 于是"解析节点地址"要先穿过节点才能解析，sing-box 报 DNS query loopback，
    // 所有节点一起挂——每个节点都得单独指定。
    domain_resolver: DNS_LOCAL,
  }))
  // 端口一般由调用方选好（0 只有测试会用，读不回来）
  const [listenHost, listenPort] = splitListen(input.listen ?? '127.0.0.1:0')

  return {
    log: { level: 'warn', timestamp: true },
    // sing-box 1.12 起 DNS 服务器要写 type，1.14 会删掉出站式的 DNS 规则，
    // 所以这里用 route.default_domain_resolver 指定解析走哪个服务器。
    // 探测目标大多是域名，解析跟着节点走才不会把目标泄漏给本机 DNS。
    dns: {
      servers: [
        // 给加密 DNS 打底的明文 DNS。它地址写的是 IP，不会再去问别人，
        // 所以这条链到不了系统 resolver，也就绕开了 fake-IP。
        { type: 'udp', tag: DNS_BASE, server: RESOLVE_BASE },
        {
          type: 'https',
          tag: DNS_LOCAL,
          server: RESOLVE_SERVER,
          path: RESOLVE_PATH,
          // 加密 DNS 的地址是域名时要解析，于是 sing-box 要求每个服务器都有解析器。
          // 这里指成上面那条明文 DNS。写成 DNS_LOCAL 自己会报
          // circular server dependency: resolve -> resolve，起不来；
          // 写 route.default_domain_resolver 又会被指回来，同样是环。
          domain_resolver: DNS_BASE,
        },
        { type: 'https', tag: DNS_REMOTE, server: '1.1.1.1', detour: PROBE_SELECTOR },
      ],
    },
    inbounds: [
      {
        type: 'socks',
        tag: PROBE_SOCKS,
        listen: listenHost,
        listen_port: listenPort,
        users: [...users.keys()].map((username) => ({ username, password: input.password })),
      },
    ],
    outbounds: [
      { type: 'selector', tag: PROBE_SELECTOR, outbounds: input.nodes.map((n) => n.tag) },
      ...outbounds,
    ],
    route: {
      default_domain_resolver: { server: DNS_REMOTE },
      // 探测流量按 SOCKS 用户直接指到对应节点。
      //
      // 这一条一条的 auth_user 规则是必须的：只写一条洒向 PROBE_SELECTOR 的兜底规则的话，
      // 20 个用户会全部汇到 selector 上，探测就变成把同一个节点测了 20 遍，
      // 每个节点看起来都"通过"——那是最坏的情况，面板会显示一份全都好的假象。
      // sing-box 依规则顺序取第一条命中的，所以每条用户规则都要排在兜底之前。
      rules: [
        ...[...users].map(([username, tag]) => ({
          inbound: PROBE_SOCKS,
          auth_user: username,
          action: 'route',
          outbound: tag,
        })),
        // 兜底留给 DNS 出站：它的 detour 指向 PROBE_SELECTOR，得有个出口能落
        {
          inbound: [PROBE_SOCKS],
          action: 'route',
          outbound: PROBE_SELECTOR,
        },
      ],
    },
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${input.apiPort}`,
        secret: '',
      },
    },
  }
}

/** 主配置里要补进去的片段检查：节点出站是原样抄的，这里只挑要用的字段 */
export function outboundFor(node: ProxyNode): { tag: string } {
  return { tag: node.tag }
}

export function probeUserOf(nodes: StoredNode[], tag: string): string | null {
  for (const [user, nodeTag] of probeUsers(nodes)) {
    if (nodeTag === tag) return user
  }
  return null
}

/** 把 "127.0.0.1:1080" 拆成 sing-box 配置要的 listen 和 listen_port */
export function splitListen(listen: string): [string, number] {
  const index = listen.lastIndexOf(':')
  if (index < 0) return [listen || '127.0.0.1', 0]
  const host = listen.slice(0, index) || '127.0.0.1'
  const port = Number(listen.slice(index + 1))
  return [host, Number.isInteger(port) ? port : 0]
}

export const MIN_PROBE_SINGBOX = MIN_SINGBOX
