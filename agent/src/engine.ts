/**
 * 主循环。一轮办四件事：拉订阅、跑一轮探测、执行服务端发下来的操作、上报。
 *
 * 顺序有讲究：订阅先拉（节点集合变了，候选跟着变），再探测（拿到这一轮的结论），
 * 再执行待办（切换要在上报之前生效），最后上报。
 *
 * 上报本身就是轮询——服务端把待办塞在响应里带回来，所以它不需要能连到这台机器。
 * 设备在内网、没有公网地址也能管。
 */

import type {
  AppEvent,
  Group,
  NodeHealth,
  ProbeDetail,
  ProbeSample,
  ProxyNode,
  StoredNode,
  SwitchRecord,
  Target,
} from '../../shared/types.ts'
import { candidateIds } from '../../shared/candidates.ts'
import { probeTarget, type ProbeContext } from './probe.ts'
import { applyRound, pickActive, type NodeOpinion } from './health.ts'
import { openProbeRuntime, type ProbeRuntime } from './runtime.ts'
import { parseSubscriptionBody, toReportedNode, type PendingSwitch } from './client.ts'
import type { Reporter } from './reporter.ts'
import { ClashApi } from './singbox.ts'
import type { AgentState } from './config.ts'

/** 一轮探测最多同时开这么多连接，避免把本机端口用完 */
const PROBE_CONCURRENCY = 8
const PROBE_HISTORY_MAX = 40

/** 一个分组在本机的运行状态，只活在内存里，重启后重新探测 */
interface GroupState {
  healths: Map<string, NodeHealth>
  activeNodeId: string | null
  /** 用户在网页上固定下来的节点。有值时自动切换让位，一直用这个 */
  pinnedNodeId: string | null
  lastRoundAt: string | null
  lastSwitch: SwitchRecord | null
}

export class Engine {
  private readonly groups = new Map<string, GroupState>()
  /** 探测结果按「节点|目标」存，上报时整理成矩阵 */
  private readonly latest = new Map<string, ProbeDetail>()
  private readonly history = new Map<string, ProbeSample[]>()

  private nodes: StoredNode[] = []
  private events: AppEvent[] = []
  private runtime: ProbeRuntime | null = null
  private readonly clash: ClashApi
  private stopped = false

  private readonly state: AgentState
  private readonly reporter: Reporter

  constructor(state: AgentState, reporter: Reporter) {
    this.state = state
    this.reporter = reporter
    this.clash = new ClashApi(state.clashApi, state.clashSecret)
  }

  /** 跑起来就一直循环，直到 stop() */
  async run(): Promise<void> {
    console.log(`设备「${this.state.name}」已接入 ${this.state.server}，开始上报。`)
    while (!this.stopped) {
      let intervalSec = this.reporter.current.reportIntervalSec || 15
      try {
        intervalSec = await this.cycle()
      } catch (err) {
        console.error('这一轮出错了，等会儿重试：', err instanceof Error ? err.message : err)
      }
      await sleep(Math.max(5, intervalSec) * 1000)
    }
  }

  stop(): void {
    this.stopped = true
    this.runtime?.stop()
  }

  /** 一轮，返回下一轮隔多久 */
  private async cycle(): Promise<number> {
    const snapshot = await this.reporter.bootstrap()
    this.nodes = snapshot.nodes
    this.applyGroups(snapshot.groups)
    this.applyPins(snapshot.pins)

    await this.syncSources(snapshot.sources)
    await this.ensureRuntime()
    await this.probeAll(snapshot.groups, snapshot.targets)
    await this.applyPending(snapshot.pending)

    const answer = await this.reporter.report(this.buildReport(snapshot.groups))
    // 事件交上去就不必再留，下一轮重新攒
    this.events = []
    return answer.reportIntervalSec
  }

  /** 分组增删时同步本地状态；消失的分组状态一并丢掉 */
  private applyGroups(groups: Group[]): void {
    const seen = new Set(groups.map((g) => g.id))
    for (const group of groups) {
      if (!this.groups.has(group.id)) {
        this.groups.set(group.id, {
          healths: new Map(),
          activeNodeId: null,
          pinnedNodeId: null,
          lastRoundAt: null,
          lastSwitch: null,
        })
      }
    }
    for (const id of [...this.groups.keys()]) {
      if (!seen.has(id)) this.groups.delete(id)
    }
  }

