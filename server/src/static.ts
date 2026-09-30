/**
 * 静态文件。生产环境下前端由这个服务一起发出去，不需要额外的 nginx。
 *
 * 规则很简单：文件存在就发文件，不存在就发 index.html 让前端路由自己处理。
 * 带哈希的构建产物可以长期缓存，index.html 必须每次问一次。
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export interface StaticFiles {
  /** 目录不存在时返回 false，调用方据此决定要不要退回旧的静态目录 */
  ready: boolean
  handle(pathname: string, res: ServerResponse): Promise<boolean>
}

/**
 * root 是前端构建产物所在的目录。返回 null 表示这个目录没有东西，
 * 调用方应当只提供接口，不发前端。
 */
export async function openStatic(root: string): Promise<StaticFiles | null> {
  const base = resolve(root)
  let indexHtml = ''
  try {
    if (!(await stat(join(base, 'index.html'))).isFile()) return null
    indexHtml = join(base, 'index.html')
  } catch {
    return null
  }

  const handle = async (pathname: string, res: ServerResponse): Promise<boolean> => {
    const target = resolveSafe(base, pathname)
    if (target) {
      const info = await stat(target).catch(() => null)
      if (info?.isFile()) {
        await send(target, res, pathname)
        return true
      }
    }
    // 前端路由的地址（/devices/xxx 之类）在磁盘上没有对应文件，统一发首页
    await send(indexHtml, res, '/index.html')
    return true
  }

  return { ready: true, handle }
}

/** 拼路径并确认没跑到目录外面去，返回 null 表示这个路径不合法 */
function resolveSafe(base: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const joined = normalize(join(base, decoded))
  if (joined !== base && !joined.startsWith(base + sep)) return null
  return joined
}

async function send(file: string, res: ServerResponse, pathname: string): Promise<void> {
  const info = await stat(file)
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  // Vite 的产物带内容哈希，换一版文件名就变了，可以放心长缓存；
  // index.html 不带哈希，必须每次核对，否则更新了前端用户还看旧的
  const immutable = /\.[0-9a-f]{8,}\.(js|css|woff2?)$/i.test(pathname)
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'cache-control': immutable
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    // 前端和接口同源，禁掉 MIME 嗅探
    'x-content-type-options': 'nosniff',
  })
  if (res.req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res)
}
