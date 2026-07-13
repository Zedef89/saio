import { Router } from 'express'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { logger } from '../lib/logger'
import { getPlatform } from '../lib/platform'
import type { ScheduleSpec } from '../lib/platform'
import { getAllCronMeta, setCronMeta, deleteCronMeta as deleteCronMetaSidecar, renameCronMeta } from '../lib/cronMeta'
import { listNotifications, archiveStale } from '../lib/notifications-store'
import { approveNotification, dismissNotification } from '../lib/auto-fix-dispatcher'

const execAsync = promisify(exec)

interface CronTask {
  name: string
  next: string | null
  last: string | null
  status: string
  enabled: boolean
  description: string
  details?: string
  lastResult?: string
  schedule?: string
  // V14.28 — auto-fix toggle (solo per cron error-handling capable)
  errorHandlingCapable?: boolean
  autoFix?: boolean | null
  // Automazioni utente (macOS): fonte + gestibilità.
  source?: 'saio' | 'launchd' | 'cron'
  managed?: boolean
}

/**
 * V14.28 — cron che processano errori e supportano auto-fix toggle.
 * I cron in questa lista mostrano il Switch UI nella CronCard.
 */
const ERROR_HANDLING_CRONS = new Set([
  'Obsidian-Providers-Errors-Hourly',
  'Obsidian-VPS-Errors-Daily',
  'Obsidian-Extract-Errors-Daily', // già esistente, ora con toggle disponibile
])

// V15.9 WS39 — task interni di sistema dashboard (nascosti dalla UI list).
const INTERNAL_TASKS = new Set(['RM-Saio-Tauri-Elevator', 'RM-Dashboard-Cron-Manager'])

// Prefissi vendor mai gestibili via API (allineato a MacOSTaskScheduler.VENDOR_PREFIXES).
const VENDOR_PREFIXES = [
  'com.apple.',
  'com.google.',
  'homebrew.mxcl.',
  'com.docker.',
  'com.microsoft.',
  'com.adobe.',
  'com.macpaw.',
  'com.lwouis.',
]

