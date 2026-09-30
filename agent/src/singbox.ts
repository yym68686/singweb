/**
 * 跟设备上那个 sing-box 打交道。
 *
 * 这里刻意不去改写用户的 sing-box 配置：那份配置是用户自己维护的，Agent 只往里加一个
 * 阻断规则集文件，切换节点走 Clash API，用户重启 sing-box 也不会丢东西。
 * 需要补进配置里的片段由网页生成，用户自己贴。
 */

import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Device, Group } from '../../shared/types.ts'
import { blockRuleSetContent, blockRuleSetPath, blockRuleSetTag } from '../../shared/singbox.ts'

/** Clash API 的响应超时。本机调用，给短一点，卡住了就是 sing-box 没起来 */
const API_TIMEOUT_MS = 3000

export interface ClashSelector {
  type: string
  now: string
  all: string[]
}

export class ClashApi {
  private readonly address: string
  private readonly secret: string

  constructor(address: string, secret: string) {
    this.address = address
    this.secret = secret
  }

  private url(path: string): string {
    // Clash API 也有跑在 unix socket 上的，但那种情况这里不支持，只认 host:port
    const host = this.address.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    return `http://${host}${path}`
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.secret) headers.authorization = `Bearer ${this.secret}`
    return headers
  }

  /**
   * 切换 selector 当前指向的节点。
   *
   * 这里必须让连不上的错误抛出去：切换是 Agent 对设备唯一的写操作，
   * 吞掉的话调用方拿到的是"成功"，却会在网页上记下一次设备上并不成立的切换。
   */
  async select(selectorTag: string, nodeTag: string): Promise<void> {
    await this.request('PUT', `/proxies/${encodeURIComponent(selectorTag)}`, { name: nodeTag }, true)
  }

  async getSelector(tag: string): Promise<ClashSelector | null> {
    const body = await this.request('GET', `/proxies/${encodeURIComponent(tag)}`)
    if (!body || typeof body !== 'object') return null
    const record = body as Record<string, unknown>
    return {
      type: String(record.type ?? ''),
      now: String(record.now ?? ''),
      all: Array.isArray(record.all) ? record.all.map(String) : [],
    }
  }

  /** sing-box 起来没有、版本对不对，用它探活 */
  async version(): Promise<string | null> {
    const body = await this.request('GET', '/version')
    if (!body || typeof body !== 'object') return null
    const version = (body as Record<string, unknown>).version
    return typeof version === 'string' ? version : null
  }

  /**
   * 探活用的原始请求。刚启动的 sing-box 会拒绝连接，
   * 这里要让调用方拿到异常去重试，而不是被吞成 null。
   */
  requestRaw(method: string, path: string): Promise<unknown> {
    return this.request(method, path, undefined, true)
  }

  private async request(
    method: string,
    path: string,
    payload?: unknown,
    raw = false,
  ): Promise<unknown | null> {
    const response = await fetch(this.url(path), {
      method,
      headers: {
        ...this.headers(),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    }).catch((err: unknown) => {
      // 探活时要看到真实的连接错误，普通调用则当作"没有响应"
      if (raw) throw err
      return null
    })
    if (!response) return null
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`sing-box 的 Clash API 返回 ${response.status}：${text.slice(0, 200)}`)
    }
    if (response.status === 204) return null
    const text = await response.text()
    return text ? (JSON.parse(text) as unknown) : null
  }
}

/**
 * 写阻断规则集。平时是空的，全部不可用时匹配所有 TCP 和 UDP，
 * 这样连接不会被悄悄改成直连，而是直接断掉。
 *
 * 先写临时文件再改名：sing-box 可能正在读这个文件，改到一半会被读成坏 JSON。
 */
export async function writeBlockRuleSet(
  device: Pick<Device, 'dataDir'>,
  group: Pick<Group, 'selectorTag'>,
  blocking: boolean,
): Promise<void> {
  const path = blockRuleSetPath(device, group)
  await mkdir(dirname(path), { recursive: true })
  const content = blocking ? blockRuleSetContent.blocking : blockRuleSetContent.idle
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify(content, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/** 规则集文件在不在。配置里引用了它但文件不存在时，sing-box 会起不来 */
export async function blockRuleSetExists(
  device: Pick<Device, 'dataDir'>,
  group: Pick<Group, 'selectorTag'>,
): Promise<boolean> {
  try {
    return (await stat(blockRuleSetPath(device, group))).isFile()
  } catch {
    return false
  }
}

/** 探测进程也要一份空规则集，否则主配置里的规则集引用在探测进程里解析不了 */
export async function ensureDataDir(device: Pick<Device, 'dataDir'>): Promise<void> {
  const dir = device.dataDir
  if (!dir) return
  await mkdir(dir, { recursive: true })
  // 目录里有探测用的配置，里面带着节点凭据
  await chmod(dir, 0o700).catch(() => {})
}

export function selectorTagOf(group: Pick<Group, 'selectorTag'>): string {
  return group.selectorTag
}

export function blockTagOf(group: Pick<Group, 'selectorTag'>): string {
  return blockRuleSetTag(group)
}
