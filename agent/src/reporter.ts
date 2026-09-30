/**
 * 上报缓存。Engine 需要的东西大多来自服务端，每次用之前问一遍太浪费，
 * 这里存最近一次的快照，Engine 只跟这个对象打交道。
 */

import { release as osRelease, type as osType } from 'node:os'
import type { Group, StoredNode, Target } from '../../shared/types.ts'
import {
  ApiClient,
  AGENT_VERSION,
  readAgentVersion,
  type PendingSwitch,
  type ReportedNodeOut,
  type SourceRef,
} from './client.ts'
import { hostnameName, type AgentState } from './config.ts'

export interface Snapshot {
  groups: Group[]
  targets: Target[]
  nodes: StoredNode[]
  sources: SourceRef[]
  pending: PendingSwitch[]
  /** 用户在网页上固定的节点，按分组 id 索引 */
  pins: Record<string, string>
  reportIntervalSec: number
}

export class Reporter {
  private readonly api: ApiClient
  private snapshot: Snapshot = {
    groups: [],
    targets: [],
    nodes: [],
    sources: [],
    pending: [],
    pins: {},
    reportIntervalSec: 15,
  }

  private readonly state: AgentState
  /** 主机名是环境事实，算一次存下来就够了，每轮上报都要带上 */
  private readonly hostname: string

  constructor(state: AgentState, secret: string) {
    this.state = state
    this.api = new ApiClient(state.server, secret)
    this.hostname = hostnameName()
  }

  /**
   * 上报里要带的主机名。注意不能拿 state.name 顶上：那是设备名，
   * 用户随时能改，跟主机名是两回事。
   */
  get host(): string {
    return this.hostname
  }

  /** 拉一次服务端状态，顺便领取待办 */
  async bootstrap(): Promise<Snapshot> {
    const answer = await this.api.bootstrap()
    this.snapshot = {
      groups: answer.groups,
      targets: answer.targets,
      nodes: answer.nodes,
      sources: answer.sources,
      pending: answer.pending,
      pins: answer.pins,
      reportIntervalSec: answer.reportIntervalSec,
    }
    return this.snapshot
  }

  get current(): Snapshot {
    return this.snapshot
  }

  groupById(id: string): Group | null {
    return this.snapshot.groups.find((g) => g.id === id) ?? null
  }

  /** 上报并领取下一批待办 */
  async report(payload: unknown): Promise<{ pending: PendingSwitch[]; reportIntervalSec: number }> {
    const answer = await this.api.report(payload)
    this.snapshot.pending = answer.pending
    this.snapshot.reportIntervalSec = answer.reportIntervalSec
    return answer
  }

  async ack(ids: string[]): Promise<void> {
    await this.api.ack(ids)
  }

  fetchSource(source: SourceRef): Promise<string> {
    return this.api.fetchSource(source)
  }

  sourceResult(
    sourceId: string,
    error: string | null,
    nodes: ReportedNodeOut[],
  ): Promise<void> {
    return this.api.sourceResult(sourceId, error, nodes)
  }

  /** 本机信息，接入和上报都用这一份 */
  async deviceInfo(): Promise<{
    name: string
    hostname: string
    platform: 'macos' | 'linux'
    osVersion: string
    agentVersion: string
  }> {
    return {
      name: this.state.name,
      hostname: this.hostname,
      platform: this.state.platform,
      osVersion: `${osType()} ${osRelease()}`,
      agentVersion: this.state.agentVersion || (await readAgentVersion()),
    }
  }
}

export { AGENT_VERSION }
