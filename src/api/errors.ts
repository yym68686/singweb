/** 管理服务返回的错误；field 指向出错的表单字段 */
export class ApiError extends Error {
  readonly status: number
  readonly field?: string

  constructor(message: string, status = 400, field?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.field = field
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof TypeError) return '连不上管理服务，请检查网络或服务是否在运行。'
  if (e instanceof Error) return e.message
  return '操作没有完成，原因未知。'
}
