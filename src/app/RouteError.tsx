import { isRouteErrorResponse, useRouteError } from 'react-router'
import { RotateCcw } from 'lucide-react'
import { Button, ButtonLink } from '../components/Button'
import { useTitle } from '../lib/useTitle'
import NotFound from '../pages/NotFound'
import s from './RouteError.module.css'

function describe(error: unknown) {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`
  return String(error)
}

/**
 * 页面渲染出错时显示。
 * standalone：外壳本身出错了，没有侧栏可用，自己撑满窗口。
 */
export function RouteError({ standalone }: { standalone?: boolean }) {
  const error = useRouteError()
  useTitle('页面出错了')
  if (isRouteErrorResponse(error) && error.status === 404 && !standalone) return <NotFound />

  return (
    <div className={standalone ? s.standalone : undefined}>
      <div className={s.box} role="alert">
        <h1 className={s.title}>页面出错了</h1>
        <p>这个页面在显示时遇到了问题，数据和设备上的配置都不受影响。重新加载通常就能恢复；如果反复出现，请把下面的错误信息反馈给维护者。</p>
        <pre className={s.detail} tabIndex={0} aria-label="错误信息">
          {describe(error)}
        </pre>
        <div className={s.actions}>
          <Button variant="primary" icon={RotateCcw} onClick={() => window.location.reload()}>
            重新加载
          </Button>
          {/* 外壳出错时用整页跳转，保证重新初始化 */}
          {standalone ? (
            <Button onClick={() => window.location.assign('/')}>回到总览</Button>
          ) : (
            <ButtonLink to="/">回到总览</ButtonLink>
          )}
        </div>
      </div>
    </div>
  )
}
