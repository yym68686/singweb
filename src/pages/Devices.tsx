import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  CircleAlert,
  CircleCheck,
  Laptop,
  LoaderCircle,
  OctagonAlert,
  Plus,
  RotateCw,
  TriangleAlert,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { groupsOf, outletName, useCatalog, type Catalog } from '../api/catalog'
import { absoluteApiUrl } from '../api/client'
import { ApiError, errorMessage } from '../api/errors'
import { useCreateEnroll, useEnrollStatus, useMe, useNow, useRuntimes } from '../api/hooks'
import type { Device, GroupRuntime } from '../api/types'
import { Badge, RuntimeBadge } from '../components/Badge'
import { Button } from '../components/Button'
import { CodeBlock } from '../components/CodeBlock'
import { TableScroll } from '../components/DataTable'
import { Dialog } from '../components/Dialog'
import { PageHeader } from '../components/PageHeader'
import { Segmented } from '../components/Segmented'
import { EmptyState, Loadable } from '../components/States'
import { Tooltip } from '../components/Tooltip'
import { cx } from '../lib/cx'
import { formatFull, timeAgo } from '../lib/format'
import { osText, singboxText } from '../lib/labels'
import { MIN_SINGBOX, singboxTooOld } from '../lib/singbox'
import t from '../components/DataTable.module.css'
import s from './Devices.module.css'

export default function Devices() {
  const catalog = useCatalog()
  const runtimes = useRuntimes()
  const me = useMe()
  const now = useNow()
  const enroll = useEnrollment()
  const admin = me.data?.role === 'admin'
  const data = catalog.data && runtimes.data ? { c: catalog.data, rts: runtimes.data } : undefined

  const add = admin && (
    <Button variant="primary" icon={Plus} onClick={enroll.start}>
      接入新设备
    </Button>
  )

  return (
    <>
      <PageHeader
        title="设备"
        description="接入了 singweb 的电脑。每台设备上的 Agent 管着本机的 sing-box：从这里拿节点和分组，按分组规则探测、切换节点，并实时上报状态。"
        actions={add}
      />
      <Loadable
        data={data}
        error={catalog.error ?? runtimes.error}
        retry={() => {
          catalog.retry()
          void runtimes.refetch()
        }}
      >
        {({ c, rts }) =>
          c.devices.length ? (
            <DeviceTable c={c} rts={rts} now={now} />
          ) : (
            <EmptyState icon={Laptop} title="还没有设备" action={add}>
              {admin
                ? '在要接入的电脑上运行一条命令，装好 Agent 和 sing-box 之后，设备会自动出现在这里。'
                : '管理员生成接入命令、在电脑上运行之后，设备会自动出现在这里。'}
            </EmptyState>
          )
        }
      </Loadable>
      {admin && <EnrollDialog e={enroll} c={catalog.data} now={now} />}
    </>
  )
}

type Os = 'macos' | 'windows'

/** 对话框默认显示哪个系统的命令：多半是在要接入的那台电脑上打开的网页 */
function guessOs(): Os {
  return /Windows/i.test(navigator.userAgent) ? 'windows' : 'macos'
}

function installCommand(os: Os, token: string): string {
  const query = `?token=${encodeURIComponent(token)}`
  if (os === 'windows') return `irm "${absoluteApiUrl('/install/windows.ps1')}${query}" | iex`
  return `curl -fsSL "${absoluteApiUrl('/install/macos.sh')}${query}" | sh`
}

/** 打开对话框时，还剩这么久才过期的命令接着用，不换新的 */
const REUSE_MIN_MS = 5 * 60_000

/**
 * 接入命令从生成到被用掉的整个过程。
 *
 * 放在页面这一层而不是对话框里：用户常常复制完命令就把对话框关了，
 * 去那台电脑上跑完再回来点开看结果，这时看到的应该还是同一条命令。
 * 已经用掉、失效或者快过期的，再打开时才换一条新的。
 */
function useEnrollment() {
  const [open, setOpen] = useState(false)
  const create = useCreateEnroll()
  const created = create.data
  const status = useEnrollStatus(created?.id ?? null, open)
  const expired = status.error instanceof ApiError && status.error.status === 404

  const start = () => {
    setOpen(true)
    if (create.isPending) return
    const reusable =
      created !== undefined &&
      status.data?.state !== 'joined' &&
      !expired &&
      Date.parse(created.expiresAt) - Date.now() > REUSE_MIN_MS
    if (!reusable) create.mutate()
  }

  return { open, start, close: () => setOpen(false), create, status, expired }
}

