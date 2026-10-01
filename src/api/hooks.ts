import { useEffect, useState } from 'react'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from './client'
import { ApiError } from './errors'
import type { EventQuery, GroupInput, TargetInput, UpdateScope } from './types'

export const keys = {
  user: ['user'] as const,
  devices: ['devices'] as const,
  device: (id: string) => ['devices', id] as const,
  nodes: ['nodes'] as const,
  sources: ['sources'] as const,
  targets: ['targets'] as const,
  groups: ['groups'] as const,
  group: (id: string) => ['groups', id] as const,
  runtimes: (deviceId?: string) => ['runtimes', deviceId ?? 'all'] as const,
  probes: (deviceId?: string, nodeId?: string) => ['probes', deviceId ?? 'all', nodeId ?? 'all'] as const,
  events: (q: EventQuery) => ['events', q] as const,
  subscription: ['subscription'] as const,
  enroll: (id: string) => ['enroll', id] as const,
}

export const useMe = () =>
  useQuery({
    queryKey: keys.user,
    queryFn: () => api.me(),
    // 会话状态问一次就够了：过期由 401 广播处理，这里不需要轮询
    staleTime: Infinity,
    // 401 是"没登录"，不是故障，重试只会拖慢进登录页
    retry: false,
  })

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      api.login(username, password),
    onSuccess: (user) => {
      // 直接写进缓存：登录页据此立刻跳转，不用再问一次 /auth/me
      qc.setQueryData(keys.user, user)
      // 上一个账号留在缓存里的数据不能给新账号看
      void qc.invalidateQueries()
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => {
      // 退出后把缓存整个丢掉，避免下一个登录的人看到上一个人的数据
      qc.clear()
      qc.setQueryData(keys.user, null)
    },
  })
}

export const useDevices = () => useQuery({ queryKey: keys.devices, queryFn: () => api.getDevices() })
export const useDevice = (id: string) =>
  useQuery({ queryKey: keys.device(id), queryFn: () => api.getDevice(id), retry: false })
export const useNodes = () => useQuery({ queryKey: keys.nodes, queryFn: () => api.getNodes() })
export const useSources = () =>
  useQuery({ queryKey: keys.sources, queryFn: () => api.getSources() })
export const useTargets = () => useQuery({ queryKey: keys.targets, queryFn: () => api.getTargets() })
export const useGroups = () => useQuery({ queryKey: keys.groups, queryFn: () => api.getGroups() })
export const useGroup = (id: string | undefined) =>
  useQuery({
    queryKey: keys.group(id ?? ''),
    queryFn: () => api.getGroup(id ?? ''),
    enabled: !!id,
    retry: false,
    // 编辑中的表单不跟随后台刷新
    staleTime: Infinity,
  })
export const useRuntimes = (deviceId?: string) =>
  useQuery({ queryKey: keys.runtimes(deviceId), queryFn: () => api.getRuntimes({ deviceId }) })
export const useProbeCells = (deviceId?: string, nodeId?: string) =>
  useQuery({
    queryKey: keys.probes(deviceId, nodeId),
    queryFn: () => api.getProbeCells({ deviceId, nodeId }),
    placeholderData: keepPreviousData,
  })

export function useEvents(q: EventQuery) {
  return useInfiniteQuery({
    queryKey: keys.events(q),
    queryFn: ({ pageParam }) => api.getEvents({ ...q, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  })
}

/** 订阅服务端推送，按变化范围刷新数据 */
export function useLiveUpdates() {
  const qc = useQueryClient()
  useEffect(
    () =>
      api.subscribe((m) => {
        if (m.type === 'reset') {
          void qc.resetQueries()
          return
        }
        for (const scope of m.scopes) {
          // 编辑页的分组表单不自动刷新，避免覆盖正在修改的内容
          if (scope === 'groups') {
            void qc.invalidateQueries({ queryKey: keys.groups, exact: true })
            continue
          }
          void qc.invalidateQueries({ queryKey: [scope] })
          // 设备接入时服务端推的是 devices。接入对话框的状态靠轮询，页面在后台时轮询会暂停，
          // 跟着这条推送问一次，设备接入的那一刻对话框就能变成「已接入」
          if (scope === 'devices') void qc.invalidateQueries({ queryKey: ['enroll'] })
        }
      }),
    [qc],
  )
}

function useInvalidate() {
  const qc = useQueryClient()
  return (...scopes: UpdateScope[]) =>
    Promise.all(scopes.map((s) => qc.invalidateQueries({ queryKey: [s] })))
}

export function useUpdateNode() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.updateNode(v.id, { enabled: v.enabled }),
    onSuccess: () => invalidate('nodes', 'runtimes', 'events'),
  })
}

export function useSaveTarget() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (v: { id: string | null; input: TargetInput }) => api.saveTarget(v.id, v.input),
    onSuccess: () => invalidate('targets', 'probes'),
  })
}

