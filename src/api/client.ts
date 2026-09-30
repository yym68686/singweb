import type {
  Device,
  EventPage,
  EventQuery,
  Group,
  GroupInput,
  GroupRuntime,
  LiveMessage,
  NodeSource,
  ProbeCell,
  ProxyNode,
  Target,
  TargetInput,
  User,
} from './types'
import { HttpApiClient } from './http'

export interface ApiClient {
  /** 当前登录的账号，没登录时是 null。它不抛错，前端靠它决定要不要跳登录页 */
  me(): Promise<User | null>
  /** 用户名或密码不对时抛 ApiError（status 401） */
  login(username: string, password: string): Promise<User>
  logout(): Promise<void>

  getDevices(): Promise<Device[]>
  getDevice(id: string): Promise<Device>

  getNodes(): Promise<ProxyNode[]>
  updateNode(id: string, patch: { enabled: boolean }): Promise<ProxyNode>

  getTargets(): Promise<Target[]>
  /** id 为 null 时新建 */
  saveTarget(id: string | null, input: TargetInput): Promise<Target>
  deleteTarget(id: string): Promise<void>

  getGroups(): Promise<Group[]>
  getGroup(id: string): Promise<Group>
  /** id 为 null 时新建 */
  saveGroup(id: string | null, input: GroupInput): Promise<Group>
  deleteGroup(id: string): Promise<void>

  getRuntimes(q?: { deviceId?: string }): Promise<GroupRuntime[]>
  getProbeCells(q?: { deviceId?: string; nodeId?: string }): Promise<ProbeCell[]>

  /**
   * 自动分组：手动固定节点，nodeId 为 null 时取消固定、恢复自动切换。
   * 手动分组：选择节点，nodeId 为 null 时回到第一个启用的候选节点
   */
  setPin(deviceId: string, groupId: string, nodeId: string | null): Promise<GroupRuntime>
  /** 重试一条放弃了的切换，让设备再执行一次 */
  retryPending(deviceId: string, groupId: string, pendingId: string): Promise<void>
  /** 让设备立即跑一轮探测 */
  probeNow(deviceId: string): Promise<void>

  getEvents(q: EventQuery): Promise<EventPage>

  getSources(): Promise<NodeSource[]>
  /** id 为 null 时新建 */
  saveSource(
    id: string | null,
    input: { name?: string; url?: string; enabled?: boolean; refresh?: boolean },
  ): Promise<NodeSource>
  deleteSource(id: string): Promise<void>
  /** 让设备重新拉一次订阅 */
  refreshSource(id: string): Promise<void>

  /** 订阅数据变化；返回取消订阅函数 */
  subscribe(onMessage: (m: LiveMessage) => void): () => void
}

export const api: ApiClient = new HttpApiClient(import.meta.env.VITE_API_BASE || '/api/v1')
