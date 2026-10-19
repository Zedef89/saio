import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export interface MeResponse {
  email: string
  role: 'owner' | 'guest'
  sid: string
  authBypass: boolean
  /** Il proprietario dell'istanza (owner.json, oggi Nicola): shell root e scrittura ovunque. */
  superAdmin?: boolean
}

export const AUTH_ME_KEY = ['auth', 'me'] as const

async function fetchMe(): Promise<MeResponse> {
  let res = await fetch('/api/auth/me', { credentials: 'include' })
  // Il cookie di accesso dura 1 ora, quello di refresh 7 giorni: senza questo tentativo chi
  // riapriva la pagina dopo un'ora finiva sul login con una sessione ancora valida.
  if (res.status === 401) {
    const refreshRes = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' }).catch(() => null)
    if (refreshRes?.ok) res = await fetch('/api/auth/me', { credentials: 'include' })
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('unauthenticated')
    throw new Error(`auth/me ${res.status}`)
  }
  return res.json()
}

export function useMe() {
  return useQuery({
    queryKey: AUTH_ME_KEY,
    queryFn: fetchMe,
    // Desktop: the backend sidecar may take a couple seconds to bind on startup, so the
    // first /api/auth/me can fail with a network error. Retry those, but never retry a real
    // 401 (unauthenticated) — that must fall through to the login screen immediately.
    retry: (failureCount, error) =>
      failureCount < 8 && !(error instanceof Error && error.message === 'unauthenticated'),
    retryDelay: 1000,
    staleTime: 5 * 60_000,
    gcTime: 5 * 60_000,
  })
}

/**
 * Se l'utente corrente e' il proprietario dell'istanza. Serve a non mostrare quello che il
 * server rifiuterebbe comunque (middleware/access-policy.ts): un menu pieno di pagine che
 * rispondono 403 sembra un'applicazione rotta, non un permesso mancante.
 *
 * `authBypass` (dev, DASHBOARD_AUTH_REQUIRED=false) vale owner: in locale non c'e' un ruolo
 * da rispettare.
 */
export function useIsOwner(): boolean {
  const { data } = useMe()
  return !!data && (data.role === 'owner' || data.authBypass)
}

/**
 * Il super admin: diverso da `useIsOwner` (owner dell'allowlist, oggi in cinque). Solo lui
 * apre la shell root e scrive nelle sessioni degli altri — il server lo controlla comunque.
 */
export function useIsSuperAdmin(): boolean {
  const { data } = useMe()
  return !!data && (!!data.superAdmin || data.authBypass)
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok && res.status !== 401) throw new Error(`logout ${res.status}`)
      return true
    },
    onSettled: () => {
      qc.clear()
      window.location.href = '/login'
    },
  })
}
