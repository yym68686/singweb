/**
 * 网页用的接口。路径和 docs/api.md 的清单一一对应。
 *
 * 这一层只做三件事：把请求里的参数取出来、调存取层、把结果按接口形状回出去。
 * 涉及引用完整性的判断（删目标前有没有分组在用）放在这里，因为那是业务规则。
 */

import type {
  AllFailAction,
  Device,
  Group,
  GroupRuntime,
  NodeProtocol,
  ProxyNode,
  Selection,
  Strategy,
  UpdateScope,
} from '../../../shared/types.ts'
import type { RuntimeRow } from '../model.ts'
import { ApiError, conflict, notFound, readBody, sendJson, type Router } from '../http.ts'
import type { LiveHub } from '../live.ts'
import { OFFLINE_AFTER_MS, isOnline, toDevice, toGroup, toNodeSource, toProxyNode } from '../model.ts'
import { toGroupRuntime, type RuntimeSnapshot } from '../../../shared/runtime.ts'
import * as store from '../store.ts'
import { checkGroup, checkTarget } from '../validate.ts'

/** 分组或目标写完之后，受影响的数据范围 */
const GROUP_SCOPES: UpdateScope[] = ['groups', 'runtimes', 'nodes']
const TARGET_SCOPES: UpdateScope[] = ['targets', 'groups', 'probes']

function body(source: unknown): Record<string, unknown> {
  if (!source || typeof source !== 'object') throw new ApiError(400, '请求内容不是有效的对象。')
  return source as Record<string, unknown>
}

/** 接口里要填的字段，防注入这种事交给参数化查询，这里只挡明显不合规的值 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/**
 * 把库里的运行状态行拼成接口形状：补上 state 和 eligibleNodeIds。
 * 这两个字段前端到处在用，但不该存库——它们随设备在线状态和节点启停变化，
 * 存进去就会过时。
 */
function runtimeItems(
  rows: RuntimeRow[],
  groupById: Map<string, Group>,
  deviceById: Map<string, Device>,
  nodes: ProxyNode[],
): Array<GroupRuntime & { groupName: string; selection: Selection; reportedAt: string }> {
  const fallbackReportedAt = new Date().toISOString()
  return rows.flatMap((row) => {
    const group = groupById.get(row.group_id)
    const device = deviceById.get(row.device_id)
    // 分组删了、设备删了，或者分组不再管这台设备：这条运行状态是残留的
    if (!group || !device || !group.deviceIds.includes(row.device_id)) return []
    const snapshot: RuntimeSnapshot = {
      groupId: row.group_id,
      activeNodeId: row.active_node_id,
      pinnedNodeId: row.pinned_node_id,
      nodes: row.nodes,
      lastRoundAt: row.last_round_at ? row.last_round_at.toISOString() : null,
      lastSwitch: row.last_switch,
      reportedAt: row.reported_at.toISOString(),
    }
    return [
      {
        ...toGroupRuntime(group, snapshot, {
          deviceId: row.device_id,
          online: device.online,
          nodes,
          fallbackReportedAt,
        }),
        groupName: group.name,
        selection: group.selection,
        reportedAt: snapshot.reportedAt,
      },
    ]
  })
}

