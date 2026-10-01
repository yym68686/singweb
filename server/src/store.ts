/**
 * 存取层：把数据库的行和接口用的类型互相转换。
 *
 * 路由只调用这里的函数，不直接写 SQL，这样表结构和接口形状的对应关系集中在一个文件里。
 * 所有函数都是无状态的——服务端自己不保存任何东西，请求之间靠数据库。
 */

import { createHash, randomBytes } from 'node:crypto'
import { tokenHash } from './auth.ts'
import { many, newId, one, run, tx } from './db.ts'
import type {
  DeviceRow,
  EnrollTokenRow,
  EventRow,
  GroupRow,
  NodeRow,
  NodeSourceRow,
  PendingSwitchRow,
  PoolNode,
  ProbeRow,
  ReportedEvent,
  ReportedProbe,
  ReportedRuntime,
  RuntimeRow,
  TargetRow,
  UserRow,
} from './model.ts'
import {
  PROBE_HISTORY_MAX,
  toDevice,
  toEvent,
  toGroup,
  toNodeSource,
  toProbeCell,
  toProxyNode,
  toStoredNode,
  toTarget,
} from './model.ts'
import type {
  AppEvent,
  Device,
  Group,
  Platform,
  ProbeCell,
  ProxyNode,
  StoredNode,
  Target,
} from '../../shared/types.ts'

// ---------------------------------------------------------------- 账号和会话

export function findUserByUsername(username: string): Promise<UserRow | null> {
  return one<UserRow>('select * from users where lower(username) = lower($1)', [username])
}

export function findUserById(id: string): Promise<UserRow | null> {
  return one<UserRow>('select * from users where id = $1', [id])
}

export function countUsers(): Promise<number> {
  return one<{ n: string }>('select count(*) as n from users').then((r) => Number(r?.n ?? 0))
}

export function listUsers(): Promise<UserRow[]> {
  return many<UserRow>('select * from users order by created_at')
}

export async function insertUser(row: {
  id: string
  username: string
  passwordHash: string
  role: string
}): Promise<void> {
  await run(
    'insert into users (id, username, password_hash, role) values ($1, $2, $3, $4)',
    [row.id, row.username, row.passwordHash, row.role],
  )
}

export async function updateUserPassword(id: string, passwordHash: string): Promise<void> {
  await run('update users set password_hash = $2 where id = $1', [id, passwordHash])
}

export async function deleteUser(id: string): Promise<void> {
  await run('delete from users where id = $1', [id])
}

/** 建一个会话。传进来的是 token 的散列，原文只在浏览器那边 */
export async function insertSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
  await run('insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)', [
    tokenHash,
    userId,
    expiresAt,
  ])
}

