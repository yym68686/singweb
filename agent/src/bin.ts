#!/usr/bin/env node
/**
 * Agent 的命令行入口。
 *
 * 第一次接入用带令牌的 `join`（安装脚本用的就是它），之后就 `run` 什么都不用带。
 * `run` 才是真正干活的：它管着本机那个 sing-box，按网页上的分组切换节点并持续上报。
 *
 *   join      拿令牌接入，把设备身份存下来，不启动 sing-box
 *   run       接入（如果需要）然后守着本机的 sing-box 并上报
 *   status    看本地接入状态
 *   leave     停掉自己起的 sing-box，删掉本地状态文件
 */

import { unlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { DEFAULT_LISTEN } from '../../shared/singbox.ts'
import { AGENT_VERSION, ApiClient, ApiError, readAgentVersion } from './client.ts'
import {
  apiBase,
  currentPlatform,
  hostnameName,
  loadState,
  normalizeServer,
  saveState,
  statePath,
  type AgentState,
} from './config.ts'
import { Engine } from './engine.ts'
import { Reporter, osVersionText } from './reporter.ts'
import { Supervisor, stopLeftover } from './supervisor.ts'

interface Args {
  server: string
  token: string
  name: string
  instance: string
  listen: string
  clashApi: string
  singboxPath: string
  dataDir: string
}

const FLAGS: Record<string, keyof Args> = {
  '--server': 'server',
  '--token': 'token',
  '--name': 'name',
  '--instance': 'instance',
  '--listen': 'listen',
  '--clash-api': 'clashApi',
  '--singbox': 'singboxPath',
  '--data-dir': 'dataDir',
}

/** 第一次接入时给本机代理挑端口的范围，跟 sing-box 的默认值对齐 */
const LISTEN_FROM = 2080
const LISTEN_TO = 2099

const COMMANDS = new Set(['run', 'join', 'status', 'leave', 'help'])

function parseArgs(argv: string[]): { command: string; args: Args } {
  const args: Args = {
    server: '',
    token: '',
    name: '',
    instance: '',
    listen: '',
    clashApi: '',
    singboxPath: '',
    dataDir: '',
  }
  let command = ''
  let help = false
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item === '-h' || item === '--help') {
      help = true
      continue
    }
    const key = FLAGS[item]
    if (key) {
      args[key] = argv[i + 1] ?? ''
      i += 1
      continue
    }
    if (!item.startsWith('-') && !command) command = item
  }
  return { command: help ? 'help' : command || 'run', args }
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2))
  if (command === 'help') {
    printUsage()
    return
  }
  if (!COMMANDS.has(command)) {
    console.error(`不认识这个命令：${command}`)
    printUsage()
    process.exitCode = 1
    return
  }

  // 实例名要在读状态之前生效：同一台机器上的多个实例靠它分开目录和端口
  if (args.instance) process.env.SINGWEB_INSTANCE = args.instance

  const { state, path, fresh } = await loadState()

  if (command === 'status') {
    await printStatus(state, path)
    return
  }

  if (command === 'leave') {
    await leave(state, path)
    return
  }

  // 命令行参数覆盖本地文件，同一台机器接多台设备时用得上
  const server = normalizeServer(args.server || state.server)
  // 换了管理服务，存的设备 id 和密钥是上一个服务发的，带过去只会被当成冒用
  const sameServer = !state.server || state.server === server
  const merged: AgentState = {
    ...state,
    deviceId: sameServer ? state.deviceId : null,
    secret: sameServer ? state.secret : null,
    server,
    name: args.name || state.name,
    instance: args.instance || state.instance,
    clashApi: args.clashApi || state.clashApi,
    singboxPath: singboxArg(args.singboxPath) || state.singboxPath,
    dataDir: args.dataDir || state.dataDir,
    agentVersion: await readAgentVersion(),
  }
  // 端口只在第一次接入时挑：挑完就写进状态文件，之后一直用它，
  // 交给系统分配的话下次启动就问不回来是哪个号了。用户自己指定过就听用户的。
  if (args.listen) merged.proxyListen = args.listen
  else if (fresh && !process.env.SINGWEB_LISTEN) merged.proxyListen = await pickListen()

  if (!merged.server) {
    console.error('还不知道管理服务在哪，用 --server 指定，或者设 SINGWEB_SERVER。')
    process.exitCode = 1
    return
  }

  const adopted = await adopt(merged, args.token)
  if (!adopted) return
  Object.assign(merged, adopted)
  await saveState(path, merged)

  if (command === 'join') {
    // 安装脚本接下来会自己把 run 装成开机自启，不用再教用户怎么起
    if (!process.env.SINGWEB_INSTALLER) {
      console.log(`之后运行 node "${process.argv[1]}" run 就会接管本机的 sing-box。`)
    }
    return
  }

  await run(merged)
}

