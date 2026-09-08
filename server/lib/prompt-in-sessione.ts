/**
 * Mandare un prompt dentro una sessione tmux che sta gia' girando.
 *
 * Serve a chi apre sessioni senza nessuno davanti (il semi-loop delle revisioni: arriva un
 * round nuovo, parte una sessione col nome del ristorante e il lavoro da fare). Due cose che
 * sembrano dettagli e non lo sono:
 *
 * 1. **Non si scrive con `send-keys` il testo del prompt.** Ogni "a capo" diventa un Invio,
 *    quindi un prompt di venti righe verrebbe spedito venti volte a meta'. Si passa dal
 *    buffer di tmux (`load-buffer` + `paste-buffer -p`), che e' un incollaggio vero: la CLI
 *    lo riceve in bracketed paste e resta una cosa sola. L'Invio lo si manda dopo, apposta.
 * 2. **Non si scrive dentro una sessione che sta lavorando.** Se in quel momento c'e' un menu
 *    o una domanda a schermo, il testo diventa la risposta a quella domanda. `readActivity`
 *    sa gia' distinguere `idle` da `working`/`waiting`: si invia solo su `idle`, e a chi
 *    chiama si dice «occupata, riprova» — il chiamante e' un timer, ripassa fra un minuto.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tmuxSuSessione } from './tmux-cmd'
import { readActivity } from './tmux-runtime'
import { logger } from './logger'

export type EsitoPrompt =
  | { ok: true }
  | { ok: false; motivo: 'occupata' | 'non_pronta' | 'errore'; dettaglio?: string }

/**
 * 🔴 La seconda prova che la sessione sta lavorando, e serve davvero.
 *
 * `readActivity` riconosce «sta elaborando» dalla barra di stato, che a pane stretta la CLI
 * **tronca**: `esc to interrupt` diventa `esc …`, la regex non aggancia piu' niente e una
 * sessione in pieno lavoro viene data per `idle`. Non e' un caso di laboratorio: una sessione
 * aperta da un timer non ha nessun client attaccato, resta larga quanto il terminale che l'ha
 * creata, ed e' esattamente il caso in cui qualcuno le scriverebbe dentro.
 *
 * Restano due firme corte, che la larghezza non porta via: il conto dei secondi accanto allo
 * spinner (`(21s ·`), e — anche quando la CLI e' scrollata e lo spinner non e' in videata —
 * il `· esc` della barra, che compare SOLO mentre c'e' qualcosa da interrompere.
 */
const STA_LAVORANDO_RE = /\(\d+s\s*·|[✻✽✢∗⋆]\s*\S+…|·\s*esc\b/

async function videataDiceLavoro(dataDir: string, name: string): Promise<boolean> {
  try {
    const { stdout } = await tmuxSuSessione(dataDir, name, ['capture-pane', '-p', '-t', `=${name}:`], { timeout: 4000 })
    return STA_LAVORANDO_RE.test(stdout)
  } catch {
    return false
  }
}

/**
 * Aspetta che la CLI sia sveglia e ferma al prompt.
 *
 * Subito dopo `new-session` la pane e' una shell (`shell`) e per qualche secondo la CLI sta
 * ancora aprendo: scrivere li' significa perdere il testo. Non si aspetta all'infinito —
 * se dopo `msMax` non e' pronta, chi chiama lo sa e riprova al giro dopo.
 */
export async function attendiPronta(
  dataDir: string,
  name: string,
  msMax = 90_000,
): Promise<'idle' | 'occupata' | 'non_pronta'> {
  const fine = Date.now() + msMax
  for (;;) {
    const stato = await readActivity(name, dataDir)
    if (stato === 'idle') return (await videataDiceLavoro(dataDir, name)) ? 'occupata' : 'idle'
    // Sta gia' lavorando: e' pronta, ma non e' il momento di scriverle.
    if (stato === 'working' || stato === 'waiting') return 'occupata'
    if (Date.now() >= fine) return 'non_pronta'
    await new Promise((r) => setTimeout(r, 1500))
  }
}

/**
 * Incolla `testo` nella sessione e manda l'Invio.
 *
 * Il testo passa da un file temporaneo invece che dallo stdin perche' `tmuxSuSessione` puo'
 * dover eseguire come un altro utente Unix (le sessioni di chi ha un'area sua vivono sul suo
 * socket): il file e' leggibile da tutti e sparisce subito dopo.
 */
export async function inviaPrompt(
  dataDir: string,
  name: string,
  testo: string,
  opts: { attendi?: boolean; msMax?: number } = {},
): Promise<EsitoPrompt> {
  let stato: string
  if (opts.attendi === false) {
    stato = await readActivity(name, dataDir)
    if (stato === 'idle' && (await videataDiceLavoro(dataDir, name))) stato = 'occupata'
  } else {
    stato = await attendiPronta(dataDir, name, opts.msMax)
  }

  if (stato === 'occupata' || stato === 'working' || stato === 'waiting') {
    return { ok: false, motivo: 'occupata' }
  }
  if (stato !== 'idle') return { ok: false, motivo: 'non_pronta' }

  const file = path.join(os.tmpdir(), `saio-prompt-${process.pid}-${Date.now()}.txt`)
  try {
    fs.writeFileSync(file, testo, { encoding: 'utf8', mode: 0o644 })
    const buf = `saio-${Date.now()}`
    await tmuxSuSessione(dataDir, name, ['load-buffer', '-b', buf, file])
    // `-p` = bracketed paste (la CLI capisce che e' testo incollato, non tasti premuti),
    // `-d` = butta il buffer dopo averlo incollato.
    await tmuxSuSessione(dataDir, name, ['paste-buffer', '-d', '-p', '-b', buf, '-t', `=${name}:`])
    // Un beat prima dell'Invio: la CLI deve aver finito di ridisegnare la riga.
    await new Promise((r) => setTimeout(r, 300))
    await tmuxSuSessione(dataDir, name, ['send-keys', '-t', `=${name}:`, 'Enter'])
    logger.info(`[prompt] "${name}": prompt di ${testo.length} caratteri consegnato`)
    return { ok: true }
  } catch (err) {
    return { ok: false, motivo: 'errore', dettaglio: (err as Error).message }
  } finally {
    try { fs.unlinkSync(file) } catch { /* gia' sparito */ }
  }
}
