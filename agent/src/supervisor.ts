/**
 * 守着 Agent 自己启动的那个 sing-box：启动、看着、挂了就重启。
 *
 * 配置只换一次就生效：写入新配置之前先跑 `sing-box check`，过了才替换并重启，
 * 没过就继续跑旧的，把原因留在本机日志和上报里。用户改坏一个分组不该让本机断网。
 *
 * 退出后按 1s、2s、4s……最多 60s 退避重启；跑满 60s 就算稳定，退避重置。
 *
 * 上一轮崩溃可能留下孤儿 sing-box，启动前收一个：但要同时满足「Clash API 用当时那份
 * 密钥答话」和「进程名是 sing-box」两条，缺一条就不碰。宁可报端口被占用，也不能误杀
 * 用户自己的代理进程（比如别的 TUN 工具）。
 */

import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  MIN_SINGBOX,
  blockRuleSetContent,
  splitListenAddress,
  versionAtLeast,
} from '../../shared/singbox.ts'
import type { BuiltConfig } from '../../shared/singbox.ts'
import { ClashApi } from './singbox.ts'

/** 启动到 Clash API 答话的等待上限。规则集要从网上拉，慢一点是正常的 */
const START_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 250
/** 停机宽限：给它几秒自己收摊 */
const STOP_TIMEOUT_MS = 5000
/** check 卡住多半是网络规则集在拉，别无限等 */
const CHECK_TIMEOUT_MS = 30_000

const RESTART_MIN_MS = 1000
const RESTART_MAX_MS = 60_000
/** 连续跑满这么久算稳定，退避重置 */
const STABLE_AFTER_MS = 60_000

/** 日志超过这个大小就轮转一份 */
const LOG_ROTATE_BYTES = 2 * 1024 * 1024
/** 出错时留着给人看的最后几行 */
const TAIL_LINES = 20

export interface SupervisorOptions {
  singboxPath: string
  dataDir: string
  clashApi: string
  clashSecret: string
  /** 本机代理的监听地址，同时用来占端口预检 */
  proxyListen: string
}

interface PidRecord {
  pid: number
  clashApi: string
  secret: string
  startedAt: string
}

export class Supervisor {
  private readonly options: SupervisorOptions
  private readonly api: ClashApi

  private child: ChildProcess | null = null
  private ready = false
  /** 当前正在生效的那份生成结果（用来反查 tag） */
  private runningConfig: BuiltConfig | null = null
  /** 已经落到 config.json 的 JSON 文本，用来判断要不要重启 */
  private appliedJson = ''
  /** 上次 check 没过的 JSON 文本，同一份不再重复 check */
  private rejectedJson = ''
  /** sing-box 跑不起来（端口被占、启动即退出） */
  private runProblem: string | null = null
  /** 生成的配置有问题（check 没过） */
  private configProblem: string | null = null
  private version = ''
  private stopping = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private backoffMs = RESTART_MIN_MS
  private startedAt = 0
  private tail: string[] = []
  private log: WriteStream | null = null
  private logBytes = 0
  /** 已写过的阻断规则集内容，避免每轮都动文件 */
  private readonly blockWritten = new Map<string, string>()
  /** 主动停掉的进程，退出回调不该把它当成崩溃 */
  private readonly retired = new WeakSet<ChildProcess>()
  /** apply / setBlocking / start 串行执行，避免两次重启打架 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: SupervisorOptions) {
    this.options = options
    this.api = new ClashApi(options.clashApi, options.clashSecret)
  }

  /** 当前生效的配置；没跑起来时是 null */
  get current(): BuiltConfig | null {
    return this.ready ? this.runningConfig : null
  }

  /** 给人看的出错原因；跑起来之后就没有了 */
  get error(): string | null {
    return this.runProblem ?? this.configProblem
  }

  /** 本机代理的监听地址；sing-box 没起来时是空串 */
  get listen(): string {
    return this.ready ? this.options.proxyListen : ''
  }

  get singboxVersion(): string {
    return this.version
  }

  get running(): boolean {
    return this.ready
  }

  /** 给引擎用的 Clash API 客户端（切 selector） */
  get clash(): ClashApi {
    return this.api
  }

  get configPath(): string {
    return join(this.options.dataDir, 'config.json')
  }

  private get pidPath(): string {
    return join(this.options.dataDir, 'singbox.pid')
  }

  private get logPath(): string {
    return join(this.options.dataDir, 'singbox.log')
  }

