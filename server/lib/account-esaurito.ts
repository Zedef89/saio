/**
 * Quando l'abbonamento di una sessione finisce i token, la sessione non muore: resta li',
 * viva e muta, e a chi le ha appena scritto sembra che stia lavorando.
 *
 * E' il modo piu' silenzioso di perdere un lavoro. Una sessione aperta da un timer non ha
 * nessuno davanti che legga «You've hit your session limit», e il prompt che le e' stato
 * appena consegnato resta li' senza che nessuno lo raccolga — misurato: una revisione su
 * undici, e se ne e' accorto solo un controllo a mano.
 *
 * Qui c'e' il ricambio: si riconosce il messaggio del limite, si sceglie l'abbonamento meno
 * carico fra quelli che ne hanno ancora, e si sposta la sessione — con la conversazione, che
 * `switchSessionAccount` porta dietro. Il prompt lo rimanda chi ha chiamato.
 */
import { tmuxSuSessione } from './tmux-cmd'
import { logger } from './logger'

/**
 * Le forme in cui la CLI dice «non posso lavorare». Sono tre limiti diversi (sessione da
 * cinque ore, uso settimanale, credito) e vale la pena riconoscerli tutti: il rimedio e' lo
 * stesso, cambiare abbonamento.
 */
const LIMITE_RE = /hit your (session|usage|weekly) limit|usage limit reached|limite settimanale|out of credit/i

/** Sopra questa soglia un abbonamento non e' un ricambio: e' il prossimo a fermarsi. */
const SOGLIA_CARICO = 95

export type EsitoCambio =
  | { cambiato: true; da: string; a: string }
  | { cambiato: false; motivo: 'non_esaurito' | 'nessun_ricambio' | 'errore'; dettaglio?: string }

/** La sessione ha finito i token? Si guarda quello che c'e' scritto a schermo. */
export async function esaurita(dataDir: string, name: string): Promise<boolean> {
  try {
    const { stdout } = await tmuxSuSessione(dataDir, name, ['capture-pane', '-p', '-t', `=${name}:`], { timeout: 4000 })
    return LIMITE_RE.test(stdout)
  } catch {
    return false
  }
}

/**
 * Sposta la sessione sull'abbonamento meno carico, se serve e se ce n'e' uno.
 *
 * Non tocca niente quando la sessione sta bene (`non_esaurito`): e' pensata per essere
 * chiamata sempre, subito dopo aver scritto in una sessione, senza doverci pensare.
 */
export async function cambiaSeEsaurito(dataDir: string, name: string): Promise<EsitoCambio> {
  if (!(await esaurita(dataDir, name))) return { cambiato: false, motivo: 'non_esaurito' }

  try {
    const { sessionRuntimes } = await import('./tmux-runtime')
    const { listClaudeAccounts } = await import('./claude-accounts')
    const { switchSessionAccount } = await import('./session-account-switch')

    const attuale = (await sessionRuntimes(dataDir))[name]?.account?.id || null
    // Si guardano tutti e due i contatori: quello settimanale e quello della finestra di
    // cinque ore. Un abbonamento al 10% sulla settimana puo' avere la sessione piena, ed e'
    // esattamente il muro contro cui si e' appena fermata quella da sostituire.
    const carico = (a: { usage: { weeklyPercent: number; sessionPercent: number } | null }) =>
      Math.max(a.usage?.weeklyPercent ?? 0, a.usage?.sessionPercent ?? 0)
    const liberi = (await listClaudeAccounts(true))
      .filter((a) => a.id !== attuale && a.usage && carico(a) < SOGLIA_CARICO)
      .sort((a, b) => carico(a) - carico(b))

    if (!liberi.length) {
      logger.warn(`[account] ${name}: abbonamento finito e nessun ricambio sotto il ${SOGLIA_CARICO}%`)
      return { cambiato: false, motivo: 'nessun_ricambio' }
    }

    const scelto = liberi[0]
    // `force` non scavalca nessuno: la sessione qui NON sta lavorando, sta ferma contro un
    // muro. Senza il flag lo switch si rifiuterebbe di toccarla se la videata le somiglia.
    const r = await switchSessionAccount(name, scelto.id, { force: true })
    if (!('ok' in r) || !r.ok) {
      return { cambiato: false, motivo: 'errore', dettaglio: (r as { message?: string }).message }
    }
    logger.info(`[account] ${name}: ${attuale || '?'} finito → passata a ${scelto.id} (settimana ${scelto.usage?.weeklyPercent ?? '?'}%, sessione ${scelto.usage?.sessionPercent ?? '?'}%)`)
    return { cambiato: true, da: attuale || '?', a: scelto.id }
  } catch (err) {
    return { cambiato: false, motivo: 'errore', dettaglio: (err as Error).message }
  }
}
