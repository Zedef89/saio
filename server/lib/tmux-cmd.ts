/**
 * Parlare al tmux GIUSTO.
 *
 * Da quando una persona puo' avere un utente Unix suo, le sessioni non stanno piu' tutte
 * nello stesso posto: tmux tiene un server per utente, con il socket in `/tmp/tmux-<uid>/`.
 * Un `tmux kill-session` lanciato da SAIO (root) non trova la sessione di `marco`, e
 * l'errore che torna e' «can't find session» — indistinguibile da una sessione gia' chiusa.
 *
 * Qui sta la regola, una volta sola: **da quale utente parlare lo dice il nome della
 * sessione**, che ha davanti lo slug del proprietario (`marco-komalead`). E' lo stesso
 * meccanismo di `session-owner.ts`, per la stessa ragione: tmux non ha metadati per sessione,
 * e un registro a parte si disallineerebbe con le sessioni aperte a mano da SSH.
 *
 * Chi non ha un utente separato (oggi Nicola e Alberto) passa da root, come sempre.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { TMUX_BIN } from './tmux-bin'
import { comeLaPersona, tuttePersoneUnix, type PersonaUnix } from './persona-unix'

const execFileAsync = promisify(execFile)

/** L'utente sul cui socket vive questa sessione, dal prefisso del nome. */
export async function fonteDellaSessione(dataDir: string, sessionName: string): Promise<PersonaUnix | null> {
  const persone = await tuttePersoneUnix(dataDir)
  // Slug piu' lunghi per primi: `marco-rossi` non deve essere scavalcato da `marco`.
  for (const p of [...persone].sort((a, b) => b.slug.length - a.slug.length)) {
    if (sessionName === p.slug || sessionName.startsWith(`${p.slug}-`)) return p
  }
  return null
}

/** Un comando tmux su una sessione precisa, eseguito dall'utente che la possiede. */
export async function tmuxSuSessione(
  dataDir: string,
  sessionName: string,
  args: string[],
  opts?: { timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const fonte = await fonteDellaSessione(dataDir, sessionName)
  const c = comeLaPersona(fonte, [TMUX_BIN, ...args])
  const r = await execFileAsync(c.file, c.args, { encoding: 'utf8', ...opts })
  return { stdout: String(r.stdout), stderr: String(r.stderr) }
}

/**
 * Lo stesso comando su TUTTI i socket, con le righe unite.
 *
 * Per le domande che non riguardano una sessione sola (`list-panes -a`, `list-sessions`):
 * ogni fonte va nel suo try, perche' un utente senza server tmux esce con codice 1 e
 * altrimenti basterebbe lui a svuotare la risposta di tutti.
 */
export async function tmuxOvunque(
  dataDir: string,
  args: string[],
  opts?: { timeout?: number; maxBuffer?: number },
): Promise<string> {
  const fonti: (PersonaUnix | null)[] = [null, ...(await tuttePersoneUnix(dataDir))]
  const righe: string[] = []
  for (const fonte of fonti) {
    const c = comeLaPersona(fonte, [TMUX_BIN, ...args])
    try {
      const { stdout } = await execFileAsync(c.file, c.args, { encoding: 'utf8', ...opts })
      righe.push(...String(stdout).trim().split('\n').filter(Boolean))
    } catch {
      /* nessun server tmux per questo utente */
    }
  }
  return righe.join('\n')
}
