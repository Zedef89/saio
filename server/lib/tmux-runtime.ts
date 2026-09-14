/**
 * Che cosa sta facendo davvero ogni sessione tmux: su quale account Claude gira e se in
 * questo momento sta lavorando o e' ferma ad aspettarti.
 *
 * Serve a decidere a colpo d'occhio, dalla lista sessioni, se vale la pena aprirne una:
 * un account a limite esaurito non produrra' nulla, e una sessione che sta ancora scrivendo
 * non ha bisogno di te.
 *
 * Tutto si ricava dal sistema, senza stato da mantenere: l'account dall'ambiente del processo
 * `claude` (CLAUDE_CONFIG_DIR), l'attivita' dalla videata della pane. Nessun registro da tenere
 * allineato, quindi funziona anche per le sessioni aperte a mano da SSH.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { TMUX_BIN } from './tmux-bin'
import { listClaudeAccounts, type ClaudeAccount } from './claude-accounts'
import { logger } from './logger'

const execFileAsync = promisify(execFile)

/** La dataDir, per sapere chi ha un utente Unix suo (e quindi un socket tmux suo). */
function DATA_DIR(): string {
  return process.env.DASHBOARD_DATA_DIR || path.join(process.cwd(), 'data')
}

/**
 * `waiting` e' lo stato che conta di piu': Claude non sta lavorando e non ha finito — e' fermo
 * su una domanda e aspetta una risposta. Senza distinguerlo da `idle` la sessione sembra a posto
 * e resta bloccata anche per ore.
 */
export type SessionActivity = 'working' | 'waiting' | 'idle' | 'shell'

export interface SessionAccountInfo {
  id: string
  label: string
  email: string | null
  weeklyPercent: number | null
  severity: 'normal' | 'warning' | 'critical' | null
  /** Finestra settimanale finita: aprire la sessione non serve a niente finche' non si resetta. */
  exhausted: boolean
  resetsAt: string | null
}

/**
 * La sessione e' ferma sul limite dell'account ("You've hit your session limit · resets
 * 11:40am (UTC)"). Non e' `waiting`: non aspetta te, aspetta l'ora scritta li'. Da quell'ora
 * basta un messaggio per farla ripartire — lo manda lib/limit-resume.ts.
 */
export interface SessionLimit {
  /** `session` (finestra di 5 ore), `weekly`, o quello che la CLI scrive al posto loro. */
  kind: string
  /** Quando si sblocca, in ISO. */
  resetsAt: string
}

export interface SessionRuntime {
  account: SessionAccountInfo | null
  activity: SessionActivity
  limit: SessionLimit | null
}

/**
 * La UI di Claude Code mostra "esc to interrupt" solo mentre sta effettivamente elaborando.
 * E' il segnale piu' affidabile che abbiamo dall'esterno: non dipende dal carico CPU (che e'
 * a zero mentre aspetta la risposta dall'API) ne' dai processi figli (che spesso non ci sono).
 */
const WORKING_RE = /esc to interrupt/i

/**
 * Lo spinner sopra la casella: "✢ Meandering… (3m 17s · ↓ 3.4k tokens)". C'e' per tutto il
 * tempo in cui elabora, mentre "esc to interrupt" col piè di pagina pieno ("6 memories
 * recalled") la CLI 2.1.260 non lo scrive — albatros lavorava da minuti e la card la dava
 * libera. Finito il turno diventa "✻ Cooked for 3m · done", che non ha il cronometro fra parentesi.
 */
const SPINNER_RE = /^\s*\S\s+[A-Z][\w-]*(?:…|\.\.\.)\s*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/

/** Domande esplicite, con o senza menu numerato. */
const ASK_RE = /do you want to proceed|do you want to|vuoi (che|procedere)|\(y\/n\)|press enter to continue|esc to cancel/i

/**
 * Menu di scelta del TUI: opzioni numerate consecutive, corte, con il cursore `❯` su una.
 * Le tre condizioni insieme evitano di scambiare per menu un elenco scritto da Claude
 * ("i 5 passi: 1. ... 2. ..."). Stessa euristica gia' usata dalla chat in EmbeddedChat.tsx.
 */
