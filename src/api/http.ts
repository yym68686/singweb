import type { ApiClient } from './client'
import { ApiError } from './errors'
import type {
  Device,
  EventPage,
  EventQuery,
  Group,
  GroupInput,
  GroupRuntime,
  LiveMessage,
  NodeSource,
  ProbeCell,
  ProxyNode,
  Target,
  TargetInput,
  UpdateScope,
  User,
} from './types'

/** 列表接口统一返回 {"items": [...]}，这里拆掉信封，调用方只看数组 */
async function items<T>(p: Promise<{ items: T[] }>): Promise<T[]> {
  return (await p).items
}

const ALL_SCOPES: UpdateScope[] = ['devices', 'nodes', 'targets', 'groups', 'runtimes', 'probes', 'events']
const POLL_MS = 10_000

/** 连接管理服务的实现，接口见 docs/api.md */
export class HttpApiClient implements ApiClient {
  private readonly base: string

  constructor(base: string) {
    this.base = base.replace(/\/+$/, '')
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      let message = `管理服务返回 ${res.status}`
      let field: string | undefined
      try {
        const data = (await res.json()) as { message?: string; field?: string }
        if (data.message) message = data.message
        field = data.field
      } catch {
        // 响应不是 JSON，保留状态码说明
      }
      // 401 是"会话没了"，不是某个接口坏了。广播出去让外壳把用户送回登录页；
      // 登录接口自己抛的 401 不广播——那是密码错了，页面要留在原处显示错误。
      if (res.status === 401 && path !== '/auth/login') notifyUnauthorized()
      throw new ApiError(message, res.status, field)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      // 常见原因：接口前缀不对，或者反向代理把请求回退成了 index.html
      throw new ApiError('管理服务返回的内容不是 JSON，请检查接口地址（VITE_API_BASE）和反向代理设置。', res.status)
    }
  }

  private query(params: Record<string, string | string[] | number | undefined>): string {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === '') continue
      if (Array.isArray(v)) {
        if (v.length) q.set(k, v.join(','))
      } else q.set(k, String(v))
    }
    const s = q.toString()
    return s ? `?${s}` : ''
  }

  /**
   * 当前账号。/auth/me 没登录时也返回 200，内容是 {user: null}，
   * 所以这里不靠异常判断，直接看字段。
   */
  async me() {
    const answer = await this.request<{ user: User | null }>('GET', '/auth/me')
    return answer.user
  }

  login(username: string, password: string) {
    return this.request<User>('POST', '/auth/login', { username, password })
  }

  async logout() {
    await this.request<void>('POST', '/auth/logout')
  }

  getDevices() {
    return items(this.request<{ items: Device[] }>('GET', '/devices'))
  }
  getDevice(id: string) {
    return this.request<Device>('GET', `/devices/${encodeURIComponent(id)}`)
  }

  getNodes() {
    return items(this.request<{ items: ProxyNode[] }>('GET', '/nodes'))
  }
  updateNode(id: string, patch: { enabled: boolean }) {
    return this.request<ProxyNode>('PATCH', `/nodes/${encodeURIComponent(id)}`, patch)
  }

  getTargets() {
    return items(this.request<{ items: Target[] }>('GET', '/targets'))
  }
  saveTarget(id: string | null, input: TargetInput) {
    return id
      ? this.request<Target>('PUT', `/targets/${encodeURIComponent(id)}`, input)
      : this.request<Target>('POST', '/targets', input)
  }
  deleteTarget(id: string) {
    return this.request<void>('DELETE', `/targets/${encodeURIComponent(id)}`)
  }

  getGroups() {
    return items(this.request<{ items: Group[] }>('GET', '/groups'))
  }
  getGroup(id: string) {
    return this.request<Group>('GET', `/groups/${encodeURIComponent(id)}`)
  }
  saveGroup(id: string | null, input: GroupInput) {
    return id
      ? this.request<Group>('PUT', `/groups/${encodeURIComponent(id)}`, input)
      : this.request<Group>('POST', '/groups', input)
  }
  deleteGroup(id: string) {
    return this.request<void>('DELETE', `/groups/${encodeURIComponent(id)}`)
  }

  getRuntimes(q: { deviceId?: string } = {}) {
    return items(this.request<{ items: GroupRuntime[] }>('GET', `/runtime${this.query(q)}`))
  }
  getProbeCells(q: { deviceId?: string; nodeId?: string } = {}) {
    return items(this.request<{ items: ProbeCell[] }>('GET', `/probes${this.query(q)}`))
  }

  setPin(deviceId: string, groupId: string, nodeId: string | null) {
    return this.request<GroupRuntime>(
      'POST',
      `/devices/${encodeURIComponent(deviceId)}/groups/${encodeURIComponent(groupId)}/pin`,
      { nodeId },
    )
  }
  probeNow(deviceId: string) {
    return this.request<void>('POST', `/devices/${encodeURIComponent(deviceId)}/probe`)
  }
  retryPending(deviceId: string, groupId: string, pendingId: string) {
    return this.request<void>(
      'POST',
      `/devices/${encodeURIComponent(deviceId)}/groups/${encodeURIComponent(groupId)}` +
        `/pending/${encodeURIComponent(pendingId)}/retry`,
    )
  }

  getEvents(q: EventQuery) {
    return this.request<EventPage>(
      'GET',
      `/events${this.query({
        deviceId: q.deviceId,
        groupId: q.groupId,
        kinds: q.kinds,
        severities: q.severities,
        since: q.since,
        cursor: q.cursor,
        limit: q.limit,
      })}`,
    )
  }

  getSources() {
    return items(this.request<{ items: NodeSource[] }>('GET', '/sources'))
  }
  async saveSource(
    id: string | null,
    input: { name?: string; url?: string; enabled?: boolean; refresh?: boolean },
  ) {
    // refresh 不是订阅自身的字段，它是「让设备重新拉一次」的动作，走另一个接口
    const { refresh, ...patch } = input
    const result = await this.request<{ source: NodeSource }>(
      id ? 'PATCH' : 'POST',
      id ? `/sources/${encodeURIComponent(id)}` : '/sources',
      patch,
    )
    if (refresh && result.source) await this.refreshSource(result.source.id)
    return result.source
  }
  deleteSource(id: string) {
    return this.request<void>('DELETE', `/sources/${encodeURIComponent(id)}`)
  }
  refreshSource(id: string) {
    return this.request<void>('POST', `/sources/${encodeURIComponent(id)}/refresh`)
  }

  /** 优先用 SSE；连不上时退回定时刷新 */
  subscribe(onMessage: (m: LiveMessage) => void): () => void {
    let source: EventSource | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let failures = 0
    let closed = false

    const poll = () => {
      if (timer || closed) return
      timer = setInterval(() => onMessage({ type: 'update', scopes: ALL_SCOPES }), POLL_MS)
    }

    if (typeof EventSource === 'undefined') {
      poll()
    } else {
      source = new EventSource(`${this.base}/stream`)
      source.onopen = () => {
        // 断线重连成功：断开期间的变化收不到了，全部刷新一次
        if (failures > 0) onMessage({ type: 'update', scopes: ALL_SCOPES })
        failures = 0
      }
      source.onmessage = (ev) => {
        try {
          onMessage(JSON.parse(ev.data as string) as LiveMessage)
        } catch {
          // 忽略无法解析的消息
        }
      }
      source.onerror = () => {
        failures += 1
        // 返回了错误状态码或者不是 event-stream 时，浏览器不会再重连（readyState 为 CLOSED）
        if (source && (source.readyState === EventSource.CLOSED || failures >= 3)) {
          source.close()
          source = null
          poll()
        }
      }
    }

    return () => {
      closed = true
      source?.close()
      if (timer) clearInterval(timer)
    }
  }
}

/**
 * 会话失效的通知。请求层不认识路由，只能广播一个事件，
 * 由外壳（Shell）决定是把用户送去登录页还是原地显示错误。
 */
const UNAUTHORIZED_EVENT = 'singweb:unauthorized'

export function notifyUnauthorized(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
}

/** 订阅会话失效；返回取消订阅函数 */
export function onUnauthorized(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(UNAUTHORIZED_EVENT, handler)
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler)
}
