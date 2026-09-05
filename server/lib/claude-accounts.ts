/**
 * Account Claude Code disponibili sul server e quanto ne resta della finestra token.
 *
 * Piu' abbonamenti convivono grazie a `CLAUDE_CONFIG_DIR`: la config di default
 * (`~/.claude`, comando `claude`) e una `~/.claude-<slot>` per ognuno degli altri
 * (`~/.claude-b` col comando `claude-b`, `~/.claude-c` con `claude-c`, ...).
 * Ognuna ha il suo `.credentials.json`, quindi restano loggate entrambe insieme.
 *
 * L'utilizzo arriva da `/api/oauth/usage` — lo stesso endpoint che alimenta `/usage`
 * dentro la TUI di Claude Code — interrogato col token OAuth dell'account.
 * Il token NON esce mai da qui: verso il frontend vanno solo le percentuali.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { logger } from './logger'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const FETCH_TIMEOUT_MS = 5000
/**
 * Quanto vale una lettura prima di rifarla. Era un minuto, ma la lista sessioni interroga gli
 * account a ogni giro e la pagina si aggiorna ogni 5 secondi: significavano ~4 richieste al
 * minuto all'endpoint usage, cioe' migliaia al giorno — e infatti rispondeva 429 proprio
 * quando serviva scegliere l'account. La finestra token si muove di poco: cinque minuti di
 * ritardo non cambiano nessuna decisione, e il pulsante "aggiorna" forza comunque la lettura.
 */
const CACHE_TTL_MS = 5 * 60_000

/**
 * Dopo un 429 l'endpoint usage resta muto per un po': continuare a bussare lo tiene muto e
 * basta. Per questa finestra si serve l'ultimo dato salvato senza nemmeno provare.
 *
 * L'attesa cresce a ogni rifiuto consecutivo e si azzera alla prima lettura riuscita: quando il
 * limite e' passeggero si torna subito ai dati freschi, quando e' serio si smette davvero di
 * insistere.
 */
const BACKOFF_STEPS_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000, 20 * 60_000]

/** Un dato vecchio piu' di cosi' non dice piu' niente di utile: meglio dichiararlo assente. */
const STALE_MAX_MS = 6 * 60 * 60_000

/** Pausa fra un account e l'altro: quattro chiamate in parallelo sono il modo piu' rapido per farsi limitare. */
const SPACING_MS = 250

/**
 * Ultimo utilizzo noto per account, su disco.
 *
 * Senza, un 429 (o un timeout) cancellava del tutto la percentuale e la schermata "scegli
 * l'account" diventava una lista di `HTTP 429`: impossibile capire quale account fosse libero,
 * che e' l'unica cosa che quella schermata deve dire. Un dato di venti minuti fa e' impreciso;
 * nessun dato e' inutilizzabile.
 */
interface UsageSnapshot {
  usage: ClaudeAccountUsage
  at: number
}

function usageCacheFile(): string {
  const dataDir = process.env.DASHBOARD_DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(dataDir, 'claude-usage-cache.json')
}

let snapshots: Record<string, UsageSnapshot> | null = null
/**
 * Quando ha senso ritentare. E' UNO per tutti, non per account: il 429 di questo endpoint
 * arriva dall'IP della macchina, non dall'abbonamento — verificato interrogandolo a mano con i
 * token dei quattro account, che rispondono 429 tutti insieme. Ritentare con l'account
 * successivo non aggira niente: allunga soltanto il periodo di punizione.
 */
let retryAfterAll = 0
/** Quanti 429 di fila: sceglie quanto aspettare fra i BACKOFF_STEPS_MS. */
let rifiutiConsecutivi = 0

async function loadSnapshots(): Promise<Record<string, UsageSnapshot>> {
  if (snapshots) return snapshots
  try {
    snapshots = JSON.parse(await fs.readFile(usageCacheFile(), 'utf8')) as Record<string, UsageSnapshot>
  } catch {
    snapshots = {}
  }
  return snapshots
}

async function saveSnapshot(id: string, usage: ClaudeAccountUsage): Promise<void> {
  const all = await loadSnapshots()
  all[id] = { usage, at: Date.now() }
  try {
    await fs.mkdir(path.dirname(usageCacheFile()), { recursive: true })
    await fs.writeFile(usageCacheFile(), JSON.stringify(all, null, 2))
  } catch (err) {
    logger.warn(`[claude-accounts] cache usage non salvata: ${String(err).slice(0, 120)}`)
  }
}

/** Etichette corte per gli account noti; per gli altri si usa la parte prima della @. */
const LABEL_ALIASES: Record<string, string> = {
  'fyroadv@gmail.com': 'fyro',
  'tech@komandaprint.it': 'tech',
  'alessandro.pisano.eth@gmail.com': 'ale',
}

