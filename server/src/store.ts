/**
 * 存取层：把数据库的行和接口用的类型互相转换。
 *
 * 路由只调用这里的函数，不直接写 SQL，这样表结构和接口形状的对应关系集中在一个文件里。
 * 所有函数都是无状态的——服务端自己不保存任何东西，请求之间靠数据库。
 */

import { createHash } from 'node:crypto'
import { many, newId, one, run, tx } from './db.ts'
import type {
  DeviceRow,
  EventRow,
  GroupRow,
  NodeRow,
  NodeSourceRow,
  PendingSwitchRow,
  ProbeRow,
  ReportedEvent,
  ReportedNode,
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
    'update node_sources set last_fetched_at = now(), last_error = $2, node_count = $3 where id = $1',
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

export function listNodeRows(): Promise<NodeRow[]> {
  return many<NodeRow>('select * from nodes order by tag')
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
 * 把一批订阅节点写进库：按 (source_id, identity) 合并，存在的更新，
 * 不存在的插入，这次没出现的从库里删掉（订阅里已经移除了）。
 *
 * 返回这次写入后的全部节点，调用方拿它去判断哪些节点不该再被分组引用。
 */
export async function syncSourceNodes(
  sourceId: string,
  source: string,
  nodes: Array<Omit<ReportedNode, 'identity'> & { identity: string }>,
): Promise<NodeRow[]> {
  const keep: string[] = []
  await tx(async (client) => {
    for (const node of nodes) {
      const id = nodeIdFor(sourceId, node.identity)
      keep.push(id)
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
           updated_at = now()`,
        [
          id,
          node.tag,
          node.protocol,
          node.server,
          node.port,
          node.region,
          source,
          JSON.stringify(node.outbound),
          sourceId,
          node.identity,
        ],
      )
    }
    // 订阅里已经没有的节点
    if (keep.length) {
      await client.query('delete from nodes where source_id = $1 and not (id = any($2))', [
        sourceId,
        keep,
      ])
    } else {
      await client.query('delete from nodes where source_id = $1', [sourceId])
    }
  })
  return many<NodeRow>('select * from nodes where source_id = $1 order by tag', [sourceId])
}

/**
 * Agent 上报的节点。这些是设备本机 sing-box 配置里的节点，按 tag 认。
 * tag 撞上了就更新，不删——设备不在线时不该把它的节点清掉。
 *
 * 认行要看 identity，不能只看 tag：Agent 每一轮上报都会把服务端发给它的整份节点列表
 * 原样送回来，里面有订阅来的也有本机配置的。按 tag 认的话，订阅那 20 个节点要么每轮
 * 再新建一份，要么把订阅那份覆盖掉，节点数会翻倍。
 *
 * 同一条 identity 落到了两行上时，优先认有 source_id 的那一行——订阅来的那份是权威的，
 * 影子行不该反客为主。
 */
export async function upsertReportedNodes(nodes: ReportedNode[]): Promise<void> {
  if (!nodes.length) return
  await tx(async (client) => {
    for (const node of nodes) {
      const identity = node.identity ?? ''
      const existing = identity
        ? await client.query<{ id: string }>(
            `select id from nodes where identity = $1
             order by (source_id is null), id limit 1`,
            [identity],
          )
        : await client.query<{ id: string }>('select id from nodes where tag = $1 limit 1', [
            node.tag,
          ])
      const id = existing.rows[0]?.id ?? newId('node')
      await client.query(
        `insert into nodes (id, tag, protocol, server, port, region, enabled, source, outbound, identity, updated_at)
         values ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, now())
         on conflict (id) do update set
           tag = excluded.tag,
           protocol = excluded.protocol,
           server = excluded.server,
           port = excluded.port,
           region = excluded.region,
           outbound = excluded.outbound,
           updated_at = now()`,
        [
          id,
          node.tag,
          node.protocol,
          node.server,
          node.port,
          node.region,
          '本机配置',
          JSON.stringify(node.outbound),
          node.identity ?? '',
        ],
      )
    }
  })
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
  secret?: string
}): Promise<{ before: DeviceRow | null; after: DeviceRow }> {
  const before = await findDeviceRow(row.id)
  await run(
    `insert into devices (id, name, hostname, platform, os_version, agent_version, singbox_version,
                          clash_api, probe_inbound, data_dir, secret, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
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
       secret = coalesce(nullif(excluded.secret, ''), devices.secret),
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
      row.secret ?? '',
    ],
  )
  const after = await findDeviceRow(row.id)
  if (!after) throw new Error('设备上报后读不回来')
  return { before, after }
}

/** 只刷新在线时间，不覆盖其他字段 */
/**
 * 按设备密钥找设备。密钥是注册时发下去的原文，
 * Agent 每次上报都用它做身份，所以这里不能存散列——服务端要能反查。
 */
export function findDeviceBySecret(secret: string): Promise<DeviceRow | null> {
  return one<DeviceRow>('select * from devices where secret = $1', [secret])
}

export async function touchDevice(id: string): Promise<DeviceRow | null> {
  await run('update devices set last_seen_at = now() where id = $1', [id])
  return findDeviceRow(id)
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
    `insert into group_runtime (device_id, group_id, active_node_id, nodes, last_round_at, last_switch, reported_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (device_id, group_id) do update set
       active_node_id = excluded.active_node_id,
       nodes = excluded.nodes,
       last_round_at = excluded.last_round_at,
       last_switch = excluded.last_switch,
       reported_at = now()`,
    [
      deviceId,
      r.groupId,
      r.activeNodeId,
      JSON.stringify(r.nodes ?? []),
      r.lastRoundAt ? new Date(r.lastRoundAt) : null,
      r.lastSwitch ? JSON.stringify(r.lastSwitch) : null,
    ],
  )
}

/** 服务端自己改固定节点时用 */
export async function setRuntimePin(
  deviceId: string,
  groupId: string,
  nodeId: string | null,
): Promise<void> {
  await run(
    `update group_runtime set pinned_node_id = $3, reported_at = now()
      where device_id = $1 and group_id = $2`,
    [deviceId, groupId, nodeId],
  )
}

/** 让设备重新跑一轮探测 */
export async function setRuntimeActive(
  deviceId: string,
  groupId: string,
  nodeId: string | null,
): Promise<void> {
  await run(
    'update group_runtime set active_node_id = $3, reported_at = now() where device_id = $1 and group_id = $2',
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
       history = (
         select coalesce(jsonb_agg(item order by idx), '[]'::jsonb)
           from (
             select item, idx
               from jsonb_array_elements(probes.history || excluded.history)
                 with ordinality as t(item, idx)
              order by idx desc
              limit $6
           ) as recent
       ),
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

export function listPendingSwitches(deviceId: string): Promise<PendingSwitchRow[]> {
  return many<PendingSwitchRow>(
    'select * from pending_switches where device_id = $1 order by created_at',
    [deviceId],
  )
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

export { toDevice, toGroup, toNodeSource, toStoredNode, toTarget }
