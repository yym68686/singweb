import { outletName, type Catalog } from '../api/catalog'
import { DIRECT, type GroupRuntime, type RuntimeState } from '../api/types'
import { gapBefore, timeAgo } from './format'

/** 运行状态的一句话说明：现在是什么情况、会有什么影响 */
export function runtimeNote(rt: GroupRuntime, c: Pick<Catalog, 'node' | 'device'>, now: number): string {
  const active = outletName(rt.activeNodeId, c)
  switch (rt.state) {
    case 'ok':
      return `当前走 ${active}。`
    case 'pinned':
      return `已手动固定在 ${active}，不会自动切换。`
    case 'degraded':
      return `只剩 ${outletName(rt.eligibleNodeIds[0], c)} 可用，它再出问题就没有节点可以切换了。`
    case 'pinned-down':
      return `手动固定的 ${outletName(rt.pinnedNodeId, c)} 不可用。取消固定后会自动切到可用节点。`
    case 'failing':
      return `所有候选节点都不可用，按分组设置仍停在 ${active}，新连接很可能失败。`
    case 'blocked':
      return rt.nodes.some((h) => c.node.get(h.nodeId)?.enabled)
        ? '所有候选节点都没通过分组规则，已阻断这个分组的新连接，不会悄悄改走直连。'
        : '没有启用的候选节点，已阻断这个分组的新连接，不会悄悄改走直连。'
    case 'direct':
      return '所有候选节点都不可用，这个分组的流量正在直连，对方会看到设备的真实出口 IP。'
    case 'manual':
      return `手动选择，当前走 ${active}。`
    case 'unknown':
      return 'Agent 还没完成第一轮探测。'
    case 'stale': {
      const d = c.device.get(rt.deviceId)
      if (!d) return '设备离线。'
      const ago = timeAgo(d.lastSeenAt, now)
      return `设备最后一次上报是${gapBefore(ago)}${ago}，这里是那时的状态。`
    }
  }
}

/** 总览标题里用的短语：“hz-build-01 的「AI 服务」已阻断” */
export const runtimeHeadline: Partial<Record<RuntimeState, string>> = {
  blocked: '已阻断',
  failing: '没有可用节点',
  direct: '已改走直连',
  'pinned-down': '固定的节点不可用',
}

/**
 * 一次切换的说明：“从 HK-01 切到 JP-01”“从 JP-01 改为阻断”“从直连切到 JP-01”。
 * 从阻断、直连切回节点不一定是恢复（也可能是全部不可用时改回保持节点，或者手动固定），不写“恢复”
 */
export function hopText(from: string | null, to: string | null, c: Pick<Catalog, 'node'>): string {
  // “阻断”“直连”本身是中文，前后不留空格；节点 tag 两边留空格
  const at = (id: string | null) => (id === null || id === DIRECT ? outletName(id, c) : ` ${outletName(id, c)} `)
  const text =
    to === null ? `从${at(from)}改为阻断` : to === DIRECT ? `从${at(from)}改走直连` : `从${at(from)}切到${at(to)}`
  return text.trimEnd()
}
