import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  TerminalSquare, Trash2, RefreshCw, Loader2, Folder, Circle, Globe, Server, Cpu,
  Maximize2, Minimize2, Plus, Ban, UserRound, ArrowLeftRight, ChevronDown, ChevronRight, Hand,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { EmbeddedChat } from '@/components/projects/EmbeddedChat'

interface SessionAccount {
  id: string
  label: string
  email: string | null
  weeklyPercent: number | null
  severity: 'normal' | 'warning' | 'critical' | null
  /** Finestra settimanale finita: aprire la sessione non produrrebbe nulla. */
  exhausted: boolean
  resetsAt: string | null
}

interface TmuxSession {
  name: string
  windows: number
  attached: boolean
  created: number
  cwd: string
  project?: string | null
  worktree?: string | null
  account?: SessionAccount | null
  /**
   * 'working' = sta elaborando · 'waiting' = fermo su una domanda, aspetta te ·
   * 'idle' = libero al prompt · 'shell' = nessun Claude nella pane.
   */
  activity?: 'working' | 'waiting' | 'idle' | 'shell'
  /** Chi ha aperto la sessione, dedotto dal prefisso del nome. */
  owner?: { slug: string; name: string } | null
}

interface PwInstance {
  pid: number
  kind: 'server' | 'browser'
  cpu: number
  memMb: number
  uptime: string
  session: string | null
  cmd: string
}

async function fetchTmuxSessions(): Promise<{ sessions: TmuxSession[] }> {
  const res = await fetch('/api/system/tmux-sessions', { credentials: 'include' })
  if (!res.ok) return { sessions: [] }
  return res.json()
}

/**
 * Sposta una sessione gia' aperta su un altro account, portandosi dietro la conversazione.
 * Il 409 non e' un errore ma uno stato forzabile: Claude sta lavorando in quel momento.
 */
async function switchSessionAccount(name: string, account: string, force = false) {
  const res = await fetch(`/api/system/tmux-sessions/${encodeURIComponent(name)}/account`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, force }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.message || 'Cambio account fallito') as Error & { code?: string }
    err.code = data.error
    throw err
  }
  return data as { from: string; to: string; transcript: string | null }
}

