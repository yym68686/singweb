/**
 * Agent 的本地状态：接入信息、sing-box 路径、探测端口。
 *
 * 存在客户机的一个 JSON 文件里，默认 ~/.singweb/agent.json。
 * 只放接入之后才有的东西（设备 id 和设备密钥）；分组、节点、订阅链接都在服务端的 PostgreSQL 里，
 * 这台机器只是执行者，换台机器重新接入就能接管。
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, hostname as osHostname, platform as osPlatform } from 'node:os'
import { dirname, join } from 'node:path'

export interface AgentState {
  /** 管理服务的地址，例如 https://singweb.example.com */
  server: string
  /** 接入成功后服务端给的设备 id，重新接入时会带上它，避免建出重复设备 */
  deviceId: string | null
  /** 设备密钥。Agent 的身份证，服务端按它认设备 */
  secret: string | null
  /** 界面上显示的设备名称 */
  name: string
  /** 去重用的实例名。同一台机器可以接入多台设备，用名字区分 */
  instance: string

  platform: 'macos' | 'linux'
  /** 接入时记下来的 sing-box 版本，上报给服务端显示 */
  singboxVersion: string
  /** 自己的版本，上报用 */
  agentVersion: string

  singboxPath: string
  /** sing-box 的工作目录，生成的分组配置、阻断规则集放这里 */
  dataDir: string
  /** 主 sing-box 的 Clash API，Agent 通过它切 selector */
  clashApi: string
  /** Clash API 的密钥，没有就留空 */
  clashSecret: string

  /** 探测用的 sing-box 监听地址，单独开一个进程，不打扰主配置 */
  probeListen: string
  /** 探测进程的 Clash API 端口，只监听本机 */
  probeApiPort: number
}

const DEFAULTS = {
  singboxPath: 'sing-box',
  clashApi: '127.0.0.1:9090',
}

export function statePath(): string {
  const override = process.env.SINGWEB_HOME
  return join(override ?? join(homedir(), '.singweb'), 'agent.json')
}

/**
 * 数据目录。同一台机器接入多台设备时按实例名分开，
 * 否则两个 Agent 会互相覆盖阻断规则集和探测配置。
 */
function dataDirFor(instance: string): string {
  const root = process.env.SINGWEB_HOME ?? join(homedir(), '.singweb')
  return join(root, 'devices', safeName(instance))
}

/** 实例名要能当目录名用：路径分隔符和空字符都不能出现 */
function safeName(raw: string): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'default'
}

/** 探测进程的 Clash API 端口。按实例名散开，避免同一台机器上撞号 */
function probeApiPortFor(instance: string): number {
  const digest = createHash('sha256').update(instance).digest()
  return 19_000 + (digest[0] * 256 + digest[1]) % 1000
}

export async function loadState(): Promise<{ state: AgentState; path: string }> {
  const path = statePath()
  const saved = await readJson(path)
  const instance =
    str(saved.instance) || str(process.env.SINGWEB_INSTANCE) || hostnameName()

  const state: AgentState = {
    server: normalizeServer(str(saved.server) || process.env.SINGWEB_SERVER || ''),
    deviceId: str(saved.deviceId) || null,
    secret: str(saved.secret) || null,
    name: str(saved.name) || instance,
    instance,
    platform: saved.platform === 'linux' ? 'linux' : currentPlatform(),
    singboxVersion: str(saved.singboxVersion),
    agentVersion: str(saved.agentVersion),
    singboxPath: str(saved.singboxPath) || process.env.SINGBOX_PATH || DEFAULTS.singboxPath,
    dataDir: str(saved.dataDir) || dataDirFor(instance),
    clashApi: str(saved.clashApi) || process.env.SINGBOX_CLASH_API || DEFAULTS.clashApi,
    clashSecret: str(saved.clashSecret) || process.env.SINGBOX_CLASH_SECRET || '',
    probeListen: str(saved.probeListen) || '127.0.0.1:0',
    probeApiPort: Number.isInteger(saved.probeApiPort)
      ? (saved.probeApiPort as number)
      : probeApiPortFor(instance),
  }
  return { state, path }
}

export async function saveState(path: string, state: AgentState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  // 里面有设备密钥，别让同机器上的其他账号读到
  await chmod(path, 0o600).catch(() => {})
}

/** 服务器地址统一成不带结尾斜杠的 http(s) 形式 */
export function normalizeServer(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/^https?:\/\//.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export function apiBase(server: string): string {
  return `${normalizeServer(server)}/api/v1`
}

/** 机器名去掉 .local 之类后缀，当作设备默认名字 */
export function hostnameName(): string {
  return osHostname().replace(/\.local$/i, '')
}

export function currentPlatform(): 'macos' | 'linux' {
  return osPlatform() === 'linux' ? 'linux' : 'macos'
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
