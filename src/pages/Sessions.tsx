import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  TerminalSquare, Trash2, RefreshCw, Loader2, Folder, Circle, Globe, Server, Cpu,
  Maximize2, Minimize2, Plus,
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

interface TmuxSession {
  name: string
  windows: number
  attached: boolean
  created: number
  cwd: string
  project?: string | null
  worktree?: string | null
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

async function createTmuxSession(body: { name: string; projectId: string | null; startClaude: boolean }) {
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
  const pw = pwQuery.data?.instances ?? []
  const pwCount = pw.length
  const projects = projectsQuery.data ?? []

  const openNewDialog = () => {
    setNewProjectId('')
    setNewName('')
    setNewStartClaude(true)
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
              {sessions.map((s) => {
                const isSel = selected === s.name
                const folder = s.cwd ? s.cwd.split('/').filter(Boolean).pop() : ''
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
                          <Circle className={cn('w-2 h-2 shrink-0', s.attached ? 'fill-emerald-400 text-emerald-400' : 'fill-slate-500 text-slate-500')} />
                          <span className="text-xs font-medium truncate">{s.name}</span>
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
                        <button onClick={() => setConfirmKill(s.name)} className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity" title={`Termina "${s.name}"`}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
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
                  <span className="text-sm font-semibold truncate">{selected}</span>
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
                onChange={(e) => setNewName(e.target.value)}
                placeholder="es. komanda-dashboard"
                autoComplete="off"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nameIsValid && !createMutation.isPending) {
                    createMutation.mutate({
                      name: newName,
                      projectId: newProjectId || null,
                      startClaude: newStartClaude,
                    })
                  }
                }}
              />
              {newName && !nameIsValid && (
                <p className="text-[10px] text-destructive">
                  Ammessi solo lettere, numeri, punto, trattino e underscore.
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
                })
              }
            >
              {createMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
              Crea
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