/** 用 token 散列换用户，顺带把过期的会话清掉 */
export async function sessionUser(tokenHash: string): Promise<UserRow | null> {
  return one<UserRow>(
    `select u.* from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash],
  )
}

export async function deleteSession(tokenHash: string): Promise<void> {
  await run('delete from sessions where token_hash = $1', [tokenHash])
}

export async function deleteSessionsOfUser(userId: string): Promise<void> {
  await run('delete from sessions where user_id = $1', [userId])
}

export async function purgeExpiredSessions(): Promise<number> {
  return run('delete from sessions where expires_at <= now()')
}

// ---------------------------------------------------------------- 订阅

export function listSources(): Promise<NodeSourceRow[]> {
  return many<NodeSourceRow>('select * from node_sources order by created_at')
}

export async function findSource(id: string): Promise<NodeSourceRow | null> {
  return one<NodeSourceRow>('select * from node_sources where id = $1', [id])
}

export async function insertSource(row: {
  name: string
  url: string
  enabled?: boolean
}): Promise<NodeSourceRow> {
  const id = newId('src')
  await run('insert into node_sources (id, name, url, enabled) values ($1, $2, $3, $4)', [
    id,
    row.name,
    row.url,
    row.enabled ?? true,
  ])
  const created = await findSource(id)
  if (!created) throw new Error('订阅创建后读不回来')
  return created
}

export async function updateSource(
  id: string,
  patch: { name?: string; url?: string; enabled?: boolean },
): Promise<NodeSourceRow | null> {
  const sets: string[] = []
  const params: unknown[] = [id]
  const add = (column: string, value: unknown) => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  if (patch.name !== undefined) add('name', patch.name)
  if (patch.url !== undefined) add('url', patch.url)
  if (patch.enabled !== undefined) add('enabled', patch.enabled)
  if (!sets.length) return findSource(id)
  await run(`update node_sources set ${sets.join(', ')} where id = $1`, params)
  return findSource(id)
}

/** 记一次拉取的结果 */
export async function recordFetch(
  id: string,
  result: { error: string | null; nodeCount: number },
): Promise<void> {
  await run(
    `update node_sources
        set last_fetched_at = now(), last_error = $2, node_count = $3
      where id = $1`,
    [id, result.error, result.nodeCount],
  )
}

/**
 * 删除订阅。它带来的节点也一起删掉——订阅没了，节点就没有来源了。
 * 手动添加的节点（source_id 为空）不受影响。
 */
export async function deleteSource(id: string): Promise<void> {
  await tx(async (client) => {
    await client.query('delete from nodes where source_id = $1', [id])
    await client.query('delete from node_sources where id = $1', [id])
  })
}

// ---------------------------------------------------------------- 节点

/**
 * 节点池：停用的订阅带来的节点不算在里面。
 *
 * 订阅上的开关靠这里起作用——关掉之后，它的节点不出现在节点页、分组候选、
 * 设备配置和 singweb 订阅链接里。行还留在库里，重新打开不用再拉一遍。
 */
export function listNodeRows(): Promise<NodeRow[]> {
  return many<NodeRow>(
    `select n.* from nodes n
       left join node_sources s on s.id = n.source_id
      where n.source_id is null or s.enabled
      order by n.tag, n.id`,
  )
}

/**
 * 库里的全部节点，包括停用订阅的。校验分组时用它：逐个挑选的候选里有停用订阅的节点
 * 不该报错——订阅只是暂时关了，打开之后这些节点还会回来。
 */
export function listAllNodeRows(): Promise<NodeRow[]> {
  // tag 可能重名（不同订阅里同名的节点），加上 id 让顺序每次都一样
  return many<NodeRow>('select * from nodes order by tag, id')
}

/** 节点在不在节点池里，也就是它所在的订阅有没有停用 */
export async function inPool(id: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    `select n.id from nodes n
       left join node_sources s on s.id = n.source_id
      where n.id = $1 and (n.source_id is null or s.enabled)`,
    [id],
  )
  return row !== null
}

export async function nodeIdsOfSource(sourceId: string): Promise<string[]> {
  const rows = await many<{ id: string }>('select id from nodes where source_id = $1', [sourceId])
  return rows.map((r) => r.id)
}

export async function findNodeRow(id: string): Promise<NodeRow | null> {
  return one<NodeRow>('select * from nodes where id = $1', [id])
}

export async function listNodes(): Promise<ProxyNode[]> {
  const rows = await listNodeRows()
  return rows.map(toProxyNode)
}

export async function listStoredNodes(): Promise<StoredNode[]> {
  const rows = await listNodeRows()
  return rows.map(toStoredNode)
}

/**
 * 界面上显示节点用的 id。tag 有唯一约束之外的可能，所以用单独的 id。
 *
 * identity 是唯一的，但整条太长，这里取它 sha256 的前 20 个十六进制字符，
 * 长度和可读性都跟原来差不多。
 *
 * 早先的写法是 identity.slice(0, 24)，那会让前缀相同的节点撞成一个 id：
 * 同一批机场的落地域名常常只差几个字符（ptxlv6-01.waimaos…、ptxlv6-02.waimaos…），
 * 24 个字符还没走到有区别的那一段，几条节点就一起被覆盖掉了。哈希会把整条
 * identity 都算进去，前缀再怎么像也分得开。
 */
export function nodeIdFor(sourceId: string | null, identity: string): string {
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 20)
  return `${sourceId ? 'sub' : 'cfg'}_${digest}`
}

export async function findNodeByTag(tag: string): Promise<NodeRow | null> {
  return one<NodeRow>('select * from nodes where tag = $1', [tag])
}

export async function setNodeEnabled(id: string, enabled: boolean): Promise<NodeRow | null> {
  await run('update nodes set enabled = $2, updated_at = now() where id = $1', [id, enabled])
  return findNodeRow(id)
}

export async function deleteNodes(ids: string[]): Promise<void> {
  if (!ids.length) return
  await run('delete from nodes where id = any($1)', [ids])
}

/**
 * 把一个订阅拉到的节点写进节点池：按 identity 合并，存在的更新，不存在的插入，
 * 这次没出现的删掉（订阅里已经移除了）。
 *
 * 节点池是所有订阅合在一起的，所以这里还要做两件事：
 * - 去重。同一个节点出现在两个订阅里（同一家机场的两条链接很常见）只留一份，
 *   归先拉到它的订阅。原来那个订阅停用了的话，由这个订阅接手。
 * - tag 在整个池子里唯一。不同订阅常有同名节点（「香港 01」），重名的加序号，
 *   不然节点页、设备页上分不清是哪个。
 *
 * 返回这个订阅名下的节点数，和因为跟别的订阅重复而没有收进来的个数。
 */
export async function syncSourceNodes(
  sourceId: string,
  source: string,
  nodes: PoolNode[],
): Promise<{ owned: number; duplicates: number }> {
  const kept = new Set<string>()
  let duplicates = 0
  let removed: string[] = []
  await tx(async (client) => {
    // 别的订阅（启用中的）已经占下的节点和 tag
    const others = await client.query<{ id: string; tag: string }>(
      `select n.id, n.tag from nodes n
         left join node_sources s on s.id = n.source_id
        where n.source_id is distinct from $1 and (n.source_id is null or s.enabled)`,
      [sourceId],
    )
    const taken = new Set(others.rows.map((r) => r.id))
    const usedTags = new Set(others.rows.map((r) => r.tag))

    for (const node of nodes) {
      // id 只由 identity 决定，两个订阅里的同一个节点会算出同一个 id
      const id = nodeIdFor(sourceId, node.identity)
      if (kept.has(id)) continue
      if (taken.has(id)) {
        duplicates++
        continue
      }
      kept.add(id)
      let tag = node.tag
      for (let i = 2; usedTags.has(tag); i++) tag = `${node.tag} ${i}`
      usedTags.add(tag)
      await client.query(
        `insert into nodes (id, tag, protocol, server, port, region, enabled, source, outbound, source_id, identity, updated_at)
         values ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10, now())
         on conflict (id) do update set
           tag = excluded.tag,
           protocol = excluded.protocol,
           server = excluded.server,
           port = excluded.port,
           region = excluded.region,
           source = excluded.source,
           outbound = excluded.outbound,
           source_id = excluded.source_id,
           identity = excluded.identity,
           updated_at = now()`,
        [
          id,
          tag,
          node.protocol,
          node.server,
          node.port,
          node.region,
          source,
          JSON.stringify({ ...node.outbound, tag }),
          sourceId,
          node.identity,
        ],
      )
    }
    // 订阅里已经没有的节点
    const gone = await client.query<{ id: string }>(
      'delete from nodes where source_id = $1 and not (id = any($2)) returning id',
      [sourceId, [...kept]],
    )
    removed = gone.rows.map((r) => r.id)
  })
  if (removed.length) {
    await clearDanglingRefs(removed)
    await dropProbesOfNodes(removed)
  }
  return { owned: kept.size, duplicates }
}

// ---------------------------------------------------------------- 探测目标

export function listTargetRows(): Promise<TargetRow[]> {
  return many<TargetRow>('select * from targets order by name')
}

export async function listTargets(): Promise<Target[]> {
  const rows = await listTargetRows()
  return rows.map(toTarget)
}

export async function findTargetRow(id: string): Promise<TargetRow | null> {
  return one<TargetRow>('select * from targets where id = $1', [id])
}

export async function findTarget(id: string): Promise<Target | null> {
  const row = await findTargetRow(id)
  return row ? toTarget(row) : null
}

export async function insertTarget(row: {
  name: string
  kind: string
  timeoutMs: number
  note: string | null
  spec: unknown
}): Promise<TargetRow> {
  const id = newId('tgt')
  await run(
    'insert into targets (id, name, kind, timeout_ms, note, spec) values ($1, $2, $3, $4, $5, $6)',
    [id, row.name, row.kind, row.timeoutMs, row.note, JSON.stringify(row.spec)],
  )
  const created = await findTargetRow(id)
  if (!created) throw new Error('目标创建后读不回来')
  return created
}

/** 保存目标。字段变了的话，调用方负责清探测结果 */
export async function updateTarget(
  id: string,
  row: { name: string; timeoutMs: number; note: string | null; spec: unknown },
): Promise<TargetRow | null> {
  await run(
    'update targets set name = $2, timeout_ms = $3, note = $4, spec = $5, updated_at = now() where id = $1',
    [id, row.name, row.timeoutMs, row.note, JSON.stringify(row.spec)],
  )
  return findTargetRow(id)
}

export async function deleteTarget(id: string): Promise<void> {
  await tx(async (client) => {
    await client.query('delete from probes where target_id = $1', [id])
    await client.query('delete from targets where id = $1', [id])
  })
}

/** 哪些分组把它当规则用 */
export async function groupsUsingTarget(id: string): Promise<GroupRow[]> {
  return many<GroupRow>("select * from groups where target_ids ? $1", [id])
}

// ---------------------------------------------------------------- 分组

export function listGroupRows(): Promise<GroupRow[]> {
  return many<GroupRow>('select * from groups order by updated_at, id')
}

export async function listGroups(): Promise<Group[]> {
  const rows = await listGroupRows()
  return rows.map(toGroup)
}

export async function findGroupRow(id: string): Promise<GroupRow | null> {
  return one<GroupRow>('select * from groups where id = $1', [id])
}

export async function findGroup(id: string): Promise<Group | null> {
  const row = await findGroupRow(id)
  return row ? toGroup(row) : null
}

export async function findGroupBySelectorTag(tag: string): Promise<GroupRow | null> {
  return one<GroupRow>('select * from groups where selector_tag = $1', [tag])
}

export async function insertGroup(input: Omit<Group, 'id' | 'updatedAt'>): Promise<GroupRow> {
  const id = newId('grp')
  await run(
    `insert into groups (id, name, selector_tag, device_ids, match, candidates, selection,
                         target_ids, target_mode, strategy, fail_threshold, recover_threshold,
                         probe_interval_sec, tolerance_ms, failback, interrupt_existing, on_all_fail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      id,
      input.name,
      input.selectorTag,
      JSON.stringify(input.deviceIds),
      JSON.stringify(input.match),
      JSON.stringify(input.candidates),
      input.selection,
      JSON.stringify(input.targetIds),
      input.targetMode,
      input.strategy,
      input.failThreshold,
      input.recoverThreshold,
      input.probeIntervalSec,
      input.toleranceMs,
      input.failback,
      input.interruptExisting,
      input.onAllFail,
    ],
  )
  const created = await findGroupRow(id)
  if (!created) throw new Error('分组创建后读不回来')
  return created
}