  /**
   * 应用一份新配置：写规则集、check、替换、重启，全程不抛异常。
   * 失败写进 configProblem，由上报带到网页上。
   */
  async apply(built: BuiltConfig, blocking: ReadonlySet<string>): Promise<void> {
    await this.serial(async () => {
      try {
        await this.ensureDataDir()
        if (!(await this.ensureVersion())) return
        await this.writeBlocks(built, blocking)

        const json = `${JSON.stringify(built.config, null, 2)}\n`
        if (json === this.appliedJson) {
          // 内容没变，只更新对照表（比如分组改名但生成结果一样）
          this.runningConfig = built
          this.configProblem = null
          return
        }
        if (json === this.rejectedJson) return

        const next = join(this.options.dataDir, 'config.next.json')
        await writeFile(next, json, { encoding: 'utf8', mode: 0o600 })

        const problem = await this.check(next)
        if (problem) {
          await rm(next, { force: true }).catch(() => {})
          this.rejectedJson = json
          this.configProblem = this.appliedJson
            ? `新的配置没有通过 sing-box check，继续用之前的配置：${problem}`
            : `生成的配置没有通过 sing-box check，本机代理没有启动：${problem}`
          console.error(this.configProblem)
          return
        }

        await rename(next, this.configPath)
        this.appliedJson = json
        this.rejectedJson = ''
        this.runningConfig = built
        this.configProblem = null
        this.backoffMs = RESTART_MIN_MS
        this.restart()
      } catch (err) {
        this.configProblem = `应用配置时出错：${message(err)}`
        console.error(this.configProblem)
      }
    })
  }

  /** 只改阻断规则集的内容，不重启 sing-box：它是文件监视的，改完自己会读 */
  async setBlocking(blocking: ReadonlySet<string>): Promise<void> {
    const built = this.runningConfig
    if (!built) return
    await this.serial(() => this.writeBlocks(built, blocking))
  }