type Enrollment = ReturnType<typeof useEnrollment>

function EnrollDialog({ e, c, now }: { e: Enrollment; c: Catalog | undefined; now: number }) {
  const [os, setOs] = useState<Os>(guessOs)
  const created = e.create.isPending ? undefined : e.create.data
  const joined = e.status.data?.state === 'joined' ? e.status.data : null
  // 接入之后读设备列表里的那份：它跟着每次上报实时更新，接入那一刻的快照不会
  const device = joined ? (c?.device.get(joined.deviceId) ?? joined.device) : null
  const showCommand = created && !joined && !e.expired

  return (
    <Dialog
      open={e.open}
      onClose={e.close}
      wide
      title="接入新设备"
      description="在要接入的电脑上运行下面这条命令。它会装好 singweb Agent，本机没有 Node.js 或 sing-box 时下载官方版本放进用户目录，并设成登录后自动运行，全程不需要管理员权限。"
      footer={
        <>
          {(e.expired || joined || e.create.isError) && (
            <Button icon={RotateCw} pending={e.create.isPending} onClick={() => e.create.mutate()}>
              {joined ? '再接入一台' : '重新生成'}
            </Button>
          )}
          <Button variant="primary" onClick={e.close}>
            {joined ? '完成' : '关闭'}
          </Button>
        </>
      }
    >
      <div className={s.enroll}>
        {showCommand && (
          <>
            <Segmented
              legend="这台电脑的系统"
              className={s.os}
              value={os}
              options={[
                { value: 'macos', label: 'macOS' },
                { value: 'windows', label: 'Windows' },
              ]}
              onChange={setOs}
            />
            <CodeBlock
              wrap
              title={os === 'macos' ? '在「终端」里运行' : '在 PowerShell 里运行（不是「命令提示符」）'}
              label="安装命令"
              copyLabel="复制命令"
              code={installCommand(os, created.token)}
            />
            <p className={s.hint}>
              {os === 'macos' ? (
                <>
                  日志在 <code>~/.singweb/agent.log</code>。只想先试一下、不设开机自启的话，把最后的 <code>sh</code> 换成{' '}
                  <code>SINGWEB_NO_SERVICE=1 sh</code>，Agent 会在这个终端里前台运行。
                </>
              ) : (
                <>
                  日志在 <code>%USERPROFILE%\.singweb\agent.log</code>。只想先试一下、不设开机自启的话，先运行{' '}
                  <code>$env:SINGWEB_NO_SERVICE=1</code>，Agent 会在这个窗口里前台运行。
                </>
              )}
            </p>
          </>
        )}
        <EnrollState e={e} joined={joined} device={device} now={now} />
      </div>
    </Dialog>
  )
}

/**
 * 接入进度。这一块一直留着、只换内容，读屏软件才会把每次变化念出来；
 * 结果也写在这里而不是弹提示条，提示条会被挡在对话框的遮罩后面。
 */
function EnrollState({
  e,
  joined,
  device,
  now,
}: {
  e: Enrollment
  joined: { deviceId: string } | null
  device: Device | null
  now: number
}) {
  let tone: 'wait' | 'good' | 'crit' = 'wait'
  let body: ReactNode
  if (e.create.isPending) {
    body = '正在生成接入命令……'
  } else if (e.create.isError) {
    tone = 'crit'
    body = `没能生成接入命令：${errorMessage(e.create.error)}`
  } else if (e.expired) {
    tone = 'crit'
    body = '这条接入命令已经失效：生成后 30 分钟内有效，而且只能用一次。点「重新生成」换一条。'
  } else if (joined) {
    tone = 'good'
    body = <Joined id={joined.deviceId} device={device} onOpen={e.close} />
  } else if (e.create.data) {
    // now 最多慢 5 秒，向上取整的话刚生成时会显示成 31 分钟
    const left = Math.max(1, Math.round((Date.parse(e.create.data.expiresAt) - now) / 60_000))
    body = (
      <>
        等待设备运行命令……命令还有 {left} 分钟有效，只能用一次。
        {e.status.isError && (
          <span className={s.retrying}>暂时问不到接入状态（{errorMessage(e.status.error)}），会继续重试。</span>
        )}
      </>
    )
  }

  const Icon = tone === 'good' ? CircleCheck : tone === 'crit' ? CircleAlert : LoaderCircle
  return (
    <div className={cx(s.enrollState, s[tone])} role="status">
      {body !== undefined && (
        <>
          <Icon className={tone === 'wait' ? s.spin : undefined} aria-hidden />
          <div className={s.enrollText}>{body}</div>
        </>
      )}
    </div>
  )
}

