/**
 * Agent 的本地状态：接入信息、本机代理的端口、sing-box 在哪。
 *
 * 存在客户机的一个 JSON 文件里，默认 ~/.singweb/agent.json。
 * 只放这台机器自己的东西（设备 id、设备密钥、端口）；分组、节点、订阅都在服务端的 PostgreSQL 里，
 * 这台机器只是执行者，换台机器重新接入就能接管。
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, hostname as osHostname, platform as osPlatform } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_LISTEN } from '../../shared/singbox.ts'
import type { Platform } from '../../shared/types.ts'

/**
 * 状态文件的格式版本。
 *
 * 1：Agent 只去切用户自己那个 sing-box 的 selector，clashApi 指向用户的进程。
 * 2：sing-box 由 Agent 自己启动和维护，Clash API 的端口和密钥都是 Agent 生成的。
 *    旧文件里的那一对指向别人的进程，升级时丢掉，其余的（接入身份、名字）照用。
 */
const STATE_VERSION = 2

export interface AgentState {
  version: number
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

  platform: Platform
  /** 最近一次检测到的 sing-box 版本，上报给服务端显示 */
  singboxVersion: string
  /** 自己的版本，上报用 */
  agentVersion: string

  /** sing-box 程序。写绝对路径最稳：开机自启时 PATH 里往往没有 Homebrew 的目录 */
  singboxPath: string
  /** Agent 的工作目录：sing-box 配置、阻断规则集、缓存和日志都放这里 */
  dataDir: string
  /** Agent 启动的 sing-box 的 Clash API，只监听本机，Agent 通过它切 selector */
  clashApi: string
  /** Clash API 的密钥，Agent 自己生成，不离开这台机器 */
  clashSecret: string
  /** 本机代理的监听地址，HTTP 和 SOCKS5 共用。浏览器和系统代理指向它 */
  proxyListen: string

  /** 探测用的 sing-box 监听地址，单独开一个进程，跟本机代理互不影响 */
  probeListen: string
  /** 探测进程的 Clash API 端口，只监听本机 */
  probeApiPort: number
}

/** 不写路径时按这个名字到 PATH 里找 */
const SINGBOX_NAME = 'sing-box'

/** Agent 的根目录，SINGWEB_HOME 可以改 */
export function singwebHome(): string {
  return process.env.SINGWEB_HOME || join(homedir(), '.singweb')
}

export function statePath(): string {
  return join(singwebHome(), 'agent.json')
}

/** 安装脚本在系统里找不到 sing-box 时，把官方发布的程序放在这里 */
export function bundledSingbox(): string {
  return join(singwebHome(), 'bin', osPlatform() === 'win32' ? 'sing-box.exe' : 'sing-box')
}

/**
 * 数据目录。同一台机器接入多台设备时按实例名分开，
 * 否则两个 Agent 会互相覆盖配置、阻断规则集和探测配置。
 */
function dataDirFor(instance: string): string {
  return join(singwebHome(), 'devices', safeName(instance))
}

/** 实例名要能当目录名用：路径分隔符和空字符都不能出现 */
function safeName(raw: string): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'default'
}

/** 按实例名散开端口，同一台机器上的几个实例不会撞号 */
function digestOf(instance: string): Buffer {
  return createHash('sha256').update(instance).digest()
}

/** 探测进程的 Clash API 端口 */
function probeApiPortFor(instance: string): number {
  const digest = digestOf(instance)
  return 19_000 + ((digest[0] * 256 + digest[1]) % 1000)
}

/** Agent 启动的 sing-box 的 Clash API 端口，跟探测进程错开一个千位 */
function clashPortFor(instance: string): number {
  const digest = digestOf(instance)
  return 18_000 + ((digest[2] * 256 + digest[3]) % 1000)
}

/**
 * sing-box 在哪。依次看：保存过的路径、SINGBOX_PATH、安装脚本放的那一份、
 * Homebrew 的两个常见位置，最后才交给 PATH。
 *
 * 保存的值是裸名字 sing-box 时不算数：那是旧版的默认值，开机自启时 PATH 里很可能找不到。
 */
export function resolveSingbox(saved: string): string {
  if (saved && saved !== SINGBOX_NAME) return saved
  const fromEnv = str(process.env.SINGBOX_PATH)
  if (fromEnv) return fromEnv
  const known = [bundledSingbox(), '/opt/homebrew/bin/sing-box', '/usr/local/bin/sing-box']
  return known.find((path) => existsSync(path)) ?? SINGBOX_NAME
}

/**
 * fresh 表示本地还没有当前格式的状态文件：第一次接入，或者是旧版留下的。
 * 这时本机代理端口还没定下来，接入时要挑一个空着的。
 */
export async function loadState(): Promise<{ state: AgentState; path: string; fresh: boolean }> {
  const path = statePath()
  const saved = await readJson(path)
  const instance = str(saved.instance) || str(process.env.SINGWEB_INSTANCE) || hostnameName()
  // 版本对不上的文件来自只切 selector 的旧版，里面的 Clash API 是用户自己的 sing-box
  const current = saved.version === STATE_VERSION

  const state: AgentState = {
    version: STATE_VERSION,
    server: normalizeServer(str(saved.server) || str(process.env.SINGWEB_SERVER)),
    deviceId: str(saved.deviceId) || null,
    secret: str(saved.secret) || null,
    name: str(saved.name) || instance,
    instance,
    platform: currentPlatform(),
    singboxVersion: str(saved.singboxVersion),
    agentVersion: str(saved.agentVersion),
    singboxPath: resolveSingbox(str(saved.singboxPath)),
    dataDir: str(saved.dataDir) || dataDirFor(instance),
    clashApi: (current && str(saved.clashApi)) || `127.0.0.1:${clashPortFor(instance)}`,
    clashSecret: (current && str(saved.clashSecret)) || randomBytes(16).toString('hex'),
    proxyListen:
      (current && str(saved.proxyListen)) || str(process.env.SINGWEB_LISTEN) || DEFAULT_LISTEN,
    probeListen: str(saved.probeListen) || '127.0.0.1:0',
    probeApiPort: Number.isInteger(saved.probeApiPort)
      ? (saved.probeApiPort as number)
      : probeApiPortFor(instance),
  }
  return { state, path, fresh: !current }
}

export async function saveState(path: string, state: AgentState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const content = { ...state, version: STATE_VERSION }
  await writeFile(path, `${JSON.stringify(content, null, 2)}\n`, 'utf8')
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

export function currentPlatform(): Platform {
  const platform = osPlatform()
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return 'macos'
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
