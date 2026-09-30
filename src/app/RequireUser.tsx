import { useEffect, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { errorMessage } from '../api/errors'
import { keys, useMe } from '../api/hooks'
import { onUnauthorized } from '../api/http'
import { ErrorState, LoadingState } from '../components/States'

/**
 * 登录检查。包住整个外壳，没登录就送去登录页，并记下原本要去的地址。
 *
 * 顺带盯住 401 广播：会话在页面上过期时（比如服务重启、会话被清掉），
 * 任何一个接口的 401 都会走这里，把用户送回登录页，
 * 而不是让每个页面各自显示一遍"请先登录"。
 */
export function RequireUser({ children }: { children: ReactNode }) {
  const me = useMe()
  const qc = useQueryClient()
  const location = useLocation()

  useEffect(
    () =>
      onUnauthorized(() => {
        qc.setQueryData(keys.user, null)
      }),
    [qc],
  )

  if (me.isPending) {
    // 首次打开时 /auth/me 要查一次库，这期间既不能说已登录也不能说没登录
    return (
      <div>
        <LoadingState label="正在检查登录状态" />
      </div>
    )
  }
  if (me.isError) {
    return <ErrorState error={errorMessage(me.error)} onRetry={() => void me.refetch()} />
  }
  if (!me.data) {
    const to = location.pathname + location.search
    // 根路径不必带上，登录后本来就落在这里
    const search = to === '/' ? '' : `?to=${encodeURIComponent(to)}`
    return <Navigate to={`/login${search}`} replace />
  }
  return <>{children}</>
}
