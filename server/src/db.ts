/**
 * PostgreSQL 连接池和建表。
 *
 * 连接串从 DATABASE_URL 读，本机开发默认用 singweb 库。
 * 表结构在 server/schema.sql，启动时执行一次（都是 create ... if not exists，重复跑没影响）。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg

/** pg 默认把 numeric 和 bigint 读成字符串，这里的字段都是小整数，直接要数字 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v))

export const DEFAULT_DATABASE_URL = 'postgres://localhost:5432/singweb'

export function databaseUrl(): string {
  return process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL
}

export const pool = new Pool({
  connectionString: databaseUrl(),
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  // 托管数据库通常要求 TLS；本机连 localhost 时不用
  ...(process.env.DATABASE_SSL === '1'
    ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_STRICT === '1' } }
    : {}),
})

pool.on('error', (err) => {
  console.error('数据库连接出错：', err.message)
})

/** 建表。返回执行过的语句数，方便启动日志里写一句 */
export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  const sql = await readFile(join(here, '..', 'schema.sql'), 'utf8')
  await pool.query(sql)
}

/** 查询辅助：只取一行 */
export async function one<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const res = await pool.query<T>(sql, params)
  return res.rows[0] ?? null
}

/** 查询辅助：取多行 */
export async function many<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(sql, params)
  return res.rows
}

/** 写操作辅助：返回受影响行数 */
export async function run(sql: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query(sql, params)
  return res.rowCount ?? 0
}

/** 在一个事务里跑一串操作 */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** 生成一个短 id，带前缀便于认出来是什么对象 */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  const body = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${prefix}_${body}`
}

/** 关掉连接池，退出前调用 */
export async function closePool(): Promise<void> {
  await pool.end()
}
