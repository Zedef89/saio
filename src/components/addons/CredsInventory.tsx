import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Key, Loader2, Plus, Pencil, Trash2, Eye, EyeOff, Copy, Check, X, Save, Lock,
} from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface CredItem {
  id: string | null
  name: string
  scope: string
  project: string
  source: 'settings.json env' | 'custom'
  editable: boolean
  configured: boolean
  hint: string
}

interface CredForm {
  name: string
  value: string
  scope: string
  project: string
}

const EMPTY: CredForm = { name: '', value: '', scope: '', project: '' }

async function fetchCreds() {
  const res = await fetch('/api/credentials', { credentials: 'include' })
  if (!res.ok) throw new Error('Failed')
  return res.json() as Promise<{
    items: CredItem[]
    stats: { total: number; custom: number; detected: number }
  }>
}

async function reveal(id: string): Promise<string> {
  const res = await fetch(`/api/credentials/${id}/reveal`, { credentials: 'include' })
  if (!res.ok) throw new Error('reveal fallito')
  return (await res.json()).value
}

export function CredsInventory() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['credentials'], queryFn: fetchCreds, staleTime: 60_000 })

  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<CredForm>(EMPTY)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['credentials'] })

  const addMut = useMutation({
    mutationFn: async (f: CredForm) => {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(f),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'errore')
      return res.json()
    },
    onSuccess: () => { toast.success('Credenziale aggiunta'); setAdding(false); setForm(EMPTY); invalidate() },
    onError: (e: Error) => toast.error('Aggiunta fallita', { description: e.message }),
  })

  const editMut = useMutation({
    mutationFn: async ({ id, f }: { id: string; f: Partial<CredForm> }) => {
      const res = await fetch(`/api/credentials/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(f),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'errore')
      return res.json()
    },
    onSuccess: () => { toast.success('Credenziale aggiornata'); setEditingId(null); setForm(EMPTY); invalidate() },
    onError: (e: Error) => toast.error('Modifica fallita', { description: e.message }),
  })

  const delMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/credentials/${id}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) throw new Error('errore')
    },
    onSuccess: () => { toast.success('Credenziale eliminata'); invalidate() },
    onError: (e: Error) => toast.error('Eliminazione fallita', { description: e.message }),
  })

  const toggleReveal = async (id: string) => {
    if (revealed[id] !== undefined) {
      setRevealed((r) => { const n = { ...r }; delete n[id]; return n })
      return
    }
    try {
      const v = await reveal(id)
      setRevealed((r) => ({ ...r, [id]: v }))
    } catch (e) {
      toast.error('Impossibile rivelare', { description: (e as Error).message })
    }
  }

  const copyValue = async (id: string) => {
    try {
      const v = revealed[id] ?? (await reveal(id))
      await navigator.clipboard.writeText(v)
      setCopied(id)
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500)
    } catch (e) {
      toast.error('Copia fallita', { description: (e as Error).message })
    }
  }

  const startEdit = (c: CredItem) => {
    setEditingId(c.id)
    setForm({ name: c.name, value: '', scope: c.scope, project: c.project })
    setAdding(false)
  }

  const custom = data?.items.filter((c) => c.source === 'custom') ?? []
  const detected = data?.items.filter((c) => c.source === 'settings.json env') ?? []

  const renderForm = (onSave: () => void, onCancel: () => void, isEdit: boolean) => (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/20 p-2">
      <Input
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        placeholder="Nome (es. RETELL_API_KEY)"
        className="h-7 text-xs font-mono"
      />
      <Input
        value={form.value}
        onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
        placeholder={isEdit ? 'Nuovo valore (vuoto = invariato)' : 'Valore del segreto'}
        className="h-7 text-xs font-mono"
        type="password"
        autoComplete="off"
      />
      <div className="flex gap-1.5">
        <Input
          value={form.project}
          onChange={(e) => setForm((f) => ({ ...f, project: e.target.value }))}
          placeholder="Progetto (es. Komanda)"
          className="h-7 text-xs"
        />
        <Input
          value={form.scope}
          onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}
          placeholder="A che serve"
          className="h-7 text-xs"
        />
      </div>
      <div className="flex items-center justify-end gap-1.5 pt-0.5">
        <Button size="sm" variant="ghost" className="h-6 text-xs gap-1" onClick={onCancel}>
          <X className="w-3 h-3" /> Annulla
        </Button>
        <Button
          size="sm"
          className="h-6 text-xs gap-1"
          onClick={onSave}
          disabled={addMut.isPending || editMut.isPending || !form.name || (!isEdit && !form.value)}
        >
          {(addMut.isPending || editMut.isPending) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          Salva
        </Button>
      </div>
    </div>
  )

  return (
    <Card className="h-full neon-card-purple">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Key className="w-4 h-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">Credenziali</h3>
          {data && (
            <span className="ml-auto text-[10px] text-muted-foreground">
              {data.stats.custom} tue · {data.stats.detected} rilevate
            </span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">Salvate sul Mac (fuori da git) · valori mascherati</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> Caricamento...
          </div>
        )}

        <div className="max-h-80 overflow-auto scrollbar-thin space-y-1.5">
          {/* Le tue credenziali (editabili) */}
          {custom.map((c) =>
            editingId === c.id ? (
              <div key={c.id}>{renderForm(() => editMut.mutate({ id: c.id!, f: form }), () => { setEditingId(null); setForm(EMPTY) }, true)}</div>
            ) : (
              <div key={c.id} className="group flex items-start gap-2 text-xs rounded-md border border-border/60 p-1.5">
                <Key className="w-3 h-3 text-emerald-500 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono truncate">{c.name}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {revealed[c.id!] !== undefined ? revealed[c.id!] : c.hint}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    {c.project && <span className="text-[9px] px-1 rounded bg-primary/10 text-primary">{c.project}</span>}
                    {c.scope && <span className="text-[9px] text-muted-foreground truncate">{c.scope}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <button className="p-1 hover:text-primary" title="Mostra/nascondi" onClick={() => toggleReveal(c.id!)}>
                    {revealed[c.id!] !== undefined ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  </button>
                  <button className="p-1 hover:text-primary" title="Copia" onClick={() => copyValue(c.id!)}>
                    {copied === c.id ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                  </button>
                  <button className="p-1 hover:text-primary" title="Modifica" onClick={() => startEdit(c)}>
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    className="p-1 hover:text-destructive"
                    title="Elimina"
                    onClick={() => { if (confirm(`Eliminare "${c.name}"?`)) delMut.mutate(c.id!) }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )
          )}

          {adding && renderForm(() => addMut.mutate(form), () => { setAdding(false); setForm(EMPTY) }, false)}

          {/* Rilevate dal sistema (read-only) */}
          {detected.length > 0 && (
            <div className="pt-1.5 mt-1.5 border-t border-border/40">
              <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-muted-foreground mb-1">
                <Lock className="w-2.5 h-2.5" /> Rilevate da settings.json (sola lettura)
              </div>
              {detected.map((c) => (
                <div key={c.name} className="flex items-center gap-2 text-xs py-0.5 opacity-70">
                  <span className="font-mono truncate flex-1">{c.name}</span>
                  <span className="text-[9px] text-muted-foreground truncate max-w-[45%]">{c.scope}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {!adding && editingId === null && (
          <Button size="sm" variant="outline" className="w-full h-7 text-xs gap-1.5" onClick={() => { setAdding(true); setForm(EMPTY) }}>
            <Plus className="w-3 h-3" /> Aggiungi credenziale
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
