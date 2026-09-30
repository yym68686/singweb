#!/usr/bin/env node
/**
 * Agent 的命令行入口。
 *
 * 日常只有两条命令：第一次接入用带令牌的 `run`，之后就 `run` 什么都不用带。
 *
 *   run       接入（如果需要）然后开始上报循环
 *   status    看本地接入状态
 *   leave     删掉本地状态文件，相当于退出登录
 */

import { unlink } from 'node:fs/promises'
import { ApiClient, AGENT_VERSION, readAgentVersion } from './client.ts'
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
import { Reporter } from './reporter.ts'
import { ClashApi } from './singbox.ts'

interface Args {
  server: string
  token: string
  name: string
  instance: string
  clashApi: string
  clashSecret: string
  singboxPath: string
  dataDir: string
}

const FLAGS: Record<string, keyof Args> = {
  '--server': 'server',
  '--token': 'token',
  '--name': 'name',
  '--instance': 'instance',
  '--clash-api': 'clashApi',
  '--clash-secret': 'clashSecret',
  '--singbox': 'singboxPath',
  '--data-dir': 'dataDir',
}

function parseArgs(argv: string[]): { command: string; args: Args } {
  const args: Args = {
    server: '',
    token: '',
    name: '',
    instance: '',
    clashApi: '',
    clashSecret: '',
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

  const { state, path } = await loadState()

  if (command === 'status') {
    await printStatus(state, path)
    return
  }

  if (command === 'leave') {
    await unlink(path).catch(() => {})
    console.log(`已退出，本地状态文件删掉了：${path}`)
    console.log('服务端上的设备记录还在，想彻底删掉去网页的设备页。')
    return
  }

  if (command !== 'run') {
    console.error(`不认识这个命令：${command}`)
    printUsage()
    process.exitCode = 1
    return
  }

  // 命令行参数覆盖本地文件，同一台机器接多台设备时用得上
  const merged: AgentState = {
    ...state,
    server: normalizeServer(args.server || state.server),
    name: args.name || state.name,
    instance: args.instance || state.instance,
    clashApi: args.clashApi || state.clashApi,
    clashSecret: args.clashSecret || state.clashSecret,
    singboxPath: args.singboxPath || state.singboxPath,
    dataDir: args.dataDir || state.dataDir,
    agentVersion: state.agentVersion || (await readAgentVersion()),
  }
  if (!merged.server) {
    console.error('还不知道管理服务在哪，用 --server 指定，或者设 SINGWEB_SERVER。')
    process.exitCode = 1
    return
  }

  const clash = new ClashApi(merged.clashApi, merged.clashSecret)
  const singboxVersion = (await clash.version()) ?? ''
  if (!singboxVersion) {
    console.warn(
      `连不上 sing-box 的 Clash API（${merged.clashApi}），切换和版本上报都会失败。\n` +
        '检查 sing-box 在不在跑，配置里的 experimental.clash_api 开了没有。',
    )
  }

  const adopted = await adopt(merged, args.token, singboxVersion)
  if (!adopted) return
  Object.assign(merged, adopted)
  await saveState(path, merged)

  const reporter = new Reporter(merged, merged.secret ?? '')
  const engine = new Engine(merged, reporter)

  // Ctrl-C 时让探测子进程收尾，不然它会被留成孤儿
  const stop = () => {
    console.log('\n正在退出……')
    engine.stop()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  await engine.run()
}

/**
 * 拿到设备密钥。已经有的先试一下还能不能用，能用就不打扰服务端。
 *
 * 重新接入时带上本地存的设备 id：服务端会更新原来那台设备，
 * 而不是又建一台出来——不然换台机器接管就会攒下一堆幽灵设备。
 */
async function adopt(
  state: AgentState,
  token: string,
  singboxVersion: string,
): Promise<Partial<AgentState> | null> {
  if (state.secret && (await alive(state))) return {}

  if (!token) {
    console.error(
      state.secret
        ? '存的设备密钥不管用了（可能这台设备在网页上被删掉了），'
        : '第一次接入需要网页上生成的注册令牌。',
    )
    console.error(`打开 ${state.server} 的设备页，点「接入新设备」拿到令牌，再用 --token 跑一次。`)
    process.exitCode = 1
    return null
  }

  const api = new ApiClient(state.server, null)
  try {
    const { device, secret } = await api.register({
      token,
      id: state.deviceId,
      name: state.name,
      hostname: hostnameName(),
      platform: currentPlatform(),
      osVersion: `${process.platform} ${process.arch}`,
      agentVersion: state.agentVersion || AGENT_VERSION,
      singboxVersion,
      clashApi: state.clashApi,
      probeInbound: state.probeListen,
      dataDir: state.dataDir,
    })
    console.log(`接入成功，设备 id 是 ${device.id}，密钥存到了 ${statePath()}`)
    return {
      deviceId: device.id,
      secret,
      singboxVersion,
      platform: currentPlatform(),
      name: device.name || state.name,
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    return null
  }
}

/** 设备密钥还有效吗，问一次服务端 */
async function alive(state: AgentState): Promise<boolean> {
  if (!state.secret) return false
  return new ApiClient(state.server, state.secret)
    .bootstrap()
    .then(() => true)
    .catch(() => false)
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
  if (!state.secret) return

  const ok = await alive(state)
  console.log(`服务端连通：${ok ? '正常' : '连不上（检查地址和设备密钥）'}`)
  if (ok) console.log(`接口地址：${apiBase(state.server)}`)
}

function printUsage(): void {
  console.log(`singweb-agent ${AGENT_VERSION} —— 把本机接进 singweb 面板

用法：
  singweb-agent run --server <地址> --token <注册令牌>   首次接入并开始上报
  singweb-agent run --server <地址>                      已接入过，直接跑
  singweb-agent status                                   看本地状态
  singweb-agent leave                                    删掉本地状态

参数：
  --server <地址>         管理服务地址，也可以设 SINGWEB_SERVER
  --token <令牌>          网页设备页上生成的注册令牌，只在首次接入时需要
  --name <名称>           界面上显示的设备名，默认取主机名
  --instance <实例名>     同一台机器接入多台设备时用来区分
  --clash-api <地址>      sing-box 的 Clash API，默认 127.0.0.1:9090
  --clash-secret <密钥>   Clash API 的密钥
  --singbox <路径>        sing-box 可执行文件，默认从 PATH 里找
  --data-dir <目录>       探测配置和规则集的存放目录

环境变量：SINGWEB_SERVER、SINGWEB_HOME、SINGWEB_INSTANCE、
          SINGBOX_PATH、SINGBOX_CLASH_API、SINGBOX_CLASH_SECRET
`)
}

export { main, parseArgs }

main().catch((err: unknown) => {
  if (!process.exitCode) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
})
