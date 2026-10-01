/**
 * 逐节点探测。
 *
 * 每次探测都从探测进程的 SOCKS5 入站出发，用「节点 id 对应的用户名」选节点，
 * 走的路由和真实流量一致——不然测出来的是本机到目标通不通，跟节点没关系。
 *
 * 三种探测：
 *   ssh   连上以后读服务端的标识，或者再走一步密钥交换（都不登录）
 *   http  发一个 GET 请求，看状态码和响应里有没有关键字
 *   tcp   能建连接就算通过
 */

import { createHash } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { HttpTarget, ProbeDetail, ProbeError, ProbeStage, SshTarget, Target } from '../../shared/types.ts'

/** HTTP 探测只看响应开头这么多字节，正文可能很大 */
const MAX_BODY_SCAN = 64 * 1024

/** SSH 标识以 CRLF 结尾，单行通常不到 255 字节 */
const MAX_BANNER = 1024

/** 探测进程里某个节点对应的 SOCKS5 入口 */
export interface ProbeEndpoint {
  socksHost: string
  socksPort: number
  /** SOCKS5 用户名，对应一个节点 */
  username: string
  password: string
}

/**
 * 一次探测要的全套信息：从哪出去（endpoint）和去哪（host、port）。
 * 两层结构在这里没好处，摊平了调用方少一层解包。
 */
export interface ProbeContext extends ProbeEndpoint {
  /** 目标地址。是域名还是 IP 交给 SOCKS5 判断，本机不做解析 */
  host: string
  port: number
  timeoutMs: number
}

/** 一次探测的结果，字段和 shared/types.ts 里的 ProbeDetail 对齐 */
export function failed(
  error: ProbeError,
  stage: ProbeStage | null,
  startedAt: number,
  extra: Partial<ProbeDetail> = {},
): ProbeDetail {
  return {
    at: new Date().toISOString(),
    ok: false,
    latencyMs: Date.now() - startedAt,
    stage,
    error,
    ...extra,
  }
}

export function passed(
  stage: ProbeStage,
  startedAt: number,
  extra: Partial<ProbeDetail> = {},
): ProbeDetail {
  return {
    at: new Date().toISOString(),
    ok: true,
    latencyMs: Date.now() - startedAt,
    stage,
    ...extra,
  }
}

/** 按类型分派 */
export async function probeTarget(target: Target, ctx: ProbeContext): Promise<ProbeDetail> {
  switch (target.kind) {
    case 'ssh':
      return probeSsh(target, ctx)
    case 'http':
      return probeHttp(target, ctx)
    case 'tcp':
      return probeTcp(ctx)
  }
}

/** TCP 探测：建连接、马上关掉 */
async function probeTcp(ctx: ProbeContext): Promise<ProbeDetail> {
  const startedAt = Date.now()
  try {
    const socket = await openThroughProxy(ctx)
    socket.destroy()
    return passed('tcp', startedAt)
  } catch (err) {
    return failureOf(err, null, startedAt)
  }
}

/**
 * SSH 探测：
 *   banner    读到服务端标识就算通过，不发送任何客户端数据
 *   handshake 再走一步版本交换并读取服务端的密钥交换包，拿到主机密钥指纹
 */
async function probeSsh(target: SshTarget, ctx: ProbeContext): Promise<ProbeDetail> {
  const startedAt = Date.now()
  let socket: Socket
  try {
    socket = await openThroughProxy(ctx)
  } catch (err) {
    return failureOf(err, null, startedAt)
  }

  try {
    // 服务端一连上就会主动发标识，我们只读
    const banner = await readBanner(socket, ctx.timeoutMs)
    if (!banner) {
      return failed('banner', 'tcp', startedAt)
    }
    if (target.level === 'banner') {
      return passed('banner', startedAt, { banner })
    }

    // 握手：发自己的标识，读服务端的密钥交换起始包，能读到就说明 SSH 服务是活的
    socket.write(`SSH-2.0-singweb_${SHORT_VERSION}\r\n`)
    const packet = await readSome(socket, ctx.timeoutMs, 64)
    if (!packet || packet.length < 6 || packet[0] !== 0x00) {
      // 版本比 2.0 低、或者根本不是 SSH：banner 阶段已经过了，这里算握手失败
      return failed('hostkey', 'banner', startedAt, { banner })
    }
    const fingerprint = fingerprintOf(packet)
    return passed('handshake', startedAt, { banner, hostKey: fingerprint })
  } catch (err) {
    return failureOf(err, 'banner', startedAt)
  } finally {
    socket.destroy()
  }
}

