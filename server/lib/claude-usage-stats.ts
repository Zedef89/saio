/**
 * Token realmente consumati da ogni account, ricavati dai transcript di Claude Code.
 *
 * L'endpoint `/api/oauth/usage` dice **quanto** della finestra e' stato bruciato (percentuali),
 * ma non quanti token sono stati usati, ne' da quale modello o su quale progetto. Quel dato
 * esiste solo nei `.jsonl` che Claude scrive dentro la cartella dell'account
 * (`<config>/projects/<slug>/<uuid>.jsonl`), riga per riga, nel campo `message.usage`.
 *
 * ⚠️ **Dedup per `message.id` obbligatorio**: Claude Code scrive una riga per ogni blocco di
 * contenuto della stessa risposta, ripetendo l'usage identico. Sommare le righe raddoppia
 * abbondantemente il totale (misurato su un transcript reale: 2.647.539 contro 1.223.049 veri).
 * Gli id ripetuti sono contigui, quindi basta ricordare la coda degli ultimi visti.
 *
 * La scansione e' **incrementale**: per ogni file si tiene (size, mtime, offset) e si rilegge
 * solo la coda cresciuta. Al primo giro ci sono centinaia di MB da digerire, percio' gira in
 * background e l'endpoint serve intanto i dati parziali.
 */
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import os from 'node:os'
import { logger } from './logger'

const HOME = process.env.HOME || os.homedir()

/** Oltre questo si buttano i giorni vecchi: la cache resta piccola e le finestre utili sono corte. */
const GIORNI_CONSERVATI = 60

/** Quanti `message.id` recenti si ricordano per file, per non ricontare le righe a cavallo di due scansioni. */
const TAIL_IDS = 64

/** Una riscansione completa non ha senso piu' spesso di cosi': i file crescono, non cambiano. */
const RESCAN_MIN_MS = 30_000

export interface TokenBucket {
  requests: number
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  thinking: number
}

export interface AccountTokenStats {
  accountId: string
  /** Da sempre, per quanto risalgono i transcript conservati. */
  total: TokenBucket
  today: TokenBucket
  last24h: TokenBucket
  last7d: TokenBucket
  last30d: TokenBucket
  /** Ultimi 7 giorni, per modello — dice dove va davvero la finestra settimanale. */
  byModel: Record<string, TokenBucket>
  /** Ultimi 7 giorni, per progetto (nome cartella). */
  byProject: Record<string, TokenBucket>
  /** Ultimi 30 giorni in ordine cronologico, per il grafico. */
  byDay: Array<{ day: string } & TokenBucket>
  firstDay: string | null
  lastDay: string | null
  files: number
}

export interface TokenStatsResult {
  accounts: Record<string, AccountTokenStats>
  /** true finche' la prima scansione (o una successiva) sta ancora girando. */
  scanning: boolean
  scannedFiles: number
  totalFiles: number
  /** Quando e' finita l'ultima scansione completa. */
  updatedAt: string | null
}

function emptyBucket(): TokenBucket {
  return { requests: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, thinking: 0 }
}

function addBucket(dst: TokenBucket, src: TokenBucket): void {
  dst.requests += src.requests
  dst.input += src.input
  dst.output += src.output
  dst.cacheCreate += src.cacheCreate
  dst.cacheRead += src.cacheRead
  dst.thinking += src.thinking
}

/**
 * Stato su disco. `days` e `projects` sono gia' aggregati: i transcript non si rileggono mai
 * due volte, nemmeno dopo un riavvio del server.
 */
interface FileState {
  size: number
  mtimeMs: number
  offset: number
  tailIds: string[]
}
interface StatsCache {
  version: number
  files: Record<string, FileState>
  /** accountId → giorno → modello → bucket */
  days: Record<string, Record<string, Record<string, TokenBucket>>>
  /** accountId → giorno → progetto → bucket */
  projects: Record<string, Record<string, Record<string, TokenBucket>>>
  updatedAt: string | null
}

