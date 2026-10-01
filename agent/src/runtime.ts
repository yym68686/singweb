/**
 * 探测用的那个 sing-box 进程。
 *
 * 它跟设备上主进程是两回事：主进程跑用户自己的流量，这个只跑探测。
 * 配置写在一个单独的 JSON 文件里，SOCKS 端口和 Clash API 端口都由这里先试绑选好再写进去，
 * 然后按节点算出用户名。端口不能交给系统分配：sing-box 的 /configs 返回的是 Clash 格式的
 * 摘要，里面没有入站列表，分配掉的号就问不回来了。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoredNode } from '../../shared/types.ts'
import type { AgentState } from './config.ts'
import { ClashApi } from './singbox.ts'
import { buildProbeConfig, probeUsers, splitListen } from './probeconfig.ts'
import type { ProbeEndpoint } from './probe.ts'

/** 等进程起来、Clash API 有响应，最多等这么久 */
const START_TIMEOUT_MS = 8000
const POLL_INTERVAL_MS = 250
/** 停机宽限：SIGTERM 之后等这么久再强杀 */
const STOP_TIMEOUT_MS = 2000
/** 探测进程起不来、中途退出时，带上它最后这几行输出 */
const TAIL_LINES = 6

export interface ProbeRuntime {
  /** 探测进程里 SOCKS5 的监听地址 */
  readonly listen: string
  /** 某个节点在探测进程里对应的凭据 */
  endpointFor(nodeId: string): ProbeEndpoint
  stop(): Promise<void>
}

export async function openProbeRuntime(input: {
  state: AgentState
  nodes: StoredNode[]
  /** 起来之后又意外退出时调用。output 是 sing-box 最后几行输出，每行缩进两格，可能为空 */
  onExit(reason: string, output: string): void
}): Promise<ProbeRuntime> {
  const { state, nodes } = input
  const usable = nodes.filter((n) => n.enabled)
  if (!usable.length) throw new Error('没有要探测的节点，不需要起探测进程。')
  await mkdir(state.dataDir, { recursive: true })

  const password = randomBytes(12).toString('hex')
  const apiPort = await freePortFrom(state.probeApiPort)
  // SOCKS 端口也自己定，不写 0 让系统分配。
  // sing-box 的 Clash API /configs 返回的是 Clash 格式的摘要（只有 port、socks-port 这些），
  // 里面没有 inbounds 数组，问不出真实监听端口——那个形状是 mihomo 的。
  // 端口自己拿着，就不用问了。
  const [socksHost, configuredPort] = splitListen(state.probeListen)
  const socksPort = configuredPort || (await freePortFrom(state.probeApiPort + 1, apiPort))
  const listen = `${socksHost}:${socksPort}`

  const configPath = join(state.dataDir, 'probe.json')
  const config = buildProbeConfig({ nodes: usable, apiPort, password, listen })
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const child = spawn(state.singboxPath, ['run', '-c', configPath], {
    // sing-box 的日志只写 stderr
    stdio: ['ignore', 'ignore', 'pipe'],
    // 环境变量照传：sing-box 要用 TMPDIR、SSL_CERT_FILE 这些
    env: process.env,
    windowsHide: true,
  })

  // 探测就是挨个去试，连不上的节点 sing-box 每次都会报一行 ERROR。这些结论已经记进了
  // 探测结果，平时不往日志里打；只留最后几行，起不来或者中途退出时拿来说明原因。
  const tail: string[] = []
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (text: string) => {
    for (const line of text.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
      if (line.trim()) tail.push(`  ${line.trim()}`)
    }
    tail.splice(0, Math.max(0, tail.length - TAIL_LINES))
  })
  const output = () => tail.join('\n')

  // 起来之前就退出的，由下面 waitForApi 抛错说明；起来之后才算中途退出，交给调用方
  let started = false
  let stopped = false
  let gone: string | null = null
  const onGone = (reason: string) => {
    if (gone !== null) return
    gone = reason
    if (started && !stopped) input.onExit(reason, output())
  }
  // 起不来（比如路径不存在）时只有 error 事件，不会有 close
  child.on('error', (err) => onGone(err instanceof Error ? err.message : String(err)))
  // 用 close 不用 exit：close 要等输出读完才来，最后那几行才不会漏掉
  child.on('close', (code, signal) => onGone(signal ? `收到 ${signal}` : `退出码 ${code}`))

  // 起不来就把子进程收掉。留着它的话 Clash API 端口一直被占，
  // 下一轮重试会撞上同一个端口，永远起不来。
  const api = new ClashApi(`127.0.0.1:${apiPort}`, '')
  try {
    await waitForApi(api, () => gone)
  } catch (err) {
    stopped = true
    child.kill('SIGKILL')
    const text = output()
    if (!text) throw err
    throw new Error(`${err instanceof Error ? err.message : String(err)}，sing-box 最后的输出：\n${text}`)
  }
  started = true
  const users = probeUsers(usable)

  return {
    listen,
    endpointFor(nodeId: string): ProbeEndpoint {
      const username = users.get(nodeId)
      if (!username) throw new Error(`探测进程里没有这个节点（${nodeId}）`)
      return { socksHost, socksPort, username, password }
    },
    async stop() {
      // 主动停的，退出时别再当成意外报给调用方
      stopped = true
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const deadline = Date.now() + STOP_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) return
        await sleep(100)
      }
      // SIGTERM 之后 child.killed 就是 true 了，不能拿它判断死没死
      child.kill('SIGKILL')
      await sleep(200)
    },
  }
}

/**
 * 等探测进程的 Clash API 有响应。有响应就说明进程起稳了，SOCKS 入站也一起在听了
 * （两者在同一个进程里，配置是一次读完的）。
 *
 * 这里只问 API 通不通，不问端口——端口是本文件选好写进配置的，不需要问。
 * gone 返回进程没了的原因，没了就不用再等。
 */
async function waitForApi(api: ClashApi, gone: () => string | null): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  let lastError = ''
  while (Date.now() < deadline) {
    const reason = gone()
    if (reason !== null) throw new Error(`${reason}，检查 sing-box 的路径和版本`)
    try {
      await api.requestRaw('GET', '/configs')
      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`${START_TIMEOUT_MS / 1000} 秒内 Clash API 都没有响应${lastError ? `（${lastError}）` : ''}`)
}

/**
 * 找一个能绑的端口。配置里那个号是按设备名算出来的，固定不变，
 * 但上一个探测进程刚退出时它可能还在 TIME_WAIT（sing-box 自己抓 /configs 留下的），
 * 这时直接起会 bind 失败。所以先试着绑一下，占着就往后顺延。
 *
 * skip 用来避开同一个进程里已经选走的端口（Clash API 和 SOCKS 两个号不能撞）。
 */
async function freePortFrom(start: number, skip?: number): Promise<number> {
  for (let port = start; port < start + 20; port += 1) {
    if (port === skip) continue
    if (await canBind(port)) return port
  }
  // 这里不能返回 0：Clash API 的 external_controller 要的是真实端口，
  // 写 0 它不会自己分配。连撞 20 个号只能说明本机端口乱得离谱。
  throw new Error(`端口 ${start} 起连续 20 个都被占着，起不了探测进程。`)
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
