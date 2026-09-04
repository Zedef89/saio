import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export interface RegolaPermesso {
  id: string
  titolo: string
  perche: string
  invece: string
  attiva: boolean
  nota: string | null
  /** I progetti in cui la regola vale. Vuoto = vale ovunque. */
  progetti: string[]
  esenti: string[]
  valeOvunque: boolean
}

export interface RichiestaPermesso {
  id: string
  titolo: string
  persona: string
  sessione: string
  cosa: string
  dove: string
  aperta: string
  perche: string | null
  prova: string | null
}

/** Una voce del banco degli accessi. Mai il valore: solo il nome e cosa apre. */
export interface Accesso {
  nome: string
  apre: string
  ambito: string
  avviso: string | null
  /** Chi lo vede OLTRE a chi amministra. `'tutti'` = non è di nessuno. */
  persone: string[] | 'tutti'
}

/** Un progetto e chi lo vede. Lista vuota = lo vedono tutti. */
export interface ProgettoVisibilita {
  id: string
  nome: string
  persone: string[]
}

export interface Persona {
  slug: string
  nome: string
}

export interface StatoPermessi {
  regole: RegolaPermesso[]
  progetti: string[]
  inAttesa: RichiestaPermesso[]
  /** Blocchi in cui nessuno ha scritto il perché: sono aggiramenti silenziosi. */
  abbozzate: number
  accessi: Accesso[]
  progettiVisibilita: ProgettoVisibilita[]
  persone: Persona[]
}

export const PERMESSI_KEY = ['admin', 'permessi'] as const

export function usePermessi() {
  return useQuery({
    queryKey: PERMESSI_KEY,
    queryFn: async () => {
      const res = await fetch('/api/admin/permessi', { credentials: 'include' })
      if (!res.ok) throw new Error(`permessi ${res.status}`)
      return (await res.json()) as StatoPermessi
    },
    refetchInterval: 30_000,
  })
}

export function useModificaRegola() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; attiva?: boolean; progetti?: string[]; esenti?: string[] }) => {
      const { id, ...body } = v
      const res = await fetch(`/api/admin/permessi/regole/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `errore ${res.status}`)
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PERMESSI_KEY }),
  })
}

/** Chi vede un accesso. La lista sostituisce quella precedente, non si somma. */
export function useModificaAccesso() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { nome: string; persone: string[] | 'tutti' }) => {
      const res = await fetch(`/api/admin/permessi/accessi/${encodeURIComponent(v.nome)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persone: v.persone }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `errore ${res.status}`)
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PERMESSI_KEY }),
  })
}

/**
 * Chi vede un progetto. Lista vuota = lo vedono tutti — non "nessuno": un progetto che non
 * si vede piu' non si riapre dall'interfaccia, e restringere tutto per sbaglio con una
 * spunta sarebbe troppo facile.
 */
export function useModificaProgetto() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; persone: string[] }) => {
      const res = await fetch(`/api/admin/permessi/progetti/${encodeURIComponent(v.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persone: v.persone }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `errore ${res.status}`)
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PERMESSI_KEY }),
  })
}

export function useDecidiRichiesta() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; approva: boolean; perche?: string; perSessione?: boolean }) => {
      const { id, ...body } = v
      const res = await fetch(`/api/admin/permessi/richieste/${encodeURIComponent(id)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `errore ${res.status}`)
      return res.json() as Promise<{ ok: true; sessione: string }>
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PERMESSI_KEY }),
  })
}
