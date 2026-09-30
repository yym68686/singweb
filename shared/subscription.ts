/**
 * 把订阅内容解析成 sing-box 出站。
 *
 * 订阅的常见形式是整段 base64，解出来是每行一个分享链接（vmess:// vless:// trojan://
 * hysteria2:// ss:// 等），也可能直接就是明文链接，或者是 Clash / sing-box 的 JSON 配置。
 * 这个文件只负责"链接列表 → 节点"，不碰网络：拉取由调用方做。
 */

import type { NodeProtocol, NodeOutbound } from './types.ts'

/** 解析出的一个节点，还没有分配 id */
export interface ParsedNode {
  /** sing-box 出站 tag，同时是界面上显示的名字 */
  tag: string
  protocol: NodeProtocol
  server: string
  port: number
  /** 从名称里识别出的地区，识别不出来时是空字符串 */
  region: string
  outbound: NodeOutbound
}

/** 解析结果中跳过的地方，用来告诉用户"订阅里有 3 条不认识" */
export interface ParseSkip {
  /** 原始行的开头，便于用户对照 */
  line: string
  reason: string
}

export interface ParseResult {
  nodes: ParsedNode[]
  skipped: ParseSkip[]
}

// ---------------------------------------------------------------- 基础工具

/** 宽松的 base64 解码：容忍换行、URL-safe 字符和缺失的补位 */
export function decodeBase64Text(input: string): string | null {
  const cleaned = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!cleaned || /[^A-Za-z0-9+/=]/.test(cleaned)) return null
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4)
  try {
    const text = Buffer.from(padded, 'base64').toString('utf8')
    // 解出来的东西必须是可打印文本，否则说明原本就不是 base64
    if (!text || /[\u0000-\u0008\u000e-\u001f]/.test(text)) return null
    return text
  } catch {
    return null
  }
}

