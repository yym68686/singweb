import { useNavigate } from 'react-router'
import { LogOut, UserRound } from 'lucide-react'
import { errorMessage } from '../api/errors'
import { useLogout, useMe } from '../api/hooks'
import { Button } from '../components/Button'
import { useToast } from '../components/Toast'
import s from './AccountMenu.module.css'

/** 侧栏底部的账号：显示当前登录的人，并提供退出 */
export function AccountMenu({ onNavigate }: { onNavigate?: () => void }) {
  const me = useMe()
  const logout = useLogout()
  const navigate = useNavigate()
  const toast = useToast()

  const signOut = () => {
    onNavigate?.()
    logout.mutate(undefined, {
      onSuccess: () => navigate('/login', { replace: true }),
      // 退出接口失败（比如网络断了）时也把人送回登录页：
      // 会话状态已经清空，留在这里只会看到一堆 401
      onError: (err) => {
        toast(`退出时出了点问题：${errorMessage(err)}`, 'crit')
        navigate('/login', { replace: true })
      },
    })
  }

  return (
    <div className={s.account}>
      <span className={s.who}>
        <UserRound aria-hidden />
        <span className={s.name}>{me.data?.username ?? '……'}</span>
        <span className="visually-hidden">
          {me.data?.role === 'admin' ? '管理员账号' : '普通账号'}
        </span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        icon={LogOut}
        pending={logout.isPending}
        onClick={signOut}
      >
        退出
      </Button>
    </div>
  )
}