const CACHE_VERSION = 1

function cacheFile(): string {
  const dataDir = process.env.DASHBOARD_DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(dataDir, 'claude-token-stats.json')
}

let cache: StatsCache | null = null
let scanning = false
let scannedFiles = 0
let totalFiles = 0
let lastScanEnd = 0

async function loadCache(): Promise<StatsCache> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFile(), 'utf-8')) as StatsCache
    if (parsed?.version === CACHE_VERSION) {
      cache = parsed
      return cache
    }
  } catch {
    /* prima volta, o cache di una versione precedente: si riparte da zero */
  }
  cache = { version: CACHE_VERSION, files: {}, days: {}, projects: {}, updatedAt: null }
  return cache
}

async function saveCache(): Promise<void> {
  if (!cache) return
  try {
    await fs.mkdir(path.dirname(cacheFile()), { recursive: true })
    await fs.writeFile(cacheFile(), JSON.stringify(cache))
  } catch (err) {
    logger.warn(`[usage-stats] cache non salvata: ${String(err).slice(0, 120)}`)
  }
}

/** `~/.claude` e ogni `~/.claude-<slot>`: stessa regola di scoperta di claude-accounts.ts. */
async function discoverAccountDirs(): Promise<Array<{ id: string; projectsDir: string }>> {
  const out = [{ id: 'default', projectsDir: path.join(HOME, '.claude', 'projects') }]
  try {
    for (const entry of await fs.readdir(HOME, { withFileTypes: true })) {
      const m = entry.isDirectory() ? /^\.claude-([a-zA-Z0-9_-]+)$/.exec(entry.name) : null
      if (m) out.push({ id: m[1], projectsDir: path.join(HOME, entry.name, 'projects') })
    }
  } catch {
    /* home illeggibile */
  }
  return out
}

/**
 * ⚠️ Su alcune macchine `~/.claude-b/projects` e' un **symlink** a quella di default: senza
 * risolvere il path reale gli stessi transcript verrebbero contati due volte, su due account
 * diversi. Stesso inciampo gia' incontrato nel worklog-analyzer.
 */
async function realDirOrNull(dir: string): Promise<string | null> {
  try {
    return await fs.realpath(dir)
  } catch {
    return null
  }
}

async function listTranscripts(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listTranscripts(full)))
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

/** Giorno secondo l'ora italiana: il server gira in UTC e a cavallo di mezzanotte sposterebbe i conti. */
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
function dayOf(iso: string): string | null {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return dayFormatter.format(new Date(t))
}

function bucketIn(
  store: Record<string, Record<string, Record<string, TokenBucket>>>,
  account: string,
  day: string,
  key: string,
): TokenBucket {
  const perAccount = (store[account] ||= {})
  const perDay = (perAccount[day] ||= {})
  return (perDay[key] ||= emptyBucket())
}

/**
 * Legge la coda di un transcript e somma l'usage nei bucket dell'account.
 * Ritorna il nuovo offset (fine dell'ultima riga completa) e la coda di id visti.
 */
