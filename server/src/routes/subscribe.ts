/**
 * singweb 自己的订阅链接。
 *
 * 设备只认这一个地址：它拿到的是一整份 sing-box 配置，里面已经有归一化过的节点、
 * 分组转成的 selector 和路由规则。上游有几个订阅、链接是什么，设备一概不知道。
 *
 * 链接里的 token 存在 settings 表里，不在代码里，也不进仓库：首次访问时随机生成。
 * 拿到链接的人就能拿到全部节点，所以它按密码对待——只在网页上显示，重置在网页上做。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { buildConfig } from '../../../shared/singbox.ts'
import { sendJson, type Router } from '../http.ts'
import * as store from '../store.ts'

/** settings 表里放订阅 token 的键 */
const TOKEN_KEY = 'subscription:token'

/** 「全部设备」的分组对订阅链接同样适用，这里不按设备过滤 */
async function buildSubscriptionConfig(tun: boolean) {
  const [nodes, groups] = await Promise.all([store.listStoredNodes(), store.listGroups()])
  const built = buildConfig({ nodes, groups, tun })
  // 订阅链接的客户端没有 Agent 在旁边，managed 保持不填：
  // 自动分组交给 sing-box 自带的 urltest，而不是等着谁来切 selector
  return built
}

/** 随机 token。订阅链接会出现在别处的配置里，用十六进制避免转义问题 */
function newToken(): string {
  return randomBytes(24).toString('hex')
}

/**
 * 读出订阅 token，没有就生成一个。
 *
 * 用 settings 表的唯一键来挡并发：两个请求同时发现没有 token 时，
 * on conflict do nothing 只有一个写得进去，另一个回头读到的是同一个值，
 * 不会出现「网页上显示 A、实际生效的是 B」这种情况。
 */
async function ensureToken(): Promise<string> {
  const existing = await store.getSetting(TOKEN_KEY)
  if (existing) return existing
  const token = newToken()
  await store.ensureSetting(TOKEN_KEY, token)
  return (await store.getSetting(TOKEN_KEY)) ?? token
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // length 不等时 timingSafeEqual 会抛，先比长度
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function registerSubscribeRoutes(router: Router): void {
  /** 网页上的「singweb 订阅链接」。返回 token 原文，跟订阅链接一样按密码对待 */
  router.adminGet('/subscription', async (ctx) => {
    const token = await ensureToken()
    sendJson(ctx.res, 200, { token })
  })

  /** 重置订阅链接。旧链接立刻失效，已经导入它的客户端要重新导入 */
  router.adminPost('/subscription/reset', async (ctx) => {
    const token = newToken()
    await store.setSetting(TOKEN_KEY, token)
    sendJson(ctx.res, 200, { token })
  })

  /**
   * 设备拿配置的入口：GET /api/v1/subscribe/<token>
   *
   * 不检查登录态——Agent 和第三方客户端只有这一条链接。token 错了就直接 404，
   * 不回 401：这个地址不告诉外面「有没有这个订阅」。
   */
  router.get(
    '/subscribe/:token',
    async (ctx) => {
      const expected = await ensureToken()
      if (!sameToken(ctx.params.token, expected)) {
        ctx.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        ctx.res.end('没有这个订阅。')
        return
      }

      const built = await buildSubscriptionConfig(ctx.url.searchParams.get('tun') === '1')
      const body = JSON.stringify(built.config, null, 2)
      // 订阅内容随节点池变化，中间层不能缓存
      ctx.res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        // sing-box 之类的客户端会把这一段当成订阅信息显示
        'profile-title': 'singweb',
        'profile-update-interval': '6',
      })
      ctx.res.end(body)
    },
    'open',
  )
}