function looksLikeChoiceMenu(screen: string): boolean {
  const lines = screen.split('\n').slice(-20)
  const found: { idx: number; len: number; marker: boolean }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:❯\s*)?([1-9])[.)]\s+(.+?)\s*$/)
    if (m) found.push({ idx: i, len: m[2].length, marker: /^\s*❯/.test(lines[i]) })
  }
  if (found.length < 2 || found.length > 6) return false
  if (!found.some((f) => f.marker)) return false
  if (found.reduce((a, f) => a + f.len, 0) / found.length > 45) return false
  for (let i = 1; i < found.length; i++) if (found[i].idx - found[i - 1].idx > 2) return false
  return true
}

/**
 * Riconosce la UI di Claude ferma al prompt. La barra di stato cambia forma a seconda di
 * cosa e' attivo ("shift+tab to cycle", "1 shell", "↓ to manage"), quindi si controllano piu'
 * ancore: se nessuna compare, nella pane non c'e' Claude ma una shell. Con una shell in
 * background il "(shift+tab to cycle)" sparisce e resta solo "bypass permissions on · 1 shell".
 */
const CLAUDE_UI_RE = /auto mode on|bypass permissions|shift\+tab to cycle|for agents|\/(status|effort)\b/i

/**
 * Claude ha lanciato un workflow e aspetta che finisca: "✻ Waiting for 1 dynamic workflow to
 * finish". Sta lavorando anche se "esc to interrupt" non c'e' — e aprirla non serve a niente.
 * Conta solo come ULTIMA riga prima della casella: finito il workflow, la stessa frase resta
 * piu' in alto nella videata.
 */
const WORKFLOW_WAIT_RE = /waiting for \d+ (?:dynamic )?workflows? to finish/i

/** Workflow in corso nel piè di pagina: "◯ nome… 21/103 agents done · 7m 28s". */
const WORKFLOW_RUNNING_RE = /(\d+)\/(\d+) agents done/i

/**
 * "You've hit your session limit · resets 11:40am (UTC)" e
 * "You've hit your weekly limit · resets Aug 28, 9am (UTC)": sono le due forme trovate in
 * migliaia di transcript sulla devbox. Il fuso fra parentesi e' sempre UTC, ma si accetta
 * qualunque fuso IANA.
 */
