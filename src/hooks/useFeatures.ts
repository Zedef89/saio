import { useQuery } from '@tanstack/react-query'

export interface Features {
  /** Istanza condivisa: ogni sessione lavora in un worktree isolato per utente. */
  isolatedWorktrees: boolean
}

/**
 * Flag dell'istanza. Cambiano solo al riavvio del server, quindi non ha senso rifarne il
 * fetch a ogni focus della finestra.
 */
export function useFeatures() {
  return useQuery({
    queryKey: ['system', 'features'] as const,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<Features> => {
      const res = await fetch('/api/system/features', { credentials: 'include' })
      if (!res.ok) return { isolatedWorktrees: false }
      return (await res.json()) as Features
    },
  })
}
