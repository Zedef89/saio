/**
 * Utilizzo — quanto resta a ogni account Claude e quanto ha davvero consumato.
 *
 * Due sorgenti diverse, tenute distinte apposta perche' rispondono a due domande diverse:
 * - le **percentuali** vengono da Anthropic (`/api/oauth/usage`) e dicono quanto della finestra
 *   e' bruciato — e' il numero che decide se puoi ancora lavorare con quell'account;
 * - i **token** vengono dai transcript sul disco e dicono dove sono finiti: quale modello, quale
 *   progetto, quale giorno. Anthropic non li espone.
 */
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { RefreshCw, Loader2, AlertTriangle, Clock, CalendarDays, Cpu, FolderGit2, Info } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface TokenBucket {
  requests: number
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  thinking: number
}
interface AccountTokens {
  total: TokenBucket
  today: TokenBucket
  last24h: TokenBucket
  last7d: TokenBucket
  last30d: TokenBucket
  byModel: Record<string, TokenBucket>
  byProject: Record<string, TokenBucket>
  byDay: Array<{ day: string } & TokenBucket>
  firstDay: string | null
  lastDay: string | null
}
interface UsageWindow {
  percent: number
  resetsAt: string | null
  limitDollars: number | null
  usedDollars: number | null
  remainingDollars: number | null
}
interface AccountRow {
  id: string
  label: string
  email: string | null
  plan: string | null
  isDefault: boolean
  error: string | null
  stale?: boolean
  staleMinutes?: number
  usage: {
    weeklyPercent: number
    sessionPercent: number
    weeklyResetsAt: string | null
    severity: 'normal' | 'warning' | 'critical'
    detail?: {
      fiveHour: UsageWindow | null
      sevenDay: UsageWindow | null
      perModel: Array<{ nome: string } & UsageWindow>
      limits: Array<{
        kind: string
        group: string
        percent: number
        severity: string
        resetsAt: string | null
        scope: string | null
        isActive: boolean
      }>
      extra: {
        enabled: boolean
        usedCredits: number | null
        monthlyLimit: number | null
        utilization: number | null
        currency: string | null
        disabledReason: string | null
      } | null
      spend: { usedMinor: number | null; currency: string | null; exponent: number | null; percent: number | null; enabled: boolean } | null
    } | null
  } | null
  tokens: AccountTokens | null
}
interface Overview {
  accounts: AccountRow[]
  scan: { scanning: boolean; scannedFiles: number; totalFiles: number; updatedAt: string | null }
}

const nf = new Intl.NumberFormat('it-IT')

/** Numeri grandi accorciati: 6.752.509 → "6,75 M". Nelle tabelle serve leggere, non contare. */
function compatto(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2).replace('.', ',')} G`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace('.', ',')} M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace('.', ',')} k`
  return nf.format(n)
}