const LIMIT_RE =
  /hit your ([a-z-]+(?: [a-z-]+)?) limit\s*[·∙•]\s*resets\s+(?:([A-Za-z]{3})[a-z]*\.? (\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i

const SEPARATOR_RE = /^\s*─{20,}\s*$/

/**
 * La videata in tre parti: la conversazione, la casella dove si scrive (fra le ultime due
 * righe di ─) e il piè di pagina. Senza la casella (TUI non ancora disegnata) e' tutto
 * conversazione.
 */
function splitScreen(screen: string): { convo: string[]; input: string[]; footer: string[] } {
  const lines = screen.split('\n')
  const seps: number[] = []
  lines.forEach((l, i) => SEPARATOR_RE.test(l) && seps.push(i))
  if (seps.length < 2) return { convo: lines, input: [], footer: [] }
  const [a, b] = seps.slice(-2)
  return { convo: lines.slice(0, a), input: lines.slice(a + 1, b), footer: lines.slice(b + 1) }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Scarto fra il fuso e UTC in quell'istante, in ms. Fuso sconosciuto: alza. */
function tzOffsetMs(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(at))
  const p = (t: string) => Number(parts.find((x) => x.type === t)?.value)
  return Date.UTC(p('year'), p('month') - 1, p('day'), p('hour'), p('minute'), p('second')) - Math.floor(at / 1000) * 1000
}

/** Ora "da muro" in quel fuso → istante UTC. */
function zonedToUtc(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo, d, h, mi)
  return guess - tzOffsetMs(timeZone, guess)
}

/**
 * L'istante del reset scritto nel messaggio. Senza data ("resets 11:40am") il giorno si
 * deduce: e' il prossimo 11:40 se cade entro la finestra del limite (5 ore per quello di
 * sessione, un giorno per gli altri), altrimenti l'11:40 gia' passato — il limite si e' gia'
 * sbloccato e la sessione e' ferma solo perche' nessuno le ha scritto.
 */
export function resolveLimitReset(
  m: { kind: string; month?: string; day?: string; hour: string; minute?: string; ampm: string; tz: string },
  now = Date.now(),
): number | null {
  const tz = m.tz.trim()
  let h = Number(m.hour) % 12
  if (m.ampm.toLowerCase() === 'pm') h += 12
  const mi = Number(m.minute || 0)
  try {
    const today = new Date(now + tzOffsetMs(tz, now)) // "adesso" letto sull'orologio di quel fuso
    const y = today.getUTCFullYear()
    if (m.month && m.day) {
      const mo = MONTHS.indexOf(m.month.slice(0, 3).toLowerCase())
      if (mo < 0) return null
      const at = zonedToUtc(tz, y, mo, Number(m.day), h, mi)
      // "resets Jan 2" letto il 30 dicembre e' dell'anno dopo.
      return at < now - 180 * 86_400_000 ? zonedToUtc(tz, y + 1, mo, Number(m.day), h, mi) : at
    }
    const window = /session/i.test(m.kind) ? 6 * 3_600_000 : 25 * 3_600_000
    const candidates = [-1, 0, 1].map((dd) => zonedToUtc(tz, y, today.getUTCMonth(), today.getUTCDate() + dd, h, mi))
    const future = candidates.find((c) => c > now && c <= now + window)
    if (future) return future
    return Math.max(...candidates.filter((c) => c <= now))
  } catch {
    return null // fuso che Intl non conosce: meglio nessuna ripresa che una all'ora sbagliata
  }
}

/**
 * Il limite e' lo stato ATTUALE della sessione solo se dopo il messaggio non c'e' stato altro:
 * ne' un messaggio tuo ("❯ riprendi") ne' una risposta di Claude. Restano ammessi gli avvisi
 * di fine workflow, che arrivano anche mentre la sessione e' ferma e portano lo stesso limite.
 */
function currentLimit(convo: string[], now: number): SessionLimit | null {
  let idx = -1
  let m: RegExpMatchArray | null = null
  for (let i = convo.length - 1; i >= 0; i--) {
    const hit = convo[i].match(LIMIT_RE)
    if (hit) {
      idx = i
      m = hit
      break
    }
  }
  if (!m) return null
  for (const l of convo.slice(idx + 1)) {
    if (/^\s*❯\s*\S/.test(l)) return null
    if (/^\s*●\s/.test(l) && !/^\s*●\s*Dynamic workflow\b/i.test(l)) return null
  }
  const at = resolveLimitReset(
    { kind: m[1], month: m[2], day: m[3], hour: m[4], minute: m[5], ampm: m[6], tz: m[7] },
    now,
  )
  return at == null ? null : { kind: m[1].toLowerCase(), resetsAt: new Date(at).toISOString() }
}

export interface ScreenState {
  activity: SessionActivity
  limit: SessionLimit | null
  /** Nella casella c'e' gia' del testo: scriverci sopra lo mescolerebbe con il tuo. */
  inputDirty: boolean
}

/** Colori e link (OSC 8) di `capture-pane -e`: per leggere il testo servono via. */
const stripAnsi = (s: string) => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

/**
 * Tutto quello che si ricava da una videata catturata CON i colori (`capture-pane -e`).
 * Pura: la si prova su una videata salvata.
 */
export function classifyScreen(raw: string, now = Date.now()): ScreenState {
  const screen = stripAnsi(raw)
  const { convo, footer } = splitScreen(screen)
  // Dopo una risposta la CLI scrive nella casella, in grigio (`\x1b[2m`), il messaggio che si
  // aspetta: non l'ha battuto nessuno. Si toglie il grigio, e quello che resta e' di una persona.
  // Stessa regola di rigaOccupata in prompt-in-sessione.ts (ramo semiloop-revisioni).
  const input = splitScreen(raw.replace(/\x1b\[2m.*?(?:\x1b\[(?:0|22)m|$)/gm, '')).input.map(stripAnsi)
  const inputDirty = input.some((l) => l.replace(/^\s*❯/, '').replace(/ /g, ' ').trim() !== '')
  // "Jump to bottom": la TUI e' scrollata indietro e mostra roba vecchia — un limite o un
  // "waiting for workflow" li' non dicono niente dello stato di adesso.
  const scrolled = /jump to bottom/i.test(screen)
  const limit = scrolled ? null : currentLimit(convo, now)
  const lastConvo = scrolled ? '' : convo.filter((l) => l.trim()).pop() || ''
  const workflowRunning = footer.some((l) => {
    const w = l.match(WORKFLOW_RUNNING_RE)
    return !!w && Number(w[1]) < Number(w[2])
  })
  let activity: SessionActivity
  // Un menu del TUI blocca davvero la sessione: vale anche se in videata resta un
  // "esc to interrupt" di poco prima.
  if (looksLikeChoiceMenu(screen)) activity = 'waiting'
  // Se sta elaborando, sta elaborando: una domanda piu' in alto e' quella a cui hai gia'
  // risposto, e senza questa precedenza la card direbbe "aspetta te" mentre lavora.
  else if (
    WORKING_RE.test(screen) ||
    WORKFLOW_WAIT_RE.test(lastConvo) ||
    workflowRunning ||
    // Sotto lo spinner puo' esserci un "⎿ Tip: …": si guardano le ultime righe, non solo l'ultima.
    (!scrolled && convo.filter((l) => l.trim()).slice(-6).some((l) => SPINNER_RE.test(l)))
  )
    activity = 'working'
  // Domanda in chiaro senza menu ("vuoi che…?"): conta solo se e' l'ultima cosa a schermo.
  else if (ASK_RE.test(screen.split('\n').filter((l) => l.trim()).slice(-8).join('\n'))) activity = 'waiting'
  else activity = CLAUDE_UI_RE.test(screen) ? 'idle' : 'shell'
  return { activity, limit, inputDirty }
}

export interface ProcRow {
  pid: number
  ppid: number
  args: string
}

/** Un solo `ps` per tutto l'albero: N sessioni non significano N fork. */
export async function processTable(): Promise<ProcRow[]> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,args='], { timeout: 5000, maxBuffer: 4_000_000 })
  const rows: ProcRow[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] })
  }
  return rows
}

