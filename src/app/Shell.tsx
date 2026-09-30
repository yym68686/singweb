import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, ScrollRestoration, type Location } from 'react-router'
import {
  ClockFading,
  Gauge,
  Grid3x3,
  Laptop,
  Menu,
  OctagonAlert,
  Server,
  Split,
  Target,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useLiveUpdates, useRuntimes } from '../api/hooks'
import { Button } from '../components/Button'
import { isCritical } from '../lib/status'
import { AccountMenu } from './AccountMenu'
import { useFocusMainOnNavigate, useHashScroll } from './navigation'
import { ThemeSwitch } from './ThemeSwitch'
import s from './Shell.module.css'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
}

const MAIN_NAV: NavItem[] = [
  { to: '/', label: '总览', icon: Gauge, end: true },
  { to: '/devices', label: '设备', icon: Laptop },
  { to: '/matrix', label: '连通性', icon: Grid3x3 },
  { to: '/events', label: '事件', icon: ClockFading },
]

const CONFIG_NAV: NavItem[] = [
  { to: '/groups', label: '分组', icon: Split },
  { to: '/targets', label: '探测目标', icon: Target },
  { to: '/nodes', label: '节点', icon: Server },
]

const WIDE = '(min-width: 960px)'

/**
 * 滚动位置按历史记录保存。直接打开或输入地址时 react-router 给的 key 都是 "default"，
 * 会把上一个页面的位置套到新页面上，这种情况改按地址保存
 */
const scrollKey = (l: Location) => (l.key === 'default' ? l.pathname + l.search : l.key)

export function Shell() {
  useLiveUpdates()
  useFocusMainOnNavigate()
  useHashScroll()
  const runtimes = useRuntimes()
  const critical = runtimes.data?.filter((r) => isCritical(r.state)).length ?? 0
  const [drawer, setDrawer] = useState(false)
  const close = () => setDrawer(false)

  // 窗口变宽、侧栏出现后，收起抽屉
  useEffect(() => {
    const m = window.matchMedia(WIDE)
    const onChange = () => m.matches && setDrawer(false)
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [])

  return (
    <div className={s.shell}>
      <a href="#main" className={s.skip}>
        跳到主要内容
      </a>

      <aside className={s.sidebar}>
        <Brand />
        <Nav critical={critical} />
        <div className={s.sideFoot}>
          <ThemeSwitch />
          <AccountMenu />
        </div>
      </aside>

      <header className={s.topbar}>
        <Button variant="ghost" icon={Menu} aria-label="打开导航" aria-expanded={drawer} onClick={() => setDrawer(true)} />
        <Brand />
        {critical > 0 && (
          <Link to="/" className={s.topCount}>
            <CritCount n={critical} />
          </Link>
        )}
      </header>

      <Drawer open={drawer} onClose={close}>
        <div className={s.drawerHead}>
          <Brand onNavigate={close} />
          <Button variant="ghost" icon={X} aria-label="关闭导航" onClick={close} />
        </div>
        <Nav critical={critical} onNavigate={close} />
        <div className={s.sideFoot}>
          <ThemeSwitch />
          <AccountMenu onNavigate={close} />
        </div>
      </Drawer>

      <div className={s.column}>
        <main id="main" tabIndex={-1} className={s.main}>
          <Outlet />
        </main>
      </div>

      <ScrollRestoration getKey={scrollKey} />
    </div>
  )
}

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link to="/" className={s.brand} onClick={onNavigate}>
      <svg className={s.mark} viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" />
        <path d="M9 22.5C9 13 23 19 23 9.5" />
        <circle cx="9" cy="23" r="3.6" />
        <circle cx="23" cy="9" r="3.6" />
      </svg>
      singweb
    </Link>
  )
}

function CritCount({ n }: { n: number }) {
  return (
    <span className={s.count}>
      <OctagonAlert aria-hidden />
      {n}
      <span className="visually-hidden">个出口需要处理</span>
    </span>
  )
}

function Nav({ critical, onNavigate }: { critical: number; onNavigate?: () => void }) {
  const configId = useId()
  const item = (n: NavItem) => (
    <li key={n.to}>
      <NavLink to={n.to} end={n.end} className={({ isActive }) => (isActive ? `${s.link} ${s.active}` : s.link)} onClick={onNavigate}>
        <n.icon aria-hidden />
        <span className={s.linkText}>{n.label}</span>
        {n.to === '/' && critical > 0 && <CritCount n={critical} />}
      </NavLink>
    </li>
  )
  return (
    <nav className={s.nav} aria-label="主导航">
      <ul className={s.navList}>{MAIN_NAV.map(item)}</ul>
      <p className={s.navGroup} id={configId}>
        配置
      </p>
      <ul className={s.navList} aria-labelledby={configId}>
        {CONFIG_NAV.map(item)}
      </ul>
    </nav>
  )
}

/** 窄屏上的导航抽屉，基于原生 <dialog>，自带焦点限制和 Esc 关闭 */
function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className={s.drawer}
      aria-label="导航"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {open && <div className={s.drawerInner}>{children}</div>}
    </dialog>
  )
}
