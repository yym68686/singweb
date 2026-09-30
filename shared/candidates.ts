/**
 * 按分组条件挑候选节点。管理服务、Agent 和前端用的是同一份实现，
 * 保证界面里看到的候选顺序和 Agent 实际用的顺序一致。
 */

import type { Group, NodeFilter, ProxyNode } from './types.ts'

const has = (text: string, words: string[]) => {
  const lower = text.toLowerCase()
  return words.some((w) => lower.includes(w.toLowerCase()))
}

/** 节点是否符合筛选条件；每一项为空表示不限 */
export function matchesFilter(n: ProxyNode, f: NodeFilter): boolean {
  if (f.regions.length && !f.regions.includes(n.region)) return false
  if (f.protocols.length && !f.protocols.includes(n.protocol)) return false
  if (f.include.length && !has(n.tag, f.include)) return false
  if (f.exclude.length && has(n.tag, f.exclude)) return false
  return true
}

/**
 * 分组的候选节点 id，按优先级排序。
 * 逐个挑选时保留用户排的顺序（去掉已经不存在的节点）；按条件加入时跟节点列表的顺序一致。
 * 结果包含停用的节点，是否启用由调用方判断
 */
export function candidateIds(g: Pick<Group, 'candidates'>, nodes: ProxyNode[]): string[] {
  if (g.candidates.mode === 'list') {
    const known = new Set(nodes.map((n) => n.id))
    return g.candidates.nodeIds.filter((id) => known.has(id))
  }
  const f = g.candidates.filter
  return nodes.filter((n) => matchesFilter(n, f)).map((n) => n.id)
}

/** 启用的候选节点 */
export function enabledCandidates(g: Pick<Group, 'candidates'>, nodes: ProxyNode[]): ProxyNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return candidateIds(g, nodes)
    .map((id) => byId.get(id))
    .filter((n): n is ProxyNode => !!n && n.enabled)
}
