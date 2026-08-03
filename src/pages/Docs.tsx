import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Search, FileText, Loader2, X, Pencil, Save, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { VaultTree, type TreeNode } from '@/components/docs/VaultTree'
import { MarkdownRenderer } from '@/components/docs/MarkdownRenderer'
import { formatRelativeTime } from '@/lib/utils'

async function fetchVaultTree() {
  const res = await fetch('/api/vault/tree')
  if (!res.ok) throw new Error('Failed to load vault tree')
  return res.json() as Promise<{ root: string; tree: TreeNode[] }>
}

async function fetchVaultFile(path: string) {
  const res = await fetch(`/api/vault/file?path=${encodeURIComponent(path)}`)
  if (!res.ok) throw new Error('File not found')
  return res.json() as Promise<{
    path: string
    name: string
    size: number
    mtime: string
    content: string
    raw?: string
  }>
}

async function saveVaultFile(path: string, content: string) {
  const res = await fetch('/api/vault/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ path, content }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Salvataggio fallito')
  }
  return res.json()
}

function findByBasename(nodes: TreeNode[], basename: string): TreeNode | null {
  const target = basename.toLowerCase().replace(/\.md$/, '')
  for (const n of nodes) {
    if (n.type === 'file' && n.name.replace(/\.md$/, '').toLowerCase() === target) return n
    if (n.type === 'dir' && n.children) {
      const found = findByBasename(n.children, basename)
      if (found) return found
    }
  }
  return null
}

export function DocsPage() {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const queryClient = useQueryClient()

  const treeQuery = useQuery({ queryKey: ['vault', 'tree'], queryFn: fetchVaultTree })
  const fileQuery = useQuery({
    queryKey: ['vault', 'file', selectedPath],
    queryFn: () => fetchVaultFile(selectedPath!),
    enabled: !!selectedPath,
  })

  // Cambiando file si esce sempre dalla modalità modifica (evita di salvare sul file sbagliato)
  useEffect(() => {
    setEditing(false)
    setDraft('')
  }, [selectedPath])

  const saveMutation = useMutation({
    mutationFn: () => saveVaultFile(selectedPath!, draft),
    onSuccess: () => {
      toast.success('File salvato', { description: selectedPath || undefined })
      setEditing(false)
      queryClient.invalidateQueries({ queryKey: ['vault', 'file', selectedPath] })
      queryClient.invalidateQueries({ queryKey: ['vault', 'tree'] })
    },
    onError: (err: Error) => {
      toast.error('Salvataggio fallito', { description: err.message })
    },
  })

  const startEditing = () => {
    if (!fileQuery.data) return
    // raw = file completo con frontmatter; fallback su content per compatibilità
    setDraft(fileQuery.data.raw ?? fileQuery.data.content)
    setEditing(true)
  }

  const handleWikiLinkClick = (target: string) => {
    if (!treeQuery.data) return
    const node = findByBasename(treeQuery.data.tree, target)
    if (node && node.type === 'file') {
      setSelectedPath(node.path)
    }
  }

  return (
    <div className="flex flex-col lg:flex-row h-[calc(100vh-6rem)] gap-3 lg:gap-4 -m-4 md:-m-6 p-4 md:p-6 min-h-0">
      {/* Sidebar — mobile: top 40vh, desktop: left 72w */}
      <aside className="w-full lg:w-72 flex flex-col shrink-0 border border-border rounded-lg bg-card/30 overflow-hidden max-h-[40vh] lg:max-h-none">
        <div className="p-3 border-b border-border">
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Vault</h2>
            {treeQuery.data && (
              <span className="ml-auto text-[10px] text-muted-foreground">
                {countFiles(treeQuery.data.tree)} file
              </span>
            )}
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filtra file..."
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
        <div className="flex-1 overflow-auto scrollbar-thin p-2">
          {treeQuery.isLoading && <p className="text-xs text-muted-foreground">Caricamento...</p>}
          {treeQuery.data && (
            <VaultTree
              nodes={treeQuery.data.tree}
              selectedPath={selectedPath}
              onSelect={(n) => setSelectedPath(n.path)}
              query={query}
            />
          )}
        </div>
      </aside>

      {/* Viewer / Editor */}
      <main className="flex-1 min-w-0 border border-border rounded-lg bg-card/30 overflow-hidden flex flex-col">
        {!selectedPath && (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <BookOpen className="w-16 h-16 opacity-20 mb-3" />
            <p className="text-sm">Seleziona un file dal vault</p>
          </div>
        )}

        {selectedPath && fileQuery.isLoading && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {selectedPath && fileQuery.error && (
          <div className="flex-1 flex items-center justify-center text-sm text-destructive">
            Errore: {String(fileQuery.error)}
          </div>
        )}

        {fileQuery.data && (
          <>
            <div className="px-6 py-3 border-b border-border bg-card/50 flex items-center gap-3">
              <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold truncate">{fileQuery.data.name.replace(/\.md$/, '')}</div>
                <div className="text-[10px] text-muted-foreground font-mono truncate">{fileQuery.data.path}</div>
              </div>

              {!editing && (
                <>
                  <div className="text-[10px] text-muted-foreground shrink-0">
                    {(fileQuery.data.size / 1024).toFixed(1)} KB · {formatRelativeTime(fileQuery.data.mtime)}
                  </div>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 shrink-0" onClick={startEditing}>
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
                    {saveMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
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
                  <MarkdownRenderer
                    content={fileQuery.data.content}
                    onWikiLinkClick={handleWikiLinkClick}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function countFiles(tree: TreeNode[]): number {
  let count = 0
  for (const n of tree) {
    if (n.type === 'file') count++
    if (n.children) count += countFiles(n.children)
  }
  return count
}
