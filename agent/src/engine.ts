/**
 * 主循环。一轮办五件事：拿服务端归一化好的节点和分组、生成配置交给 sing-box、
 * 跑一轮探测、把结论落到 selector 上、上报。
 *
 * 顺序有讲究：配置先生效（探测进程和 selector 都依赖它），再探测（拿到这一轮的结论），
 * 再执行网页上排下来的待办（固定节点要先记下来，下结论时才会尊重它），
 * 然后下结论、落到 selector 上，最后上报。
 *
 * 订阅不经过这里：上游有几个订阅、链接是什么，设备一概不知道。节点池由服务端自己
 * 拉取和归一化，设备只拿归一化之后的结果。
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
import { DIRECT } from '../../shared/types.ts'
import { candidateIds } from '../../shared/candidates.ts'
import { blockRuleSetTag, buildConfig } from '../../shared/singbox.ts'
import type { BuiltConfig } from '../../shared/singbox.ts'
import { probeTarget, type ProbeContext } from './probe.ts'
import { applyRound, chooseActive, SWITCH_ROUNDS, type Choice, type NodeOpinion, type Outpaced } from './health.ts'
import { openProbeRuntime, type ProbeRuntime } from './runtime.ts'
import type { ClashSelector } from './singbox.ts'
import type { PendingSwitch } from './client.ts'
import { AGENT_VERSION } from './client.ts'
import type { Reporter } from './reporter.ts'
import type { Supervisor } from './supervisor.ts'
import type { AgentState } from './config.ts'

/** 一轮探测最多同时开这么多连接，避免把本机端口用完 */
const PROBE_CONCURRENCY = 8
const PROBE_HISTORY_MAX = 40

/**
 * 一个分组在本机的运行状态，只活在内存里，重启后重新探测。
 *
 * decided 是这个 Agent 算出来的结论，undefined 表示还没下结论（候选全都还没测过）。
 * 设备上真正在用的是 selector 里的值，两者可能对不上（切换失败、程序重启过），
 * 所以上报的出口以 selector 为准。
 */
interface GroupState {
  healths: Map<string, NodeHealth>
  decided: string | null | undefined
  /** 当前节点连续被比下去的记录，见 health.ts 的 SWITCH_ROUNDS */
  outpaced: Outpaced | null
  /** 设备上实际在用的出口；null 表示已阻断或还没读到 */
  active: string | null
  allFail: boolean
  /**
   * 下一次出口变化是因为什么：全部不可用改走直连、或者从全部不可用里恢复。
   * 结论是在 decide 里下的，出口真正变了是在 reconcile 里，原因得这样带过去，
   * 不然直连会被记成一次普通切换、恢复会被记成别人改的。
   */
  cause: 'all-down' | 'recovered' | null
  /**
   * 自动切换时当前节点为什么被换掉，跟 cause 一样从 decide 带到 reconcile 去记事件。
   * 记着是为哪个节点算的：切换失败了下一轮接着切，那时 decide 不会再算一遍原因
   */
  why: { nodeId: string; text: string } | null
  /** 读到过一次 selector 了没有。第一次读到的是启动前就在的状态，不算切换 */
  synced: boolean
  lastRoundAt: string | null
  lastSwitch: SwitchRecord | null
  nextProbeAt: number
}

export class Engine {
  private readonly groups = new Map<string, GroupState>()
  /** 探测结果按「节点|目标」存，上报时整理成矩阵 */
  private readonly latest = new Map<string, ProbeDetail>()
  private readonly history = new Map<string, ProbeSample[]>()

  private nodes: StoredNode[] = []
  private events: AppEvent[] = []
  private runtime: ProbeRuntime | null = null
  private runtimeKey = ''
  private readonly pins = new Map<string, string>()
  /** 这一轮要阻断的规则集 tag */
  private blocking = new Set<string>()
  private forceProbe = false
  private stopped = false
  private readonly wake = new Wake()
  /** 同一个生成问题只提示一次，别每轮刷屏 */
  private readonly warned = new Set<string>()

