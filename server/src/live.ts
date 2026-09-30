/**
 * 服务端推送。前端连一次 /api/v1/stream，之后有变更就收到一条 update。
 *
 * 只推「哪几类数据变了」，内容由前端自己重新拉——这样断线重连、多标签页、
 * 多实例部署都不用维护增量状态，服务端始终无状态。
 *
 * 多条变更在一秒内合并成一条，免得连续操作时把前端刷爆。
 */

import type { ServerResponse } from 'node:http'
import type { UpdateScope } from '../../shared/types.ts'

const MERGE_MS = 1000
const PING_MS = 20_000

interface Client {
  res: ServerResponse
  /** 还没发出去的变更范围 */
  pending: Set<UpdateScope>
  timer: NodeJS.Timeout | null
}

export class LiveHub {
  private clients = new Set<Client>()
  private ping: NodeJS.Timeout

  constructor() {
    this.ping = setInterval(() => this.beat(), PING_MS)
    // 心跳不该拖着进程不让退出
    this.ping.unref?.()
  }

  /** 接一个前端连接。注意头里要关掉 nginx 一类反向代理的缓冲，否则事件会攒着不发 */
  attach(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // 先来一条注释，让前端立刻知道连上了
    res.write(': connected\n\n')

    const client: Client = { res, pending: new Set(), timer: null }
    this.clients.add(client)
    res.on('close', () => {
      if (client.timer) clearTimeout(client.timer)
      this.clients.delete(client)
    })
  }

  /**
   * 宣告一批数据变了。scopes 为空表示「什么都可能变了」，
   * 前端收到后整页重新拉——设备刚上线、节点表被重排这类情况。
   */
  update(scopes: UpdateScope[]): void {
    if (!this.clients.size) return
    for (const client of this.clients) {
      for (const scope of scopes) client.pending.add(scope)
      if (client.timer) continue
      client.timer = setTimeout(() => {
        client.timer = null
        this.flush(client)
      }, MERGE_MS)
      client.timer.unref?.()
    }
  }

  /** 让所有前端丢掉本地缓存重新拉，用在批量导入、恢复备份之后 */
  reset(): void {
    for (const client of this.clients) {
      if (client.timer) clearTimeout(client.timer)
      client.timer = null
      client.pending.clear()
      this.write(client.res, { type: 'reset' })
    }
  }

  private flush(client: Client): void {
    if (!client.pending.size) return
    const scopes = [...client.pending]
    client.pending.clear()
    this.write(client.res, { type: 'update', scopes })
  }

  private beat(): void {
    for (const client of this.clients) {
      // 行首冒号是 SSE 的注释，前端会忽略，只用来保活
      client.res.write(': ping\n\n')
    }
  }

  private write(res: ServerResponse, payload: unknown): void {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      // 连接断了，close 事件里会清理
    }
  }

  close(): void {
    clearInterval(this.ping)
    for (const client of this.clients) {
      if (client.timer) clearTimeout(client.timer)
      client.res.end()
    }
    this.clients.clear()
  }
}
