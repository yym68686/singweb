import { useMemo } from 'react'
import { appliesTo } from '../lib/groups'
import { useDevices, useGroups, useNodes, useSources, useTargets } from './hooks'
import { DIRECT, type Device, type Group, type NodeSource, type ProxyNode, type Target } from './types'

/** 页面上常用的配置数据，附带按 id 查找的表 */
export interface Catalog {
  devices: Device[]
  nodes: ProxyNode[]
  groups: Group[]
  targets: Target[]
  /** 订阅地址；只有节点页用得到 */
  sources: NodeSource[]
  device: Map<string, Device>
  node: Map<string, ProxyNode>
  group: Map<string, Group>
  target: Map<string, Target>
  source: Map<string, NodeSource>
}

const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]))

export function useCatalog() {
  const devices = useDevices()
  const nodes = useNodes()
  const groups = useGroups()
  const targets = useTargets()
  const sources = useSources()

  const data = useMemo<Catalog | undefined>(() => {
    if (!devices.data || !nodes.data || !groups.data || !targets.data || !sources.data) return undefined
    return {
      devices: devices.data,
      nodes: nodes.data,
      groups: groups.data,
      targets: targets.data,
      sources: sources.data,
      device: byId(devices.data),
      node: byId(nodes.data),
      group: byId(groups.data),
      target: byId(targets.data),
      source: byId(sources.data),
    }
  }, [devices.data, nodes.data, groups.data, targets.data, sources.data])

  const error = devices.error ?? nodes.error ?? groups.error ?? targets.error ?? sources.error
  const retry = () => {
    for (const q of [devices, nodes, groups, targets, sources]) if (q.error) void q.refetch()
  }
  return { data, error, retry }
}

/** selector 选中项的显示名：节点 tag、直连或阻断 */
export function outletName(id: string | null | undefined, c: Pick<Catalog, 'node'>): string {
  if (id === null || id === undefined) return '阻断'
  if (id === DIRECT) return '直连'
  return c.node.get(id)?.tag ?? id
}

/** 应用到某台设备的分组，包括应用到所有设备的 */
export const groupsOf = (c: Pick<Catalog, 'groups'>, deviceId: string) =>
  c.groups.filter((g) => appliesTo(g, deviceId))
