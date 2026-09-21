import { cn } from '@/lib/utils'

const styles = {
  INSERT: 'bg-insert/12 text-insert ring-insert/25',
  UPDATE: 'bg-update/12 text-update ring-update/25',
  DELETE: 'bg-delete/12 text-delete ring-delete/25',
} as const

export function OperationBadge({ operation, className }: { operation: string; className?: string }) {
  const style = styles[operation as keyof typeof styles] ?? 'bg-muted text-muted-foreground ring-border'
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wide ring-1 ring-inset', style, className)}>
      {operation}
    </span>
  )
}
