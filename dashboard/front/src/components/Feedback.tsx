import { CircleAlert, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from './ui/button'

export function ErrorBanner({ message, onRetry, retrying }: { message: string; onRetry?: () => void; retrying?: boolean }) {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-lg border border-delete/30 bg-delete/8 px-4 py-3 text-sm">
      <CircleAlert aria-hidden className="size-4 shrink-0 text-delete" />
      <p className="min-w-0 flex-1">{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry} disabled={retrying}>
          <RefreshCw aria-hidden className={retrying ? 'size-3.5 animate-spin' : 'size-3.5'} />
          Retry
        </Button>
      )}
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div aria-hidden className="mb-4 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</div>
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-1.5 max-w-md text-sm text-muted-foreground">{children}</div>
    </div>
  )
}
