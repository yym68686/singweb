/**
 * 上报缓存。Engine 需要的东西大多来自服务端，每次用之前问一遍太浪费，
 * 这里存最近一次的快照，Engine 只跟这个对象打交道。
 *
 * 快照里没有订阅：上游订阅只有服务端知道，设备拿到的是归一化之后的节点池。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { platform as osPlatform, release as osRelease, type as osType } from 'node:os'
import type { Group, StoredNode, Target } from '../../shared/types.ts'
import { ApiClient, AGENT_VERSION, type PendingSwitch } from './client.ts'
import { hostnameName, type AgentState } from './config.ts'

export interface Snapshot {
  groups: Group[]
  targets: Target[]
  nodes: StoredNode[]
  pending: PendingSwitch[]
  /** 用户在网页上固定的节点，按分组 id 索引 */
  pins: Record<string, string>
  /** 服务端多久没收到上报就当设备离线 */
  offlineAfterSec: number
  reportIntervalSec: number
}

export class Reporter {
  private readonly api: ApiClient
  private snapshot: Snapshot = {
    groups: [],
    targets: [],
    nodes: [],
    pending: [],
    pins: {},
    offlineAfterSec: 90,
    reportIntervalSec: 15,
  }

  /** 主机名和系统版本是环境事实，算一次存下来就够了，每轮上报都要带上 */
  private readonly hostname: string
  private readonly os: string

  constructor(state: AgentState, secret: string) {
    this.api = new ApiClient(state.server, secret)
    this.hostname = hostnameName()
    this.os = osVersionText()
  }

  /**
   * 上报里要带的主机名。注意不能拿 state.name 顶上：那是设备名，
   * 用户随时能改，跟主机名是两回事。
   */
  get host(): string {
    return this.hostname
  }

  /** 给人看的系统版本，比如 macOS 15.5 */
  get osVersion(): string {
    return this.os
  }

  /** 拉一次服务端状态，顺便领取待办 */
  async bootstrap(): Promise<Snapshot> {
    const answer = await this.api.bootstrap()
    this.snapshot = {
      groups: answer.groups,
      targets: answer.targets,
      nodes: answer.nodes,
      pending: answer.pending,
      pins: answer.pins,
      offlineAfterSec: answer.offlineAfterSec,
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

  /** 报告一条待办执行失败，服务端据此累加次数 */
  async failPending(id: string, error: string): Promise<{ abandoned: boolean }> {
    return this.api.failPending(id, error)
  }
}

/**
 * 给人看的系统版本。各家系统的版本号藏在不同地方，取不到就退回内核版本，
 * 这一项只是显示用，不能因为它让接入失败。
 */
export function osVersionText(): string {
  try {
    const platform = osPlatform()
    if (platform === 'darwin') {
      const version = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 3000 }).trim()
      if (version) return `macOS ${version}`
    }
    if (platform === 'linux') {
      const pretty = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))
      if (pretty) return pretty[1]
    }
    if (platform === 'win32') {
      // Windows 11 报的内核版本还是 10.0.x，得看内部版本号：22000 起就是 11
      const release = osRelease()
      const [major, , build] = release.split('.').map(Number)
      if (major === 10) return `Windows ${build >= 22000 ? 11 : 10}（${release}）`
      return `Windows ${release}`
    }
  } catch {
    // 走下面的兜底
  }
  return `${osType()} ${osRelease()}`
}

export { AGENT_VERSION }
