import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type Variant = 'primary' | 'outline' | 'ghost'
type Size = 'sm' | 'md' | 'icon'

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground hover:opacity-90 shadow-sm',
  outline: 'border border-input bg-card hover:bg-hover',
  ghost: 'hover:bg-hover text-muted-foreground hover:text-foreground',
}
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  icon: 'size-8 justify-center',
}

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export function Button({ variant = 'outline', size = 'md', className, type = 'button', ...props }: Props) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  )
}
