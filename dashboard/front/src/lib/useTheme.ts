import { useCallback, useState } from 'react'

const KEY = 'dbmesh-theme'

/** Light/dark theme; the class on <html> is set before first paint by index.html. */
export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const toggle = useCallback(() => {
    const next = !document.documentElement.classList.contains('dark')
    document.documentElement.classList.toggle('dark', next)
    try {
      localStorage.setItem(KEY, next ? 'dark' : 'light')
    } catch {
      // Storage can be blocked; the theme still applies for this visit.
    }
    setDark(next)
  }, [])
  return { dark, toggle }
}