/** Una delle finestre che Anthropic espone: le 5 ore, i 7 giorni, i 7 giorni di un singolo modello. */
export interface ClaudeUsageWindow {
  percent: number
  resetsAt: string | null
  /** Presenti solo sui piani a budget: sugli abbonamenti Max restano null. */
  limitDollars: number | null
  usedDollars: number | null
  remainingDollars: number | null
}

/**
 * Il resto di quel che dice `/api/oauth/usage` e che le card sessione non usano.
 * Viaggia insieme alle percentuali perche' arriva dalla **stessa** risposta: la pagina Utilizzo
 * non deve interrogare l'endpoint per conto suo, o si torna dritti al 429 per IP.
 */
export interface ClaudeUsageDetail {
  fiveHour: ClaudeUsageWindow | null
  sevenDay: ClaudeUsageWindow | null
  /** Finestre per modello, quando il piano ne ha (`seven_day_opus`, `seven_day_sonnet`, ...). */
  perModel: Array<{ nome: string } & ClaudeUsageWindow>
  /** Elenco grezzo dei limiti, con la severita' gia' decisa da Anthropic. */
  limits: Array<{
    kind: string
    group: string
    percent: number
    severity: 'normal' | 'warning' | 'critical'
    resetsAt: string | null
    scope: string | null
    isActive: boolean
  }>
  /** Crediti extra a consumo, se l'account li ha attivi. */
  extra: {
    enabled: boolean
    usedCredits: number | null
    monthlyLimit: number | null
    utilization: number | null
    currency: string | null
    disabledReason: string | null
  } | null
  /** Spesa a consumo gia' maturata (minor units: 150 = 1,50). */
  spend: {
    usedMinor: number | null
    currency: string | null
    exponent: number | null
    percent: number | null
    enabled: boolean
  } | null
}

export interface ClaudeAccountUsage {
  weeklyPercent: number
  sessionPercent: number
  weeklyResetsAt: string | null
  severity: 'normal' | 'warning' | 'critical'
  /** Tutto il resto della risposta, per la pagina Utilizzo. Opzionale: gli snapshot vecchi non ce l'hanno. */
  detail?: ClaudeUsageDetail | null
}

export interface ClaudeAccount {
  id: string
  label: string
  email: string | null
  isDefault: boolean
  /** Abbonamento leggibile ("Max 20x", "Pro"), dedotto dalle credenziali. */
  plan: string | null
  usage: ClaudeAccountUsage | null
  /** Perché l'usage manca (token assente/scaduto, rete…). Mai il token. */
  error: string | null
  /** true quando la percentuale non è appena letta ma ripescata dall'ultima lettura riuscita. */
  stale?: boolean
  /** Da quanti minuti risale il dato mostrato, quando è `stale`. */
  staleMinutes?: number
}

interface AccountSlot {
  id: string
  configDir: string
  isDefault: boolean
}

const HOME = process.env.HOME || os.homedir()

/**
 * `~/.claude` (default) + ogni `~/.claude-<slot>` che esiste davvero: lo slot e' il
 * suffisso, quindi un account nuovo si aggiunge creando la cartella e facendo il login,
 * senza toccare questo file.
 */
async function discoverSlots(): Promise<AccountSlot[]> {
  const slots: AccountSlot[] = [{ id: 'default', configDir: path.join(HOME, '.claude'), isDefault: true }]
  try {
    const entries = await fs.readdir(HOME, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Solo cartelle: in home ci sono anche `.claude.json` e i suoi backup. Un symlink a
      // una cartella conta come cartella — `isDirectory()` su una dirent e' falso per i
      // symlink, e da quando le config vivono in `/srv/taskless/account-claude` (con un
      // symlink da `/root`) quel controllo da solo faceva sparire quattro account su cinque.
      const nome = /^\.claude-([a-zA-Z0-9_-]+)$/.exec(entry.name)
      let match: RegExpExecArray | null = null
      if (nome) {
        if (entry.isDirectory()) match = nome
        else if (entry.isSymbolicLink()) {
          try {
            match = (await fs.stat(path.join(HOME, entry.name))).isDirectory() ? nome : null
          } catch {
            match = null
          }
        }
      }
      if (match) slots.push({ id: match[1], configDir: path.join(HOME, entry.name), isDefault: false })
    }
  } catch {
    /* home illeggibile: si va avanti col solo account di default */
  }
  return slots
}

/**
 * Il `.claude.json` della config di default vive nella home, non dentro `~/.claude`;
 * le config alternative invece lo tengono al proprio interno.
 */
function claudeJsonPath(slot: AccountSlot): string {
  return slot.isDefault ? path.join(HOME, '.claude.json') : path.join(slot.configDir, '.claude.json')
}

