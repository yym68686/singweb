/**
 * 服务端自己拉订阅、解析、归一化。
 *
 * 这里跟 Agent 无关：订阅链接和 token 只存在服务端，也只有服务端去访问它。
 * 设备那边只知道 singweb 自己的地址，不知道上游有几个订阅、分别是什么。
 * 解析本身复用 shared/subscription.ts，那个文件不碰网络，拉取放在这里。
 */

import { parseJsonProxies, parseSubscription, type ParsedNode } from '../../shared/subscription.ts'
import type { LiveHub } from './live.ts'
import type { NodeSourceRow, PoolNode } from './model.ts'
import * as store from './store.ts'

/**
 * 拉订阅时用的 User-Agent。订阅站靠它决定返回什么格式，也靠它决定放不放行——
 * 写错不是格式不对，是被挡在门外。写 sing-box / Clash 的名字多半拿到 YAML 或 JSON，
 * 只有链接列表客户端才会拿到统一格式。
 */
const SUBSCRIPTION_UA = 'v2rayN/6.31'

/** 订阅站慢起来没有下限，但也不能一直挂着，撑过这个时间就当作失败 */
const FETCH_TIMEOUT_MS = 60_000

/** 拉取成功的订阅隔多久再拉一次 */
const REFRESH_MS = 6 * 60 * 60 * 1000

/** 拉取失败后的重试间隔，比成功间隔短很多，订阅站抖一下能很快恢复 */
const RETRY_MS = 5 * 60 * 1000

/** 一轮最多同时拉几个订阅，避免开机时几十个请求一起打出去 */
const MAX_CONCURRENT = 3

/** 一次拉取最多收多少节点，防止某个订阅返回一个巨大的文件把库撑爆 */
const MAX_NODES = 2000

/**
 * 订阅内容可能是链接列表，也可能是 Clash / sing-box 的 JSON。
 * 看开头几个字符就能分清，不用两种都试一遍。
 */
export function parseSubscriptionBody(body: string): ParsedNode[] {
  const trimmed = body.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseJsonProxies(body).nodes.slice(0, MAX_NODES)
  }
  return parseSubscription(body).nodes.slice(0, MAX_NODES)
}

/**
 * 节点的身份：同一个服务器、端口、协议和凭据就是同一个节点。
 * 跟解析器里的算法保持一致，这样同一份订阅重新拉一遍不会把节点认成新的。
 */
export function identityOf(node: ParsedNode): string {
  const o = node.outbound
  const parts = [
    node.protocol,
    String(o.server ?? node.server),
    String(o.server_port ?? node.port),
    String(o.uuid ?? ''),
    String(o.password ?? ''),
    String(o.method ?? ''),
  ]
  const tp = o.transport as Record<string, unknown> | undefined
  if (tp) parts.push(String(tp.type ?? ''), String(tp.path ?? ''), String(tp.service_name ?? ''))
  return parts.join('|')
}

function toPoolNode(node: ParsedNode): PoolNode {
  return {
    tag: node.tag,
    protocol: node.protocol,
    server: node.server,
    port: node.port,
    region: node.region,
    outbound: node.outbound as PoolNode['outbound'],
    identity: identityOf(node),
  }
}

/**
 * 出错信息里只留主机名。订阅的 token 一般在查询串里（?token=…），
 * 也有放在路径里或者写成 user:pass@ 的，出错信息会进库、进事件、上网页，哪种都不能带出去。
 */
function hostLabel(raw: string): string {
  try {
    return new URL(raw).host || '订阅站'
  } catch {
    return '订阅站'
  }
}

/** fetch 失败时 message 只有一句 fetch failed，真正的原因在 cause 里 */
function fetchFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as Error & { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code
    const message = (cause as { message?: unknown }).message
    if (code === 'ENOTFOUND') return '域名解析不出来'
    if (code === 'ECONNREFUSED') return '连接被拒绝'
    if (code === 'ECONNRESET') return '连接被重置'
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时'
    if (typeof code === 'string' && code.startsWith('CERT_')) return `证书有问题（${code}）`
    if (typeof message === 'string' && message) return message
  }
  return err.message
}

/**
 * 拉一个订阅并写进库。
 *
 * 失败时保留原有节点：订阅站临时挂掉不代表节点没了，清空节点池会把所有分组的
 * 候选一起弄没，设备上的 selector 也会跟着空掉。
 */
