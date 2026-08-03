import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Server, Cloud, RefreshCw, Loader2, Eye, EyeOff, Save, CheckCircle2, XCircle,
  HardDrive, MemoryStick, Cpu, Boxes, AlertTriangle, ExternalLink, KeyRound,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface VpsHost {
  id: string
  ip: string
  hostname?: string
  label: string
  category: string
  notes?: string
}

interface VpsStats {
  id: string
  online: boolean
  error?: string
  uptime?: string
  load?: { one: number; five: number; fifteen: number }
  memory?: { totalMB: number; usedMB: number; usedPct: number }
  disks?: Array<{ mount: string; size: string; used: string; avail: string; usePct: number }>
  docker?: { count: number }
}

interface CoolifyInstance {
  id: string
  label: string
  url: string
  vpsId?: string
  owner?: string
  notes?: string
  tokenMasked: string | null
  hasToken: boolean
}

interface CoolifyStatus {
  reachable: boolean | null
  needsToken?: boolean
  unauthorized?: boolean
  version?: string
  applications?: number
  services?: number
  items?: Array<{ kind: string; name: string; status: string; fqdn: string }>
}

const api = {
  vps: async (): Promise<{ vps: VpsHost[] }> => {
    const r = await fetch('/api/vps', { credentials: 'include' })
    if (!r.ok) return { vps: [] }
    return r.json()
  },
  vpsStats: async (id: string): Promise<VpsStats> => {
    const r = await fetch(`/api/vps/${id}/stats`, { credentials: 'include' })
    if (!r.ok) throw new Error('probe fallito')
    return r.json()
  },
  coolify: async (): Promise<{ instances: CoolifyInstance[] }> => {
    const r = await fetch('/api/coolify', { credentials: 'include' })
    if (!r.ok) return { instances: [] }
    return r.json()
  },
  coolifyStatus: async (id: string): Promise<CoolifyStatus> => {
    const r = await fetch(`/api/coolify/${id}/status`, { credentials: 'include' })
    if (!r.ok) throw new Error('status fallito')
    return r.json()
  },
  saveToken: async (id: string, token: string) => {
    const r = await fetch(`/api/coolify/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token }),
    })
    if (!r.ok) throw new Error('salvataggio fallito')
    return r.json()
  },
  revealToken: async (id: string): Promise<{ token: string }> => {
    const r = await fetch(`/api/coolify/${id}/token`, { credentials: 'include' })
    if (!r.ok) throw new Error('token non presente')
    return r.json()
  },
}

function pctColor(p: number): string {
  if (p >= 90) return 'bg-red-500'
  if (p >= 70) return 'bg-amber-500'
  return 'bg-emerald-500'
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className={cn('h-full rounded-full', pctColor(pct))} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </div>
  )
}

/* ---------------- VPS ---------------- */
function VpsCard({ host }: { host: VpsHost }) {
  const [open, setOpen] = useState(false)
  const statsQuery = useQuery({
    queryKey: ['vps', host.id, 'stats'],
    queryFn: () => api.vpsStats(host.id),
    enabled: open,
    refetchInterval: open ? 30000 : false,
  })
  const s = statsQuery.data

  return (
    <Card className="p-3">
      <div className="flex items-start gap-3">
        <Server className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{host.label}</span>
            <span className="text-[10px] font-mono text-muted-foreground">{host.ip}</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/60 text-muted-foreground">{host.category}</span>
            <code className="text-[9px] text-muted-foreground">ssh {host.id}</code>
          </div>
          {host.notes && <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{host.notes}</p>}

          {open && (
            <div className="mt-3 space-y-2">
              {statsQuery.isLoading && (
                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> connessione SSH…
                </p>
              )}
              {statsQuery.error && <p className="text-[11px] text-destructive">Probe fallito</p>}
              {s && !s.online && (
                <p className="text-[11px] text-destructive flex items-center gap-1">
                  <XCircle className="w-3 h-3" /> offline {s.error ? `— ${s.error.slice(0, 80)}` : ''}
                </p>
              )}
              {s?.online && (
                <div className="space-y-2">
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
                    <span className="flex items-center gap-1 text-emerald-400">
                      <CheckCircle2 className="w-3 h-3" /> online
                    </span>
                    {s.uptime && <span>uptime {s.uptime}</span>}
                    {s.load && <span className="flex items-center gap-1"><Cpu className="w-2.5 h-2.5" />load {s.load.one.toFixed(2)}</span>}
                    {s.docker && <span className="flex items-center gap-1"><Boxes className="w-2.5 h-2.5" />{s.docker.count} container</span>}
                  </div>

                  {s.memory && (
                    <div>
                      <div className="flex items-center gap-1.5 text-[10px] mb-0.5">
                        <MemoryStick className="w-2.5 h-2.5 text-muted-foreground" />
                        <span>RAM</span>
                        <span className="ml-auto tabular-nums">
                          {(s.memory.usedMB / 1024).toFixed(1)}/{(s.memory.totalMB / 1024).toFixed(1)} GB · {s.memory.usedPct}%
                        </span>
                      </div>
                      <Bar pct={s.memory.usedPct} />
                    </div>
                  )}

                  {s.disks?.slice(0, 2).map((d) => (
                    <div key={d.mount}>
                      <div className="flex items-center gap-1.5 text-[10px] mb-0.5">
                        <HardDrive className="w-2.5 h-2.5 text-muted-foreground" />
                        <span className="font-mono">{d.mount}</span>
                        {d.usePct >= 85 && <AlertTriangle className="w-2.5 h-2.5 text-amber-400" />}
                        <span className="ml-auto tabular-nums">{d.used}/{d.size} · {d.usePct}% ({d.avail} liberi)</span>
                      </div>
                      <Bar pct={d.usePct} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <Button
          size="sm" variant="outline" className="h-6 px-2 text-[10px] gap-1 shrink-0"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Nascondi' : 'Stato live'}
          {open && statsQuery.isFetching && <Loader2 className="w-3 h-3 animate-spin" />}
        </Button>
      </div>
    </Card>
  )
}

/* ---------------- Coolify ---------------- */
function CoolifyCard({ inst }: { inst: CoolifyInstance }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [tokenDraft, setTokenDraft] = useState('')
  const [revealed, setRevealed] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const statusQuery = useQuery({
    queryKey: ['coolify', inst.id, 'status'],
    queryFn: () => api.coolifyStatus(inst.id),
    enabled: checking && inst.hasToken,
  })

  const saveMutation = useMutation({
    mutationFn: () => api.saveToken(inst.id, tokenDraft.trim()),
    onSuccess: () => {
      toast.success('Token salvato', { description: inst.label })
      setEditing(false); setTokenDraft('')
      qc.invalidateQueries({ queryKey: ['coolify'] })
    },
    onError: (e: Error) => toast.error('Salvataggio fallito', { description: e.message }),
  })

  const st = statusQuery.data

  return (
    <Card className="p-3">
      <div className="flex items-start gap-3">
        <Cloud className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{inst.label}</span>
            <a
              href={inst.url} target="_blank" rel="noreferrer"
              className="text-[10px] text-sky-400 hover:underline flex items-center gap-0.5"
            >
              {inst.url.replace('https://', '')} <ExternalLink className="w-2.5 h-2.5" />
            </a>
            {inst.owner && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent/60 text-muted-foreground">{inst.owner}</span>
            )}
            {inst.vpsId && <code className="text-[9px] text-muted-foreground">ssh {inst.vpsId}</code>}
          </div>
          {inst.notes && <p className="text-[10px] text-muted-foreground mt-1">{inst.notes}</p>}

          {/* Token */}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <KeyRound className="w-3 h-3 text-muted-foreground shrink-0" />
            {!editing && (
              <>
                <span className="text-[11px] font-mono text-muted-foreground">
                  {revealed || inst.tokenMasked || <span className="italic">nessun token</span>}
                </span>
                {inst.hasToken && (
                  <button
                    onClick={async () => {
                      if (revealed) { setRevealed(null); return }
                      try { setRevealed((await api.revealToken(inst.id)).token) }
                      catch { toast.error('Token non disponibile') }
                    }}
                    className="text-muted-foreground hover:text-foreground"
                    title={revealed ? 'Nascondi' : 'Rivela token'}
                  >
                    {revealed ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  </button>
                )}
                <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={() => setEditing(true)}>
                  {inst.hasToken ? 'cambia' : 'aggiungi'}
                </Button>
              </>
            )}
            {editing && (
              <>
                <Input
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  placeholder="API token Coolify"
                  className="h-6 text-[11px] font-mono flex-1 min-w-[180px]"
                  autoFocus
                />
                <Button
                  size="sm" className="h-6 px-2 text-[10px] gap-1"
                  onClick={() => saveMutation.mutate()}
                  disabled={!tokenDraft.trim() || saveMutation.isPending}
                >
                  {saveMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Salva
                </Button>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => { setEditing(false); setTokenDraft('') }}>
                  Annulla
                </Button>
              </>
            )}
          </div>

          {/* Stato */}
          {checking && (
            <div className="mt-2 text-[10px]">
              {statusQuery.isLoading && (
                <span className="text-muted-foreground flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> interrogo l'API…
                </span>
              )}
              {st?.needsToken && <span className="text-amber-400">Serve un token per interrogare l'API</span>}
              {st?.unauthorized && <span className="text-destructive">401 — token non valido</span>}
              {st?.reachable && (
                <div className="space-y-1">
                  <span className="text-emerald-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    raggiungibile {st.version && `· v${st.version}`} · {st.applications} app · {st.services} servizi
                  </span>
                  {st.items && st.items.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {st.items.slice(0, 12).map((it, i) => (
                        <span
                          key={i}
                          className="text-[9px] px-1.5 py-0.5 rounded bg-accent/50 text-muted-foreground"
                          title={it.fqdn || it.name}
                        >
                          {it.name}
                          {it.status && <span className={cn('ml-1', it.status.includes('running') ? 'text-emerald-400' : 'text-amber-400')}>●</span>}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {st && st.reachable === false && !st.needsToken && (
                <span className="text-destructive">non raggiungibile</span>
              )}
            </div>
          )}
        </div>

        <Button
          size="sm" variant="outline" className="h-6 px-2 text-[10px] gap-1 shrink-0"
          onClick={() => { setChecking(true); statusQuery.refetch() }}
          disabled={!inst.hasToken}
          title={inst.hasToken ? 'Interroga l\'API Coolify' : 'Aggiungi prima un token'}
        >
          <RefreshCw className={cn('w-3 h-3', statusQuery.isFetching && 'animate-spin')} />
          Verifica
        </Button>
      </div>
    </Card>
  )
}

/* ---------------- Pagina ---------------- */
export function InfrastructurePage() {
  const [tab, setTab] = useState<'vps' | 'coolify'>('vps')
  // queryKey distinta da VpsMonitor (Extra): condividevano ['vps','list'] ma le due
  // queryFn ritornano shape diverse ({vps} vs {hosts}) → chi popolava la cache per
  // ultimo faceva leggere all'altra la chiave sbagliata (una vista 6 VPS, l'altra 0).
  const vpsQuery = useQuery({ queryKey: ['vps', 'infra-list'], queryFn: api.vps })
  const coolifyQuery = useQuery({ queryKey: ['coolify'], queryFn: api.coolify })

  const vps = vpsQuery.data?.vps ?? []
  const instances = coolifyQuery.data?.instances ?? []

  const TabBtn = ({ id, label, count, icon: Icon }: { id: 'vps' | 'coolify'; label: string; count: number; icon: typeof Server }) => (
    <button
      onClick={() => setTab(id)}
      className={cn(
        'px-3 py-1.5 text-xs rounded-md transition-colors flex items-center gap-1.5',
        tab === id ? 'bg-primary/15 text-foreground font-medium' : 'text-muted-foreground hover:bg-accent/50'
      )}
    >
      <Icon className="w-3.5 h-3.5" /> {label} <span className="text-[10px] opacity-70">({count})</span>
    </button>
  )

  return (
    <div className="space-y-4 pb-12">
      <div className="flex items-center gap-3">
        <Server className="w-6 h-6 text-muted-foreground" />
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Infrastruttura</h1>
      </div>

      <div className="flex items-center gap-2">
        <TabBtn id="vps" label="VPS" count={vps.length} icon={Server} />
        <TabBtn id="coolify" label="Coolify" count={instances.length} icon={Cloud} />
      </div>

      {tab === 'vps' && (
        <div className="space-y-2">
          {vpsQuery.isLoading && <p className="text-xs text-muted-foreground">Caricamento…</p>}
          {vps.length === 0 && !vpsQuery.isLoading && (
            <Card className="p-6 text-center text-sm text-muted-foreground">Nessun VPS nell'inventario.</Card>
          )}
          {vps.map((h) => <VpsCard key={h.id} host={h} />)}
          <p className="text-[10px] text-muted-foreground pt-1">
            "Stato live" apre una connessione SSH al server e legge carico, RAM, dischi e container.
          </p>
        </div>
      )}

      {tab === 'coolify' && (
        <div className="space-y-2">
          {coolifyQuery.isLoading && <p className="text-xs text-muted-foreground">Caricamento…</p>}
          {instances.map((i) => <CoolifyCard key={i.id} inst={i} />)}
          <p className="text-[10px] text-muted-foreground pt-1">
            I token restano sul tuo Mac (cartella dati di SAIO, fuori da git) e non compaiono mai in chiaro negli elenchi.
          </p>
        </div>
      )}
    </div>
  )
}