  /**
   * 对齐网页上的固定节点。
   *
   * 每次都整份覆盖：用户取消固定后 pins 里就没有这一项了，只做增量的写法
   * 会让取消不生效。固定的节点也不校验是否存在——列表里没有它时下一轮
   * probeAll 也不会选它，界面照样显示得出来。
   */
  private applyPins(pins: Record<string, string>): void {
    for (const [groupId, state] of this.groups) {
      state.pinnedNodeId = pins[groupId] ?? null
    }
  }

  /** 探测进程的出站列表写死在配置里，节点集合变了就得重启它 */
  private async ensureRuntime(): Promise<void> {
    const wanted = this.nodes.filter((n) => n.enabled).map((n) => n.tag).join('\u0000')
    if (this.runtime && this.runtimeTags === wanted) return
    this.runtime?.stop()
    // 先清干净再起：起不来时不能留下"已经迁到这个节点集合"的假象，
    // 否则下一轮会以为已经就绪，再也不重试
    this.runtime = null
    this.runtimeTags = wanted
    this.runtime = await openProbeRuntime({
      state: this.state,
      nodes: this.nodes,
      onExit: (reason) => {
        this.runtime = null
        this.runtimeTags = ''
        console.error(`探测进程退出了（${reason}），下一轮重新拉起。`)
      },
    })
    this.runtimeTags = wanted
  }

  private runtimeTags = ''

  /** 逐个订阅去取。链接只在服务端，Agent 拿到的是完整的订阅地址 */
  private async syncSources(sources: { id: string; name: string; url: string }[]): Promise<void> {
    for (const source of sources) {
      try {
        const body = await this.reporter.fetchSource(source)
        const nodes = parseSubscriptionBody(body)
        await this.reporter.sourceResult(source.id, null, nodes.map(toReportedNode))
      } catch (err) {
        await this.reporter.sourceResult(
          source.id,
          err instanceof Error ? err.message : String(err),
          [],
        )
      }
    }
  }

  /**
   * 探测一轮。手动分组不探测——它的意义就是"我说用哪个就用哪个"。
   */
  private async probeAll(groups: Group[], targets: Target[]): Promise<void> {
    const byId = new Map(targets.map((t) => [t.id, t]))
    const at = new Date().toISOString()

    for (const group of groups) {
      const state = this.groups.get(group.id)
      if (!state) continue
      if (group.selection === 'manual') {
        // 出口就是固定或选中的那个节点，没有就取第一个启用的候选
        const ids = candidateIds(group, this.nodes)
        const usable = this.nodes.filter((n) => ids.includes(n.id) && n.enabled)
        state.activeNodeId =
          (state.activeNodeId && usable.some((n) => n.id === state.activeNodeId)
            ? state.activeNodeId
            : usable[0]?.id) ?? null
        state.lastRoundAt = at
        continue
      }

      const ids = candidateIds(group, this.nodes)
      const live = this.nodes.filter((n) => ids.includes(n.id) && n.enabled)
      const rules = group.targetIds
        .map((id) => byId.get(id))
        .filter((t): t is Target => t !== undefined)

      const opinions = await this.runProbes(group, live, rules)
      const healths: NodeHealth[] = []
      for (const opinion of opinions) {
        const { health, changed } = applyRound(group, state.healths.get(opinion.nodeId), opinion, at)
        healths.push(health)
        if (changed) this.noteHealthChange(group, opinion, health, changed, byId)
      }
      state.healths = new Map(healths.map((h) => [h.nodeId, h]))
      state.lastRoundAt = at

      // 用户固定了节点就一直用它，探测照跑（界面要看健康度），但不拿结论去改出口。
      // 固定节点不在候选里或已经被停用时当作没固定，否则出口会卡在一个不存在的节点上。
      const pinned = state.pinnedNodeId && live.some((n) => n.id === state.pinnedNodeId)
        ? state.pinnedNodeId
        : null
      // 规则跑完才轮到决定用哪个。pickActive 按优先级或延迟挑一个可用的，
      // 一个都没有时返回 null——那就是"全部不可用"。
      const next = pinned ?? pickActive(group, healths, ids)
      await this.applyActive(group, state, next)
    }
  }