/** 接入成功之后，设备自己上报的状态：Agent 在不在线、本机 sing-box 起没起来 */
function Joined({ id, device, onOpen }: { id: string; device: Device | null; onOpen: () => void }) {
  if (!device) return <p>设备已经接入。</p>
  let detail: string
  if (!device.online) detail = '正在等它第一次上报……'
  else if (device.singboxError) detail = `Agent 在线，但本机的 sing-box 没起来：${device.singboxError}`
  else if (device.proxyListen) detail = `在线，本机代理 ${device.proxyListen}（HTTP 和 SOCKS5 共用这个端口）。`
  else detail = 'Agent 在线，正在启动本机的 sing-box……'
  return (
    <>
      <p className={s.joinedTitle}>「{device.name}」已经接入</p>
      <p>{detail}</p>
      <Link to={`/devices/${id}`} onClick={onOpen}>
        查看这台设备
      </Link>
    </>
  )
}

function DeviceTable({ c, rts, now }: { c: Catalog; rts: GroupRuntime[]; now: number }) {
  return (
    <TableScroll label="设备" minWidth={820}>
      <table className={t.table}>
        <thead>
          <tr>
            <th>设备</th>
            <th>连接</th>
            <th>各分组的出口</th>
            <th>系统和版本</th>
          </tr>
        </thead>
        <tbody>
          {c.devices.map((d) => (
            <tr key={d.id}>
              <td>
                <Link to={`/devices/${d.id}`} className={t.name}>
                  {d.name}
                </Link>
                <div className={cx(t.sub, 'mono')}>{d.hostname}</div>
                {d.note && <div className={t.sub}>{d.note}</div>}
              </td>
              <td className={t.nowrap}>
                <Presence d={d} now={now} />
              </td>
              <td>
                <Outlets d={d} c={c} rts={rts} />
              </td>
              <td>
                <Versions d={d} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  )
}

export function Presence({ d, now }: { d: Device; now: number }) {
  return (
    <>
      {d.online ? (
        <Badge tone="good" icon={Wifi}>
          在线
        </Badge>
      ) : (
        <Badge tone="offline" icon={WifiOff}>
          离线
        </Badge>
      )}
      <div className={t.sub}>
        <time dateTime={d.lastSeenAt} title={formatFull(d.lastSeenAt)}>
          {timeAgo(d.lastSeenAt, now)}
        </time>
        上报
      </div>
      {d.online && <LocalProxy d={d} />}
    </>
  )
}

/** 本机 sing-box 的状态。离线时不显示：那是很久以前报的，现在不一定还是这样 */
function LocalProxy({ d }: { d: Device }) {
  if (d.singboxError) {
    return (
      <Tooltip content={d.singboxError} focusable>
        <span className={s.down}>
          <OctagonAlert aria-hidden />
          sing-box 没起来
        </span>
      </Tooltip>
    )
  }
  if (!d.proxyListen) return <div className={t.sub}>sing-box 启动中</div>
  return (
    <div className={t.sub}>
      本机代理 <span className="mono">{d.proxyListen}</span>
    </div>
  )
}

function Outlets({ d, c, rts }: { d: Device; c: Catalog; rts: GroupRuntime[] }) {
  const groups = groupsOf(c, d.id)
  if (!groups.length) return <span className={t.dim}>没有应用分组</span>
  return (
    <ul className={s.outlets}>
      {groups.map((g) => {
        const rt = rts.find((r) => r.deviceId === d.id && r.groupId === g.id)
        return (
          <li key={g.id} className={s.outlet}>
            <span className={s.group}>{g.name}</span>
            <span className={s.node}>{rt && rt.activeNodeId !== null ? outletName(rt.activeNodeId, c) : '—'}</span>
            {rt && <RuntimeBadge state={rt.state} />}
          </li>
        )
      })}
    </ul>
  )
}

function Versions({ d }: { d: Device }) {
  const old = singboxTooOld(d.singboxVersion)
  return (
    <>
      <div>{osText(d)}</div>
      <div className={cx(t.sub, s.versions)}>
        <span>{singboxText(d.singboxVersion)}</span>
        {old && (
          <Tooltip content={`singweb 生成的路由规则需要 sing-box ${MIN_SINGBOX} 或更新的版本。`} focusable>
            <span className={s.old}>
              <TriangleAlert aria-hidden />
              版本过低
            </span>
          </Tooltip>
        )}
        <span>Agent {d.agentVersion}</span>
      </div>
    </>
  )
}
