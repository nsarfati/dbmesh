import { ChevronDown } from 'lucide-react'
import type { SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** A native select (best keyboard, mobile and screen-reader behaviour) with our styling. */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn('relative', className)}>
      <select
        className={cn(
          'h-9 w-full appearance-none rounded-md border border-input bg-card pr-8 pl-3 text-sm',
          'transition-colors hover:border-ring/50 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}
