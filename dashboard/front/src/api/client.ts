export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** FastAPI reports `detail` as a string, or as a list of validation problems. */
function messageFrom(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const messages = detail.map((d) => (d as { msg?: string }).msg).filter(Boolean)
    if (messages.length) return messages.join('; ')
  }
  return fallback
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    })
  } catch {
    throw new ApiError(0, 'Cannot reach the dashboard API')
  }
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (!response.ok) throw new ApiError(response.status, messageFrom(body, `Request failed (${response.status})`))
  return body as T
}

export function queryString(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}