  private readonly state: AgentState
  private readonly reporter: Reporter
  private readonly supervisor: Supervisor

  constructor(state: AgentState, reporter: Reporter, supervisor: Supervisor) {
    this.state = state
    this.reporter = reporter
    this.supervisor = supervisor
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
      await this.wake.wait(Math.max(5, intervalSec) * 1000)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.wake.stop()
    const runtime = this.runtime
    this.runtime = null
    this.runtimeKey = ''
    await runtime?.stop()
  }

  /** 一轮，返回下一轮隔多久 */
  private async cycle(): Promise<number> {
    const snapshot = await this.reporter.bootstrap()
    this.nodes = snapshot.nodes
    this.syncGroups(snapshot.groups)
    this.syncPins(snapshot.pins)

    const built = this.build(snapshot.groups)
    await this.supervisor.apply(built, this.blocking)
    // 手动探测：这一轮所有该探的都重探一次
    if (snapshot.pending.some((item) => item.reason === 'manual-probe')) this.forceProbe = true
    await this.ensureRuntime(built, snapshot.groups)
    await this.probeAll(snapshot.groups, snapshot.targets, built)
    // 固定节点先落下来：decide 要知道它，否则会先按探测结果切一次、再被固定切回去
    await this.applyPending(snapshot.pending, built)

    this.blocking = new Set<string>()
    for (const group of snapshot.groups) this.decide(group, built)
    await this.supervisor.setBlocking(this.blocking)

    // 切换执行完了再读 selector 成员，这样上报的是这一轮切换之后的结果
    const members = await this.reconcile(snapshot.groups, built)
    this.pruneProbes(snapshot.groups)

    const answer = await this.reporter.report(this.buildReport(snapshot.groups, members))
    // 事件交上去就不必再留，下一轮重新攒
    this.events = []
    this.forceProbe = false
    return answer.reportIntervalSec
  }

  /** 生成本机代理的配置。managed 一给，自动分组就是 selector，Agent 才切得动 */
  private build(groups: Group[]): BuiltConfig {
    const built = buildConfig({
      nodes: this.nodes,
      groups,
      listen: this.state.proxyListen,
      managed: {
        clashApi: this.state.clashApi,
        clashSecret: this.state.clashSecret,
        dataDir: this.state.dataDir,
      },
    })
    this.noteWarnings(built.warnings)
    return built
  }

  private noteWarnings(warnings: string[]): void {
    for (const warning of warnings) {
      if (this.warned.has(warning)) continue
      this.warned.add(warning)
      console.error(`配置提醒：${warning}`)
    }
  }

  /** 分组增删时同步本地状态；消失的分组状态一并丢掉 */
  private syncGroups(groups: Group[]): void {
    const seen = new Set(groups.map((g) => g.id))
    for (const group of groups) {
      if (this.groups.has(group.id)) continue
      this.groups.set(group.id, {
        healths: new Map(),
        decided: undefined,
        outpaced: null,
        active: null,
        allFail: false,
        cause: null,
        why: null,
        synced: false,
        lastRoundAt: null,
        lastSwitch: null,
        nextProbeAt: 0,
      })
    }
    for (const id of [...this.groups.keys()]) {
      if (!seen.has(id)) this.groups.delete(id)
    }
  }

  /**
   * 对齐网页上的固定节点。
   *
   * 每次都整份覆盖：用户取消固定后 pins 里就没有这一项了，只做增量的写法
   * 会让取消不生效。
   */
  private syncPins(pins: Record<string, string>): void {
    this.pins.clear()
    for (const [groupId, nodeId] of Object.entries(pins)) this.pins.set(groupId, nodeId)
  }

