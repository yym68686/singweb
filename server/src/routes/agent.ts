/**
 * Agent 用的接口。设备凭据走 Authorization 头，不用 Cookie。
 *
 * Agent 每次上报都是一个完整的往返：交上去本机的状态，拿回来该执行的操作。
 * 服务端因此不需要主动连设备，设备放在内网、没有公网地址也能管。
 */

import { timingSafeEqual } from 'node:crypto'
import { tokenHash } from '../auth.ts'
import type { AgentIdentity, Router } from '../http.ts'
import { ApiError, readBody, sendJson, unauthorized } from '../http.ts'
import type { LiveHub } from '../live.ts'
import type { ReportPayload, ReportedNode } from '../model.ts'
import { toDevice } from '../model.ts'
import * as store from '../store.ts'

/** 上报里各个数组的上限，防止一次塞进来太多 */
const MAX_NODES = 2000
const MAX_PROBES = 5000
const MAX_EVENTS = 500

/** Agent 默认每隔这么久上报一次。网页上的「立即探测」也等这个周期 */
const REPORT_INTERVAL_SEC = 15

export function registerAgentRoutes(router: Router, live: LiveHub): void {
  /**
   * 设备第一次接入时用注册令牌换自己的设备 id 和设备密钥。
   * 令牌就是服务端自己的一个会话 token，跟前端登录用同一套账号体系。
   */
  router.post('/agent/register', async ({ req, res }) => {
    const token = bearer(req.headers.authorization)
    if (!token) throw unauthorized('注册时要在 Authorization 头里带上网页上生成的令牌。')
    // 会话表里存的是散列，传原文进去永远查不到
    const user = await store.sessionUser(tokenHash(token))
    if (!user) throw unauthorized('注册令牌不对或者已经过期了，请在设备页重新生成。')

    const input = asRecord(await readBody(req))
    const name = text(input.name)
    const hostname = text(input.hostname)
    const platform = input.platform === 'linux' ? 'linux' : 'macos'
    if (!name) throw new ApiError(400, '请填写设备名称。', 'name')
    if (name.length > 60) throw new ApiError(400, '设备名称最多 60 个字。', 'name')
    if (!hostname) throw new ApiError(400, '请填写主机名。', 'hostname')

    const id = text(input.id) || `dev_${randomHex(9)}`
    const existing = await store.findDeviceRow(id)

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
      // 密钥只发一次：重新接入时沿用旧的，否则 Agent 手里那份当场作废，
      // 下一次上报就会被判成凭据不对
      secret: existing?.secret || randomHex(32),
    })

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
      // 之后 Agent 用它做身份，不再需要网页上的令牌
      secret: after.secret,
      registeredBy: user.username,
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

    const scopes = new Set<'devices' | 'nodes' | 'runtimes' | 'probes' | 'events'>()

    // 设备自报的字段先落库，离线时会话过期也不影响它继续上报
    await store.upsertDevice({
      id: device.id,
      name: text(report.device?.name) || device.name,
      hostname: text(report.device?.hostname) || device.name,
      platform: report.device?.platform === 'linux' ? 'linux' : 'macos',
      osVersion: text(report.device?.osVersion),
      agentVersion: text(report.device?.agentVersion),
      singboxVersion: text(report.device?.singboxVersion),
      clashApi: text(report.device?.clashApi),
      probeInbound: text(report.device?.probeInbound),
      dataDir: text(report.device?.dataDir),
      secret: text(report.device?.secret),
    })
    scopes.add('devices')

    const nodes = Array.isArray(report.nodes) ? report.nodes.slice(0, MAX_NODES) : []
    if (nodes.length) {
      await store.upsertReportedNodes(nodes)
      scopes.add('nodes')
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
    await store.clearPendingSwitches(ids)
    live.update(['runtimes'])
    sendJson(res, 200, { cleared: ids.length })
  }, 'agent')

  /**
   * 拉取订阅。订阅链接只存在服务端，由服务端去取，设备不必知道链接和 token。
   * 取回来的内容原样交给 Agent，用什么协议解析由 shared 里的解析器决定。
   */
  router.get('/agent/sources', async ({ res, device }) => {
    if (!device) throw unauthorized('设备凭据不对，请重新接入。')
    const rows = await store.listSources()
    sendJson(res, 200, {
      items: rows
        .filter((row) => row.enabled)
        .map((row) => ({
          id: row.id,
          name: row.name,
          url: row.url,
          lastFetchedAt: row.last_fetched_at ? row.last_fetched_at.toISOString() : null,
        })),
    })
  }, 'agent')

  /** 设备拉完订阅后回报结果，服务端记下节点数和出错原因 */
  router.post('/agent/sources/:id/result', async ({ req, res, params, device }) => {
    if (!device) throw unauthorized('设备凭据不对，请重新接入。')
    const source = await store.findSource(params.id)
    if (!source) throw new ApiError(404, '找不到这个订阅。')
    const input = asRecord(await readBody(req))
    const error = text(input.error)
    const nodes = Array.isArray(input.nodes) ? input.nodes.slice(0, MAX_NODES) : []

    // 拉取失败就别动节点：订阅站临时挂了不代表节点没了，
    // 清空节点池会把所有分组的候选一起弄没。
    if (!error && nodes.length) {
      await store.syncSourceNodes(params.id, source.name, normalizeNodes(nodes))
    }

    const nodeCount = Number.isInteger(input.nodeCount)
      ? (input.nodeCount as number)
      : nodes.length
    await store.recordFetch(params.id, { error: error || null, nodeCount })
    live.update(['nodes', 'devices'])
    sendJson(res, 200, { ok: true })
  }, 'agent')

  /** Agent 首轮启动时问一次「我该做什么」，省得等一个上报周期 */
  router.get('/agent/bootstrap', async ({ res, device }) => {
    if (!device) throw unauthorized('设备凭据不对，请重新接入。')
    const [groups, targets, sources, nodes, pending, runtimes] = await Promise.all([
      store.listGroups(),
      store.listTargets(),
      store.listSources(),
      store.listStoredNodes(),
      store.listPendingSwitches(device.id),
      store.listRuntimeRows(device.id),
    ])
    // 用户在网页上固定了某个节点，Agent 得知道——不然它下一轮就按探测结果重算回去了，
    // 固定的意义（一直用这个，直到取消）就没了。
    const pinned = new Map(runtimes.map((r) => [r.group_id, r.pinned_node_id]))
    sendJson(res, 200, {
      device: await store.findDevice(device.id),
      groups: groups.filter((g) => g.deviceIds.includes(device.id)),
      targets,
      nodes,
      sources: sources.filter((s) => s.enabled).map((s) => ({
        id: s.id,
        name: s.name,
        url: s.url,
      })),
      pins: Object.fromEntries(
        [...pinned].filter(([, nodeId]) => nodeId),
      ),
      pending,
      offlineAfterSec: 90,
      reportIntervalSec: 15,
    })
  }, 'agent')
}

/**
 * Agent 报上来的节点过一道手：字段缺失的直接丢掉，别让半条记录进库。
 * 节点是订阅内容解析出来的，格式不可信。
 */
function normalizeNodes(raw: unknown[]): Array<ReportedNode & { identity: string }> {
  const out: Array<ReportedNode & { identity: string }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const node = item as Record<string, unknown>
    const tag = text(node.tag)
    const server = text(node.server)
    const port = Number(node.port)
    const protocol = text(node.protocol)
    const identity = text(node.identity)
    if (!tag || !server || !protocol) continue
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    out.push({
      tag,
      protocol: protocol as ReportedNode['protocol'],
      server,
      port,
      region: text(node.region),
      outbound: (node.outbound ?? {}) as ReportedNode['outbound'],
      // 没有 identity 就没法合并重复节点，用 tag 兜底
      identity: identity || `${protocol}|${server}|${port}|${tag}`,
    })
  }
  return out
}

// ---------------------------------------------------------------- 辅助

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