/**
 * 真正干活的那条路径：起一个 Supervisor 守着 sing-box，
 * Engine 每轮从服务端拉分组、探测、切换、上报。
 */
async function run(state: AgentState): Promise<void> {
  const reporter = new Reporter(state, state.secret ?? '')
  const supervisor = new Supervisor({
    singboxPath: state.singboxPath,
    dataDir: state.dataDir,
    clashApi: state.clashApi,
    clashSecret: state.clashSecret,
    proxyListen: state.proxyListen,
  })
  const engine = new Engine(state, reporter, supervisor)

  // Ctrl-C 时让子进程收尾，不然 sing-box 和探测进程会被留成孤儿
  let leaving = false
  const stop = () => {
    if (leaving) return
    leaving = true
    console.log('\n正在退出……')
    void engine
      .stop()
      .then(() => supervisor.stop())
      .then(
        () => process.exit(0),
        () => process.exit(0),
      )
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  console.log(`本机代理：${state.proxyListen}`)
  await engine.run()
  await supervisor.stop()
}

/**
 * 拿到设备密钥。
 *
 * 带了令牌就一定拿它去注册，哪怕本地的密钥还能用：网页上的接入框在等这条令牌被用掉，
 * 不用掉它，那边就一直停在「等待设备运行命令」。没带令牌时才沿用本地的密钥。
 *
 * 重新接入时带上本地存的设备 id 和密钥：服务端核对上了才更新原来那台设备，
 * 而不是又建一台出来——不然换台机器接管就会攒下一堆幽灵设备。
 */
async function adopt(state: AgentState, token: string): Promise<Partial<AgentState> | null> {
  if (!token && state.secret) {
    const check = await checkSecret(state)
    if (check.result === 'ok') return {}
    if (check.result === 'unreachable') {
      // 网络不通多半是临时的，为这个重新接入没有意义，还会把设备记录搅乱
      console.warn(`暂时连不上 ${state.server}，先按已接入继续：${check.message}`)
      return {}
    }
  }

  if (!token) {
    console.error(
      state.secret
        ? '服务端不认存的设备密钥了（可能这台设备在网页上被删掉了），'
        : '第一次接入需要网页上生成的注册令牌。',
    )
    console.error(`打开 ${state.server} 的设备页，点「接入新设备」拿到令牌，再用 --token 跑一次。`)
    process.exitCode = 1
    return null
  }

  const api = new ApiClient(state.server, null)
  try {
    const { device, secret } = await api.register(token, {
      id: state.deviceId,
      secret: state.secret,
      name: state.name,
      hostname: hostnameName(),
      platform: currentPlatform(),
      osVersion: osVersionText(),
      agentVersion: state.agentVersion || AGENT_VERSION,
      // 这时 sing-box 还没起来，版本等第一轮上报再补上
      singboxVersion: state.singboxVersion,
      clashApi: state.clashApi,
      probeInbound: '',
      dataDir: state.dataDir,
      proxyListen: state.proxyListen,
    })
    console.log(`接入成功，设备 id 是 ${device.id}，密钥存到了 ${statePath()}`)
    return {
      deviceId: device.id,
      secret,
      platform: currentPlatform(),
      name: device.name || state.name,
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    return null
  }
}

/**
 * 设备密钥还有效吗，问一次服务端。
 *
 * 只有服务端明说凭据不行（401/403）才算 rejected。其余的失败——网络不通、
 * 服务端 5xx——都算 unreachable：说明不了密钥的好坏，由调用方决定怎么对待。
 */
async function checkSecret(
  state: AgentState,
): Promise<{ result: 'ok' | 'rejected' | 'unreachable'; message: string }> {
  if (!state.secret) return { result: 'rejected', message: '还没有设备密钥' }
  try {
    await new ApiClient(state.server, state.secret).bootstrap()
    return { result: 'ok', message: '' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return { result: 'rejected', message }
    }
    return { result: 'unreachable', message }
  }
}

async function leave(state: AgentState, path: string): Promise<void> {
  // 先把自己起的那个 sing-box 收掉，不然它会一直占着端口跑在后台
  await stopLeftover(state.dataDir)
  await unlink(path).catch(() => {})
  console.log(`已退出，本地状态文件删掉了：${path}`)
  console.log('服务端上的设备记录还在，想彻底删掉去网页的设备页。')
}

/** --singbox 给的是路径就转成绝对路径：开机自启时工作目录不是用户敲命令的那个 */
function singboxArg(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (!trimmed.includes('/') && !trimmed.includes('\\')) return trimmed
  return resolve(trimmed)
}

/** 从 2080 往后找一个能绑的端口。全占着就退回默认值，让 Supervisor 去报端口冲突 */
async function pickListen(): Promise<string> {
  for (let port = LISTEN_FROM; port <= LISTEN_TO; port += 1) {
    if (await canBind(port)) return `127.0.0.1:${port}`
  }
  return DEFAULT_LISTEN
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve_) => {
    const server = createServer()
    server.once('error', () => resolve_(false))
    server.once('listening', () => {
      server.close(() => resolve_(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function printStatus(state: AgentState, path: string): Promise<void> {
  console.log(`状态文件：${path}`)
  console.log(`管理服务：${state.server || '（没设）'}`)
  console.log(`设备名称：${state.name}（实例 ${state.instance}）`)
  console.log(`设备 id：${state.deviceId ?? '（还没接入）'}`)
  console.log(`设备密钥：${state.secret ? '已保存' : '（还没有）'}`)
  console.log(`sing-box：${state.singboxPath}`)
  console.log(`数据目录：${state.dataDir}`)
  console.log(`Clash API：${state.clashApi}`)
  console.log(`本机代理：${state.proxyListen}`)
  if (!state.secret) return

  console.log(`接口地址：${apiBase(state.server)}`)
  const check = await checkSecret(state)
  if (check.result === 'ok') console.log('服务端连通：正常')
  else if (check.result === 'rejected') {
    console.log(`服务端连通：通了，但不认这台设备的密钥（${check.message}）`)
    console.log('到网页的设备页点「接入新设备」，按上面的命令重新接入一次。')
  } else console.log(`服务端连通：连不上（${check.message}）`)
}

function printUsage(): void {
  console.log(`singweb-agent ${AGENT_VERSION} —— 把本机接进 singweb 面板

用法：
  singweb-agent join --server <地址> --token <注册令牌>  首次接入，只存身份
  singweb-agent run  --server <地址> --token <注册令牌>  首次接入并开始上报
  singweb-agent run                                      已接入过，直接跑
  singweb-agent status                                   看本地状态
  singweb-agent leave                                    退出并删掉本地身份

参数：
  --server <地址>         管理服务地址，也可以设 SINGWEB_SERVER
  --token <令牌>          网页设备页上生成的注册令牌，只在首次接入时需要
  --name <名称>           界面上显示的设备名，默认取主机名
  --instance <实例名>     同一台机器接入多台设备时用来区分
  --listen <地址>         本机代理的监听地址，默认自动挑一个空闲端口
  --clash-api <地址>      sing-box 的 Clash API，默认按实例名算出来
  --singbox <路径>        sing-box 可执行文件，默认从 PATH 和常见位置里找
  --data-dir <目录>       sing-box 配置、日志和规则的存放目录

环境变量：SINGWEB_SERVER、SINGWEB_HOME、SINGWEB_INSTANCE、
          SINGWEB_LISTEN、SINGBOX_PATH
`)
}

export { main, parseArgs }

main().catch((err: unknown) => {
  if (!process.exitCode) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
})
