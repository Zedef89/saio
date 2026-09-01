/**
 * Fa vedere fra loro le sessioni Claude Code dei DUE account.
 *
 * ## Il problema che risolve
 *
 * Ogni sessione si registra in un file dentro la cartella di configurazione del proprio
 * account: `<config-dir>/sessions/<pid>.json` (la scheda) più `<pid>.<sha256>.key` (la
 * chiave per parlarle). `ListAgents` legge **solo la propria** cartella — quindi una
 * sessione su `~/.claude` e una su `~/.claude-b`, sullo stesso repo e nello stesso
 * momento, non si vedono e non possono scriversi.
 *
 * Il manuale del team impone di annunciarsi alle altre sessioni prima di toccare un file
 * condiviso. Con i due account separati quella regola non è applicabile: chi si comporta
 * bene e chiama `ListAgents` riceve una lista che non contiene metà delle persone al
 * lavoro, e ne conclude — in buona fede — di essere solo.
 *
 * Successo davvero il 21/08/2026: due sessioni sullo stesso repo, invisibili l'una
 * all'altra, una in procinto di portare in produzione il lavoro dell'altra senza saperlo.
 * Nelle sei ore in cui si sono viste (ponte messo a mano) si sono evitate a vicenda un
 * deploy rotto, un sync inutile su 44 agenti e tre voci sbagliate in documentazione.
 *
 * ## Perché basta copiare due file
 *
 * Il **trasporto è già condiviso**: i socket non stanno dentro le cartelle degli account,
 * stanno in `/tmp/cc-socks/<pid>.sock`, un percorso comune. Le due famiglie non sono
 * separate da un muro tecnico — sono separate solo da **scoperta e chiave**. Quindi non
 * serve toccare il protocollo: basta che ogni cartella veda anche le schede dell'altra.
 *
 * ## Le regole che rendono la copia sicura
 *
 * 1. **Si specchia, non si sposta**: l'originale non si tocca mai.
 * 2. **Ogni copia ha un marcatore** (`<pid>.saio-mirror`). Si cancella SOLO ciò che porta
 *    il marcatore: una scheda vera di quell'account non viene mai rimossa, nemmeno per
 *    errore di lettura.
 * 3. **Non si sovrascrive mai un file che non è nostro**: se in destinazione esiste già
 *    una scheda con quel pid e non è una nostra copia, si lascia stare e si logga.
 * 4. La copia sparisce quando sparisce l'originale, così `ListAgents` non elenca sessioni
 *    morte.
 *
 * ⚠️ `sessions/*.json` è un **dettaglio interno** di Claude Code, non un'API pubblica: un
 * aggiornamento può cambiarne forma o posizione. Per questo il ponte **verifica il
 * formato** e, se non lo riconosce, smette di specchiare invece di scrivere file che
 * nessuno legge più — meglio tornare al problema noto che crearne uno nuovo.
 */
import fs from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { logger } from './logger'

const HOME = process.env.HOME || os.homedir()
const INTERVALLO_MS = 5_000
const MARCATORE = '.saio-mirror'

/**
 * Le cartelle dei REGISTRI di sessione di tutti gli account — non le config dir.
 * La differenza non e' cosmetica: puntando alla config dir si finisce a leggere
 * `.credentials.json` e `.claude.json`, che non sono schede di sessione. Al primo avvio e'
 * successo, e la guardia sul formato ha spento il ponte invece di copiare file a caso.
 */
function configDirs(): string[] {
  const dirs = [path.join(HOME, '.claude')]
  try {
    for (const entry of readdirSync(HOME, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.claude-[a-zA-Z0-9_-]+$/.test(entry.name)) dirs.push(path.join(HOME, entry.name))
    }
  } catch {
    /* home illeggibile: resta il solo account di default */
  }
  return dirs.sort()
}

const REGISTRI = configDirs().map((dir) => path.join(dir, 'sessions'))

let attivo = false
let spentoPerFormato = false

interface Scheda {
  pid: number
  file: string
  chiavi: string[]
}

/**
 * Il formato che ci aspettiamo. Se cambia, il ponte si spegne da solo: `pid` è l'unico
 * campo su cui facciamo affidamento davvero (nome dei file e vita della sessione).
 */
function formatoValido(dati: unknown): dati is { pid: number } {
  return !!dati && typeof dati === 'object' && Number.isInteger((dati as { pid?: unknown }).pid)
}

function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' // esiste ma di un altro utente
  }
}

