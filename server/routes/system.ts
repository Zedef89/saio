/**
 * V15.0 WS10 + WS19 — System checks (dipendenze runtime) + install endpoints.
 *
 * /api/system/deps-check (auth required, solo owner):
 *   ritorna {python, claudeCli, cloudflared, playwright, ...} con stato + version.
 *   Frontend mostra popup "Dipendenze runtime" se manca qualcosa di critical.
 *
 * /api/system/install-python-deps (WS19):
 *   crea venv `orchestrator/.venv` se mancante e installa requirements.txt.
 *   Stream stdout+stderr come text/plain.
 */
import { Router } from 'express'
import fsSync from 'node:fs'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { logger } from '../lib/logger'
import { TMUX_BIN } from '../lib/tmux-bin'

// V15.0 WS19 — In-memory lock per prevenire doppio install Python deps
let pythonDepsInstallRunning = false

interface DepStatus {
  found: boolean
  version?: string
  category: 'CRITICAL' | 'CORE' | 'OPTIONAL'
  installCommand?: string
  installLink?: string
}

interface DepsReport {
  os: NodeJS.Platform
  deps: Record<string, DepStatus>
  allCriticalOk: boolean
  missingCritical: string[]
}

function checkCommand(cmd: string, args: string[] = ['--version']): Promise<string | null> {
  // V15.0 WS19 — su Windows usa shell:true per resolvere correttamente
  // .exe / .cmd / .bat / shim files (es. WinGet aliases).
  // Su POSIX shell:false è preferibile per safety.
  const isWin = platform() === 'win32'
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { shell: isWin })
    let out = ''
    p.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8')
    })
    p.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8')
    })
    p.on('error', () => resolve(null))
    p.on('exit', (code) => {
      if (code === 0) resolve(out.trim().split('\n')[0] || 'detected')
      else resolve(null)
    })
    setTimeout(() => {
      try {
        p.kill()
      } catch {
        /* ignore */
      }
      resolve(null)
    }, 3000)
  })
}

