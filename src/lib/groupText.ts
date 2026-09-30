import type { Group, NodeFilter, ProxyNode, Target, TrafficMatch } from '../api/types'
import { candidateIds } from './candidates'
import { duration, gapBefore, joinZh } from './format'
import { protocolLabel, sniffProtocolShort, sshLevelLabel, targetKindLabel } from './labels'

const orBetween = (a: string, b: string) => `${a}${/[0-9A-Za-z)]$/.test(a) ? ' ' : ''}或${gapBefore(b)}${b}`

/** 最后两项用“或”，前面用顿号；挨着数字或拉丁字母的一侧留空格，如“22 或 2222”“香港、东京或新加坡” */
export function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return orBetween(items.slice(0, -1).join('、'), items[items.length - 1])
}

/** 每两项之间都用“或”：各项里面已经有顿号时，才分得清 */
const joinEachOr = (items: string[]) => items.reduce(orBetween)

/** 三类条件各自的说明，没设置的类为 null */
export function matchParts(m: TrafficMatch) {
  const dest = [
    m.domains.length ? `域名 ${m.domains.join('、')}` : '',
    m.domainKeywords.length ? `域名包含 ${m.domainKeywords.join('、')}` : '',
    m.ipCidrs.length ? `IP 段 ${m.ipCidrs.join('、')}` : '',
    m.ruleSets.length ? `规则集 ${m.ruleSets.join('、')}` : '',
  ].filter(Boolean)
  const proto = [
    m.protocols.length ? `${m.protocols.map((p) => sniffProtocolShort[p]).join('、')} 协议` : '',
    m.ports.length ? `端口 ${m.ports.join('、')}` : '',
  ].filter(Boolean)
  return {
    dest: dest.length ? joinEachOr(dest) : null,
    proto: proto.length ? joinEachOr(proto) : null,
    process: m.processNames.length ? `进程 ${m.processNames.join('、')}` : null,
  }
}

/** “SSH 协议或端口 22、2222”“域名 pg-tokyo.example.net，并且端口 5432” */
export function matchText(m: TrafficMatch): string {
  const { dest, proto, process } = matchParts(m)
  const parts = [dest, proto, process].filter((x): x is string => !!x)
  return parts.length ? parts.join('，并且') : '没有设置'
}

/** “地区是香港或东京，名称不含 IPLC 的节点”；没有条件时是“全部节点” */
export function filterText(f: NodeFilter): string {
  const parts = [
    f.regions.length ? `地区是${joinOr(f.regions)}` : '',
    f.protocols.length ? `协议是 ${joinOr(f.protocols.map((p) => protocolLabel[p]))}` : '',
    f.include.length ? `名称包含 ${joinOr(f.include)}` : '',
    f.exclude.length ? `名称不含 ${f.exclude.join('、')}` : '',
  ].filter(Boolean)
  if (!parts.length) return '全部节点'
  // 各项里面已经用了顿号，项与项之间用逗号
  const text = parts.join('，')
  return `${text}${/[0-9A-Za-z]$/.test(text) ? ' ' : ''}的节点`
}

/** “8 个节点”“地区是香港或东京的节点，现在 6 个” */
export function candidatesText(g: Pick<Group, 'candidates'>, nodes: ProxyNode[]): string {
  const n = candidateIds(g, nodes).length
  if (g.candidates.mode === 'list') return `${n} 个节点`
  return `${filterText(g.candidates.filter)}，现在 ${n} 个`
}

/** 目标的地址：主机和端口，或者网址 */
export function targetAddress(t: Target): string {
  return t.kind === 'http' ? t.url : `${t.host}:${t.port}`
}

/** 期望的状态码：“状态码 200”“状态码 200 或 204”“状态码 200–399” */
export function expectStatusText(codes: number[]): string {
  return codes.length ? `状态码 ${joinOr(codes.map(String))}` : '状态码 200–399'
}

/** 怎样算通过：“到 SSH 握手，核对主机密钥”“状态码 200，包含“Sign in””“端口能连上” */
export function targetPassText(t: Target): string {
  switch (t.kind) {
    case 'ssh': {
      const level = sshLevelLabel[t.level]
      return `到${gapBefore(level)}${level}${t.level === 'handshake' && t.hostKey ? '，核对主机密钥' : ''}`
    }
    case 'http':
      return `${expectStatusText(t.expectStatus)}${t.keyword ? `，包含“${t.keyword}”` : ''}`
    case 'tcp':
      return '端口能连上'
  }
}

/** “github.com:22，到 SSH 握手”“https://github.com，状态码 200” */
export function targetSummary(t: Target): string {
  return `${targetAddress(t)}，${targetPassText(t)}`
}

/** “SSH 探测「GitHub SSH」和 HTTP 探测「GitHub 网页」，全部通过” */
export function rulesText(g: Pick<Group, 'selection' | 'targetIds' | 'targetMode'>, target: Map<string, Target>): string {
  if (g.selection === 'manual') return '手动选择，不探测'
  if (!g.targetIds.length) return '没有规则'
  const items = g.targetIds.map((id) => {
    const t = target.get(id)
    return t ? `${targetKindLabel[t.kind]}「${t.name}」` : id
  })
  if (items.length === 1) return items[0]
  return `${joinZh(items)}，${g.targetMode === 'all' ? '全部通过' : '任意一条通过'}`
}

type SwitchFields = Pick<
  Group,
  'strategy' | 'failThreshold' | 'recoverThreshold' | 'probeIntervalSec' | 'toleranceMs' | 'failback' | 'interruptExisting'
>

/** 一句话说清什么时候切换 */
export function switchText(p: SwitchFields): string {
  const parts = [
    `每 ${duration(p.probeIntervalSec)}探测一轮`,
    `连续失败 ${p.failThreshold} 轮切走`,
    `连续成功 ${p.recoverThreshold} 轮恢复`,
  ]
  if (p.strategy === 'priority') parts.push(p.failback ? '更靠前的节点恢复后切回' : '恢复后不切回')
  else parts.push(`新节点快 ${p.toleranceMs} ms 以上才换`)
  parts.push(p.interruptExisting ? '切换时断开已有连接' : '已有连接不断开')
  return parts.join('，')
}