async function killTmuxSession(name: string) {
  const res = await fetch(`/api/system/tmux-sessions/${encodeURIComponent(name)}`, {
    method: 'DELETE', credentials: 'include',
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Terminazione fallita')
  return res.json()
}

interface ProjectLite {
  id: string
  name: string
  path?: string | null
}

async function fetchProjectsLite(): Promise<ProjectLite[]> {
  const res = await fetch('/api/projects', { credentials: 'include' })
  if (!res.ok) return []
  const data = await res.json().catch(() => null)
  const list = Array.isArray(data) ? data : (data?.projects ?? [])
  return (list as ProjectLite[]).filter((p) => p?.name && p?.path)
}

interface ClaudeAccount {
  id: string
  label: string
  email: string | null
  isDefault: boolean
  usage: {
    weeklyPercent: number
    sessionPercent: number
    weeklyResetsAt: string | null
    severity: 'normal' | 'warning' | 'critical'
  } | null
  error: string | null
  /** La percentuale è l'ultima letta, non una lettura fresca (endpoint usage limitato). */
  stale?: boolean
  staleMinutes?: number
}

/** Già ordinati dal più libero al più carico dal server. */
async function fetchClaudeAccounts(refresh = false): Promise<{ accounts: ClaudeAccount[]; freestId: string | null }> {
  const res = await fetch(`/api/system/claude-accounts${refresh ? '?refresh=1' : ''}`, { credentials: 'include' })
  if (!res.ok) return { accounts: [], freestId: null }
  return res.json()
}

/**
 * Come si legge il nome di una sessione nella UI: senza il prefisso del proprietario (lo dice
 * gia' il gruppo che la contiene) e con trattini e underscore resi come spazi.
 *
 * Il nome vero resta quello tecnico: finisce non quotato in righe di comando tmux e nell'URL
 * del WebSocket, dove uno spazio romperebbe tutto. Qui si tocca solo cio' che si vede.
 */
function prettySessionName(name: string, ownerSlug?: string | null): string {
  const senzaPrefisso = ownerSlug && name.startsWith(`${ownerSlug}-`) ? name.slice(ownerSlug.length + 1) : name
  return senzaPrefisso.replace(/[-_]+/g, ' ')
}

/** "reset oggi 14:00" / "reset mar 14:00" — la finestra settimanale non si legge in ISO. */
function resetLabel(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
  const isToday = d.toDateString() === new Date().toDateString()
  return isToday ? `reset oggi ${time}` : `reset ${d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

async function createTmuxSession(body: { name: string; projectId: string | null; startClaude: boolean; account: string | null }) {
  const res = await fetch('/api/system/tmux-sessions', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || data.error || 'Creazione fallita')
  return data as { name: string; created: boolean; alreadyExisted?: boolean }
}

async function fetchPlaywright(): Promise<{ instances: PwInstance[]; counts: { servers: number; browsers: number } }> {
  const res = await fetch('/api/system/playwright', { credentials: 'include' })
  if (!res.ok) return { instances: [], counts: { servers: 0, browsers: 0 } }
  return res.json()
}

async function killPlaywright(pid: number) {
  const res = await fetch(`/api/system/playwright/${pid}`, { method: 'DELETE', credentials: 'include' })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Kill fallito')
  return res.json()
}

function uptimeLabel(createdSec: number): string {
  if (!createdSec) return ''
  const mins = Math.floor((Date.now() / 1000 - createdSec) / 60)
  if (mins < 1) return 'adesso'
  if (mins < 60) return `${mins}min`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}g`
}

export function SessionsPage() {
  const [tab, setTab] = useState<'tmux' | 'playwright'>('tmux')
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmKill, setConfirmKill] = useState<string | null>(null)
  const [confirmPw, setConfirmPw] = useState<number | null>(null)
  // Nuova sessione: creabile direttamente da qui, senza passare dalla card progetto.
  const [showNew, setShowNew] = useState(false)
  const [newProjectId, setNewProjectId] = useState<string>('')
  const [newName, setNewName] = useState('')
  const [newStartClaude, setNewStartClaude] = useState(true)
  // null = non ancora scelto: alla prima risposta si preseleziona l'account più libero.
  const [newAccount, setNewAccount] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const sessionsQuery = useQuery({
    queryKey: ['tmux', 'sessions'],
    queryFn: fetchTmuxSessions,
    refetchInterval: 5000,
  })

  const pwQuery = useQuery({
    queryKey: ['playwright', 'instances'],
    queryFn: fetchPlaywright,
    refetchInterval: 5000,
  })

  // Sessione per cui e' aperto il selettore "cambia account", e conferma pendente quando la
  // sessione sta lavorando (l'unico caso in cui si chiede due volte).
  const [switchFor, setSwitchFor] = useState<string | null>(null)
  const [switchBusy, setSwitchBusy] = useState<{ name: string; account: string } | null>(null)

  const switchMutation = useMutation({
    mutationFn: (v: { name: string; account: string; force?: boolean }) =>
      switchSessionAccount(v.name, v.account, v.force),
    onSuccess: (data, v) => {
      toast.success(`"${v.name}" ora gira su ${data.to}`, {
        description: data.transcript ? 'Conversazione ripresa da dove era' : 'Ripartita senza cronologia precedente',
      })
      setSwitchFor(null)
      setSwitchBusy(null)
      queryClient.invalidateQueries({ queryKey: ['tmux', 'sessions'] })
    },
    onError: (err: Error & { code?: string }, v) => {
      if (err.code === 'busy') {
        setSwitchBusy({ name: v.name, account: v.account })
        return
      }
      toast.error('Cambio account fallito', { description: err.message })
    },
  })

  const killMutation = useMutation({
    mutationFn: (name: string) => killTmuxSession(name),
    onSuccess: (_d, name) => {
      toast.success(`Sessione "${name}" terminata`)
      setConfirmKill(null)
      if (selected === name) setSelected(null)
      queryClient.invalidateQueries({ queryKey: ['tmux', 'sessions'] })
    },
    onError: (err: Error) => toast.error('Terminazione fallita', { description: err.message }),
  })

  const killPwMutation = useMutation({
    mutationFn: (pid: number) => killPlaywright(pid),
    onSuccess: (_d, pid) => {
      toast.success(`Istanza Playwright ${pid} terminata`)
      setConfirmPw(null)
      queryClient.invalidateQueries({ queryKey: ['playwright', 'instances'] })
    },
    onError: (err: Error) => toast.error('Kill fallito', { description: err.message }),
  })

  const projectsQuery = useQuery({
    queryKey: ['projects', 'lite'],
    queryFn: fetchProjectsLite,
    enabled: showNew, // si carica solo all'apertura del dialogo
  })

  // Interroga Anthropic: si carica solo con la modale aperta, non a ogni refresh della pagina.
  const accountsQuery = useQuery({
    queryKey: ['claude', 'accounts'],
    queryFn: () => fetchClaudeAccounts(),
    enabled: showNew || switchFor !== null,
    staleTime: 60_000,
  })

  const accounts = accountsQuery.data?.accounts ?? []
  const freestId = accountsQuery.data?.freestId ?? null
  // Preselezione automatica del più libero, finché Nicola non sceglie a mano.
  const pickedAccount = newAccount ?? freestId

  const createMutation = useMutation({
    mutationFn: createTmuxSession,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['tmux', 'sessions'] })
      setShowNew(false)
      setSelected(data.name) // apre subito la sessione appena creata
      toast.success(
        data.alreadyExisted ? `Sessione "${data.name}" già attiva` : `Sessione "${data.name}" creata`
      )
    },
    onError: (err: Error) => toast.error('Creazione fallita', { description: err.message }),
  })

  const sessions = sessionsQuery.data?.sessions ?? []

  // Avviso quando una sessione smette di lavorare: e' il momento in cui serve tornarci.
  // Si confronta con il giro precedente invece di tenere stato sul server, cosi' vale anche
  // per le sessioni aperte da SSH. Al primo caricamento non si notifica nulla: sarebbero
  // tutte "appena finite" solo perche' non le avevamo mai viste.
  const prevActivity = useRef<Record<string, string> | null>(null)
  useEffect(() => {
    const now: Record<string, string> = {}
    for (const s of sessions) now[s.name] = s.activity || 'shell'
    const before = prevActivity.current
    if (before) {
      for (const [name, act] of Object.entries(now)) {
        // Due passaggi meritano un avviso: la sessione si e' bloccata su una domanda (sta ferma
        // finche' non rispondi) oppure ha finito di lavorare.
        const bloccata = act === 'waiting' && before[name] !== 'waiting'
        const finita = before[name] === 'working' && act === 'idle'
        if (!bloccata && !finita) continue
        const testo = bloccata ? `"${name}" aspetta una risposta` : `"${name}" ha finito di lavorare`
        if (bloccata) toast.warning(testo)
        else toast.success(testo)
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(bloccata ? 'SAIO — serve una risposta' : 'SAIO — sessione pronta', { body: testo, tag: name })
          }
        } catch {
          /* notifiche non disponibili: resta il toast */
        }
      }
    }
    prevActivity.current = now
  }, [sessions])

  // Il permesso si chiede una volta sola; se negato restano i toast dentro la pagina.
  useEffect(() => {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission()
      }
    } catch {
      /* browser senza Notification API */
    }
  }, [])

  // Sessioni raggruppate per proprietario: su una macchina condivisa la lista piatta mescola
  // il lavoro di tutti. L'ordine tiene davanti chi guarda, poi gli altri per nome, e infine le
  // sessioni senza proprietario (aperte da SSH o create prima del prefisso).
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({})
  const groups = (() => {
    const map = new Map<string, { key: string; label: string; items: TmuxSession[] }>()
    for (const s of sessions) {
      const key = s.owner?.slug || '__nessuno'
      const label = s.owner?.name || 'Senza proprietario'
      const g = map.get(key) || { key, label, items: [] }
      g.items.push(s)
      map.set(key, g)
    }
    return [...map.values()].sort((a, b) => {
      if (a.key === '__nessuno') return 1
      if (b.key === '__nessuno') return -1
      return a.label.localeCompare(b.label)
    })
  })()

  const pw = pwQuery.data?.instances ?? []
  const pwCount = pw.length
  const projects = projectsQuery.data ?? []

  const openNewDialog = () => {
    setNewProjectId('')
    setNewName('')
    setNewStartClaude(true)
    setNewAccount(null) // torna alla preselezione automatica del più libero
    setShowNew(true)
  }

  // Scegliendo un progetto il nome si compila da solo (resta modificabile).
  const onPickProject = (id: string) => {
    setNewProjectId(id)
    const p = projects.find((x) => x.id === id)
    if (p) setNewName(p.name.replace(/[^a-zA-Z0-9._-]/g, '-'))
  }

  const nameIsValid = /^[a-zA-Z0-9._-]+$/.test(newName)

  const TabButton = ({ id, label, count }: { id: 'tmux' | 'playwright'; label: string; count: number }) => (
    <button
      onClick={() => setTab(id)}
      className={cn(
        'px-3 py-1.5 text-xs rounded-md transition-colors flex items-center gap-1.5',
        tab === id ? 'bg-primary/15 text-foreground font-medium' : 'text-muted-foreground hover:bg-accent/50'
      )}
    >
      {id === 'tmux' ? <TerminalSquare className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
      {label}
      <span className="text-[10px] opacity-70">({count})</span>
    </button>
  )

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] gap-3 -m-4 md:-m-6 p-4 md:p-6 min-h-0">
      {/* Tab switcher */}
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <TabButton id="tmux" label="Sessioni tmux" count={sessions.length} />
        <TabButton id="playwright" label="Playwright" count={pwCount} />
        {tab === 'tmux' && (
          <Button size="sm" variant="outline" className="ml-2 h-7 text-xs gap-1.5" onClick={openNewDialog}>
            <Plus className="w-3.5 h-3.5" />
            Nuova sessione
          </Button>
        )}
        <button
          onClick={() => (tab === 'tmux' ? sessionsQuery.refetch() : pwQuery.refetch())}
          className="sm:ml-auto text-muted-foreground hover:text-foreground shrink-0"
          title="Aggiorna"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', (sessionsQuery.isFetching || pwQuery.isFetching) && 'animate-spin')} />
        </button>
      </div>

      {/* ---------- TAB TMUX ---------- */}
      {tab === 'tmux' && (
        <div className="flex flex-col lg:flex-row gap-3 lg:gap-4 flex-1 min-h-0">
          <aside className="w-full lg:w-80 flex flex-col shrink-0 border border-border rounded-lg bg-card/30 overflow-hidden max-h-[45vh] lg:max-h-none">
            <div className="flex-1 overflow-auto scrollbar-thin p-2 space-y-1">
              {sessionsQuery.isLoading && <p className="text-xs text-muted-foreground px-2">Caricamento…</p>}
              {!sessionsQuery.isLoading && sessions.length === 0 && (
                <p className="text-xs text-muted-foreground px-2 py-4 text-center">Nessuna sessione tmux attiva.</p>
              )}
              {groups.map((g) => {
                const chiuso = !!closedGroups[g.key]
                const attivi = g.items.filter((x) => x.activity === 'working').length
                const inAttesa = g.items.filter((x) => x.activity === 'waiting').length
                const fermi = g.items.filter((x) => x.account?.exhausted).length
                return (
                <div key={g.key} className="mb-1">
                  <button
                    onClick={() => setClosedGroups((p) => ({ ...p, [g.key]: !p[g.key] }))}
                    className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  >
                    {chiuso ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    <span className="font-medium">{g.label}</span>
                    <span className="text-muted-foreground/60">({g.items.length})</span>
                    {inAttesa > 0 && <span className="text-red-400 normal-case font-medium">· {inAttesa} aspetta te</span>}
                    {attivi > 0 && <span className="text-amber-400 normal-case">· {attivi} al lavoro</span>}
                    {fermi > 0 && <span className="text-red-400 normal-case">· {fermi} a limite</span>}
                  </button>
                  {!chiuso && g.items.map((s) => {
                const isSel = selected === s.name
                const folder = s.cwd ? s.cwd.split('/').filter(Boolean).pop() : ''
                const working = s.activity === 'working'
                const waiting = s.activity === 'waiting'
                const exhausted = !!s.account?.exhausted
                return (
                  <div
                    key={s.name}
                    className={cn(
                      'group rounded-md border transition-colors',
                      isSel ? 'bg-primary/10 border-primary/40' : 'border-transparent hover:bg-accent/50'
                    )}
                  >
                    <div className="flex items-center gap-2 px-2 py-2">
                      <button className="flex-1 min-w-0 text-left" onClick={() => setSelected(s.name)}>
                        <div className="flex items-center gap-1.5">
                          {waiting ? (
                            <Hand className="w-2.5 h-2.5 shrink-0 text-red-400 animate-pulse" />
                          ) : working ? (
                            <Loader2 className="w-2.5 h-2.5 shrink-0 animate-spin text-amber-400" />
                          ) : (
                            <Circle
                              className={cn(
                                'w-2 h-2 shrink-0',
                                exhausted
                                  ? 'fill-red-500 text-red-500'
                                  : s.attached
                                    ? 'fill-emerald-400 text-emerald-400'
                                    : 'fill-slate-500 text-slate-500'
                              )}
                            />
                          )}
                          <span
                            className={cn('text-xs font-medium truncate', exhausted && 'text-muted-foreground')}
                            title={s.name}
                          >
                            {prettySessionName(s.name, s.owner?.slug)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground flex-wrap">
                          {(s.project || folder) && (
                            <>
                              <Folder className="w-2.5 h-2.5 shrink-0" />
                              <span className="truncate">{s.project || folder}</span>
                            </>
                          )}
                          {s.worktree && (
                            <span
                              className="px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 text-[9px]"
                              title={`Worktree isolato: ${s.worktree}`}
                            >
                              ⑂ {s.worktree}
                            </span>
                          )}
                          <span>· {uptimeLabel(s.created)}</span>
                          {s.attached && <span className="text-emerald-400">· in uso</span>}
                          {s.account && (
                            <span
                              className={cn(
                                'flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px]',
                                exhausted ? 'bg-red-500/15 text-red-400' : 'bg-muted text-muted-foreground'
                              )}
                              title={
                                exhausted
                                  ? `${s.account.email || s.account.label}: limite settimanale finito — ${resetLabel(s.account.resetsAt)}`
                                  : `${s.account.email || s.account.label}${s.account.weeklyPercent != null ? ` — ${s.account.weeklyPercent}% della settimana usato` : ''}`
                              }
                            >
                              <UserRound className="w-2.5 h-2.5" />
                              {s.account.label}
                            </span>
                          )}
                          {exhausted && (
                            <span className="flex items-center gap-0.5 text-red-400" title={resetLabel(s.account?.resetsAt ?? null)}>
                              <Ban className="w-2.5 h-2.5" /> limite finito
                            </span>
                          )}
                          {working && <span className="text-amber-400">· sta lavorando</span>}
                          {waiting && <span className="text-red-400 font-medium">· aspetta te</span>}
                        </div>
                      </button>
                      {confirmKill === s.name ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <Button size="sm" variant="destructive" className="h-6 px-2 text-[10px]" onClick={() => killMutation.mutate(s.name)} disabled={killMutation.isPending}>
                            {killMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Conferma'}
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setConfirmKill(null)}>No</Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 shrink-0 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
                          {/* Su touch non esiste l'hover: da telefono i bottoni restano visibili,
                              altrimenti cambio account e chiusura sarebbero irraggiungibili. */}
                          {s.account && (
                            <button
                              onClick={() => setSwitchFor(s.name)}
                              className="text-muted-foreground hover:text-primary"
                              title={`Cambia account (ora: ${s.account.label})`}
                            >
                              <ArrowLeftRight className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button onClick={() => setConfirmKill(s.name)} className="text-muted-foreground hover:text-destructive" title={`Termina "${s.name}"`}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
                  })}
                </div>
                )
              })}
            </div>
            <div className="p-2 border-t border-border text-[10px] text-muted-foreground">
              Click per aprire. Il cestino termina <strong>una sola</strong> sessione.
            </div>
          </aside>

          <main className="flex-1 min-w-0 border border-border rounded-lg bg-card/30 overflow-hidden flex flex-col">
            {!selected && (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                <TerminalSquare className="w-16 h-16 opacity-20 mb-3" />
                <p className="text-sm">Seleziona una sessione per vederla</p>
                <p className="text-xs mt-1 opacity-70">Resta viva anche se chiudi SAIO</p>
              </div>
            )}
            {selected && (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="px-4 py-2 border-b border-border bg-card/50 flex items-center gap-2">
                  <TerminalSquare className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="text-sm font-semibold truncate" title={selected}>
                    {prettySessionName(selected, sessions.find((x) => x.name === selected)?.owner?.slug)}
                  </span>
                  {/* Il tutto-schermo vive dentro EmbeddedChat: vale sia qui che in Progetti */}
                  <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[10px]" onClick={() => setSelected(null)}>Chiudi vista</Button>
                </div>
                <div className="flex-1 min-h-0 overflow-auto">
                  <EmbeddedChat key={selected} projectId={`tmux-${selected}`} />
                </div>
              </div>
            )}
          </main>
        </div>
      )}

      {/* ---------- TAB PLAYWRIGHT ---------- */}
      {tab === 'playwright' && (
        <div className="flex-1 min-h-0 overflow-auto scrollbar-thin">
          {pwQuery.isLoading && <p className="text-xs text-muted-foreground">Lettura processi…</p>}

          {!pwQuery.isLoading && pw.length === 0 && (
            <Card className="p-8 flex flex-col items-center justify-center text-muted-foreground">
              <Globe className="w-12 h-12 opacity-20 mb-3" />
              <p className="text-sm">Nessuna istanza Playwright attiva</p>
            </Card>
          )}

          {pw.length > 0 && (
            <>
              <div className="text-[11px] text-muted-foreground mb-2">
                {pwQuery.data?.counts.servers ?? 0} server MCP · {pwQuery.data?.counts.browsers ?? 0} browser.
                Le istanze restano vive finché non le chiudi: qui puoi terminarle una alla volta.
              </div>
              <div className="space-y-2">
                {pw.map((i) => (
                  <Card key={i.pid} className="p-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      {i.kind === 'server' ? (
                        <Server className="w-4 h-4 text-violet-400 shrink-0" />
                      ) : (
                        <Globe className="w-4 h-4 text-sky-400 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold">
                            {i.kind === 'server' ? 'Server MCP' : 'Browser'}
                          </span>
                          <span className="text-[10px] font-mono text-muted-foreground">PID {i.pid}</span>
                          {i.session ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                              da: {i.session}
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/15 text-muted-foreground">
                              origine sconosciuta
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                          <span className="flex items-center gap-1"><Cpu className="w-2.5 h-2.5" />{i.cpu.toFixed(1)}%</span>
                          <span>{i.memMb} MB</span>
                          <span>attivo da {i.uptime}</span>
                        </div>
                        <div className="text-[9px] font-mono text-muted-foreground/60 truncate mt-1">{i.cmd}</div>
                      </div>

                      {confirmPw === i.pid ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <Button size="sm" variant="destructive" className="h-6 px-2 text-[10px]" onClick={() => killPwMutation.mutate(i.pid)} disabled={killPwMutation.isPending}>
                            {killPwMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Conferma'}
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setConfirmPw(null)}>No</Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] gap-1 shrink-0" onClick={() => setConfirmPw(i.pid)}>
                          <Trash2 className="w-3 h-3" /> Termina
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ---------- NUOVA SESSIONE ---------- */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Nuova sessione tmux</DialogTitle>
            <DialogDescription>
              Resta viva sul server anche chiudendo SAIO: la ritrovi da qualsiasi dispositivo.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-session-project" className="text-xs">Progetto</Label>
              <select
                id="new-session-project"
                value={newProjectId}
                onChange={(e) => onPickProject(e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">— nessuno (sessione libera nella home) —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {projectsQuery.isLoading && (
                <p className="text-[10px] text-muted-foreground">Carico i progetti…</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-session-name" className="text-xs">Nome sessione</Label>
              <Input
                id="new-session-name"
                value={newName}
                // Gli spazi sono comodi da digitare ma illegali nel nome tmux: si convertono
                // mentre si scrive, cosi' il vincolo non si vede e non si sbaglia.
                onChange={(e) => setNewName(e.target.value.replace(/\s+/g, '-'))}
                placeholder="es. komanda-dashboard"
                autoComplete="off"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nameIsValid && !createMutation.isPending) {
                    createMutation.mutate({
                      name: newName,
                      projectId: newProjectId || null,
                      startClaude: newStartClaude,
                      account: newStartClaude ? pickedAccount : null,
                    })
                  }
                }}
              />
              {newName && !nameIsValid && (
                <p className="text-[10px] text-destructive">
                  Ammessi solo lettere, numeri, punto, trattino e underscore (gli spazi diventano trattini).
                </p>
              )}
            </div>

            <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={newStartClaude}
                onChange={(e) => setNewStartClaude(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              Avvia <span className="font-mono">claude</span> all'apertura
            </label>

            {/* Quale abbonamento usare: preselezionato quello con la settimana più libera. */}
            {newStartClaude && (
              <div className="space-y-1.5 pl-5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Account</Label>
                  <button
                    type="button"
                    onClick={() => {
                      queryClient.setQueryData(['claude', 'accounts'], undefined)
                      fetchClaudeAccounts(true).then((d) => queryClient.setQueryData(['claude', 'accounts'], d))
                    }}
                    className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    <RefreshCw className={cn('w-3 h-3', accountsQuery.isFetching && 'animate-spin')} />
                    aggiorna
                  </button>
                </div>

                {accountsQuery.isLoading && (
                  <p className="text-[10px] text-muted-foreground">Leggo le finestre token…</p>
                )}

                {!accountsQuery.isLoading && accounts.length === 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    Nessun account rilevato: parte <span className="font-mono">claude</span> con la config di default.
                  </p>
                )}

                {accounts.map((a) => {
                  const picked = pickedAccount === a.id
                  const weekly = a.usage?.weeklyPercent
                  const sev = a.usage?.severity ?? 'normal'
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setNewAccount(a.id)}
                      className={cn(
                        'w-full flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors',
                        picked ? 'border-primary bg-primary/10' : 'border-input hover:bg-accent/50'
                      )}
                    >
                      <Circle className={cn('w-2 h-2 shrink-0', picked ? 'fill-primary text-primary' : 'text-muted-foreground/40')} />
                      <span className="font-mono text-xs">{a.label}</span>
                      {a.id === freestId && accounts.length > 1 && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-500">più libero</span>
                      )}
                      <span className="ml-auto text-right shrink-0">
                        {a.usage ? (
                          <>
                            <span
                              className={cn(
                                'text-[11px] font-medium',
                                sev === 'critical' && 'text-destructive',
                                sev === 'warning' && 'text-amber-500',
                                sev === 'normal' && 'text-emerald-500'
                              )}
                            >
                              {weekly}% settimana
                            </span>
                            <span className="block text-[9px] text-muted-foreground/70">
                              {weekly !== undefined && weekly >= 100 ? 'esaurito · ' : ''}
                              {a.stale ? `dato di ${a.staleMinutes} min fa` : resetLabel(a.usage.weeklyResetsAt)}
                            </span>
                          </>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">{a.error || 'n/d'}</span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Annulla</Button>
            <Button
              disabled={!nameIsValid || createMutation.isPending}
              onClick={() =>
                createMutation.mutate({
                  name: newName,
                  projectId: newProjectId || null,
                  startClaude: newStartClaude,
                  account: newStartClaude ? pickedAccount : null,
                })
              }
            >
              {createMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
              Crea
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cambio account a sessione aperta: la conversazione si sposta con lei, quindi si
          riprende da dove era invece di ricominciare su un account con token liberi. */}
      <Dialog open={switchFor !== null} onOpenChange={(o) => { if (!o) { setSwitchFor(null); setSwitchBusy(null) } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cambia account</DialogTitle>
            <DialogDescription>
              La sessione <span className="font-mono">{switchFor}</span> viene fermata e riavviata
              sull'account scelto, riprendendo la conversazione da dove era.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            {accountsQuery.isLoading && <p className="text-[10px] text-muted-foreground">Leggo le finestre token…</p>}
            {accounts.map((a) => {
              const weekly = a.usage?.weeklyPercent
              const sev = a.usage?.severity ?? 'normal'
              const current = sessions.find((x) => x.name === switchFor)?.account?.id === a.id
              const full = weekly !== undefined && weekly >= 100
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={current || switchMutation.isPending}
                  onClick={() => switchMutation.mutate({ name: switchFor!, account: a.id })}
                  className={cn(
                    'w-full flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors',
                    current ? 'border-input opacity-50 cursor-default' : 'border-input hover:bg-accent/50',
                    full && !current && 'opacity-60'
                  )}
                >
                  <Circle className={cn('w-2 h-2 shrink-0', current ? 'fill-primary text-primary' : 'text-muted-foreground/40')} />
                  <span className="font-mono text-xs">{a.label}</span>
                  {current && <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">in uso ora</span>}
                  {a.id === freestId && !current && accounts.length > 1 && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-500">più libero</span>
                  )}
                  <span className="ml-auto text-right shrink-0">
                    {a.usage ? (
                      <>
                        <span
                          className={cn(
                            'text-[11px] font-medium',
                            sev === 'critical' && 'text-destructive',
                            sev === 'warning' && 'text-amber-500',
                            sev === 'normal' && 'text-emerald-500'
                          )}
                        >
                          {weekly}% settimana
                        </span>
                        <span className="block text-[9px] text-muted-foreground/70">
                          {full ? 'esaurito · ' : ''}
                          {a.stale ? `dato di ${a.staleMinutes} min fa` : resetLabel(a.usage.weeklyResetsAt)}
                        </span>
                      </>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">{a.error || 'n/d'}</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>

          {switchBusy && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 space-y-2">
              <p className="text-[11px] text-amber-200">
                La sessione sta lavorando in questo momento: cambiando account ora, quello che Claude
                sta facendo va perso.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 text-[11px]"
                  disabled={switchMutation.isPending}
                  onClick={() => switchMutation.mutate({ ...switchBusy, force: true })}
                >
                  {switchMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                  Cambia comunque
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setSwitchBusy(null)}>
                  Aspetta che finisca
                </Button>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => { setSwitchFor(null); setSwitchBusy(null) }}>Chiudi</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