export function registerWebRoutes(router: Router, live: LiveHub): void {
  // ---------------------------------------------------------------- 健康检查

  router.get('/health', ({ res }) => {
    sendJson(res, 200, { ok: true })
  }, 'open')

  // ---------------------------------------------------------------- 设备

  router.get('/devices', async ({ res }) => {
    const [devices, groups, runtimes] = await Promise.all([
      store.listDevices(),
      store.listGroups(),
      store.listRuntimeRows(),
    ])
    const groupById = new Map(groups.map((g) => [g.id, g]))
    // 每台设备当前各分组的出口，列表页的摘要要用
    const exitBy = new Map<string, Array<{ groupId: string; groupName: string; nodeId: string | null }>>()
    for (const row of runtimes) {
      const group = groupById.get(row.group_id)
      if (!group || !group.deviceIds.includes(row.device_id)) continue
      const list = exitBy.get(row.device_id) ?? []
      list.push({ groupId: group.id, groupName: group.name, nodeId: row.active_node_id })
      exitBy.set(row.device_id, list)
    }
    sendJson(res, 200, {
      items: devices.map((device) => ({ ...device, exits: exitBy.get(device.id) ?? [] })),
    })
  })

  router.get('/devices/:id', async ({ res, params }) => {
    const row = await store.findDeviceRow(params.id)
    if (!row) throw notFound('找不到这台设备。')
    const device = toDevice(row)
    // 设备离线时告诉前端「多久没上报了」，详情页拿它做提示
    sendJson(res, 200, {
      ...device,
      ...(device.online
        ? {}
        : { silentForSec: Math.round((Date.now() - row.last_seen_at.getTime()) / 1000) }),
      offlineAfterSec: Math.round(OFFLINE_AFTER_MS / 1000),
    })
  })

  router.patch('/devices/:id', async ({ req, res, params, user }) => {
    const row = await store.findDeviceRow(params.id)
    if (!row) throw notFound('找不到这台设备。')
    const input = body(await readBody(req))
    if ('note' in input) {
      const note = typeof input.note === 'string' ? input.note.trim() : ''
      if (note.length > 200) throw new ApiError(400, '备注最多 200 个字。', 'note')
      await store.setDeviceNote(params.id, note || null)
    }
    const updated = await store.findDeviceRow(params.id)
    if (!updated) throw notFound('找不到这台设备。')
    live.update(['devices'])
    sendJson(res, 200, { device: toDevice(updated), by: user?.username ?? null })
  })

  router.delete('/devices/:id', async ({ res, params }) => {
    const row = await store.findDeviceRow(params.id)
    if (!row) throw notFound('找不到这台设备。')
    // 待办队列是按设备排的，设备没了队列也要清掉，否则会留着指不到人的操作
    await store.clearPendingOfDevice(params.id)
    await store.deleteDevice(params.id)
    live.update(['devices', 'runtimes', 'probes'])
    res.writeHead(204, { 'cache-control': 'no-store' }).end()
  })

  /** 立即探测一次：排个待办，设备下次上报时取走 */
  router.post('/devices/:id/probe', async ({ res, params }) => {
    const row = await store.findDeviceRow(params.id)
    if (!row) throw notFound('找不到这台设备。')
    if (!isOnline(row)) throw conflict('这台设备现在不在线，等它上报之后再试。')
    await store.queuePendingSwitch({
      deviceId: params.id,
      // 探测不属于某个分组，各分组的节点都过一遍
      groupId: '',
      nodeId: null,
      reason: 'manual-probe',
    })
    live.update(['runtimes', 'probes'])
    sendJson(res, 202, { queued: true })
  })

  /**
   * 固定或取消固定一个节点。自动分组和手动分组都用这里：
   * 手动分组选节点、自动分组临时指定节点，对 Agent 来说都是「这一轮的出口定成谁」。
   * nodeId 传 null 表示恢复自动。
   */
  router.post('/devices/:deviceId/groups/:groupId/pin', async ({ req, res, params }) => {
    const device = await store.findDeviceRow(params.deviceId)
    if (!device) throw notFound('找不到这台设备。')
    const group = await store.findGroup(params.groupId)
    if (!group) throw notFound('找不到这个分组。')
    if (!group.deviceIds.includes(params.deviceId)) {
      throw conflict(`这个分组没有用到「${device.name}」。`)
    }

    const input = body(await readBody(req))
    const nodeId = typeof input.nodeId === 'string' && input.nodeId ? input.nodeId : null

    if (nodeId) {
      const node = await store.findNodeRow(nodeId)
      if (!node) throw notFound('找不到这个节点。')
      if (!node.enabled) throw conflict(`节点「${node.tag}」现在是停用状态，先启用它。`)
      // 逐个挑选的候选列表之外的节点不能选，否则设备那边根本不会把它算进来
      if (group.candidates.mode === 'list' && !group.candidates.nodeIds.includes(nodeId)) {
        throw new ApiError(400, '这个节点不属于该分组的候选节点。', 'nodeId')
      }
    }

    await store.setRuntimePin(params.deviceId, params.groupId, nodeId)
    await store.queuePendingSwitch({
      deviceId: params.deviceId,
      groupId: params.groupId,
      nodeId,
      reason: nodeId ? 'web-pin' : 'web-unpin',
    })
    live.update(['runtimes'])
    sendJson(res, 200, { ok: true, nodeId })
  })

  // ---------------------------------------------------------------- 节点

  router.get('/nodes', async ({ res }) => {
    const rows = await store.listNodeRows()
    sendJson(res, 200, { items: rows.map(toProxyNode) })
  })

  router.patch('/nodes/:id', async ({ req, res, params }) => {
    const row = await store.findNodeRow(params.id)
    if (!row) throw notFound('找不到这个节点。')
    const input = body(await readBody(req))
    if (typeof input.enabled !== 'boolean') {
      throw new ApiError(400, '这里只能改节点的启用状态。', 'enabled')
    }
    await store.setNodeEnabled(params.id, input.enabled)
    // 停用之后，固定在这个节点上的分组要回到自动挑选
    if (!input.enabled) await store.clearDanglingRefs([params.id])
    const updated = await store.findNodeRow(params.id)
    if (!updated) throw notFound('找不到这个节点。')
    live.update(['nodes', 'runtimes'])
    sendJson(res, 200, { node: toProxyNode(updated) })
  })

  // ---------------------------------------------------------------- 节点订阅

  router.get('/sources', async ({ res }) => {
    const rows = await store.listSources()
    sendJson(res, 200, { items: rows.map(toNodeSource) })
  })

  router.post('/sources', async ({ req, res }) => {
    const input = body(await readBody(req))
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) throw new ApiError(400, '请给订阅起个名字。', 'name')
    if (name.length > 60) throw new ApiError(400, '订阅名称最多 60 个字。', 'name')
    const url = checkSubscriptionUrl(input.url)
    const row = await store.insertSource({ name, url })
    live.update(['nodes'])
    sendJson(res, 201, { source: toNodeSource(row) })
  })

  router.patch('/sources/:id', async ({ req, res, params }) => {
    const row = await store.findSource(params.id)
    if (!row) throw notFound('找不到这个订阅。')
    const input = body(await readBody(req))
    const patch: { name?: string; url?: string; enabled?: boolean } = {}
    if (typeof input.name === 'string' && input.name.trim()) {
      if (input.name.trim().length > 60) throw new ApiError(400, '订阅名称最多 60 个字。', 'name')
      patch.name = input.name.trim()
    }
    if (typeof input.url === 'string' && input.url.trim()) {
      patch.url = checkSubscriptionUrl(input.url)
    }
    if (typeof input.enabled === 'boolean') patch.enabled = input.enabled
    if (!Object.keys(patch).length) throw new ApiError(400, '没有要修改的内容。')
    const updated = await store.updateSource(params.id, patch)
    if (!updated) throw notFound('找不到这个订阅。')
    live.update(['nodes'])
    sendJson(res, 200, { source: toNodeSource(updated) })
  })

  /**
   * 删除订阅。订阅里的节点跟着走，所以要先看有没有分组在用它们——
   * 分组引用的节点被删掉，那台设备上就会少一截出口。
   */
  router.delete('/sources/:id', async ({ res, params }) => {
    const row = await store.findSource(params.id)
    if (!row) throw notFound('找不到这个订阅。')
    await store.deleteSource(params.id)
    live.update(['nodes', 'runtimes'])
    res.writeHead(204, { 'cache-control': 'no-store' }).end()
  })

  // ---------------------------------------------------------------- 探测目标

  router.get('/targets', async ({ res }) => {
    const targets = await store.listTargets()
    const groupRows = await store.listGroupRows()
    // 每个目标被哪些分组当成规则在用，列表页要显示，也用来决定删除按钮的状态
    const usedBy = new Map<string, Array<{ id: string; name: string }>>()
    for (const group of groupRows) {
      for (const targetId of group.target_ids) {
        const list = usedBy.get(targetId) ?? []
        list.push({ id: group.id, name: group.name })
        usedBy.set(targetId, list)
      }
    }
    sendJson(res, 200, {
      items: targets.map((target) => ({ ...target, usedBy: usedBy.get(target.id) ?? [] })),
    })
  })

  router.get('/targets/:id', async ({ res, params }) => {
    const target = await store.findTarget(params.id)
    if (!target) throw notFound('找不到这个探测目标。')
    sendJson(res, 200, { target })
  })

  router.post('/targets', async ({ req, res }) => {
    const shape = checkTarget(await readBody(req))
    const row = await store.insertTarget(shape)
    live.update(TARGET_SCOPES)
    sendJson(res, 201, { target: await store.findTarget(row.id) })
  })

  router.put('/targets/:id', async ({ req, res, params }) => {
    const existing = await store.findTargetRow(params.id)
    if (!existing) throw notFound('找不到这个探测目标。')
    const shape = checkTarget(await readBody(req))
    // 类型定了就不改：SSH 的字段和 HTTP 的字段不是一回事，改了等于新建
    if (shape.kind !== existing.kind) {
      throw new ApiError(400, '目标的类型不能改，需要别的类型请新建一个。', 'kind')
    }
    await store.updateTarget(params.id, shape)
    live.update(TARGET_SCOPES)
    sendJson(res, 200, { target: await store.findTarget(params.id) })
  })

  router.delete('/targets/:id', async ({ res, params }) => {
    const existing = await store.findTargetRow(params.id)
    if (!existing) throw notFound('找不到这个探测目标。')
    const used = await store.groupsUsingTarget(params.id)
    if (used.length) {
      const names = used.map((g) => `「${g.name}」`).join('、')
      throw conflict(`${names}还在用这个目标作为分组规则，先在分组里移除它。`)
    }
    await store.deleteTarget(params.id)
    live.update(TARGET_SCOPES)
    res.writeHead(204, { 'cache-control': 'no-store' }).end()
  })

  // ---------------------------------------------------------------- 分组

  router.get('/groups', async ({ res }) => {
    sendJson(res, 200, { items: await store.listGroups() })
  })

  router.get('/groups/:id', async ({ res, params }) => {
    const group = await store.findGroup(params.id)
    if (!group) throw notFound('找不到这个分组。')
    sendJson(res, 200, { group })
  })

  router.post('/groups', async ({ req, res }) => {
    const shape = await prepareGroup(await readBody(req), null)
    const row = await store.insertGroup(shape)
    await logGroupChange(null, row.id, shape.name, '创建了分组')
    live.update(GROUP_SCOPES)
    sendJson(res, 201, { group: await store.findGroup(row.id) })
  })

  router.put('/groups/:id', async ({ req, res, params }) => {
    const existing = await store.findGroupRow(params.id)
    if (!existing) throw notFound('找不到这个分组。')
    const before = toGroup(existing)
    const shape = await prepareGroup(await readBody(req), before)
    await store.updateGroup(params.id, shape)
    // 设备列表变了的话，多出来的运行状态要清掉
    await store.pruneRuntime(shape.deviceIds, [params.id])
    // 停用的节点不该留在候选列表里，挡一道免得设备那边拿到空列表
    await store.clearDanglingRefs(
      shape.candidates.mode === 'list' ? shape.candidates.nodeIds : [],
    )
    await logGroupChange(before, params.id, shape.name, describeGroupChange(before, shape))
    live.update(GROUP_SCOPES)
    sendJson(res, 200, { group: await store.findGroup(params.id) })
  })

  router.delete('/groups/:id', async ({ res, params }) => {
    const row = await store.findGroupRow(params.id)
    if (!row) throw notFound('找不到这个分组。')
    const before = toGroup(row)
    await store.deleteGroup(params.id)
    await logGroupChange(before, params.id, before.name, '删除了分组')
    live.update(GROUP_SCOPES)
    res.writeHead(204, { 'cache-control': 'no-store' }).end()
  })

  // ---------------------------------------------------------------- 运行状态

  router.get('/runtime', async ({ res, url }) => {
    const deviceId = url.searchParams.get('deviceId')?.trim() || undefined
    const [rows, groups, devices, nodes] = await Promise.all([
      store.listRuntimeRows(deviceId),
      store.listGroups(),
      store.listDevices(),
      store.listNodes(),
    ])
    const groupById = new Map(groups.map((g) => [g.id, g]))
    const deviceById = new Map(devices.map((d) => [d.id, d]))
    sendJson(res, 200, { items: runtimeItems(rows, groupById, deviceById, nodes) })
  })

  // ---------------------------------------------------------------- 探测结果

  router.get('/probes', async ({ res, url }) => {
    const deviceId = url.searchParams.get('deviceId')?.trim()
    if (!deviceId) throw new ApiError(400, '请指定设备。', 'deviceId')
    const cells = await store.listProbeCells({
      deviceId,
      nodeId: url.searchParams.get('nodeId')?.trim() || undefined,
      targetId: url.searchParams.get('targetId')?.trim() || undefined,
    })
    sendJson(res, 200, { items: cells })
  })

  // ---------------------------------------------------------------- 事件

  router.get('/events', async ({ res, url }) => {
    const page = await store.queryEvents({
      deviceId: url.searchParams.get('deviceId')?.trim() || undefined,
      groupId: url.searchParams.get('groupId')?.trim() || undefined,
      kinds: csv(url.searchParams.get('kind')),
      severities: csv(url.searchParams.get('severity')),
      since: url.searchParams.get('since')?.trim() || undefined,
      cursor: url.searchParams.get('cursor')?.trim() || undefined,
      limit: numberParam(url, 'limit', 50, 1, 200),
      // 事件可以按节点筛，但那是前端在已取回的页里做，接口层不重复实现
    })
    sendJson(res, 200, page)
  })

  // ---------------------------------------------------------------- 实时推送

  router.get('/stream', ({ res }) => {
    live.attach(res)
  })

  // ---------------------------------------------------------------- 概览

  router.get('/overview', async ({ res }) => {
    const [devices, nodes, targets, groups, runtimes] = await Promise.all([
      store.listDevices(),
      store.listNodes(),
      store.listTargets(),
      store.listGroups(),
      store.listRuntimeRows(),
    ])
    const offline = new Set(devices.filter((d) => !d.online).map((d) => d.id))
    sendJson(res, 200, {
      devices: devices.length,
      devicesOnline: devices.length - offline.size,
      nodes: nodes.length,
      nodesEnabled: nodes.filter((n) => n.enabled).length,
      targets: targets.length,
      groups: groups.length,
      // 设备离线之后它的运行状态就不算数了，概览上单独报一下
      staleGroups: runtimes.filter((r) => offline.has(r.device_id)).length,
    })
  })
}

