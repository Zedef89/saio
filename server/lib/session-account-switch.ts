/**
 * Cambiare l'account Claude di una sessione gia' aperta, portandosi dietro la conversazione.
 *
 * Serve quando un account finisce i token a meta' lavoro: l'alternativa e' aspettare il reset
 * settimanale o ricominciare la chat da zero su un altro account.
 *
 * L'account e' legato alla sessione dal `CLAUDE_CONFIG_DIR` con cui `claude` e' stato lanciato
 * (`system.ts`, creazione sessione) e non esiste modo di cambiarlo a caldo: va fermato e
 * rilanciato. Il punto delicato e' che i transcript vivono DENTRO la cartella dell'account
 * (`<config>/projects/<slug>/<uuid>.jsonl`), quindi ripartire con un altro slot senza spostarli
 * significa perdere la conversazione: per il nuovo account non e' mai esistita.
 *
 * Il transcript viene SPOSTATO, non copiato: altrimenti la stessa chat continuerebbe a esistere
 * in due account e ripartire da quello vecchio creerebbe due rami divergenti. L'originale resta
 * come `.moved-<timestamp>` per poter tornare indietro.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { TMUX_BIN } from './tmux-bin'
import { logger } from './logger'
import { configDirForAccount } from './claude-accounts'
import { withPermissionMode } from './pty-manager'
import { processTable, findClaudePid, readConfigDir, slotFromConfigDir, readActivity } from './tmux-runtime'

const execFileAsync = promisify(execFile)

export interface SwitchResult {
  ok: true
  session: string
  from: string
  to: string
  /** uuid della conversazione portata sul nuovo account, null se non ne e' stata trovata una. */
  transcript: string | null
  cwd: string
}

export interface SwitchError {
  ok: false
  /** `busy` = sta lavorando (si forza), `no_claude`/`unknown_account`/... = errori veri. */
  code: 'busy' | 'no_claude' | 'unknown_account' | 'same_account' | 'not_found' | 'stop_failed'
  message: string
}

/**
 * Slug della cartella transcript: ogni carattere non alfanumerico diventa `-`, trattino
 * iniziale COMPRESO (`/root/dev/x` → `-root-dev-x`). Volutamente diverso da
 * `claudeSlugFromCwd` di pty-manager, che taglia il trattino iniziale e quindi non
 * corrisponde ai nomi reali delle cartelle.
 */
function transcriptSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Istante di avvio del processo, per distinguere i transcript di sessioni diverse sullo stesso repo. */
async function processStartMs(pid: number): Promise<number | null> {
  try {
    if (process.platform !== 'linux') return null
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    // Il campo 22 (starttime) va contato DOPO il comm fra parentesi, che puo' contenere spazi.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = Number(after[19])
    if (!Number.isFinite(ticks)) return null
    const uptime = Number((await fs.readFile('/proc/uptime', 'utf8')).split(' ')[0])
    const hz = 100 // CONFIG_HZ standard su Linux x86_64
    return Date.now() - (uptime - ticks / hz) * 1000
  } catch {
    return null
  }
}

