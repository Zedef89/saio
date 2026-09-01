/**
 * Selettore del worktree con cui aprire una sessione.
 *
 * Su un'istanza condivisa nessuno lavora nella working copy del progetto: ognuno ha il suo
 * worktree, su un branch staccato dalla base. Questo dialog mostra quelli già esistenti — per
 * riprendere il lavoro del giorno prima — e permette di crearne uno nuovo.
 *
 * Mostra anche i file che gli altri stanno modificando: sapere prima di iniziare che qualcuno
 * ha già messo mano agli stessi file evita di scoprire il conflitto al merge.
 */
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { GitBranch, Loader2, Plus, AlertTriangle, User, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useCreateWorktree, useOverlaps, useWorktrees, type Worktree } from '@/hooks/useWorktrees'

export interface WorktreeChoice {
  path: string
  branch: string
  label?: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Nome cartella del progetto (= nome repo sotto ~/dev). */
  project: string
  /** Chiamata con il worktree scelto; il chiamante apre la sessione. */
  onSelect: (choice: WorktreeChoice) => void
}

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.round(diff / 60000)
  if (min < 1) return 'ora'
  if (min < 60) return `${min} min fa`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h fa`
  return `${Math.round(h / 24)} g fa`
}

export function WorktreeSelectDialog({ open, onOpenChange, project, onSelect }: Props) {
  const { data, isLoading, error } = useWorktrees(project, open)
  const { data: overlapData } = useOverlaps(project, undefined, open)
  const create = useCreateWorktree()
  const [newLabel, setNewLabel] = useState('')

  const { mine, others } = useMemo(() => {
    const list = data?.worktrees || []
    return {
      mine: list.filter((w) => w.mine),
      others: list.filter((w) => !w.mine),
    }
  }, [data])

  async function handleCreate() {
    const label = newLabel.trim() || 'work'
    try {
      const res = await create.mutateAsync({ project, label })
      for (const w of res.warnings) toast.warning(w)
      onSelect({ path: res.path, branch: res.branch, label })
      onOpenChange(false)
      setNewLabel('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Creazione worktree fallita')
    }
  }

  function pick(w: Worktree) {
    onSelect({ path: w.path, branch: w.branch })
    onOpenChange(false)
  }

  const overlaps = overlapData?.overlaps || []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Worktree per {project}
          </DialogTitle>
          <DialogDescription>
            {data?.gitRepo === false ? (
              'Questo progetto non è un repository git: la sessione userà la cartella direttamente.'
            ) : (
              <>
                Ogni sessione lavora in un worktree isolato, su un branch staccato da{' '}
                <code className="text-xs">{data?.baseBranch || 'staging'}</code>. Non si lavora mai
                direttamente sulla working copy condivisa.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carico i worktree…
          </div>
        )}

        {error && (
          <div className="text-sm text-destructive py-2">
            Impossibile leggere i worktree: {String(error)}
          </div>
        )}

        {data?.identity && !data.identity.hasKey && (
          <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
            <div>
              Nessuna chiave SSH per <strong>{data.identity.slug}</strong>: i push
              partirebbero con l&apos;identità di un altro account. Va aggiunta{' '}
              <code className="text-xs">~/.ssh/id_ed25519_gh_{data.identity.slug}</code>.
            </div>
          </div>
        )}

        {overlaps.length > 0 && (
          <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
            <div className="space-y-1">
              <div className="font-medium">Altri stanno lavorando su questo progetto</div>
              {overlaps.map((o) => (
                <div key={o.worktree} className="text-muted-foreground">
                  <strong>{o.owner}</strong> ha {o.files.length}{' '}
                  {o.files.length === 1 ? 'file modificato' : 'file modificati'}:{' '}
                  <span className="font-mono text-xs">{o.files.slice(0, 4).join(', ')}</span>
                  {o.files.length > 4 && ` +${o.files.length - 4}`}
                </div>
              ))}
            </div>
          </div>
        )}

        {data?.gitRepo !== false && (
          <ScrollArea className="max-h-64 pr-3">
            <div className="space-y-3">
              {mine.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">I tuoi worktree</div>
                  {mine.map((w) => (
                    <WorktreeRow key={w.path} w={w} onPick={pick} />
                  ))}
                </div>
              )}

              {others.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-muted-foreground">
                    Di altri (sola lettura)
                  </div>
                  {others.map((w) => (
                    <WorktreeRow key={w.path} w={w} onPick={pick} readOnly />
                  ))}
                </div>
              )}

              {mine.length === 0 && others.length === 0 && !isLoading && (
                <div className="text-sm text-muted-foreground py-2">
                  Nessun worktree ancora. Creane uno qui sotto per iniziare.
                </div>
              )}
            </div>
          </ScrollArea>
        )}

        {data?.gitRepo !== false && (
          <div className="space-y-2 border-t border-border pt-3">
            <Label htmlFor="wt-label" className="text-xs">
              Nuovo worktree
            </Label>
            <div className="flex gap-2">
              <Input
                id="wt-label"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="nome-attività (es. fix-login)"
                disabled={create.isPending}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreate()
                }}
              />
              <Button onClick={() => void handleCreate()} disabled={create.isPending}>
                {create.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Crea e apri
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Branch:{' '}
              <code>
                {data?.identity?.slug || 'utente'}/{newLabel.trim() || 'work'}
              </code>{' '}
              da <code>{data?.baseBranch || 'staging'}</code>
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Annulla
          </Button>
          {data?.gitRepo === false && (
            <Button onClick={() => { onSelect({ path: '', branch: '' }); onOpenChange(false) }}>
              Apri comunque
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function WorktreeRow({
  w,
  onPick,
  readOnly,
}: {
  w: Worktree
  onPick: (w: Worktree) => void
  readOnly?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(w)}
      className="w-full flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-left hover:bg-accent transition-colors"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono text-sm truncate">{w.branch}</span>
          {readOnly && (
            <Badge variant="outline" className="text-[10px] py-0">
              <User className="h-2.5 w-2.5 mr-1" />
              {w.owner}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
          {w.dirty > 0 ? (
            <span className="text-amber-500">
              {w.dirty} {w.dirty === 1 ? 'file modificato' : 'file modificati'}
            </span>
          ) : (
            <span>pulito</span>
          )}
          {w.lastUsed && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {relativeTime(w.lastUsed)}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}
