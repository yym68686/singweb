/**
 * 初始化内容。只有在库里还什么都没有的时候才建，建成之后就不再插手：
 * 用户在网页上改了名称、换了规则、删掉整个分组，服务端都不该在下次重启时
 * 又把它变回来。每一样都单独判存不存在，所以删掉其中一样也不会导致另一样被重建。
 */

import { EMPTY_MATCH } from './model.ts'
import * as store from './store.ts'
import { checkGroup, checkTarget } from './validate.ts'

/** 建一个默认分组，把节点池里的节点全兜住 */
export async function ensureGroups(): Promise<void> {
  const groups = await store.listGroups()
  if (groups.some((g) => g.selectorTag === 'all-nodes')) return

  // 走和网页同一套校验，保证种进去的东西跟用户自己建出来的一模一样
  const shape = checkGroup(
    {
      name: '全部节点',
      selectorTag: 'all-nodes',
      deviceIds: [],
      match: EMPTY_MATCH,
      // 条件全空 = 不限，节点池里有多少收多少。订阅里新增的节点自动进来，
      // 不需要有人回去改分组
      candidates: { mode: 'filter', filter: { regions: [], protocols: [], include: [], exclude: [] } },
      selection: 'manual',
      targetIds: [],
      targetMode: 'all',
      strategy: 'latency',
      failThreshold: 3,
      recoverThreshold: 2,
      probeIntervalSec: 60,
      toleranceMs: 150,
      failback: true,
      interruptExisting: false,
      onAllFail: 'keep-last',
    },
    new Set(),
    new Set(),
  )
  await store.insertGroup(shape)
  console.log('  已建好默认分组「全部节点」。')
}

/**
 * 建默认的 SSH 探测目标。
 *
 * 用 ssh.github.com:443 而不是 github.com:22：443 上跑 SSH 是 GitHub 专门给
 * 22 端口被墙的网络准备的，探测能过的节点，基本就是真的能连外网 SSH 的节点。
 * banner 级别只看能不能连上、拿不拿得到 SSH 版本串，不做握手，快且不依赖指纹。
 */
export async function ensureSshTarget(): Promise<void> {
  const targets = await store.listTargets()
  if (targets.some((t) => t.kind === 'ssh' && t.name === 'GitHub SSH')) return

  const shape = checkTarget({
    name: 'GitHub SSH',
    kind: 'ssh',
    host: 'ssh.github.com',
    port: 443,
    level: 'banner',
    hostKey: '',
    timeoutMs: 8000,
    note: 'GitHub 的 SSH 入口，走 443 端口；22 端口不通的网络也能用',
  })
  await store.insertTarget({
    name: shape.name,
    kind: shape.kind,
    timeoutMs: shape.timeoutMs,
    note: shape.note,
    spec: shape.spec,
  })
  console.log('  已建好探测目标「GitHub SSH」。')
}

/**
 * SSH 分组：接住本机往外发起的 SSH 连接，只放探得通 SSH 的节点。
 *
 * 候选是「节点池里所有节点」，能不能进这个分组由探测结果决定，不由筛选条件决定——
 * 这两件事分开之后，新订阅里的节点不用改配置就会自动参与探测，探不通的自然被排除。
 * 命中条件是端口 22 和 2222（常见的备选 SSH 端口），协议嗅探也认 ssh，
 * 两者是「或」，所以既覆盖没开嗅探的普通连接，也覆盖起了别名的连接。
 */
export async function ensureSshGroup(): Promise<void> {
  const groups = await store.listGroups()
  if (groups.some((g) => g.selectorTag === 'ssh-out')) return

  const targets = await store.listTargets()
  const ssh = targets.find((t) => t.kind === 'ssh' && t.name === 'GitHub SSH')
  if (!ssh) return

  const shape = checkGroup(
    {
      name: 'SSH 出口',
      selectorTag: 'ssh-out',
      deviceIds: [],
      match: { ...EMPTY_MATCH, ports: [22, 2222], protocols: ['ssh'] },
      candidates: { mode: 'filter', filter: { regions: [], protocols: [], include: [], exclude: [] } },
      selection: 'auto',
      targetIds: [ssh.id],
      targetMode: 'all',
      strategy: 'latency',
      failThreshold: 3,
      recoverThreshold: 2,
      probeIntervalSec: 60,
      // 经代理连 SSH 要来回好几趟，测出来的延迟本身就会上下跳一两百毫秒。
      // 容忍度比这个小，差不多快的几个节点会轮流被判成「明显更快」，出口隔几分钟就换一次
      toleranceMs: 150,
      failback: true,
      interruptExisting: false,
      // SSH 会话断在半路比走错出口更烦人，所以全都探不通时保持当前节点
      onAllFail: 'keep-last',
    },
    new Set([ssh.id]),
    new Set(),
  )
  await store.insertGroup(shape)
  console.log('  已建好分组「SSH 出口」。')
}
