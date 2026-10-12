import { ShieldAlert } from 'lucide-react'
import { EmbeddedChat } from '@/components/projects/EmbeddedChat'
import { useIsSuperAdmin } from '@/hooks/useAuth'

/**
 * Shell root dell'admin, in un clic (Nicola, 12/10/2026). E' una sessione tmux sua
 * (`<slug>-shell-root`), ripresa se c'e' gia'. Solo il super admin: il server rifiuta il
 * WebSocket a chiunque altro, la pagina lo dice e basta.
 */
export function ShellRootPage() {
  const superAdmin = useIsSuperAdmin()
  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-5 h-5 text-red-400" />
        <h1 className="text-lg font-semibold">Shell root</h1>
        <span className="text-xs text-red-300/80">root su questa macchina: ogni comando conta</span>
      </div>
      {superAdmin ? (
        <div className="flex-1 min-h-0 overflow-auto rounded-md border border-red-500/30">
          <EmbeddedChat projectId="shell-root" />
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">La shell root la apre solo Nicola.</div>
      )}
    </div>
  )
}
