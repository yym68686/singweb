/**
 * 跟管理服务通信。
 *
 * 两种身份：接入时用网页上生成的注册令牌（就是服务端的一个会话 token），
 * 接入之后一直用设备密钥。密钥只在接入那一次返回，之后本地文件里存一份。
 */

import { readFile } from 'node:fs/promises'
import type {
  AppEvent,
  Device,
  Group,
  NodeHealth,
  NodeSource,
  ProbeDetail,
  ProbeSample,
  ProxyNode,
  StoredNode,
  SwitchRecord,
  Target,
} from '../../shared/types.ts'
import type { ParsedNode } from '../../shared/subscription.ts'
import { parseJsonProxies, parseSubscription } from '../../shared/subscription.ts'
import { apiBase } from './config.ts'

/** 上报的请求体可能很大（几千个节点），超时给足；拉订阅更长 */
const REQUEST_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 60_000

/**
 * 拉订阅时用的 User-Agent。订阅站靠它决定返回什么格式，
 * 也靠它决定放不放行——写错不是格式不对，是被挡在门外。
 */
const SUBSCRIPTION_UA = 'v2rayN/6.31'

export class ApiClient {
  private readonly server: string
  private readonly secret: string | null

  constructor(server: string, secret: string | null) {
    this.server = server
    this.secret = secret
  }

  get base(): string {
    return apiBase(this.server)
  }

  /** 接入：用网页上的注册令牌换设备 id 和设备密钥 */
  async register(input: {
    token: string
    id: string | null
    name: string
    hostname: string
    platform: 'macos' | 'linux'
    osVersion: string
    agentVersion: string
    singboxVersion: string
    clashApi: string
    probeInbound: string
    dataDir: string
  }): Promise<{ device: Device; secret: string }> {
    const result = await this.request('POST', '/agent/register', input, input.token)
    const record = asRecord(result)
    const device = asRecord(record.device)
    const secret = typeof record.secret === 'string' ? record.secret : ''
    if (!secret) throw new Error('接入成功了，但服务端没有返回设备密钥。')
    return { device: device as unknown as Device, secret }
  }

  /** 上报本机状态，拿回要执行的操作 */
  async report(payload: unknown): Promise<{
    pending: PendingSwitch[]
    serverTime: string
    reportIntervalSec: number
  }> {
    const result = asRecord(await this.request('POST', '/agent/report', payload))
    return {
      pending: Array.isArray(result.pending) ? (result.pending as PendingSwitch[]) : [],
      serverTime: String(result.serverTime ?? new Date().toISOString()),
      reportIntervalSec: Number(result.reportIntervalSec) || 15,
    }
  }

  /** 确认待办已执行 */
  async ack(ids: string[]): Promise<void> {
    if (!ids.length) return
    await this.request('POST', '/agent/ack', { ids })
  }

  /**
   * 报告一条待办执行失败。服务端据此累加次数，够多了就放弃。
   * 不报的话它会一直重试——这是有意的（暂时性故障会自愈），
   * 但永久性故障需要有个了断，否则网页上永远显示"正在切换"。
   */
  async failPending(id: string, error: string): Promise<{ abandoned: boolean }> {
    const result = asRecord(
      await this.request('POST', `/agent/pending/${encodeURIComponent(id)}/fail`, { error }),
    )
    return { abandoned: Boolean(result.abandoned) }
  }

  /** 最新一轮的待办。每次上报都会带回来，这里用于启动时补一次 */
  async bootstrap(): Promise<Bootstrap> {
    const result = asRecord(await this.request('GET', '/agent/bootstrap'))
    return {
      groups: arrayOf<Group>(result.groups),
      targets: arrayOf<Target>(result.targets),
      nodes: arrayOf<StoredNode>(result.nodes),
      sources: arrayOf<SourceRef>(result.sources),
      pending: arrayOf<PendingSwitch>(result.pending),
      pins: pinsOf(result.pins),
      reportIntervalSec: Number(result.reportIntervalSec) || 15,
    }
  }