/** 订阅返回的内容可能是 base64，也可能是明文；这里统一成明文 */
export function normalizeSubscription(body: string): string {
  const text = body.trim()
  if (!text) return ''
  // 已经是明文链接或 JSON，直接用
  if (/^(vmess|vless|trojan|ss|ssr|hysteria2?|hy2|tuic):\/\//im.test(text) || text.startsWith('{')) return text
  return decodeBase64Text(text) ?? text
}

/** 从节点名称里认地区。认不出来时返回空字符串 */
const REGION_RULES: [RegExp, string][] = [
  [/香港|hk|hongkong|hong kong/i, '香港'],
  [/台湾|台北|tw|taiwan|taipei/i, '台北'],
  [/日本|东京|jp|japan|tokyo|osaka|大阪/i, '东京'],
  [/新加坡|狮城|sg|singapore/i, '新加坡'],
  [/美国|洛杉矶|圣何塞|西雅图|us|united states|los angeles|san jose|seattle/i, '洛杉矶'],
  [/韩国|首尔|kr|korea|seoul/i, '首尔'],
  [/英国|伦敦|uk|gb|britain|london/i, '伦敦'],
  [/德国|法兰克福|de|germany|frankfurt/i, '法兰克福'],
  [/荷兰|阿姆斯特丹|nl|netherlands|amsterdam/i, '阿姆斯特丹'],
  [/法国|巴黎|fr|france|paris/i, '巴黎'],
  [/加拿大|ca|canada|toronto/i, '加拿大'],
  [/澳大利亚|悉尼|au|australia|sydney/i, '悉尼'],
  [/俄罗斯|ru|russia|moscow/i, '俄罗斯'],
  [/印度|in|india|mumbai/i, '印度'],
  [/土耳其|tr|turkey|istanbul/i, '土耳其'],
  [/马来西亚|my|malaysia/i, '马来西亚'],
  [/越南|vn|vietnam/i, '越南'],
  [/泰国|th|thailand/i, '泰国'],
  [/菲律宾|ph|philippines/i, '菲律宾'],
  [/阿根廷|ar|argentina/i, '阿根廷'],
  [/巴西|br|brazil/i, '巴西'],
]

export function guessRegion(name: string): string {
  for (const [re, region] of REGION_RULES) if (re.test(name)) return region
  return ''
}

/** 名称里去掉 emoji、标记符号和多余空白，留作 tag 和显示名 */
function cleanName(raw: string): string {
  return raw
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{20E3}]/gu, '')
    .replace(/[|｜]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------- 分享链接

/** 分享链接里的 host:port 可能在 userinfo 之后，也可能是 IPv6 的 [::1]:443 */
function splitAuthority(authority: string): { host: string; port: number } | null {
  let rest = authority
  // 去掉 userinfo
  const at = rest.lastIndexOf('@')
  if (at >= 0) rest = rest.slice(at + 1)
  // 去掉查询串和路径
  rest = rest.split(/[/?#]/)[0]
  if (!rest) return null
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    if (end < 0) return null
    const host = rest.slice(1, end)
    const port = Number(rest.slice(end + 1).replace(/^:/, ''))
    return host && Number.isFinite(port) ? { host, port } : null
  }
  const colon = rest.lastIndexOf(':')
  if (colon < 0) return null
  const host = rest.slice(0, colon)
  const port = Number(rest.slice(colon + 1))
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port }
}

interface TlsOptions {
  security?: string
  sni?: string
  alpn?: string
  allowInsecure?: string
  fp?: string
}

/** 生成 sing-box 的 tls 块；没有启用 TLS 时返回 undefined */
function tlsBlock(q: TlsOptions, fallbackSni: string): Record<string, unknown> | undefined {
  const security = (q.security ?? '').toLowerCase()
  if (security !== 'tls' && security !== 'reality' && security !== 'xtls') return undefined
  const tls: Record<string, unknown> = {
    enabled: true,
    server_name: q.sni || fallbackSni,
    insecure: q.allowInsecure === '1' || q.allowInsecure === 'true',
  }
  if (q.alpn) tls.alpn = q.alpn.split(',').map((s) => s.trim()).filter(Boolean)
  if (q.fp) tls.utls = { enabled: true, fingerprint: q.fp }
  return tls
}

/** transport：ws / grpc / http（h2）/ quic，对应 sing-box 的 transport 字段 */
function transportBlock(params: URLSearchParams): Record<string, unknown> | undefined {
  const type = (params.get('type') ?? 'tcp').toLowerCase()
  if (type === 'ws') {
    return {
      type: 'ws',
      path: params.get('path') || '/',
      ...(params.get('host') ? { headers: { Host: params.get('host') as string } } : {}),
    }
  }
  if (type === 'grpc') {
    return { type: 'grpc', service_name: params.get('serviceName') || '' }
  }
  if (type === 'http' || type === 'h2') {
    return {
      type: 'http',
      host: params.get('host') ? (params.get('host') as string).split(',') : undefined,
      path: params.get('path') || '/',
    }
  }
  if (type === 'quic') return { type: 'quic' }
  return undefined
}

function parseVless(url: URL, name: string): ParsedNode | string {
  const server = url.hostname
  const port = Number(url.port)
  if (!server || !Number.isInteger(port)) return '缺少服务器地址或端口'
  const id = decodeURIComponent(url.username)
  if (!id) return '缺少用户 id'
  const q = url.searchParams
  const tls = tlsBlock(
    {
      security: q.get('security') ?? undefined,
      sni: q.get('sni') ?? q.get('host') ?? undefined,
      alpn: q.get('alpn') ?? undefined,
      allowInsecure: q.get('allowInsecure') ?? q.get('insecure') ?? undefined,
      fp: q.get('fp') ?? undefined,
    },
    server,
  )
  if (q.get('security') === 'reality') {
    // reality 的公钥在订阅里叫 pbk，短 id 叫 sid
    if (tls) tls.reality = { enabled: true, public_key: q.get('pbk') ?? '', short_id: q.get('sid') ?? '' }
  }
  const transport = transportBlock(q)
  const outbound: NodeOutbound = {
    type: 'vless',
    tag: name,
    server,
    server_port: port,
    uuid: id,
    ...(tls ? { tls } : {}),
    ...(transport ? { transport } : {}),
  }
  if (q.get('flow')) outbound.flow = q.get('flow')
  if (q.get('packetEncoding')) outbound.packet_encoding = q.get('packetEncoding')
  return { tag: name, protocol: 'vless', server, port, region: guessRegion(name), outbound }
}

function parseTrojan(url: URL, name: string): ParsedNode | string {
  const server = url.hostname
  const port = Number(url.port)
  if (!server || !Number.isInteger(port)) return '缺少服务器地址或端口'
  const password = decodeURIComponent(url.username)
  if (!password) return '缺少密码'
  const q = url.searchParams
  const tls = tlsBlock(
    {
      security: q.get('security') ?? 'tls',
      sni: q.get('sni') ?? q.get('peer') ?? undefined,
      alpn: q.get('alpn') ?? undefined,
      allowInsecure: q.get('allowInsecure') ?? undefined,
      fp: q.get('fp') ?? undefined,
    },
    server,
  )
  const outbound: NodeOutbound = {
    type: 'trojan',
    tag: name,
    server,
    server_port: port,
    password,
    ...(tls ? { tls } : { tls: { enabled: true, server_name: server } }),
    ...(transportBlock(q) ? { transport: transportBlock(q) } : {}),
  }
  return { tag: name, protocol: 'trojan', server, port, region: guessRegion(name), outbound }
}

function parseHysteria2(url: URL, name: string): ParsedNode | string {
  const server = url.hostname
  const port = Number(url.port)
  if (!server || !Number.isInteger(port)) return '缺少服务器地址或端口'
  // 密码可能在 userinfo，也可能在 auth 参数里
  const password = decodeURIComponent(url.username) || (url.searchParams.get('auth') ?? '')
  if (!password) return '缺少密码'
  const q = url.searchParams
  const outbound: NodeOutbound = {
    type: 'hysteria2',
    tag: name,
    server,
    server_port: port,
    password,
    tls: {
      enabled: true,
      server_name: q.get('sni') ?? server,
      insecure: q.get('insecure') === '1' || q.get('allowInsecure') === '1',
      ...(q.get('alpn') ? { alpn: (q.get('alpn') as string).split(',').filter(Boolean) } : {}),
    },
    ...(q.get('obfs') === 'salamander' && q.get('obfs-password')
      ? { obfs: { type: 'salamander', password: q.get('obfs-password') } }
      : {}),
  }
  // mport 是端口范围，写法是 "20000-50000" 或 "20000,30000-40000"，
  // sing-box 要的是 "起:止" 或单端口
  if (q.get('mport')) {
    outbound.server_ports = (q.get('mport') as string)
      .split(',')
      .map((s) => s.trim().replace('-', ':'))
      .filter(Boolean)
  }
  return { tag: name, protocol: 'hysteria2', server, port, region: guessRegion(name), outbound }
}

/** ss:// 有两种写法：旧的 base64(method:pass)@host:port，新的明文带查询串 */
function parseShadowsocks(url: URL, name: string): ParsedNode | string {
  let server = url.hostname
  let port = Number(url.port)
  let userInfo = ''
  try {
    userInfo = decodeURIComponent(url.username)
  } catch {
    userInfo = url.username
  }
  if (url.password) userInfo += `:${decodeURIComponent(url.password)}`

  // 旧写法：整个 "method:pass@host:port" 被 base64 过
  if (!server || !Number.isInteger(port)) {
    const decoded = decodeBase64Text(url.hostname + url.pathname)
    const authority = decoded ? splitAuthority(decoded) : null
    if (authority && decoded) {
      server = authority.host
      port = authority.port
      userInfo = decoded.split('@')[0]
    }
  }
  if (!server || !Number.isInteger(port)) return '缺少服务器地址或端口'

  let method = ''
  let password = ''
  if (userInfo.includes(':')) {
    const i = userInfo.lastIndexOf(':')
    method = userInfo.slice(0, i)
    password = userInfo.slice(i + 1)
  } else {
    const decoded = decodeBase64Text(userInfo)
    if (!decoded || !decoded.includes(':')) return '缺少加密方式或密码'
    const i = decoded.lastIndexOf(':')
    method = decoded.slice(0, i)
    password = decoded.slice(i + 1)
  }
  if (!method || !password) return '缺少加密方式或密码'
  const outbound: NodeOutbound = {
    type: 'shadowsocks',
    tag: name,
    server,
    server_port: port,
    method,
    password,
  }
  return { tag: name, protocol: 'shadowsocks', server, port, region: guessRegion(name), outbound }
}

function parseTuic(url: URL, name: string): ParsedNode | string {
  const server = url.hostname
  const port = Number(url.port)
  if (!server || !Number.isInteger(port)) return '缺少服务器地址或端口'
  const q = url.searchParams
  const outbound: NodeOutbound = {
    type: 'tuic',
    tag: name,
    server,
    server_port: port,
    uuid: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    tls: {
      enabled: true,
      server_name: q.get('sni') ?? server,
      insecure: q.get('allow_insecure') === '1' || q.get('insecure') === '1',
      ...(q.get('alpn') ? { alpn: (q.get('alpn') as string).split(',').filter(Boolean) } : {}),
    },
    ...(q.get('congestion_control') ? { congestion_control: q.get('congestion_control') } : {}),
    ...(q.get('udp_relay_mode') ? { udp_relay_mode: q.get('udp_relay_mode') } : {}),
  }
  return { tag: name, protocol: 'tuic', server, port, region: guessRegion(name), outbound }
}

/** vmess:// 是 base64 过的 JSON */
export function parseVmess(link: string, fallbackName: string): ParsedNode | string {
  const payload = link.slice('vmess://'.length).split('#')[0]
  const decoded = decodeBase64Text(payload)
  if (!decoded) return 'vmess 内容不是有效的 base64'
  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return 'vmess 内容不是有效的 JSON'
  }
  const str = (k: string) => (cfg[k] === undefined || cfg[k] === null ? '' : String(cfg[k]))
  const server = str('add')
  const port = Number(str('port'))
  const uuid = str('id')
  if (!server || !Number.isInteger(port)) return '缺少服务器地址或端口'
  if (!uuid) return '缺少用户 id'
  const name = cleanName(str('ps')) || fallbackName
  const net = str('net').toLowerCase()
  const tls = str('tls').toLowerCase()
  const host = str('host')
  const path = str('path')

  const outbound: NodeOutbound = {
    type: 'vmess',
    tag: name,
    server,
    server_port: port,
    uuid,
    security: str('scy') || 'auto',
    alter_id: Number(str('aid')) || 0,
  }
  if (tls === 'tls') {
    outbound.tls = {
      enabled: true,
      server_name: host || server,
      insecure: str('verify_cert') === 'false' || str('allowInsecure') === '1',
      ...(str('alpn') ? { alpn: str('alpn').split(',').filter(Boolean) } : {}),
    }
  }
  if (net === 'ws') {
    outbound.transport = { type: 'ws', path: path || '/', ...(host ? { headers: { Host: host } } : {}) }
  } else if (net === 'grpc') {
    outbound.transport = { type: 'grpc', service_name: path || '' }
  } else if (net === 'h2' || net === 'http') {
    outbound.transport = { type: 'http', ...(host ? { host: host.split(',') } : {}), path: path || '/' }
  } else if (net === 'quic') {
    outbound.transport = { type: 'quic' }
  }
  return { tag: name, protocol: 'vmess', server, port, region: guessRegion(name), outbound }
}