  /** 主动停掉，之后不再重启 */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    await this.serial(() => this.halt())
    this.log?.end()
    this.log = null
  }

  // ------------------------------------------------------------ 内部

  private async ensureDataDir(): Promise<void> {
    await mkdir(this.options.dataDir, { recursive: true })
    // 目录里有节点凭据和探测配置
    await chmod(this.options.dataDir, 0o700).catch(() => {})
  }

  /** sing-box 在不在、版本够不够。返回 false 表示已经写好了 configProblem */
  private async ensureVersion(): Promise<boolean> {
    if (this.version) return true
    const path = this.options.singboxPath
    const out = await new Promise<{ code: number; text: string }>((resolve) => {
      execFile(path, ['version'], { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1
          resolve({ code, text: `${stdout}${stderr}` })
          return
        }
        resolve({ code: 0, text: `${stdout}${stderr}` })
      })
    })

    if (out.code !== 0) {
      this.configProblem =
        (out.text.includes('ENOENT') || out.code === -1 ? '' : '') +
        `找不到 sing-box（${path}）。装好 sing-box，或者用 --singbox 指定它的路径。`
      if (out.code !== -1) {
        this.configProblem = `跑 ${path} version 失败了（退出码 ${out.code}）：${out.text.trim().slice(0, 300)}`
      }
      console.error(this.configProblem)
      return false
    }

    const matched = /(\d+\.\d+\.\d+)/.exec(out.text)
    if (!matched) {
      this.configProblem = `没法确认 sing-box 的版本（${path}）：${out.text.trim().slice(0, 200)}`
      console.error(this.configProblem)
      return false
    }
    if (!versionAtLeast(matched[1], MIN_SINGBOX)) {
      this.configProblem = `sing-box ${matched[1]} 太旧了，至少要 ${MIN_SINGBOX}。升级之后重新运行 Agent。`
      console.error(this.configProblem)
      return false
    }
    this.version = matched[1]
    return true
  }

  /** 用 sing-box 自己的 check 过一遍；返回 null 表示通过 */
  private async check(path: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      execFile(
        this.options.singboxPath,
        ['check', '-c', path],
        { timeout: CHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (!err) {
            resolve(null)
            return
          }
          const text = `${stdout}${stderr}`.trim() || message(err)
          resolve(text.slice(0, 500))
        },
      )
    })
  }

  /** 把配置里引用的本地规则集写成该有的内容 */
  private async writeBlocks(built: BuiltConfig, blocking: ReadonlySet<string>): Promise<void> {
    const route = built.config.route as { rule_set?: Array<Record<string, unknown>> } | undefined
    const ruleSets = route?.rule_set ?? []
    for (const item of ruleSets) {
      if (item.type !== 'local') continue
      const tag = String(item.tag ?? '')
      const path = String(item.path ?? '')
      if (!tag || !path) continue
      const content = blocking.has(tag) ? blockRuleSetContent.blocking : blockRuleSetContent.idle
      const json = `${JSON.stringify(content, null, 2)}\n`
      if (this.blockWritten.get(path) === json) continue
      const temp = `${path}.tmp`
      await writeFile(temp, json, 'utf8').catch(() => {})
      await rename(temp, path).catch(() => {})
      this.blockWritten.set(path, json)
    }
  }

  /** 换配置之后重启：先停再起，端口腾出来再开 */
  private restart(): void {
    if (this.stopping) return
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    void this.serial(async () => {
      await this.halt()
      await this.start()
    })
  }

  private async start(): Promise<void> {
    if (this.stopping || !this.appliedJson || this.child) return
    try {
      await this.reapOrphan()
      await this.ensurePortsFree()
      await this.spawnAndWait()
      this.runProblem = null
    } catch (err) {
      this.runProblem = `sing-box 没能启动：${message(err)}`
      console.error(this.runProblem)
      this.scheduleRestart()
    }
  }

  /** 代理端口和 Clash API 端口都得空着，否则 sing-box 会起来就退 */
  private async ensurePortsFree(): Promise<void> {
    const [proxyHost, proxyPort] = splitListenAddress(this.options.proxyListen)
    if (!(await canBind(proxyHost, proxyPort))) {
      throw new Error(
        `本机代理端口 ${proxyPort} 被别的程序占用了。关掉占用它的程序，或者用 --listen 换一个端口重新运行 Agent。`,
      )
    }
    const [apiHost, apiPort] = splitListenAddress(this.options.clashApi)
    if (!(await canBind(apiHost, apiPort))) {
      throw new Error(
        `Clash API 端口 ${apiPort} 被别的程序占用了，用 --clash-api 换一个端口重新运行 Agent。`,
      )
    }
  }

  private async spawnAndWait(): Promise<void> {
    await this.openLog()
    const child = spawn(
      this.options.singboxPath,
      ['run', '-c', this.configPath, '-D', this.options.dataDir],
      { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, windowsHide: true },
    )
    this.child = child
    this.ready = false
    this.tail = []
    this.startedAt = Date.now()

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => this.capture(text))
    child.stderr?.on('data', (text: string) => this.capture(text))

    let gone = false
    let goneText = ''

    child.on('error', (err) => {
      // 进程根本没起来时不会再有 exit，得自己收尾
      if (gone) return
      gone = true
      goneText = message(err)
      this.onExit(child, goneText)
    })
    child.on('exit', (code, signal) => {
      if (gone) return
      gone = true
      goneText = signal ? `收到 ${signal}` : `退出码 ${code}`
      this.onExit(child, goneText)
    })

    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (gone) {
        const tail = this.tailText()
        throw new Error(
          `sing-box 启动后马上退出了（${goneText}）${tail ? `：\n${tail}` : ''}`,
        )
      }
      const version = await this.api.version().catch(() => null)
      if (version) {
        this.version = /(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? this.version
        this.ready = true
        await this.writePid(child.pid)
        return
      }
      await sleep(POLL_INTERVAL_MS)
    }

    await this.halt()
    throw new Error(
      `等了 ${START_TIMEOUT_MS / 1000} 秒，sing-box 的 Clash API 还是没答话。${this.tailText() ? `\n${this.tailText()}` : ''}`,
    )
  }

  private onExit(child: ChildProcess, text: string): void {
    if (this.child !== child) return
    this.child = null
    this.ready = false
    void this.clearPid()

    // 自己停的、或者还没跑起来就退了的，不算崩溃
    if (this.retired.has(child) || this.stopping) return
    if (!this.startedAt) return

    const uptime = Date.now() - this.startedAt
    if (uptime >= STABLE_AFTER_MS) this.backoffMs = RESTART_MIN_MS

    const tail = this.tailText()
    this.runProblem = `sing-box 意外退出（${text}）${tail ? `：\n${tail}` : ''}`
    console.error(this.runProblem)
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(RESTART_MAX_MS, this.backoffMs * 2)
    console.error(`将在 ${Math.round(delay / 1000)} 秒后重试启动 sing-box。`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.serial(() => this.start())
    }, delay)
  }

  /** 停掉当前的 sing-box，并保证不会再自己起来 */
  private async halt(): Promise<void> {
    const child = this.child
    this.child = null
    this.ready = false
    if (!child) {
      await this.clearPid()
      return
    }
    this.retired.add(child)
    await terminate(child)
    await this.clearPid()
  }

  private async writePid(pid: number | undefined): Promise<void> {
    if (!pid) return
    const record: PidRecord = {
      pid,
      clashApi: this.options.clashApi,
      secret: this.options.clashSecret,
      startedAt: new Date().toISOString(),
    }
    await writeFile(this.pidPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    }).catch(() => {})
  }

  private async clearPid(): Promise<void> {
    await rm(this.pidPath, { force: true }).catch(() => {})
  }

  /**
   * 收上一个进程留下的孤儿 sing-box。
   *
   * 判断依据两条缺一不可：它用当时那份 Clash API 密钥答话，且进程名里有 sing-box。
   * 只按 pid 杀是不行的——pid 会被系统复用，撞上用户的别的程序就是事故。
   */
  private async reapOrphan(): Promise<void> {
    const saved = await readPidRecord(this.pidPath)
    await this.clearPid()
    if (!saved) return
    if (this.child?.pid === saved.pid) return
    if (!isAlive(saved.pid)) return

    const answers = await new ClashApi(saved.clashApi, saved.secret)
      .version()
      .catch(() => null)
    if (!answers) return
    if (!(await looksLikeSingbox(saved.pid))) return

    console.error(`发现上次留下的 sing-box（pid ${saved.pid}），先把它停掉。`)
    await killPid(saved.pid)
  }

  private capture(text: string): void {
    const clean = text.replace(/\x1b\[[0-9;]*m/g, '')
    this.log?.write(clean)
    this.logBytes += Buffer.byteLength(clean)
    for (const line of clean.split('\n')) {
      const trimmed = line.trimEnd()
      if (!trimmed) continue
      this.tail.push(trimmed)
    }
    if (this.tail.length > TAIL_LINES * 3) this.tail = this.tail.slice(-TAIL_LINES * 3)
  }

  private tailText(): string {
    return this.tail.slice(-TAIL_LINES).join('\n')
  }

  private async openLog(): Promise<void> {
    if (this.log) return
    await this.ensureDataDir()
    try {
      this.logBytes = statSync(this.logPath).size
    } catch {
      this.logBytes = 0
    }
    if (this.logBytes > LOG_ROTATE_BYTES) {
      try {
        renameSync(this.logPath, `${this.logPath}.1`)
        this.logBytes = 0
      } catch {
        // 轮转不了就直接续写，比丢掉日志强
      }
    }
    this.log = createWriteStream(this.logPath, { flags: 'a', mode: 0o600 })
    this.log.on('error', () => {})
  }

  private serial<T>(task: () => Promise<T>): Promise<T | undefined> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run.catch(() => undefined)
  }
}

