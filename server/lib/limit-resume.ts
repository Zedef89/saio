/**
 * Riprende da sola una sessione ferma sul limite dell'account, all'ora in cui si sblocca.
 *
 * ## Il problema che risolve
 *
 * Quando un account finisce la finestra, la CLI lo scrive nero su bianco: «You've hit your
 * session limit · resets 11:40am (UTC)». Da quel momento la sessione sta ferma finche'
 * qualcuno non le scrive: il 13/09 un'analisi lanciata la mattina e' rimasta ferma dalle 11:40
 * alle 2:39 di notte, quando Nicola ha battuto «riprendi» e tutto e' ripartito senza problemi.
 * Il lavoro da fare era solo quello: aspettare l'ora scritta e mandare un messaggio.
 *
 * ## Come
 *
 * Un giro al minuto su tutte le pane con Claude. Si scrive in una sessione solo se tutte
 * queste cose sono vere insieme:
 * - l'ultima cosa successa nella conversazione e' il limite (lo decide classifyScreen);
 * - la sessione e' libera al prompt: non lavora e non e' ferma su una domanda;
 * - nella casella non c'e' testo battuto da qualcuno;
 * - l'ora del reset e' passata, ma da meno di TROPPO_VECCHIO_MS: una sessione ferma da giorni
 *   e' stata lasciata li' apposta, non la si risveglia.
 * Ogni limite si riprende una volta sola: la chiave sessione+ora del reset finisce in un file
 * nella dataDir, cosi' nemmeno un riavvio di SAIO fa ripartire due volte la stessa sessione.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { logger } from './logger'
import { processTable, findClaudePid, readScreen } from './tmux-runtime'

const INTERVALLO_MS = 60_000
/** Il reset e' scritto al minuto: un filo dopo, per non trovare il limite ancora chiuso. */
const MARGINE_MS = 90_000
const TROPPO_VECCHIO_MS = 3 * 3_600_000
/** Le riprese piu' vecchie di cosi' escono dal file: il loro reset non tornera' a schermo. */
const RICORDO_MS = 8 * 86_400_000
/** La stessa frase che usa la CLI quando riparte da sola dopo un limite. */
const MESSAGGIO =
  'Il limite di utilizzo si è sbloccato. Riprendi il lavoro da dove si era fermato, senza rifare quello che è già completo.'

function DATA_DIR(): string {
  return process.env.DASHBOARD_DATA_DIR || path.join(process.cwd(), 'data')
}

const FILE = () => path.join(DATA_DIR(), 'limit-resume.json')

/** `<sessione>|<resetsAt>` → quando e' stata ripresa (o scartata perche' troppo vecchia). */
let riprese: Record<string, number> | null = null
let inCorso = false
let attivo = false

async function carica(): Promise<Record<string, number>> {
  if (riprese) return riprese
  try {
    riprese = JSON.parse(await fs.readFile(FILE(), 'utf8')) as Record<string, number>
  } catch {
    riprese = {}
  }
  return riprese
}

async function salva(r: Record<string, number>): Promise<void> {
  const limite = Date.now() - RICORDO_MS
  for (const [k, v] of Object.entries(r)) if (v < limite) delete r[k]
  const tmp = `${FILE()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(r, null, 2))
  await fs.rename(tmp, FILE())
}

async function giro(): Promise<void> {
  if (inCorso) return
  inCorso = true
  try {
    const dd = DATA_DIR()
    const { tmuxOvunque, tmuxSuSessione } = await import('./tmux-cmd')
    const stdout = await tmuxOvunque(dd, ['list-panes', '-a', '-F', '#{session_name}|#{pane_pid}'], { timeout: 4000 })
    if (!stdout.trim()) return
    const rows = await processTable()
    const r = await carica()
    let cambiato = false
    const viste = new Set<string>()
    for (const line of stdout.split('\n')) {
      const [name, pid] = line.split('|')
      if (!name || viste.has(name)) continue // una sola window per sessione: la prima basta
      viste.add(name)
      if (!findClaudePid(rows, Number(pid))) continue
      const s = await readScreen(name, dd)
      if (!s.limit || s.activity !== 'idle' || s.inputDirty) continue
      const at = Date.parse(s.limit.resetsAt)
      const now = Date.now()
      if (now < at + MARGINE_MS) continue
      const chiave = `${name}|${s.limit.resetsAt}`
      if (chiave in r) continue
      r[chiave] = now
      cambiato = true
      if (now - at > TROPPO_VECCHIO_MS) {
        logger.info(`[limit-resume] ${name}: limite ${s.limit.kind} sbloccato da piu' di 3 ore, la lascio com'e'`)
        continue
      }
      const target = `=${name}:`
      await tmuxSuSessione(dd, name, ['send-keys', '-t', target, '-l', MESSAGGIO])
      await new Promise((ok) => setTimeout(ok, 400))
      await tmuxSuSessione(dd, name, ['send-keys', '-t', target, 'Enter'])
      logger.info(`[limit-resume] ${name}: limite ${s.limit.kind} sbloccato (${s.limit.resetsAt}), sessione ripresa`)
    }
    if (cambiato) await salva(r)
  } catch (err) {
    logger.warn(`[limit-resume] giro fallito: ${(err as Error).message}`)
  } finally {
    inCorso = false
  }
}

/** Avvia il giro. Idempotente, e non alza mai: se non parte, SAIO funziona lo stesso. */
export function startLimitResume(): void {
  if (attivo) return
  attivo = true
  logger.info('[limit-resume] attivo: le sessioni ferme sul limite ripartono da sole al reset')
  const timer = setInterval(() => void giro(), INTERVALLO_MS)
  timer.unref?.()
}
