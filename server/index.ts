// DEVE restare il PRIMO import: carica .env.local/.env + PATH + cwd prima di ogni altro
// modulo, così le const che leggono process.env (es. VAULT_PATH) vedono i valori giusti.
import './load-env'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Request, type Response, type NextFunction } from 'express'
import helmet from 'helmet'
import fs from 'node:fs'
import { chatsRouter } from './routes/chats'
import { memoriesRouter } from './routes/memories'
import { uploadsRouter } from './routes/uploads'
import { coolifyRouter } from './routes/coolify'
import { briefsRouter } from './routes/briefs'
import { responsesRouter } from './routes/responses'
import { tasksRouter } from './routes/tasks'
import { projectsRouter, getProjectById } from './routes/projects'
import { newProjectRouter } from './routes/new-project'
import { orchestratorRouter } from './routes/orchestrator'
import { archiveRouter } from './routes/archive'
import { metricsRouter } from './routes/metrics'
import { mcpRouter } from './routes/mcp'
import { credentialsRouter } from './routes/credentials'
import { startSessionBridge } from './lib/session-bridge'
import { sshRouter } from './routes/ssh'
import { vpsRouter } from './routes/vps'
import { mcpDiscoveryRouter } from './routes/mcp-discovery'
import { deepResearchRouter } from './routes/deep-research'
import { ptyRouter } from './routes/pty'
import { worktreesRouter } from './routes/worktrees'
import { attachPtyWebSocket } from './lib/ws-pty'
import { ptyManager } from './lib/pty-manager'
import { projectsStore } from './lib/projects-store'
import { vpsStateStore } from './lib/vps-state-store'
import { vpsConfigStore } from './lib/vps-config-store'
import { accountsStore } from './lib/accounts-store'
import { setHealthDataDir } from './lib/account-health'
import { taskTypesStore } from './lib/task-types-store'
import { customProvidersStore } from './lib/custom-providers-store'
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { cronRouter } from './routes/cron'
import { recipesRouter } from './routes/recipes'
import { errorPipelineRouter } from './routes/error-pipeline'
import { toolsSnapshotRouter } from './routes/tools-snapshot'
import { patternAdoptionRouter } from './routes/pattern-adoption'
import { accountsRouter } from './routes/accounts'
import { taskTypesRouter } from './routes/task-types'
import { logsRouter } from './routes/logs'
import { vaultRouter } from './routes/vault'
import { eventsRouter, broadcastEvent } from './routes/sse'
import { setupFileWatch } from './lib/filewatch'
import { ensureDataDirs } from './lib/datadirs'
import { logger } from './lib/logger'
import { setAuditDataDir } from './lib/auth/audit'
import { setBanStoreDataDir } from './lib/auth/ban-store'
import { bootstrapAuth } from './lib/auth/bootstrap'
import { authRouter } from './routes/auth'
import { adminAccessRouter } from './routes/admin-access'
import { systemRouter } from './routes/system'
import { perfRouter } from './routes/perf'
import { onboardingRouter } from './routes/onboarding'
import { scanRouter } from './routes/scan'
import { authLimiter, checkBanlist } from './middleware/rate-limit'
import { makeRequireAuth, requireOwner } from './middleware/require-auth'
import { accessPolicy } from './middleware/access-policy'
import { cronTokenOrAuth } from './middleware/cron-bypass'
import cookieParser from 'cookie-parser'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')
// DATA_DIR: in app bundle macOS le Resources sono read-only e si perdono a ogni reinstallazione.
// Usiamo una dir utente scrivibile e persistente (claim/owner/config/progetti sopravvivono).
function resolveDataDir(): string {
  if (process.env.DASHBOARD_DATA_DIR) return process.env.DASHBOARD_DATA_DIR
  if (process.platform === 'darwin' && PROJECT_ROOT.includes('.app/Contents')) {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', 'us.revolutionmarketing.saio', 'data')
  }
  return path.join(PROJECT_ROOT, 'data')
}
const DATA_DIR = resolveDataDir()
// Esporta il data dir risolto: alcune lib (es. ssh-inventory) lo leggono da qui invece
// di riceverlo come parametro. Senza, cadevano su process.cwd()/data → inventario VPS
// vuoto nel bundle ("Nessun VPS" pur avendo ssh-inventory.json con 6 server).
process.env.DASHBOARD_DATA_DIR = DATA_DIR
const PORT = Number(process.env.SERVER_PORT || 3031)
const HOST = '127.0.0.1'