/** "fra 2h 14m" — quanto manca al reset, che e' l'unica cosa che interessa di quella data. */
function fraQuanto(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.parse(iso) - Date.now()
  if (Number.isNaN(ms)) return '—'
  if (ms <= 0) return 'a momenti'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `fra ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `fra ${h}h ${min % 60}m`
  const g = Math.floor(h / 24)
  return `fra ${g}g ${h % 24}h`
}

// Il server gira in UTC: senza fuso esplicito l'orario mostrato sarebbe indietro di due ore.
function oraLocale(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('it-IT', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Rome',
  })
}

function tonoDi(percent: number): { barra: string; testo: string; badge: string } {
  if (percent >= 95) return { barra: 'bg-red-500', testo: 'text-red-500', badge: 'border-red-500/30 bg-red-500/10 text-red-500' }
  if (percent >= 75) return { barra: 'bg-amber-500', testo: 'text-amber-500', badge: 'border-amber-500/30 bg-amber-500/10 text-amber-500' }
  return { barra: 'bg-emerald-500', testo: 'text-emerald-500', badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' }
}

/** Nome modello leggibile: `claude-haiku-4-5-20251001` → "Haiku 4.5". */
function nomeModello(id: string): string {
  const m = /^claude-([a-z]+)-?(\d+)?-?(\d+)?/.exec(id)
  if (!m) return id
  const famiglia = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  const versione = [m[2], m[3]].filter(Boolean).join('.')
  return versione ? `${famiglia} ${versione}` : famiglia
}

function BarraFinestra({
  icona,
  titolo,
  percent,
  resetsAt,
  nota,
}: {
  icona: React.ReactNode
  titolo: string
  percent: number
  resetsAt: string | null
  nota?: string
}) {
  const tono = tonoDi(percent)
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {icona}
          {titolo}
        </span>
        <span className={cn('text-sm font-semibold tabular-nums', tono.testo)}>
          {Math.round(percent)}% <span className="text-xs font-normal text-muted-foreground">usato</span>
        </span>
      </div>
      {/* Barra a mano invece del componente Progress: il colore dell'indicatore deve cambiare
          con la soglia, e Progress non lo espone — modificarlo toccherebbe tutte le altre pagine. */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div className={cn('h-full rounded-full transition-all', tono.barra)} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{nota ?? `resta ${Math.max(0, 100 - Math.round(percent))}%`}</span>
        <span title={oraLocale(resetsAt)}>si azzera {fraQuanto(resetsAt)}</span>
      </div>
    </div>
  )
}

/** Barre orizzontali proporzionali: dice a colpo d'occhio chi si mangia la finestra. */
function Ripartizione({
  titolo,
  icona,
  voci,
  etichetta = (k: string) => k,
}: {
  titolo: string
  icona: React.ReactNode
  voci: Array<[string, TokenBucket]>
  etichetta?: (k: string) => string
}) {
  const ordinate = [...voci].sort((a, b) => b[1].output - a[1].output).slice(0, 5)
  const max = ordinate[0]?.[1].output ?? 0
  if (!ordinate.length || max === 0) return null
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icona}
        {titolo}
      </div>
      <div className="space-y-1.5">
        {ordinate.map(([chiave, b]) => (
          <div key={chiave} className="space-y-0.5">
            <div className="flex justify-between gap-2 text-[11px]">
              <span className="truncate text-foreground/80">{etichetta(chiave)}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{compatto(b.output)}</span>
            </div>
            <div className="h-1 rounded-full bg-muted">
              <div className="h-1 rounded-full bg-primary/60" style={{ width: `${(b.output / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Ultimi 30 giorni. Una barra per giorno: serve a vedere il ritmo, non i valori esatti. */
function Andamento({ giorni }: { giorni: AccountTokens['byDay'] }) {
  if (!giorni.length) return null
  const max = Math.max(...giorni.map((g) => g.output), 1)
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">Ultimi 30 giorni (token in uscita)</div>
      <TooltipProvider>
        <div className="flex h-12 items-end gap-[2px]">
          {giorni.map((g) => (
            <Tooltip key={g.day}>
              <TooltipTrigger asChild>
                <div
                  className="min-w-[3px] flex-1 rounded-sm bg-primary/50 transition-colors hover:bg-primary"
                  style={{ height: `${Math.max(4, (g.output / max) * 100)}%` }}
                />
              </TooltipTrigger>
              <TooltipContent>
                <div className="text-xs">
                  <div className="font-medium">{g.day}</div>
                  <div>{nf.format(g.output)} token · {nf.format(g.requests)} richieste</div>
                </div>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
    </div>
  )
}

function Cifra({ etichetta, valore, sotto }: { etichetta: string; valore: string; sotto?: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{etichetta}</div>
      <div className="text-sm font-semibold tabular-nums">{valore}</div>
      {sotto && <div className="text-[10px] text-muted-foreground">{sotto}</div>}
    </div>
  )
}

function SchedaAccount({ a }: { a: AccountRow }) {
  const d = a.usage?.detail
  const t = a.tokens
  const tono = tonoDi(a.usage?.weeklyPercent ?? 0)

  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">{a.label}</span>
              {a.plan && <Badge variant="outline" className="shrink-0 text-[10px]">{a.plan}</Badge>}
              {a.isDefault && <Badge variant="secondary" className="shrink-0 text-[10px]">default</Badge>}
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">slot {a.id}</Badge>
            </div>
            <div className="truncate text-xs text-muted-foreground">{a.email ?? 'account non identificato'}</div>
          </div>
          {a.usage && (
            <Badge variant="outline" className={cn('shrink-0', tono.badge)}>
              {Math.max(0, 100 - Math.round(a.usage.weeklyPercent))}% settimana disponibile
            </Badge>
          )}
        </div>

        {a.error && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{a.error}</span>
          </div>
        )}
        {a.stale && (
          <div className="text-[11px] text-muted-foreground">
            Percentuali dell&apos;ultima lettura riuscita, {a.staleMinutes} min fa.
          </div>
        )}

        {a.usage && (
          <div className="grid gap-3 sm:grid-cols-2">
            <BarraFinestra
              icona={<Clock className="h-3.5 w-3.5" />}
              titolo="Finestra 5 ore"
              percent={d?.fiveHour?.percent ?? a.usage.sessionPercent}
              resetsAt={d?.fiveHour?.resetsAt ?? null}
            />
            <BarraFinestra
              icona={<CalendarDays className="h-3.5 w-3.5" />}
              titolo="Finestra 7 giorni"
              percent={d?.sevenDay?.percent ?? a.usage.weeklyPercent}
              resetsAt={d?.sevenDay?.resetsAt ?? a.usage.weeklyResetsAt}
            />
          </div>
        )}

        {/* Limiti per modello: esistono solo su certi piani, quindi compaiono solo quando ci sono. */}
        {d?.perModel?.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {d.perModel.map((w) => (
              <BarraFinestra
                key={w.nome}
                icona={<Cpu className="h-3.5 w-3.5" />}
                titolo={`7 giorni · ${w.nome}`}
                percent={w.percent}
                resetsAt={w.resetsAt}
              />
            ))}
          </div>
        ) : null}

        {t && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Cifra etichetta="Uscita 7g" valore={compatto(t.last7d.output)} sotto={`${nf.format(t.last7d.requests)} richieste`} />
              <Cifra etichetta="Oggi" valore={compatto(t.today.output)} sotto={`${nf.format(t.today.requests)} richieste`} />
              <Cifra etichetta="Cache letta 7g" valore={compatto(t.last7d.cacheRead)} sotto="riuso del contesto" />
              <Cifra etichetta="Cache scritta 7g" valore={compatto(t.last7d.cacheCreate)} sotto={`ingresso ${compatto(t.last7d.input)}`} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Ripartizione
                titolo="Per modello (7 giorni)"
                icona={<Cpu className="h-3.5 w-3.5" />}
                voci={Object.entries(t.byModel)}
                etichetta={nomeModello}
              />
              <Ripartizione
                titolo="Per progetto (7 giorni)"
                icona={<FolderGit2 className="h-3.5 w-3.5" />}
                voci={Object.entries(t.byProject)}
              />
            </div>

            <Andamento giorni={t.byDay} />
          </>
        )}

        {/* Crediti a consumo: si mostrano solo se l'account li ha mai avuti, altrimenti sono rumore. */}
        {d?.extra?.enabled || (d?.spend?.enabled && d.spend.usedMinor) ? (
          <div className="rounded-lg border bg-muted/30 p-2 text-xs">
            <div className="font-medium">Crediti extra</div>
            <div className="text-muted-foreground">
              {d.extra?.usedCredits != null && `usati ${d.extra.usedCredits} ${d.extra.currency ?? ''}`}
              {d.spend?.usedMinor != null &&
                d.spend.exponent != null &&
                ` · spesa ${(d.spend.usedMinor / 10 ** d.spend.exponent).toFixed(2)} ${d.spend.currency ?? ''}`}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function UsagePage() {
  const [refreshing, setRefreshing] = useState(false)

  const { data, isLoading, refetch } = useQuery<Overview>({
    queryKey: ['usage-overview'],
    queryFn: async () => {
      const res = await fetch('/api/system/usage-overview', { credentials: 'include' })
      if (!res.ok) throw new Error('lettura non riuscita')
      return res.json()
    },
    // Le percentuali hanno comunque una cache di 5 minuti lato server (l'endpoint di Anthropic
    // limita per IP): interrogare piu' spesso non darebbe dati piu' freschi, solo 429.
    refetchInterval: (q) => (q.state.data?.scan.scanning ? 4000 : 60_000),
  })

  async function aggiorna() {
    setRefreshing(true)
    try {
      await fetch('/api/system/usage-overview?refresh=1&rescan=1', { credentials: 'include' })
      await refetch()
    } finally {
      setRefreshing(false)
    }
  }

  const accounts = data?.accounts ?? []
  const totale7g = accounts.reduce((s, a) => s + (a.tokens?.last7d.output ?? 0), 0)
  const richieste7g = accounts.reduce((s, a) => s + (a.tokens?.last7d.requests ?? 0), 0)
  const liberi = accounts.filter((a) => (a.usage?.weeklyPercent ?? 100) < 75).length

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Utilizzo</h1>
          <p className="text-sm text-muted-foreground">
            Finestre, limiti e token consumati da ogni account Claude della macchina.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={aggiorna} disabled={refreshing}>
          {refreshing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
          Aggiorna
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Cifra etichetta="Account" valore={String(accounts.length)} sotto={`${liberi} sotto il 75%`} />
        <Cifra etichetta="Token in uscita 7g" valore={compatto(totale7g)} sotto="tutti gli account" />
        <Cifra etichetta="Richieste 7g" valore={nf.format(richieste7g)} />
        <Cifra
          etichetta="Transcript"
          valore={data?.scan.scanning ? `${data.scan.scannedFiles}/${data.scan.totalFiles}` : String(data?.scan.totalFiles ?? 0)}
          sotto={data?.scan.scanning ? 'scansione in corso…' : 'file letti'}
        />
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Lettura in corso…
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {accounts.map((a) => (
            <SchedaAccount key={a.id} a={a} />
          ))}
        </div>
      )}

      <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="space-y-1">
          <p>
            Le <strong>percentuali</strong> arrivano da Anthropic e sono la fonte di verita&apos; su quanto puoi
            ancora lavorare; si aggiornano al massimo ogni 5 minuti perche&apos; quell&apos;endpoint limita le
            letture per indirizzo IP, non per account.
          </p>
          <p>
            I <strong>token</strong> sono contati dai transcript sul disco: Anthropic non li espone. Sono
            attribuiti all&apos;account nella cui cartella il transcript si trova <em>adesso</em> — se una sessione
            e&apos; stata spostata da un account all&apos;altro, la sua storia si sposta con lei.
          </p>
        </div>
      </div>
    </div>
  )
}
