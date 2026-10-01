/**
 * Agent 用的接口。设备凭据走 Authorization 头，不用 Cookie。
 *
 * Agent 每次上报都是一个完整的往返：交上去本机的状态，拿回来该执行的操作。
 * 服务端因此不需要主动连设备，设备放在内网、没有公网地址也能管。
 */

import { timingSafeEqual } from 'node:crypto'
import type { AgentIdentity, Router } from '../http.ts'
import { ApiError, readBody, sendJson, unauthorized } from '../http.ts'
import type { LiveHub } from '../live.ts'
import type { Platform, ReportPayload } from '../model.ts'
import { toDevice } from '../model.ts'
import * as store from '../store.ts'
import { appliesTo } from '../../../shared/groups.ts'

/** 上报里各个数组的上限，防止一次塞进来太多 */
const MAX_PROBES = 5000
const MAX_EVENTS = 500

/** Agent 默认每隔这么久上报一次。网页上的「立即探测」也等这个周期 */
const REPORT_INTERVAL_SEC = 15

/** 超过这么久没上报就当作离线，网页和 Agent 用同一个数 */
const OFFLINE_AFTER_SEC = 90

export function registerAgentRoutes(router: Router, live: LiveHub): void {
  /**
   * 设备接入：用网页上生成的一次性令牌换自己的设备 id 和设备密钥。
   *
   * 令牌跟登录会话是两回事。它会出现在命令行里，可能被终端历史、日志、截图带走，
   * 所以有独立的生命周期：只能成功一次，半小时作废，库里只存散列。
   *
   * 重复接入的设备要带上自己上一次拿到的密钥，服务端才认这个 id 是它本人；
   * 没带或者对不上就发一套新的 id，免得谁都能顶掉别人的设备。
   */
  router.post('/agent/register', async ({ req, res }) => {
    const token = bearer(req.headers.authorization)
    if (!token) throw unauthorized('接入时要在 Authorization 头里带上设备页生成的令牌。')

    const input = asRecord(await readBody(req))
    const name = text(input.name)
    const hostname = text(input.hostname)
    const platform = parsePlatform(input.platform)
    if (!name) throw new ApiError(400, '请填写设备名称。', 'name')
    if (name.length > 60) throw new ApiError(400, '设备名称最多 60 个字。', 'name')
    if (!hostname) throw new ApiError(400, '请填写主机名。', 'hostname')

    const claimed = text(input.id)
    const claimedSecret = text(input.secret)
    // 先看它是不是原来那台设备：id 对得上、密钥也对得上，才继续用这个 id
    const known = claimed ? await store.findDeviceRow(claimed) : null
    const reuse = Boolean(known && claimedSecret && sameSecret(known.secret, claimedSecret))
    if (known && !reuse) {
      await store.insertEvent({
        at: new Date().toISOString(),
        kind: 'device-rejected',
        severity: 'warn',
        deviceId: known.id,
        groupId: null,
        nodeId: null,
        message: `有人拿着「${known.name}」的设备 id 想要接入，密钥对不上，已经发给它一个新的身份`,
      })
    }
    const id = reuse ? (known as NonNullable<typeof known>).id : `dev_${randomHex(9)}`

    // 令牌在这一步作废。先消耗再写设备：并发用同一个令牌时只有一条能通过
    const consumed = await store.consumeEnrollToken(token, id)
    if (!consumed) throw unauthorized('接入令牌不对、已经用过或者过期了，请在设备页重新生成。')

    const { before, after } = await store.upsertDevice({
      id,
      name,
      hostname,
      platform,
      osVersion: text(input.osVersion),
      agentVersion: text(input.agentVersion),
      singboxVersion: text(input.singboxVersion),
      clashApi: text(input.clashApi),
      probeInbound: text(input.probeInbound),
      dataDir: text(input.dataDir),
      proxyListen: input.proxyListen === undefined ? undefined : text(input.proxyListen),
      // 密钥发一次就固定下来，之后靠它认设备
      secret: reuse && known ? known.secret : randomHex(32),
    })

    const by = consumed.created_by ? (await store.findUserById(consumed.created_by))?.username ?? null : null
    await store.insertEvent({
      at: new Date().toISOString(),
      kind: 'device-online',
      severity: 'good',
      deviceId: after.id,
      groupId: null,
      nodeId: null,
      message: before ? `「${after.name}」重新接入了` : `「${after.name}」第一次接入`,
    })

    live.update(['devices', 'runtimes', 'nodes', 'probes', 'events'])
    sendJson(res, before ? 200 : 201, {
      device: toDevice(after),
      // 之后 Agent 用它做身份，令牌已经作废
      secret: after.secret,
      registeredBy: by,
    })
  }, 'open')

  /**
   * 设备上报。Agent 每隔一段时间调一次，内容是本机的节点、分组运行状态、探测结果。
   *
   * 同时也充当轮询：待执行的操作在这条响应里带回去，Agent 执行完在下一次上报里确认。
   */
  router.post('/agent/report', async ({ req, res, device }) => {
    if (!device) throw unauthorized('设备凭据不对，请重新接入。')
    const payload = await readBody(req)
    if (!payload || typeof payload !== 'object') throw new ApiError(400, '上报内容不是有效的对象。')
    const report = payload as ReportPayload

    const scopes = new Set<'devices' | 'runtimes' | 'probes' | 'events'>()

    // 设备自报的字段先落库。密钥不在这里改：上报已经是用密钥认证过的，
    // 再允许它顺手换一个，拿到过一次密钥的人就能把设备整个抢走
    const { before, after } = await store.upsertDevice({
      id: device.id,
      name: text(report.device?.name) || device.name,
      hostname: text(report.device?.hostname) || device.name,
      platform: parsePlatform(report.device?.platform),
      osVersion: text(report.device?.osVersion),
      agentVersion: text(report.device?.agentVersion),
      singboxVersion: text(report.device?.singboxVersion),
      clashApi: text(report.device?.clashApi),
      probeInbound: text(report.device?.probeInbound),
      dataDir: text(report.device?.dataDir),
      proxyListen:
        report.device?.proxyListen === undefined ? undefined : text(report.device.proxyListen),
      singboxError: singboxErrorOf(report.device),
    })
    scopes.add('devices')

    // 掉线记过事件的设备又报上来了，补一条上线，事件页上离线和上线是成对的
    if (before?.offline_noted) {
      await store.insertEvent({
        kind: 'device-online',
        severity: 'good',
        deviceId: device.id,
        groupId: null,
        nodeId: null,
        message: `「${after.name}」重新上线了`,
      })
      scopes.add('events')
      scopes.add('runtimes')
    }

    const runtime = Array.isArray(report.runtime) ? report.runtime : []
    for (const item of runtime) {
      if (!item?.groupId) continue
      await store.saveRuntime(device.id, item)
    }
    if (runtime.length) scopes.add('runtimes')

    const probes = Array.isArray(report.probes) ? report.probes.slice(0, MAX_PROBES) : []
    for (const probe of probes) {
      if (!probe?.nodeId || !probe?.targetId || !probe.last) continue
      await store.saveProbe(device.id, probe.nodeId, probe)
    }
    if (probes.length) scopes.add('probes')

    const events = Array.isArray(report.events) ? report.events.slice(0, MAX_EVENTS) : []
    for (const event of events) {
      if (!event?.kind || !event?.severity || !event?.message) continue
      // Agent 补传离线期间的事件时会重复，按时间和内容挡一道
      if (event.at) {
        const at = new Date(event.at)
        if (await store.eventExists(device.id, at, event.kind, event.message)) continue
      }
      await store.insertEvent({ ...event, deviceId: device.id })
    }
    if (events.length) scopes.add('events')

    // 设备报上来就说明它还活着，超时的那点时间差不用管
    await store.touchDevice(device.id)

    // 待办交给 Agent 去执行，服务端不替它决定
    const pending = await store.listPendingSwitches(device.id)

    if (scopes.size) live.update([...scopes])
    sendJson(res, 200, {
      ok: true,
      serverTime: new Date().toISOString(),
      pending,
      // Agent 拿它决定下一轮多久之后再上报
      reportIntervalSec: REPORT_INTERVAL_SEC,
    })
  }, 'agent')

  /** Agent 确认某条待办已经执行，服务端把它从队列里划掉 */
  router.post('/agent/ack', async ({ req, res, device }) => {
    if (!device) throw unauthorized('设备凭据不对，请重新接入。')
    const input = asRecord(await readBody(req))
    const ids = Array.isArray(input.ids)
      ? input.ids.filter((id): id is string => typeof id === 'string')
      : []
    if (!ids.length) throw new ApiError(400, '请给出要确认的操作。', 'ids')
    const cleared = await store.clearPendingSwitches(ids, device.id)
    live.update(['runtimes'])
    sendJson(res, 200, { cleared })
  }, 'agent')

  /**
   * 报告一次切换失败。
   *
   * Agent 执行失败时不会 ack，这一条会被反复领走。没有这个接口的话，一个永远
   * 不会成功的操作（比如节点已经停用了，或者设备上的 sing-box 没在跑）就会每 15 秒重试一次，
   * 而且网页上完全看不出来。记满次数后服务端放弃，写一条事件，网页上显示为失败。
   */
  router.post('/agent/pending/:id/fail', async ({ req, res, params, device }) => {
    if (!device) throw unauthorized('设备凭据不对，请重新接入。')
    const input = asRecord(await readBody(req))
    const error = typeof input.error === 'string' ? input.error.trim() : ''
    const row = await store.failPendingSwitch(params.id, device.id, error || '切换失败，没有说明原因。')
    // 待办可能已经被用户在网页上撤掉了，那不是错误
    if (!row) {
      sendJson(res, 200, { ok: true, abandoned: false })
      return
    }

    // 到上限就写一条事件：它在事件页留下痕迹，而不是无声消失
    if (row.failed_at) {
      const group = await store.findGroup(row.group_id)
      const node = row.node_id ? await store.findNodeRow(row.node_id) : null
      const target = node ? `「${node.tag}」` : '直连'
      await store.insertEvent({
        kind: 'switch-failed',
        severity: 'warn',
        deviceId: device.id,
        groupId: row.group_id,
        nodeId: row.node_id,
        message:
          `「${group?.name ?? row.group_id}」切到 ${target} 连续 ${row.attempts} 次失败，已放弃：` +
          row.last_error,
      })
      live.update(['events'])
    }
    live.update(['runtimes'])
    sendJson(res, 200, { ok: true, abandoned: Boolean(row.failed_at), attempts: row.attempts })
  }, 'agent')

  /** Agent 首轮启动时问一次「我该做什么」，省得等一个上报周期 */
  router.get('/agent/bootstrap', async ({ res, device }) => {
    if (!device) throw unauthorized('设备凭据不对，请重新接入。')
    const [groups, targets, nodes, pending, runtimes] = await Promise.all([
      store.listGroups(),
      store.listTargets(),
      store.listStoredNodes(),
      store.listPendingSwitches(device.id),
      store.listRuntimeRows(device.id),
    ])
    // 用户在网页上固定了某个节点，Agent 得知道——不然它下一轮就按探测结果重算回去了，
    // 固定的意义（一直用这个，直到取消）就没了。
    const pinned = new Map(runtimes.map((r) => [r.group_id, r.pinned_node_id]))
    sendJson(res, 200, {
      device: await store.findDevice(device.id),
      // 分组一个都没指定设备时表示所有设备，所以这里不能写 deviceIds.includes
      groups: groups.filter((g) => appliesTo(g, device.id)),
      targets,
      nodes,
      pins: Object.fromEntries(
        [...pinned].filter(([, nodeId]) => nodeId),
      ),
      pending,
      offlineAfterSec: OFFLINE_AFTER_SEC,
      reportIntervalSec: REPORT_INTERVAL_SEC,
    })
  }, 'agent')
}

// ---------------------------------------------------------------- 辅助

/**
 * 上报里的 sing-box 错误。没有这个字段是旧版 Agent，保留库里的值；
 * 报了空值表示现在正常。太长的截断，别让一份报错把设备页撑开
 */
function singboxErrorOf(device: ReportPayload['device'] | undefined): string | null | undefined {
  if (!device || !('singboxError' in device)) return undefined
  const value = text(device.singboxError)
  return value ? value.slice(0, 1000) : null
}

/** Agent 自报的平台，认不出来的按 macOS 算（早期版本只分 macos 和 linux） */
function parsePlatform(value: unknown): Platform {
  return value === 'linux' || value === 'windows' ? value : 'macos'
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {}
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function bearer(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return null
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return match ? match[1].trim() : null
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 比对两个密钥，用固定时间的写法，免得从响应快慢上试出来 */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export type { AgentIdentity }
