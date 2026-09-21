import { cn } from '@/lib/utils'

/** One JSON value on a single line, coloured by type. */
export function ValueText({ value, className }: { value: unknown; className?: string }) {
  if (value === null || value === undefined) {
    return <span className={cn('text-muted-foreground italic', className)}>null</span>
  }
  if (typeof value === 'string') return <span className={cn('break-all text-json-string', className)}>{JSON.stringify(value)}</span>
  if (typeof value === 'number') return <span className={cn('text-json-number', className)}>{String(value)}</span>
  if (typeof value === 'boolean') return <span className={cn('text-json-keyword', className)}>{String(value)}</span>
  return <span className={cn('break-all', className)}>{JSON.stringify(value)}</span>
}
