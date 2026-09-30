import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { KeyRound } from 'lucide-react'
import { useLogin, useMe } from '../api/hooks'
import { errorMessage } from '../api/errors'
import { Button } from '../components/Button'
import { Field, FormError, TextInput } from '../components/Form'
import { LoadingState } from '../components/States'
import { useTitle } from '../lib/useTitle'
import s from './Login.module.css'

/** 登录前想去的地址。只认站内相对路径，避免被构造成跳去外站 */
function nextPath(search: string): string | null {
  const to = new URLSearchParams(search).get('to')
  if (!to) return null
  if (!to.startsWith('/') || to.startsWith('//')) return null
  if (to.startsWith('/login')) return null
  return to
}

export default function Login() {
  useTitle('登录')
  const me = useMe()
  const login = useLogin()
  const navigate = useNavigate()
  const location = useLocation()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const to = nextPath(location.search)

  // 已经登录的人不该看到登录页。刷新后 /auth/me 要问一次库，先等一下再判断
  if (me.isPending) {
    return (
      <div className={s.page}>
        <LoadingState label="正在检查登录状态" />
      </div>
    )
  }
  if (me.data) return <Navigate to={to ?? '/'} replace />

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (login.isPending) return
    login.mutate(
      { username: username.trim(), password },
      { onSuccess: () => navigate(to ?? '/', { replace: true }) },
    )
  }

  return (
    <div className={s.page}>
      <main className={s.card}>
        <div className={s.head}>
          <svg className={s.mark} viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="7" />
            <path d="M9 22.5C9 13 23 19 23 9.5" />
            <circle cx="9" cy="23" r="3.6" />
            <circle cx="23" cy="9" r="3.6" />
          </svg>
          <h1 className={s.title}>singweb</h1>
          <p className={s.lede}>登录后才能管理设备上的分组和出口。</p>
        </div>

        <form className={s.form} onSubmit={submit} noValidate>
          {login.isError && <FormError>{errorMessage(login.error)}</FormError>}

          <Field label="用户名">
            {({ id, ...rest }) => (
              <TextInput
                {...rest}
                id={id}
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                autoFocus
                required
              />
            )}
          </Field>

          <Field label="密码">
            {({ id, ...rest }) => (
              <TextInput
                {...rest}
                id={id}
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            )}
          </Field>

          <Button type="submit" pending={login.isPending} icon={KeyRound} className={s.submit}>
            登录
          </Button>
        </form>

        <p className={s.foot}>
          没有账号就找管理员开一个。会话只存在浏览器里，关掉浏览器就要重新登录。
        </p>
      </main>
    </div>
  )
}
