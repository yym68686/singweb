/**
 * 分组跟设备、跟流量的关系。管理服务、Agent 和前端共用。
 */

import type { Group, TrafficMatch } from './types.ts'

/**
 * 分组用在哪些设备上。deviceIds 为空表示所有设备，包括以后接入的——
 * 没有设备的时候也要能先把分组建好，设备接入后自动拿到。
 */
export function appliesTo(group: Pick<Group, 'deviceIds'>, deviceId: string): boolean {
  return group.deviceIds.length === 0 || group.deviceIds.includes(deviceId)
}

/** 分组实际作用的设备 id，按 devices 的顺序 */
export function groupDeviceIds(group: Pick<Group, 'deviceIds'>, devices: Array<{ id: string }>): string[] {
  return devices.filter((d) => appliesTo(group, d.id)).map((d) => d.id)
}

/**
 * 接管条件一项都没设的分组是兜底分组：别的分组都没接管的流量，全部走它。
 * 一台设备上最多一个兜底分组。
 */
export function isCatchAll(m: TrafficMatch): boolean {
  return (
    m.domains.length +
      m.domainKeywords.length +
      m.ipCidrs.length +
      m.ruleSets.length +
      m.protocols.length +
      m.ports.length +
      m.processNames.length ===
    0
  )
}

/** 两个分组会不会落到同一台设备上 */
export function sharesDevice(a: Pick<Group, 'deviceIds'>, b: Pick<Group, 'deviceIds'>): boolean {
  if (!a.deviceIds.length || !b.deviceIds.length) return true
  return a.deviceIds.some((id) => b.deviceIds.includes(id))
}
