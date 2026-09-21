import { cn } from '@/lib/utils'

interface Props<T extends string> {
  label: string
  value: T
  options: readonly { value: T; label: string; disabled?: boolean; title?: string }[]
  onChange: (value: T) => void
  className?: string
}

/** Mutually exclusive choices as a radio group of buttons. */
export function Segmented<T extends string>({ label, value, options, onChange, className }: Props<T>) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-md border border-input bg-muted p-0.5', className)}>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-7 rounded-[5px] px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              selected ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground enabled:hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