export async function updateGroup(
  id: string,
  input: Omit<Group, 'id' | 'updatedAt'>,
): Promise<GroupRow | null> {
  await run(
    `update groups set
       name = $2, selector_tag = $3, device_ids = $4, match = $5, candidates = $6, selection = $7,
       target_ids = $8, target_mode = $9, strategy = $10, fail_threshold = $11,
       recover_threshold = $12, probe_interval_sec = $13, tolerance_ms = $14, failback = $15,
       interrupt_existing = $16, on_all_fail = $17, updated_at = now()
     where id = $1`,
    [
      id,
      input.name,
      input.selectorTag,
      JSON.stringify(input.deviceIds),
      JSON.stringify(input.match),
      JSON.stringify(input.candidates),
      input.selection,
      JSON.stringify(input.targetIds),
      input.targetMode,
      input.strategy,
      input.failThreshold,
      input.recoverThreshold,
      input.probeIntervalSec,
      input.toleranceMs,
      input.failback,
      input.interruptExisting,
      input.onAllFail,
    ],
  )
  return findGroupRow(id)
}

export async function deleteGroup(id: string): Promise<void> {
  await tx(async (client) => {
    await client.query('delete from group_runtime where group_id = $1', [id])
    await client.query('delete from groups where id = $1', [id])
  })
}