// Known Obsidian automation descriptions
// V14.23 — aggiunto field `details` per descrizione espandibile in UI
const KNOWN_DESCRIPTIONS: Record<string, { desc: string; schedule: string; details?: string }> = {
  'Obsidian-Daily-Cockpit': {
    desc: 'Genera daily note con calendar + task overdue + progetti attivi',
    schedule: 'Ogni giorno 07:30',
    details:
      'Ogni mattina alle 07:30 invoca Claude CLI in modalità readonly (no Write/Edit) sul vault Obsidian locale. ' +
      "Estrae: priorità top 3 della giornata, tabella progetti attivi con stato, task urgenti con scadenze, decisioni aperte in inbox, stato VPS, item overdue trascinati, reminder, da dove ripartire. " +
      "Output salvato in <vault>/daily/<YYYY-MM-DD>.md. Se output >100 char viene anche pushato nella coda email per il dispatcher. " +
      "Vantaggio: ogni mattina hai un cockpit pronto da leggere senza dover ricostruire il contesto.",
  },
  'Obsidian-Health-Weekly': {
    desc: 'Vault health audit: broken links, stale notes, tag duplicati',
    schedule: 'Ogni lunedì 09:30',
    details:
      'Audit settimanale del vault: scansiona tutte le note .md, identifica broken links [[note-mancante]], note stale (>90 giorni senza modifica), tag duplicati con varianti (es. #vps vs #VPS). ' +
      'Output: report markdown in <vault>/audit/health-<YYYY-W>.md con score globale, samples e raccomandazioni. ' +
      'Vantaggio: previene la "memory rot" del vault tenendo traccia di link rotti e note che invecchiano senza essere consultate.',
  },
  'Obsidian-Session-Save-EOD': {
    desc: 'Salva sessione End-of-Day + extract error patterns',
    schedule: 'Ogni sera 00:30',
    details:
      "A mezzanotte estrae il sommario delle sessioni Claude/Codex dell'ultimo giorno (lette da ~/.claude/projects/.../*.jsonl), identifica pattern d'errore ricorrenti, salva in <vault>/sessions/EOD-<YYYY-MM-DD>.md. " +
      'Vantaggio: trasformi le sessioni grezze in conoscenza incrementale per il vault, individua errori ripetuti che meritano un feedback memo.',
  },
  'Obsidian-Connect-Weekly': {
    desc: 'Trova connessioni non ovvie tra note, evidenzia pattern',
    schedule: 'Ogni sabato 09:00',
    details:
      'Sabato mattina analizza il vault cercando connessioni semantiche tra note che non sono linkate ma trattano lo stesso topic. ' +
      'Output: report con suggerimenti di [[link]] da aggiungere. Vantaggio: il vault diventa più "graph-like" senza dover ricordare ogni connessione.',
  },
  'Obsidian-Pattern-Deep-Scan': {
    desc: 'Deep scan pattern tecnici consolidati + proposte nuovi pattern',
    schedule: 'Ogni giorno 01:00',
    details:
      "Ogni notte alle 01:00 analizza pattern tecnici consolidati nel vault (anti-flood, retry, queue recovery, AI timeout, n8n v3, ecc.). " +
      'Identifica nuovi pattern emergenti dal flusso recente di sessioni e propone aggiunta a <vault>/patterns/. ' +
      'Vantaggio: il catalogo pattern cresce organicamente da osservazione reale, non solo manuale.',
  },
  'Obsidian-Extract-Errors-Daily': {
    desc: 'Estrae error patterns dai session log ultimi 24h',
    schedule: 'Ogni giorno 01:30',
    details:
      'Daily extraction: legge log delle ultime 24h, identifica error patterns (stack trace ricorrenti, problemi VPS, timeout AI). ' +
      'Output: <vault>/errors/<YYYY-MM-DD>.md con categorizzazione + count. Vantaggio: feed continuo di osservazioni per migliorare gli script + roadmap fix.',
  },
  'Obsidian-GitHub-AI-Trending': {
    desc: 'Scan GitHub per AI repo trending + valuta rilevanza per vault',
    schedule: 'Ogni domenica 03:30',
    details:
      'Domenica notte scan GitHub trending in categoria AI/Claude/MCP/Agents, filtra per rilevanza al tuo lavoro, salva in <vault>/research/github-trending-<YYYY-W>.md. ' +
      'Vantaggio: scopri tool nuovi senza dover scrollare GitHub manualmente.',
  },
  'Obsidian-Hot-Topics-Weekly': {
    desc: 'Identifica hot topics in vault + proposta wiki pages',
    schedule: 'Ogni venerdì 02:00',
    details:
      'Venerdì notte identifica i topic più toccati nel vault questa settimana (frequency analysis), propone creazione di MOC wiki pages se mancanti. ' +
      'Vantaggio: il vault si auto-organizza con MOC che riflettono il focus reale, non a priori.',
  },
  'Obsidian-Serendipity-Scan': {
    desc: 'Scan serendipity: trova collegamenti random tra note',
    schedule: 'Ogni giorno 02:00',
    details:
      'Ogni notte un meccanismo "lottery" propone 1-2 collegamenti tra note distanti tra loro temalmente, per stimolare insight inaspettati. ' +
      'Output: <vault>/serendipity/<YYYY-MM-DD>.md (1 paragrafo). Vantaggio: rompi i silos cognitivi del vault.',
  },
  'Obsidian-Anthropic-Weekly': {
    desc: 'Update vault con news Anthropic/Claude + best practices',
    schedule: 'Ogni domenica 02:00',
    details:
      'Aggiornamento settimanale: scansiona blog/changelog Anthropic, modelli Claude, best practices CLI/SDK/MCP. ' +
      'Output in <vault>/research/anthropic-week-<YYYY-W>.md. Vantaggio: rimani aggiornato sul provider principale senza monitorare manualmente.',
  },
  'Obsidian-Ecosystem-Update': {
    desc: 'Scan ecosistema Claude Code: nuove skill, MCP, agenti',
    schedule: 'Ogni mercoledì 02:00',
    details:
      'Mercoledì notte scansiona ecosistema Claude Code (registry skill, marketplace MCP, repo awesome-claude, agenti pubblicati). ' +
      'Identifica novità da valutare per AgencyOS. Output in <vault>/research/ecosystem-<YYYY-W>.md. Vantaggio: copri tutto l\'ecosistema senza monitoring manuale.',
  },
  'RM-Dashboard-Feedback-AI': {
    desc: 'Elabora feedback con AI 2-step (V14.19): meta-prompt + exec',
    schedule: 'Ogni giorno 03:00',
    details:
      'Per ogni nota di feedback non processata: Step A invia il testo a Claude per generare un prompt mirato, Step B esegue quel prompt e ottiene JSON con causa/effetto/rischi/soluzione. ' +
      'Aggrega tutte le decisioni in 1 brief Inbox <data/briefs/feedback-digest-<date>.json>. Vantaggio: trasforma le tue note rapide in proposte di azione strutturate, pronte da approvare in Inbox.',
  },
}

