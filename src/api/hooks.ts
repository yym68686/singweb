import { useEffect, useState } from 'react'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from './client'
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

export function useSetPin() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (v: { deviceId: string; groupId: string; nodeId: string | null }) =>
      api.setPin(v.deviceId, v.groupId, v.nodeId),
    onSuccess: () => invalidate('runtimes', 'events'),
  })
}

/** 新建或修改订阅。新建时带 refresh 表示存下之后立刻让设备拉一次 */
export function useSaveSource() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (v: {
      id: string | null
      name?: string
      url?: string
      enabled?: boolean
      refresh?: boolean
    }) => api.saveSource(v.id, v),
    onSuccess: () => invalidate('nodes', 'devices', 'runtimes'),
  })
}

export function useDeleteSource() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.deleteSource(id),
    onSuccess: () => invalidate('nodes', 'devices', 'runtimes'),
  })
}

/** 让设备重新拉一次订阅。不立刻失效缓存：结果要等设备上报才回来 */
export function useRefreshSource() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.refreshSource(id),
    onSuccess: () => invalidate('nodes', 'devices'),
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
