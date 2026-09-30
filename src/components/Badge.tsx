import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { HealthState, RuntimeState, Severity } from '../api/types'
import { cx } from '../lib/cx'
import { healthLabel, runtimeLabel, severityLabel } from '../lib/labels'
import { healthLook, runtimeLook, severityLook, type Tone } from '../lib/status'
import s from './Badge.module.css'

interface BadgeProps {
  tone: Tone
  icon?: LucideIcon
  children: ReactNode
  className?: string
  /** 只显示图标和文字，不要底色 */
  plain?: boolean
}

/** 状态标签：底色、图标和文字一起表示状态，不只靠颜色 */
export function Badge({ tone, icon: Icon, children, className, plain }: BadgeProps) {
  return (
    <span className={cx(s.badge, s[tone], plain && s.plain, className)}>
      {Icon && <Icon className={s.icon} />}
      <span>{children}</span>
    </span>
  )
}

export function RuntimeBadge({ state, plain }: { state: RuntimeState; plain?: boolean }) {
  const look = runtimeLook[state]
  return (
    <Badge tone={look.tone} icon={look.icon} plain={plain}>
      {runtimeLabel[state]}
    </Badge>
  )
}

export function HealthBadge({ state, plain }: { state: HealthState; plain?: boolean }) {
  const look = healthLook[state]
  return (
    <Badge tone={look.tone} icon={look.icon} plain={plain}>
      {healthLabel[state]}
    </Badge>
  )
}

export function SeverityIcon({ severity, size = 16 }: { severity: Severity; size?: number }) {
  const look = severityLook[severity]
  const Icon = look.icon
  return <Icon size={size} className={s[`${look.tone}Icon`]} aria-label={severityLabel[severity]} role="img" />
}

/** 只要一个带状态色的图标（旁边已有文字说明时使用） */
export function ToneIcon({ tone, icon: Icon, size = 16 }: { tone: Tone; icon: LucideIcon; size?: number }) {
  return <Icon size={size} className={s[`${tone}Icon`]} />
}