/**
 * V15.9 WS39 — Lista task via Platform Abstraction Layer.
 * Su Windows → schtasks (WindowsTaskScheduler), macOS → launchd (MacOSTaskScheduler),
 * Linux → systemd-timer. La UI riceve la stessa shape `CronTask[]` su ogni OS.
 */
async function listTasks(): Promise<CronTask[]> {
  try {
    const palTasks = await getPlatform().taskScheduler.list()
    // Load sidecar metadata (long-form details + custom schedule labels)
    const allMeta = await getAllCronMeta()

    const tasks: CronTask[] = []
    for (const t of palTasks) {
      const name = t.name
      const lname = name.toLowerCase()
      // Fonte del task. Windows/Linux non popolano `source` → trattato come 'saio'.
      const source = t.source ?? 'saio'
      // I task SAIO/dashboard restano filtrati per naming pattern; le automazioni
      // utente esterne (launchd/cron) sono gestibili e vanno sempre mostrate.
      if (source === 'saio') {
        if (!lname.includes('obsidian') && !lname.includes('claude') && !lname.includes('rm-dashboard')) continue
        if (INTERNAL_TASKS.has(name)) continue
      }

      // FALLBACK: usato solo se description nativa e cron-meta.json sidecar entrambi vuoti.
      const known = KNOWN_DESCRIPTIONS[name]
      const meta = allMeta[name] || {}

      const enabled = t.state !== 'disabled'
      // sources priority: description nativa (Comment/SaioDescription) > KNOWN fallback
      const nativeDesc = (t.description || '').trim()
      const description = nativeDesc || known?.desc || `Automazione cron: ${name}`
      const details = meta.details || known?.details
      // Schedule label: sidecar > KNOWN > label pre-derivata dal PAL > derivato dallo ScheduleSpec
      const schedule = meta.schedule || known?.schedule || t.scheduleLabel || scheduleLabel(t.schedule)

      // V14.28 — auto-fix capability + state per cron error-handling
      const errorHandlingCapable = ERROR_HANDLING_CRONS.has(name)
      const autoFix = errorHandlingCapable ? (meta.autoFix ?? false) : null

      tasks.push({
        name,
        next: t.nextRunAt || null,
        last: t.lastRunAt || null,
        status: t.state,
        enabled,
        description,
        details,
        schedule,
        lastResult: t.lastResult != null ? String(t.lastResult) : undefined,
        errorHandlingCapable,
        autoFix,
        source,
        managed: t.managed ?? true,
      })
    }
    // Unique per name
    const uniq = new Map<string, CronTask>()
    for (const t of tasks) {
      if (!uniq.has(t.name)) uniq.set(t.name, t)
    }
    return Array.from(uniq.values()).sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    logger.error('listTasks failed:', err)
    return []
  }
}

/** Deriva una label leggibile ("Daily 09:00") da uno ScheduleSpec del PAL. */
function scheduleLabel(spec: ScheduleSpec | undefined): string | undefined {
  if (!spec) return undefined
  const time = spec.time || ''
  switch (spec.type) {
    case 'DAILY':
      return time ? `Daily ${time}` : 'Daily'
    case 'WEEKLY':
      return `Weekly ${spec.day || 'MON'}${time ? ` ${time}` : ''}`
    case 'MONTHLY':
      return `Monthly day-${spec.dayOfMonth || '1'}${time ? ` ${time}` : ''}`
    case 'ONCE':
      return time ? `Once ${time}` : 'Once'
    default:
      return undefined
  }
}

