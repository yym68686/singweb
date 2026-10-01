/**
 * HTTP 骨架：路由、请求解析、统一出错回包。
 *
 * 只用 node:http，不引框架。端点数得过来，路由表就在这儿匹配；
 * 出错时统一回 {message, field}，message 是可以直接给用户看的一句中文。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Invalid } from './validate.ts'

/** 请求太大就不收，避免有人往 /agent/report 灌数据 */
const BODY_LIMIT = 4 * 1024 * 1024

/** 接口出错。status 是 HTTP 状态码，field 让前端把消息标到对应输入框 */
export class ApiError extends Error {
  readonly status: number
  readonly field?: string

  constructor(status: number, message: string, field?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.field = field
  }
}

export const badRequest = (message: string, field?: string) => new ApiError(400, message, field)
export const unauthorized = (message = '请先登录。') => new ApiError(401, message)
export const forbidden = (message = '这个账号没有权限做这件事。') => new ApiError(403, message)
export const notFound = (message = '找不到这个对象。') => new ApiError(404, message)
export const conflict = (message: string, field?: string) => new ApiError(409, message, field)

// ---------------------------------------------------------------- 路由

export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  /** 路径里的 :参数，比如 /devices/:id 会给出 { id } */
  params: Record<string, string>
  url: URL
  /** 登录后的账号，没登录时是 null */
  user: SessionUser | null
  /** 给 Agent 用的设备身份，没带凭据时是 null */
  device: AgentIdentity | null
}

export interface SessionUser {
  id: string
  username: string
  role: 'admin' | 'viewer'
}

export interface AgentIdentity {
  id: string
  name: string
}

export type Handler = (ctx: Ctx) => Promise<void> | void

interface Route {
  method: string
  pattern: string
  keys: string[]
  re: RegExp
  handler: Handler
  /** 谁能调：web 是登录用户，agent 是设备凭据，open 不检查 */
  auth: 'web' | 'agent' | 'open'
  /** 只有管理员能调 */
  admin?: boolean
}

/** ':id' 这种参数名，转成正则时把整段抓下来 */
function compile(pattern: string): { re: RegExp; keys: string[] } {
  const keys: string[] = []
  const source = pattern
    .split('/')
    .map((part) => {
      if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      keys.push(part.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { re: new RegExp(`^${source}$`), keys }
}

export class Router {
  private routes: Route[] = []

  add(method: string, pattern: string, handler: Handler, auth: Route['auth'], admin = false) {
    const { re, keys } = compile(pattern)
    this.routes.push({ method, pattern, keys, re, handler, auth, admin })
  }

  get(p: string, h: Handler, auth: Route['auth'] = 'web') {
    this.add('GET', p, h, auth)
  }
  post(p: string, h: Handler, auth: Route['auth'] = 'web') {
    this.add('POST', p, h, auth)
  }
  put(p: string, h: Handler, auth: Route['auth'] = 'web') {
    this.add('PUT', p, h, auth)
  }
  patch(p: string, h: Handler, auth: Route['auth'] = 'web') {
    this.add('PATCH', p, h, auth)
  }
  delete(p: string, h: Handler, auth: Route['auth'] = 'web') {
    this.add('DELETE', p, h, auth)
  }

  /** 管理员专用。写成方法是为了让路由表里一眼能看出哪些是管理操作 */
  adminGet(p: string, h: Handler) {
    this.add('GET', p, h, 'web', true)
  }
  adminPost(p: string, h: Handler) {
    this.add('POST', p, h, 'web', true)
  }
  adminDelete(p: string, h: Handler) {
    this.add('DELETE', p, h, 'web', true)
  }

  /**
   * 找到匹配的路由。路径对上了但方法不对时回 405，
   * 这样前端拼错方法能立刻看出来，不会误以为是路径写错了。
   */
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    let pathMatched = false
    for (const route of this.routes) {
      const m = route.re.exec(pathname)
      if (!m) continue
      pathMatched = true
      if (route.method !== method) continue
      const params: Record<string, string> = {}
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1])
      })
      return { route, params }
    }
    if (pathMatched) throw new ApiError(405, '这个地址不支持这种请求方式。')
    return null
  }

  /** 是否是已注册的路径（用来区分接口和前端静态文件） */
  hasPath(pathname: string): boolean {
    return this.routes.some((r) => r.re.test(pathname))
  }
}

// ---------------------------------------------------------------- 请求解析

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > BODY_LIMIT) throw new ApiError(413, '请求内容太大了。')
    chunks.push(buf)
  }
  if (!chunks.length) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw badRequest('请求内容不是有效的 JSON。')
  }
}

/** 取一个字符串字段，空字符串按未填处理 */
export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text || undefined
}

export function boolParam(url: URL, key: string): boolean | undefined {
  const value = url.searchParams.get(key)
  if (value === null) return undefined
  return value === '1' || value === 'true'
}

// ---------------------------------------------------------------- 回包

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  const body = JSON.stringify(payload ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // 接口一律不缓存，前端自己用 react-query 管新鲜度
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function sendEmpty(res: ServerResponse, status = 204): void {
  if (res.headersSent) return
  res.writeHead(status, { 'cache-control': 'no-store' })
  res.end()
}

/** 把任何异常转成接口错误。校验错误带 field，其他错误只留一句能看的话 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (err instanceof Invalid) return new ApiError(400, err.message, err.field)
  const message = err instanceof Error ? err.message : String(err)
  // 唯一约束冲突多数是重名，直接说清楚比抛 500 有用
  if (/duplicate key|unique constraint/i.test(message)) {
    return conflict('已经有同名的对象了。')
  }
  console.error('接口出错：', err)
  return new ApiError(500, '服务端出错了，稍后再试。')
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress ?? ''
}

/**
 * 走没走 HTTPS。决定 Cookie 要不要加 Secure。
 *
 * 先看浏览器带的 Origin：有的平台在边缘终止 TLS，转进来时把 x-forwarded-proto
 * 一律写成 http，只看转发头会把 https 站点当成 http，Cookie 就少了 Secure。
 * 登录、退出、改密码都是 POST，浏览器一定会带 Origin。被伪造了也无妨，
 * 最坏是给伪造者自己的 Cookie 多加或少加一个 Secure
 */
export function isSecure(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.startsWith('https://')) return true
  const proto = req.headers['x-forwarded-proto']
  if (typeof proto === 'string' && proto) return proto.split(',')[0].trim() === 'https'
  return Boolean((req.socket as { encrypted?: boolean }).encrypted)
}
