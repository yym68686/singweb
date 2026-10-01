/**
 * 跟 Agent 自己起的那个 sing-box 打交道：只走 Clash API。
 *
 * 配置文件和进程由 Supervisor 管，这里只负责切 selector、读 selector 和探活。
 * Clash API 只监听本机，密钥是 Agent 生成的，不离开这台机器。
 */

/** Clash API 的响应超时。本机调用，给短一点，卡住了就是 sing-box 没起来 */
const API_TIMEOUT_MS = 3000

export interface ClashSelector {
  type: string
  now: string
  all: string[]
}

export class ClashApi {
  private readonly address: string
  private readonly secret: string

  constructor(address: string, secret: string) {
    this.address = address
    this.secret = secret
  }

  private url(path: string): string {
    // Clash API 也有跑在 unix socket 上的，但那种情况这里不支持，只认 host:port
    const host = this.address.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    return `http://${host}${path}`
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.secret) headers.authorization = `Bearer ${this.secret}`
    return headers
  }

  /**
   * 切换 selector 当前指向的节点。
   *
   * 这里必须让连不上的错误抛出去：切换是 Agent 对设备唯一的写操作，
   * 吞掉的话调用方拿到的是"成功"，却会在网页上记下一次设备上并不成立的切换。
   */
  async select(selectorTag: string, nodeTag: string): Promise<void> {
    await this.request('PUT', `/proxies/${encodeURIComponent(selectorTag)}`, { name: nodeTag }, true)
  }

  async getSelector(tag: string): Promise<ClashSelector | null> {
    const body = await this.request('GET', `/proxies/${encodeURIComponent(tag)}`)
    if (!body || typeof body !== 'object') return null
    const record = body as Record<string, unknown>
    return {
      type: String(record.type ?? ''),
      now: String(record.now ?? ''),
      all: Array.isArray(record.all) ? record.all.map(String) : [],
    }
  }

  /** sing-box 起来没有、版本对不对，用它探活 */
  async version(): Promise<string | null> {
    const body = await this.request('GET', '/version')
    if (!body || typeof body !== 'object') return null
    const version = (body as Record<string, unknown>).version
    return typeof version === 'string' ? version : null
  }

  /**
   * 探活用的原始请求。刚启动的 sing-box 会拒绝连接，
   * 这里要让调用方拿到异常去重试，而不是被吞成 null。
   */
  requestRaw(method: string, path: string): Promise<unknown> {
    return this.request(method, path, undefined, true)
  }

  private async request(
    method: string,
    path: string,
    payload?: unknown,
    raw = false,
  ): Promise<unknown | null> {
    const response = await fetch(this.url(path), {
      method,
      headers: {
        ...this.headers(),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    }).catch((err: unknown) => {
      // 探活时要看到真实的连接错误，普通调用则当作"没有响应"
      if (raw) throw err
      return null
    })
    if (!response) return null
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`sing-box 的 Clash API 返回 ${response.status}：${text.slice(0, 200)}`)
    }
    if (response.status === 204) return null
    const text = await response.text()
    return text ? (JSON.parse(text) as unknown) : null
  }
}