ensureDataDirs(DATA_DIR)
ptyManager.setDataDir(DATA_DIR)
projectsStore.setDataDir(DATA_DIR)
// Kick off V11 migration asynchronously — non-blocking
projectsStore.migrate().catch((err) => logger.error('[projects-store] migrate failed:', err))
// V13: VPS state store init
vpsStateStore.setDataDir(DATA_DIR)
// V13.3-T8: VPS user-editable config store (custom labels)
vpsConfigStore.setDataDir(DATA_DIR)
// V13: Accounts store — autodetect + seed on first boot
accountsStore.setDataDir(DATA_DIR)
accountsStore.migrate().catch((err) => logger.error('[accounts-store] migrate failed:', err))
setHealthDataDir(DATA_DIR)
taskTypesStore.setDataDir(DATA_DIR)
taskTypesStore.migrate().catch((err) => logger.error('[task-types-store] migrate failed:', err))
customProvidersStore.setDataDir(DATA_DIR)
customProvidersStore.ensureLoaded().catch((err) => logger.error('[custom-providers] init failed:', err))

// V15.0 WS3-3D — Auth-related store init (ban-store + audit log).
setBanStoreDataDir(DATA_DIR)
setAuditDataDir(DATA_DIR)

// V15.0 WS3-3G — Bootstrap claim flow: stampa banner stdout se owner.json mancante.
// Idempotente, safe da chiamare ad ogni avvio.
bootstrapAuth(DATA_DIR).catch((err) => logger.error('[auth] bootstrap failed:', err))

const app = express()

// V15.0 WS3-3E — Production-ready security: HSTS + strict CSP + CORS allowlist
const IS_PROD = process.env.NODE_ENV === 'production'
const ALLOWED_ORIGINS = (process.env.DASHBOARD_ALLOWED_ORIGINS || 'http://127.0.0.1:3030,http://localhost:3030')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// V15.0 WS3-3D — Tunnel URL (Cloudflare/Reverse-proxy) per CORS allowlist + magic-link absolute URL
const TUNNEL_URL = (process.env.DASHBOARD_AUTH_TUNNEL_URL || '').trim()
if (TUNNEL_URL && !ALLOWED_ORIGINS.includes(TUNNEL_URL)) ALLOWED_ORIGINS.push(TUNNEL_URL)

// SAIO desktop (Tauri) webview origins — required so the packaged app (macOS: tauri://localhost,
// Windows/Linux: http://tauri.localhost) passes the CORS allowlist when calling the local API.
for (const o of ['tauri://localhost', 'http://tauri.localhost']) {
  if (!ALLOWED_ORIGINS.includes(o)) ALLOWED_ORIGINS.push(o)
}

// V15.0 WS3-3D — Trust proxy SOLO da localhost (cloudflared gira sulla stessa VPS e
// inoltra a 127.0.0.1, settando X-Forwarded-For + CF-Connecting-IP). Senza questo,
// req.ip sarebbe sempre 127.0.0.1 e i rate-limit per-IP non funzionerebbero su VPS.
app.set('trust proxy', '127.0.0.1')

// ============================================================
// Security middlewares
// ============================================================
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Vite dev HMR richiede 'unsafe-inline' + 'unsafe-eval'. In build prod le rimuoviamo.
        scriptSrc: IS_PROD ? ["'self'"] : ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind inline + Radix style props
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'http://127.0.0.1:3030', 'http://127.0.0.1:3031', 'ws://127.0.0.1:3030', 'ws://127.0.0.1:3031', ...ALLOWED_ORIGINS],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        ...(IS_PROD ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    // Cloudflare Tunnel termina HTTPS al edge — HSTS sempre on (anche in dev locale è no-op se HTTP)
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: false },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xFrameOptions: { action: 'deny' },
  })
)