  /**
   * 决定每个分组该走哪个节点，只改内存里的结论，不碰 sing-box。
   *
   * 手动分组不探测：出口就是固定的那个节点，没有就取第一个启用的候选。
   * 自动分组按健康度和策略挑；一个可用的都没有时按「全部节点都不可用时」处理。
   * 候选全都还没测出结论（unknown）时不下结论，出口保持不动——
   * 刚启动就切一次是没有意义的。还没读到过设备上现在走的是谁，也先不换节点。
   *
   * 阻断要每轮都重新加进 this.blocking：这个集合每轮清空重算，漏一轮规则集就会被清掉，
   * 阻断就悄悄失效了。
   */
  private decide(group: Group, built: BuiltConfig): void {
    const state = this.groups.get(group.id)
    if (!state) return
    // 原因只管这一轮：上一轮没用上的（比如切换失败了）不能留到以后的某次切换上
    state.cause = null
    if (!this.selectorTagSet(built).has(group.selectorTag)) return

    // 停用的节点不在配置里，切过去必然失败
    const enabled = candidateIds(group, this.nodes).filter((id) => built.tagOf.has(id))
    const pin = this.pins.get(group.id) ?? null
    const pinned = pin !== null && enabled.includes(pin)

    if (group.selection === 'manual') {
      state.decided = pinned ? pin : (enabled[0] ?? null)
      state.outpaced = null
      state.allFail = false
      return
    }

    // 固定节点是用户直接指定的，不进选节点的流程，攒的轮数跟着作废
    if (pinned) {
      if (state.allFail) state.cause = 'recovered'
      state.decided = pin
      state.outpaced = null
      state.allFail = false
      return
    }

    const choice = chooseActive(group, state.healths, enabled, state.decided ?? null, state.outpaced, state.lastRoundAt)
    state.outpaced = choice.outpaced
    const pick = choice.pick
    if (pick) {
      // 还没读到过设备上的 selector，不知道现在走的是谁。先让 reconcile 把它认作现任
      // （Agent、sing-box 重启后 cache_file 会恢复上一次的选择），下一轮再按健康度判断。
      // 现在就挑的话是拿「没有现任」去比，会直接换到这一轮最快的节点，连续几轮才换的防抖就白设了
      if (!state.synced && state.decided === undefined) return
      if (state.allFail) state.cause = 'recovered'
      const current = state.decided ?? null
      if (choice.why) {
        state.why = { nodeId: pick, text: this.whyText(choice.why, group, state, enabled, current, pick, built) }
      }
      state.decided = pick
      state.allFail = false
      return
    }

    // 一个可用的都没有，没什么可比的
    state.outpaced = null

    // 没有可用的节点：候选还没测过就再等等，别急着切。
    // 已经在阻断的继续阻断——新加进来的节点还没测出结论，不能因此把阻断撤掉。
    if (enabled.some((id) => (state.healths.get(id)?.state ?? 'unknown') === 'unknown')) {
      if (state.allFail && group.onAllFail === 'block') this.blocking.add(blockRuleSetTag(group))
      return
    }

    const first = !state.allFail
    state.allFail = true

    if (group.onAllFail === 'block') {
      // 阻断靠规则集，selector 指着谁都拦得住，不用去动它
      this.blocking.add(blockRuleSetTag(group))
      state.decided = null
      state.outpaced = null
      if (first) {
        // 刚启动时还没读过 selector，不知道之前走的是谁，就不记切换了
        if (state.active !== null) {
          state.lastSwitch = {
            at: new Date().toISOString(),
            from: state.active,
            to: null,
            reason: '节点全都不可用，已阻断',
          }
        }
        this.events.push(
          this.event(group, 'all-down', 'warn', {
            from: state.active,
            to: null,
            message: `「${group.name}」的节点全都不可用，已阻断这个分组的新连接（不会走直连）`,
          }),
        )
        state.active = null
      }
      return
    }

    if (group.onAllFail === 'direct') {
      // 事件等 selector 真的切到直连再记，切失败的话这里记了就是假的。
      // 每轮都带上原因：这一轮没切成，下一轮重试时还得知道是为什么
      state.cause = 'all-down'
      state.decided = DIRECT
      return
    }

    // 保持当前节点：出口不变，不记切换。事件留到 reconcile 读到 selector 再发——
    // 刚启动时还不知道设备上指着谁，这里写的名字会是错的。
    // 还没读到过 selector（sing-box 没起来）就每轮都带上，读到的那一轮再说
    if (first || !state.synced) state.cause = 'all-down'
  }

