import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
}

/** A right-hand drawer: focus is trapped, Escape and the overlay close it. */
export function Sheet({ open, onOpenChange, title, description, children, className }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]" />
        <Dialog.Content
          className={cn(
            'sheet-content fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-card shadow-2xl sm:max-w-2xl',
            className,
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-sm text-muted-foreground">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">Details</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label="Close"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            >
              <X className="size-4" />
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