/**
 * HTTP 探测：不跟随重定向、校验证书。
 * 状态码不在期望列表里算 status 错误，响应里没有关键字算 keyword 错误，
 * 这两种错误在界面上是分开显示的——OpenAI 在部分节点返回 403，属于前者。
 */
async function probeHttp(target: HttpTarget, ctx: ProbeContext): Promise<ProbeDetail> {
  const startedAt = Date.now()
  let url: URL
  try {
    url = new URL(target.url)
  } catch {
    return failed('dns', null, startedAt, { status: undefined })
  }

  const https = url.protocol === 'https:'
  const port = Number(url.port) || (https ? 443 : 80)

  let socket: Socket
  try {
    socket = await openThroughProxy({ ...ctx, host: url.hostname, port })
  } catch (err) {
    return failureOf(err, null, startedAt)
  }

  let stream: Socket = socket
  try {
    if (https) {
      stream = await upgradeTls(socket, url.hostname, ctx.timeoutMs)
    }
    const request =
      `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
      `Host: ${url.host}\r\n` +
      `User-Agent: singweb-agent\r\n` +
      `Accept: */*\r\n` +
      `Connection: close\r\n\r\n`
    stream.write(request)

    const raw = await readHttp(stream, ctx.timeoutMs)
    const parsed = parseHttp(raw)
    if (!parsed) {
      return failed('reset', https ? 'tls' : 'tcp', startedAt)
    }

    const stage: ProbeStage = 'response'
    const allowed = target.expectStatus.length
      ? target.expectStatus
      : DEFAULT_OK_STATUS
    if (!allowed.includes(parsed.status)) {
      return failed('status', stage, startedAt, { status: parsed.status })
    }
    const keyword = target.keyword?.trim()
    if (keyword && !parsed.body.toLowerCase().includes(keyword.toLowerCase())) {
      return failed('keyword', stage, startedAt, { status: parsed.status })
    }
    return passed(stage, startedAt, { status: parsed.status })
  } catch (err) {
    return failureOf(err, https ? 'tls' : 'tcp', startedAt)
  } finally {
    stream.destroy()
  }
}

/** 没填期望状态码时，2xx 和 3xx 都算通过 */
const DEFAULT_OK_STATUS = [200, 201, 202, 203, 204, 205, 206, 301, 302, 303, 304, 307, 308]

const SHORT_VERSION = '0.1'

// ---------------------------------------------------------------- SOCKS5

/**
 * 通过 SOCKS5 连到目标。用户名决定走哪个节点，密码是探测进程启动时生成的。
 * 认不得的错误统一报 proxy，让用户知道是节点本身的问题。
 */
function openThroughProxy(ctx: ProbeContext): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: ctx.socksHost, port: ctx.socksPort })
    let stage: 'greeting' | 'auth' | 'connect' = 'greeting'
    let buffer = Buffer.alloc(0)

    const timer = setTimeout(() => finish(new Error('timeout')), ctx.timeoutMs)
    const finish = (err: Error | null) => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      if (err) {
        socket.destroy()
        reject(err)
        return
      }
      socket.setTimeout(0)
      resolve(socket)
    }

    const onError = (err: Error) => {
      // 连不上本机的探测进程和连不上目标节点是两回事，这里统一报 proxy 之外还带原因
      finish(err)
    }
    const onClose = () => finish(new Error(`closed:${stage}`))

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])

      if (stage === 'greeting') {
        if (buffer.length < 2) return
        if (buffer[0] !== 0x05) return finish(new Error('proxy'))
        if (buffer[1] === 0xff) return finish(new Error('proxy'))
        buffer = buffer.subarray(2)
        stage = 'auth'
        // 只支持用户名密码认证，探测进程就是这么配的
        const user = Buffer.from(ctx.username, 'utf8')
        const pass = Buffer.from(ctx.password, 'utf8')
        socket.write(
          Buffer.concat([
            Buffer.from([0x01, user.length]),
            user,
            Buffer.from([pass.length]),
            pass,
          ]),
        )
      }

      if (stage === 'auth') {
        if (buffer.length < 2) return
        if (buffer[1] !== 0x00) return finish(new Error('proxy'))
        buffer = buffer.subarray(2)
        stage = 'connect'
        const host = Buffer.from(ctx.host, 'utf8')
        const port = Buffer.alloc(2)
        port.writeUInt16BE(ctx.port)
        socket.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
            host,
            port,
          ]),
        )
      }

      if (stage === 'connect') {
        if (buffer.length < 4) return
        if (buffer[1] !== 0x00) return finish(new Error(`socks:${buffer[1]}`))
        // 应答里还有地址和端口，长度取决于类型
        const atype = buffer[3]
        const need =
          atype === 0x01 ? 10 : atype === 0x04 ? 22 : atype === 0x03 ? 7 + (buffer[4] ?? 0) : 0
        if (!need) return finish(new Error('proxy'))
        if (buffer.length < need) return
        finish(null)
      }
    }

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.write(Buffer.from([0x05, 0x01, 0x02]))
  })
}