// ---------------------------------------------------------------- 设备

export function listDeviceRows(): Promise<DeviceRow[]> {
  return many<DeviceRow>('select * from devices order by created_at')
}

export async function listDevices(): Promise<Device[]> {
  const rows = await listDeviceRows()
  const now = Date.now()
  return rows.map((row) => toDevice(row, now))
}

export async function findDeviceRow(id: string): Promise<DeviceRow | null> {
  return one<DeviceRow>('select * from devices where id = $1', [id])
}

export async function findDevice(id: string): Promise<Device | null> {
  const row = await findDeviceRow(id)
  return row ? toDevice(row) : null
}

/** Agent 注册或上报时更新设备信息。返回更新前的那一行，用来判断在线状态变没变 */
export async function upsertDevice(row: {
  id: string
  name: string
  hostname: string
  platform: Platform
  osVersion?: string
  agentVersion?: string
  singboxVersion?: string
  clashApi?: string
  probeInbound?: string
  dataDir?: string
  /**
   * 本机代理的监听地址。空字符串是"现在没有"（sing-box 没起来、端口被占），
   * 要能把旧值清掉；undefined 才表示没上报（旧版 Agent 没有这个字段），保留原值。
   */
  proxyListen?: string
  /**
   * 设备密钥。只有注册时才传：上报走的是已经认证过的身份，
   * 不能让一次上报顺手把密钥换掉——那等于谁拿到一次密钥就能把设备抢走。
   */
  secret?: string
  /**
   * 本机 sing-box 现在的错误。null 是"没问题"，undefined 是"没上报"，保留原值。
   */
  singboxError?: string | null
}): Promise<{ before: DeviceRow | null; after: DeviceRow }> {
  const before = await findDeviceRow(row.id)
  await run(
    `insert into devices (id, name, hostname, platform, os_version, agent_version, singbox_version,
                          clash_api, probe_inbound, data_dir, proxy_listen, secret, singbox_error,
                          last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11::text, ''), $12,
             case when $13::boolean then $14::text else null end, now())
     on conflict (id) do update set
       name = excluded.name,
       hostname = excluded.hostname,
       platform = excluded.platform,
       os_version = coalesce(nullif(excluded.os_version, ''), devices.os_version),
       agent_version = coalesce(nullif(excluded.agent_version, ''), devices.agent_version),
       singbox_version = coalesce(nullif(excluded.singbox_version, ''), devices.singbox_version),
       clash_api = coalesce(nullif(excluded.clash_api, ''), devices.clash_api),
       probe_inbound = coalesce(nullif(excluded.probe_inbound, ''), devices.probe_inbound),
       data_dir = coalesce(nullif(excluded.data_dir, ''), devices.data_dir),
       proxy_listen = coalesce($11::text, devices.proxy_listen),
       secret = coalesce(nullif(excluded.secret, ''), devices.secret),
       singbox_error = case when $13::boolean then $14::text else devices.singbox_error end,
       offline_noted = false,
       last_seen_at = now()`,
    [
      row.id,
      row.name,
      row.hostname,
      row.platform,
      row.osVersion ?? '',
      row.agentVersion ?? '',
      row.singboxVersion ?? '',
      row.clashApi ?? '',
      row.probeInbound ?? '',
      row.dataDir ?? '',
      // null 表示没上报：insert 时落成空字符串（列是 not null），冲突时保留原值
      row.proxyListen === undefined ? null : row.proxyListen,
      row.secret ?? '',
      // 第 13 个参数区分"上报了 null（没问题）"和"没上报"，两者在 SQL 里都是 null
      row.singboxError !== undefined,
      row.singboxError ?? null,
    ],
  )
  const after = await findDeviceRow(row.id)
  if (!after) throw new Error('设备上报后读不回来')
  return { before, after }
}