async function scanFile(
  file: string,
  accountId: string,
  state: FileState,
  c: StatsCache,
): Promise<void> {
  const visti = new Set(state.tailIds)
  const coda = [...state.tailIds]
  let consumati = state.offset
  let pendenti = 0

  const stream = createReadStream(file, { start: state.offset, encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of rl) {
    // +1 per il newline: l'offset deve cadere all'inizio di una riga, altrimenti al giro dopo
    // si riparte da meta' riga e il JSON.parse fallisce su tutto il resto del file.
    pendenti = Buffer.byteLength(line, 'utf-8') + 1
    consumati += pendenti

    // Filtro a stringa prima di parsare: la maggior parte delle righe (input utente, risultati
    // tool, meta) non ha usage, e un JSON.parse su ognuna costerebbe piu' di tutto il resto.
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue

    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec?.type !== 'assistant') continue
    const msg = (rec.message ?? {}) as Record<string, unknown>
    const usage = msg.usage as Record<string, unknown> | undefined
    if (!usage) continue

    const id = (msg.id as string) || (rec.requestId as string) || ''
    if (id && visti.has(id)) continue
    if (id) {
      visti.add(id)
      coda.push(id)
      if (coda.length > TAIL_IDS) {
        const fuori = coda.shift()
        if (fuori) visti.delete(fuori)
      }
    }

    const day = dayOf(String(rec.timestamp ?? ''))
    if (!day) continue

    const model = String(msg.model ?? 'sconosciuto')
    // Le risposte sintetiche (errori, interruzioni) non consumano finestra: non vanno contate.
    if (model.startsWith('<')) continue

    const dettagli = usage.output_tokens_details as Record<string, unknown> | undefined
    const b: TokenBucket = {
      requests: 1,
      input: Number(usage.input_tokens ?? 0),
      output: Number(usage.output_tokens ?? 0),
      cacheCreate: Number(usage.cache_creation_input_tokens ?? 0),
      cacheRead: Number(usage.cache_read_input_tokens ?? 0),
      thinking: Number(dettagli?.thinking_tokens ?? 0),
    }
    addBucket(bucketIn(c.days, accountId, day, model), b)

    const cwd = String(rec.cwd ?? '')
    const progetto = cwd ? path.basename(cwd) : 'altro'
    addBucket(bucketIn(c.projects, accountId, day, progetto), b)
  }

  rl.close()
  state.offset = consumati
  state.tailIds = coda
}

/** Butta i giorni troppo vecchi: la cache non deve crescere all'infinito. */
function potaGiorniVecchi(c: StatsCache): void {
  const limite = new Date(Date.now() - GIORNI_CONSERVATI * 86_400_000)
  const soglia = dayFormatter.format(limite)
  for (const store of [c.days, c.projects]) {
    for (const perAccount of Object.values(store)) {
      for (const day of Object.keys(perAccount)) {
        if (day < soglia) delete perAccount[day]
      }
    }
  }
}

async function runScan(): Promise<void> {
  if (scanning) return
  scanning = true
  scannedFiles = 0
  totalFiles = 0
  const c = await loadCache()
  const inizio = Date.now()

  try {
    const visitati = new Set<string>()
    const lavoro: Array<{ accountId: string; file: string }> = []

    for (const acc of await discoverAccountDirs()) {
      const reale = await realDirOrNull(acc.projectsDir)
      // Symlink verso una cartella gia' vista: sono gli stessi transcript, non vanno raddoppiati.
      if (!reale || visitati.has(reale)) continue
      visitati.add(reale)
      for (const file of await listTranscripts(reale)) lavoro.push({ accountId: acc.id, file })
    }
    totalFiles = lavoro.length

    for (const { accountId, file } of lavoro) {
      scannedFiles++
      let st: import('node:fs').Stats
      try {
        st = await fs.stat(file)
      } catch {
        continue
      }
      const prev = c.files[file]
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue

      // File rimpicciolito o sostituito: l'offset vecchio non vale piu', si rilegge da capo.
      // (I bucket gia' scritti restano: si preferisce un conteggio doppio raro a uno azzerato.)
      const state: FileState =
        prev && st.size >= prev.offset ? prev : { size: 0, mtimeMs: 0, offset: 0, tailIds: [] }

      try {
        await scanFile(file, accountId, state, c)
      } catch (err) {
        logger.warn(`[usage-stats] ${path.basename(file)}: ${String(err).slice(0, 100)}`)
        continue
      }
      state.size = st.size
      state.mtimeMs = st.mtimeMs
      c.files[file] = state
    }

    // File spariti (sessioni cancellate): via dallo stato, i loro token restano negli aggregati.
    for (const known of Object.keys(c.files)) {
      if (!lavoro.some((l) => l.file === known)) delete c.files[known]
    }

    potaGiorniVecchi(c)
    c.updatedAt = new Date().toISOString()
    await saveCache()
    logger.info(
      `[usage-stats] scansione completata: ${totalFiles} file in ${Math.round((Date.now() - inizio) / 1000)}s`,
    )
  } finally {
    scanning = false
    lastScanEnd = Date.now()
  }
}