/** Il processo `claude` piu' vicino alla shell della pane (discesa a profondita' limitata). */
export function findClaudePid(rows: ProcRow[], panePid: number): number | null {
  const byParent = new Map<number, ProcRow[]>()
  for (const r of rows) {
    const arr = byParent.get(r.ppid)
    if (arr) arr.push(r)
    else byParent.set(r.ppid, [r])
  }
  let frontier = [panePid]
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next: number[] = []
    for (const pid of frontier) {
      for (const child of byParent.get(pid) || []) {
        // `node .../claude`, `claude`, `bun .../cli.js`: basta che il comando nomini claude.
        if (/(^|\/|\s)claude(\s|$)|claude-code|\/claude\b/.test(child.args)) return child.pid
        next.push(child.pid)
      }
    }
    frontier = next
  }
  return null
}

/**
 * `CLAUDE_CONFIG_DIR` del processo: e' cio' che distingue un account dall'altro. Su Linux si
 * legge da /proc; altrove si ripiega su `ps eww`, che espone l'ambiente nella riga di comando.
 */
export async function readConfigDir(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'linux') {
      const raw = await fs.readFile(`/proc/${pid}/environ`, 'utf8')
      const hit = raw.split('\0').find((e) => e.startsWith('CLAUDE_CONFIG_DIR='))
      return hit ? hit.slice('CLAUDE_CONFIG_DIR='.length) : null
    }
    const { stdout } = await execFileAsync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { timeout: 3000 })
    const m = stdout.match(/CLAUDE_CONFIG_DIR=(\S+)/)
    return m ? m[1] : null
  } catch {
    // Processo gia' uscito o ambiente non leggibile: si ricade sull'account di default.
    return null
  }
}