// ---------------------------------------------------------------- 小工具

function readBanner(socket: Socket, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => done(null), timeoutMs)
    const done = (value: string | null) => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      resolve(value)
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\n')
      if (end >= 0 || buffer.length > MAX_BANNER) {
        done(buffer.subarray(0, Math.min(end < 0 ? buffer.length : end, MAX_BANNER)).toString('utf8').trim())
      }
    }
    socket.on('data', onData)
  })
}

function readSome(socket: Socket, timeoutMs: number, bytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => done(null), timeoutMs)
    const done = (value: Buffer | null) => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      resolve(value)
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length >= bytes) done(buffer.subarray(0, bytes))
    }
    socket.on('data', onData)
  })
}

/** 读到响应头加一小段正文就够判断了 */
function readHttp(socket: Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => {
      cleanup()
      if (buffer.length) resolve(buffer)
      else reject(new Error('timeout'))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('end', onEnd)
    }
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      // 头读全了并且正文够长，就不用等服务器关连接了
      const headEnd = buffer.indexOf('\r\n\r\n')
      if (headEnd >= 0 && buffer.length - headEnd >= MAX_BODY_SCAN) {
        cleanup()
        resolve(buffer)
      }
    }
    const onEnd = () => {
      cleanup()
      resolve(buffer)
    }
    socket.on('data', onData)
    socket.on('end', onEnd)
  })
}

function parseHttp(raw: Buffer): { status: number; body: string } | null {
  const headEnd = raw.indexOf('\r\n\r\n')
  const text = raw.toString('utf8')
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text
  const status = /^HTTP\/\d\.\d\s+(\d{3})/.exec(head)
  if (!status) return null
  const body = headEnd >= 0 ? text.slice(headEnd + 4) : ''
  return { status: Number(status[1]), body: body.slice(0, MAX_BODY_SCAN) }
}

/** 只有 https 才升级，且证书必须可信——被中间人换掉的节点要能被发现 */
function upgradeTls(socket: Socket, host: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({
      socket,
      servername: host,
      rejectUnauthorized: true,
    })
    const timer = setTimeout(() => {
      tls.destroy()
      reject(new Error('tls'))
    }, timeoutMs)
    tls.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(tls)
    })
    tls.once('error', (err) => {
      clearTimeout(timer)
      tls.destroy()
      reject(err)
    })
  })
}

/** 主机密钥指纹。只取 SSH 密钥交换起始包的前 32 字节做个摘要，够用来比对变化 */
function fingerprintOf(packet: Buffer): string {
  return createHash('sha256').update(packet).digest('hex').slice(0, 32)
}

/** 把 socket 层的错误翻译成界面上的说法 */
function failureOf(err: unknown, stage: ProbeStage | null, startedAt: number): ProbeDetail {
  const code = (err as { code?: string } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  if (code === 'ECONNREFUSED') return failed('refused', stage, startedAt)
  if (code === 'ECONNRESET' || message.startsWith('closed')) return failed('reset', stage, startedAt)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return failed('dns', stage, startedAt)
  if (message === 'timeout') return failed('timeout', stage, startedAt)
  if (message === 'tls') return failed('tls', stage, startedAt)
  // 节点自己出不去、握手被拒之类，都归到 proxy，界面上提示是节点的问题
  return failed('proxy', stage, startedAt)
}
