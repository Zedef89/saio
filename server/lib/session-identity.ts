/**
 * Dice alla sessione CHI la sta usando.
 *
 * ## Il problema
 *
 * La CLI si presenta col titolare dell'**abbonamento Anthropic** della config dir con cui e'
 * stata lanciata ("Welcome back, Alessandro Pisano!"), e la sessione lo prende per la persona
 * al lavoro. Ma su questa devbox gli abbonamenti sono un modo di pagare i token, non un
 * elenco di persone: `.claude-c` e' intestato a un account, mentre chi scrive i prompt e'
 * chiunque sia loggato in SAIO in quel momento.
 *
 * Il risultato si e' visto il 01/09/2026: due sessioni si sono annunciate a vicenda come "di
 * Alessandro" e "di Andrea" mentre ai due terminali c'erano Nicola e Alberto. Da li' in poi
 * ogni cosa che dipende dalla persona — annunciarsi alle altre sessioni, firmare il lavoro,
 * scegliere l'identita' git — parte da un nome sbagliato.
 *
 * ## La soluzione
 *
 * SAIO sa chi e' collegato (`req.user.email`, l'utente autenticato) e lo dice alla sessione
 * al momento dello spawn, con `--append-system-prompt`. E' la stessa fonte da cui esce gia'
 * l'identita' git del worktree e il prefisso del nome della sessione: una sola anagrafica,
 * non tre.
 *
 * Il testo passa da un **file** letto dalla riga di comando (`"$(cat …)"`) invece che inline:
 * i punti di spawn compongono stringhe di shell annidate (tmux send-keys dentro un comando
 * gia' fra apici) e un apostrofo in "l'account" basterebbe a rompere il comando. Un percorso
 * senza spazi passa indenne da tutti i livelli di quoting.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getIdentity } from './worktree'
import { logger } from './logger'

/** Percorsi che attraversano `sh -c`, `tmux send-keys` e apici annidati senza doverli citare. */
const SHELL_SAFE = /^[A-Za-z0-9/._-]+$/

/**
 * Dove finiscono i file di identita'. Il data dir e' la scelta naturale, ma nel bundle macOS
 * contiene uno spazio ("Application Support") e romperebbe la riga di comando: in quel caso
 * si ripiega sulla tmp dir, che non ne ha su nessuna piattaforma.
 */
function identityDir(dataDir: string): string {
  const preferred = path.join(dataDir, 'session-identity')
  return SHELL_SAFE.test(preferred) ? preferred : path.join(os.tmpdir(), 'saio-session-identity')
}

/**
 * Il testo consegnato alla sessione. Non dice solo il nome giusto: dice anche da dove viene
 * quello sbagliato, altrimenti la sessione si trova due identita' in conflitto (il saluto
 * della CLI e questa nota) senza sapere quale delle due vince.
 */
export function identityPrompt(person: { name: string; email: string }): string {
  return [
    '# Chi sta usando questa sessione',
    '',
    `Questa sessione è stata aperta da SAIO da **${person.name}** (${person.email}).`,
    'È la persona che scrive i prompt: usa questo nome quando ti annunci alle altre sessioni',
    "(ListAgents/SendMessage), quando firmi il lavoro e quando parli dell'utente.",
    '',
    'Il nome che la CLI mostra nel saluto di benvenuto ("Welcome back, …") è il titolare',
    "dell'abbonamento Anthropic che paga i token di questa sessione. È una voce di spesa, non",
    'una persona presente: non usarlo mai per capire chi ti sta parlando, né per scegliere',
    "l'identità dei commit. Gli abbonamenti sono condivisi, le persone no.",
    '',
    "L'identità git di questo worktree è già impostata da SAIO sulla persona qui sopra:",
    'non cambiarla e non usare `git config --global`.',
  ].join('\n')
}

/**
 * Scrive il file di identita' della persona e ne restituisce il percorso. Un file per persona
 * (non per sessione): il contenuto dipende solo da chi e' collegato, e riscriverlo a ogni
 * spawn lo tiene allineato se il nome cambia in `git-identities.json`.
 *
 * Restituisce null se non si sa chi e' collegato o se il percorso non e' passabile alla shell:
 * meglio una sessione senza la nota che un comando di spawn rotto.
 */
export async function writeIdentityFile(
  dataDir: string,
  email: string | null | undefined,
  /**
   * Dove scrivere la nota, quando la dataDir non va bene.
   *
   * Serve per chi ha un utente Unix suo: la dataDir sta sotto `/root` (`700`), e la sua
   * sessione — che root non e' — non riuscirebbe a leggere il file. Il sintomo sarebbe muto:
   * `"$(cat …)"` diventa una stringa vuota e la sessione parte senza sapere chi ha davanti.
   */
  dirOverride?: string,
): Promise<string | null> {
  if (!email || email === 'unknown') return null
  try {
    const identity = await getIdentity(dataDir, email)
    const dir = dirOverride || identityDir(dataDir)
    const file = path.join(dir, `${identity.slug}.md`)
    if (!SHELL_SAFE.test(file)) {
      logger.warn(`[identity] percorso non passabile alla shell, nota saltata: ${file}`)
      return null
    }
    await fs.mkdir(dir, { recursive: true })
    // Nome dal mapping, email quella con cui la persona e' entrata in SAIO: `identity.email`
    // e' l'indirizzo dei COMMIT, che per qualcuno e' diverso da quello di login (Alberto
    // firma da Epicode) e come "chi ti sta parlando" sarebbe fuorviante.
    await fs.writeFile(file, identityPrompt({ name: identity.name, email: email.trim() }), 'utf8')
    return file
  } catch (err) {
    logger.warn(`[identity] impossibile preparare la nota per ${email}:`, err)
    return null
  }
}

/**
 * Aggiunge la nota a un comando `claude` gia' composto, per i punti di spawn che costruiscono
 * la riga a mano (pagina Sessioni, card→tmux, cambio account). Speculare a
 * `withPermissionMode` di pty-manager, e come quello non fa niente se non c'e' niente da dire.
 */
export function withIdentityFile(cmd: string, identityFile: string | null): string {
  if (!identityFile) return cmd
  return `${cmd} --append-system-prompt "$(cat ${identityFile})"`
}

/**
 * Gli stessi argomenti per gli spawn che passano un array invece di una stringa di shell:
 * li' il testo viaggia diretto, senza file e senza quoting.
 */
export async function identityArgs(dataDir: string, email: string | null | undefined): Promise<string[]> {
  if (!email || email === 'unknown') return []
  try {
    const identity = await getIdentity(dataDir, email)
    return ['--append-system-prompt', identityPrompt({ name: identity.name, email: email.trim() })]
  } catch {
    return []
  }
}
