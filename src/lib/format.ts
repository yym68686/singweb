const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
const timeFmt = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const fullFmt = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
const dayFmt = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })

const toMs = (t: string | number) => (typeof t === 'number' ? t : Date.parse(t))

/** “刚刚”“30 秒前”“3 分钟前”“昨天”；数字和中文之间补一个空格，与其他文案一致 */
export function timeAgo(t: string | number, now = Date.now()): string {
  const diff = (toMs(t) - now) / 1000
  const abs = Math.abs(diff)
  if (abs < 10) return '刚刚'
  const text =
    abs < 60
      ? rtf.format(Math.round(diff), 'second')
      : abs < 3600
        ? rtf.format(Math.round(diff / 60), 'minute')
        : abs < 86400
          ? rtf.format(Math.round(diff / 3600), 'hour')
          : rtf.format(Math.round(diff / 86400), 'day')
  return text.replace('秒钟', '秒').replace(/(\d)(?=[^\d\s])/, '$1 ')
}

/** 中文后面接数字或拉丁字母开头的片段时，中间留一个空格 */
export const gapBefore = (text: string) => (/^[0-9A-Za-z]/.test(text) ? ' ' : '')

/** 14:03:27 */
export function formatTime(t: string | number): string {
  return timeFmt.format(toMs(t))
}

/** 9月30日 14:03 */
export function formatDateTime(t: string | number): string {
  return dateTimeFmt.format(toMs(t))
}

/** 2026/9/30 14:03:27，用于 title 提示 */
export function formatFull(t: string | number): string {
  return fullFmt.format(toMs(t))
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** 用于按天分组的键 */
export function localDay(t: string | number): string {
  return dayKey(toMs(t))
}

/** 今天 / 昨天 / 9月28日 周一 */
export function formatDay(t: string | number, now = Date.now()): string {
  const ms = toMs(t)
  if (dayKey(ms) === dayKey(now)) return '今天'
  if (dayKey(ms) === dayKey(now - 86_400_000)) return '昨天'
  return dayFmt.format(ms)
}

/** 523 ms / 1.2 s */
export function ms(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v >= 10_000) return `${Math.round(v / 1000)} s`
  if (v >= 1000) return `${(v / 1000).toFixed(1)} s`
  return `${Math.round(v)} ms`
}

/** 15 秒 / 2 分钟 */
export function duration(sec: number): string {
  if (sec < 60) return `${sec} 秒`
  if (sec % 60 === 0) return `${sec / 60} 分钟`
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
}

/** 把列表连成“A、B 和 C”；“和”两边只在挨着数字或拉丁字母时留空格，如“东京和 GitHub SSH” */
export function joinZh(items: string[]): string {
  if (items.length <= 1) return items.join('')
  const head = items.slice(0, -1).join('、')
  const last = items[items.length - 1]
  return `${head}${/[0-9A-Za-z]$/.test(head) ? ' ' : ''}和${gapBefore(last)}${last}`
}

/**
 * 订阅地址里的凭据打码，用于网页上显示。
 *
 * 订阅链接本身就是凭证：拿到整条链接的人可以在任何客户端上用它取节点，
 * 而它会被写进截图、录屏和别人的屏幕。界面上只需要认出「是哪一个订阅」，
 * 不需要认出里面的 token，所以查询参数的值一律隐掉，只留参数名。
 *
 * 用字符串替换而不是 URL 解析：解析会把百分号编码解码再重新编码，
 * 显示出来的地址就和用户粘进去的不是同一条了，地址栏里比对时反而让人怀疑。
 */
export function maskUrl(url: string): string {
  return url.replace(
    /([?&])([A-Za-z0-9_.\-]+)=([^&#\s]*)/g,
    (_, sep: string, key: string) => `${sep}${key}=••••`,
  )
}