async function buildReport(): Promise<DepsReport> {
  const os = platform()
  const isWin = os === 'win32'

  const [node, npmV, claude, cloudflared, py311, py3, py] = await Promise.all([
    checkCommand('node'),
    checkCommand('npm'),
    checkCommand('claude'),
    checkCommand('cloudflared'),
    checkCommand(isWin ? 'python' : 'python3.11'),
    checkCommand(isWin ? 'py' : 'python3'),
    checkCommand(isWin ? 'py' : 'python'),
  ])

  // Resolve Python: prefer 3.11+, fallback any python detected
  let pythonVer: string | null = null
  for (const v of [py311, py3, py]) {
    if (v && /3\.(1[1-9]|[2-9]\d)/.test(v)) {
      pythonVer = v
      break
    }
  }
  if (!pythonVer && (py311 || py3 || py)) {
    pythonVer = py311 || py3 || py // detected ma versione minore di 3.11
  }

  // Playwright check via node_modules
  const playwrightInstalled = await fileExists(
    path.join(process.cwd(), 'node_modules', 'playwright')
  )

  // V15.0 WS19+WS20 — Python orchestrator deps check (pywinpty/psutil/watchdog)
  // Uso findWorkingPython che prova candidati multipli (venv → PYTHON_EXE → python/py/python3)
  // → evita false-positive quando backend ha PATH stale o Python alt installato senza pywinpty.
  const { findWorkingPython } = await import('../lib/python-deps-check')
  const pyDeps = isWin ? ['psutil', 'watchdog', 'pywinpty'] : ['psutil', 'watchdog']
  const pyResult = await findWorkingPython(pyDeps)

  const deps: Record<string, DepStatus> = {
    node: {
      found: !!node,
      version: node || undefined,
      category: 'CRITICAL',
      installCommand: isWin ? 'winget install OpenJS.NodeJS.LTS' : 'brew install node',
    },
    npm: {
      found: !!npmV,
      version: npmV || undefined,
      category: 'CRITICAL',
      installCommand: '(included with Node.js)',
    },
    python: {
      found: !!pythonVer && /3\.(1[1-9]|[2-9]\d)/.test(pythonVer),
      version: pythonVer || undefined,
      category: 'CORE',
      installCommand: isWin ? 'winget install Python.Python.3.11' : 'brew install python@3.11',
    },
    claudeCli: {
      found: !!claude,
      version: claude || undefined,
      category: 'CRITICAL',
      installLink: 'https://docs.anthropic.com/cli',
    },
    cloudflared: {
      found: !!cloudflared,
      version: cloudflared || undefined,
      category: 'OPTIONAL',
      installCommand: isWin
        ? 'winget install Cloudflare.cloudflared'
        : 'brew install cloudflare/cloudflare/cloudflared',
    },
    playwright: {
      found: playwrightInstalled,
      version: playwrightInstalled ? 'in node_modules' : undefined,
      category: 'OPTIONAL',
      installCommand: 'npx playwright install',
    },
    pythonDeps: {
      found: pyResult.allOk,
      version: pyResult.allOk
        ? `${pyDeps.join(', ')} OK (via ${pyResult.exe})`
        : `Mancanti: ${pyResult.missing.join(', ')} (provati: ${pyResult.tried.map((t) => t.exe).join(', ')})`,
      category: 'CORE',
      installCommand: 'npm run setup:deps',
    } as DepStatus,
  }

  const missingCritical = Object.entries(deps)
    .filter(([, v]) => v.category === 'CRITICAL' && !v.found)
    .map(([k]) => k)

  return {
    os,
    deps,
    allCriticalOk: missingCritical.length === 0,
    missingCritical,
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Data dir di SAIO: index.ts la popola all'avvio, come per gli altri moduli che la usano. */
function DATA_DIR(): string {
  return process.env.DASHBOARD_DATA_DIR || path.join(process.cwd(), 'data')
}

export function systemRouter(): Router {
  const router = Router()

  // Sessioni tmux REALI della macchina (Nicola): il contatore "Sessioni" deve riflettere
  // quello che gira davvero sul Mac, non solo i PTY spawnati da SAIO.
  router.get('/tmux-sessions', async (_req, res) => {
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      // Separatore '|': il TAB non sopravvive al passaggio (i campi restavano incollati
      // e il nome sessione risultava "42_1_1_1784806212_/Users/...").
      const fmt = '#{session_name}|#{session_windows}|#{?session_attached,1,0}|#{session_created}|#{pane_current_path}'
      const { stdout } = await execFileAsync(TMUX_BIN, ['list-sessions', '-F', fmt])
      // Su quale account gira ogni sessione e se sta lavorando: senza questi due dati la
      // lista non dice ne' quale sessione e' inutile aprire (account a limite finito) ne'
      // quale sta ancora scrivendo. Non blocca: se fallisce, le card restano come prima.
      const { sessionRuntimes } = await import('../lib/tmux-runtime')
      const { knownOwners, ownerFromName } = await import('../lib/session-owner')
      const [runtimes, owners] = await Promise.all([sessionRuntimes(), knownOwners(DATA_DIR())])
      const sessions = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parts = line.split('|')
          const cwd = parts.slice(4).join('|') || ''
          // Riconosce i worktree isolati: <progetto>/.claude/worktrees/<worktree>
          // così una sessione che gira nel worktree resta attribuita al suo progetto.
          let project: string | null = null
          let worktree: string | null = null
          const wtMatch = cwd.match(/^(.*?)\/\.claude\/worktrees\/([^/]+)/)
          if (wtMatch) {
            project = wtMatch[1].split('/').filter(Boolean).pop() || null
            worktree = wtMatch[2]
          } else {
            const devMatch = cwd.match(/\/dev\/([^/]+)/)
            if (devMatch) project = devMatch[1]
          }
          const name = parts[0] || ''
          const runtime = runtimes[name]
          return {
            name,
            windows: Number(parts[1]) || 1,
            attached: parts[2] === '1',
            created: Number(parts[3]) || 0,
            cwd,
            project,
            worktree,
            account: runtime?.account ?? null,
            activity: runtime?.activity ?? 'shell',
            owner: ownerFromName(name, owners),
          }
        })
        .filter((s) => s.name)
      res.json({ sessions })
    } catch {
      // tmux assente o nessuna sessione: lista vuota, non è un errore
      res.json({ sessions: [] })
    }
  })

  // Risorse di sistema del Mac: CPU, RAM, disco, carico.
  router.get('/stats', async (_req, res) => {
    try {
      const os = await import('node:os')
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)

      const total = os.totalmem()
      const free = os.freemem()
      const cpus = os.cpus()
      const load = os.loadavg()

      // Disco: su macOS APFS `df /` legge il volume di SISTEMA (read-only) e riporta un
      // "used" fuorviante (es. 6% con soli 16GB liberi). Usiamo il volume DATI e ricaviamo
      // l'occupato come total - free, coerente con "Informazioni su questo Mac".
      let disk = { total: 0, used: 0, free: 0, pct: 0 }
      try {
        const target = fsSync.existsSync('/System/Volumes/Data') ? '/System/Volumes/Data' : '/'
        const { stdout } = await execFileAsync('df', ['-k', target])
        const line = stdout.trim().split('\n').pop() || ''
        const p = line.split(/\s+/)
        const t = Number(p[1]) * 1024
        const f = Number(p[3]) * 1024
        const u = Math.max(0, t - f)
        disk = { total: t, used: u, free: f, pct: t ? Math.round((u / t) * 100) : 0 }
      } catch { /* df non disponibile */ }

      // RAM: su macOS `os.freemem()` conta SOLO la memoria completamente libera e ignora la
      // cache file (riutilizzabile all'istante) → "usata" risultava gonfiata (99% invece di 65%).
      // Usiamo vm_stat come Activity Monitor: usata = active + wired + compressa.
      let memory: Record<string, number> = {
        total,
        free,
        used: total - free,
        cached: 0,
        wired: 0,
        compressed: 0,
        pct: total ? Math.round(((total - free) / total) * 100) : 0,
      }
      try {
        const { stdout } = await execFileAsync('vm_stat', [])
        const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1]) || 4096
        const pages = (re: RegExp): number => {
          const m = stdout.match(re)
          return m ? Number(m[1].replace(/\./g, '')) : 0
        }
        const active = pages(/Pages active:\s+([\d.]+)/)
        const wired = pages(/Pages wired down:\s+([\d.]+)/)
        const compressed = pages(/Pages occupied by compressor:\s+([\d.]+)/)
        const fileBacked = pages(/File-backed pages:\s+([\d.]+)/)
        const speculative = pages(/Pages speculative:\s+([\d.]+)/)
        const usedBytes = (active + wired + compressed) * pageSize
        const cachedBytes = (fileBacked + speculative) * pageSize
        if (usedBytes > 0 && usedBytes <= total) {
          memory = {
            total,
            used: usedBytes,
            cached: cachedBytes,
            wired: wired * pageSize,
            compressed: compressed * pageSize,
            free: Math.max(0, total - usedBytes),
            pct: Math.round((usedBytes / total) * 100),
          }
        }
      } catch { /* vm_stat assente (non-macOS): resta il calcolo os.freemem */ }

      res.json({
        cpu: {
          cores: cpus.length,
          model: cpus[0]?.model || '',
          // load1 / core = occupazione media approssimata
          loadPct: cpus.length ? Math.min(100, Math.round((load[0] / cpus.length) * 100)) : 0,
          load: { '1m': load[0], '5m': load[1], '15m': load[2] },
        },
        memory,
        disk,
        uptime: os.uptime(),
      })
    } catch (err) {
      res.status(500).json({ error: 'stats_failed', message: (err as Error).message })
    }
  })

  // Dettaglio risorse: CHI sta occupando RAM/CPU, da quanto e da quale sessione tmux.
  router.get('/processes', async (req, res) => {
    const by = String(req.query.by || 'mem') === 'cpu' ? 'cpu' : 'mem'
    const limit = Math.min(50, Math.max(5, Number(req.query.limit) || 15))
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)

      const paneToSession = new Map<number, string>()
      try {
        const { stdout } = await execFileAsync(TMUX_BIN, [
          'list-panes', '-a', '-F', '#{session_name}|#{pane_pid}',
        ])
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const idx = line.lastIndexOf('|')
          if (idx > 0) {
            const s = line.slice(0, idx)
            const p = Number(line.slice(idx + 1))
            if (s && p) paneToSession.set(p, s)
          }
        }
      } catch { /* tmux assente */ }

      const { stdout: psOut } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,command='])
      const all: { pid: number; ppid: number; cpu: number; rssKb: number; etime: string; cmd: string }[] = []
      for (const line of psOut.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/)
        if (m) {
          all.push({
            pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]),
            rssKb: Number(m[4]), etime: m[5], cmd: m[6],
          })
        }
      }
      const byPid = new Map(all.map((p) => [p.pid, p]))
      const originSession = (pid: number): string | null => {
        let cur = byPid.get(pid)
        for (let i = 0; i < 25 && cur; i++) {
          const s = paneToSession.get(cur.pid) || paneToSession.get(cur.ppid)
          if (s) return s
          cur = byPid.get(cur.ppid)
        }
        return null
      }

      // nome leggibile: ultimo segmento dell'eseguibile, senza path
      const niceName = (cmd: string): string => {
        const first = cmd.split(' ')[0] || cmd
        const base = first.split('/').filter(Boolean).pop() || first
        // per node/python mostra anche lo script
        if (/^(node|python\d?|npm|npx|ruby|deno|bun)$/i.test(base)) {
          const arg = cmd.split(/\s+/).slice(1).find((a) => !a.startsWith('-'))
          if (arg) return `${base} · ${arg.split('/').filter(Boolean).pop()}`
        }
        return base
      }

      const sorted = [...all].sort((a, b) => (by === 'cpu' ? b.cpu - a.cpu : b.rssKb - a.rssKb)).slice(0, limit)
      res.json({
        by,
        processes: sorted.map((p) => ({
          pid: p.pid,
          name: niceName(p.cmd),
          cpu: p.cpu,
          memMb: Math.round(p.rssKb / 1024),
          uptime: p.etime,
          session: originSession(p.pid),
          cmd: p.cmd.slice(0, 160),
        })),
      })
    } catch (err) {
      res.status(500).json({ error: 'processes_failed', message: (err as Error).message })
    }
  })

  // Istanze Playwright attive + da quale sessione tmux sono state lanciate.
  router.get('/playwright', async (_req, res) => {
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)

      // 1) mappa pane_pid -> sessione tmux
      const paneToSession = new Map<number, string>()
      try {
        const { stdout } = await execFileAsync(TMUX_BIN, [
          'list-panes', '-a', '-F', '#{session_name}|#{pane_pid}',
        ])
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const idx = line.lastIndexOf('|')
          if (idx > 0) {
            const sess = line.slice(0, idx)
            const pid = Number(line.slice(idx + 1))
            if (sess && pid) paneToSession.set(pid, sess)
          }
        }
      } catch { /* tmux assente */ }

      // 2) tabella processi: pid, ppid, %cpu, rss, elapsed, comando
      const { stdout: psOut } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,command='])
      const all: { pid: number; ppid: number; cpu: number; rssKb: number; etime: string; cmd: string }[] = []
      for (const line of psOut.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/)
        if (m) {
          all.push({
            pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]),
            rssKb: Number(m[4]), etime: m[5], cmd: m[6],
          })
        }
      }
      const byPid = new Map(all.map((p) => [p.pid, p]))

      // 3) risale la catena dei padri finché trova un pane tmux
      const originSession = (pid: number): string | null => {
        let cur = byPid.get(pid)
        for (let i = 0; i < 20 && cur; i++) {
          const s = paneToSession.get(cur.pid) || paneToSession.get(cur.ppid)
          if (s) return s
          cur = byPid.get(cur.ppid)
        }
        return null
      }

      // 4) filtra i processi Playwright (server MCP e browser che ne discendono)
      const isPwServer = (c: string) => /playwright[-\/]?mcp|@playwright\/mcp|playwright\b.*(run-server|mcp)/i.test(c)
      const isBrowser = (c: string) => /chrome-mac|Chromium|headless_shell|WebKit\.WebContent|firefox.*marionette/i.test(c)

      const servers = all.filter((p) => isPwServer(p.cmd))
      const serverPids = new Set(servers.map((s) => s.pid))
      const descendsFromServer = (p: { pid: number; ppid: number }) => {
        let cur = byPid.get(p.pid)
        for (let i = 0; i < 20 && cur; i++) {
          if (serverPids.has(cur.ppid) || serverPids.has(cur.pid)) return true
          cur = byPid.get(cur.ppid)
        }
        return false
      }
      const browsers = all.filter((p) => isBrowser(p.cmd) && descendsFromServer(p))

      const shape = (p: typeof all[number], kind: 'server' | 'browser') => ({
        pid: p.pid,
        kind,
        cpu: p.cpu,
        memMb: Math.round(p.rssKb / 1024),
        uptime: p.etime,
        session: originSession(p.pid),
        cmd: p.cmd.slice(0, 140),
      })

      res.json({
        instances: [...servers.map((p) => shape(p, 'server')), ...browsers.map((p) => shape(p, 'browser'))],
        counts: { servers: servers.length, browsers: browsers.length },
      })
    } catch (err) {
      res.status(500).json({ error: 'playwright_failed', message: (err as Error).message })
    }
  })

  // Termina una singola istanza Playwright per PID.
  router.delete('/playwright/:pid', async (req, res) => {
    const pid = Number(req.params.pid)
    if (!Number.isInteger(pid) || pid <= 1) {
      res.status(400).json({ error: 'invalid_pid' })
      return
    }
    try {
      // Sicurezza: killa SOLO se il comando è davvero Playwright
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)])
      const cmd = stdout.trim()
      if (!/playwright|chrome-mac|Chromium|headless_shell|WebKit\.WebContent/i.test(cmd)) {
        res.status(403).json({ error: 'not_a_playwright_process' })
        return
      }
      process.kill(pid, 'SIGTERM')
      res.json({ ok: true, killed: pid })
    } catch (err) {
      res.status(500).json({ error: 'kill_failed', message: (err as Error).message })
    }
  })

  // Termina UNA singola sessione tmux (non tutte).
  router.delete('/tmux-sessions/:name', async (req, res) => {
    const name = String(req.params.name || '')
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      res.status(400).json({ error: 'invalid_session_name' })
      return
    }
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      await execFileAsync(TMUX_BIN, ['kill-session', '-t', `=${name}`])
      res.json({ ok: true, killed: name })
    } catch (err) {
      res.status(500).json({ error: 'kill_failed', message: (err as Error).message })
    }
  })

  // Crea una nuova sessione tmux dalla pagina Sessioni (senza passare dalla card progetto).
  // body: { name, projectId?, startClaude?, account? }
  //  - projectId → cwd = path del progetto (e il nome di default è quello del progetto)
  //  - senza projectId → sessione "libera" nella home
  //  - account → quale abbonamento Claude usare (vedi /claude-accounts); omesso = quello di default
  // Stessa whitelist del kill: il nome finisce in una riga di comando, niente caratteri strani.
  router.post('/tmux-sessions', async (req, res) => {
    const rawName = String(req.body?.name || '').trim()
    const projectId = req.body?.projectId ? String(req.body.projectId) : null
    const startClaude = req.body?.startClaude !== false
    const accountId = req.body?.account ? String(req.body.account) : null

    if (!/^[a-zA-Z0-9._-]+$/.test(rawName)) {
      res.status(400).json({ error: 'invalid_session_name' })
      return
    }

    // Chi apre la sessione finisce nel nome (`nicola-komanda-dashboard`): e' l'unico modo per
    // capire a colpo d'occhio, in una lista condivisa, quali sessioni sono le proprie.
    const { withOwnerPrefix } = await import('../lib/session-owner')
    const requester =
      req.user?.email || (req.headers['cf-access-authenticated-user-email'] as string) || null
    const name = await withOwnerPrefix(rawName, DATA_DIR(), requester)

    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)

      // Già viva? Non ricreare: il frontend ci si attacca e basta.
      try {
        await execFileAsync(TMUX_BIN, ['has-session', '-t', `=${name}`])
        res.json({ ok: true, name, created: false, alreadyExisted: true })
        return
      } catch {
        /* non esiste → si crea */
      }

      let cwd = process.env.HOME || '/root'
      if (projectId) {
        const { projectsStore } = await import('../lib/projects-store')
        const project = await projectsStore.findById(projectId)
        const p = (project as { path?: string } | null)?.path
        if (!p || !fsSync.existsSync(p)) {
          res.status(400).json({ error: 'project_dir_missing', path: p || null })
          return
        }
        cwd = p
      }

      // L'account arriva come id simbolico e viene risolto contro il registro:
      // nella riga di comando finisce solo una config dir nostra, mai input dell'utente.
      let claudeCmd = 'claude'
      let accountLabel = 'default'
      if (startClaude && accountId) {
        const { configDirForAccount } = await import('../lib/claude-accounts')
        const configDir = await configDirForAccount(accountId)
        if (!configDir) {
          res.status(400).json({ error: 'unknown_account', account: accountId })
          return
        }
        if (accountId !== 'default') {
          claudeCmd = `CLAUDE_CONFIG_DIR='${configDir}' claude`
          accountLabel = accountId
        }
      }

      // Stessa modalità permessi delle sessioni aperte dalle card progetto: senza questo
      // le sessioni create da qui partirebbero col comportamento di default.
      const { withPermissionMode, resolvePermissionMode } = await import('../lib/pty-manager')
      claudeCmd = withPermissionMode(claudeCmd)

      await execFileAsync(TMUX_BIN, ['new-session', '-d', '-s', name, '-c', cwd])
      if (startClaude) {
        await execFileAsync(TMUX_BIN, ['send-keys', '-t', name, claudeCmd, 'Enter'])
      }
      if (startClaude) {
        logger.info(`[tmux] "${name}": claude con perm=${resolvePermissionMode()}`)
      }

      logger.info(`[tmux] creata sessione "${name}" in ${cwd}${startClaude ? ` (+claude account=${accountLabel})` : ''}`)
      res.json({ ok: true, name, cwd, created: true, startedClaude: startClaude, account: startClaude ? accountLabel : null })
    } catch (err) {
      res.status(500).json({ error: 'create_failed', message: (err as Error).message })
    }
  })

  // Cambia l'account di una sessione gia' aperta portandosi dietro la conversazione: serve
  // quando un account finisce i token a meta' lavoro. Rifiuta se la sessione sta lavorando,
  // a meno di ?force=1 — fermare Claude mentre elabora butta via il lavoro in corso.
  router.post('/tmux-sessions/:name/account', async (req, res) => {
    const name = String(req.params.name || '')
    const account = String(req.body?.account || '')
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      res.status(400).json({ error: 'invalid_session_name' })
      return
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(account)) {
      res.status(400).json({ error: 'invalid_account' })
      return
    }
    try {
      const { switchSessionAccount } = await import('../lib/session-account-switch')
      const out = await switchSessionAccount(name, account, { force: req.body?.force === true })
      if (!out.ok) {
        // `busy` non e' un errore del client: e' uno stato che l'utente puo' forzare.
        res.status(out.code === 'busy' ? 409 : 400).json({ error: out.code, message: out.message })
        return
      }
      res.json(out)
    } catch (err) {
      res.status(500).json({ error: 'switch_failed', message: (err as Error).message })
    }
  })

  // Account Claude configurati sul server + quanto resta della finestra token settimanale.
  // Ordinati dal più libero al più carico: il primo è quello da preselezionare.
  // ?refresh=1 salta la cache di 60s.
  router.get('/claude-accounts', async (req, res) => {
    try {
      const { listClaudeAccounts } = await import('../lib/claude-accounts')
      const accounts = await listClaudeAccounts(req.query.refresh === '1')
      res.json({ accounts, freestId: accounts.find((a) => a.usage)?.id ?? null })
    } catch (err) {
      res.status(500).json({ error: 'accounts_failed', message: (err as Error).message })
    }
  })

  // Panoramica completa per la pagina Utilizzo: percentuali di ogni finestra (dalla stessa
  // lettura che alimenta le card sessione, non una in piu' — l'endpoint usage limita per IP) e
  // token davvero consumati, ricavati dai transcript.
  // ?refresh=1 forza la rilettura delle percentuali; ?rescan=1 forza anche la scansione dei transcript.
  router.get('/usage-overview', async (req, res) => {
    try {
      const [{ listClaudeAccounts }, { claudeTokenStats }] = await Promise.all([
        import('../lib/claude-accounts'),
        import('../lib/claude-usage-stats'),
      ])
      const [accounts, tokens] = await Promise.all([
        listClaudeAccounts(req.query.refresh === '1'),
        claudeTokenStats(req.query.rescan === '1'),
      ])
      res.json({
        accounts: accounts.map((a) => ({ ...a, tokens: tokens.accounts[a.id] ?? null })),
        scan: {
          scanning: tokens.scanning,
          scannedFiles: tokens.scannedFiles,
          totalFiles: tokens.totalFiles,
          updatedAt: tokens.updatedAt,
        },
      })
    } catch (err) {
      res.status(500).json({ error: 'usage_overview_failed', message: (err as Error).message })
    }
  })

  router.get('/deps-check', async (_req, res) => {
    try {
      const report = await buildReport()
      res.json(report)
    } catch (err) {
      res.status(500).json({ error: 'check_failed', message: (err as Error).message })
    }
  })

  // V15.0 WS18 — Guardrails antidistruttivi serviti al frontend
  router.get('/guardrails', async (_req, res) => {
    try {
      const { ANTIDESTRUCTIVE_GUARDRAILS, AUTH_RESET_FILES } = await import('../lib/safety-guardrails')
      res.json({
        guardrails: ANTIDESTRUCTIVE_GUARDRAILS,
        authResetFiles: AUTH_RESET_FILES,
      })
    } catch (err) {
      res.status(500).json({ error: 'load_failed', message: (err as Error).message })
    }
  })

  /**
   * Flag dell'istanza. Servono al frontend per sapere quali funzioni mostrare: i worktree
   * isolati hanno senso solo sulle installazioni condivise, sull'istanza personale il
   * selettore sarebbe solo un passaggio in più.
   */
  router.get('/features', (_req, res) => {
    res.json({
      isolatedWorktrees: process.env.SAIO_ISOLATED_WORKTREES === 'true',
    })
  })

  // V15.0 WS11 — Cloudflare tunnel status (per wizard)
  router.get('/tunnel-status', async (_req, res) => {
    try {
      const { detectCloudflared } = await import('../lib/cloudflared-detect')
      const status = await detectCloudflared()
      res.json({
        ...status,
        configuredUrl: process.env.DASHBOARD_AUTH_TUNNEL_URL || null,
      })
    } catch (err) {
      res.status(500).json({ error: 'check_failed', message: (err as Error).message })
    }
  })

  // V15.0 WS17 — Install Obsidian via package manager OS-detected
  router.post('/install-obsidian', async (_req, res) => {
    const { spawn } = await import('node:child_process')
    const { platform } = await import('node:os')
    const os = platform()
    let cmd: string, args: string[]
    if (os === 'win32') {
      cmd = 'winget'
      args = ['install', 'Obsidian.Obsidian', '--accept-source-agreements', '--accept-package-agreements']
    } else if (os === 'darwin') {
      cmd = 'brew'
      args = ['install', '--cask', 'obsidian']
    } else {
      res.status(501).json({ error: 'unsupported_platform', message: 'Linux: scarica manualmente da obsidian.md/download' })
      return
    }
    let out = ''
    let err = ''
    const proc = spawn(cmd, args, { shell: false })
    proc.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf-8')
    })
    proc.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf-8')
    })
    proc.on('error', (e) => {
      res.status(500).type('text/plain').send(`Failed to spawn: ${e.message}\n${err}`)
    })
    proc.on('exit', (code) => {
      if (code === 0) {
        res.type('text/plain').send(`Install completato.\n\n${out}\n${err}`)
      } else {
        res.status(500).type('text/plain').send(`Install fallito (exit ${code}).\n\n${out}\n${err}`)
      }
    })
    // Timeout di sicurezza 5 min
    setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    }, 5 * 60_000)
  })

  // V15.0 WS19 — Install Python deps (venv + pip install -r requirements.txt)
  // Concorrenza: lock in-memory previene doppi spawn. Streaming text/plain output.
  router.post('/install-python-deps', async (_req, res) => {
    if (pythonDepsInstallRunning) {
      res.status(409).json({ error: 'install_already_running' })
      return
    }
    pythonDepsInstallRunning = true
    res.type('text/plain; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Transfer-Encoding', 'chunked')

    const { orchestratorRequirements, orchestratorVenvDir, venvPythonExe, venvPipExe, appSupportDir } =
      await import('../lib/orchestrator-paths')
    // La venv NON può stare nel bundle read-only → dir utente scrivibile.
    const venvPath = orchestratorVenvDir()
    const venvPython = venvPythonExe(venvPath)
    const venvPip = venvPipExe(venvPath)
    // requirements.txt si legge dal bundle/repo (read-only ok).
    const reqFile = orchestratorRequirements()
    // Assicura che la dir padre della venv esista prima di `python -m venv`.
    await fs.mkdir(appSupportDir(), { recursive: true }).catch(() => {})

    // Helper streaming
    function writeLine(line: string): void {
      try {
        res.write(line + '\n')
      } catch {
        /* socket closed */
      }
    }

    function runStep(cmd: string, args: string[], label: string): Promise<number> {
      return new Promise((resolve) => {
        writeLine(`\n→ ${label}`)
        writeLine(`  $ ${cmd} ${args.join(' ')}`)
        const proc = spawn(cmd, args, {
          shell: process.platform === 'win32',
          // Tutti i path passati sono assoluti; cwd = dir orchestrator (esistente).
          cwd: path.dirname(reqFile),
        })
        proc.stdout.on('data', (c: Buffer) => writeLine(c.toString('utf-8').trimEnd()))
        proc.stderr.on('data', (c: Buffer) => writeLine(c.toString('utf-8').trimEnd()))
        proc.on('error', (err) => {
          writeLine(`  ERRORE spawn: ${err.message}`)
          resolve(1)
        })
        proc.on('exit', (code) => {
          writeLine(`  exit=${code ?? 'null'}`)
          resolve(code ?? 1)
        })
        // Safety timeout 5 min per step
        setTimeout(() => {
          try { proc.kill() } catch { /* */ }
        }, 5 * 60_000)
      })
    }

    try {
      // Verifica requirements.txt esiste
      try {
        await fs.access(reqFile)
      } catch {
        writeLine(`ERRORE: ${reqFile} non trovato.`)
        res.end()
        return
      }

      // Step 1: crea venv se mancante
      let venvExists = false
      try {
        await fs.access(venvPython)
        venvExists = true
      } catch {
        /* not found */
      }

      if (!venvExists) {
        writeLine('Creazione venv Python...')
        // Trova python di sistema
        const sysPython = process.platform === 'win32' ? 'python' : 'python3'
        const venvCode = await runStep(sysPython, ['-m', 'venv', venvPath], 'Creazione venv')
        if (venvCode !== 0) {
          writeLine(`\nFAIL: creazione venv fallita (exit ${venvCode}). Verifica che Python sia installato e nel PATH.`)
          res.end()
          return
        }
      } else {
        writeLine(`venv già presente: ${venvPath}`)
      }

      // Step 2: upgrade pip
      const pipUpgradeCode = await runStep(
        venvPython,
        ['-m', 'pip', 'install', '--upgrade', 'pip'],
        'Upgrade pip nel venv'
      )
      if (pipUpgradeCode !== 0) {
        writeLine(`\nWARN: pip upgrade fallito (exit ${pipUpgradeCode}). Provo comunque l'install.`)
      }

      // Step 3: pip install -r requirements.txt
      const installCode = await runStep(
        venvPip,
        ['install', '-r', reqFile],
        'Install requirements.txt'
      )

      if (installCode === 0) {
        writeLine('\n✓ INSTALLAZIONE COMPLETATA')
        writeLine(`  venv: ${venvPath}`)
        writeLine(`  Riavvia il backend (Ctrl+C nel terminale + npm run dev:all) perché orchestrator-client risolva il nuovo venv.`)
        logger.info(`[install-python-deps] success venv=${venvPath}`)
      } else {
        writeLine(`\nFAIL: pip install fallito (exit ${installCode}).`)
        writeLine('Suggerimenti:')
        writeLine('  - Verifica connessione internet')
        writeLine('  - Su Windows assicurati di avere VS Build Tools per pywinpty')
        writeLine(`  - Manuale: ${venvPip} install -r ${reqFile}`)
      }
    } catch (err) {
      writeLine(`\nERRORE imprevisto: ${(err as Error).message}`)
      logger.error('[install-python-deps] unexpected error:', err)
    } finally {
      pythonDepsInstallRunning = false
      try { res.end() } catch { /* */ }
    }
  })

  // V15.0 WS11 — Set tunnel URL in .env.local
  router.post('/tunnel-url', async (req, res) => {
    try {
      const { z } = await import('zod')
      const { updateEnvLocal, setProcessEnv } = await import('../lib/auth/env-writer')
      const Schema = z.object({ url: z.string().url().max(2048) })
      const parsed = Schema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_url' })
        return
      }
      await updateEnvLocal({ DASHBOARD_AUTH_TUNNEL_URL: parsed.data.url })
      setProcessEnv({ DASHBOARD_AUTH_TUNNEL_URL: parsed.data.url })
      res.json({ ok: true, url: parsed.data.url })
    } catch (err) {
      res.status(500).json({ error: 'env_write_failed', message: (err as Error).message })
    }
  })

  return router
}
