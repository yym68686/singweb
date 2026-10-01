/**
 * 设备接入。
 *
 * 网页的设备页点「接入新设备」，这里生成一个一次性令牌，然后把令牌拼进安装命令里。
 * 令牌只能用一次、半小时过期，库里只存散列，所以它出现在命令行里、被复制到聊天窗口里
 * 都不至于让谁多接一台设备进来。
 *
 * 状态查询是给设备页轮询用的：命令跑起来之后，页面靠它把「等待接入」变成「已接入」。
 */

import { badRequest, notFound, readBody, sendJson, type Router } from '../http.ts'
import { toDevice } from '../model.ts'
import * as store from '../store.ts'
import { isScriptBase } from './install.ts'

/**
 * 网页报上来的自己所在的站点，安装脚本照着它连回管理服务。
 * 网页知道用户是从哪个地址打开的，服务端在 TLS 终止的代理后面只看得到 http。
 * 不带也行（直接调接口时），那样安装脚本按请求本身推算
 */
function enrollBase(body: unknown): string | null {
  if (body === undefined) return null
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('请求内容要是一个对象。')
  const raw = (body as Record<string, unknown>).base
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' || !isScriptBase(raw)) {
    throw badRequest('管理服务地址只能是 http(s)://主机[:端口]，不带路径。', 'base')
  }
  return raw
}

export function registerEnrollRoutes(router: Router): void {
  /** 生成一个接入令牌。要登录，而且只有管理员能生成 */
  router.adminPost('/devices/enroll', async (ctx) => {
    const base = enrollBase(await readBody(ctx.req))
    const created = await store.createEnrollToken(ctx.user?.id ?? null, base)
    sendJson(ctx.res, 201, {
      id: created.id,
      token: created.token,
      expiresAt: created.expiresAt.toISOString(),
    })
  })

  /**
   * 这个令牌用掉了没有。设备页每两秒问一次，直到拿到设备为止。
   *
   * 按令牌 id 查而不是按原文查：原文只发给浏览器一次，服务端不再留。
   * 没用上就过期了、或者已经被清理掉时回 404，页面据此提示「换一条命令」。
   */
  router.get('/devices/enroll/:id', async (ctx) => {
    const row = await store.findEnrollToken(ctx.params.id)
    if (!row || (!row.used_at && row.expires_at.getTime() <= Date.now())) {
      throw notFound('这条接入命令已经失效，重新生成一条。')
    }
    if (!row.used_at) {
      sendJson(ctx.res, 200, { state: 'pending', expiresAt: row.expires_at.toISOString() })
      return
    }
    const deviceRow = row.device_id ? await store.findDeviceRow(row.device_id) : null
    sendJson(ctx.res, 200, {
      state: 'joined',
      deviceId: row.device_id,
      device: deviceRow ? toDevice(deviceRow) : null,
    })
  })
}