/** Config dir → slot: `~/.claude` = default, `~/.claude-<slot>` = quello slot. */
export function slotFromConfigDir(configDir: string | null): string {
  if (!configDir) return 'default'
  const base = path.basename(configDir.replace(/\/+$/, ''))
  const m = /^\.claude-(.+)$/.exec(base)
  return m ? m[1] : 'default'
}

function toAccountInfo(acc: ClaudeAccount | undefined, slot: string): SessionAccountInfo | null {
  if (!acc) return { id: slot, label: slot, email: null, weeklyPercent: null, severity: null, exhausted: false, resetsAt: null }
  return {
    id: acc.id,
    label: acc.label,
    email: acc.email,
    weeklyPercent: acc.usage?.weeklyPercent ?? null,
    severity: acc.usage?.severity ?? null,
    // >=100% e' il caso in cui la sessione risponderebbe solo "You've hit your weekly limit".
    exhausted: (acc.usage?.weeklyPercent ?? 0) >= 100,
    resetsAt: acc.usage?.weeklyResetsAt ?? null,
  }
}

/** La videata della sessione, letta e classificata. Si guarda lo schermo, non il carico: mentre aspetta l'API la CPU e' a zero. */
export async function readScreen(session: string, dataDir = DATA_DIR()): Promise<ScreenState> {
  try {
    // Il target va chiuso con i due punti (`=nome:`): senza, tmux non risolve la finestra corrente
    // della sessione e capture-pane torna vuoto — ogni sessione sembrerebbe una shell.
    const { tmuxSuSessione } = await import('./tmux-cmd')
    // `-e`: i colori servono a distinguere il suggerimento grigio della CLI da una frase battuta.
    const { stdout } = await tmuxSuSessione(dataDir, session, ['capture-pane', '-p', '-e', '-t', `=${session}:`], { timeout: 4000, maxBuffer: 2_000_000 })
    return classifyScreen(stdout)
  } catch {
    return { activity: 'shell', limit: null, inputDirty: false }
  }
}

/** Sta elaborando? */
export async function readActivity(session: string, dataDir = DATA_DIR()): Promise<SessionActivity> {
  return (await readScreen(session, dataDir)).activity
}

/**
 * Runtime di tutte le sessioni, in una passata: mappa nome-sessione → {account, activity}.
 * Non solleva mai: se qualcosa non e' leggibile, quella sessione resta senza dati extra e la
 * lista continua a funzionare come prima.
 */
export async function sessionRuntimes(dataDir = DATA_DIR()): Promise<Record<string, SessionRuntime>> {
  const out: Record<string, SessionRuntime> = {}
  try {
    const { tmuxOvunque } = await import('./tmux-cmd')
    const stdout = await tmuxOvunque(dataDir, ['list-panes', '-a', '-F', '#{session_name}|#{pane_pid}'], { timeout: 4000 })
    const panes = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, pid] = l.split('|')
        return { name, pid: Number(pid) }
      })
      .filter((p) => p.name && p.pid)
    if (!panes.length) return out

    const [rows, accounts] = await Promise.all([processTable(), listClaudeAccounts()])
    const byId = new Map(accounts.map((a) => [a.id, a]))

    await Promise.all(
      panes.map(async (pane) => {
        if (out[pane.name]) return // una sola window per sessione: la prima basta
        const claudePid = findClaudePid(rows, pane.pid)
        let account: SessionAccountInfo | null = null
        if (claudePid) {
          const slot = slotFromConfigDir(await readConfigDir(claudePid))
          account = toAccountInfo(byId.get(slot), slot)
        }
        const screen = claudePid ? await readScreen(pane.name) : null
        out[pane.name] = { account, activity: screen?.activity ?? 'shell', limit: screen?.limit ?? null }
      })
    )
  } catch (err) {
    logger.warn(`[tmux-runtime] runtime sessioni non disponibile: ${String(err).slice(0, 200)}`)
  }
  return out
}