/** 名称里的 # 注释 */
function nameFromHash(link: string, fallback: string): string {
  const hash = link.indexOf('#')
  if (hash < 0) return fallback
  try {
    return cleanName(decodeURIComponent(link.slice(hash + 1))) || fallback
  } catch {
    return cleanName(link.slice(hash + 1)) || fallback
  }
}

/** 解析一条分享链接 */
export function parseShareLink(link: string): ParsedNode | string {
  const trimmed = link.trim()
  if (!trimmed) return '空行'
  const scheme = trimmed.slice(0, trimmed.indexOf('://')).toLowerCase()
  if (scheme === 'vmess') {
    return parseVmess(trimmed, 'vmess')
  }
  // 订阅里有些链接的 # 注释没做 URL 编码，直接 new URL 会解析出乱码的服务器名，
  // 先把片段切掉再解析，名称单独处理
  const withoutHash = trimmed.split('#')[0]
  let url: URL
  try {
    url = new URL(withoutHash)
  } catch {
    return '链接格式不对'
  }
  // 名称优先用 # 后面的中文注释，没有就用 host:port
  const fallback = `${url.hostname}:${url.port}`
  const name = nameFromHash(trimmed, fallback)

  switch (scheme) {
    case 'vless':
      return parseVless(url, name)
    case 'trojan':
      return parseTrojan(url, name)
    case 'hysteria2':
    case 'hy2':
    case 'hysteria':
      return parseHysteria2(url, name)
    case 'ss':
      return parseShadowsocks(url, name)
    case 'tuic':
      return parseTuic(url, name)
    case 'ssr':
      return 'ssr 协议不支持，sing-box 需要额外的转换'
    default:
      return `不认识的协议 ${scheme}`
  }
}

