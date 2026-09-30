/**
 * 登录相关的接口。
 *
 * 会话放在数据库里，token 只以散列形式落库，浏览器拿到的原文放在 HttpOnly Cookie 里，
 * 脚本读不到。服务端自己不保存任何登录状态，所以重启、换实例都不会把用户踢下线。
 */

import type { IncomingMessage } from 'node:http'
import {
  clearSessionCookie,
  hashPassword,
  newSessionToken,
  publicUser,
  readSessionCookie,
  sessionCookie,
  sessionExpiry,
  suggestPassword,
  tokenHash,
  validatePassword,
  validateUsername,
  verifyPassword,
} from '../auth.ts'
import { newId } from '../db.ts'
import { ApiError, badRequest, isSecure, readBody, sendJson, unauthorized, type Router } from '../http.ts'
import * as store from '../store.ts'

/** 登录失败的次数限制，防止有人慢慢试密码 */
const ATTEMPTS = new Map<string, { count: number; until: number }>()
const MAX_ATTEMPTS = 8
const LOCK_MS = 5 * 60 * 1000

function throttle(key: string): void {
  const entry = ATTEMPTS.get(key)
  if (!entry) return
  if (entry.until > Date.now() && entry.count >= MAX_ATTEMPTS) {
    const seconds = Math.ceil((entry.until - Date.now()) / 1000)
    throw new ApiError(429, `试得太频繁了，请等 ${seconds} 秒再试。`)
  }
}

function noteFailure(key: string): void {
  const entry = ATTEMPTS.get(key) ?? { count: 0, until: 0 }
  entry.count += 1
  entry.until = Date.now() + LOCK_MS
  ATTEMPTS.set(key, entry)
}

function clearFailures(key: string): void {
  ATTEMPTS.delete(key)
}

export function registerAuthRoutes(router: Router): void {
  router.get('/auth/me', async ({ res, user }) => {
    // 没登录不是错误，前端拿它判断要不要跳到登录页
    sendJson(res, 200, { user })
  }, 'open')

  router.post('/auth/login', async ({ req, res, user }) => {
    if (user) throw badRequest('已经登录了。')
    const body = ((await readBody(req)) ?? {}) as Record<string, unknown>

    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username) throw badRequest('请填写用户名。', 'username')
    if (!password) throw badRequest('请填写密码。', 'password')

    throttle(`${username}|${req.socket.remoteAddress ?? ''}`)

    const row = await store.findUserByUsername(username)
    // 账号不存在也走一遍散列校验的耗时，免得从响应快慢看出用户名对不对
    const ok = row ? await verifyPassword(password, row.password_hash) : false
    if (!row || !ok) {
      noteFailure(`${username}|${req.socket.remoteAddress ?? ''}`)
      throw new ApiError(401, '用户名或密码不对。')
    }

    clearFailures(`${username}|${req.socket.remoteAddress ?? ''}`)
    const token = newSessionToken()
    const expires = sessionExpiry()
    await store.insertSession(tokenHash(token), row.id, expires)
    await store.purgeExpiredSessions()

    res.setHeader('set-cookie', sessionCookie(token, expires, isSecure(req)))
    sendJson(res, 200, { user: publicUser(row) })
  }, 'open')

  router.post('/auth/logout', async ({ req, res }) => {
    const token = readToken(req)
    if (token) await store.deleteSession(tokenHash(token))
    res.setHeader('set-cookie', clearSessionCookie(isSecure(req)))
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  }, 'open')

  // ------------------------------------------------------------ 账号管理

  router.adminGet('/auth/users', async ({ res }) => {
    const rows = await store.listUsers()
    sendJson(res, 200, { items: rows.map(publicUser) })
  })

  router.adminPost('/auth/users', async ({ req, res }) => {
    const body = ((await readBody(req)) ?? {}) as Record<string, unknown>
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const problem = validateUsername(username)
    if (problem) throw badRequest(problem, 'username')

    const role = body.role === 'viewer' ? 'viewer' : 'admin'
    // 不填密码就随便生成一个，回给调用方，让用户自己改
    const generated = typeof body.password === 'string' && body.password ? null : suggestPassword()
    const password = generated ?? (body.password as string)
    const weak = validatePassword(password)
    if (weak) throw badRequest(weak, 'password')

    if (await store.findUserByUsername(username)) {
      throw new ApiError(409, '这个用户名已经有人用了。', 'username')
    }
    // id 由这边生成：插入语句不接受默认值，建完再读回来
    const id = newId('usr')
    await store.insertUser({
      id,
      username,
      passwordHash: await hashPassword(password),
      role,
    })
    const row = await store.findUserById(id)
    if (!row) throw new ApiError(500, '账号建好了，但读不回来，请刷新页面看看。')
    sendJson(res, 201, {
      user: publicUser(row),
      ...(generated ? { password: generated } : {}),
    })
  })

  router.adminDelete('/auth/users/:id', async ({ res, user, params }) => {
    if (!user) throw unauthorized()
    if (user.id === params.id) throw badRequest('不能删掉自己正在用的账号。')
    const target = await store.findUserById(params.id)
    if (!target) throw new ApiError(404, '找不到这个账号。')
    const total = await store.countUsers()
    if (total <= 1) throw badRequest('至少要留一个账号，否则没人能登录了。')
    await store.deleteUser(params.id)
    res.writeHead(204, { 'cache-control': 'no-store' }).end()
  })

  router.post('/auth/users/:id/password', async ({ req, res, user, params }) => {
    if (!user) throw unauthorized()
    const target = await store.findUserById(params.id)
    if (!target) throw new ApiError(404, '找不到这个账号。')

    const body = ((await readBody(req)) ?? {}) as Record<string, unknown>
    const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : ''
    const generated = typeof body.password === 'string' && body.password ? null : suggestPassword()
    const password = generated ?? (body.password as string)

    // 改别人的密码要管理员，改自己的要知道原来的密码
    const changingSelf = user.id === params.id
    if (changingSelf) {
      if (!oldPassword || !(await verifyPassword(oldPassword, target.password_hash))) {
        throw badRequest('原来的密码不对。', 'oldPassword')
      }
    } else if (user.role !== 'admin') {
      throw new ApiError(403, '只有管理员能改别人的密码。')
    }

    const weak = validatePassword(password)
    if (weak) throw badRequest(weak, 'password')
    await store.updateUserPassword(params.id, await hashPassword(password))
    // 改了密码就把所有旧会话踢掉，包括当前这个
    await store.deleteSessionsOfUser(params.id)
    res.setHeader('set-cookie', clearSessionCookie(isSecure(req)))
    sendJson(res, 200, { password: generated ?? undefined })
  }, 'web')
}

/** 从 Cookie 里取会话 token，入口和这里共用同一个解析 */
export function readToken(req: IncomingMessage): string | null {
  return readSessionCookie(req.headers.cookie)
}
