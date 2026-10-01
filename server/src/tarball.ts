/**
 * 打一个最小的 tar.gz。
 *
 * 安装脚本要把 Agent 的源码拉到别的机器上，做法是现打一个压缩包让 curl 直接下。
 * 用 node:zlib 就够了，不必为了打包多引一个依赖：ustar 格式的头部是定长的，
 * 写一次就够，不用支持长文件名、稀疏文件那些边角。
 *
 * 之所以打包源码而不是预编译产物：Agent 和 shared/ 都是 Node 直接执行的
 * TypeScript，没有构建步骤，拷过去就能跑，包里的目录结构必须跟仓库里一致。
 */

import { gzipSync } from 'node:zlib'

/** tar 头里的时间戳，全部写 0：同一份内容每次打出来的包都一样，便于比对 */
const EPOCH = 0
const BLOCK = 512

export interface TarEntry {
  /** 包里的路径，用 / 分隔 */
  path: string
  content: string | Buffer
  /** 可执行位。安装脚本本身是靠 curl 下的，这里主要是给 launcher 用 */
  mode?: number
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

/** 一个文件的头块。ustar 允许在名字里带目录，只要不超过 100 字节 */
function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(BLOCK)
  const name = Buffer.from(entry.path, 'utf8')
  if (name.length > 100) throw new Error(`包里的路径太长了：${entry.path}`)
  name.copy(block, 0)
  block.write(octal(entry.mode ?? 0o644, 8), 100, 'ascii')
  block.write(octal(0, 8), 108, 'ascii') // uid
  block.write(octal(0, 8), 116, 'ascii') // gid
  block.write(octal(size, 12), 124, 'ascii')
  block.write(octal(EPOCH, 12), 136, 'ascii')
  block.write('        ', 148, 'ascii') // 校验和先留空格
  block.write('0', 156, 'ascii') // 普通文件
  block.write('ustar\0', 257, 'ascii')
  block.write('00', 263, 'ascii')
  // 校验和：把这个块按字节加起来，写进头里的校验和字段
  let sum = 0
  for (const byte of block) sum += byte
  block.write(octal(sum, 8).slice(0, 7) + '\0', 148, 'ascii')
  return block
}

/** 按顺序写进 tar.gz。目录不用单独建，解包时按路径现建 */
export function makeTarGz(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8')
    chunks.push(header(entry, content.length))
    chunks.push(content)
    // 每个文件的内容要补齐到 512 的整数倍
    const pad = content.length % BLOCK
    if (pad) chunks.push(Buffer.alloc(BLOCK - pad))
  }
  // 结尾两个全零块，tar 靠它判断包结束
  chunks.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(chunks), { level: 9 })
}