  /**
   * 把结论落到设备上：读 selector 现在指谁，跟结论不一样就切，再把实际结果记下来。
   *
   * 出口以 selector 为准。切换失败、sing-box 刚重启（cache_file 会恢复上一次的选择）、
   * 有人在别处改过，这些情况下设备上的值都可能跟结论对不上。
   */
  private async reconcile(
    groups: Group[],
    built: BuiltConfig,
  ): Promise<Map<string, string[] | null>> {
    const members = new Map<string, string[] | null>()
    const selectorTags = this.selectorTagSet(built)
    const idOfTag = invert(built.tagOf)

    const entries = await runLimited(
      groups.map((group) => async () => {
        const state = this.groups.get(group.id)
        if (!state) return [group.id, null] as const
        // 没生成 selector 的分组（没有可用的候选、tag 重名），它的流量直接被拒绝
        if (!selectorTags.has(group.selectorTag)) {
          state.active = null
          return [group.id, null] as const
        }
        // sing-box 没起来时问不到，什么都不改，等它起来
        if (!this.supervisor.running) return [group.id, null] as const

        let selector: ClashSelector | null = null
        try {
          selector = await this.supervisor.clash.getSelector(group.selectorTag)
        } catch (err) {
          console.error(
            `读取「${group.name}」的 selector 失败：`,
            err instanceof Error ? err.message : String(err),
          )
        }
        // 读不到就什么都不改，别因为一次读取失败报一次假的切换
        if (!selector) return [group.id, null] as const

        const ids = selector.all.map((tag) => (tag === DIRECT ? DIRECT : idOfTag.get(tag) ?? tag))
        const observed = selector.now === DIRECT ? DIRECT : idOfTag.get(selector.now) ?? null

        if (this.blocking.has(blockRuleSetTag(group))) {
          state.active = null
          state.synced = true
          return [group.id, ids] as const
        }

        // 第一次读到之前，本机还没有结论（decided 是 undefined）。把设备上实际在用的
        // 那个当成本机的结论，而不是拿它跟空的结论比：Agent 重启、sing-box 重启
        // （cache_file 会恢复上一次的选择）之后都该接着用现在这个，
        // 至于它还合不合适，交给下一轮 decide 按健康度判断。
        if (state.decided === undefined && observed !== null) state.decided = observed

        const next = state.decided
        let now = observed
        let ours = false
        if (next !== undefined && next !== null && next !== observed && (await this.select(group, next, built))) {
          now = next
          ours = true
        }

        const cause = state.cause
        state.cause = null
        // 第一次读到之前不知道设备上走的是谁，就拿读到的值当「之前」：
        // 启动前就在的状态不算切换，但这一轮真的切了还是要记
        const before = state.synced ? state.active : observed
        state.synced = true
        state.active = now

        if (cause === 'all-down' && group.onAllFail === 'keep-last') {
          // 「保持当前节点」：出口不动，说一声就行
          this.events.push(
            this.event(group, 'all-down', 'warn', {
              nodeId: now,
              from: now,
              to: now,
              message: now
                ? `「${group.name}」的节点全都不可用，保持在 ${this.tagOf(now, built)} 上`
                : `「${group.name}」的节点全都不可用，现在没有可用的出口`,
            }),
          )
          if (now !== before) this.noteSwitch(group, state, before, now, ours, null, built)
          return [group.id, ids] as const
        }
        if (now !== before) {
          this.noteSwitch(group, state, before, now, ours, cause, built)
        } else if (cause === 'recovered' && now !== null) {
          // 「保持当前节点」的分组恢复时出口没变，不算切换，但要让人知道恢复了
          this.events.push(
            this.event(group, 'recovered', 'good', {
              nodeId: now,
              from: now,
              to: now,
              message: `「${group.name}」恢复了，继续走 ${this.tagOf(now, built)}`,
            }),
          )
        }
        return [group.id, ids] as const
      }),
      // 本机接口，开太多并发没意义，还容易打满 sing-box 的连接数
      4,
    )
    for (const [id, list] of entries) members.set(id, list)
    return members
  }