export function useDeleteTarget() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.deleteTarget(id),
    onSuccess: () => invalidate('targets', 'probes'),
  })
}

export function useSaveGroup() {
  const qc = useQueryClient()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (v: { id: string | null; input: GroupInput }) => api.saveGroup(v.id, v.input),
    onSuccess: (g) => {
      qc.setQueryData(keys.group(g.id), g)
      return invalidate('groups', 'runtimes', 'probes', 'events')
    },
  })
}

export function useDeleteGroup() {
  const qc = useQueryClient()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.deleteGroup(id),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: keys.group(id) })
      return invalidate('groups', 'runtimes', 'probes', 'events')
    },
  })
}

/**
 * 这台设备实际会拿到的 sing-box 配置。
 *
 * 生成必须在服务端做：节点的出站（密码、UUID 之类）只在服务端有，
 * 前端拿到的节点对象里没有这些字段，拼不出来。用的是真正下发时同一个
 * `buildConfig`，所以预览里看到的规则顺序、selector、兜底都跟设备拿到的一致。
 * 返回的配置里密钥位置是占位符，Agent 那台设备上真正生效的密钥不会离开设备。
 */
export function useConfigPreview(q: { deviceId: string | null; group?: GroupInput & { id?: string } }) {
  const deviceId = q.deviceId
  const group = q.group
  return useQuery({
    queryKey: ['config-preview', deviceId ?? '', group ?? null] as const,
    queryFn: () => api.previewConfig({ deviceId: deviceId as string, group }),
    enabled: !!deviceId,
    // 编辑时草稿每次按键都会变，旧结果留着当占位，免得代码块一直闪
    placeholderData: keepPreviousData,
  })
}

export function useSetPin() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (v: { deviceId: string; groupId: string; nodeId: string | null }) =>
      api.setPin(v.deviceId, v.groupId, v.nodeId),
    onSuccess: () => invalidate('runtimes', 'events'),
  })
}

/**
 * 新建或修改订阅。
 *
 * 对象存储和节点池都要失效：服务端在返回之前已经拉过一轮，拉完会广播
 * sources/nodes/events 三个范围，这里跟着失效一次，页面立刻就是新状态，
 * 不用等推送。
 */
export function useSaveSource() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (v: { id: string | null; name?: string; url?: string; enabled?: boolean }) =>
      api.saveSource(v.id, v),
    onSuccess: () => invalidate('sources', 'nodes', 'events'),
  })
}

export function useDeleteSource() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.deleteSource(id),
    onSuccess: () => invalidate('sources', 'nodes', 'events'),
  })
}

/** 立刻重拉一次订阅。拉取在这个接口里做完，返回时节点池已经变了 */
export function useRefreshSource() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.refreshSource(id),
    onSuccess: () => invalidate('sources', 'nodes', 'events'),
  })
}

/** 设备拿配置用的那条链接。token 不会自己变，取一次就够 */
export const useSubscription = () =>
  useQuery({
    queryKey: keys.subscription,
    queryFn: () => api.getSubscription(),
    staleTime: Infinity,
  })

export function useResetSubscription() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.resetSubscription(),
    onSuccess: (token) => {
      qc.setQueryData(keys.subscription, token)
    },
  })
}

/** 生成一条接入命令。生成之后不会自己重试，所以不放在 query 里 */
export function useCreateEnroll() {
  return useMutation({ mutationFn: () => api.createEnroll() })
}

/**
 * 轮询接入命令的状态。
 *
 * 两秒一次，跟安装脚本跑起来的时间尺度对得上；拿到 joined 或者命令失效（404）就停，
 * 失效由调用方提示用户换一条。active 为 false 时暂停轮询但留着结果：
 * 对话框关掉再打开，还能接着看同一条命令。
 */
export function useEnrollStatus(id: string | null, active = true) {
  return useQuery({
    queryKey: keys.enroll(id ?? ''),
    queryFn: () => api.getEnroll(id as string),
    enabled: !!id && active,
    refetchInterval: (q) => {
      if (q.state.data?.state === 'joined') return false
      const err = q.state.error
      return err instanceof ApiError && err.status === 404 ? false : 2000
    },
    retry: false,
    staleTime: 0,
  })
}

/** 重试一条放弃了的切换 */
export function useRetryPending() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (v: { deviceId: string; groupId: string; pendingId: string }) =>
      api.retryPending(v.deviceId, v.groupId, v.pendingId),
    onSuccess: () => invalidate('runtimes', 'events'),
  })
}

export function useProbeNow() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (deviceId: string) => api.probeNow(deviceId),
    onSuccess: () => invalidate('runtimes', 'probes', 'events', 'devices'),
  })
}

/** 每隔一段时间重新渲染，让“3 分钟前”之类的文字保持准确 */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