  /**
   * 把这一轮的结论落到设备上。出口变了就调 Clash API 切 selector，
   * 并记一条 switch 事件——网页上的出口显示和切换记录都靠它。
   *
   * 切失败不改内存状态：下一轮还会算出同样的结论再试一次，
   * 内存里先改成"已切换"会让网页显示一个设备上并不成立的状态。
   */
  private async applyActive(
    group: Group,
    state: GroupState,
    next: string | null,
  ): Promise<void> {
    if (next === state.activeNodeId) return

    const from = state.activeNodeId
    const to = next
    if (to) {
      try {
        await this.clash.select(group.selectorTag, this.tagOf(to))
      } catch (err) {
        console.error(
          `切换「${group.name}」到 ${this.tagOf(to)} 失败：`,
          err instanceof Error ? err.message : String(err),
        )
        return
      }
    }

    state.activeNodeId = to
    state.lastSwitch = {
      at: new Date().toISOString(),
      from: from ? this.tagOf(from) : null,
      to,
      reason: to ? 'auto' : 'all-fail',
    }
    this.events.push(
      this.event(group, to ? 'switch' : 'all-down', to ? 'info' : 'warn', {
        nodeId: to,
        from: from ? this.tagOf(from) : null,
        to,
        message: to
          ? `「${group.name}」改走 ${this.tagOf(to)}`
          : `「${group.name}」的节点全都不可用`,
      }),
    )
  }

  /** 一个节点一轮里要过完所有规则：全部通过或任意通过取决于分组设置 */
  private async runProbes(
    group: Group,
    nodes: ProxyNode[],
    rules: Target[],
  ): Promise<NodeOpinion[]> {
    const runtime = this.runtime
    if (!runtime) return []
    if (!rules.length || !nodes.length) {
      // 没有规则或没有候选：给每个候选一个"未知"的结论，不改变已有状态
      return nodes.map((node) => ({
        nodeId: node.id,
        ok: true,
        latencyMs: null,
        failingTargetIds: [],
      }))
    }

    const tasks = nodes.map((node) => async (): Promise<NodeOpinion> => {
      const details: ProbeDetail[] = []
      const failing: string[] = []

      for (const target of rules) {
        const ctx: ProbeContext = {
          ...runtime.endpointFor(node.tag),
          host: hostOf(target),
          port: portOf(target),
          timeoutMs: target.timeoutMs,
        }
        const detail = await probeTarget(target, ctx)
        details.push(detail)
        if (!detail.ok) failing.push(target.id)

        const key = `${node.id}|${target.id}`
        this.latest.set(key, detail)
        const sample = sampleOf(detail)
        this.history.set(key, [...(this.history.get(key) ?? []), sample].slice(-PROBE_HISTORY_MAX))
      }

      const ok =
        group.targetMode === 'any'
          ? details.some((d) => d.ok)
          : details.length > 0 && details.every((d) => d.ok)
      const passed = details.filter((d) => d.ok)
      return {
        nodeId: node.id,
        ok,
        // 一个节点过好几条规则时，整轮耗时按最慢的那条算
        latencyMs: passed.length ? Math.max(...passed.map((d) => d.latencyMs ?? 0)) : null,
        failingTargetIds: failing,
      }
    })

    return runLimited(tasks, PROBE_CONCURRENCY)
  }

  private noteHealthChange(
    group: Group,
    opinion: NodeOpinion,
    health: NodeHealth,
    changed: 'up' | 'down',
    targets: Map<string, Target>,
  ): void {
    const tag = this.tagOf(opinion.nodeId)
    if (changed === 'up') {
      this.events.push(
        this.event(group, 'node-up', 'good', {
          nodeId: opinion.nodeId,
          message: `${tag} 恢复正常，可以用了`,
        }),
      )
      return
    }
    const names = opinion.failingTargetIds
      .map((id) => targets.get(id)?.name ?? id)
      .join('、')
    this.events.push(
      this.event(group, 'node-down', 'warn', {
        nodeId: opinion.nodeId,
        message: `${tag} 连续 ${health.consecutiveFails} 轮没有通过「${names}」`,
      }),
    )
  }