async function readEmail(slot: AccountSlot): Promise<string | null> {
  try {
    const raw = await fs.readFile(claudeJsonPath(slot), 'utf-8')
    const email = JSON.parse(raw)?.oauthAccount?.emailAddress
    return typeof email === 'string' ? email : null
  } catch {
    return null
  }
}

async function readAccessToken(slot: AccountSlot): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(slot.configDir, '.credentials.json'), 'utf-8')
    const token = JSON.parse(raw)?.claudeAiOauth?.accessToken
    return typeof token === 'string' && token ? token : null
  } catch {
    return null
  }
}

/**
 * Che abbonamento e'. Sta nelle stesse credenziali del token: `subscriptionType` dice la famiglia
 * ("max", "pro") e `rateLimitTier` la taglia — che e' l'informazione che conta davvero, perche' un
 * Max 5x e un Max 20x hanno finestre molto diverse a parita' di percentuale mostrata.
 */
async function readPlan(slot: AccountSlot): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(slot.configDir, '.credentials.json'), 'utf-8')
    const oauth = JSON.parse(raw)?.claudeAiOauth ?? {}
    const tier = String(oauth.rateLimitTier ?? '')
    if (/max_20x/.test(tier)) return 'Max 20x'
    if (/max_5x/.test(tier)) return 'Max 5x'
    if (/pro/.test(tier)) return 'Pro'
    const tipo = oauth.subscriptionType
    return typeof tipo === 'string' && tipo ? tipo.charAt(0).toUpperCase() + tipo.slice(1) : null
  } catch {
    return null
  }
}

function labelFor(email: string | null, slot: AccountSlot): string {
  if (!email) return slot.isDefault ? 'default' : slot.id
  return LABEL_ALIASES[email] || email.split('@')[0]
}

function severityOf(percent: number): ClaudeAccountUsage['severity'] {
  if (percent >= 95) return 'critical'
  if (percent >= 75) return 'warning'
  return 'normal'
}

/** Una finestra della risposta usage; `null` quando il piano non ha quel limite. */
function finestra(raw: unknown): ClaudeUsageWindow | null {
  const w = raw as Record<string, unknown> | null | undefined
  if (!w || typeof w !== 'object') return null
  return {
    percent: Number(w.utilization ?? 0),
    resetsAt: (w.resets_at as string) ?? null,
    limitDollars: w.limit_dollars == null ? null : Number(w.limit_dollars),
    usedDollars: w.used_dollars == null ? null : Number(w.used_dollars),
    remainingDollars: w.remaining_dollars == null ? null : Number(w.remaining_dollars),
  }
}

/**
 * Le finestre per modello non hanno un elenco: sono chiavi `seven_day_<qualcosa>` che compaiono
 * solo se il piano le prevede. Si scorrono per prefisso invece di inchiodare i nomi, cosi' un
 * limite nuovo introdotto da Anthropic si vede senza toccare il codice.
 */
function estraiDettaglio(data: Record<string, unknown>): ClaudeUsageDetail {
  const perModel: ClaudeUsageDetail['perModel'] = []
  for (const [chiave, valore] of Object.entries(data ?? {})) {
    if (!chiave.startsWith('seven_day_') || !valore) continue
    const w = finestra(valore)
    if (!w) continue
    const nome = chiave.slice('seven_day_'.length).replace(/_/g, ' ')
    perModel.push({ nome, ...w })
  }

  const limits = Array.isArray(data?.limits)
    ? (data.limits as Array<Record<string, unknown>>).map((l) => ({
        kind: String(l?.kind ?? ''),
        group: String(l?.group ?? ''),
        percent: Number(l?.percent ?? 0),
        severity: (l?.severity as 'normal' | 'warning' | 'critical') ?? 'normal',
        resetsAt: (l?.resets_at as string) ?? null,
        scope:
          ((l?.scope as Record<string, Record<string, string>> | null)?.model?.display_name as string) ?? null,
        isActive: Boolean(l?.is_active),
      }))
    : []

  const ex = data?.extra_usage as Record<string, unknown> | null | undefined
  const sp = data?.spend as Record<string, unknown> | null | undefined
  const used = sp?.used as Record<string, unknown> | undefined

  return {
    fiveHour: finestra(data?.five_hour),
    sevenDay: finestra(data?.seven_day),
    perModel,
    limits,
    extra: ex
      ? {
          enabled: Boolean(ex.is_enabled),
          usedCredits: ex.used_credits == null ? null : Number(ex.used_credits),
          monthlyLimit: ex.monthly_limit == null ? null : Number(ex.monthly_limit),
          utilization: ex.utilization == null ? null : Number(ex.utilization),
          currency: (ex.currency as string) ?? null,
          disabledReason: (ex.disabled_reason as string) ?? null,
        }
      : null,
    spend: sp
      ? {
          usedMinor: used?.amount_minor == null ? null : Number(used.amount_minor),
          currency: (used?.currency as string) ?? null,
          exponent: used?.exponent == null ? null : Number(used.exponent),
          percent: sp.percent == null ? null : Number(sp.percent),
          enabled: Boolean(sp.enabled),
        }
      : null,
  }
}

