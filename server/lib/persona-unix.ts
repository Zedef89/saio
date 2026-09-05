/**
 * Chi e' una persona per il SISTEMA, non solo per git.
 *
 * Fino a qui l'anagrafica (`git-identities.json`) diceva come firmare i commit e come
 * chiamare i worktree: tutto dentro SAIO, che gira come root. Da qui dice anche **con quale
 * utente Unix** far girare le sue sessioni, che e' l'unico punto in cui i permessi smettono
 * di essere una convenzione: il cancello si aggira, un `chmod 700` no.
 *
 * Il campo e' OPZIONALE, ed e' voluto: chi non ce l'ha (oggi Nicola e Alberto, che hanno
 * l'ambiente dentro `/root`) continua a girare esattamente come prima. Spostare il loro
 * ambiente e' un'operazione con una finestra, questa non ne ha bisogno — una persona nuova
 * non ha lavoro in corso da spostare.
 *
 *     "marco.rossi@example.com": {
 *       "slug": "marco",
 *       "name": "Marco Rossi",
 *       "email": "marco@users.noreply.github.com",
 *       "sshKey": "/srv/taskless/marco/.ssh/id_ed25519_gh_marco",
 *       "unixUser": "marco"
 *     }
 *
 * 🔴 Se `unixUser` c'e' ma non si risolve, questo modulo **alza**: non ricade su root.
 * Una sessione che doveva essere separata e gira invece come root e' indistinguibile da una
 * che e' andata bene, e sarebbe l'ennesima protezione che esiste solo come frase in un campo
 * di testo. Meglio una sessione che non parte, e si vede subito.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getIdentity } from './worktree'

/** Dove vivono gli ambienti delle persone con utente separato. */
export const AREA_ROOT = process.env.SAIO_AREA_ROOT || '/srv/taskless'

/** Dove vivono le configurazioni dei cinque account Claude, fuori da `/root`. */
export const ACCOUNT_ROOT = process.env.SAIO_ACCOUNT_ROOT || '/srv/taskless/account-claude'

export interface PersonaUnix {
  slug: string
  /** Nome dell'utente Unix. */
  user: string
  uid: number
  gid: number
  /** Home dell'utente (da /etc/passwd), `700`: e' li' che stanno le sue chiavi. */
  home: string
  /** La sua area di lavoro: `/srv/taskless/<slug>`. */
  area: string
  /** I suoi repo: `/srv/taskless/<slug>/dev` — l'equivalente di `/root/dev` per lei. */
  devRoot: string
}

export class PersonaUnixError extends Error {}

/** uid/gid/home di un utente, letti da /etc/passwd. Nessuna dipendenza esterna. */
async function fromPasswd(user: string): Promise<{ uid: number; gid: number; home: string } | null> {
  const txt = await fsp.readFile('/etc/passwd', 'utf8')
  for (const line of txt.split('\n')) {
    const f = line.split(':')
    if (f[0] !== user) continue
    const uid = Number(f[2])
    const gid = Number(f[3])
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null
    return { uid, gid, home: f[5] || `/home/${user}` }
  }
  return null
}

/**
 * L'utente Unix di questa persona, o `null` se non ne ha uno (comportamento storico: root).
 *
 * @throws PersonaUnixError se l'anagrafica ne dichiara uno che il sistema non conosce.
 */
export async function personaUnix(dataDir: string, email: string | null | undefined): Promise<PersonaUnix | null> {
  if (!email || email === 'unknown') return null
  let dichiarato: string | undefined
  try {
    const raw = await fsp.readFile(path.join(dataDir, 'git-identities.json'), 'utf8')
    const all = JSON.parse(raw) as Record<string, { unixUser?: string }>
    dichiarato = all[email.toLowerCase().trim()]?.unixUser
  } catch {
    return null // nessuna anagrafica: nessuno ha un utente separato
  }
  if (!dichiarato) return null
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(dichiarato)) {
    throw new PersonaUnixError(`unixUser non valido per ${email}: "${dichiarato}"`)
  }
  const pw = await fromPasswd(dichiarato)
  if (!pw) {
    throw new PersonaUnixError(
      `l'anagrafica dice che ${email} gira come utente "${dichiarato}", ma quell'utente non esiste su questa macchina`,
    )
  }
  if (pw.uid === 0) {
    throw new PersonaUnixError(`"${dichiarato}" e' root: un utente separato che e' root non separa niente`)
  }
  const { slug } = await getIdentity(dataDir, email)
  const area = path.join(AREA_ROOT, slug)
  return { slug, user: dichiarato, uid: pw.uid, gid: pw.gid, home: pw.home, area, devRoot: path.join(area, 'dev') }
}

/**
 * L'ambiente con cui far partire la sua shell.
 *
 * `pty.spawn` con `uid`/`gid` cambia l'utente ma **non** l'ambiente: senza questi, la sessione
 * gira come `marco` con `HOME=/root`, cioe' non riesce a scrivere niente e Claude non trova la
 * sua configurazione. Il sintomo e' un terminale che si apre e non fa nulla.
 */
