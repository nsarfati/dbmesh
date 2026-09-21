import type { ReactNode } from 'react'
import { CopyButton } from './CopyButton'

// Strings (a following colon marks an object key), keywords and numbers.
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g

export function highlight(json: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of json.matchAll(TOKEN)) {
    const at = match.index ?? 0
    if (at > last) out.push(json.slice(last, at))
    const [text, str, colon, keyword] = match
    if (str !== undefined) {
      out.push(
        <span key={index++} className={colon ? 'text-json-key' : 'text-json-string'}>{str}</span>,
      )
      if (colon) out.push(colon)
    } else if (keyword !== undefined) {
      out.push(<span key={index++} className="text-json-keyword">{text}</span>)
    } else {
      out.push(<span key={index++} className="text-json-number">{text}</span>)
    }
    last = at + text.length
  }
  if (last < json.length) out.push(json.slice(last))
  return out
}

export function JsonView({ value, label }: { value: unknown; label: string }) {
  const text = JSON.stringify(value, null, 2)
  return (
    <div className="group relative rounded-md border bg-muted/50">
      <CopyButton value={text} label={label} className="absolute top-1.5 right-1.5 bg-card/80 opacity-70 group-hover:opacity-100" />
      <pre role="region" tabIndex={0} className="max-h-80 overflow-auto p-3 pr-9 font-mono text-[12.5px] leading-relaxed" aria-label={label}>
        <code>{highlight(text)}</code>
      </pre>
    </div>
  )
}
