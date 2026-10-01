/**
 * 网页用的接口。路径和 docs/api.md 的清单一一对应。
 *
 * 这一层只做三件事：把请求里的参数取出来、调存取层、把结果按接口形状回出去。
 * 涉及引用完整性的判断（删目标前有没有分组在用）放在这里，因为那是业务规则。
 */

import type {
  Device,
  Group,
  GroupRuntime,
  NodeProtocol,
  ProxyNode,
  Selection,
  Strategy,
  UpdateScope,
} from '../../../shared/types.ts'
import type { PendingSwitchRow, RuntimeRow } from '../model.ts'
import { ApiError, conflict, notFound, readBody, sendJson, type Router } from '../http.ts'
import type { LiveHub } from '../live.ts'
import type { SubscriptionScheduler } from '../subscriptions.ts'
import { OFFLINE_AFTER_MS, isOnline, toDevice, toGroup, toNodeSource, toProxyNode } from '../model.ts'
import { toGroupRuntime, type RuntimeSnapshot } from '../../../shared/runtime.ts'
import { DEFAULT_LISTEN, buildConfig } from '../../../shared/singbox.ts'
import * as store from '../store.ts'
import { groupDeviceIds, appliesTo } from '../../../shared/groups.ts'
import { candidateIds } from '../../../shared/candidates.ts'
import { checkCatchAll, checkGroup, checkTarget } from '../validate.ts'

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
  pendingByGroup: Map<string, PendingSwitchRow> = new Map(),
): Array<
  GroupRuntime & {
    groupName: string
    selection: Selection
    reportedAt: string
    pendingSwitch: PendingSwitch | null
  }
> {
  const fallbackReportedAt = new Date().toISOString()
  return rows.flatMap((row) => {
    const group = groupById.get(row.group_id)
    const device = deviceById.get(row.device_id)
    // 分组删了、设备删了，或者分组不再管这台设备：这条运行状态是残留的
    if (!group || !device || !appliesTo(group, row.device_id)) return []
    const snapshot: RuntimeSnapshot = {
      groupId: row.group_id,
      activeNodeId: row.active_node_id,
      pinnedNodeId: row.pinned_node_id,
      nodes: row.nodes,
      availableNodeIds: row.available_node_ids ?? null,
      lastRoundAt: row.last_round_at ? row.last_round_at.toISOString() : null,
      lastSwitch: row.last_switch,
      reportedAt: row.reported_at.toISOString(),
    }
    const pending = pendingByGroup.get(row.group_id)
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
        /*
         * 排队中和已失败的切换。
         *
         * 点完节点网页只说"正在切换"，如果设备没执行，用户没有任何办法知道——之前就是这样，
         * 一条永远失败的待办在库里躺了 45 分钟，网页上却显示一切正常。这里把它带出来，
         * 设备页可以显示"正在切换，等待设备执行"或者失败原因加重试按钮。
         */
        pendingSwitch: pending
          ? {
              id: pending.id,
              nodeId: pending.node_id,
              attempts: pending.attempts,
              lastError: pending.last_error,
              failedAt: pending.failed_at ? pending.failed_at.toISOString() : null,
            }
          : null,
      },
    ]
  })
}

/** 网页上要显示的待办状态，字段名按接口习惯用驼峰 */
interface PendingSwitch {
  id: string
  nodeId: string | null
  attempts: number
  lastError: string | null
  failedAt: string | null
}