/**
 * 按设备密钥找设备。密钥是注册时发下去的原文，
 * Agent 每次上报都用它做身份，所以这里不能存散列——服务端要能反查。
 */
export function findDeviceBySecret(secret: string): Promise<DeviceRow | null> {
  return one<DeviceRow>('select * from devices where secret = $1', [secret])
}

/** 只刷新在线时间，不覆盖其他字段 */
export async function touchDevice(id: string): Promise<DeviceRow | null> {
  await run('update devices set last_seen_at = now(), offline_noted = false where id = $1', [id])
  return findDeviceRow(id)
}

/**
 * 把超时没上报、还没记过离线的设备标成已离线，返回这一批。
 *
 * 一条 update … returning 做完：多个实例同时扫的时候，每台设备只会被其中一个领走，
 * 离线事件不会记两遍。
 */
export function markOfflineDevices(afterMs: number): Promise<DeviceRow[]> {
  return many<DeviceRow>(
    `update devices set offline_noted = true
      where not offline_noted
        and last_seen_at < now() - make_interval(secs => $1::double precision)
      returning *`,
    [afterMs / 1000],
  )
}

export async function setDeviceNote(id: string, note: string | null): Promise<DeviceRow | null> {
  await run('update devices set note = $2 where id = $1', [id, note])
  return findDeviceRow(id)
}

/** 设备上的分组运行状态只对应用到这个设备的分组有意义，删设备时一起清 */
export async function deleteDevice(id: string): Promise<void> {
  await tx(async (client) => {
    await client.query('delete from probes where device_id = $1', [id])
    await client.query('delete from group_runtime where device_id = $1', [id])
    await client.query('delete from devices where id = $1', [id])
  })
}

// ---------------------------------------------------------------- 运行状态

export function listRuntimeRows(deviceId?: string): Promise<RuntimeRow[]> {
  if (deviceId) {
    return many<RuntimeRow>('select * from group_runtime where device_id = $1', [deviceId])
  }
  return many<RuntimeRow>('select * from group_runtime')
}

export async function findRuntimeRow(
  deviceId: string,
  groupId: string,
): Promise<RuntimeRow | null> {
  return one<RuntimeRow>('select * from group_runtime where device_id = $1 and group_id = $2', [
    deviceId,
    groupId,
  ])
}

/**
 * Agent 上报的运行状态。固定节点这一栏以服务端为准——用户是在网页上固定的，
 * Agent 上报的顺序可能落后，写进去会把用户的固定覆盖掉。
 */
export async function saveRuntime(deviceId: string, r: ReportedRuntime): Promise<void> {
  await run(
    `insert into group_runtime
       (device_id, group_id, active_node_id, nodes, available_node_ids, last_round_at, last_switch, reported_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (device_id, group_id) do update set
       active_node_id = excluded.active_node_id,
       nodes = excluded.nodes,
       available_node_ids = excluded.available_node_ids,
       last_round_at = excluded.last_round_at,
       last_switch = excluded.last_switch,
       reported_at = now()`,
    [
      deviceId,
      r.groupId,
      r.activeNodeId,
      JSON.stringify(r.nodes ?? []),
      // 没上报这个字段时存 null，不要存成空数组：空数组的意思是"设备上一个都不认得"
      r.availableNodeIds ? JSON.stringify(r.availableNodeIds) : null,
      r.lastRoundAt ? new Date(r.lastRoundAt) : null,
      r.lastSwitch ? JSON.stringify(r.lastSwitch) : null,
    ],
  )
}

/**
 * 服务端自己改固定节点时用。
 *
 * 设备可能还没上报过这个分组（分组刚建好），这时库里没有这一行。
 * 只写 update 的话固定会悄悄丢掉：Agent 执行完待办，下一轮从 bootstrap
 * 拿到的固定表里没有它，又自己选回去了。所以没有就插一行。
 */
export async function setRuntimePin(
  deviceId: string,
  groupId: string,
  nodeId: string | null,
): Promise<void> {
  await run(
    `insert into group_runtime (device_id, group_id, pinned_node_id)
     values ($1, $2, $3)
     on conflict (device_id, group_id) do update set pinned_node_id = excluded.pinned_node_id`,
    [deviceId, groupId, nodeId],
  )
}

