import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MessagesSquare, Search, Loader2, X, Folder, User, Sparkles, Clock } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ChatMeta {
  id: string
  slug: string
  project: string
  worktree: string | null
  mtime: number
  size: number
  preview?: string
}

interface ChatsResponse {
  total: number
  totalAll: number
  offset: number
  limit: number
  chats: ChatMeta[]
  projects: { name: string; count: number }[]
}

interface ChatDetail {
  id: string
  cwd: string | null
  count: number
  messages: { role: string; text: string; ts: string | null }[]
}

async function fetchChats(project: string, q: string, offset: number): Promise<ChatsResponse> {
  const p = new URLSearchParams({ limit: '30', offset: String(offset) })
  if (project) p.set('project', project)
  if (q) p.set('q', q)
  const res = await fetch(`/api/chats?${p}`, { credentials: 'include' })
  if (!res.ok) throw new Error('Storico non disponibile')
  return res.json()
}

async function fetchChatDetail(slug: string, id: string): Promise<ChatDetail> {
  const res = await fetch(`/api/chats/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Conversazione non trovata')
  return res.json()
}

function dateLabel(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return `oggi ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
  const yest = new Date(today.getTime() - 86400000)
  if (d.toDateString() === yest.toDateString())
    return `ieri ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' })
}

export function ChatsPage() {
  const [project, setProject] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<{ slug: string; id: string } | null>(null)

  const listQuery = useQuery({
    queryKey: ['chats', project, query, offset],
    queryFn: () => fetchChats(project, query, offset),
  })

  const detailQuery = useQuery({
    queryKey: ['chat', selected?.slug, selected?.id],
    queryFn: () => fetchChatDetail(selected!.slug, selected!.id),
    enabled: !!selected,
  })

  const data = listQuery.data

  return (
    <div className="flex flex-col lg:flex-row h-[calc(100vh-6rem)] gap-3 lg:gap-4 -m-4 md:-m-6 p-4 md:p-6 min-h-0">
      {/* Lista */}
      <aside className="w-full lg:w-96 flex flex-col shrink-0 border border-border rounded-lg bg-card/30 overflow-hidden max-h-[45vh] lg:max-h-none">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center gap-2">
            <MessagesSquare className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Storico chat</h2>
            {data && (
              <span className="ml-auto text-[10px] text-muted-foreground">
                {data.total} di {data.totalAll}
              </span>
            )}
          </div>

          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setOffset(0) }}
              placeholder="Cerca nelle anteprime..."
              className="h-7 pl-7 text-xs"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Filtro progetti */}
          {data && data.projects.length > 0 && (
            <div className="flex gap-1 flex-wrap max-h-20 overflow-auto scrollbar-thin">
              <button
                onClick={() => { setProject(''); setOffset(0) }}
                className={cn(
                  'px-1.5 py-0.5 rounded text-[10px] transition-colors',
                  !project ? 'bg-primary/20 text-foreground' : 'bg-accent/40 text-muted-foreground hover:bg-accent'
                )}
              >
                tutti
              </button>
              {data.projects.slice(0, 14).map((p) => (
                <button
                  key={p.name}
                  onClick={() => { setProject(p.name); setOffset(0) }}
                  className={cn(
                    'px-1.5 py-0.5 rounded text-[10px] transition-colors truncate max-w-[140px]',
                    project === p.name
                      ? 'bg-primary/20 text-foreground'
                      : 'bg-accent/40 text-muted-foreground hover:bg-accent'
                  )}
                  title={`${p.name} · ${p.count} conversazioni`}
                >
                  {p.name} <span className="opacity-60">{p.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto scrollbar-thin p-2 space-y-1">
          {listQuery.isLoading && <p className="text-xs text-muted-foreground px-2">Caricamento…</p>}
          {listQuery.error && <p className="text-xs text-destructive px-2">Storico non disponibile</p>}
          {data?.chats.length === 0 && (
            <p className="text-xs text-muted-foreground px-2 py-4 text-center">Nessuna conversazione.</p>
          )}

          {data?.chats.map((c) => {
            const isSel = selected?.id === c.id
            return (
              <button
                key={`${c.slug}/${c.id}`}
                onClick={() => setSelected({ slug: c.slug, id: c.id })}
                className={cn(
                  'w-full text-left rounded-md px-2 py-2 border transition-colors',
                  isSel ? 'bg-primary/10 border-primary/40' : 'border-transparent hover:bg-accent/50'
                )}
              >
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Folder className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate">{c.project}</span>
                  {c.worktree && (
                    <span className="px-1 rounded bg-amber-500/15 text-amber-400 text-[9px]">⑂ {c.worktree}</span>
                  )}
                  <span className="ml-auto shrink-0">{dateLabel(c.mtime)}</span>
                </div>
                <p className="text-[11px] mt-1 line-clamp-2 text-foreground/90">
                  {c.preview || <span className="text-muted-foreground italic">(nessuna anteprima)</span>}
                </p>
              </button>
            )
          })}
        </div>

        {/* Paginazione */}
        {data && data.total > data.limit && (
          <div className="p-2 border-t border-border flex items-center gap-2">
            <Button
              size="sm" variant="ghost" className="h-6 px-2 text-[10px]"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 30))}
            >
              ← precedenti
            </Button>
            <span className="text-[10px] text-muted-foreground mx-auto">
              {offset + 1}–{Math.min(offset + 30, data.total)}
            </span>
            <Button
              size="sm" variant="ghost" className="h-6 px-2 text-[10px]"
              disabled={offset + 30 >= data.total}
              onClick={() => setOffset(offset + 30)}
            >
              successive →
            </Button>
          </div>
        )}
      </aside>

      {/* Viewer conversazione */}
      <main className="flex-1 min-w-0 border border-border rounded-lg bg-card/30 overflow-hidden flex flex-col">
        {!selected && (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <MessagesSquare className="w-16 h-16 opacity-20 mb-3" />
            <p className="text-sm">Seleziona una conversazione</p>
            <p className="text-xs mt-1 opacity-70">Tutto lo storico è salvato in locale sul tuo Mac</p>
          </div>
        )}

        {selected && detailQuery.isLoading && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {selected && detailQuery.data && (
          <>
            <div className="px-4 py-2 border-b border-border bg-card/50 flex items-center gap-2">
              <MessagesSquare className="w-4 h-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold truncate">
                  {detailQuery.data.cwd?.split('/').filter(Boolean).pop() || selected.id}
                </div>
                <div className="text-[10px] text-muted-foreground font-mono truncate">
                  {detailQuery.data.cwd || selected.slug}
                </div>
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {detailQuery.data.count} messaggi
              </span>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setSelected(null)}>
                Chiudi
              </Button>
            </div>

            <div className="flex-1 overflow-auto scrollbar-thin p-4 space-y-3">
              {detailQuery.data.messages.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    'rounded-lg px-3 py-2 max-w-[85%]',
                    m.role === 'user'
                      ? 'bg-primary/10 border border-primary/20 ml-auto'
                      : 'bg-card/60 border border-border'
                  )}
                >
                  <div className="flex items-center gap-1.5 mb-1 text-[10px] text-muted-foreground">
                    {m.role === 'user' ? <User className="w-2.5 h-2.5" /> : <Sparkles className="w-2.5 h-2.5" />}
                    <span>{m.role === 'user' ? 'Tu' : 'Claude'}</span>
                    {m.ts && (
                      <>
                        <Clock className="w-2.5 h-2.5 ml-1" />
                        <span>{new Date(m.ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      </>
                    )}
                  </div>
                  <p className="text-xs whitespace-pre-wrap break-words leading-relaxed">{m.text}</p>
                </div>
              ))}
              {detailQuery.data.messages.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-8">
                  Nessun messaggio leggibile in questa conversazione.
                </p>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