export function cronRouter() {
  const router = Router()

  const scheduler = () => getPlatform().taskScheduler

  router.get('/', async (_req, res) => {
    const tasks = await listTasks()
    res.json({ tasks, count: tasks.length, updatedAt: new Date().toISOString() })
  })

  // V14.19 — Health endpoint: per ogni task, stato derivato da log + last result
  router.get('/health', async (_req, res) => {
    try {
      const tasks = await listTasks()
      const vaultLogsDir = path.join(
        os.homedir(),
        '.claude',
        'projects',
        'C--Users-info-Desktop-CLAUDE-WORLD',
        'memory',
        'logs'
      )
      const dashboardLogsDir = path.join(process.cwd(), 'data', 'logs')
      // V15.9 — su macOS launchd redirige stdout/stderr qui (StandardOutPath).
      const macosLogsDir = path.join(os.homedir(), 'Library', 'Logs', 'saio')

      const health = await Promise.all(
        tasks.map(async (task) => {
          // Prefix matching: Obsidian-Daily-Cockpit -> "obsidian-daily*"
          const prefix = task.name.toLowerCase().replace(/^(obsidian|rm-dashboard)-/, '').slice(0, 25)
          const logDirs = [vaultLogsDir, dashboardLogsDir, macosLogsDir]
          let latestLog: { path: string; mtime: Date; preview: string } | null = null

          for (const dir of logDirs) {
            try {
              const files = await fs.readdir(dir)
              const matches = files.filter((f) =>
                f.toLowerCase().includes(prefix) ||
                f.toLowerCase().includes(task.name.toLowerCase().replace('rm-dashboard-', ''))
              )
              for (const f of matches) {
                const fp = path.join(dir, f)
                const stat = await fs.stat(fp)
                if (!latestLog || stat.mtime > latestLog.mtime) {
                  latestLog = { path: fp, mtime: stat.mtime, preview: '' }
                }
              }
            } catch {
              /* dir non esiste */
            }
          }

          if (latestLog) {
            try {
              const content = await fs.readFile(latestLog.path, 'utf8')
              latestLog.preview = content.slice(-2000) // Ultimi 2KB
            } catch { /* unreadable */ }
          }

          // Status derivation
          const lastResultStr = (task.lastResult || '').trim()
          const isError =
            lastResultStr.includes('1') ||
            lastResultStr.toLowerCase().includes('errore') ||
            (latestLog?.preview || '').toLowerCase().includes('error:') ||
            (latestLog?.preview || '').toLowerCase().includes('fatal')
          const last = task.last || ''
          const isStale = last.includes('1999') || last.includes('30/11') // "30/11/1999" = mai eseguito
          let status: 'ok' | 'failed' | 'stale' | 'unknown' = 'unknown'
          if (isStale) status = 'stale'
          else if (isError) status = 'failed'
          else if (latestLog) status = 'ok'

          return {
            name: task.name,
            description: task.description,
            schedule: task.schedule,
            enabled: task.enabled,
            lastRun: task.last,
            lastResult: task.lastResult,
            status,
            latestLogPath: latestLog?.path || null,
            latestLogMtime: latestLog?.mtime?.toISOString() || null,
            latestLogPreview: latestLog?.preview || null,
          }
        })
      )

      res.json({
        health,
        count: health.length,
        failed: health.filter((h) => h.status === 'failed').length,
        stale: health.filter((h) => h.status === 'stale').length,
        ok: health.filter((h) => h.status === 'ok').length,
        updatedAt: new Date().toISOString(),
      })
    } catch (err: any) {
      logger.error('cron/health failed:', err)
      res.status(500).json({ error: err?.message || String(err) })
    }
  })

  function validateTaskName(name: string): string | null {
    // Cron utente: id sintetico `cron-<hash8>`.
    if (/^cron-[a-f0-9]{8}$/.test(name)) return null
    // LaunchAgent utente esterno: label FQDN-like (contiene punti). Vietati i vendor.
    if (name.includes('.')) {
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) return 'invalid task name'
      if (VENDOR_PREFIXES.some((p) => name.startsWith(p))) return 'task not allowed'
      return null
    }
    // Task SAIO/dashboard: naming pattern classico.
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return 'invalid task name'
    if (
      !name.toLowerCase().includes('obsidian') &&
      !name.toLowerCase().includes('claude') &&
      !name.toLowerCase().includes('rm-dashboard')
    ) {
      return 'task not allowed'
    }
    return null
  }

  // V15.9 — pre-check per rename/delete: blocca op su task in running. Delega al PAL.
  async function isTaskRunning(name: string): Promise<boolean> {
    try {
      const t = await scheduler().get(name)
      return t?.state === 'running'
    } catch {
      return false
    }
  }

  router.post('/:name/run', async (req, res) => {
    const name = String(req.params.name)
    const err = validateTaskName(name)
    if (err) return res.status(err === 'invalid task name' ? 400 : 403).json({ error: err })

    const r = await scheduler().run(name)
    if (r.ok) return res.json({ ok: true, stdout: (r.output || '').trim(), stderr: '' })
    res.status(500).json({ error: r.error || 'run failed' })
  })

  // V14.28 — PATCH auto-fix toggle: ON/OFF per cron error-handling
  router.patch('/:name/auto-fix', async (req, res) => {
    const name = String(req.params.name)
    const err = validateTaskName(name)
    if (err) return res.status(err === 'invalid task name' ? 400 : 403).json({ error: err })
    if (!ERROR_HANDLING_CRONS.has(name)) {
      return res.status(400).json({
        error: 'Questo cron non supporta auto-fix toggle',
        errorCode: 'not_capable',
      })
    }
    const { enabled } = req.body || {}
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'body.enabled deve essere boolean' })
    }
    try {
      await setCronMeta(name, { autoFix: enabled })
      res.json({ ok: true, name, autoFix: enabled })
    } catch (e: any) {
      logger.error(`auto-fix toggle failed: ${e.message}`)
      res.status(500).json({ error: e.message })
    }
  })

  // V14.28 Step 3 — Notifications endpoint (lista + approve + dismiss)
  router.get('/notifications', async (req, res) => {
    try {
      // Opportunistic archive di stale notifications all'init
      await archiveStale().catch(() => {})
      const status = req.query.status as any
      const list = await listNotifications(status ? { status } : undefined)
      res.json({ notifications: list, count: list.length, pendingCount: list.filter((n) => n.status === 'pending').length })
    } catch (err: any) {
      logger.error(`notifications list failed: ${err.message}`)
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/notifications/:id/approve', async (req, res) => {
    try {
      const result = await approveNotification(String(req.params.id))
      res.json(result)
    } catch (err: any) {
      logger.error(`notification approve failed: ${err.message}`)
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/notifications/:id/dismiss', async (req, res) => {
    try {
      const note = req.body?.note ? String(req.body.note).slice(0, 200) : undefined
      const ok = await dismissNotification(String(req.params.id), note)
      if (!ok) return res.status(404).json({ error: 'notification not found' })
      res.json({ ok: true })
    } catch (err: any) {
      logger.error(`notification dismiss failed: ${err.message}`)
      res.status(500).json({ error: err.message })
    }
  })

  // V15.9 — Stato elevator/privilegi. Solo Windows richiede l'elevator (zero-UAC);
  // su macOS/Linux le automazioni sono user-level (LaunchAgents / systemd --user),
  // nessun admin necessario → available:true, nessun setup.
  router.get('/elevator/status', async (_req, res) => {
    const plat = getPlatform().platform
    if (plat !== 'win32') {
      return res.json({
        available: true,
        taskName: null,
        setupCommand: null,
        hint:
          plat === 'darwin'
            ? 'macOS: automazioni via LaunchAgents user-level, nessun admin/elevator richiesto.'
            : 'Automazioni user-level, nessun admin/elevator richiesto.',
      })
    }
    const available = await getPlatform().elevator.isAvailable()
    res.json({
      available,
      taskName: 'RM-Saio-Tauri-Elevator',
      setupCommand: available ? null : 'pwsh "scripts\\register-elevator.ps1"',
      hint: available
        ? 'Elevator attivo: nessun popup UAC sui toggle cron'
        : 'Elevator NON registrato: ogni toggle apre popup UAC. Esegui setup una volta.',
    })
  })

  router.post('/:name/enable', async (req, res) => {
    const name = String(req.params.name)
    const err = validateTaskName(name)
    if (err) return res.status(err === 'invalid task name' ? 400 : 403).json({ error: err })

    const r = await scheduler().enable(name)
    if (r.ok) return res.json({ ok: true, enabled: true })
    res.status(500).json({ error: r.error || 'enable failed' })
  })

  router.post('/:name/disable', async (req, res) => {
    const name = String(req.params.name)
    const err = validateTaskName(name)
    if (err) return res.status(err === 'invalid task name' ? 400 : 403).json({ error: err })

    const r = await scheduler().disable(name)
    if (r.ok) return res.json({ ok: true, enabled: false })
    res.status(500).json({ error: r.error || 'disable failed' })
  })

  // V14.27 — DELETE task scheduled
  router.delete('/:name', async (req, res) => {
    const name = String(req.params.name)
    const err = validateTaskName(name)
    if (err) return res.status(err === 'invalid task name' ? 400 : 403).json({ error: err })

    // Pre-check: blocca delete se task running
    if (await isTaskRunning(name)) {
      return res.status(423).json({
        error: 'Task in esecuzione, riprova tra qualche minuto',
        errorCode: 'task_running',
      })
    }

    const r = await scheduler().delete(name)
    if (r.ok) {
      await deleteCronMetaSidecar(name).catch(() => {}) // cleanup sidecar
      return res.json({ ok: true })
    }
    res.status(500).json({ error: r.error || 'delete failed' })
  })

  // V14.27 — PUT rename (atomic: nel PAL export+delete+create o copy+delete)
  router.put('/:name/rename', async (req, res) => {
    const oldName = String(req.params.name)
    const { newName } = (req.body || {}) as { newName?: string }
    const e1 = validateTaskName(oldName)
    if (e1) return res.status(e1 === 'invalid task name' ? 400 : 403).json({ error: e1 })
    if (!newName || typeof newName !== 'string') {
      return res.status(400).json({ error: 'newName richiesto' })
    }
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(newName)) {
      return res.status(400).json({ error: 'newName 3-64 char alphanum/dash/underscore' })
    }
    const e2 = validateTaskName(newName)
    if (e2) return res.status(e2 === 'invalid task name' ? 400 : 403).json({ error: e2 })
    if (newName === oldName) {
      return res.status(400).json({ error: 'newName uguale a oldName' })
    }

    // Pre-check: blocca rename se task running
    if (await isTaskRunning(oldName)) {
      return res.status(423).json({
        error: 'Task in esecuzione, riprova tra qualche minuto',
        errorCode: 'task_running',
      })
    }

    // Pre-check: newName non deve esistere
    const existing = await scheduler().get(newName)
    if (existing) {
      return res.status(409).json({ error: `Esiste già un task con nome "${newName}"` })
    }

    const r = await scheduler().rename(oldName, newName)
    if (!r.ok) {
      logger.error(`rename failed ${oldName}->${newName}: ${r.error}`)
      return res.status(500).json({ error: r.error || 'rename failed', detail: r.output })
    }
    await renameCronMeta(oldName, newName).catch(() => {})

    // Audit log
    try {
      const auditDir = path.join(process.cwd(), 'data', 'audit')
      await fs.mkdir(auditDir, { recursive: true })
      const auditFile = path.join(auditDir, `cron-rename-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`)
      const entry = JSON.stringify({ ts: new Date().toISOString(), op: 'rename', old: oldName, new: newName, success: true }) + '\n'
      await fs.appendFile(auditFile, entry, 'utf-8')
    } catch (auditErr) {
      logger.warn(`audit log append failed: ${auditErr}`)
    }

    res.json({ ok: true, name: newName })
  })

  // Apri lo strumento di gestione automazioni nativo dell'OS.
  // Windows: Task Scheduler GUI. macOS: cartella LaunchAgents in Finder.
  router.post('/open-gui', async (_req, res) => {
    const plat = getPlatform().platform
    try {
      if (plat === 'win32') {
        await execAsync('start "" taskschd.msc', { encoding: 'utf-8', shell: 'cmd.exe' } as any)
        return res.json({ ok: true })
      }
      if (plat === 'darwin') {
        await execAsync(`open "${path.join(os.homedir(), 'Library', 'LaunchAgents')}"`, { encoding: 'utf-8' })
        return res.json({ ok: true })
      }
      return res.status(501).json({ error: 'Nessuna GUI nativa disponibile su questa piattaforma' })
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'failed to open task manager GUI' })
    }
  })

  // V14.23 — POST / : crea nuovo task scheduled (delega al PAL)
  // Body: { name, schedule: { type: 'DAILY'|'WEEKLY'|'ONCE'|'MONTHLY', time: 'HH:MM', day?: 'MON|TUE|...', dayOfMonth?: '1-31' }, command, description, details }
  router.post('/', async (req, res) => {
    try {
      const { name, schedule, command, description, details, commandType } = (req.body || {}) as {
        name?: string
        schedule?: { type: 'DAILY' | 'WEEKLY' | 'ONCE' | 'MONTHLY'; time?: string; day?: string; dayOfMonth?: string }
        command?: string
        description?: string
        details?: string
        commandType?: 'command' | 'file' // 'file' esegue lo script direttamente (no -c wrap)
      }
      if (!name || !/^[a-zA-Z0-9_-]{3,64}$/.test(name)) {
        return res.status(400).json({ error: 'name 3-64 char alphanum/dash/underscore richiesto' })
      }
      if (!command || command.length < 3 || command.length > 2000) {
        return res.status(400).json({ error: 'command 3-2000 chars richiesto' })
      }
      if (!schedule || !['DAILY', 'WEEKLY', 'ONCE', 'MONTHLY'].includes(schedule.type)) {
        return res.status(400).json({ error: 'schedule.type DAILY|WEEKLY|MONTHLY|ONCE richiesto' })
      }
      const time = schedule.time && /^\d{2}:\d{2}$/.test(schedule.time) ? schedule.time : '03:00'
      const spec: ScheduleSpec = { type: schedule.type, time }
      let scheduleLbl = ''
      if (schedule.type === 'DAILY') {
        scheduleLbl = `Daily ${time}`
      } else if (schedule.type === 'WEEKLY') {
        const day = schedule.day && /^(MON|TUE|WED|THU|FRI|SAT|SUN)$/.test(schedule.day) ? schedule.day : 'MON'
        spec.day = day as ScheduleSpec['day']
        scheduleLbl = `Weekly ${day} ${time}`
      } else if (schedule.type === 'MONTHLY') {
        const dom = schedule.dayOfMonth && /^([1-9]|[12][0-9]|3[01])$/.test(schedule.dayOfMonth) ? schedule.dayOfMonth : '1'
        spec.dayOfMonth = dom
        scheduleLbl = `Monthly day-${dom} ${time}`
      } else {
        scheduleLbl = `Once ${time}`
      }

      // Force prefix RM-Dashboard- se non già presente (così validateTaskName ammette il task).
      const taskName = name.toLowerCase().includes('obsidian') || name.toLowerCase().includes('rm-dashboard')
        ? name
        : `RM-Dashboard-${name}`

      const r = await scheduler().create({
        name: taskName,
        schedule: spec,
        command,
        commandIsFile: commandType === 'file',
        description: description?.trim() || undefined,
      })
      if (!r.ok) {
        return res.status(500).json({ error: r.error || 'creazione task fallita' })
      }

      // Persisti sidecar (details + schedule label leggibile)
      if (details || scheduleLbl) {
        await setCronMeta(taskName, { details: details || undefined, schedule: scheduleLbl }).catch((e) =>
          logger.warn(`sidecar persist failed for ${taskName}: ${e?.message}`)
        )
      }
      // Assicura la description nativa (comment) anche dove create() non la imposta.
      if (description && description.trim()) {
        await scheduler().setComment(taskName, description.trim()).catch((e) =>
          logger.warn(`set-comment failed for ${taskName}: ${e?.message}`)
        )
      }

      res.status(201).json({ ok: true, name: taskName, description: description || '' })
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'failed' })
    }
  })

  return router
}