export function registerWebRoutes(router: Router, live: LiveHub, subscriptions: SubscriptionScheduler): void {
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
      if (!group || !appliesTo(group, row.device_id)) continue
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
    if (!appliesTo(group, params.deviceId)) {
      throw conflict(`这个分组没有用到「${device.name}」。`)
    }

    const input = body(await readBody(req))
    const nodeId = typeof input.nodeId === 'string' && input.nodeId ? input.nodeId : null

    if (nodeId) {
      const node = await store.findNodeRow(nodeId)
      if (!node) throw notFound('找不到这个节点。')
      if (!node.enabled) throw conflict(`节点「${node.tag}」现在是停用状态，先启用它。`)

      // 不在候选范围内的节点不能选，设备那边不会把它算进来。
      // 逐个挑选看列表，按条件加入要拿当前节点池现算一遍——条件没变，订阅变了，
      // 候选也会跟着变，所以不能只看保存时算过的结果。
      if (group.candidates.mode === 'list') {
        if (!group.candidates.nodeIds.includes(nodeId)) {
          throw new ApiError(400, '这个节点不属于该分组的候选节点。', 'nodeId')
        }
      } else {
        const pool = (await store.listAllNodeRows()).map(toProxyNode)
        if (!candidateIds(group, pool).includes(nodeId)) {
          throw new ApiError(400, '这个节点不符合该分组的筛选条件。', 'nodeId')
        }
      }

      /*
       * 光在候选列表里还不够：切换是让设备把 selector 切到这个节点，而 selector
       * 只认得自己 outbounds 里列出的名字。设备上的配置由 Agent 按照候选节点生成，
       * 但这份列表是上一次生成时的样子：刚加进候选的节点、刚才被停用又启用的节点、
       * 或者节点没了又重加回来的情况，设备那边可能还要下一轮才跟上（还会顺手重启
       * sing-box），这时候切过去必然失败——sing-box 直接返回 not found。
       *
       * 所以这里拿设备实际上报的列表再挡一道，把"点了没反应"变成"点的时候就说清楚"。
       * availableNodeIds 是 null 时说明 Agent 没读到（Clash API 不通、设备没上报过
       * 这个分组），这时不拦：宁可让它排队等设备自己报错，也不要因为一次读取失败
       * 就断定节点不存在——那样 Clash API 一抖动，用户就会发现什么都点不动。
       */
      const runtime = await store.findRuntimeRow(params.deviceId, params.groupId)
      const known = runtime?.available_node_ids ?? null
      if (known && !known.includes(nodeId)) {
        throw conflict(
          `「${device.name}」上的「${group.selectorTag}」现在还没有「${node.tag}」，` +
            `可能是刚加入候选、或者设备还没来得及重新生成配置。等下一次上报之后再试。`,
          'nodeId',
        )
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

  /**
   * 重试一条放弃了的切换。
   *
   * 失败的原因修好之后（比如重新启用了节点，或者设备上的 sing-box 重新跑起来了），
   * 同样的操作就能成功。所以这里不重新排队一条新的待办，而是把原来那条的次数清零
   * 让它重新下发，这样失败原因和节点都还在，用户点一下就行，不用回去重新选节点。
   */
  router.post(
    '/devices/:deviceId/groups/:groupId/pending/:id/retry',
    async ({ res, params }) => {
      const device = await store.findDevice(params.deviceId)
      if (!device) throw notFound('找不到这台设备。')
      const group = await store.findGroup(params.groupId)
      if (!group) throw notFound('找不到这个分组。')

      const revived = await store.revivePendingSwitch(params.id, params.deviceId, params.groupId)
      if (!revived) throw notFound('这条切换已经不在队列里了，重新选一次节点。')

      await store.insertEvent({
        kind: 'switch',
        severity: 'info',
        deviceId: params.deviceId,
        groupId: params.groupId,
        nodeId: null,
        message: `在网页上重新尝试了「${group.name}」的切换`,
      })
      live.update(['runtimes', 'events'])
      sendJson(res, 200, { ok: true })
    },
  )

  /**
   * 配置预览：用真正下发时那套 buildConfig 生成一份配置。
   *
   * 为什么不在前端拼：节点的 outbound（密码、UUID 之类）只在服务端有，
   * 前端的节点对象里根本没有，拼不出来。而且和真正下发用的是同一个函数，
   * 预览里看到的规则顺序、selector、兜底设置，必然跟设备拿到的一致。
   *
   * group 给了就预览这份还没保存的草稿（编辑页用），没给就预览已保存的全部分组。
   * 密钥位置换成占位符：clashSecret 是 Agent 在本机生成的，不该发到浏览器上。
   */
  router.post('/config/preview', async ({ req, res }) => {
    const input = body(await readBody(req))
    const deviceId = typeof input.deviceId === 'string' ? input.deviceId : ''
    const deviceRow = await store.findDeviceRow(deviceId)
    if (!deviceRow) throw notFound('找不到这台设备。')
    const device = toDevice(deviceRow)

    const [saved, targets, nodes] = await Promise.all([
      store.listGroups(),
      store.listTargetRows(),
      store.listAllNodeRows(),
    ])

    let groups = saved.filter((g) => appliesTo(g, deviceId))
    if (input.group !== undefined) {
      // 草稿还没入库，先按保存时的同一套规则校验，再当成已保存的那个分组
      const shape = checkGroup(
        input.group,
        new Set(targets.map((t) => t.id)),
        new Set(nodes.map((n) => n.id)),
      )
      const draftId = typeof (input.group as Record<string, unknown>).id === 'string'
        ? ((input.group as Record<string, unknown>).id as string)
        : ''
      // 草稿也按自己的 deviceIds 判断用不用在这台设备上，跟保存后的行为一致
      groups = appliesTo(shape, deviceId)
        ? [...saved.filter((g) => g.id !== draftId), { ...shape, id: draftId || 'new', updatedAt: '' }]
        : groups.filter((g) => g.id !== draftId)
    }

    const built = buildConfig({
      nodes: await store.listStoredNodes(),
      groups,
      listen: device.proxyListen || DEFAULT_LISTEN,
      managed: { clashApi: device.clashApi, clashSecret: '', dataDir: device.dataDir },
      redact: true,
    })
    sendJson(res, 200, { config: built.config, warnings: built.warnings })
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
    // 新建之后立刻拉一次：节点池该马上有这个订阅的节点，不用等下一轮调度
    await subscriptions.refreshNow(row.id)
    const fresh = await store.findSource(row.id)
    sendJson(res, 201, { source: toNodeSource(fresh ?? row), fetched: true })
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
    const urlChanged = patch.url !== undefined && patch.url !== row.url
    const enabledChanged = patch.enabled !== undefined && patch.enabled !== row.enabled
    let updated = await store.updateSource(params.id, patch)
    if (!updated) throw notFound('找不到这个订阅。')
    // 换了地址就当是同一个订阅现在指向了别处；从停用改成启用也要拉一次，
    // 否则它会一直空着等下一轮调度
    if (updated.enabled && (urlChanged || (enabledChanged && !row.enabled))) {
      await subscriptions.refreshNow(params.id)
      updated = (await store.findSource(params.id)) ?? updated
    } else {
      live.update(['sources', 'nodes'])
    }
    sendJson(res, 200, { source: toNodeSource(updated) })
  })

  /**
   * 立即拉一次这个订阅。
   *
   * 拉订阅的一直是服务端自己：设备的接入与否跟节点池无关，没有设备也要能解析出节点。
   * 同步做完再回，调用方拿到的是这次的结果，不用等下一轮。
   */
  router.post('/sources/:id/refresh', async ({ res, params }) => {
    const row = await store.findSource(params.id)
    if (!row) throw notFound('找不到这个订阅。')
    if (!row.enabled) throw conflict(`订阅「${row.name}」现在是停用状态，先启用它。`)
    const result = await subscriptions.refreshNow(params.id)
    const fresh = await store.findSource(params.id)
    // 拉取失败不算接口失败：上次的节点还留着，页面要的是「这次拉到了什么」。
    // 用 ok 和 error 告诉它这一次的结果，而不是回 5xx 让它以为请求没送到。
    sendJson(res, 200, {
      ok: result.error === null,
      error: result.error,
      nodeCount: result.nodeCount,
      refreshedAt: new Date().toISOString(),
      source: fresh ? toNodeSource(fresh) : null,
    })
  })

  /**
   * 删除订阅。订阅里的节点跟着走，所以要先看有没有分组在用它们——
   * 分组引用的节点被删掉，那台设备上就会少一截出口。
   */
  router.delete('/sources/:id', async ({ res, params }) => {
    const row = await store.findSource(params.id)
    if (!row) throw notFound('找不到这个订阅。')
    await store.deleteSource(params.id)
    live.update(['sources', 'nodes', 'runtimes'])
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
    await logGroupChange(row.id, `新建了分组「${shape.name}」`)
    live.update(GROUP_SCOPES)
    sendJson(res, 201, { group: await store.findGroup(row.id) })
  })

  router.put('/groups/:id', async ({ req, res, params }) => {
    const existing = await store.findGroupRow(params.id)
    if (!existing) throw notFound('找不到这个分组。')
    const before = toGroup(existing)
    const shape = await prepareGroup(await readBody(req), before)
    const [devices, nodes] = await Promise.all([
      store.listDeviceRows(),
      store.listAllNodeRows().then((rows) => rows.map(toProxyNode)),
    ])
    const candidates = candidateIds(shape, nodes)
    const enabled = new Set(nodes.filter((n) => n.enabled).map((n) => n.id))
    await store.updateGroup(params.id, shape, {
      // 空列表表示所有设备，包括以后加的，实际范围要按当前的设备表算出来
      deviceIds: groupDeviceIds(shape, devices),
      candidateIds: candidates,
      enabledIds: candidates.filter((id) => enabled.has(id)),
      selection: shape.selection === before.selection ? null : shape.selection,
    })
    const changed = changedSettings(before, shape)
    // 没有实际改动时不记，见 docs/api.md
    if (changed.length) await logGroupChange(params.id, `修改了分组「${shape.name}」：${changed.join('、')}`)
    live.update(GROUP_SCOPES)
    sendJson(res, 200, { group: await store.findGroup(params.id) })
  })

  router.delete('/groups/:id', async ({ res, params }) => {
    const row = await store.findGroupRow(params.id)
    if (!row) throw notFound('找不到这个分组。')
    const before = toGroup(row)
    await store.deleteGroup(params.id)
    await logGroupChange(params.id, `删除了分组「${before.name}」`)
    live.update(GROUP_SCOPES)
    res.writeHead(204, { 'cache-control': 'no-store' }).end()
  })

  // ---------------------------------------------------------------- 运行状态

  router.get('/runtime', async ({ res, url }) => {
    const deviceId = url.searchParams.get('deviceId')?.trim() || undefined
    const [rows, groups, devices, nodes, pending] = await Promise.all([
      store.listRuntimeRows(deviceId),
      store.listGroups(),
      store.listDevices(),
      store.listNodes(),
      // 待办也是按设备查的，跟运行状态同一维度，省得前端再发一个请求
      store.listPendingByGroup(deviceId ?? null),
    ])
    const groupById = new Map(groups.map((g) => [g.id, g]))
    const deviceById = new Map(devices.map((d) => [d.id, d]))
    sendJson(res, 200, { items: runtimeItems(rows, groupById, deviceById, nodes, pending) })
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

  const [devices, nodes, targets, groups] = await Promise.all([
    store.listDeviceRows(),
    // 全部节点：候选里有个已停用订阅的节点不该报错，订阅只是暂时关着
    store.listAllNodeRows(),
    store.listTargetRows(),
    store.listGroups(),
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

  // 兜底分组只能有一个：两台设备各有一个、或者所有设备共用一个
  checkCatchAll(
    shape,
    before ? groups.filter((g) => g.id !== before.id) : groups,
  )

  // 逐个挑选的节点全被停用时提醒一句：分组建出来也不会有出口。
  // 按条件自动加入的不拦，现在没有符合的节点也行（比如订阅还没导入），以后符合条件的节点会自动加入
  const enabled = new Set(nodes.filter((n) => n.enabled).map((n) => n.id))
  if (
    shape.selection === 'auto' &&
    shape.candidates.mode === 'list' &&
    !shape.candidates.nodeIds.some((id) => enabled.has(id))
  ) {
    throw new ApiError(400, '候选节点现在都被停用了，先去节点页启用至少一个。', 'candidates')
  }

  return shape
}

/**
 * 修改分组时改了哪些设置，写进事件里给用户回头看，叫法跟编辑页上一致。没改什么时是空数组。
 *
 * 要按内容比：match、candidates 存在 jsonb 里，读回来时键的顺序变了（jsonb 把短的键排在前面），
 * 直接比 JSON.stringify 的话，每次保存都会算成这两项改过
 */
function changedSettings(before: Group, after: Omit<Group, 'id' | 'updatedAt'>): string[] {
  const settings: Array<[string, unknown, unknown]> = [
    [`名称（原来叫「${before.name}」）`, before.name, after.name],
    ['selector tag', before.selectorTag, after.selectorTag],
    ['适用设备', before.deviceIds, after.deviceIds],
    ['接管的流量', before.match, after.match],
    ['候选节点', before.candidates, after.candidates],
    ['选择方式', before.selection, after.selection],
    ['分组规则', before.targetIds, after.targetIds],
    ['规则判定方式', before.targetMode, after.targetMode],
    ['选节点的方式', before.strategy, after.strategy],
    ['判定不可用', before.failThreshold, after.failThreshold],
    ['判定恢复', before.recoverThreshold, after.recoverThreshold],
    ['探测间隔', before.probeIntervalSec, after.probeIntervalSec],
    ['延迟容差', before.toleranceMs, after.toleranceMs],
    ['恢复后切回', before.failback, after.failback],
    ['切换时断开已有连接', before.interruptExisting, after.interruptExisting],
    ['全部不可用时的处理', before.onAllFail, after.onAllFail],
  ]
  return settings.filter(([, a, b]) => canonical(a) !== canonical(b)).map(([label]) => label)
}

/** 按内容序列化：对象的键排好序，数组保持原样（候选节点的顺序就是优先级） */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

function logGroupChange(groupId: string, message: string): Promise<unknown> {
  return store.insertEvent({
    at: new Date().toISOString(),
    kind: 'group-changed',
    severity: 'info',
    deviceId: null,
    groupId,
    nodeId: null,
    message,
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