/** 设备或分组被删时清掉它的运行状态 */
export async function dropRuntime(groupId: string): Promise<void> {
  await run('delete from group_runtime where group_id = $1', [groupId])
}

export async function dropRuntimeOfDeviceGroup(deviceId: string, groupId: string): Promise<void> {
  await run('delete from group_runtime where device_id = $1 and group_id = $2', [deviceId, groupId])
}

/** 分组不再应用到某台设备时，把它的运行状态清掉 */
export async function pruneRuntime(deviceIds: string[], groupIds: string[]): Promise<number> {
  return run(
    `delete from group_runtime
      where not (device_id = any($1)) or not (group_id = any($2))`,
    [deviceIds, groupIds],
  )
}

// ---------------------------------------------------------------- 探测结果

export async function listProbeRows(q: {
  deviceId?: string
  nodeId?: string
  targetId?: string
}): Promise<ProbeRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (q.deviceId) {
    params.push(q.deviceId)
    where.push(`device_id = $${params.length}`)
  }
  if (q.nodeId) {
    params.push(q.nodeId)
    where.push(`node_id = $${params.length}`)
  }
  if (q.targetId) {
    params.push(q.targetId)
    where.push(`target_id = $${params.length}`)
  }
  const clause = where.length ? ` where ${where.join(' and ')}` : ''
  return many<ProbeRow>(`select * from probes${clause}`, params)
}

export async function listProbeCells(q: {
  deviceId?: string
  nodeId?: string
  targetId?: string
}): Promise<ProbeCell[]> {
  const rows = await listProbeRows(q)
  return rows.map(toProbeCell)
}

/**
 * 写一条探测结果。历史里追加这一条，再从前面裁掉超出的部分，
 * 一次请求里完成，不留给后面的清理任务。
 */
export async function saveProbe(
  deviceId: string,
  nodeId: string,
  probe: ReportedProbe,
): Promise<void> {
  const sample = {
    at: probe.last.at,
    ok: probe.last.ok,
    latencyMs: probe.last.latencyMs,
    stage: probe.last.stage,
    ...(probe.last.error ? { error: probe.last.error } : {}),
  }
  await run(
    `insert into probes (device_id, node_id, target_id, last, history, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (device_id, node_id, target_id) do update set
       last = excluded.last,
       history = case
         -- Agent 每次上报都带着最近一次探测，而探测比上报稀得多：
         -- 同一次探测会被连着报好几回，只有探测时间变了才是新的一条
         when probes.history @> jsonb_build_array(jsonb_build_object('at', $4::jsonb -> 'at'))
           then probes.history
         else (
           select coalesce(jsonb_agg(item order by idx), '[]'::jsonb)
             from (
               select item, idx
                 from jsonb_array_elements(probes.history || excluded.history)
                   with ordinality as t(item, idx)
                order by idx desc
                limit $6
             ) as recent
         )
       end,
       updated_at = now()`,
    [
      deviceId,
      nodeId,
      probe.targetId,
      JSON.stringify(probe.last),
      JSON.stringify([sample]),
      PROBE_HISTORY_MAX,
    ],
  )
}

/** 节点删掉后它的探测结果也没用了 */
export async function dropProbesOfNodes(ids: string[]): Promise<void> {
  if (!ids.length) return
  await run('delete from probes where node_id = any($1)', [ids])
}

// ---------------------------------------------------------------- 事件

