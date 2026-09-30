/**
 * 探测用的那个 sing-box 进程。
 *
 * 它跟设备上主进程是两回事：主进程跑用户自己的流量，这个只跑探测。
 * 配置写在一个单独的 JSON 文件里，SOCKS 端口和 Clash API 端口都由这里先试绑选好再写进去，
 * 然后按节点算出用户名。端口不能交给系统分配：sing-box 的 /configs 返回的是 Clash 格式的
 * 摘要，里面没有入站列表，分配掉的号就问不回来了。
 */

import { spawn, type ChildProcess } from 'node:child_process'
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

export interface ProbeRuntime {
  /** 探测进程里 SOCKS5 的监听地址 */
  readonly listen: string
  /** 某个节点在探测进程里对应的凭据 */
  endpointFor(tag: string): ProbeEndpoint
  stop(): void
}

export async function openProbeRuntime(input: {
  state: AgentState
  nodes: StoredNode[]
  onExit(reason: string): void
}): Promise<ProbeRuntime> {
  const { state, nodes } = input
  const usable = nodes.filter((n) => n.enabled)
  await mkdir(state.dataDir, { recursive: true })

  const password = randomBytes(12).toString('hex')
  const apiPort = await freePortFrom(state.probeApiPort)
  // SOCKS 端口也自己定，不写 0 让系统分配。
  // sing-box 的 Clash API /configs 返回的是 Clash 格式的摘要（只有 port、socks-port 这些），
  // 里面没有 inbounds 数组，问不出真实监听端口——那个形状是 mihomo 的。
  // 端口自己拿着，就不用问了。
  const [socksHost, configuredPort] = splitListen(state.probeListen)
  const socksPort = configuredPort || (await freePortFrom(state.probeApiPort + 1))
  const listen = `${socksHost}:${socksPort}`

  const configPath = join(state.dataDir, 'probe.json')
  const config = buildProbeConfig({
    nodes: usable,
    apiPort,
    password,
    listen,
  })
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const child = spawn(state.singboxPath, ['run', '-c', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // 探测进程不需要外部的环境变量，隔离掉更干净
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  })

  let exited = false
  const onExit = (reason: string) => {
    if (exited) return
    exited = true
    input.onExit(reason)
  }

  child.on('exit', (code, signal) => {
    onExit(signal ? `收到 ${signal}` : `退出码 ${code}`)
  })
  // 起不来时 stderr 才是唯一线索，原样打出来
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (text) console.error(`[探测进程] ${text}`)
  })

  // 起不来就把子进程收掉。留着它的话 Clash API 端口一直被占，
  // 下一轮重试会撞上同一个端口，永远起不来。
  const api = new ClashApi(`127.0.0.1:${apiPort}`, '')
  try {
    await waitForApi(api, child)
  } catch (err) {
    exited = true
    child.removeAllListeners('exit')
    child.kill('SIGKILL')
    throw err
  }
  const users = probeUsers(usable)
  const byUser = new Map([...users.entries()].map(([user, tag]) => [tag, user]))

  return {
    listen,
    endpointFor(tag: string): ProbeEndpoint {
      const username = byUser.get(tag)
      if (!username) throw new Error(`探测进程里没有 ${tag} 这个节点`)
      return { socksHost, socksPort, username, password }
    },
    stop() {
      exited = true
      child.removeAllListeners('exit')
      child.kill('SIGTERM')
      // 给两秒收尾，还活着就强杀
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 2000).unref()
    },
  }
}

/**
 * 等探测进程的 Clash API 有响应。有响应就说明进程起稳了，SOCKS 入站也一起在听了
 * （两者在同一个进程里，配置是一次读完的）。
 *
 * 这里只问 API 通不通，不问端口——端口是本文件选好写进配置的，不需要问。
 */
async function waitForApi(api: ClashApi, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  let lastError = ''
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`探测进程没能启动（退出码 ${child.exitCode}），检查 sing-box 路径和版本`)
    }
    try {
      await api.requestRaw('GET', '/configs')
      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`等探测进程的 Clash API 超时${lastError ? `：${lastError}` : ''}`)
}

/**
 * 找一个能绑的端口。配置里那个号是按设备名算出来的，固定不变，
 * 但上一个探测进程刚退出时它可能还在 TIME_WAIT（sing-box 自己抓 /configs 留下的），
 * 这时直接起会 bind 失败。所以先试着绑一下，占着就往后顺延。
 */
async function freePortFrom(start: number): Promise<number> {
  for (let port = start; port < start + 20; port += 1) {
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