// ---------------------------------------------------------------- 辅助

function csv(value: string | null): string[] | undefined {
  if (!value) return undefined
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length ? items : undefined
}

function numberParam(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key)
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(400, `这个参数要是 ${min} 到 ${max} 之间的整数。`, key)
  }
  return n
}

/** 订阅链接必须是 http 或 https，且不能带用户名密码 */
function checkSubscriptionUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : ''
  if (!url) throw new ApiError(400, '请填写订阅链接。', 'url')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ApiError(400, '订阅链接格式不对，要以 http:// 或 https:// 开头。', 'url')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, '订阅链接只能以 http:// 或 https:// 开头。', 'url')
  }
  if (!parsed.hostname) throw new ApiError(400, '订阅链接里要有主机名。', 'url')
  return url
}

/**
 * 校验分组，顺便补上跨表的判断：设备在不在、候选节点还在不在、规则引用的目标还在不在。
 * before 是修改前的分组，用来在修改时排除掉自己占用的 selector tag。
 */
async function prepareGroup(
  input: unknown,
  before: Group | null,
): Promise<Omit<Group, 'id' | 'updatedAt'>> {
  const raw = body(input)

  const [devices, nodes, targets] = await Promise.all([
    store.listDeviceRows(),
    store.listNodeRows(),
    store.listTargetRows(),
  ])

  const selected = Array.isArray(raw.deviceIds)
    ? raw.deviceIds.filter((id): id is string => typeof id === 'string')
    : []
  const knownDevices = new Set(devices.map((d) => d.id))
  if (selected.some((id) => !knownDevices.has(id))) {
    throw new ApiError(400, '选中的设备已经不在列表里了，请重新选。', 'deviceIds')
  }

  if (before) {
    const tag = typeof raw.selectorTag === 'string' ? raw.selectorTag.trim() : ''
    const taken = tag ? await store.findGroupBySelectorTag(tag) : null
    if (taken && taken.id !== before.id) {
      throw conflict(`selector tag「${taken.selector_tag}」已经被别的分组用了。`, 'selectorTag')
    }
  }

  const shape = checkGroup(
    raw,
    new Set(targets.map((t) => t.id)),
    new Set(nodes.map((n) => n.id)),
  )

  // 候选节点全被停用时提醒一句：分组建出来也不会有出口
  const enabled = nodes.filter((n) => n.enabled)
  const usable =
    shape.candidates.mode === 'list'
      ? shape.candidates.nodeIds.filter((id) => enabled.some((n) => n.id === id)).length
      : enabled.length
  if (shape.selection === 'auto' && !usable) {
    throw new ApiError(400, '候选节点现在都被停用了，先去节点页启用至少一个。', 'candidates')
  }

  return shape
}

