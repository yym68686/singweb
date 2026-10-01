import type {
  ConfigPreview,
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
import { HttpApiClient, type EnrollStatus, type RefreshResult } from './http'

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

  /**
   * 这台设备实际会拿到的 sing-box 配置。
   * group 给了就预览这份还没保存的草稿，没给就预览已保存的全部分组。
   * 里面的密钥是占位符，真正的密钥由 Agent 在本机生成。
   */
  previewConfig(q: { deviceId: string; group?: GroupInput & { id?: string } }): Promise<ConfigPreview>

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
  /**
   * id 为 null 时新建。新建、改地址、从停用改成启用这三种情况服务端会自己先拉一轮，
   * 返回的就是拉完的状态，调用方不用再补一次刷新。
   */
  saveSource(
    id: string | null,
    input: { name?: string; url?: string; enabled?: boolean },
  ): Promise<NodeSource>
  deleteSource(id: string): Promise<void>
  /** 让服务端立刻重拉一次这个订阅 */
  refreshSource(id: string): Promise<RefreshResult>

  /** 设备拿配置用的那条链接里的 token */
  getSubscription(): Promise<string>
  /** 换一个 token，旧链接立刻失效 */
  resetSubscription(): Promise<string>

  /** 生成一条接入命令用的令牌，设备页轮询它有没有被用掉 */
  createEnroll(): Promise<{ id: string; token: string; expiresAt: string }>
  getEnroll(id: string): Promise<EnrollStatus>

  /** 订阅数据变化；返回取消订阅函数 */
  subscribe(onMessage: (m: LiveMessage) => void): () => void
}

/** 接口前缀。订阅链接和安装命令都要拼出绝对地址，所以单独导出 */
export const API_BASE: string = import.meta.env.VITE_API_BASE || '/api/v1'

/** 把接口路径拼成浏览器当前所在站点下的绝对地址，给要复制到别处用的链接 */
export function absoluteApiUrl(path: string): string {
  return new URL(`${API_BASE.replace(/\/+$/, '')}${path}`, window.location.origin).toString()
}

export const api: ApiClient = new HttpApiClient(API_BASE)
