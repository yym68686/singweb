/**
 * 跟管理服务通信。
 *
 * 两种身份：接入时用网页上生成的一次性令牌，接入之后一直用设备密钥。
 * 密钥只在接入那一次返回，之后本地文件里存一份。
 *
 * 订阅不经过这里：上游有几个订阅、链接是什么，设备一概不知道。
 * 节点池由服务端自己拉取和归一化，设备只拿归一化之后的结果。
 */

import { readFile } from 'node:fs/promises'
import type {
  AppEvent,
  Device,
  Group,
  NodeHealth,
  Platform,
  ProbeDetail,
  ProbeSample,
  StoredNode,
  SwitchRecord,
  Target,
} from '../../shared/types.ts'
import { apiBase } from './config.ts'

/** 上报的请求体可能不小（几千条探测结果），超时给足 */
const REQUEST_TIMEOUT_MS = 30_000

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

  /**
   * 接入：用网页上的一次性令牌换设备 id 和设备密钥。
   *
   * 重新接入时带上原来的 id 和密钥，服务端核对上了才沿用原来的 id——
   * 网页上这台设备的分组、固定的节点、历史事件都还在。
   */
  async register(
    token: string,
    input: {
      id: string | null
      secret: string | null
      name: string
      hostname: string
      platform: Platform
      osVersion: string
      agentVersion: string
      singboxVersion: string
      clashApi: string
      probeInbound: string
      dataDir: string
      proxyListen: string
    },
  ): Promise<{ device: Device; secret: string }> {
    const result = await this.request('POST', '/agent/register', input, token)
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

  /**
   * 这台设备该用的全部东西：分组、探测目标、节点池、固定的节点和待办。
   * 每轮开始时拉一次，网页上的改动最多晚一个周期生效。
   */
  async bootstrap(): Promise<Bootstrap> {
    const result = asRecord(await this.request('GET', '/agent/bootstrap'))
    return {
      groups: arrayOf<Group>(result.groups),
      targets: arrayOf<Target>(result.targets),
      nodes: arrayOf<StoredNode>(result.nodes),
      pending: arrayOf<PendingSwitch>(result.pending),
      pins: pinsOf(result.pins),
      offlineAfterSec: Number(result.offlineAfterSec) || 90,
      reportIntervalSec: Number(result.reportIntervalSec) || 15,
    }
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
      throw new ApiError(messageFrom(text, response.status), response.status)
    }
    if (!text) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('服务端返回的不是 JSON，可能这个地址不是 singweb 的管理服务。')
    }
  }
}

/** 服务端明确拒绝的请求。带上状态码，调用方据此区分「凭据作废了」和「网络抖了一下」 */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface PendingSwitch {
  id: string
  device_id: string
  group_id: string
  node_id: string | null
  reason: string
}

export interface Bootstrap {
  groups: Group[]
  targets: Target[]
  nodes: StoredNode[]
  pending: PendingSwitch[]
  /** 用户在网页上固定的节点，按分组 id 索引。没有固定的分组不在里面 */
  pins: Record<string, string>
  /** 服务端多久没收到上报就当设备离线 */
  offlineAfterSec: number
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

export type {
  AppEvent,
  Device,
  Group,
  NodeHealth,
  ProbeDetail,
  ProbeSample,
  StoredNode,
  SwitchRecord,
  Target,
}

/** Agent 版本，上报给服务端显示用 */
export const AGENT_VERSION = '0.2.0'

/** 读 agent/package.json 里的版本，读不到就用常量 */
export async function readAgentVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return typeof parsed.version === 'string' ? parsed.version : AGENT_VERSION
  } catch {
    return AGENT_VERSION
  }
}
