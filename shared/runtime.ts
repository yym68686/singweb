/**
 * 分组运行状态的推导。管理服务和 Agent 用同一份，谁也别自己写一遍。
 *
 * 输入是「库里存着什么」和「Agent 最近报了什么」，输出是界面直接能用的
 * GroupRuntime。判定顺序见 docs/api.md 的 state 表，从上到下取第一个符合的。
 *
 * 这里只看上报过的数据，不连设备、不探测——前端每隔几秒就要问一次，
 * 不能因为某个设备掉线就把这次请求拖住。
 */

import { candidateIds } from './candidates.ts'
import type {
  Group,
  GroupRuntime,
  NodeHealth,
  ProxyNode,
  RuntimeState,
  SwitchRecord,
} from './types.ts'

/** 库里存的 group_runtime 行，管理服务那边是 snake_case 的数据库列 */
export interface RuntimeSnapshot {
  groupId: string
  activeNodeId: string | null
  pinnedNodeId: string | null
  /** Agent 报上来的候选节点健康状态；手动分组不探测，是空的 */
  nodes: NodeHealth[]
  /** 设备上 selector 实际认得的节点；null 表示 Agent 没读出来 */
  availableNodeIds: string[] | null
  lastRoundAt: string | null
  lastSwitch: SwitchRecord | null
  reportedAt: string
}

export interface RuntimeContext {
  deviceId: string
  /** 设备是否还在上报。离线时状态一律是 stale，其余字段是离线前的快照 */
  online: boolean
  /** 全库节点，用来判断候选节点还在不在、有没有被停用 */
  nodes: ProxyNode[]
  /** 没有上报记录时，各字段的默认值 */
  fallbackReportedAt: string
}

/**
 * 一个分组的运行状态。
 *
 * 手动选择的分组按文档只会是 stale、manual 或 blocked：它不探测，
 * 没有「可用不可用」这回事，有启用的候选节点就算正常。
 */
export function runtimeState(
  group: Group,
  snapshot: RuntimeSnapshot,
  ctx: RuntimeContext,
): RuntimeState {
  if (!ctx.online) return 'stale'

  const enabled = enabledCandidateIds(group, ctx.nodes)

  if (group.selection === 'manual') {
    // 一个候选节点都没有，selector 生成不出来，规则直接 reject
    return enabled.length ? 'manual' : 'blocked'
  }

  const healthById = new Map(snapshot.nodes.map((h) => [h.nodeId, h]))
  const split = splitCandidates(enabled, healthById)

  if (split.healthy.length) {
    const pinned = snapshot.pinnedNodeId
    // 固定是「一直用这个」的意思，所以固定的节点还能用就不用看别的
    if (pinned && enabled.includes(pinned)) {
      return split.healthy.includes(pinned) ? 'pinned' : 'pinned-down'
    }
    if (split.healthy.length === 1) return 'degraded'
    return 'ok'
  }

  // 到这里一个可用节点都没有了
  if (!enabled.length) {
    // 没有启用的候选节点时 onAllFail 三种取值都救不了：没有东西可以停、可以直连
    return 'blocked'
  }
  // 还有节点没探测完，先别急着说全挂了
  if (split.pending.length) return 'unknown'
  switch (group.onAllFail) {
    case 'block':
      return 'blocked'
    case 'direct':
      return 'direct'
    case 'keep-last':
      return 'failing'
  }
}

/**
 * 启用着的候选节点按健康情况分开。
 * 健康表里没有的算 pending：那是还没探测过，不是挂了。
 */
function splitCandidates(enabled: string[], healthById: Map<string, NodeHealth>) {
  const healthy: string[] = []
  const pending: string[] = []
  for (const id of enabled) {
    const state = healthById.get(id)?.state
    if (state === 'up') healthy.push(id)
    // down 明确判过不可用，unknown 和没上报过都是在等结果，都算 pending
    else if (state !== 'down') pending.push(id)
  }
  return { healthy, pending }
}

/**
 * 当前可用、组成分组的节点，按优先级排列。
 * 自动分组只留判为可用的，手动分组给全部启用的候选节点（它不探测）。
 */
export function eligibleNodeIds(
  group: Group,
  snapshot: RuntimeSnapshot,
  ctx: RuntimeContext,
): string[] {
  const enabled = enabledCandidateIds(group, ctx.nodes)
  if (group.selection === 'manual') return enabled
  return splitCandidates(enabled, new Map(snapshot.nodes.map((h) => [h.nodeId, h]))).healthy
}

/** 候选节点里还启用着的那些，按 candidates 定义的顺序 */
function enabledCandidateIds(group: Group, nodes: ProxyNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return candidateIds(group, nodes).filter((id) => byId.get(id)?.enabled)
}

/** 拼成接口回出去的形状，/runtime、/devices/:id 和概览都用这个 */
export function toGroupRuntime(
  group: Group,
  snapshot: RuntimeSnapshot,
  ctx: RuntimeContext,
): GroupRuntime {
  return {
    deviceId: ctx.deviceId,
    groupId: group.id,
    activeNodeId: snapshot.activeNodeId,
    pinnedNodeId: snapshot.pinnedNodeId,
    state: runtimeState(group, snapshot, ctx),
    eligibleNodeIds: eligibleNodeIds(group, snapshot, ctx),
    // 手动分组不探测，历史健康数据就算库里有也当没有——它随时可能被改成自动分组
    nodes: group.selection === 'manual' ? [] : snapshot.nodes,
    // 设备认得哪些节点跟分组怎么选节点无关，手动分组一样要报，切换时要用它校验
    availableNodeIds: snapshot.availableNodeIds,
    lastRoundAt: group.selection === 'manual' ? null : snapshot.lastRoundAt,
    lastSwitch: snapshot.lastSwitch,
  }
}

/** 出口为空时的兜底：设备还没上报过这个分组 */
export function emptyRuntime(group: Group, ctx: RuntimeContext): GroupRuntime {
  return toGroupRuntime(
    group,
    {
      groupId: group.id,
      activeNodeId: null,
      pinnedNodeId: null,
      nodes: [],
      // 还没上报过，设备上认不认得节点是未知的，不是"设备上一个都没有"
      availableNodeIds: null,
      lastRoundAt: null,
      lastSwitch: null,
      reportedAt: ctx.fallbackReportedAt,
    },
    ctx,
  )
}
