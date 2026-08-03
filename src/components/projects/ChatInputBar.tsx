import { useEffect, useRef, useState } from 'react'
import {
  Send, Settings, Sparkles, Shield, Zap, ChevronDown, ChevronUp,
  Check, X, Eye, RotateCcw, Paperclip, Mic, Square, Loader2
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
export type ModelId = 'default' | 'claude-opus-4-7[1m]' | 'claude-opus-4-7' | 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001'

interface ChatInputBarProps {
  onSend: (text: string) => void
  onQuickChoice?: (choice: string) => void
  pendingChoices?: Array<{ key: string; label: string; description?: string }>
  disabled?: boolean
  model: ModelId
  permissionMode: PermissionMode
  onModelChange: (m: ModelId) => void
  onPermissionModeChange: (p: PermissionMode) => void
  onSettingsApply: () => void
  settingsDirty: boolean
  /** V14.19 — provider name for placeholders (es. "claude", "codex", "gemini"). Default "AI". */
  providerName?: string
  /** Sessione a cui appartengono gli allegati (usato come cartella in ~/SAIO-uploads/). */
  projectId?: string
}

const MODELS: Array<{ id: ModelId; label: string; hint: string }> = [
  { id: 'default', label: 'Default (CLI)', hint: "Usa il modello configurato nel CLI" },
  { id: 'claude-opus-4-7[1m]', label: 'Opus 4.7 · 1M context', hint: 'Massima intelligenza, finestra 1M token' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7 (standard)', hint: 'Massima intelligenza, 200K context' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', hint: 'Bilanciato velocità/qualità' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hint: 'Veloce ed economico' },
]

const PERMISSION_MODES: Array<{ id: PermissionMode; label: string; icon: any; hint: string }> = [
  { id: 'default', label: 'Chiedi sempre', icon: Shield, hint: 'Default: conferma ogni azione sensibile' },
  { id: 'acceptEdits', label: 'Auto-accetta edits', icon: Check, hint: 'Edit/Write approvati senza chiedere (altre azioni chiedono)' },
  { id: 'bypassPermissions', label: 'Auto-accetta tutto ⚠️', icon: Zap, hint: 'NO permission prompts — usa con cautela' },
  { id: 'plan', label: 'Plan mode', icon: Eye, hint: 'Solo plan, niente esecuzione' },
]

export function ChatInputBar({
  onSend,
  onQuickChoice,
  pendingChoices = [],
  disabled,
  model,
  permissionMode,
  onModelChange,
  onPermissionModeChange,
  onSettingsApply,
  settingsDirty,
  providerName = 'AI',
  projectId = 'sessione',
}: ChatInputBarProps) {
  const [value, setValue] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Focus automatico sul campo appena la sessione è pronta o cambi sessione: così scrivi
  // subito senza dover cliccare dentro. Solo su desktop — su mobile aprirebbe la tastiera
  // a sproposito coprendo il terminale.
  useEffect(() => {
    if (disabled) return
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) return
    const t = setTimeout(() => textareaRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [disabled, projectId])

  // --- Allegati e audio -------------------------------------------------
  // SAIO non trascrive né analizza: carica il file sul Mac e inietta il PATH nel
  // prompt. Da lì ci pensa Claude (immagini/PDF letti da path, audio via Groq).
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recSeconds, setRecSeconds] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /** Aggiunge i path caricati in coda al testo, uno per riga. */
  const appendPaths = (paths: string[]) => {
    if (paths.length === 0) return
    setValue((v) => (v ? `${v.replace(/\s*$/, '')}\n${paths.join('\n')}\n` : `${paths.join('\n')}\n`))
    textareaRef.current?.focus()
  }

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return
    setUploading(true)
    try {
      const fd = new FormData()
      for (const f of files) fd.append('files', f)
      const res = await fetch(`/api/uploads/${encodeURIComponent(projectId)}`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || data.error || 'upload fallito')
      const paths = (data.files || []).map((f: { path: string }) => f.path)
      appendPaths(paths)
      toast.success(
        paths.length === 1 ? 'File caricato' : `${paths.length} file caricati`,
        { description: 'Path inserito nel messaggio: scrivi cosa farci e invia.' }
      )
    } catch (err) {
      toast.error('Caricamento fallito', { description: (err as Error).message })
    } finally {
      setUploading(false)
    }
  }

  const stopRecording = () => {
    recorderRef.current?.stop()
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
  }

  const startRecording = async () => {
    if (recording) return stopRecording()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // webm/opus è ciò che supportano Chromium e la webview di macOS; Groq lo accetta
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setRecording(false)
        setRecSeconds(0)
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        if (blob.size < 1000) {
          toast.error('Registrazione troppo breve')
          return
        }
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        await uploadFiles([new File([blob], `nota-vocale-${ts}.webm`, { type: blob.type })])
      }
      rec.start()
      recorderRef.current = rec
      setRecording(true)
      setRecSeconds(0)
      timerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000)
    } catch (err) {
      toast.error('Microfono non disponibile', {
        description: (err as Error).message || 'Consenti l\'accesso al microfono nelle impostazioni di sistema.',
      })
    }
  }

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current) }, [])

  // File trascinati sul terminale (desktop): EmbeddedChat cattura il drop via Tauri e
  // ci passa i PATH già locali con un CustomEvent. Nessun upload: il file è già su disco.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { projectId?: string; paths?: string[] }
      if (detail?.projectId !== projectId || !Array.isArray(detail.paths) || detail.paths.length === 0) return
      appendPaths(detail.paths)
      toast.success(
        detail.paths.length === 1 ? 'File allegato' : `${detail.paths.length} file allegati`,
        { description: 'Path inserito nel messaggio: scrivi cosa farci e invia.' }
      )
    }
    window.addEventListener('saio-attach-paths', handler)
    return () => window.removeEventListener('saio-attach-paths', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(200, ta.scrollHeight) + 'px'
  }, [value])

  // Su schermi stretti il placeholder lungo sforava il campo: se ne usa uno corto.
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const handleSend = () => {
    if (!value.trim() || disabled) return
    onSend(value)
    setValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSend()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="border-t border-border bg-card/60 backdrop-blur-sm">
      {/* Settings bar — collapsible */}
      {settingsOpen && (
        <div className="p-3 border-b border-border/50 bg-muted/20 space-y-2 animate-fade-in">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                <Sparkles className="w-2.5 h-2.5" />
                Modello
              </label>
              <Select value={model} onValueChange={(v) => onModelChange(v as ModelId)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      <div>
                        <div className="font-medium">{m.label}</div>
                        <div className="text-[10px] text-muted-foreground">{m.hint}</div>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                <Shield className="w-2.5 h-2.5" />
                Permessi azioni
              </label>
              <Select value={permissionMode} onValueChange={(v) => onPermissionModeChange(v as PermissionMode)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSION_MODES.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      <div>
                        <div className="font-medium">{m.label}</div>
                        <div className="text-[10px] text-muted-foreground">{m.hint}</div>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {settingsDirty && (
            <div className="flex items-center justify-between gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 px-2 py-1.5">
              <span className="text-[11px] text-amber-300">
                Per applicare le modifiche serve riavviare la sessione Claude
              </span>
              <Button size="sm" variant="outline" className="h-6 text-xs gap-1" onClick={onSettingsApply}>
                <RotateCcw className="w-3 h-3" /> Riavvia sessione
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Quick choices for permission prompts */}
      {pendingChoices.length > 0 && (
        <div className="px-3 py-2 border-b border-amber-500/20 bg-amber-500/5 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-amber-400 font-semibold">{providerName} aspetta una scelta:</span>
          {pendingChoices.map((c) => (
            <Button
              key={c.key}
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 border-amber-500/40 hover:bg-amber-500/10"
              onClick={() => onQuickChoice?.(c.key)}
              title={c.description}
            >
              {c.label}
            </Button>
          ))}
        </div>
      )}

      {/* Main input area */}
      <div className="p-3 flex items-end gap-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className={cn('h-9 w-9 shrink-0', settingsOpen && 'bg-accent text-accent-foreground')}
                onClick={() => setSettingsOpen((v) => !v)}
              >
                <Settings className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <span className="text-xs">Impostazioni modello, permessi</span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Allega file (foto, PDF, documenti, audio già registrati) */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files || [])
            e.target.value = '' // permette di ricaricare lo stesso file
            void uploadFiles(files)
          }}
        />
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-9 w-9 shrink-0"
                disabled={disabled || uploading || recording}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <span className="text-xs">Allega foto, PDF o documenti — il path finisce nel messaggio</span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Nota vocale: registra e carica il file, la trascrizione la fa Claude */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant={recording ? 'destructive' : 'ghost'}
                className={cn('h-9 shrink-0', recording ? 'w-auto px-2 gap-1.5' : 'w-9')}
                disabled={disabled || uploading}
                onClick={() => void startRecording()}
              >
                {recording ? (
                  <>
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span className="text-xs font-mono tabular-nums">
                      {String(Math.floor(recSeconds / 60)).padStart(2, '0')}:
                      {String(recSeconds % 60).padStart(2, '0')}
                    </span>
                  </>
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <span className="text-xs">
                {recording ? 'Ferma e carica la nota vocale' : 'Registra una nota vocale'}
              </span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled
              ? 'Chat non disponibile...'
              : isNarrow
                ? `Scrivi a ${providerName}…`
                : `Scrivi a ${providerName} · Enter per inviare · Shift+Enter per nuova riga`
          }
          className="resize-none min-h-[40px] max-h-[200px] text-sm"
          disabled={disabled}
          rows={1}
        />

        <Button
          size="icon"
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="h-9 w-9 shrink-0"
        >
          <Send className="w-4 h-4" />
        </Button>
      </div>

      {/* Status line */}
      <div className="px-3 pb-2 flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
        <span className="flex items-center gap-1">
          <Sparkles className="w-2.5 h-2.5" />
          {MODELS.find((m) => m.id === model)?.label || model}
        </span>
        <span className="flex items-center gap-1">
          <Shield className="w-2.5 h-2.5" />
          {PERMISSION_MODES.find((m) => m.id === permissionMode)?.label || permissionMode}
        </span>
        <span className="ml-auto">Ctrl+Enter o Enter per inviare</span>
      </div>
    </div>
  )
}
