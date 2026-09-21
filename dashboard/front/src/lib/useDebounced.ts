import { useEffect, useState } from 'react'

/** A value that follows `value` only after it has been stable for `delayMs`. */
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
