/**
 * 管理服务的入口。
 *
 * 启动顺序：迁移数据库、没有账号就建一个并打印密码、挂路由、监听。
 * 服务端自己不保存状态，进程随时可以重启，所有东西都在 PostgreSQL 里。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { hashPassword, publicUser, suggestPassword, tokenHash } from './auth.ts'
import { closePool, migrate } from './db.ts'
import { ApiError, Router, sendJson, toApiError, type AgentIdentity } from './http.ts'
import { LiveHub } from './live.ts'
import { registerAgentRoutes } from './routes/agent.ts'
import { readToken, registerAuthRoutes } from './routes/auth.ts'
import { registerEnrollRoutes } from './routes/enroll.ts'
import { registerInstallRoutes } from './routes/install.ts'
import { registerSubscribeRoutes } from './routes/subscribe.ts'
import { registerWebRoutes } from './routes/web.ts'
import { PresenceWatcher } from './presence.ts'
import { ensureGroups, ensureSshGroup, ensureSshTarget } from './seed.ts'
import { openStatic, type StaticFiles } from './static.ts'
import { SubscriptionScheduler } from './subscriptions.ts'
import * as store from './store.ts'

const API_PREFIX = '/api/v1'

/** 端口和监听地址。容器里要监听 0.0.0.0，否则外面连不进来 */
const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'

/** 前端构建产物。docker-compose 里由 Dockerfile 拷到这个位置 */
const STATIC_DIR = process.env.STATIC_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../dist')

const router = new Router()
const live = new LiveHub()
const subscriptions = new SubscriptionScheduler(live)
const presence = new PresenceWatcher(live)

async function main(): Promise<void> {
  await migrate()

  await ensureAdmin()

  // 默认的探测目标和分组。只在这个库还是空的时候建，之后再怎么重启都不会覆盖
  // 用户在网页上做过的修改
  await ensureSshTarget()
  await ensureSshGroup()
  await ensureGroups()

  registerAuthRoutes(router)
  registerWebRoutes(router, live, subscriptions)
  registerAgentRoutes(router, live)
  // 这几组是「不带登录态」的：订阅链接本身就是一个密钥，
  // 安装脚本和 Agent 包要能被 curl 直接拉下来
  registerSubscribeRoutes(router)
  registerEnrollRoutes(router)
  registerInstallRoutes(router)

  // 订阅由服务端自己拉：设备的接入与否跟节点池无关，没有设备也照样有节点
  subscriptions.start()
  // 设备掉线时没有请求进来，得有人定时看一眼，网页才能及时显示离线
  presence.start()

  const staticFiles = await openStatic(STATIC_DIR)
  if (!staticFiles) {
    console.warn(`没有找到前端构建产物（${STATIC_DIR}），这次只提供接口。`)
  }

  const server = createServer((req, res) => {
    handle(req, res, staticFiles).catch((err) => {
      // 这里接住的除了真正的故障，还有路由匹配和登录检查抛出的 401、403、404——
      // 它们是正常的接口响应，一律写成 500 的话前端没法照着跳登录页。
      const apiError = toApiError(err)
      if (apiError.status >= 500) console.error('请求处理出错：', err)
      if (!res.headersSent) {
        sendJson(res, apiError.status, {
          message: apiError.message,
          ...(apiError.field ? { field: apiError.field } : {}),
        })
      } else res.end()
    })
  })

  // SSE 是长连接，反向代理默认的超时会把它们掐掉，这里放宽
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000
  // 上报的请求体可能不小，超时给足
  server.requestTimeout = 120_000

  server.listen(PORT, HOST, () => {
    console.log(`singweb 管理服务已启动：http://${HOST}:${PORT}${API_PREFIX}`)
  })

  const shutdown = async (signal: string) => {
    console.log(`收到 ${signal}，正在退出。`)
    server.close()
    subscriptions.stop()
    presence.stop()
    live.close()
    await closePool().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

/**
 * 库里一个账号都没有时建一个，密码随机生成打在日志里。
 * 之后可以在网页上改密码，也可以再建别的账号。
 */
async function ensureAdmin(): Promise<void> {
  if ((await store.countUsers()) > 0) return
  const password = suggestPassword()
  const id = `usr_${Math.random().toString(16).slice(2, 12)}`
  await store.insertUser({
    id,
    username: 'admin',
    passwordHash: await hashPassword(password),
    role: 'admin',
  })
  const row = await store.findUserById(id)
  console.log('')
  console.log('  已经建好第一个账号，请登录后尽快改掉密码。')
  console.log(`  用户名：${row?.username ?? 'admin'}`)
  console.log(`  密码：${password}`)
  console.log('')
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  staticFiles: StaticFiles | null,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const pathname = url.pathname
  const method = req.method ?? 'GET'

  // 跨域请求带着 Cookie 才能算数，所以这里不做通配的 CORS，
  // 前端和接口同源部署，没有跨域的场景
  if (pathname === '/' || !pathname.startsWith(API_PREFIX)) {
    if (staticFiles) {
      await staticFiles.handle(pathname, res)
      return
    }
    throw new ApiError(404, '这个地址没有对应的内容。')
  }

  // 去掉前缀之后交给路由表
  const inner = pathname.slice(API_PREFIX.length) || '/'
  const matched = router.match(method, inner)

  if (!matched) {
    // 接口路径没匹配上时不要回前端页面，否则前端会拿到一段 HTML 去当 JSON 解析
    throw new ApiError(404, `没有这个接口：${method} ${pathname}`)
  }

  const { route, params } = matched
  const user = route.auth === 'web' || route.auth === 'open' ? await readUser(req) : null
  if (route.auth === 'web') {
    if (!user) throw new ApiError(401, '请先登录。')
    if (route.admin && user.role !== 'admin') {
      throw new ApiError(403, '这个操作要管理员才能做。')
    }
  }

  const device = route.auth === 'agent' ? await readDevice(req) : null

  try {
    await route.handler({ req, res, params, url, user, device })
  } catch (err) {
    const apiError = toApiError(err)
    // 出错之前可能已经写了头（比如 SSE），那时只能断开
    if (res.headersSent) {
      res.end()
      return
    }
    if (apiError.status >= 500) {
      console.error(`${method} ${pathname} 出错：`, err)
    }
    sendJson(res, apiError.status, {
      message: apiError.message,
      ...(apiError.field ? { field: apiError.field } : {}),
    })
  }
}

/**
 * 读出登录的账号。每次请求查一次库，会话失效立刻生效。
 *
 * 只认 Cookie。设备接入走的是设备页生成的一次性令牌，跟登录会话没有关系，
 * 所以这里不再认 Authorization 头——否则一个浏览器会话 token 就能拿来当设备凭据。
 */
async function readUser(req: IncomingMessage) {
  const token = readToken(req)
  if (!token) return null
  const row = await store.sessionUser(tokenHash(token)).catch(() => null)
  if (!row) return null
  const { role, ...rest } = publicUser(row)
  return { ...rest, role }
}

/** Authorization: Bearer <token> 里的那一段 */
function bearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return null
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return match ? match[1].trim() : null
}

/**
 * 设备身份。Authorization: Bearer <secret>，
 * 密钥是注册时发下去的那个，服务端存的是原文——它不像密码需要防拖库。
 */
async function readDevice(req: IncomingMessage): Promise<AgentIdentity | null> {
  const secret = bearerToken(req.headers.authorization)
  if (!secret) return null

  const row = await store.findDeviceBySecret(secret)
  if (!row) return null
  return { id: row.id, name: row.name }
}

await main()