function giorniIndietro(n: number): string {
  return dayFormatter.format(new Date(Date.now() - n * 86_400_000))
}

/** Somma delle ultime `n` giornate solari (0 = solo oggi). */
function sommaGiorni(perDay: Record<string, Record<string, TokenBucket>>, da: string): TokenBucket {
  const out = emptyBucket()
  for (const [day, perModel] of Object.entries(perDay)) {
    if (day < da) continue
    for (const b of Object.values(perModel)) addBucket(out, b)
  }
  return out
}

function aggrega(c: StatsCache, accountId: string): AccountTokenStats {
  const perDay = c.days[accountId] ?? {}
  const perProject = c.projects[accountId] ?? {}
  const oggi = dayFormatter.format(new Date())
  const da7 = giorniIndietro(6)
  const da30 = giorniIndietro(29)

  const byModel: Record<string, TokenBucket> = {}
  for (const [day, perModel] of Object.entries(perDay)) {
    if (day < da7) continue
    for (const [model, b] of Object.entries(perModel)) addBucket((byModel[model] ||= emptyBucket()), b)
  }

  const byProject: Record<string, TokenBucket> = {}
  for (const [day, perProj] of Object.entries(perProject)) {
    if (day < da7) continue
    for (const [proj, b] of Object.entries(perProj)) addBucket((byProject[proj] ||= emptyBucket()), b)
  }

  const byDay: Array<{ day: string } & TokenBucket> = []
  for (const [day, perModel] of Object.entries(perDay)) {
    if (day < da30) continue
    const b = emptyBucket()
    for (const x of Object.values(perModel)) addBucket(b, x)
    byDay.push({ day, ...b })
  }
  byDay.sort((a, b) => a.day.localeCompare(b.day))

  const giorni = Object.keys(perDay).sort()
  const total = emptyBucket()
  for (const perModel of Object.values(perDay)) {
    for (const b of Object.values(perModel)) addBucket(total, b)
  }

  return {
    accountId,
    total,
    today: sommaGiorni(perDay, oggi),
    // Giornata solare di ieri+oggi: i transcript hanno il timestamp al messaggio, non serve
    // precisione al minuto per capire "quanto sto consumando adesso".
    last24h: sommaGiorni(perDay, giorniIndietro(1)),
    last7d: sommaGiorni(perDay, da7),
    last30d: sommaGiorni(perDay, da30),
    byModel,
    byProject,
    byDay,
    firstDay: giorni[0] ?? null,
    lastDay: giorni[giorni.length - 1] ?? null,
    files: Object.keys(c.files).length,
  }
}

/**
 * Statistiche correnti. Se i transcript sono cambiati avvia una scansione **in background** e
 * ritorna comunque subito quello che c'e': al primo giro ci sono centinaia di MB da leggere e
 * far aspettare la pagina non servirebbe a niente.
 */
export async function claudeTokenStats(force = false): Promise<TokenStatsResult> {
  const c = await loadCache()
  if (!scanning && (force || Date.now() - lastScanEnd > RESCAN_MIN_MS)) {
    void runScan().catch((err) => logger.warn(`[usage-stats] scansione fallita: ${String(err).slice(0, 160)}`))
  }

  const accounts: Record<string, AccountTokenStats> = {}
  for (const id of new Set([...Object.keys(c.days), ...Object.keys(c.projects)])) {
    accounts[id] = aggrega(c, id)
  }
  return { accounts, scanning, scannedFiles, totalFiles, updatedAt: c.updatedAt }
}
