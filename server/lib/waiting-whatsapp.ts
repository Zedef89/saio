/**
 * Quando una sessione resta su "aspetta te", lo dice su WhatsApp alla persona che l'ha aperta.
 *
 * ## Perche' non basta l'hook
 *
 * `devbox-config/hooks/saio-avvisa.py` avvisa a fine turno (hook `Stop`), ma solo se in quel
 * momento la persona non ha scritto nella sessione da 10 minuti. Il 14/09 albatros ha chiuso
 * con «Decidi tu» mentre Nicola ci stava scrivendo: l'hook ha taciuto — giusto — e poi nessuno
 * l'ha piu' richiamato. E i menu della CLI (permessi, scelte) non passano mai dallo `Stop`.
 *
 * Qui il segnale e' lo stesso della card: la videata (`activity === 'waiting'`). Se resta cosi'
 * per DOPO_MS, chi guardava se n'e' andato, e il messaggio serve.
 *
 * Le regole anti-rumore sono quelle dell'hook, e il registro e' LO STESSO file
 * (`<dataDir>/avvisi/stato.json`): una domanda gia' mandata dall'hook non riparte da qui, e
 * i 20 minuti fra due avvisi e i 6 al giorno valgono per tutti e due insieme.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { logger } from './logger'
import type { ScreenState } from './tmux-runtime'

const execFileAsync = promisify(execFile)

/** Chi ha un numero: stesso elenco dell'hook. Una sessione di altri non avvisa nessuno. */
const NUMERI: Record<string, string> = { nicola: '393933141966', alberto: '393272407929' }
const EVOLUTION = 'https://evolution.komandaprint.com/message/sendText/komanda'
/** Da quanto deve aspettare prima di avvisare: se sei li', rispondi prima. */
const DOPO_MS = 3 * 60_000
const COOLDOWN_S = 20 * 60
const MAX_AL_GIORNO = 6

interface Voce {
  quando?: number
  giorno?: string
  ultima_impronta?: string
  sessione?: string
}

/** Da quando ogni sessione e' su "aspetta te" (in memoria: basta per i 3 minuti). -1 = gia' in attesa all'avvio. */
const inAttesaDa = new Map<string, number>()
const AVVIO = Date.now()

function persona(sessione: string): string | null {
  for (const slug of Object.keys(NUMERI)) if (sessione === slug || sessione.startsWith(`${slug}-`)) return slug
  return null
}

async function manda(dir: string, numero: string, testo: string): Promise<boolean> {
  // Il payload va da file, mai in riga di comando; la chiave la mette saio-run e non si vede.
  const p = path.join(dir, `wa-${process.pid}-${Date.now()}.json`)
  await fs.writeFile(p, JSON.stringify({ number: numero, text: testo }), { mode: 0o600 })
  try {
    const { stdout } = await execFileAsync(
      'saio-run',
      ['--con', 'EVOLUTION_API_KEY', '--', 'bash', '-c',
        `curl -s -m 25 -X POST "${EVOLUTION}" -H "Content-Type: application/json" -H "apikey: $EVOLUTION_API_KEY" --data-binary @${p}`],
      { timeout: 40_000 },
    )
    return stdout.includes('"status"')
  } catch {
    return false
  } finally {
    await fs.rm(p, { force: true })
  }
}

/** Da chiamare a ogni giro per ogni sessione con Claude. Non alza mai. */
export async function avvisaSeAspetta(name: string, s: ScreenState, dataDir: string): Promise<void> {
  if (s.activity !== 'waiting') {
    inAttesaDa.delete(name)
    return
  }
  const now = Date.now()
  // Chi aspettava gia' quando SAIO e' partito aspetta da un tempo che non conosciamo: dopo un
  // riavvio non si spara una raffica di domande vecchie. Si avvisa solo un'attesa vista iniziare.
  if (!inAttesaDa.has(name)) inAttesaDa.set(name, now - AVVIO < 90_000 ? -1 : now)
  const da = inAttesaDa.get(name)!
  if (da === -1 || now - da < DOPO_MS) return
  const chi = persona(name)
  if (!chi) return

  const dir = path.join(dataDir, 'avvisi')
  const file = path.join(dir, 'stato.json')
  let st: Record<string, Voce> = {}
  try {
    st = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, Voce>
  } catch {
    /* primo avviso di sempre */
  }
  const mio = (st[name] ??= {})
  const impronta = s.excerpt.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-60)
  if (mio.ultima_impronta === impronta) return // stessa domanda gia' mandata
  const oraS = now / 1000
  if (oraS - (mio.quando ?? 0) < COOLDOWN_S) return
  const oggi = new Date(now).toISOString().slice(0, 10)
  const contati = Object.values(st).filter((v) => v.giorno === oggi && persona(v.sessione ?? '') === chi).length
  if (contati >= MAX_AL_GIORNO) return

  const minuti = Math.round((now - da) / 60_000)
  const testo =
    `⏸ La sessione «${name}» aspetta una tua risposta da ${minuti} minuti.\n\n${s.excerpt}\n\n` +
    `(Rispondi nella sessione su SAIO: https://saio-komanda.nicolamele.com/sessions)`
  try {
    await fs.mkdir(dir, { recursive: true })
    if (!(await manda(dir, NUMERI[chi], testo))) {
      logger.warn(`[waiting-whatsapp] ${name}: invio WhatsApp non riuscito`)
      return
    }
    Object.assign(mio, { quando: oraS, giorno: oggi, ultima_impronta: impronta, sessione: name })
    await fs.writeFile(file, JSON.stringify(st, null, 1), { mode: 0o600 })
    logger.info(`[waiting-whatsapp] ${name}: aspetta da ${minuti} min, avvisato ${chi} su WhatsApp`)
  } catch (err) {
    logger.warn(`[waiting-whatsapp] ${name}: ${(err as Error).message}`)
  }
}
