/**
 * 账号和登录会话。
 *
 * 密码用 scrypt 加盐散列；会话 token 是一串随机字节，库里只存它的 SHA-256，
 * 所以库被读走也不能直接拿来登录。会话本身放在数据库里，
 * 服务端不保存任何状态，重启或换实例都不影响已登录的浏览器。
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import type { UserAccount, UserRole } from '../../shared/types.ts'

interface ScryptOptions {
  N: number
  r: number
  p: number
  maxmem?: number
}

/**
 * 包一层 Promise。node:util 的 promisify 认不出 scrypt 的重载，
 * 推断出来的签名少了 options 参数，这里自己写。
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options?: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, key: Buffer) => (err ? reject(err) : resolve(key))
    if (options) scryptCb(password, salt, keylen, options, done)
    else scryptCb(password, salt, keylen, done)
  })
}

/** scrypt 参数。N 越大越慢，16384 在服务器上单次约 60 毫秒 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }
const SALT_BYTES = 16

/** 会话有效期 */
export const SESSION_DAYS = 30
export const COOKIE_NAME = 'singweb_session'

/** 散列密码，格式：scrypt$N$r$p$盐$散列，都是 base64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await scrypt(password, salt, SCRYPT.keylen)
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

/** 校验密码。散列格式不对或者不匹配都返回 false */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltB64, 'base64')
    expected = Buffer.from(hashB64, 'base64')
  } catch {
    return false
  }
  const key = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    // 参数来自库里的记录，放宽内存上限避免旧参数报错
    maxmem: 256 * 1024 * 1024,
  })
  return key.length === expected.length && timingSafeEqual(key, expected)
}

/** 新会话 token（给浏览器的那个） */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 库里存的是 token 的散列 */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 会话过期时间 */
export function sessionExpiry(from = new Date()): Date {
  return new Date(from.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000)
}

/** 取 Cookie 里的会话 token */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

/**
 * 生成 Set-Cookie。HttpOnly 挡掉脚本读取，SameSite=Lax 挡掉跨站提交，
 * 走 HTTPS 时再加 Secure（由调用方根据请求判断）。
 */
export function sessionCookie(token: string, expires: Date, secure: boolean): string {
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`,
  ]
  if (secure) bits.push('Secure')
  return bits.join('; ')
}

/** 退出登录时清掉 Cookie */
export function clearSessionCookie(secure: boolean): string {
  const bits = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) bits.push('Secure')
  return bits.join('; ')
}

/** 用户名规则：3-32 位，字母数字和 . _ - */
export function validateUsername(username: string): string | null {
  const value = username.trim()
  if (!value) return '请填写用户名。'
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(value)) {
    return '用户名只能用 3 到 32 位的字母、数字、. _ 和 -。'
  }
  return null
}

/** 密码规则：至少 8 位 */
export function validatePassword(password: string): string | null {
  if (!password) return '请填写密码。'
  if (password.length < 8) return '密码至少 8 位。'
  if (password.length > 200) return '密码最多 200 位。'
  return null
}

/** 生成一个能念得出来的随机密码：4 段各 5 位，去掉了容易看错的字符 */
export function suggestPassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  const groups: string[] = []
  for (let g = 0; g < 4; g++) {
    const bytes = randomBytes(5)
    let s = ''
    for (const b of bytes) s += alphabet[b % alphabet.length]
    groups.push(s)
  }
  return groups.join('-')
}

/** 对外表示一个账号，绝不带上散列 */
export function publicUser(row: { id: string; username: string; role: string; created_at: Date }): UserAccount {
  return {
    id: row.id,
    username: row.username,
    role: row.role as UserRole,
    createdAt: row.created_at.toISOString(),
  }
}
