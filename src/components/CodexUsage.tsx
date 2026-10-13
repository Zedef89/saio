import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'

interface Window { usedPercent: number; windowMinutes: number; resetsAt: number | null }
interface Usage {
  primary: Window | null; secondary: Window | null; plan: string | null
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null
  updatedAt: string; source: 'app-server' | 'sessions'
}
export function CodexUsage({ enabled = true }: { enabled?: boolean }) {
  const query = useQuery({
    queryKey: ['codex', 'usage'],
    queryFn: async (): Promise<{ usage: Usage | null }> => {
      const response = await fetch('/api/system/codex-usage', { credentials: 'include' })
      if (!response.ok) throw new Error('Uso Codex non disponibile')
      return response.json()
    },
    enabled, staleTime: 60_000, refetchInterval: enabled ? 60_000 : false,
  })
  const usage = query.data?.usage
  const age = usage ? Math.max(0, Math.floor((Date.now() - Date.parse(usage.updatedAt)) / 60_000)) : 0
  const windows = [usage?.primary, usage?.secondary].filter((w): w is Window => !!w).sort((a, b) => b.windowMinutes - a.windowMinutes)
  return (
    <div className="space-y-1.5" data-testid="codex-usage">
      <div className="flex items-center justify-between">
        <span className="text-xs">Codex{usage?.plan ? ` · ${usage.plan}` : ''}</span>
        <button type="button" onClick={() => query.refetch()} className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1">
          <RefreshCw className={`w-3 h-3 ${query.isFetching ? 'animate-spin' : ''}`} /> aggiorna
        </button>
      </div>
      <div className="rounded-md border border-input px-2.5 py-1.5 space-y-1">
        {!usage && <p className="text-[10px] text-muted-foreground">{query.isFetching ? 'Leggo il consumo Codex…' : 'Consumo Codex non disponibile.'}</p>}
        {windows.map((w, i) => (
          <div key={i} className="flex items-center justify-between gap-2 text-[10px]">
            <span>{w.windowMinutes === 10080 ? 'Settimana' : w.windowMinutes < 1440 ? `Finestra breve (${w.windowMinutes / 60} h)` : `Finestra ${w.windowMinutes / 1440} giorni`}</span>
            <span className={w.usedPercent >= 90 ? 'text-red-400' : w.usedPercent >= 70 ? 'text-amber-400' : 'text-emerald-400'}>{w.usedPercent}% usato</span>
            <span className="text-muted-foreground">{w.resetsAt ? `si azzera ${new Date(w.resetsAt * 1000).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'Reset non disponibile'}</span>
          </div>
        ))}
        {usage && <>
          <p className="text-[10px] text-muted-foreground">Crediti: {usage.credits?.unlimited ? 'illimitati' : usage.credits?.balance ?? (usage.credits?.hasCredits ? 'disponibili' : 'non disponibili')}</p>
          <p className="text-[10px] text-muted-foreground">Aggiornato {age} minuti fa{usage.source === 'sessions' ? ' · ultima sessione Codex' : ''}{age >= 5 ? ' · dato vecchio, potrebbe essere cambiato' : ''}</p>
        </>}
      </div>
    </div>
  )
}