  /**
   * 切一个分组的 selector，成功返回 true。
   *
   * 这里不改内存里的状态：切失败时下一轮还会算出同样的结论再试一次，
   * 先改成"已切换"会让网页显示一个设备上并不成立的状态。
   */
  private async select(group: Group, next: string, built: BuiltConfig): Promise<boolean> {
    const tag = next === DIRECT ? DIRECT : built.tagOf.get(next)
    if (!tag) {
      console.error(`「${group.name}」要切到的节点不在配置里（${next}），跳过。`)
      return false
    }
    try {
      await this.supervisor.clash.select(group.selectorTag, tag)
      return true
    } catch (err) {
      console.error(
        `切换「${group.name}」失败：`,
        err instanceof Error ? err.message : String(err),
      )
      return false
    }
  }

  /**
   * 记一次设备上真实发生的出口变化：切换记录和事件都在这里，from/to 一律是节点 id。
   *
   * ours 表示这次是 Agent 自己切的；不是的话就是在设备上被改了（有人用别的面板切过、
   * sing-box 重启后恢复了旧的选择），照实记成外部变化。
   */
  private noteSwitch(
    group: Group,
    state: GroupState,
    from: string | null,
    to: string | null,
    ours: boolean,
    cause: GroupState['cause'],
    built: BuiltConfig,
  ): void {
    const name = to === null ? '（没有出口）' : this.tagOf(to, built)

    let kind: AppEvent['kind'] = 'switch'
    let severity: AppEvent['severity'] = 'info'
    let message: string
    let reason: string
    if (cause === 'all-down' && to === DIRECT) {
      kind = 'all-down'
      severity = 'warn'
      message = `「${group.name}」的节点全都不可用，流量改走直连`
      reason = '节点全都不可用，改走直连'
    } else if (cause === 'recovered') {
      kind = 'recovered'
      severity = 'good'
      message = `「${group.name}」恢复了，改走 ${name}`
      reason = '节点恢复了'
    } else if (ours) {
      message = `「${group.name}」改走 ${name}`
      if (to !== null && this.pins.get(group.id) === to) reason = '按手动选择切换'
      else if (group.selection === 'manual') reason = '没有手动选择，用分组里第一个候选节点'
      else if (to !== null && state.why?.nodeId === to) {
        reason = state.why.text
        message += `：${reason}`
      } else reason = '按分组规则自动切换'
    } else {
      message = `「${group.name}」在设备上被改成了 ${name}`
      reason = '设备上的选择变了'
    }

    state.lastSwitch = { at: new Date().toISOString(), from, to, reason }
    state.why = null
    this.events.push(this.event(group, kind, severity, { nodeId: to, from, to, message }))
  }

  /** 自动切换时当前节点为什么被换掉，写进切换事件：网页上只看得到事件，得在这里说清楚 */
  private whyText(
    why: NonNullable<Choice['why']>,
    group: Group,
    state: GroupState,
    enabled: string[],
    current: string | null,
    pick: string,
    built: BuiltConfig,
  ): string {
    if (why === 'failback') return `排在前面的 ${this.tagOf(pick, built)} 能用了，按设置切回去`
    if (current === null) return '之前没有出口'
    const from = this.tagOf(current, built)
    const health = state.healths.get(current)
    if (why === 'slower') {
      const a = health?.latencyMs ?? null
      const b = state.healths.get(pick)?.latencyMs ?? null
      const gap = a !== null && b !== null ? `，现在慢 ${a - b} ms` : ''
      return `${from} 连续 ${SWITCH_ROUNDS} 轮比最快的节点慢 ${group.toleranceMs} ms 以上${gap}`
    }
    if (!enabled.includes(current)) return `${from} 不在候选节点里了`
    if (health?.state === 'down' && health.consecutiveFails > 0) {
      return `${from} 连续 ${health.consecutiveFails} 轮没通过分组规则`
    }
    if (health?.state === 'down') return `${from} 不可用`
    return `${from} 还没通过分组规则`
  }

