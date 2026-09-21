import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API needs a secure context; fall back for plain-HTTP localhost setups.
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    try {
      return document.execCommand('copy')
    } finally {
      area.remove()
    }
  }
}

export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : `Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      onClick={async (event) => {
        event.stopPropagation()
        if (await copyText(value)) {
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1500)
        }
      }}
      className={cn('inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-hover hover:text-foreground', className)}
    >
      {copied ? <Check className="size-3.5 text-insert" /> : <Copy className="size-3.5" />}
    </button>
  )
}