/** Le schede NON specchiate di una cartella: quelle che quell'account ha davvero. */
async function schedeProprie(dir: string): Promise<Scheda[]> {
  let file: string[]
  try {
    file = await fs.readdir(dir)
  } catch {
    return [] // account non configurato: nulla da specchiare
  }
  const specchiati = new Set(
    file.filter((f) => f.endsWith(MARCATORE)).map((f) => f.slice(0, -MARCATORE.length))
  )
  const fuori: Scheda[] = []
  for (const f of file) {
    if (!f.endsWith('.json')) continue
    const pidStr = f.slice(0, -'.json'.length)
    if (specchiati.has(pidStr)) continue // è una nostra copia, non l'originale
    let dati: unknown
    try {
      dati = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'))
    } catch {
      continue // scheda a metà scrittura: al giro dopo
    }
    if (!formatoValido(dati)) {
      spentoPerFormato = true
      logger.warn(
        `[session-bridge] formato di ${f} non riconosciuto (manca "pid"): ponte SPENTO. ` +
          'Probabile aggiornamento di Claude Code — va riallineato a mano.'
      )
      return []
    }
    fuori.push({
      pid: dati.pid,
      file: f,
      chiavi: file.filter((k) => k.startsWith(`${pidStr}.`) && k.endsWith('.key')),
    })
  }
  return fuori
}

async function copiaSeServe(da: string, a: string, nome: string): Promise<boolean> {
  const dest = path.join(a, nome)
  try {
    await fs.access(dest)
    return false // c'è già
  } catch {
    /* da copiare */
  }
  await fs.copyFile(path.join(da, nome), dest)
  await fs.chmod(dest, 0o600)
  return true
}

/** Porta in `a` le schede di `da`, e toglie le copie rimaste orfane. */
async function specchia(da: string, a: string): Promise<number> {
  const schede = await schedeProprie(da)
  if (spentoPerFormato) return 0

  let nuove = 0
  const pidVivi = new Set<string>()
  for (const s of schede) {
    if (!vivo(s.pid)) continue // sessione morta: non ha senso annunciarla
    pidVivi.add(String(s.pid))
    const marker = path.join(a, `${s.pid}${MARCATORE}`)
    // Regola 3: se in destinazione c'è già una scheda con quel pid e NON è nostra, è la
    // scheda vera di quell'account (o un pid riciclato). Non si tocca.
    try {
      await fs.access(path.join(a, s.file))
      try {
        await fs.access(marker)
      } catch {
        continue // esiste ma non è una nostra copia
      }
    } catch {
      /* non c'è: si copia */
    }
    let copiato = await copiaSeServe(da, a, s.file)
    for (const k of s.chiavi) copiato = (await copiaSeServe(da, a, k)) || copiato
    if (copiato) {
      await fs.writeFile(marker, `${da}\n`, { mode: 0o600 })
      nuove++
    }
  }

  // Regola 2 e 4: si cancella SOLO ciò che porta il marcatore, e solo se l'originale non
  // c'è più (sessione chiusa) — mai una scheda vera.
  let file: string[] = []
  try {
    file = await fs.readdir(a)
  } catch {
    return nuove
  }
  for (const f of file) {
    if (!f.endsWith(MARCATORE)) continue
    const pidStr = f.slice(0, -MARCATORE.length)
    if (pidVivi.has(pidStr)) continue
    if (vivo(Number(pidStr))) continue // viva ma non ancora riletta: si aspetta
    for (const g of file.filter((x) => x.startsWith(`${pidStr}.`) || x === f)) {
      await fs.rm(path.join(a, g), { force: true })
    }
  }
  return nuove
}

async function giro(): Promise<void> {
  if (spentoPerFormato) return
  try {
    let nuove = 0
    for (const da of REGISTRI) {
      for (const a of REGISTRI) {
        if (da !== a) nuove += await specchia(da, a)
      }
    }
    if (nuove > 0) logger.info(`[session-bridge] ${nuove} sessioni rese visibili all'altro account`)
  } catch (err) {
    logger.warn(`[session-bridge] giro fallito: ${(err as Error).message}`)
  }
}

/**
 * Avvia il ponte. Idempotente: chiamarlo due volte non raddoppia il timer.
 * Non alza mai — se il ponte non parte, SAIO deve funzionare lo stesso.
 */
export function startSessionBridge(): void {
  if (attivo) return
  attivo = true
  logger.info('[session-bridge] attivo: le sessioni dei due account si vedono fra loro')
  void giro()
  const timer = setInterval(() => void giro(), INTERVALLO_MS)
  timer.unref?.()
}