async function fetchUsage(token: string): Promise<ClaudeAccountUsage> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new Error(res.status === 401 ? 'token scaduto — riapri una sessione con questo account' : `HTTP ${res.status}`)
    }
    const data = await res.json()
    const weekly = Number(data?.seven_day?.utilization ?? 0)
    // `limits` porta la severità già calcolata lato server: se c'è, vince sulla soglia locale.
    const weeklyLimit = Array.isArray(data?.limits)
      ? data.limits.find((l: { kind?: string }) => l?.kind === 'weekly_all')
      : null
    return {
      weeklyPercent: weekly,
      sessionPercent: Number(data?.five_hour?.utilization ?? 0),
      weeklyResetsAt: data?.seven_day?.resets_at ?? null,
      severity: (weeklyLimit?.severity as ClaudeAccountUsage['severity']) || severityOf(weekly),
      detail: estraiDettaglio(data),
    }
  } finally {
    clearTimeout(timer)
  }
}

let cache: { at: number; accounts: ClaudeAccount[] } | null = null

/**
 * Elenco account con utilizzo, ordinato dal più libero al più carico.
 * `force` salta la cache (bottone "aggiorna" nella modale).
 */
/** Perche' il dato manca e quando tornera': un "n/d" secco non aiuta a scegliere. */
function attesaLabel(): string {
  if (!retryAfterAll) return 'lettura non riuscita'
  // Fuso esplicito: il server gira in UTC, chi legge sta in Italia — senza, l'orario mostrato
  // e' indietro di due ore e sembra che il tentativo sia gia' passato.
  const ora = new Date(retryAfterAll).toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Rome',
  })
  return `Anthropic limita le letture · riprovo alle ${ora}`
}

export async function listClaudeAccounts(force = false): Promise<ClaudeAccount[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.accounts

  const slots = await discoverSlots()
  const snaps = await loadSnapshots()
  const accounts: ClaudeAccount[] = []

  // Sequenziale e distanziato: quattro richieste insieme allo stesso endpoint sono il modo
  // piu' veloce per prendersi un 429 e restare senza percentuali proprio quando servono.
  for (const [i, slot] of slots.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, SPACING_MS))
    const email = await readEmail(slot)
    const plan = await readPlan(slot)
    const base = { id: slot.id, label: labelFor(email, slot), email, isDefault: slot.isDefault, plan }
    const token = await readAccessToken(slot)

    /** Ultimo dato buono, se abbastanza fresco da dire ancora qualcosa. */
    const fallback = (motivo: string): ClaudeAccount => {
      const snap = snaps[slot.id]
      const age = snap ? Date.now() - snap.at : Infinity
      if (snap && age < STALE_MAX_MS) {
        return {
          ...base,
          usage: snap.usage,
          error: null,
          stale: true,
          staleMinutes: Math.round(age / 60_000),
        }
      }
      return { ...base, usage: null, error: motivo }
    }

    if (!token) {
      accounts.push(fallback('non autenticato'))
      continue
    }

    // Finestra di riposo dopo un 429: si serve la cache senza nemmeno provare.
    if (Date.now() < retryAfterAll) {
      accounts.push(fallback(attesaLabel()))
      continue
    }

    try {
      const usage = await fetchUsage(token)
      await saveSnapshot(slot.id, usage)
      retryAfterAll = 0
      rifiutiConsecutivi = 0
      accounts.push({ ...base, usage, error: null })
    } catch (err) {
      const message = (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message
      if (message.includes('429')) {
        const attesa = BACKOFF_STEPS_MS[Math.min(rifiutiConsecutivi, BACKOFF_STEPS_MS.length - 1)]
        rifiutiConsecutivi += 1
        retryAfterAll = Date.now() + attesa
        logger.warn(`[claude-accounts] 429 sull'endpoint usage (limite per IP): fermo le letture per ${attesa / 60_000} min`)
      } else {
        logger.warn(`[claude-accounts] usage non disponibile per ${base.label}: ${message}`)
      }
      accounts.push(fallback(message.includes('429') ? attesaLabel() : message))
    }
  }

  // Chi non risponde finisce in fondo: non è candidabile a "più libero".
  accounts.sort((a, b) => (a.usage?.weeklyPercent ?? 101) - (b.usage?.weeklyPercent ?? 101))
  cache = { at: Date.now(), accounts }
  return accounts
}

/** Config dir di un account, validata contro il registro: mai path da input utente. */
export async function configDirForAccount(id: string): Promise<string | null> {
  const slot = (await discoverSlots()).find((s) => s.id === id)
  return slot ? slot.configDir : null
}
