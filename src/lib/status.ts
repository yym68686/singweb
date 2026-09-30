import {
  ArrowRightLeft,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  Globe,
  Hand,
  Info,
  OctagonAlert,
  OctagonX,
  Pin,
  PinOff,
  Server,
  ShieldCheck,
  Split,
  TriangleAlert,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import type { EventKind, HealthState, RuntimeState, Severity } from '../api/types'

/** 状态色只表示状态，并且总是和图标、文字一起出现 */
export type Tone = 'good' | 'warn' | 'serious' | 'crit' | 'offline' | 'neutral'

export interface StatusLook {
  tone: Tone
  icon: LucideIcon
}

export const runtimeLook: Record<RuntimeState, StatusLook> = {
  ok: { tone: 'good', icon: CircleCheck },
  degraded: { tone: 'warn', icon: TriangleAlert },
  pinned: { tone: 'neutral', icon: Pin },
  'pinned-down': { tone: 'crit', icon: OctagonAlert },
  failing: { tone: 'crit', icon: OctagonAlert },
  blocked: { tone: 'crit', icon: OctagonX },
  direct: { tone: 'serious', icon: Globe },
  manual: { tone: 'neutral', icon: Hand },
  unknown: { tone: 'neutral', icon: CircleDashed },
  stale: { tone: 'offline', icon: WifiOff },
}

export const healthLook: Record<HealthState, StatusLook> = {
  up: { tone: 'good', icon: CircleCheck },
  down: { tone: 'crit', icon: CircleX },
  unknown: { tone: 'neutral', icon: CircleDashed },
}

export const disabledLook: StatusLook = { tone: 'offline', icon: CircleMinus }

export const severityLook: Record<Severity, StatusLook> = {
  info: { tone: 'neutral', icon: Info },
  good: { tone: 'good', icon: CircleCheck },
  warn: { tone: 'warn', icon: TriangleAlert },
  crit: { tone: 'crit', icon: OctagonAlert },
}

export const eventIcon: Record<EventKind, LucideIcon> = {
  switch: ArrowRightLeft,
  'node-down': CircleX,
  'node-up': CircleCheck,
  'all-down': OctagonX,
  recovered: ShieldCheck,
  pin: Pin,
  unpin: PinOff,
  'device-offline': WifiOff,
  'device-online': Wifi,
  'group-changed': Split,
  'node-changed': Server,
}

/** 需要人处理的运行状态，按严重程度排序 */
export const runtimeRank: Record<RuntimeState, number> = {
  blocked: 0,
  failing: 1,
  direct: 2,
  'pinned-down': 3,
  degraded: 4,
  stale: 5,
  unknown: 6,
  pinned: 7,
  manual: 7,
  ok: 8,
}

export const isCritical = (s: RuntimeState) =>
  s === 'blocked' || s === 'failing' || s === 'direct' || s === 'pinned-down'
