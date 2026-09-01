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

export interface SessionRuntime {
  account: SessionAccountInfo | null
  activity: SessionActivity
}

/**
 * La UI di Claude Code mostra "esc to interrupt" solo mentre sta effettivamente elaborando.
 * E' il segnale piu' affidabile che abbiamo dall'esterno: non dipende dal carico CPU (che e'
 * a zero mentre aspetta la risposta dall'API) ne' dai processi figli (che spesso non ci sono).
 */
const WORKING_RE = /esc to interrupt/i

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
 * ancore: se nessuna compare, nella pane non c'e' Claude ma una shell.
 */
const CLAUDE_UI_RE = /auto mode on|shift\+tab to cycle|for agents|\/(status|effort)\b/i

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

/** Sta elaborando? Si guarda la videata, non il carico: mentre aspetta l'API la CPU e' a zero. */
export async function readActivity(session: string): Promise<SessionActivity> {
  try {
    // Il target va chiuso con i due punti (`=nome:`): senza, tmux non risolve la finestra corrente
    // della sessione e capture-pane torna vuoto — ogni sessione sembrerebbe una shell.
    const { stdout } = await execFileAsync(TMUX_BIN, ['capture-pane', '-p', '-t', `=${session}:`], { timeout: 4000, maxBuffer: 2_000_000 })
    // Un menu del TUI blocca davvero la sessione: vale anche se in videata resta un
    // "esc to interrupt" di poco prima.
    if (looksLikeChoiceMenu(stdout)) return 'waiting'
    // Se sta elaborando, sta elaborando: una domanda piu' in alto e' quella a cui hai gia'
    // risposto, e senza questa precedenza la card direbbe "aspetta te" mentre lavora.
    if (WORKING_RE.test(stdout)) return 'working'
    // Domanda in chiaro senza menu ("vuoi che…?"): conta solo se e' l'ultima cosa a schermo.
    const coda = stdout.split('\n').filter((l) => l.trim()).slice(-8).join('\n')
    if (ASK_RE.test(coda)) return 'waiting'
    return CLAUDE_UI_RE.test(stdout) ? 'idle' : 'shell'
  } catch {
    return 'shell'
  }
}

/**
 * Runtime di tutte le sessioni, in una passata: mappa nome-sessione → {account, activity}.
 * Non solleva mai: se qualcosa non e' leggibile, quella sessione resta senza dati extra e la
 * lista continua a funzionare come prima.
 */
export async function sessionRuntimes(): Promise<Record<string, SessionRuntime>> {
  const out: Record<string, SessionRuntime> = {}
  try {
    const { stdout } = await execFileAsync(
      TMUX_BIN,
      ['list-panes', '-a', '-F', '#{session_name}|#{pane_pid}'],
      { timeout: 4000 }
    )
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
        out[pane.name] = { account, activity: claudePid ? await readActivity(pane.name) : 'shell' }
      })
    )
  } catch (err) {
    logger.warn(`[tmux-runtime] runtime sessioni non disponibile: ${String(err).slice(0, 200)}`)
  }
  return out
}