  /**
   * 拉取订阅内容。真正的网络请求在这里做，用 Node 直接发，
   * 不走代理——订阅服务器通常国内可直连，走了代理反而可能被挡。
   *
   * User-Agent 必须伪装成客户端：多数订阅站按 UA 分流，不认识的 UA 直接 403；
   * 而 Clash、sing-box 这些客户端的 UA 换回来的是 YAML 或 JSON，
   * 只有 v2rayN 这类用链接列表的才返回统一格式。别改成 singweb-agent。
   */
  async fetchSource(source: SourceRef): Promise<string> {
    const response = await fetch(source.url, {
      headers: {
        'user-agent': SUBSCRIPTION_UA,
        accept: '*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`订阅服务器返回 ${response.status}`)
    }
    return response.text()
  }

  /**
   * 把某个订阅的拉取结果回报给服务端。节点本身要一起交上去，
   * 只报个数的话服务端手里只有计数，节点池永远是空的。
   */
  async sourceResult(
    sourceId: string,
    error: string | null,
    nodes: ReportedNodeOut[],
  ): Promise<void> {
    await this.request('POST', `/agent/sources/${encodeURIComponent(sourceId)}/result`, {
      error,
      nodeCount: nodes.length,
      nodes,
    })
  }

  private async request(
    method: string,
    path: string,
    payload?: unknown,
    token?: string | null,
  ): Promise<unknown> {
    const credential = token ?? this.secret
    const headers: Record<string, string> = {}
    if (credential) headers.authorization = `Bearer ${credential}`
    if (payload !== undefined) headers['content-type'] = 'application/json'

    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((err: unknown) => {
      throw new Error(`连不上 ${this.base}：${err instanceof Error ? err.message : String(err)}`)
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(messageFrom(text, response.status))
    }
    if (!text) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('服务端返回的不是 JSON，可能这个地址不是 singweb 的管理服务。')
    }
  }
}

export interface PendingSwitch {
  id: string
  device_id: string
  group_id: string
  node_id: string | null
  reason: string
}

export interface SourceRef {
  id: string
  name: string
  url: string
  /**
   * 用户在网页上点了「立即刷新」，或者这个订阅还没拉过。
   * 为假时 Agent 可以自己决定要不要跳过——每轮都去拉一次订阅太浪费。
   */
  force?: boolean
}

export interface Bootstrap {
  groups: Group[]
  targets: Target[]
  nodes: StoredNode[]
  sources: SourceRef[]
  pending: PendingSwitch[]
  /** 用户在网页上固定的节点，按分组 id 索引。没有固定的分组不在里面 */
  pins: Record<string, string>
  reportIntervalSec: number
}

/**
 * 错误信息取服务端的 message 字段。取不到就退回状态码，
 * 不要把整段 HTML 甩进日志里。
 */
function messageFrom(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message
  } catch {
    // 不是 JSON，走下面的兜底
  }
  return `服务端返回 ${status}`
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {}
  return value as Record<string, unknown>
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** 固定表只是分组 id 到节点 id 的映射，脏值直接丢掉 */
function pinsOf(value: unknown): Record<string, string> {
  const record = asRecord(value)
  const out: Record<string, string> = {}
  for (const [groupId, nodeId] of Object.entries(record)) {
    if (typeof nodeId === 'string' && nodeId) out[groupId] = nodeId
  }
  return out
}

// ---------------------------------------------------------------- 节点上报格式

export interface ReportedNodeOut {
  tag: string
  protocol: ProxyNode['protocol']
  server: string
  port: number
  region: string
  outbound: Record<string, unknown>
  identity: string
}

/** 解析出来的订阅节点整理成上报格式 */
export function toReportedNode(node: ParsedNode): ReportedNodeOut {
  return {
    tag: node.tag,
    protocol: node.protocol,
    server: node.server,
    port: node.port,
    region: node.region,
    outbound: node.outbound as Record<string, unknown>,
    identity: identityOf(node),
  }
}

/**
 * 订阅内容可能是链接列表，也可能是 Clash / sing-box 的 JSON。
 * 先看开头几个字符就能分清，不用把两种解析都试一遍。
 */
export function parseSubscriptionBody(body: string): ParsedNode[] {
  const trimmed = body.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseJsonProxies(body).nodes
  }
  return parseSubscription(body).nodes
}

/** 服务端用它合并同一订阅里的重复节点，取协议加地址 */
function identityOf(node: ParsedNode): string {
  return `${node.protocol}|${node.server}|${node.port}|${node.tag}`
}

export type {
  AppEvent,
  Device,
  Group,
  NodeHealth,
  NodeSource,
  ProbeDetail,
  ProbeSample,
  StoredNode,
  SwitchRecord,
  Target,
}

/** Agent 版本，上报给服务端显示用 */
export const AGENT_VERSION = '0.1.0'

/** 读 package.json 里的版本，读不到就用常量 */
export async function readAgentVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return typeof parsed.version === 'string' ? parsed.version : AGENT_VERSION
  } catch {
    return AGENT_VERSION
  }
}
