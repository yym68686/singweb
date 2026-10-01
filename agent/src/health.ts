/**
 * 一轮探测的结果怎么变成"能不能用"。
 *
 * 连续失败到次数下限才算不可用、连续成功到次数下限才算恢复，是为了容忍偶发抖动：
 * 一次超时就把节点踢出分组，会让流量来回切。选节点也一样，见下面的 SWITCH_ROUNDS。
 *
 * 这个状态是每个分组各自的，跟着分组规则走，不跨分组共享。
 */

import type { Group, HealthState, NodeHealth, RoundSample } from '../../shared/types.ts'

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
    // 恢复的门槛是给掉过线的节点设的；刚开始探测、还没出过问题的节点，过一轮就能用，
    // 不然 Agent 每次启动都要白等好几个探测周期才能选出节点
    const needed = before === 'unknown' ? 1 : Math.max(1, group.recoverThreshold)
    if (consecutiveSuccesses >= needed) state = 'up'
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

  // 只有在 up 和 down 之间翻转才算"变了"。从 unknown 出来是第一次下结论，不发事件：
  // 不然 Agent 每次启动，分组里每个节点都会报一条「恢复正常」或「不可用」
  const changed: HealthState | null =
    before === 'unknown' || state === before || state === 'unknown' ? null : state

  return { health, changed }
}

/**
 * 当前节点被比下去的记录。
 *
 * 单轮的中位数差别大半是噪声：公网延迟一轮里跳几百毫秒很常见，两个节点的
 * 中位数又常常只差几十毫秒。只看一轮就换，结果是每个探测周期换一次出口，
 * 连接被反复打断。所以当前节点要连续 SWITCH_ROUNDS 轮都慢出容忍度才换。
 *
 * 只数当前节点输了几轮、不管输给谁：几个差不多快的节点轮流当第一时，
 * 当前节点其实一直都慢，不能因为领先的换了人就从头数。
 */
export interface Outpaced {
  /** 被比下去的是哪个节点。当前节点换了（固定、故障转移），记录就作废 */
  nodeId: string
  /** 连续几轮慢出容忍度 */
  rounds: number
  /**
   * 最后计入的是哪一轮探测。选节点每次上报都会跑一遍，比探测频繁得多，
   * 同一轮的结果只能数一次，不然几次上报就把同一个噪声数够了
   */
  roundAt: string | null
}

/** 当前节点连续慢出容忍度这么多轮才换，扛住单轮抖动 */
export const SWITCH_ROUNDS = 2

export interface Choice {
  /** 该走哪个节点。null 表示一个可用的都没有 */
  pick: string | null
  /** 当前节点还在被比下去、但没到轮数时的记录；其余情况是 null */
  outpaced: Outpaced | null
}

/**
 * 这一轮之后该走哪个节点。
 *
 * 只在可用（up）的候选节点里挑；一个都没有时 pick 是 null，由调用方按「全部不可用时」处理。
 *
 * priority：候选顺序里第一个可用的。当前节点还能用、又没开「恢复后切回」时不动，
 *   免得排在前面的节点一恢复就把连接拽回去。
 * latency：延迟最低的那个。当前节点还能用、只慢了容忍度以内时不动；
 *   慢出容忍度的，也要连续 SWITCH_ROUNDS 轮都如此才换，换到那一轮最快的节点。
 *   容忍度管的是单轮差多少算「明显」，管不了这个差值是噪声还是真的变慢了，
 *   多看一轮才分得出来。没有延迟数据的节点排在最后。
 *
 * 当前节点不能用（不可用、被移出候选、还没有当前节点）时立刻换，不等轮数：
 * 这时没有可比的对象，故障转移也不该拖。
 */
export function chooseActive(
  group: Pick<Group, 'strategy' | 'toleranceMs' | 'failback'>,
  healths: Map<string, NodeHealth>,
  candidateIds: string[],
  current: string | null,
  outpaced: Outpaced | null = null,
  /** 这些健康状态来自哪一轮探测 */
  roundAt: string | null = null,
): Choice {
  const usable = candidateIds.filter((id) => healths.get(id)?.state === 'up')
  if (!usable.length) return { pick: null, outpaced: null }
  const keep = current !== null && usable.includes(current)

  if (group.strategy === 'priority') {
    return { pick: keep && !group.failback ? current : usable[0], outpaced: null }
  }

  const latency = (id: string) => healths.get(id)?.latencyMs ?? Number.POSITIVE_INFINITY
  // 延迟一样时留下排在前面的
  const best = usable.reduce((a, b) => (latency(b) < latency(a) ? b : a))
  if (!keep) return { pick: best, outpaced: null }

  const gap = latency(current) - latency(best)
  // 两边都没有延迟数据时差值是 NaN，也算不比它慢
  if (!(gap > Math.max(0, group.toleranceMs))) return { pick: current, outpaced: null }

  let rounds = 1
  if (outpaced?.nodeId === current) {
    rounds = outpaced.roundAt === roundAt ? outpaced.rounds : outpaced.rounds + 1
  }
  if (rounds >= SWITCH_ROUNDS) return { pick: best, outpaced: null }
  return { pick: current, outpaced: { nodeId: current, rounds, roundAt } }
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}