// V15.0 WS3-3E — CORS strict da env allowlist (con dev fallback)
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Cron-Token,X-Requested-With')
    res.setHeader('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true, limit: '2mb' }))
app.use(cookieParser())

// Request logging
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`)
  next()
})

// ============================================================
// Health
// ============================================================
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    version: '1.0.0',
    dataDir: DATA_DIR,
  })
})

// ============================================================
// V15.0 WS3 — Mount order:
//  1. /api/auth/*           PUBLIC (rate-limited + banlist)
//  2. /api/error-pipeline   X-Cron-Token only (verifyCronToken self-protected)
//  3. /api/cron             X-Cron-Token OR (JWT + role:owner)
//  4. /api/* umbrella JWT   gates everything below
//  5. accessPolicy          nega ai guest le rotte owner-only (middleware/access-policy.ts)
//  6. /api/admin/access     requireOwner additional gate (in 3H)
// ============================================================
app.use('/api/auth', checkBanlist, authLimiter, authRouter(DATA_DIR))

const requireAuth = makeRequireAuth(DATA_DIR)

// CRON-protected routes (X-Cron-Token gate, bypass JWT)
app.use('/api/error-pipeline', errorPipelineRouter())
// `cronTokenOrAuth` da solo NON respinge nessuno: si limita a marcare `req.skipAuth` quando
// il token combacia. Essendo montato PRIMA dell'umbrella, /api/cron restava raggiungibile
// senza sessione (creare, lanciare e cancellare job che girano come root). requireAuth +
// requireOwner completano il "X-Cron-Token OR (JWT + role:owner)" promesso qui sopra:
// con skipAuth requireAuth mette un utente owner e i due passano lisci.
app.use('/api/cron', cronTokenOrAuth, requireAuth, requireOwner, cronRouter())

// JWT umbrella — tutte le rotte dopo richiedono auth (a meno che req.skipAuth)
app.use('/api', requireAuth)
// Ruolo: l'umbrella dice CHI sei, questa dice cosa puoi fare.
app.use('/api', accessPolicy)

// Routes (esistenti, ora protette)
app.use('/api/briefs', briefsRouter(DATA_DIR))
app.use('/api/responses', responsesRouter(DATA_DIR))
app.use('/api/tasks', tasksRouter(DATA_DIR))
app.use('/api/projects', projectsRouter(DATA_DIR))
app.use('/api/new-project', newProjectRouter(DATA_DIR))
app.use('/api/orchestrator', orchestratorRouter(DATA_DIR, getProjectById))
app.use('/api/archive', archiveRouter(DATA_DIR))
app.use('/api/metrics', metricsRouter(DATA_DIR))
app.use('/api/mcp', mcpRouter())
// Storico conversazioni Claude Code (~/.claude/projects/<slug>/*.jsonl)
app.use('/api/chats', chatsRouter())
// Memorie di progetto Claude Code (~/.claude/projects/<slug>/memory/*.md) — lettura + scrittura
app.use('/api/memories', memoriesRouter())
// Allegati (foto/documenti/audio) per le sessioni: salva su disco e restituisce il path
app.use('/api/uploads', uploadsRouter())
// Istanze Coolify (inventario + stato via API)
app.use('/api/coolify', coolifyRouter())
app.use('/api/credentials', credentialsRouter(DATA_DIR))
app.use('/api/ssh', sshRouter())
app.use('/api/vps', vpsRouter())
app.use('/api/mcp-discovery', mcpDiscoveryRouter(DATA_DIR))
app.use('/api/deep-research', deepResearchRouter())
app.use('/api/pty', ptyRouter())
// Worktree isolati per utente (istanze condivise): lista, creazione, collisioni
app.use('/api/worktrees', worktreesRouter(DATA_DIR))
app.use('/api/recipes', recipesRouter())
app.use('/api/tools-snapshot', toolsSnapshotRouter())
app.use('/api/pattern-adoption', patternAdoptionRouter())
app.use('/api/accounts', accountsRouter())
app.use('/api/task-types', taskTypesRouter())
app.use('/api/logs', logsRouter(DATA_DIR))
app.use('/api/vault', vaultRouter())
app.use('/api/events', eventsRouter())

// V15.0 WS3-3H — Admin access (owner-only)
app.use('/api/admin/access', requireOwner, adminAccessRouter(DATA_DIR))

// V15.0 WS10 — System checks (deps, tunnel status). Auth gated da umbrella.
app.use('/api/system', systemRouter())

// V15.0 WS22 — Performance snapshot per CPU monitor (alert >100% sostenuto)
app.use('/api/perf', perfRouter())

// V15.0 WS12 — Onboarding (first-login wizard state)
app.use('/api/onboarding', onboardingRouter(DATA_DIR))

// V15.0 WS13 — Filesystem scan + import progetti
app.use('/api/scan', scanRouter(DATA_DIR))

// V15.0 WS11 — Static PDF docs (es. SAIO-cloudflare-setup-guide.pdf).
// Auth required (post-login). Per dev locale, Vite proxy /docs → backend.
const docsPath = path.join(PROJECT_ROOT, 'docs')
if (fs.existsSync(docsPath)) {
  app.use('/docs', express.static(docsPath, { fallthrough: true, maxAge: '1d' }))
}

// Opzionale (SAIO_SERVE_STATIC): serve il frontend buildato (dist/) dallo stesso origin
// del backend. Abilita test E2E via browser su http://127.0.0.1:3031 e il flusso magic-link
// web same-origin. Non attivo di default (in app desktop il frontend è embedded in Tauri).
// Auto-detect del frontend buildato: env esplicita, oppure dist bundlato (Resources/_up_/dist),
// oppure dist dev. Necessario per l'accesso via tunnel browser (same-origin, il magic-link web).
const staticDir =
  process.env.SAIO_SERVE_STATIC ||
  [path.join(PROJECT_ROOT, '_up_', 'dist'), path.join(PROJECT_ROOT, 'dist')].find((d) => fs.existsSync(d)) ||
  ''
if (staticDir && fs.existsSync(staticDir)) {
  app.use(express.static(staticDir, { index: false }))
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next()
    if (req.path.startsWith('/api/') || req.path.startsWith('/docs/')) return next()
    if (req.path.includes('.')) return next() // asset (js/css/png) già gestiti da express.static
    res.sendFile(path.join(staticDir, 'index.html'))
  })
  logger.info(`🖼️  Serving frontend (SAIO_SERVE_STATIC) from ${staticDir}`)
}

// ============================================================
// File watch → SSE broadcast
// ============================================================
setupFileWatch(DATA_DIR, (event) => broadcastEvent(event))

// ============================================================
// Error handler
// ============================================================
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error:', err)
  res.status(500).json({ error: err.message })
})

// ============================================================
// Start
// ============================================================
const httpServer = createServer(app)
attachPtyWebSocket(httpServer, DATA_DIR)

// Fix #22 (macOS beta test) — guardia EADDRINUSE: se l'app viene chiusa in modo
// brusco il sidecar Node resta orfano sulla porta; al riavvio successivo il nuovo
// sidecar crashava subito con EADDRINUSE e Tauri non lo rilancia (app aperta ma
// backend morto, tunnel in 502). Qui: se la porta è occupata da un ALTRO sidecar
// SAIO della stessa installazione, lo terminiamo e riproviamo il listen (l'app
// appena avviata vince). Un processo sconosciuto non viene MAI toccato: usciamo
// subito con un errore che ne riporta pid e command line.
const LISTEN_MAX_RETRIES = 5
const LISTEN_RETRY_DELAY_MS = 700
let listenAttempt = 0

// Firma forte: un gemello SAIO risponde /api/health con lo STESSO dataDir
// (= stessa installazione). Un servizio estraneo che per caso risponde
// {status:'ok'} non matcha e non viene mai toccato.
async function portHeldBySameSaio(): Promise<boolean> {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return false
    const body = (await res.json()) as { status?: string; dataDir?: string }
    return body.status === 'ok' && body.dataDir === DATA_DIR
  } catch {
    return false
  }
}

function findListenerPids(): number[] {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' })
      return out
        .split('\n')
        .filter((l) => l.includes(`:${PORT} `) && /LISTENING/i.test(l))
        .map((l) => Number(l.trim().split(/\s+/).pop()))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    }
    const out = execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { encoding: 'utf8' })
    return out
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return [] // lsof/netstat escono ≠0 anche solo quando non trovano nulla
  }
}

function pidCommandLine(pid: number): string {
  if (process.platform === 'win32') return ''
  try {
    return execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// Log di avvio registrato UNA volta: passarlo come callback a listen() dentro
// startListen lo duplicherebbe ad ogni retry (ogni listen() aggiunge un once).
httpServer.once('listening', () => {
  logger.info(`🚀 Dashboard server running on http://${HOST}:${PORT}`)
  logger.info(`🔌 WebSocket PTY endpoint: ws://${HOST}:${PORT}/api/pty/:projectId`)
  logger.info(`📁 Data dir: ${DATA_DIR}`)
})

