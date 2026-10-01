/**
 * 设备掉线的推送。
 *
 * 在线与否是读的时候按 last_seen_at 现算的，「超过 90 秒没上报」那一刻没有谁去改库，
 * 网页也就收不到推送：设备断了网，页面上会一直显示在线，直到用户自己刷新。
 * 这里每隔一会儿扫一遍，把刚掉线的设备记一条事件，再告诉网页「设备变了」。
 *
 * 重新上线不在这里管：设备一上报，上报接口自己就知道它回来了。
 */

import type { LiveHub } from './live.ts'
import { OFFLINE_AFTER_MS } from './model.ts'
import * as store from './store.ts'

/** 多久扫一次。网页上的「离线」最多比实际晚这么久 */
const SCAN_MS = 15_000

export class PresenceWatcher {
  private readonly live: LiveHub
  private timer: ReturnType<typeof setInterval> | null = null
  private scanning = false

  constructor(live: LiveHub) {
    this.live = live
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.scan(), SCAN_MS)
    // 扫描不该拖着进程不让退出
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 扫一遍。库暂时连不上就等下一轮，不往外抛 */
  async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const rows = await store.markOfflineDevices(OFFLINE_AFTER_MS)
      for (const row of rows) {
        await store.insertEvent({
          kind: 'device-offline',
          severity: 'warn',
          deviceId: row.id,
          groupId: null,
          nodeId: null,
          message: `「${row.name}」超过 ${OFFLINE_AFTER_MS / 1000} 秒没有上报，可能已经离线`,
        })
      }
      if (rows.length) this.live.update(['devices', 'runtimes', 'events'])
    } catch (err) {
      console.error('检查设备在线状态时出错：', err)
    } finally {
      this.scanning = false
    }
  }
}
