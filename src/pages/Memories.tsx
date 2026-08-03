import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Brain,
  Search,
  FileText,
  FileCode2,
  Loader2,
  X,
  Pencil,
  Save,
  Undo2,
  ChevronRight,
  ChevronDown,
  GitBranch,
} from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { MarkdownRenderer } from '@/components/docs/MarkdownRenderer'
import { formatRelativeTime, cn } from '@/lib/utils'

type Kind = 'memory' | 'claude'

interface MemoryProject {
  slug: string
  project: string
  worktree: string | null
  projectPath: string | null
  memories: number
  claudeMds: number
  count: number
  mtime: number
}

interface MemoryFile {
  kind: Kind
  name: string
  label: string
  size: number
  mtime: number
  description: string
  type: string
}

interface Selection {
  slug: string
  kind: Kind
  name: string
}

async function fetchProjects() {
  const res = await fetch('/api/memories', { credentials: 'include' })
  if (!res.ok) throw new Error('Caricamento progetti fallito')
  return res.json() as Promise<{ projects: MemoryProject[]; total: number }>
}

async function fetchFiles(slug: string) {
  const res = await fetch(`/api/memories/files?slug=${encodeURIComponent(slug)}`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Caricamento file fallito')
  return res.json() as Promise<{ slug: string; project: string; projectPath: string | null; files: MemoryFile[] }>
}

async function fetchFile(sel: Selection) {
  const qs = new URLSearchParams({ slug: sel.slug, kind: sel.kind, name: sel.name })
  const res = await fetch(`/api/memories/file?${qs}`, { credentials: 'include' })
  if (!res.ok) throw new Error('File non trovato')
  return res.json() as Promise<{
    kind: Kind
    slug: string
    name: string
    path: string
    size: number
    mtime: number
    content: string
    raw: string
  }>
}

async function saveFile(sel: Selection, content: string) {
  const res = await fetch('/api/memories/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ ...sel, content }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || err.error || 'Salvataggio fallito')
  }
  return res.json()
}

// Colore del badge per tipo (convenzione CLAUDE.md: user/feedback/project/reference)
const TYPE_STYLES: Record<string, string> = {
  user: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
  feedback: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  project: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  reference: 'bg-violet-500/10 text-violet-400 border-violet-500/30',
  claude: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
}

export function MemoriesPage() {
  const [openSlug, setOpenSlug] = useState<string | null>(null)
  const [selected, setSelected] = useState<Selection | null>(null)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const queryClient = useQueryClient()

  const projectsQuery = useQuery({ queryKey: ['memories', 'projects'], queryFn: fetchProjects })
  const filesQuery = useQuery({
    queryKey: ['memories', 'files', openSlug],
    queryFn: () => fetchFiles(openSlug!),
    enabled: !!openSlug,
  })
  const fileQuery = useQuery({
    queryKey: ['memories', 'file', selected?.slug, selected?.kind, selected?.name],
    queryFn: () => fetchFile(selected!),
    enabled: !!selected,
  })

  // Cambiando file si esce sempre dalla modifica (evita di salvare sul file sbagliato)
  useEffect(() => {
    setEditing(false)
    setDraft('')
  }, [selected?.slug, selected?.kind, selected?.name])

  const saveMutation = useMutation({
    mutationFn: () => saveFile(selected!, draft),
    onSuccess: () => {
      toast.success('Salvato', { description: `${selected?.name}` })
      setEditing(false)
      queryClient.invalidateQueries({ queryKey: ['memories', 'file'] })
      queryClient.invalidateQueries({ queryKey: ['memories', 'files', selected?.slug] })
      queryClient.invalidateQueries({ queryKey: ['memories', 'projects'] })
    },
    onError: (err: Error) => toast.error('Salvataggio fallito', { description: err.message }),
  })

  const startEditing = () => {
    if (!fileQuery.data) return
    setDraft(fileQuery.data.raw) // raw = file completo col frontmatter
    setEditing(true)
  }

  const q = query.toLowerCase().trim()
  const projects = (projectsQuery.data?.projects || []).filter(
    (p) => !q || p.project.toLowerCase().includes(q) || (p.worktree || '').toLowerCase().includes(q)
  )

  return (
    <div className="flex flex-col lg:flex-row h-[calc(100vh-6rem)] gap-3 lg:gap-4 -m-4 md:-m-6 p-4 md:p-6 min-h-0">
      {/* Colonna progetti + file */}
      <aside className="w-full lg:w-80 flex flex-col shrink-0 border border-border rounded-lg bg-card/30 overflow-hidden max-h-[40vh] lg:max-h-none">
        <div className="p-3 border-b border-border">
          <div className="flex items-center gap-2 mb-2">
            <Brain className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Memorie &amp; CLAUDE.md</h2>
            {projectsQuery.data && (
              <span className="ml-auto text-[10px] text-muted-foreground">
                {projectsQuery.data.total} file
              </span>
            )}
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filtra progetti o file..."
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
        </div>

        <div className="flex-1 overflow-auto scrollbar-thin p-2 space-y-0.5">
          {projectsQuery.isLoading && <p className="text-xs text-muted-foreground px-1">Caricamento...</p>}
          {projectsQuery.data && projects.length === 0 && (
            <p className="text-xs text-muted-foreground px-1">Nessun risultato.</p>
          )}

          {projects.map((p) => {
            const open = openSlug === p.slug
            return (
              <div key={p.slug}>
                <button
                  onClick={() => setOpenSlug(open ? null : p.slug)}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left hover:bg-accent/50 transition-colors"
                  title={p.projectPath || p.slug}
                >
                  {open ? (
                    <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="text-xs truncate flex-1">{p.project}</span>
                  {p.worktree && (
                    <span className="flex items-center gap-0.5 text-[9px] text-amber-400 shrink-0">
                      <GitBranch className="w-2.5 h-2.5" />
                      {p.worktree}
                    </span>
                  )}
                  {p.claudeMds > 0 && (
                    <span className="text-[9px] px-1 rounded border border-orange-500/30 bg-orange-500/10 text-orange-400 shrink-0">
                      MD
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground shrink-0">{p.count}</span>
                </button>

                {open && (
                  <div className="ml-4 border-l border-border pl-1.5 py-0.5 space-y-0.5">
                    {filesQuery.isLoading && (
                      <p className="text-[10px] text-muted-foreground px-1 py-1">Caricamento file...</p>
                    )}
                    {filesQuery.data?.files
                      .filter(
                        (f) =>
                          !q ||
                          f.name.toLowerCase().includes(q) ||
                          f.description.toLowerCase().includes(q)
                      )
                      .map((f) => {
                        const active =
                          selected?.slug === p.slug &&
                          selected?.name === f.name &&
                          selected?.kind === f.kind
                        const Icon = f.kind === 'claude' ? FileCode2 : FileText
                        return (
                          <button
                            key={`${f.kind}:${f.name}`}
                            onClick={() => setSelected({ slug: p.slug, kind: f.kind, name: f.name })}
                            className={cn(
                              'w-full text-left px-2 py-1 rounded transition-colors',
                              active ? 'bg-primary/15 text-primary' : 'hover:bg-accent/50'
                            )}
                            title={f.description || f.name}
                          >
                            <div className="flex items-center gap-1.5">
                              <Icon
                                className={cn(
                                  'w-3 h-3 shrink-0',
                                  f.kind === 'claude' ? 'text-orange-400' : 'opacity-60'
                                )}
                              />
                              <span className="text-[11px] truncate flex-1">{f.label}</span>
                              {f.type && f.type !== 'claude' && (
                                <span
                                  className={cn(
                                    'text-[8px] px-1 py-px rounded border shrink-0',
                                    TYPE_STYLES[f.type] || 'bg-muted text-muted-foreground border-border'
                                  )}
                                >
                                  {f.type}
                                </span>
                              )}
                            </div>
                            {f.description && (
                              <div className="text-[9px] text-muted-foreground truncate pl-[18px] mt-0.5">
                                {f.description}
                              </div>
                            )}
                          </button>
                        )
                      })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </aside>

      {/* Viewer / Editor */}
      <main className="flex-1 min-w-0 border border-border rounded-lg bg-card/30 overflow-hidden flex flex-col">
        {!selected && (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <Brain className="w-16 h-16 opacity-20 mb-3" />
            <p className="text-sm">Seleziona una memoria o un CLAUDE.md</p>
            <p className="text-[11px] mt-1 opacity-60">
              ~/.claude/projects/&lt;progetto&gt;/memory/ · &lt;progetto&gt;/CLAUDE.md
            </p>
          </div>
        )}

        {selected && fileQuery.isLoading && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {selected && fileQuery.error && (
          <div className="flex-1 flex items-center justify-center text-sm text-destructive">
            Errore: {String(fileQuery.error)}
          </div>
        )}

        {fileQuery.data && (
          <>
            <div className="px-6 py-3 border-b border-border bg-card/50 flex items-center gap-3">
              {fileQuery.data.kind === 'claude' ? (
                <FileCode2 className="w-4 h-4 text-orange-400 shrink-0" />
              ) : (
                <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold truncate">
                  {fileQuery.data.name.replace(/\.md$/, '')}
                </div>
                <div className="text-[10px] text-muted-foreground font-mono truncate">
                  {fileQuery.data.path}
                </div>
              </div>

              {!editing && (
                <>
                  <div className="text-[10px] text-muted-foreground shrink-0">
                    {(fileQuery.data.size / 1024).toFixed(1)} KB ·{' '}
                    {formatRelativeTime(new Date(fileQuery.data.mtime).toISOString())}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1.5 shrink-0"
                    onClick={startEditing}
                  >
                    <Pencil className="w-3 h-3" /> Modifica
                  </Button>
                </>
              )}

              {editing && (
                <>
                  <span className="text-[10px] text-amber-400 shrink-0">modifica in corso</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs gap-1.5 shrink-0"
                    onClick={() => setEditing(false)}
                    disabled={saveMutation.isPending}
                  >
                    <Undo2 className="w-3 h-3" /> Annulla
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-xs gap-1.5 shrink-0"
                    onClick={() => saveMutation.mutate()}
                    disabled={saveMutation.isPending}
                  >
                    {saveMutation.isPending ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Save className="w-3 h-3" />
                    )}
                    Salva
                  </Button>
                </>
              )}
            </div>

            <div className="flex-1 overflow-auto scrollbar-thin">
              {editing ? (
                <div className="h-full p-4">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    className="w-full h-full min-h-[60vh] font-mono text-xs leading-relaxed resize-none"
                  />
                </div>
              ) : (
                <div className="max-w-4xl mx-auto px-8 py-6">
                  <MarkdownRenderer content={fileQuery.data.content} />
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