// ---------------------------------------------------------------- 入口

/** 名称像不像订阅塞进来的广告或流量提示 */
function looksLikeNotice(name: string): boolean {
  return /剩余|到期|流量|官网|放丢失|建议|订阅|频道|群组|重置|购买|续费|机场|公告|telegram|t\.me|traffic|expire/i.test(
    name,
  )
}

/** tag 去重：重名的加序号 */
function dedupe(used: Set<string>, tag: string): string {
  let candidate = tag
  let i = 2
  while (used.has(candidate)) candidate = `${tag} ${i++}`
  used.add(candidate)
  return candidate
}

/**
 * 节点的身份：同一个服务器、端口、协议和凭据就是同一个节点。
 * 机场常用同一节点配上不同名字重复塞好几行做公告，靠它合并。
 */
function identityOf(n: ParsedNode): string {
  const o = n.outbound
  const parts = [
    n.protocol,
    String(o.server ?? n.server),
    String(o.server_port ?? n.port),
    String(o.uuid ?? ''),
    String(o.password ?? ''),
    String(o.method ?? ''),
  ]
  const tp = o.transport as Record<string, unknown> | undefined
  if (tp) parts.push(String(tp.type ?? ''), String(tp.path ?? ''), String(tp.service_name ?? ''))
  return parts.join('|')
}

