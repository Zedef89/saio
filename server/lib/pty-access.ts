/**
 * Chi puo' aprire quale terminale, e se ci puo' scrivere o solo guardare.
 *
 * Nicola, 12/10/2026: «tutti possono VEDERE le sessioni degli altri, scriverci solo chi le ha
 * aperte; io le vedo e ci scrivo tutte. La shell root solo io». Fino a qui chiunque aprisse un
 * terminale ci scriveva dentro: il WebSocket inoltrava i tasti al PTY senza chiedersi di chi
 * fosse la sessione, e il «Terminale condiviso» (tmux `main` + choose-tree, cioe' una shell
 * root da cui si salta in qualsiasi sessione) era aperto a ogni invitato.
 *
 * La regola sta qui, separata dal WebSocket, per due ragioni: si legge in una schermata e si
 * prova con un test senza tirare su un server.
 *
 * Il blocco vero e' nel server (ws-pty.ts non inoltra i tasti di chi non puo' scrivere, le
 * route REST rispondono 403): l'interfaccia lo racconta e basta.
 */
import { canActOnSession, ownerSlugForEmail } from './session-owner'

/** I due terminali che sono una shell root: il «Terminale condiviso» e la shell dell'admin. */
export const PTY_SHELL_ROOT = new Set(['terminal', 'shell-root'])

export interface UtentePty {
  /** Assente solo nei bypass di sviluppo (auth spenta, richiesta locale). */
  email?: string
  superAdmin: boolean
}

export type EsitoAccessoPty =
  | { ok: false; reason: string }
  | {
      ok: true
      /** Chiave del PTY in ptyManager: non sempre coincide con l'id chiesto. */
      key: string
      /** false = la connessione guarda e basta: i suoi tasti non arrivano al PTY. */
      canWrite: boolean
      /** Il progetto vero, quando la chiave e' quella personale di una card. */
      progettoId?: string
      /** Nome della sessione tmux per `shell-root`. */
      shellRootSession?: string
    }

/** Il proprietario di un PTY gia' aperto, per quanto lo sa il pty-manager. */
export type SessioneDi = (key: string) => { ownerEmail?: string } | undefined

async function stessaPersona(dataDir: string, a: string | undefined, b: string | undefined): Promise<boolean> {
  if (!a || !b) return false
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true
  return (await ownerSlugForEmail(dataDir, a)) === (await ownerSlugForEmail(dataDir, b))
}

/**
 * Decide l'apertura di un terminale.
 *
 * - `terminal`, `shell-root`: solo il super admin.
 * - `tmux-<nome>`: tutti la vedono; chi non ne e' il proprietario (`canActOnSession`) viene
 *   attaccato in sola lettura, su un PTY a parte (`tmuxro-<nome>`), cosi' non condivide
 *   nemmeno il processo di chi ci scrive.
 * - card di un progetto: il PTY e' indicizzato per progetto, quindi il secondo che apriva la
 *   stessa card finiva nel terminale del primo. Se la card e' gia' aperta da un altro, si apre
 *   su una chiave personale (`<progetto>__<slug>`): ognuno scrive nel suo.
 */
export async function accessoPty(
  dataDir: string,
  projectId: string,
  utente: UtentePty,
  sessioneDi: SessioneDi,
): Promise<EsitoAccessoPty> {
  if (PTY_SHELL_ROOT.has(projectId)) {
    if (!utente.superAdmin) return { ok: false, reason: 'shell root: solo il super admin' }
    if (projectId === 'shell-root') {
      const slug = utente.email ? await ownerSlugForEmail(dataDir, utente.email) : 'admin'
      return { ok: true, key: projectId, canWrite: true, shellRootSession: `${slug}-shell-root` }
    }
    return { ok: true, key: projectId, canWrite: true }
  }

  if (projectId.startsWith('tmuxro-')) {
    return { ok: true, key: projectId, canWrite: false }
  }

  if (projectId.startsWith('tmux-')) {
    const nome = projectId.slice(5)
    const canWrite =
      utente.superAdmin ||
      (!!utente.email && (await canActOnSession(dataDir, nome, { email: utente.email })))
    return canWrite
      ? { ok: true, key: projectId, canWrite: true }
      : { ok: true, key: `tmuxro-${nome}`, canWrite: false }
  }

  // Card di un progetto.
  if (!utente.email) return { ok: true, key: projectId, canWrite: true }
  const mio = await ownerSlugForEmail(dataDir, utente.email)
  const personale = `${projectId}__${mio}`
  if (sessioneDi(personale)) return { ok: true, key: personale, canWrite: true, progettoId: projectId }
  const base = sessioneDi(projectId)
  if (!base) return { ok: true, key: projectId, canWrite: true }
  if (base.ownerEmail ? await stessaPersona(dataDir, base.ownerEmail, utente.email) : utente.superAdmin) {
    return { ok: true, key: projectId, canWrite: true }
  }
  return { ok: true, key: personale, canWrite: true, progettoId: projectId }
}

/**
 * Chi puo' chiudere un PTY (DELETE /api/pty/:id, messaggio `kill`). Chiudere e' scrivere:
 * stesse regole di `accessoPty`, piu' una — il PTY di chi guarda (`tmuxro-`) non e' di
 * nessuno e chiuderlo non tocca la sessione, quindi lo chiude chiunque.
 */
export async function puoChiuderePty(
  dataDir: string,
  key: string,
  utente: UtentePty,
  sessione: { ownerEmail?: string } | undefined,
): Promise<boolean> {
  if (utente.superAdmin) return true
  if (PTY_SHELL_ROOT.has(key)) return false
  if (key.startsWith('tmuxro-')) return true
  if (!utente.email) return false
  if (key.startsWith('tmux-')) return canActOnSession(dataDir, key.slice(5), { email: utente.email })
  return stessaPersona(dataDir, sessione?.ownerEmail, utente.email)
}