function startListen(): void {
  httpServer.listen(PORT, HOST)
}

httpServer.on('error', (err: Error) => {
  const e = err as NodeJS.ErrnoException
  if (e.code !== 'EADDRINUSE') {
    logger.error('[listen] fatal server error:', err)
    process.exit(1)
  }
  listenAttempt++
  if (listenAttempt > LISTEN_MAX_RETRIES) {
    logger.error(`[listen] port ${PORT} still in use after ${LISTEN_MAX_RETRIES} retries — giving up (see logs above)`)
    process.exit(1)
  }
  void (async () => {
    const sameSaio = await portHeldBySameSaio()
    const pids = findListenerPids().filter((pid) => pid !== process.pid)
    // Decisione per-pid. Il sidecar bundlato si riconosce dalla command line
    // ('saio-server' copre anche l'orfano hung che non risponde più all'HTTP).
    // Il dev server ('server/index.ts') richiede ANCHE la firma health per non
    // uccidere il dev server di un ALTRO progetto sulla stessa porta. Su
    // Windows la command line non è disponibile → solo firma health (limite:
    // un orfano hung non è reclamabile lì, vedi ISSUE #22).
    const killable = pids.filter((pid) => {
      const cmd = pidCommandLine(pid)
      if (cmd.includes('saio-server')) return true
      if (cmd.includes('server/index.ts') && sameSaio) return true
      if (process.platform === 'win32' && sameSaio) return true
      return false
    })
    if (pids.length > 0 && killable.length === 0) {
      logger.error(
        `[listen] port ${PORT} in use by non-SAIO process(es): ` +
          pids.map((pid) => `${pid} (${pidCommandLine(pid) || 'unknown cmd'})`).join(', ') +
          ` — refusing to kill unknown processes; exiting. Free the port or set SERVER_PORT.`,
      )
      process.exit(1)
    }
    // SIGTERM dà all'orfano la chance di chiudere pulito; se dopo 2 giri è
    // ancora lì (hung vero), escalation a SIGKILL.
    const signal = listenAttempt >= 3 ? 'SIGKILL' : 'SIGTERM'
    for (const pid of killable) {
      logger.warn(`[listen] port ${PORT} held by orphan SAIO sidecar (pid ${pid}) — sending ${signal}`)
      try {
        process.kill(pid, signal)
      } catch (killErr) {
        if ((killErr as NodeJS.ErrnoException).code === 'EPERM') {
          // Sidecar di un ALTRO utente della macchina: non possiamo (né
          // dobbiamo) terminarlo — inutile ritentare.
          logger.error(`[listen] cannot kill pid ${pid} (EPERM — owned by another user?); exiting`)
          process.exit(1)
        }
        /* ESRCH: già terminato da solo */
      }
    }
    setTimeout(startListen, LISTEN_RETRY_DELAY_MS)
  })()
})

// Le sessioni Claude dei due account (~/.claude e ~/.claude-b) non si vedono fra
// loro: `ListAgents` legge solo il registro del proprio. Il ponte le specchia, così
// due sessioni sullo stesso repo possono annunciarsi come impone il manuale.
// Vedi lib/session-bridge.ts.
startSessionBridge()

startListen()

// ============================================================
// Graceful shutdown
// ============================================================
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully')
  process.exit(0)
})
process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully')
  process.exit(0)
})
