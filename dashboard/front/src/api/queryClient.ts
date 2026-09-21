import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { ApiError } from './client'

export const SESSION_KEY = ['session'] as const

/**
 * Any 401 from a data request means the session ended (expired cookie, API
 * restart): drop to the login screen instead of showing a broken page.
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => onError(client, error) }),
    mutationCache: new MutationCache({ onError: (error) => onError(client, error) }),
    defaultOptions: {
      queries: {
        retry: (count, error) => !(error instanceof ApiError && [400, 401, 404, 422].includes(error.status)) && count < 2,
        refetchOnWindowFocus: false,
        staleTime: 5_000,
      },
    },
  })
  return client
}

function onError(client: QueryClient, error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    client.setQueryData(SESSION_KEY, { authenticated: false })
  }
}
