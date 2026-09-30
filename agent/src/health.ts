/**
 * 一轮探测的结果怎么变成"能不能用"。
 *
 * 连续失败到次数下限才算不可用、连续成功到次数下限才算恢复，是为了容忍偶发抖动：
 * 一次超时就把节点踢出分组，会让流量来回切。
 *
 * 这个状态是每个分组各自的，跟着分组规则走，不跨分组共享。
 */

import type { Group, HealthState, NodeHealth, ProbeSample, RoundSample } from '../../shared/types.ts'

/** 每轮通过时的延迟中位数取最近几条算 */
const LATENCY_WINDOW = 5
/** 界面上看最近几轮就够了 */
const HISTORY_WINDOW = 5

export interface NodeOpinion {
  nodeId: string
  /** 这一轮全部规则都过了吗 */
  ok: boolean
  /** 这一轮通过的规则对应的延迟，取最大的那个作为这一轮的延迟 */
  latencyMs: number | null
  /** 这一轮没通过的规则 */
  failingTargetIds: string[]
}

/**
 * 把上一轮的状态和这一轮的结果合起来，算出新的健康状态。
 * group 提供阈值：连续失败几次算不可用、连续成功几次算恢复。
 */
export function applyRound(
  group: Pick<Group, 'failThreshold' | 'recoverThreshold'>,
  previous: NodeHealth | undefined,
  opinion: NodeOpinion,
  at: string,
): { health: NodeHealth; changed: 'up' | 'down' | null } {
  const before = previous?.state ?? 'unknown'
  const consecutiveFails = opinion.ok ? 0 : (previous?.consecutiveFails ?? 0) + 1
  const consecutiveSuccesses = opinion.ok ? (previous?.consecutiveSuccesses ?? 0) + 1 : 0

  const history: RoundSample[] = [
    ...(previous?.history ?? []),
    { at, ok: opinion.ok, latencyMs: opinion.latencyMs },
  ].slice(-HISTORY_WINDOW)

  let state: HealthState = before
  if (!opinion.ok && before !== 'down') {
    if (consecutiveFails >= Math.max(1, group.failThreshold)) state = 'down'
  } else if (opinion.ok && before !== 'up') {
    if (consecutiveSuccesses >= Math.max(1, group.recoverThreshold)) state = 'up'
  } else if (before === 'unknown') {
    // 阈值还没到，但至少有过一轮结果了
    state = 'unknown'
  }

  const latencies = history
    .filter((h) => h.ok && h.latencyMs !== null)
    .map((h) => h.latencyMs as number)
    .slice(-LATENCY_WINDOW)

  const health: NodeHealth = {
    nodeId: opinion.nodeId,
    state,
    consecutiveFails,
    consecutiveSuccesses,
    latencyMs: median(latencies),
    lastRoundOk: opinion.ok,
    failingTargetIds: opinion.failingTargetIds,
    changedAt: state === before ? (previous?.changedAt ?? null) : at,
    history,
  }

  // 只有真的翻到 up 或 down 才算"变了"：unknown 是还没测出结论，不值得发事件
  const changed: HealthState | null =
    state === before || state === 'unknown' ? null : state

  return { health, changed }
}

/**
 * 一轮探测后谁是当前出口。
 *
 * priority：按候选顺序，第一个可用的。
 * latency：可用的里面延迟最低的；都没有延迟数据（比如 TCP 探测的 RTT 异常）时退回顺序。
 * 手动分组不探测，由调用方直接给结论。
 */
export function pickActive(group: Group, healths: NodeHealth[], candidateIds: string[]): string | null {
  const usable = new Set(healths.filter((h) => h.state === 'up').map((h) => h.nodeId))
  const ordered = group.strategy === 'latency' ? byLatency(group, healths, candidateIds) : candidateIds
  return ordered.find((id) => usable.has(id)) ?? null
}

function byLatency(group: Group, healths: NodeHealth[], candidateIds: string[]): string[] {
  const latency = new Map(healths.map((h) => [h.nodeId, h.latencyMs]))
  // 容忍度：延迟差在这个范围以内算打平，打平时按优先级，免得在两个节点之间来回跳
  const tolerance = group.toleranceMs
  return [...candidateIds].sort((a, b) => {
    const la = latency.get(a) ?? Number.POSITIVE_INFINITY
    const lb = latency.get(b) ?? Number.POSITIVE_INFINITY
    if (la === lb) return 0
    if (tolerance > 0 && Math.abs(la - lb) <= tolerance) {
      // 差别在容忍范围内：延迟低的那个不算更优，回到候选顺序
      return candidateIds.indexOf(a) - candidateIds.indexOf(b)
    }
    if (la === Number.POSITIVE_INFINITY) return 1
    if (lb === Number.POSITIVE_INFINITY) return -1
    return la - lb
  })
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** 探测历史压缩成界面上的小图，最多留 40 条 */
export function toSamples(health: NodeHealth, latest: ProbeSample | null): ProbeSample[] {
  const fromRounds: ProbeSample[] = health.history.map((h) => ({
    at: h.at,
    ok: h.ok,
    latencyMs: h.latencyMs,
    stage: h.ok ? 'tcp' : null,
  }))
  const merged = latest ? [...fromRounds, latest] : fromRounds
  return merged.slice(-40)
}

export function emptyHealth(nodeId: string): NodeHealth {
  return {
    nodeId,
    state: 'unknown',
    consecutiveFails: 0,
    consecutiveSuccesses: 0,
    latencyMs: null,
    lastRoundOk: null,
    failingTargetIds: [],
    changedAt: null,
    history: [],
  }
}