/** 记一条事件。id 由服务端生成，时间默认现在 */
export async function insertEvent(event: ReportedEvent & { deviceId: string | null }): Promise<AppEvent> {
  const id = newId('ev')
  const at = event.at ? new Date(event.at) : new Date()
  await run(
    `insert into events (id, at, kind, severity, device_id, group_id, node_id, from_id, to_id, message)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      at,
      event.kind,
      event.severity,
      event.deviceId,
      event.groupId ?? null,
      event.nodeId ?? null,
      event.from ?? null,
      event.to ?? null,
      event.message,
    ],
  )
  return toEvent({
    id,
    at,
    kind: event.kind,
    severity: event.severity,
    device_id: event.deviceId,
    group_id: event.groupId ?? null,
    node_id: event.nodeId ?? null,
    from_id: event.from ?? null,
    to_id: event.to ?? null,
    message: event.message,
  })
}

/** 一次写多条，Agent 补传离线期间的事件时用 */
export async function insertEvents(
  events: Array<ReportedEvent & { deviceId: string | null }>,
): Promise<AppEvent[]> {
  const written: AppEvent[] = []
  for (const event of events) written.push(await insertEvent(event))
  return written
}

/** Agent 只在本地记过的事件，补传时可能重复，用时间和内容挡一道 */
export async function eventExists(
  deviceId: string,
  at: Date,
  kind: string,
  message: string,
): Promise<boolean> {
  const row = await one<{ id: string }>(
    `select id from events
      where device_id = $1 and kind = $2 and message = $3
        and at between $4::timestamptz - interval '5 seconds' and $4::timestamptz + interval '5 seconds'
      limit 1`,
    [deviceId, kind, message, at],
  )
  return !!row
}

export interface EventQueryInput {
  deviceId?: string
  groupId?: string
  kinds?: string[]
  severities?: string[]
  since?: string
  cursor?: string
  limit?: number
}

/**
 * 事件分页。cursor 就是上一页最后一条的 id，
 * 前端不解析它，只需要原样传回来。
 */
export async function queryEvents(q: EventQueryInput): Promise<{
  items: AppEvent[]
  nextCursor: string | null
}> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200)
  const where: string[] = []
  const params: unknown[] = []
  const push = (clause: string, value: unknown) => {
    params.push(value)
    where.push(clause.replace('$?', `$${params.length}`))
  }

  if (q.deviceId) push('device_id = $?', q.deviceId)
  if (q.groupId) push('group_id = $?', q.groupId)
  if (q.kinds?.length) push('kind = any($?)', q.kinds)
  if (q.severities?.length) push('severity = any($?)', q.severities)
  if (q.since) push('at >= $?', q.since)

  if (q.cursor) {
    // cursor 是上一条的 id，用它定位到那一行的时间，再往后取
    const anchor = await one<{ at: Date }>('select at from events where id = $1', [q.cursor])
    if (anchor) {
      params.push(anchor.at, q.cursor)
      where.push(`(at, id) < ($${params.length - 1}, $${params.length})`)
    }
  }

  const clause = where.length ? ` where ${where.join(' and ')}` : ''
  params.push(limit + 1)
  const rows = await many<EventRow>(
    `select * from events${clause} order by at desc, id desc limit $${params.length}`,
    params,
  )
  const page = rows.slice(0, limit)
  return {
    items: page.map(toEvent),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  }
}

/** 保留最近的事件，避免库无限增长 */
export async function trimEvents(keep: number): Promise<number> {
  return run(
    `delete from events where id in (
       select id from events order by at desc, id desc offset $1
     )`,
    [keep],
  )
}

// ---------------------------------------------------------------- 待执行的切换

/** 用户改了固定节点或选了节点，入队一条，Agent 下次上报时取走 */
export async function queuePendingSwitch(row: {
  deviceId: string
  groupId: string
  nodeId: string | null
  reason: string
}): Promise<PendingSwitchRow> {
  const id = newId('pnd')
  await run(
    'insert into pending_switches (id, device_id, group_id, node_id, reason) values ($1, $2, $3, $4, $5)',
    [id, row.deviceId, row.groupId, row.nodeId, row.reason],
  )
  const created = await one<PendingSwitchRow>('select * from pending_switches where id = $1', [id])
  if (!created) throw new Error('待执行的操作入队后读不回来')
  return created
}

/**
 * 下发给 Agent 的待办。
 *
 * 已经放弃重试的（failed_at 有值）不再下发——不然一个永远不会成功的操作会每
 * 15 秒重试一次，直到天荒地老，而且失败得悄无声息。它们留在库里，网页上显示为失败，
 * 由用户决定重试还是撤掉。
 */
export function listPendingSwitches(deviceId: string): Promise<PendingSwitchRow[]> {
  return many<PendingSwitchRow>(
    `select * from pending_switches
      where device_id = $1 and failed_at is null
      order by created_at`,
    [deviceId],
  )
}

/** 全部待办，含已放弃的，网页用来显示"正在切换"和"切换失败" */
export function listAllPendingSwitches(deviceId: string): Promise<PendingSwitchRow[]> {
  return many<PendingSwitchRow>(
    'select * from pending_switches where device_id = $1 order by created_at',
    [deviceId],
  )
}

/**
 * 还没执行的待办，按分组 id 索引，给网页显示"正在切换"和"切换失败"用。
 *
 * 不传设备就是所有设备的。分组 id 是主要的查法：网页是按设备页里的分组卡片显示的，
 * 一个分组在一台设备上最多同时有一条待办（新的一次切换会先把旧的清掉）。
 */
export function listPendingByGroup(
  deviceId: string | null,
): Promise<Map<string, PendingSwitchRow>> {
  const rows = deviceId
    ? many<PendingSwitchRow>(
        'select * from pending_switches where device_id = $1 order by created_at',
        [deviceId],
      )
    : many<PendingSwitchRow>('select * from pending_switches order by created_at')
  return rows.then((list) => {
    const byGroup = new Map<string, PendingSwitchRow>()
    for (const row of list) {
      // 一条分组有多条待办时，留下最新的那条——用户刚点的那次才算数
      const previous = byGroup.get(row.group_id)
      if (!previous || row.created_at >= previous.created_at) byGroup.set(row.group_id, row)
    }
    return byGroup
  })
}

/** 一次失败试多少次就放弃。15 秒一轮的话，5 次大约一分多钟，够区分暂时和永久了 */
export const PENDING_MAX_ATTEMPTS = 5

/**
 * 记一次失败。到上限就置 failed_at，从此不再下发。
 * 返回置位后的行，调用方据此决定要不要写事件。
 */
export async function failPendingSwitch(
  id: string,
  error: string,
): Promise<PendingSwitchRow | null> {
  const row = await one<PendingSwitchRow>(
    `update pending_switches
        set attempts = attempts + 1,
            last_error = $2,
            failed_at = case when attempts + 1 >= $3 then now() else failed_at end
      where id = $1
      returning *`,
    [id, error.slice(0, 500), PENDING_MAX_ATTEMPTS],
  )
  return row
}

/** 网页上点"重试"：清掉失败标记，重新排队 */
export async function revivePendingSwitch(id: string): Promise<boolean> {
  const row = await one<PendingSwitchRow>(
    `update pending_switches
        set attempts = 0, last_error = null, failed_at = null
      where id = $1
      returning id`,
    [id],
  )
  return Boolean(row)
}

export async function clearPendingSwitches(ids: string[]): Promise<void> {
  if (!ids.length) return
  await run('delete from pending_switches where id = any($1)', [ids])
}

/** 设备都删了，队列也没意义 */
export async function clearPendingOfDevice(deviceId: string): Promise<void> {
  await run('delete from pending_switches where device_id = $1', [deviceId])
}

// ---------------------------------------------------------------- 分组引用的节点

/**
 * 分组里固定或选中的节点被删掉、停用后，运行状态里的引用要清掉。
 * 返回受影响的 (设备, 分组) 对，调用方好决定要不要记事件。
 */
export async function clearDanglingRefs(nodeIds: string[]): Promise<void> {
  if (!nodeIds.length) return
  await tx(async (client) => {
    await client.query(
      `update group_runtime
          set pinned_node_id = null
        where pinned_node_id = any($1)`,
      [nodeIds],
    )
    await client.query(
      `update group_runtime
          set active_node_id = null
        where active_node_id = any($1)`,
      [nodeIds],
    )
  })
}

// ---------------------------------------------------------------- 设置

export async function getSetting(key: string): Promise<string | null> {
  const row = await one<{ value: string }>('select value from settings where key = $1', [key])
  return row?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await run(
    `insert into settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  )
}