export async function refreshSource(source: NodeSourceRow): Promise<{ nodeCount: number; error: string | null }> {
  const label = hostLabel(source.url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(source.url, {
      headers: {
        'user-agent': SUBSCRIPTION_UA,
        accept: '*/*',
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!res.ok) {
      const error = `${label} 返回 ${res.status}`
      await store.recordFetch(source.id, { error, nodeCount: source.node_count })
      return { nodeCount: source.node_count, error }
    }
    const body = await res.text()
    const parsed = parseSubscriptionBody(body)
    if (!parsed.length) {
      // 节点数照旧：上一次拉到的节点还留在库里，计数跟着清零会跟节点页对不上
      const error = '没有解析出节点，请确认这是一个订阅地址。'
      await store.recordFetch(source.id, { error, nodeCount: source.node_count })
      return { nodeCount: source.node_count, error }
    }
    await store.syncSourceNodes(source.id, source.name, parsed.map(toPoolNode))
    await store.recordFetch(source.id, { error: null, nodeCount: parsed.length })
    return { nodeCount: parsed.length, error: null }
  } catch (err) {
    const error = controller.signal.aborted
      ? `拉取超时（超过 ${FETCH_TIMEOUT_MS / 1000} 秒）`
      : `访问 ${label} 失败：${fetchFailure(err)}`
    await store.recordFetch(source.id, { error, nodeCount: source.node_count })
    return { nodeCount: source.node_count, error }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 该不该现在拉：从来没拉过、或者距上次成功已经超过刷新间隔；
 * 上次失败的话按更短的重试间隔来。网页上的「立即刷新」不走这里，直接调 refreshNow。
 */
function dueAt(row: NodeSourceRow): number {
  if (!row.enabled) return Number.POSITIVE_INFINITY
  if (!row.last_fetched_at) return 0
  const base = row.last_fetched_at.getTime()
  return base + (row.last_error ? RETRY_MS : REFRESH_MS)
}

/**
 * 订阅拉取的调度器。
 *
 * 跟 Agent 的 15 秒上报循环无关，自己按分钟级跑。服务端因此可以完全无状态——
 * 重启之后该拉什么由库里那几列决定，不需要额外的内存状态。
 */
export class SubscriptionScheduler {
  private readonly live: LiveHub
  private readonly intervalMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = false
  /**
   * 正在拉的订阅。用户连点两下「立即刷新」、或者点的时候调度器刚好也轮到它，
   * 都并到同一次请求上：两次并发写同一个订阅的节点，后写的会把先写的删掉一半。
   */
  private readonly inflight = new Map<string, Promise<{ nodeCount: number; error: string | null }>>()

  constructor(live: LiveHub, intervalMs = 60_000) {
    this.live = live
    this.intervalMs = intervalMs
  }

  start(): void {
    // 启动时先跑一轮：重启之后节点池不该空着等 6 小时
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.tick(), this.intervalMs)
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    if (this.running) {
      this.schedule()
      return
    }
    this.running = true
    try {
      await this.runDue()
    } catch (err) {
      console.error('拉取订阅出错：', err)
    } finally {
      this.running = false
      this.schedule()
    }
  }

  private async runDue(): Promise<void> {
    const rows = await store.listSources()
    const now = Date.now()
    const due = rows.filter((row) => row.enabled && dueAt(row) <= now)
    if (!due.length) return

    // 分批并发：一次全放出去对订阅站不友好，串行又太慢
    for (let i = 0; i < due.length; i += MAX_CONCURRENT) {
      const batch = due.slice(i, i + MAX_CONCURRENT)
      await Promise.all(batch.map((row) => this.refreshOne(row)))
    }
    // 节点池可能整体变了，让前端和 Agent 都刷新
    this.live.update(['sources', 'nodes', 'events'])
  }

  /** 同一个订阅同一时间只拉一次，后来的直接等前一次的结果 */
  private fetchOnce(row: NodeSourceRow): Promise<{ nodeCount: number; error: string | null }> {
    const running = this.inflight.get(row.id)
    if (running) return running
    const task = this.fetchAndLog(row).finally(() => this.inflight.delete(row.id))
    this.inflight.set(row.id, task)
    return task
  }

  /**
   * 拉一次，结果写进事件。只在结果跟上次不一样时写：每 6 小时一条「拉取成功」
   * 会把事件页刷满，用户真正关心的是坏了和好了这两个时刻。
   */
  private async fetchAndLog(row: NodeSourceRow): Promise<{ nodeCount: number; error: string | null }> {
    const result = await refreshSource(row)
    const first = !row.last_fetched_at
    const recovered = Boolean(row.last_error) && !result.error
    const broke = Boolean(result.error) && result.error !== row.last_error
    const countChanged = !result.error && result.nodeCount !== row.node_count
    if (first || recovered || broke || countChanged) {
      await store.insertEvent({
        at: new Date().toISOString(),
        kind: 'node-changed',
        severity: result.error ? 'warn' : recovered ? 'good' : 'info',
        deviceId: null,
        groupId: null,
        nodeId: null,
        message: result.error
          ? `订阅「${row.name}」拉取失败：${result.error}`
          : `订阅「${row.name}」拉取成功，共 ${result.nodeCount} 个节点`,
      })
    }
    return result
  }

  private async refreshOne(row: NodeSourceRow): Promise<void> {
    await this.fetchOnce(row)
  }

  /** 用户在网页上点了「立即刷新」、新加或改了订阅：不用等下一轮，现在就拉 */
  async refreshNow(id: string): Promise<{ nodeCount: number; error: string | null }> {
    const row = await store.findSource(id)
    if (!row) return { nodeCount: 0, error: '找不到这个订阅。' }
    const result = await this.fetchOnce(row)
    this.live.update(['sources', 'nodes', 'events'])
    return result
  }
}