  /**
   * 执行服务端排下来的操作。网页上点的「切换到这个节点」就是走这条路：
   * 写库、Agent 下一轮领回来、调 Clash API、然后 ack。
   */
  private async applyPending(pending: PendingSwitch[]): Promise<void> {
    if (!pending.length) return
    const acked: string[] = []

    for (const item of pending) {
      const group = this.reporter.groupById(item.group_id)
      const state = this.groups.get(item.group_id)
      if (!group || !state) {
        // 分组已经没了，这条待办没有意义
        acked.push(item.id)
        continue
      }
      const tag = item.node_id ? this.tagOf(item.node_id) : null
      try {
        if (tag) await this.clash.select(group.selectorTag, tag)
        const record: SwitchRecord = {
          at: new Date().toISOString(),
          from: state.activeNodeId ? this.tagOf(state.activeNodeId) : null,
          to: item.node_id,
          reason: reasonText(item.reason),
        }
        state.activeNodeId = item.node_id
        // 网页上的固定/取消固定立刻生效，不等下一轮 bootstrap
        state.pinnedNodeId = item.node_id
        state.lastSwitch = record
        this.events.push(
          this.event(group, item.node_id ? 'pin' : 'unpin', 'info', {
            nodeId: item.node_id,
            from: record.from,
            to: record.to,
            message: item.node_id
              ? `「${group.name}」切到 ${tag}`
              : `「${group.name}」取消了手动选择`,
          }),
        )
        acked.push(item.id)
      } catch (err) {
        // 没成功就不 ack，下一轮还会领到，用户能在网页上看到它一直没生效
        console.error(
          `切换「${group.name}」失败：`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    if (acked.length) await this.reporter.ack(acked)
  }

  private buildReport(groups: Group[]): unknown {
    return {
      device: {
        id: this.state.deviceId,
        name: this.state.name,
        hostname: this.reporter.host,
        platform: this.state.platform,
        agentVersion: this.state.agentVersion,
        singboxVersion: this.state.singboxVersion,
        clashApi: this.state.clashApi,
        probeInbound: this.runtime?.listen ?? '',
        dataDir: this.state.dataDir,
      },
      nodes: this.nodes.map((node) => ({
        tag: node.tag,
        protocol: node.protocol,
        server: node.server,
        port: node.port,
        region: node.region,
        outbound: node.outbound,
        // 只有订阅来的节点带 identity，配置里的节点由 tag 认
        ...(node.sourceId ? { identity: `${node.protocol}|${node.server}|${node.port}|${node.tag}` } : {}),
      })),
      runtime: groups.map((group) => {
        const state = this.groups.get(group.id)
        return {
          groupId: group.id,
          activeNodeId: state?.activeNodeId ?? null,
          pinnedNodeId: state?.pinnedNodeId ?? null,
          nodes: state ? [...state.healths.values()] : [],
          lastRoundAt: state?.lastRoundAt ?? null,
          lastSwitch: state?.lastSwitch ?? null,
        }
      }),
      probes: this.buildProbes(),
      events: this.events.map((event) => ({
        kind: event.kind,
        severity: event.severity,
        at: event.at,
        groupId: event.groupId,
        nodeId: event.nodeId,
        from: event.from,
        to: event.to,
        message: event.message,
      })),
    }
  }

  private buildProbes(): unknown[] {
    const out: unknown[] = []
    for (const [last, key] of [...this.latest].map(([k, v]) => [v, k] as const)) {
      const [nodeId, targetId] = key.split('|')
      out.push({ nodeId, targetId, last, history: this.history.get(key) ?? [] })
    }
    return out
  }

  private event(
    group: Group,
    kind: AppEvent['kind'],
    severity: AppEvent['severity'],
    extra: {
      nodeId?: string | null
      from?: string | null
      to?: string | null
      message: string
    },
  ): AppEvent {
    return {
      id: '',
      at: new Date().toISOString(),
      kind,
      severity,
      deviceId: this.state.deviceId ?? '',
      groupId: group.id,
      nodeId: extra.nodeId ?? null,
      from: extra.from ?? null,
      to: extra.to ?? null,
      message: extra.message,
    }
  }

  private tagOf(nodeId: string): string {
    return this.nodes.find((n) => n.id === nodeId)?.tag ?? nodeId
  }
}

function sampleOf(detail: ProbeDetail): ProbeSample {
  return {
    at: detail.at,
    ok: detail.ok,
    latencyMs: detail.latencyMs,
    stage: detail.stage,
    ...(detail.error ? { error: detail.error } : {}),
  }
}

/** 目标地址和端口。HTTP 从网址里取，其余用 host 和 port 字段 */
function hostOf(target: Target): string {
  if (target.kind === 'http') {
    try {
      return new URL(target.url).hostname
    } catch {
      return ''
    }
  }
  return target.host
}

function portOf(target: Target): number {
  if (target.kind === 'http') {
    try {
      const url = new URL(target.url)
      return Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    } catch {
      return 443
    }
  }
  return target.port
}

/** 待办里的原因是服务端写的英文标识，翻成中文再进事件 */
function reasonText(reason: string): string {
  switch (reason) {
    case 'web-pin':
      return '在网页上手动选择'
    case 'web-unpin':
      return '在网页上取消手动选择'
    case 'manual-probe':
      return '在网页上手动探测'
    default:
      return reason
  }
}

/** 限定并发地跑一批任务，结果按原顺序放回去 */
async function runLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor
      cursor += 1
      results[index] = await tasks[index]()
    }
  })
  await Promise.all(workers)
  return results
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
