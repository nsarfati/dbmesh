import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useSession } from '@/api/hooks'
import { createQueryClient } from '@/api/queryClient'
import { Layout } from '@/components/Layout'
import { AuditLog } from '@/pages/AuditLog'
import { Explorer } from '@/pages/Explorer'
import { Login } from '@/pages/Login'
import { EmptyState, ErrorBanner } from '@/components/Feedback'
import { Compass } from 'lucide-react'

export function Gate() {
  const session = useSession()
  if (session.isPending) return <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground" role="status">Loading…</div>
  if (session.isError) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <ErrorBanner message={`${session.error.message}. Is the dashboard API running?`} onRetry={() => session.refetch()} retrying={session.isFetching} />
      </div>
    )
  }
  if (!session.data.authenticated) return <Login />
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/audit" replace />} />
        <Route path="audit" element={<AuditLog />} />
        <Route path="explorer" element={<Explorer />} />
        <Route
          path="*"
          element={<EmptyState icon={<Compass className="size-5" />} title="Page not found">There is nothing at this address.</EmptyState>}
        />
      </Route>
    </Routes>
  )
}

export function App() {
  const [client] = useState(createQueryClient)
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