  /** 探测进程的出站列表写死在配置里，节点集合变了就得重启它 */
  private async ensureRuntime(built: BuiltConfig, groups: Group[]): Promise<void> {
    const wanted = autoCandidateIds(groups, this.nodes, built)
    if (!wanted.length) {
      if (this.runtime) {
        const runtime = this.runtime
        this.runtime = null
        this.runtimeKey = ''
        await runtime.stop()
      }
      return
    }

    const nodes = wanted
      .map((id) => this.nodes.find((n) => n.id === id))
      .filter((n): n is StoredNode => n !== undefined && n.enabled)
    /*
     * 出站集合写死在配置里，节点变了（增删、启停）就得重启探测进程。
     *
     * 键只取节点 id 和出站内容，不取整份配置：配置里有随机生成的 SOCKS 密码、
     * 探测进程自己选的端口，每次算出来都不一样，拿它当键会每轮都重启一次。
     */
    const key = `${nodes.map((n) => n.id).join(',')}|${JSON.stringify(
      nodes.map((n) => [n.id, n.outbound]),
    )}`
    if (this.runtime && this.runtimeKey === key) return

    const previous = this.runtime
    this.runtime = null
    this.runtimeKey = ''
    await previous?.stop()

    try {
      this.runtime = await openProbeRuntime({
        state: this.state,
        nodes,
        onExit: (reason, output) => {
          this.runtime = null
          this.runtimeKey = ''
          console.error(`探测进程退出了（${reason}），下一轮重新拉起。${output ? `它最后的输出：\n${output}` : ''}`)
        },
      })
      this.runtimeKey = key
    } catch (err) {
      // 先清干净再等下轮重试：留着的话下一轮会以为已经就绪，再也不重试
      this.runtimeKey = ''
      console.error(`探测进程没能启动：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 探测一轮。手动分组不探测——它的意义就是"我说用哪个就用哪个"。
   *
   * 探测进程不在（没起来、刚退出）时跳过，但不清空已有的健康状态：
   * 那只是这一轮没测成，不代表节点坏了。
   */
  private async probeAll(groups: Group[], targets: Target[], built: BuiltConfig): Promise<void> {
    const runtime = this.runtime
    const now = Date.now()

    for (const group of groups) {
      const state = this.groups.get(group.id)
      if (!state || group.selection === 'manual') continue
      const enabled = candidateIds(group, this.nodes).filter((id) => built.tagOf.has(id))
      if (!enabled.length) continue
      const due = this.forceProbe || !state.lastRoundAt || now >= state.nextProbeAt
      if (!runtime || !due) continue
      state.nextProbeAt = now + Math.max(5, group.probeIntervalSec) * 1000

      const byId = new Map(targets.map((t) => [t.id, t]))
      const rules = group.targetIds
        .map((id) => byId.get(id))
        .filter((t): t is Target => t !== undefined)
      if (!rules.length) continue

      const live = enabled
        .map((id) => this.nodes.find((n) => n.id === id))
        .filter((n): n is StoredNode => n !== undefined)
      const at = new Date().toISOString()
      const opinions = await this.runProbes(group, live, rules, runtime)
      const healths: NodeHealth[] = []
      for (const opinion of opinions) {
        const { health, changed } = applyRound(group, state.healths.get(opinion.nodeId), opinion, at)
        healths.push(health)
        if (changed) this.noteHealthChange(group, opinion, health, changed, byId)
      }
      state.healths = new Map(healths.map((h) => [h.nodeId, h]))
      state.lastRoundAt = at
    }
  }

  /** 一个节点一轮里要过完所有规则：全部通过或任意通过取决于分组设置 */
  private async runProbes(
    group: Group,
    nodes: ProxyNode[],
    rules: Target[],
    runtime: ProbeRuntime,
  ): Promise<NodeOpinion[]> {
    const tasks = nodes.map((node) => async (): Promise<NodeOpinion> => {
      const details: ProbeDetail[] = []
      const failing: string[] = []

      for (const target of rules) {
        const ctx: ProbeContext = {
          ...runtime.endpointFor(node.id),
          host: hostOf(target),
          port: portOf(target),
          timeoutMs: target.timeoutMs,
        }
        const detail = await probeTarget(target, ctx)
        details.push(detail)
        if (!detail.ok) failing.push(target.id)

        const key = `${node.id}|${target.id}`
        this.latest.set(key, detail)
        this.history.set(key, [...(this.history.get(key) ?? []), sampleOf(detail)].slice(-PROBE_HISTORY_MAX))
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
    const tag = this.tagOf(opinion.nodeId, null)
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
  private async applyPending(pending: PendingSwitch[], built: BuiltConfig): Promise<void> {
    if (!pending.length) return
    const acked: string[] = []

    for (const item of pending) {
      const state = this.groups.get(item.group_id)
      if (item.group_id === '' || item.reason === 'manual-probe') {
        // 手动探测已经在上面处理过了
        acked.push(item.id)
        continue
      }
      if (!state) {
        // 分组已经没了，这条待办没有意义
        acked.push(item.id)
        continue
      }
      const group = this.reporter.groupById(item.group_id)
      if (!group) {
        acked.push(item.id)
        continue
      }

      try {
        const to = item.node_id
        if (to) {
          if (!this.supervisor.running) {
            throw new Error(this.supervisor.error ?? 'sing-box 还没有启动')
          }
          if (!this.selectorTagSet(built).has(group.selectorTag)) {
            throw new Error(`「${group.name}」在这台设备上没有可用的候选节点，没法切换`)
          }
          const tag = built.tagOf.get(to)
          if (!tag || !candidateIds(group, this.nodes).includes(to)) {
            throw new Error(`「${this.tagOf(to, built)}」不在这个分组的候选节点里，或者已经停用了`)
          }
          await this.supervisor.clash.select(group.selectorTag, tag)
          this.pins.set(item.group_id, to)

          // 还没读过 selector 时不知道之前走的是谁，切换记录就不写了，免得写出一个假的来处
          const from = state.synced ? state.active : null
          if (state.synced && from !== to) {
            state.lastSwitch = { at: new Date().toISOString(), from, to, reason: reasonText(item.reason) }
          }
          // 固定的节点就是结论。从全部不可用里被手动救回来的，阻断也要跟着撤掉
          state.decided = to
          state.active = to
          state.outpaced = null
          state.allFail = false
          state.synced = true
          this.events.push(
            this.event(group, 'pin', 'info', {
              nodeId: to,
              from,
              to,
              message: `「${group.name}」手动选择了 ${this.tagOf(to, built)}`,
            }),
          )
        } else {
          // 取消只是不再固定，出口先不动：这一轮 decide 会按分组规则重新挑，
          // 真的换了节点由 reconcile 照实记一次切换
          this.pins.delete(item.group_id)
          this.events.push(
            this.event(group, 'unpin', 'info', { message: `「${group.name}」取消了手动选择` }),
          )
        }
        acked.push(item.id)
      } catch (err) {
        /*
         * 失败要报上去，不能只是不 ack。
         *
         * 不 ack 的话服务器下一轮还会把这一条发下来——对暂时性故障这是好事，重试几次
         * 自己就好了。但对永久性故障（节点不在 selector 的 outbounds 里、分组被删了）
         * 它会一直重试到天荒地老，网页上永远显示"正在切换"，而失败原因只有这台机器的
         * 日志里有，用户看不到。
         *
         * 报上去之后服务端累计次数，够了就放弃并把原因写进事件，网页上变成"切换失败"，
         * 由用户决定重试还是撤掉。
         */
        const message = err instanceof Error ? err.message : String(err)
        console.error(`切换「${group.name}」失败：`, message)
        try {
          await this.reporter.failPending(item.id, message)
        } catch (reportErr) {
          // 连失败都报不上去（网络断了）。这一条下一轮还会领到，已经记过日志了，不重复刷屏
          console.error(
            '上报切换失败时出错：',
            reportErr instanceof Error ? reportErr.message : String(reportErr),
          )
        }
      }
    }

    if (acked.length) await this.reporter.ack(acked)
  }

  /**
   * 只留下还在用的探测结果：节点换了、分组规则改了、分组改成手动了，
   * 旧结果都该扔掉，否则网页的矩阵里会一直挂着早就不测的格子。
   */
  private pruneProbes(groups: Group[]): void {
    const keep = new Set<string>()
    for (const group of groups) {
      if (group.selection === 'manual') continue
      const state = this.groups.get(group.id)
      if (!state) continue
      // 目标按这个分组自己的规则取，不能混进别的分组的
      for (const nodeId of state.healths.keys()) {
        for (const targetId of group.targetIds) keep.add(`${nodeId}|${targetId}`)
      }
    }
    for (const key of [...this.latest.keys()]) {
      if (!keep.has(key)) this.latest.delete(key)
    }
    for (const key of [...this.history.keys()]) {
      if (!keep.has(key)) this.history.delete(key)
    }
  }

  private buildReport(groups: Group[], members: Map<string, string[] | null>): unknown {
    return {
      device: {
        name: this.state.name,
        hostname: this.reporter.host,
        platform: this.state.platform,
        osVersion: this.reporter.osVersion,
        agentVersion: this.state.agentVersion || AGENT_VERSION,
        singboxVersion: this.supervisor.singboxVersion,
        clashApi: this.state.clashApi,
        probeInbound: this.runtime?.listen ?? '',
        dataDir: this.state.dataDir,
        proxyListen: this.supervisor.listen,
        singboxError: this.supervisor.error,
      },
      runtime: groups.map((group) => {
        const state = this.groups.get(group.id)
        return {
          groupId: group.id,
          activeNodeId: state?.active ?? null,
          pinnedNodeId: this.pins.get(group.id) ?? null,
          nodes: state ? [...state.healths.values()] : [],
          // 设备上这个 selector 认得的节点，网页拿它校验切换
          availableNodeIds: members.get(group.id) ?? null,
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
    for (const [key, last] of this.latest) {
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

  /** 节点 id 换成给人看的名字；id 认不出来时原样返回 */
  private tagOf(nodeId: string, built: BuiltConfig | null): string {
    if (nodeId === DIRECT) return '直连'
    return (
      built?.tagOf.get(nodeId) ??
      this.nodes.find((n) => n.id === nodeId)?.tag ??
      nodeId
    )
  }

  private selectorTagSet(built: BuiltConfig): Set<string> {
    const outbounds = built.config.outbounds as Array<Record<string, unknown>> | undefined
    return new Set((outbounds ?? []).map((o) => String(o.tag ?? '')))
  }
}

/** 要探测的节点：自动分组的候选里的启用节点，去重 */
function autoCandidateIds(
  groups: Group[],
  nodes: StoredNode[],
  built: BuiltConfig,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const group of groups) {
    if (group.selection === 'manual') continue
    for (const id of candidateIds(group, nodes)) {
      if (seen.has(id) || !built.tagOf.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

function invert(map: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, tag] of map) out.set(tag, id)
  return out
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

/** 可中断的等待：stop() 之后立刻返回，不用等完这一轮 */
class Wake {
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private resolve: (() => void) | null = null

  wait(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise((resolve) => {
      this.resolve = resolve
      this.timer = setTimeout(() => {
        this.timer = null
        this.resolve = null
        resolve()
      }, ms)
    })
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.resolve?.()
    this.resolve = null
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
