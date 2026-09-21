import { LogOut, Moon, ScrollText, Sun, Table2 } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { useLogout, useStatus } from '@/api/hooks'
import { useTheme } from '@/lib/useTheme'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

const NAV = [
  { to: '/explorer', label: 'Explorer', icon: Table2 },
  { to: '/audit', label: 'Audit log', icon: ScrollText },
]

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <svg aria-hidden viewBox="0 0 32 32" className="size-7 text-primary">
        <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M16 6 6 24M16 6l10 18M6 24h20" opacity=".55" />
        </g>
        <g fill="currentColor">
          <circle cx="16" cy="6" r="3.4" />
          <circle cx="6" cy="24" r="3.4" />
          <circle cx="26" cy="24" r="3.4" />
        </g>
      </svg>
      <div className="leading-tight">
        <div className="text-[15px] font-semibold tracking-tight">DBMesh</div>
        <div className="text-[11px] text-muted-foreground">dashboard</div>
      </div>
    </div>
  )
}

function AuditStatus() {
  const status = useStatus()
  const known = status.data !== undefined
  const up = status.data?.audit_available === true
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <span aria-hidden className={cn('size-2 rounded-full', !known ? 'bg-muted-foreground/40' : up ? 'bg-insert' : 'bg-delete')} />
      {!known ? 'Checking audit database…' : up ? 'Audit database connected' : 'Audit database unreachable'}
    </div>
  )
}

function Actions({ compact }: { compact?: boolean }) {
  const { dark, toggle } = useTheme()
  const logout = useLogout()
  return (
    <div className={cn('flex items-center gap-1', !compact && '-ml-2')}>
      <Button variant="ghost" size={compact ? 'icon' : 'sm'} onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}>
        {dark ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
        {!compact && (dark ? 'Light' : 'Dark')}
      </Button>
      <Button variant="ghost" size={compact ? 'icon' : 'sm'} onClick={() => logout.mutate()} aria-label="Sign out">
        <LogOut aria-hidden className="size-4" />
        {!compact && 'Sign out'}
      </Button>
    </div>
  )
}

function Nav({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  return (
    <nav aria-label="Main" className={cn('flex gap-1', orientation === 'vertical' ? 'flex-col' : 'overflow-x-auto px-3 py-2')}>
      {NAV.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
              isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-hover hover:text-foreground',
            )
          }
        >
          <Icon aria-hidden className="size-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  )
}

export function Layout() {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14.5rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r bg-card px-4 py-5 md:flex">
        <Brand />
        <Nav orientation="vertical" />
        <div className="mt-auto space-y-3">
          <AuditStatus />
          <Actions />
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-card/90 px-4 backdrop-blur md:hidden">
          <Brand />
          <Actions compact />
        </header>
        <div className="border-b bg-card md:hidden">
          <Nav orientation="horizontal" />
        </div>
        <main className="mx-auto w-full max-w-[92rem] px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