/**
 * 只在没有的时候写一次。种子数据用：用户删掉默认分组之后重启服务，不该再冒出来一个。
 */
export async function ensureSetting(key: string, value: string): Promise<boolean> {
  const result = await run(
    'insert into settings (key, value) values ($1, $2) on conflict (key) do nothing',
    [key, value],
  )
  return result > 0
}

// ---------------------------------------------------------------- 设备接入令牌

/** 接入命令里那个令牌的有效期，够用户复制粘贴到另一台机器上跑 */
const ENROLL_TTL_MS = 30 * 60 * 1000

/** 生成一个设备接入令牌。库里只留散列，原文发给网页一次，之后再也读不出来 */
export async function createEnrollToken(
  userId: string | null,
  ttlMs = ENROLL_TTL_MS,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const id = newId('enr')
  const token = randomBytes(24).toString('hex')
  const expiresAt = new Date(Date.now() + ttlMs)
  await tx(async (client) => {
    // 过期一天以上的顺手清掉，免得表越攒越大。刚用掉的留着：
    // 设备页可能还开在后台，回到前台时要能查到「已接入」，而不是「已失效」
    await client.query("delete from enroll_tokens where expires_at <= now() - interval '1 day'")
    await client.query(
      'insert into enroll_tokens (id, token_hash, created_by, expires_at) values ($1, $2, $3, $4)',
      [id, tokenHash(token), userId, expiresAt],
    )
  })
  return { id, token, expiresAt }
}

/**
 * 用令牌换设备身份。原子的一条 update：两个 Agent 同时拿着同一个令牌注册时，
 * 只有一个能拿到行，另一个当作令牌无效。
 */
export async function consumeEnrollToken(token: string, deviceId: string): Promise<EnrollTokenRow | null> {
  return one<EnrollTokenRow>(
    `update enroll_tokens
        set used_at = now(), device_id = $2
      where token_hash = $1 and used_at is null and expires_at > now()
      returning *`,
    [tokenHash(token), deviceId],
  )
}

/** 令牌现在还能不能用来接入。只看不用，安装脚本据此提前报错，省得白下一遍 Node 和 sing-box */
export async function enrollTokenUsable(token: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    'select id from enroll_tokens where token_hash = $1 and used_at is null and expires_at > now()',
    [tokenHash(token)],
  )
  return row !== null
}

export async function findEnrollToken(id: string): Promise<EnrollTokenRow | null> {
  return one<EnrollTokenRow>('select * from enroll_tokens where id = $1', [id])
}

export { toDevice, toGroup, toNodeSource, toStoredNode, toTarget }
