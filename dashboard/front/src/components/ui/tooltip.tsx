import type { CSSProperties, MouseEventHandler, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface Props {
  content: ReactNode
  children?: ReactNode
  className?: string
  style?: CSSProperties
  onMouseEnter?: MouseEventHandler<HTMLDivElement>
  onMouseLeave?: MouseEventHandler<HTMLDivElement>
}

/** Hover tooltip anchored above its trigger, styled to match the dashboard's cards. */
export function Tooltip({ content, children, className, style, onMouseEnter, onMouseLeave }: Props) {
  return (
    <div className={cn('group relative', className)} style={style} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {children}
      <div className="pointer-events-none absolute top-full left-1/2 z-10 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-xs text-foreground opacity-0 shadow-md transition-opacity group-hover:opacity-100">
        {content}
      </div>
    </div>
  )
}
