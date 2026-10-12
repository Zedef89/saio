import { useQuery } from '@tanstack/react-query'
import { Crown, Loader2 } from 'lucide-react'
import { EmbeddedChat } from '@/components/projects/EmbeddedChat'

/**
 * La sessione madre di Nicola (tmux `nicola-sessione-madre`), con un posto suo: fra decine di
 * sessioni nella lista si perdeva (Nicola, 12/10/2026). La pagina e' solo visiva: chi puo'
 * scriverci lo decide il server (lib/pty-access.ts) — Nicola si', gli altri la guardano.
 */
const SESSIONE = 'nicola-sessione-madre'

async function esiste(): Promise<boolean | null> {
  const res = await fetch('/api/system/tmux-sessions', { credentials: 'include' })
  if (!res.ok) return null
  const data = (await res.json()) as { sessions?: { name: string }[] }
  return (data.sessions || []).some((s) => s.name === SESSIONE)
}

export function SessioneMadrePage() {
  const q = useQuery({ queryKey: ['sessione-madre', 'esiste'], queryFn: esiste, refetchInterval: 30_000 })
  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <div className="flex items-center gap-2">
        <Crown className="w-5 h-5 text-amber-400" />
        <h1 className="text-lg font-semibold">Sessione madre</h1>
        <span className="text-xs text-muted-foreground font-mono">{SESSIONE}</span>
      </div>
      {q.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Cerco la sessione…
        </div>
      ) : q.data === false ? (
        <div className="text-sm text-muted-foreground">
          La sessione <span className="font-mono">{SESSIONE}</span> adesso non è aperta.
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto rounded-md border border-amber-500/30">
          <EmbeddedChat projectId={`tmux-${SESSIONE}`} />
        </div>
      )}
    </div>
  )
}
