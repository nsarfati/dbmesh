import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-md border border-input bg-card px-3 text-sm placeholder:text-muted-foreground/70',
        'transition-colors hover:border-ring/50 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
        className,
      )}
      {...props}
    />
  )
}