/** 退出时把上次留下的孤儿 sing-box 收掉，`leave` 用 */
export async function stopLeftover(dataDir: string): Promise<void> {
  const pidPath = join(dataDir, 'singbox.pid')
  const saved = await readPidRecord(pidPath)
  await rm(pidPath, { force: true }).catch(() => {})
  if (!saved || !isAlive(saved.pid)) return
  const answers = await new ClashApi(saved.clashApi, saved.secret)
    .version()
    .catch(() => null)
  if (!answers || !(await looksLikeSingbox(saved.pid))) return
  await killPid(saved.pid)
}

async function readPidRecord(path: string): Promise<PidRecord | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PidRecord>
    if (!parsed || typeof parsed.pid !== 'number') return null
    return {
      pid: parsed.pid,
      clashApi: typeof parsed.clashApi === 'string' ? parsed.clashApi : '',
      secret: typeof parsed.secret === 'string' ? parsed.secret : '',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    }
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // 别人的进程（非本用户）会返回 EPERM：既不是我们的，也停不掉它，当它不存在
    return false
  }
}

/** 进程名里有没有 sing-box。用系统自带工具，不引第三方依赖 */
function looksLikeSingbox(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']]
        : ['ps', ['-p', String(pid), '-o', 'comm=']]
    execFile(cmd as string, args as string[], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(false)
        return
      }
      resolve(String(stdout).toLowerCase().includes('sing-box'))
    })
  })
}

/** 先礼后兵：SIGTERM，宽限期内没走就 SIGKILL */
async function killPid(pid: number): Promise<void> {
  if (!isAlive(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return
    await sleep(200)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已经没了
  }
  await sleep(500)
}

/** 等一个子进程退出；超时就 SIGKILL */
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!child.pid) return

  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(hard)
      clearTimeout(giveUp)
      resolve()
    }
    const hard = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }, STOP_TIMEOUT_MS)
    const giveUp = setTimeout(finish, STOP_TIMEOUT_MS + 2000)
    child.once('exit', finish)
    try {
      child.kill('SIGTERM')
    } catch {
      finish()
    }
  })
}

function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host === '0.0.0.0' ? undefined : host)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
