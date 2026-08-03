import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Cpu, MemoryStick, HardDrive, Activity, ChevronDown, Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface SystemStats {
  cpu: { cores: number; model: string; loadPct: number; load: { '1m': number; '5m': number; '15m': number } }
  memory: {
    total: number
    free: number
    used: number
    pct: number
    cached?: number
    wired?: number
    compressed?: number
  }
  disk: { total: number; used: number; free: number; pct: number }
  uptime: number
}

interface ProcInfo {
  pid: number
  name: string
  cpu: number
  memMb: number
  uptime: string
  session: string | null
  cmd: string
}

async function fetchSystemStats(): Promise<SystemStats> {
  const res = await fetch('/api/system/stats', { credentials: 'include' })
  if (!res.ok) throw new Error('stats non disponibili')
  return res.json()
}

async function fetchProcesses(by: 'cpu' | 'mem'): Promise<{ processes: ProcInfo[] }> {
  const res = await fetch(`/api/system/processes?by=${by}&limit=15`, { credentials: 'include' })
  if (!res.ok) return { processes: [] }
  return res.json()
}

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1)
}

function uptimeLabel(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  if (d > 0) return `${d}g ${h}h`
  const m = Math.floor((sec % 3600) / 60)
  return `${h}h ${m}min`
}

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 70) return 'bg-amber-500'
  return 'bg-emerald-500'
}

function Metric({
  icon: Icon, label, pct, detail, onClick, expanded,
}: {
  icon: typeof Cpu
  label: string
  pct: number
  detail: string
  onClick?: () => void
  expanded?: boolean
}) {
  const Wrapper = onClick ? 'button' : 'div'
  return (
    <Wrapper
      onClick={onClick}
      className={cn('space-y-1.5 text-left w-full', onClick && 'hover:opacity-80 transition-opacity')}
    >
      <div className="flex items-center gap-2 text-xs">
        <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="font-medium">{label}</span>
        {onClick && (
          <ChevronDown className={cn('w-3 h-3 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
        )}
        <span className="ml-auto tabular-nums font-semibold">{pct}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-500', barColor(pct))}
          style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
        />
      </div>
      <div className="text-[10px] text-muted-foreground">{detail}</div>
    </Wrapper>
  )
}

export function SystemMonitor() {
  const [openDetail, setOpenDetail] = useState<'cpu' | 'mem' | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['system', 'stats'],
    queryFn: fetchSystemStats,
    refetchInterval: 3000,
  })

  const procQuery = useQuery({
    queryKey: ['system', 'processes', openDetail],
    queryFn: () => fetchProcesses(openDetail === 'cpu' ? 'cpu' : 'mem'),
    enabled: !!openDetail,
    refetchInterval: 5000,
  })

  const toggle = (which: 'cpu' | 'mem') => setOpenDetail((cur) => (cur === which ? null : which))

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Activity className="w-4 h-4 text-emerald-400" />
        <h3 className="text-sm font-semibold">Risorse del Mac</h3>
        {data && (
          <span className="ml-auto text-[10px] text-muted-foreground">acceso da {uptimeLabel(data.uptime)}</span>
        )}
      </div>

      {isLoading && <p className="text-xs text-muted-foreground">Lettura risorse…</p>}
      {error && <p className="text-xs text-destructive">Risorse non disponibili</p>}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Metric
              icon={Cpu}
              label="CPU"
              pct={data.cpu.loadPct}
              detail={`${data.cpu.cores} core · carico ${data.cpu.load['1m'].toFixed(2)} (1m)`}
              onClick={() => toggle('cpu')}
              expanded={openDetail === 'cpu'}
            />
            <Metric
              icon={MemoryStick}
              label="RAM"
              pct={data.memory.pct}
              detail={
                `${gb(data.memory.used)} / ${gb(data.memory.total)} GB usati` +
                (data.memory.cached ? ` · ${gb(data.memory.cached)} GB cache` : '')
              }
              onClick={() => toggle('mem')}
              expanded={openDetail === 'mem'}
            />
            <Metric
              icon={HardDrive}
              label="Disco"
              pct={data.disk.pct}
              detail={`${gb(data.disk.free)} GB liberi di ${gb(data.disk.total)} GB`}
            />
          </div>

          {openDetail && (
            <div className="mt-4 pt-3 border-t border-border">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium">
                  {openDetail === 'cpu' ? 'Chi sta usando la CPU' : 'Chi sta occupando la RAM'}
                </span>
                {procQuery.isFetching && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                <button
                  onClick={() => setOpenDetail(null)}
                  className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
                >
                  chiudi
                </button>
              </div>

              <div className="space-y-1 max-h-72 overflow-auto scrollbar-thin">
                {(procQuery.data?.processes ?? []).map((p) => (
                  <div
                    key={p.pid}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/40 text-[11px]"
                  >
                    <span className="font-medium truncate flex-1 min-w-0" title={p.cmd}>
                      {p.name}
                    </span>
                    {p.session && (
                      <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                        {p.session}
                      </span>
                    )}
                    <span className="shrink-0 text-muted-foreground tabular-nums w-16 text-right">
                      {p.uptime}
                    </span>
                    <span className="shrink-0 tabular-nums w-14 text-right font-semibold">
                      {openDetail === 'cpu' ? `${p.cpu.toFixed(1)}%` : `${p.memMb} MB`}
                    </span>
                  </div>
                ))}
                {procQuery.data?.processes.length === 0 && (
                  <p className="text-[11px] text-muted-foreground px-2">Nessun dato disponibile.</p>
                )}
              </div>
              <p className="text-[9px] text-muted-foreground mt-2 leading-relaxed">
                Il badge verde indica la sessione tmux che ha avviato il processo.
                {openDetail === 'mem' && (
                  <>
                    {' '}La somma dei processi <strong>non coincide</strong> col totale: la memoria
                    condivisa (librerie di sistema) viene conteggiata per ogni processo che la usa.
                  </>
                )}
              </p>
            </div>
          )}
        </>
      )}
    </Card>
  )
}
