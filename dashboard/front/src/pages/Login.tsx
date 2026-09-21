import { Loader2, LockKeyhole } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useLogin } from '@/api/hooks'
import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function Login() {
  const [password, setPassword] = useState('')
  const login = useLogin()

  function submit(event: FormEvent) {
    event.preventDefault()
    if (password) login.mutate(password)
  }

  const error = login.error
  const message =
    error instanceof ApiError
      ? error.status === 401
        ? 'Wrong password.'
        : error.message
      : error
        ? 'Something went wrong. Try again.'
        : null

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <div className="mb-5 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <LockKeyhole aria-hidden className="size-5" />
        </div>
        <h1 className="text-lg font-semibold tracking-tight">DBMesh dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">Sign in with the dashboard password.</p>

        <label htmlFor="password" className="mt-5 block text-xs font-medium text-muted-foreground">Password</label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          className="mt-1.5"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? 'login-error' : 'login-hint'}
        />
        {message ? (
          <p id="login-error" role="alert" className="mt-2 text-sm text-delete">{message}</p>
        ) : (
          <p id="login-hint" className="mt-2 text-xs text-muted-foreground">
            Set with <code className="font-mono">DASHBOARD_PASSWORD</code>. If unset, the API printed a random one when it started.
          </p>
        )}

        <Button type="submit" variant="primary" className="mt-5 w-full" disabled={!password || login.isPending}>
          {login.isPending && <Loader2 aria-hidden className="size-4 animate-spin" />}
          Sign in
        </Button>
      </form>
    </div>
  )
}