/** 名字越好越可能被留下：广告词排最后，带地区标签的排前面 */
function nameScore(name: string): number {
  if (looksLikeNotice(name)) return -1
  let score = name.length
  if (/[一-龥]/.test(name)) score += 20
  if (guessRegion(name)) score += 30
  return score
}

/**
 * 解析订阅内容。能处理 base64 的链接列表和明文链接列表；
 * Clash / sing-box 的 JSON 配置由调用方先用 parseJsonProxies 处理。
 */
export function parseSubscription(body: string): ParseResult {
  const text = normalizeSubscription(body)
  const skipped: ParseSkip[] = []
  /** 节点身份 → 已收下的节点，用来合并重复行 */
  const byIdentity = new Map<string, ParsedNode>()

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (!/^[a-z0-9]+:\/\//i.test(line)) continue // 注释、广告文字，静默跳过
    const parsed = parseShareLink(line)
    if (typeof parsed === 'string') {
      skipped.push({ line: line.slice(0, 80), reason: parsed })
      continue
    }
    const key = identityOf(parsed)
    const existing = byIdentity.get(key)
    if (!existing) {
      byIdentity.set(key, parsed)
      continue
    }
    // 同一个节点重复出现：留下名字更像样的那个
    if (nameScore(parsed.tag) > nameScore(existing.tag)) byIdentity.set(key, parsed)
  }

  // 去重完成后再分配唯一的 tag
  const used = new Set<string>()
  const nodes: ParsedNode[] = []
  for (const node of byIdentity.values()) {
    node.tag = dedupe(used, node.tag)
    node.outbound.tag = node.tag
    nodes.push(node)
  }

  return { nodes, skipped }
}

/** Clash 的 proxies 列表或 sing-box 的 outbounds 列表 → 节点 */
export function parseJsonProxies(body: string): ParseResult {
  const nodes: ParsedNode[] = []
  const skipped: ParseSkip[] = []
  const used = new Set<string>()
  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(body) as Record<string, unknown>
  } catch {
    return { nodes, skipped: [{ line: body.slice(0, 80), reason: '不是有效的 JSON' }] }
  }
  // sing-box：{ outbounds: [...] }；Clash：{ proxies: [...] }
  const list =
    (Array.isArray(cfg.outbounds) ? cfg.outbounds : null) ??
    (Array.isArray(cfg.proxies) ? cfg.proxies : null) ??
    []
  const PROXY_TYPES = new Set(['vmess', 'vless', 'trojan', 'hysteria2', 'shadowsocks', 'tuic'])
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const type = String(o.type ?? '')
    if (!PROXY_TYPES.has(type)) continue // selector、direct 这类跳过
    const tag = String(o.tag ?? o.name ?? '')
    const server = String(o.server ?? '')
    const port = Number(o.server_port ?? o.port ?? 0)
    if (!tag || !server || !Number.isInteger(port)) {
      skipped.push({ line: tag || '(没有名称)', reason: '缺少服务器地址或端口' })
      continue
    }
    const finalTag = dedupe(used, cleanName(tag))
    nodes.push({
      tag: finalTag,
      protocol: type as NodeProtocol,
      server,
      port,
      region: guessRegion(finalTag),
      outbound: { ...o, tag: finalTag },
    })
  }
  return { nodes, skipped }
}