/**
 * La configurazione di un account Claude, ma nella cartella di QUESTA persona.
 *
 * I cinque abbonamenti sono in comune (`/srv/taskless/account-claude/.claude-b`), ma quella
 * cartella non e' un posto dove farla lavorare: dentro ci sono i transcript di tutte le
 * sessioni di chi c'era prima — ed e' li' che finiscono le chiavi di produzione lette a
 * schermo. Quindi le si da' una config dir sua (`/srv/taskless/marco/.claude-b`), con dentro
 * un collegamento al SOLO file delle credenziali: usa l'abbonamento, non legge il lavoro
 * degli altri, e i suoi transcript restano suoi.
 *
 * Se il percorso non e' quello di un account condiviso, torna com'e'.
 */
export function configPerPersona(p: PersonaUnix | null, configDir: string): string {
  if (!p) return configDir
  let vero = configDir
  try {
    vero = fs.realpathSync(configDir)
  } catch {
    /* non esiste ancora: si lavora sul percorso cosi' com'e' */
  }
  const base = ACCOUNT_ROOT + path.sep
  if (!vero.startsWith(base)) return configDir
  const nome = vero.slice(base.length).split(path.sep)[0]
  return path.join(p.area, nome)
}

export function envPerPersona(base: NodeJS.ProcessEnv, p: PersonaUnix): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base }
  for (const [k, v] of Object.entries(base)) {
    if (!v || !v.startsWith('/root/')) continue
    // SAIO gira come root e si porta dietro percorsi dentro `/root`, che e' `700`. Molti sono
    // symlink verso una cartella condivisa (`/srv/taskless/…`): quelli si riscrivono al
    // percorso vero, cosi' funzionano per lei. Gli altri si TOLGONO invece di lasciarli
    // rotti: quasi sempre il programma ha un default giusto, mentre una variabile che punta
    // dove lei non arriva produce un errore che sembra tutt'altro — «registro assente»
    // invece di «non puoi leggerlo». Successo davvero, al primo collaudo.
    let vero: string | null = null
    try {
      vero = fs.realpathSync(v)
    } catch {
      vero = null
    }
    if (vero && !vero.startsWith('/root/')) out[k] = k === 'CLAUDE_CONFIG_DIR' ? configPerPersona(p, vero) : vero
    else delete out[k]
  }
  out.HOME = p.home
  out.USER = p.user
  out.LOGNAME = p.user
  out.SHELL = base.SHELL || '/bin/bash'
  out.PATH = base.PATH?.split(':').filter((d) => !d.startsWith('/root/')).join(':') || '/usr/local/bin:/usr/bin:/bin'
  return out
}

/**
 * Lo stesso comando, eseguito COME questa persona.
 *
 * Serve dove SAIO lancia un comando da se' (`execFile`) invece di aprire un PTY: la pagina
 * Sessioni crea la sessione tmux cosi', e senza questo la creerebbe di root anche per chi ha
 * un utente suo — con l'effetto che la sessione appare separata nell'anagrafica ed e' root
 * nei fatti.
 *
 * `--init-groups` prende i gruppi supplementari da `/etc/group`: senza, la persona resterebbe
 * fuori dal gruppo `taskless` e non scriverebbe nella sua area.
 */
export function comeLaPersona(p: PersonaUnix | null, argv: string[]): { file: string; args: string[] } {
  if (!p) return { file: argv[0], args: argv.slice(1) }
  return {
    file: 'setpriv',
    args: ['--reuid', String(p.uid), '--regid', String(p.gid), '--init-groups', '--', 'env', `HOME=${p.home}`, `USER=${p.user}`, `LOGNAME=${p.user}`, ...argv],
  }
}

/**
 * Tutte le persone con un utente Unix separato.
 *
 * Serve per ENUMERARE: le loro sessioni tmux vivono su `/tmp/tmux-<uid>/default`, un socket
 * per utente, e un `tmux list-sessions` di root vede solo le proprie. Senza questa lista, in
 * SAIO le sessioni delle persone separate semplicemente non compaiono.
 */
export async function tuttePersoneUnix(dataDir: string): Promise<PersonaUnix[]> {
  let emails: string[] = []
  try {
    const raw = await fsp.readFile(path.join(dataDir, 'git-identities.json'), 'utf8')
    emails = Object.keys(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return []
  }
  const out: PersonaUnix[] = []
  for (const e of emails) {
    try {
      const p = await personaUnix(dataDir, e)
      if (p) out.push(p)
    } catch {
      /* dichiarata ma non risolvibile: lo spawn lo dira' forte, qui si salta */
    }
  }
  return out
}

/**
 * Lo stesso progetto, ma nella cartella di questa persona.
 *
 * I progetti sono registrati una volta sola, col percorso di chi li ha importati
 * (`/root/dev/komalead`). Per chi ha un'area sua lo stesso progetto vive in
 * `/srv/taskless/<slug>/dev/komalead`: e' il suo clone, col suo remote e le sue chiavi.
 *
 * Se in quell'area il progetto non c'e', ritorna `null` — e chi chiama deve dire di no, non
 * ripiegare sul percorso di root: aprire il repo di un altro utente e' esattamente quello che
 * l'area separata serve a impedire.
 */
export function nellaSuaArea(p: PersonaUnix | null, percorso: string): string | null {
  if (!p) return percorso
  const base = path.join(os.homedir(), 'dev') + path.sep
  const rel = percorso.startsWith(base) ? percorso.slice(base.length) : path.basename(percorso)
  const suo = path.join(p.devRoot, rel)
  return suo.startsWith(p.devRoot + path.sep) ? suo : null
}