/** Directory di lavoro reale del processo: regge anche i worktree isolati. */
async function processCwd(pid: number): Promise<string | null> {
  try {
    return await fs.readlink(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

/**
 * Righe "riconoscibili" di un testo: abbastanza lunghe da non capitare per caso.
 *
 * Servono a legare una videata a un transcript. Si scartano quelle corte e quelle fatte solo
 * di cornici del TUI, che sono identiche in ogni sessione e farebbero combaciare tutto.
 */
function ancore(testo: string): string[] {
  return testo
    .split('\n')
    .map((l) => l.replace(/[│┃|╭╰─━┈>·•\s]+/g, ' ').trim())
    .filter((l) => l.length >= 28 && /[a-zA-Z]{4}/.test(l))
    .slice(-40)
}

/** Il testo dei messaggi dentro un transcript, per confrontarlo con la videata. */
async function testoDelTranscript(file: string): Promise<string> {
  const raw = await fs.readFile(file, 'utf8').catch(() => '')
  const righe = raw.split('\n').slice(-400)
  const pezzi: string[] = []
  for (const r of righe) {
    if (!r.trim()) continue
    try {
      const o = JSON.parse(r) as { message?: { content?: unknown } }
      const c = o.message?.content
      if (typeof c === 'string') pezzi.push(c)
      else if (Array.isArray(c)) {
        for (const b of c as { type?: string; text?: string }[]) if (b?.type === 'text' && b.text) pezzi.push(b.text)
      }
    } catch {
      /* riga non JSON: si salta */
    }
  }
  return pezzi.join('\n')
}

/**
 * La conversazione in corso in QUESTA pane.
 *
 * Il criterio "il piu' recente toccato dopo l'avvio del processo" non basta, ed e' il bug che
 * il 07/09 ha spostato la chat di una persona dentro la sessione di un'altra: su questa
 * macchina piu' sessioni lavorano sullo stesso repo con lo stesso account — misurate quattro
 * insieme su komanda-dashboard — e quindi condividono la stessa cartella di transcript. Fra
 * due chat entrambe vive, "la piu' recente" e' quella di chi ha scritto per ultimo, che non
 * ha niente a che vedere con chi sta cambiando account. E il transcript viene SPOSTATO: chi
 * lo perde se ne accorge quando la sua chat non c'e' piu'.
 *
 * Quindi, quando i candidati sono piu' d'uno, si guarda cosa c'e' scritto a schermo: la
 * videata della pane appartiene per definizione a questa sessione. Vince il transcript che la
 * contiene. **Se nessuno la contiene, o se pareggiano, non si sceglie**: meglio ripartire
 * senza cronologia che portare via la chat a qualcun altro.
 */
export async function findTranscript(
  configDir: string,
  cwd: string,
  startedMs: number | null,
  videata?: string,
): Promise<string | null> {
  const dir = path.join(configDir, 'projects', transcriptSlug(cwd))
  try {
    const entries = await fs.readdir(dir)
    const candidates: { file: string; mtime: number }[] = []
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const st = await fs.stat(path.join(dir, name)).catch(() => null)
      if (!st) continue
      // Tolleranza: il file nasce qualche istante dopo il processo, mai prima.
      if (startedMs && st.mtimeMs < startedMs - 5000) continue
      candidates.push({ file: name, mtime: st.mtimeMs })
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    if (candidates.length === 0) return null
    if (candidates.length === 1) return candidates[0].file.replace(/\.jsonl$/, '')

    const chiavi = ancore(videata || '')
    if (chiavi.length === 0) {
      logger.warn(`[switch-account] ${candidates.length} chat aperte su ${cwd} e videata illeggibile: riparte senza cronologia invece di indovinare`)
      return null
    }
    const punteggi: { file: string; punti: number }[] = []
    for (const c of candidates.slice(0, 8)) {
      const testo = await testoDelTranscript(path.join(dir, c.file))
      punteggi.push({ file: c.file, punti: chiavi.filter((k) => testo.includes(k)).length })
    }
    punteggi.sort((a, b) => b.punti - a.punti)
    if (punteggi[0].punti === 0 || punteggi[0].punti === punteggi[1]?.punti) {
      logger.warn(`[switch-account] ${candidates.length} chat aperte su ${cwd} e nessuna riconosciuta dalla videata: riparte senza cronologia invece di prendere quella di un altro`)
      return null
    }
    return punteggi[0].file.replace(/\.jsonl$/, '')
  } catch {
    return null
  }
}

/** Quello che si vede adesso nella pane: e' la conversazione di QUESTA sessione, per definizione. */
async function readPaneText(session: string): Promise<string> {
  try {
    const { tmuxSuSessione } = await import('./tmux-cmd')
    const dd = process.env.DASHBOARD_DATA_DIR || path.join(process.cwd(), 'data')
    const { stdout } = await tmuxSuSessione(dd, session, ['capture-pane', '-p', '-S', '-400', '-t', `=${session}:`], {
      timeout: 4000,
      maxBuffer: 2_000_000,
    })
    return stdout
  } catch {
    return ''
  }
}

/** Ferma Claude nella pane lasciando viva la sessione tmux; ritorna false se non esce. */
async function stopClaude(session: string, pid: number): Promise<boolean> {
  const target = `=${session}:`
  // Esc chiude un eventuale menu/prompt aperto, poi /exit e' l'uscita pulita: salva il
  // transcript e restituisce la shell. Un kill secco lascerebbe la chat troncata.
  const { tmuxSuSessione } = await import('./tmux-cmd')
  const dd = process.env.DASHBOARD_DATA_DIR || path.join(process.cwd(), 'data')
  await tmuxSuSessione(dd, session, ['send-keys', '-t', target, 'Escape']).catch(() => {})
  await new Promise((r) => setTimeout(r, 300))
  await tmuxSuSessione(dd, session, ['send-keys', '-t', target, '-l', '/exit']).catch(() => {})
  await tmuxSuSessione(dd, session, ['send-keys', '-t', target, 'Enter']).catch(() => {})
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try {
      await fs.access(`/proc/${pid}`)
    } catch {
      return true // il processo non c'e' piu'
    }
  }
  // Ultima spiaggia: SIGTERM al solo processo claude, la sessione tmux resta.
  try {
    process.kill(pid, 'SIGTERM')
    await new Promise((r) => setTimeout(r, 1500))
    await fs.access(`/proc/${pid}`)
    return false
  } catch {
    return true
  }
}

/**
 * Il progetto va marcato "fidato" nella config di destinazione, altrimenti al riavvio Claude
 * si pianta sul dialog "Is this a project you trust?" e la sessione muore senza spiegazioni.
 */
async function ensureTrusted(configDir: string, cwd: string): Promise<void> {
  const isDefault = path.basename(configDir) === '.claude'
  const jsonPath = isDefault ? path.join(path.dirname(configDir), '.claude.json') : path.join(configDir, '.claude.json')
  try {
    const raw = JSON.parse(await fs.readFile(jsonPath, 'utf8'))
    raw.projects = raw.projects || {}
    const entry = raw.projects[cwd] || {}
    if (entry.hasTrustDialogAccepted) return
    raw.projects[cwd] = {
      allowedTools: [],
      history: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      ...entry,
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: Math.max(1, entry.projectOnboardingSeenCount || 0),
    }
    await fs.writeFile(jsonPath, JSON.stringify(raw, null, 2))
    logger.info(`[switch-account] trust propagato a ${jsonPath} per ${cwd}`)
  } catch (err) {
    logger.warn(`[switch-account] trust non propagato su ${jsonPath}: ${String(err).slice(0, 150)}`)
  }
}

export async function switchSessionAccount(
  session: string,
  targetAccountId: string,
  opts: { force?: boolean; userEmail?: string | null } = {}
): Promise<SwitchResult | SwitchError> {
  const destDir = await configDirForAccount(targetAccountId)
  if (!destDir) return { ok: false, code: 'unknown_account', message: `account sconosciuto: ${targetAccountId}` }
  // Se la sessione e' di una persona con un utente suo, l'account si cambia dentro la SUA
  // config, non in quella condivisa — altrimenti la sessione ripartirebbe scrivendo in una
  // cartella che non le appartiene, e senza permesso di scriverci.
  const { fonteDellaSessione } = await import('./tmux-cmd')
  const { configPerPersona } = await import('./persona-unix')
  const config = configPerPersona(
    await fonteDellaSessione(process.env.DASHBOARD_DATA_DIR || path.join(process.cwd(), 'data'), session),
    destDir,
  )

  // pane della sessione → processo claude che ci gira dentro
  let panePid: number | null = null
  try {
    const { tmuxOvunque } = await import('./tmux-cmd')
    const stdout = await tmuxOvunque(
      process.env.DASHBOARD_DATA_DIR || path.join(process.cwd(), 'data'),
      ['list-panes', '-a', '-F', '#{session_name}|#{pane_pid}'],
      { timeout: 4000 },
    )
    for (const line of stdout.trim().split('\n')) {
      const [name, pid] = line.split('|')
      if (name === session) {
        panePid = Number(pid)
        break
      }
    }
  } catch {
    /* tmux assente: gestito sotto */
  }
  if (!panePid) return { ok: false, code: 'not_found', message: `sessione tmux "${session}" non trovata` }

  const claudePid = findClaudePid(await processTable(), panePid)
  if (!claudePid) {
    return { ok: false, code: 'no_claude', message: 'in questa sessione non gira Claude: non c\'e\' niente da spostare' }
  }

  const srcDir = (await readConfigDir(claudePid)) || path.join(process.env.HOME || '/root', '.claude')
  const fromSlot = slotFromConfigDir(srcDir)
  if (fromSlot === targetAccountId) {
    return { ok: false, code: 'same_account', message: 'la sessione gira gia\' su questo account' }
  }

  if (!opts.force && (await readActivity(session)) === 'working') {
    return { ok: false, code: 'busy', message: 'la sessione sta lavorando: fermarla ora butterebbe via il lavoro in corso' }
  }

  const cwd = (await processCwd(claudePid)) || ''
  const startedMs = await processStartMs(claudePid)
  // La videata della pane e' l'unica cosa che appartiene con certezza a QUESTA sessione:
  // serve a riconoscere la sua chat fra quelle aperte sullo stesso repo.
  const videata = await readPaneText(session)
  const transcript = cwd ? await findTranscript(srcDir, cwd, startedMs, videata) : null

  if (!(await stopClaude(session, claudePid))) {
    return { ok: false, code: 'stop_failed', message: 'Claude non si e\' fermato: chiudilo a mano nella pane e riprova' }
  }

  // Spostamento del transcript: prima la copia nella destinazione, poi l'originale viene
  // messo da parte. In quest'ordine un'interruzione lascia al peggio un doppione, mai un buco.
  if (transcript && cwd) {
    const slug = transcriptSlug(cwd)
    const srcFile = path.join(srcDir, 'projects', slug, `${transcript}.jsonl`)
    const destSubdir = path.join(destDir, 'projects', slug)
    try {
      await fs.mkdir(destSubdir, { recursive: true })
      await fs.copyFile(srcFile, path.join(destSubdir, `${transcript}.jsonl`))
      await fs.rename(srcFile, `${srcFile}.moved-${Date.now()}`)
      logger.info(`[switch-account] ${session}: transcript ${transcript} spostato da ${fromSlot} a ${targetAccountId}`)
    } catch (err) {
      logger.warn(`[switch-account] ${session}: transcript non spostato (${String(err).slice(0, 150)}) → riparte senza cronologia`)
    }
  }

  if (cwd) await ensureTrusted(destDir, cwd)

  // withPermissionMode tiene la modalità permessi allineata agli altri punti di spawn:
  // cambiare account non deve far ripartire la sessione con permessi diversi da come era.
  // La nota su chi sta usando la sessione va riattaccata: cambiare abbonamento non cambia la
  // persona, ma il processo claude riparte da zero e senza questa se la dimenticherebbe.
  const { writeIdentityFile, withIdentityFile } = await import('./session-identity')
  const identityFile = await writeIdentityFile(
    process.env.DASHBOARD_DATA_DIR || path.join(process.cwd(), 'data'),
    opts.userEmail,
  )
  const cmd = withIdentityFile(
    withPermissionMode(
      transcript
        ? `CLAUDE_CONFIG_DIR='${config}' claude --resume ${transcript}`
        : `CLAUDE_CONFIG_DIR='${config}' claude`
    ),
    identityFile,
  )
  const { tmuxSuSessione: inviaA } = await import('./tmux-cmd')
  await inviaA(process.env.DASHBOARD_DATA_DIR || path.join(process.cwd(), 'data'), session, ['send-keys', '-t', `=${session}:`, cmd, 'Enter'])
  logger.info(`[switch-account] ${session}: ${fromSlot} → ${targetAccountId}${transcript ? ` (resume ${transcript})` : ' (chat nuova)'}`)

  return { ok: true, session, from: fromSlot, to: targetAccountId, transcript, cwd }
}
