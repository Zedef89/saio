import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export interface Worktree {
  name: string
  path: string
  branch: string
  /** Slug del proprietario, ricavato dal nome della cartella. */
  owner: string
  /** File modificati non committati. */
  dirty: number
  lastUsed?: string
  /** Vero se appartiene all'utente collegato. */
  mine: boolean
}

export interface WorktreesResponse {
  gitRepo: boolean
  baseBranch: string | null
  identity?: { slug: string; name: string; hasKey: boolean }
  worktrees: Worktree[]
}

export interface Overlap {
  worktree: string
  owner: string
  files: string[]
}

export const worktreesKey = (project: string) => ['worktrees', project] as const

/** Worktree di un progetto. `enabled: false` finché non serve, per non chiamare su ogni card. */
export function useWorktrees(project: string | undefined, enabled = true) {
  return useQuery({
    queryKey: worktreesKey(project || ''),
    enabled: Boolean(project) && enabled,
    queryFn: async () => {
      const res = await fetch(`/api/worktrees/${encodeURIComponent(project!)}`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`worktrees ${res.status}`)
      return (await res.json()) as WorktreesResponse
    },
  })
}

/** File in lavorazione negli altri worktree: avviso di collisione prima di iniziare. */
export function useOverlaps(project: string | undefined, myPath: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['worktrees', project, 'overlaps', myPath] as const,
    enabled: Boolean(project) && enabled,
    queryFn: async () => {
      const qs = myPath ? `?path=${encodeURIComponent(myPath)}` : ''
      const res = await fetch(`/api/worktrees/${encodeURIComponent(project!)}/overlaps${qs}`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`overlaps ${res.status}`)
      return (await res.json()) as { overlaps: Overlap[] }
    },
  })
}

export function useCreateWorktree() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { project: string; label?: string; baseBranch?: string }) => {
      const res = await fetch('/api/worktrees', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(`create worktree ${res.status}: ${txt}`)
      }
      return (await res.json()) as {
        path: string
        branch: string
        created: boolean
        warnings: string[]
        identity: { slug: string; name: string }
      }
    },
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: worktreesKey(vars.project) }),
  })
}

export function useRemoveWorktree() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { project: string; path: string; force?: boolean }) => {
      const qs = `?path=${encodeURIComponent(input.path)}${input.force ? '&force=true' : ''}`
      const res = await fetch(`/api/worktrees/${encodeURIComponent(input.project)}${qs}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `remove worktree ${res.status}`)
      }
      return (await res.json()) as { ok: true }
    },
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: worktreesKey(vars.project) }),
  })
}