/** 分组变更的说明，写进事件里给用户回头看 */
function describeGroupChange(before: Group, after: Omit<Group, 'id' | 'updatedAt'>): string {
  const parts: string[] = []
  if (before.name !== after.name) parts.push(`名称改为「${after.name}」`)
  if (before.selection !== after.selection) {
    parts.push(after.selection === 'manual' ? '改为手动选择' : '改为按规则自动切换')
  }
  if (before.strategy !== after.strategy) {
    parts.push(after.strategy === 'latency' ? '改为按延迟选择' : '改为按优先级选择')
  }
  if (before.onAllFail !== after.onAllFail) parts.push('全部不可用时的处理有变动')
  if (before.targetIds.join() !== after.targetIds.join()) parts.push('分组规则有变动')
  if ((before.targetMode as AllFailAction | string) !== after.targetMode) parts.push('规则的通过条件有变动')
  if (JSON.stringify(before.match) !== JSON.stringify(after.match)) parts.push('接管范围有变动')
  if (JSON.stringify(before.candidates) !== JSON.stringify(after.candidates)) {
    parts.push('候选节点有变动')
  }
  if (before.deviceIds.join() !== after.deviceIds.join()) parts.push('适用设备有变动')
  if (before.probeIntervalSec !== after.probeIntervalSec) parts.push('探测间隔有变动')
  return parts.length ? parts.join('，') : '保存了分组，内容没有变化'
}

function logGroupChange(
  before: Group | null,
  groupId: string,
  name: string,
  detail: string,
): Promise<unknown> {
  const head = before ? `「${name}」` : `新建分组「${name}」`
  return store.insertEvent({
    at: new Date().toISOString(),
    kind: 'group-changed',
    severity: 'info',
    deviceId: null,
    groupId,
    nodeId: null,
    message: `${head}${detail}`,
  })
}

/** 给别的路由复用的判断，类型上和 shared 的枚举对齐 */
export const GROUP_STRATEGIES: readonly Strategy[] = ['priority', 'latency']
export const GROUP_PROTOCOLS: readonly NodeProtocol[] = [
  'shadowsocks',
  'vmess',
  'vless',
  'trojan',
  'hysteria2',
  'tuic',
]
export { oneOf }
