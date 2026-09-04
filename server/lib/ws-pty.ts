import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { ptyManager, type SpawnOptions } from './pty-manager'
import { logger } from './logger'
import { COOKIE_ACCESS, COOKIE_TRUSTED, isAuthRequired } from './auth/constants'
import { verifyAccess, verifyTrusted } from './auth/jwt'
import { isSessionRevoked } from './auth/session-store'
import { effectiveRole } from './auth/allowlist'
import { audit } from './auth/audit'
import { guestPtyAllowed } from '../middleware/access-policy'

const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:3030',
  'http://127.0.0.1:3031',
  'http://localhost:3030',
  'http://localhost:3031',
  // Desktop webview (Tauri) + accesso via tunnel: origini della webview e del dominio pubblico.
  'tauri://localhost',
  'http://tauri.localhost',
  ...(process.env.DASHBOARD_AUTH_TUNNEL_URL ? [process.env.DASHBOARD_AUTH_TUNNEL_URL.replace(/\/$/, '')] : []),
])

/**
 * Parse SpawnOptions from WebSocket upgrade request URL query.
 *
 * Supported params:
 *   model=<id>               — override model
 *   permissionMode=<mode>    — default/plan/acceptEdits/bypassPermissions
 *   forceNew=true            — force new session (no --continue)
 *   accountId=<id>           — V13: account profile for provider/mode resolution
 *   vpsId=<id>               — V13: remote VPS via ssh (requires cliName)
 *   cliName=<name>           — V13: CLI binary on remote VPS (claude|codex|gemini|aichat)
 *   taskType=<id>            — V13: macro-task routing hint
 */
function parseSpawnOptions(rawUrl: string): SpawnOptions {
  const opts: SpawnOptions = {}
  try {
    const qIdx = rawUrl.indexOf('?')
    if (qIdx === -1) return opts
    const params = new URLSearchParams(rawUrl.slice(qIdx + 1))

    if (params.get('forceNew') === 'true') opts.forceNew = true

    const model = params.get('model')
    if (model && /^[a-zA-Z0-9._\-[\]]{1,64}$/.test(model)) opts.model = model

    const perm = params.get('permissionMode')
    if (perm && ['default', 'acceptEdits', 'bypassPermissions', 'plan'].includes(perm)) {
      opts.permissionMode = perm as any
    }

    const accountId = params.get('accountId')
    if (accountId && /^[a-zA-Z0-9_-]{1,64}$/.test(accountId)) opts.accountId = accountId

    // Worktree scelto dall'utente nel selettore. `worktreePath` è un path assoluto e viene
    // validato lato pty-manager (deve esistere); qui basta escludere caratteri da shell,
    // visto che finisce in una riga di comando tmux.
    const wtLabel = params.get('worktreeLabel')
    if (wtLabel && /^[a-zA-Z0-9._-]{1,40}$/.test(wtLabel)) opts.worktreeLabel = wtLabel

    const wtPath = params.get('worktreePath')
    if (wtPath && /^\/[a-zA-Z0-9._\-/]{1,200}$/.test(wtPath)) opts.worktreePath = wtPath

    const vpsId = params.get('vpsId')
    const cliName = params.get('cliName')
    if (
      vpsId && /^[a-zA-Z0-9_-]{1,64}$/.test(vpsId) &&
      cliName && /^[a-zA-Z0-9_-]{1,32}$/.test(cliName)
    ) {
      opts.remote = { vpsId, cliName }
    }

    const taskType = params.get('taskType')
    if (taskType && /^[a-z0-9_-]{1,64}$/.test(taskType)) opts.taskType = taskType
  } catch (err) {
    logger.warn('[ws-pty] parseSpawnOptions failed:', err)
  }
  return opts
}

// Richiesta LOCALE diretta = connessione TCP da loopback SENZA header di proxy.
// Le richieste inoltrate dal tunnel Cloudflare arrivano anch'esse a 127.0.0.1 (cloudflared
// gira in locale) MA con X-Forwarded-For settato → NON sono considerate locali.
// Speculare a isLocalDirectRequest() in middleware/require-auth.ts.
function isLocalDirectUpgrade(req: IncomingMessage): boolean {
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['forwarded']) return false
  const ip = req.socket?.remoteAddress || ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    if (!key) continue
    out[key] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

/**
 * IP del client sull'upgrade. `getClientIp` vuole una Request di Express e qui c'e' una
 * IncomingMessage nuda: stessa precedenza (CF-Connecting-IP, poi X-Forwarded-For), poche
 * righe invece di un cast.
 */
function upgradeIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.length > 0) return cf.trim()
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) return (xff.split(',')[0] || '').trim()
  return req.socket?.remoteAddress || '127.0.0.1'
}

/**
 * Autentica l'upgrade WebSocket riusando la STESSA logica fail-closed di requireAuth
 * (server/middleware/require-auth.ts). L'upgrade gira su server.on('upgrade'), fuori dai
 * middleware Express, quindi il controllo va replicato qui o il PTY (shell remota) resta
 * aperto a chiunque raggiunga il tunnel. Il browser same-origin invia già i cookie di
 * sessione nell'handshake; un client senza cookie/CF-Access valido viene rifiutato.
 */
/**
 * Esito dell'auth sull'upgrade. L'email non serve solo a loggare: su un'istanza condivisa
 * determina in quale worktree isolato nasce la sessione e con quale identità git si pusha,
 * quindi va propagata fino allo spawn invece di essere scartata.
 */
interface UpgradeAuth {
  ok: boolean
  email?: string
  /**
   * Ruolo di chi si collega. Il terminale vero passa da qui, non dalle route REST: senza il
   * ruolo sull'upgrade, spegnere il PTY ai guest lato Express non chiuderebbe niente.
   */
  role?: 'owner' | 'guest'
}

async function authenticateUpgrade(req: IncomingMessage, dataDir: string): Promise<UpgradeAuth> {
  // Master switch dev: bypassa tutto
  if (!isAuthRequired()) return { ok: true, role: 'owner' }
  // Desktop remote-only: la webview LOCALE entra senza login; il tunnel deve autenticarsi.
  if (process.env.DASHBOARD_AUTH_LOCAL_BYPASS === 'true' && isLocalDirectUpgrade(req))
    return { ok: true, role: 'owner' }
  // SSO via Cloudflare Access: header iniettato dall'edge dopo verifica identità.
  const cfEmailHeader = req.headers['cf-access-authenticated-user-email']
  const ownerEmail = (process.env.DASHBOARD_OWNER_EMAIL || '').trim().toLowerCase()
  if (typeof cfEmailHeader === 'string' && ownerEmail && cfEmailHeader.trim().toLowerCase() === ownerEmail) {
    return { ok: true, email: cfEmailHeader.trim().toLowerCase(), role: 'owner' }
  }
  const cookies = parseCookies(req.headers.cookie)
  // Trusted device cookie (long-lived) prima, poi access token.
  const trusted = cookies[COOKIE_TRUSTED]
  if (trusted) {
    const tp = await verifyTrusted(dataDir, trusted)
    if (tp && !(await isSessionRevoked(dataDir, tp.sid)))
      return { ok: true, email: tp.sub, role: await effectiveRole(dataDir, tp.sub, tp.role) }
  }
  const at = cookies[COOKIE_ACCESS]
  if (at) {
    const payload = await verifyAccess(dataDir, at)
    if (payload && !(await isSessionRevoked(dataDir, payload.sid)))
      return { ok: true, email: payload.sub, role: await effectiveRole(dataDir, payload.sub, payload.role) }
  }
  // Nessun ramo "basta Cloudflare Access": un guest revocato da SAIO resterebbe nella policy
  // Access e potrebbe riaprire un PTY. Il revoke deve chiudere tutto subito, quindi per i
  // guest serve sempre un cookie di sessione valido.
  return { ok: false }
}

/**
 * Questo progetto e' fra quelli assegnati a questa persona?
 *
 * `terminal` e i `tmux-…` non sono progetti: sono il terminale condiviso e l'attacco a una
 * sessione, che hanno gia' i loro controlli (`guestPtyAllowed`, `canActOnSession`).
 */
async function puoVedereProgetto(projectId: string, email: string | null | undefined): Promise<boolean> {
  if (!email) return false
  if (projectId === 'terminal' || projectId.startsWith('tmux-')) return true
  try {
    const [{ projectsStore }, { ownerSlugForEmail }] = await Promise.all([
      import('./projects-store'),
      import('./session-owner'),
    ])
    const p = await projectsStore.findById(projectId)
    if (!p) return false
    const persone = (p as { persone?: string[] }).persone
    if (!persone || persone.length === 0) return true
    const dataDir = process.env.DASHBOARD_DATA_DIR || pathJoinData()
    return persone.includes(await ownerSlugForEmail(dataDir, email))
  } catch {
    // Un errore qui non deve aprire: chi non si riesce a verificare non entra.
    return false
  }
}

function pathJoinData(): string {
  return `${process.cwd()}/data`
}

export function attachPtyWebSocket(server: HttpServer, dataDir: string) {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      try {
        const url = req.url || ''
        const match = url.match(/^\/api\/pty\/([a-zA-Z0-9_-]{1,64})(\?.*)?$/)
        if (!match) {
          socket.destroy()
          return
        }
        const origin = req.headers.origin
        if (origin && !ALLOWED_ORIGINS.has(origin)) {
          logger.warn(`[ws] rejected origin: ${origin}`)
          socket.destroy()
          return
        }
        const auth = await authenticateUpgrade(req, dataDir)
        if (!auth.ok) {
          logger.warn(`[ws] rejected unauthenticated upgrade from ${req.socket?.remoteAddress}`)
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        // Terminale spento per i guest: qui si chiude davvero, perche' il PTY nasce
        // sull'upgrade. Il 403 e' esplicito per non far sembrare l'interfaccia rotta.
        if (auth.role === 'guest' && !guestPtyAllowed()) {
          void audit({
            type: 'access.denied',
            email: auth.email,
            ip: upgradeIp(req),
            userAgentHash: '',
            meta: { path: url.split('?')[0], reason: 'terminale' },
          })
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        const projectId = match[1]
        // Un progetto che non gli e' stato dato non si apre nemmeno indovinandone l'id: il
        // filtro sulla lista nasconde la card, questo chiude la porta. E' la stessa ragione
        // per cui `requireOwner` sta sul mount e non solo nell'interfaccia.
        if (auth.role === 'guest' && !(await puoVedereProgetto(projectId, auth.email))) {
          void audit({
            type: 'access.denied',
            email: auth.email,
            ip: upgradeIp(req),
            userAgentHash: '',
            meta: { path: url.split('?')[0], projectId, reason: 'progetto non assegnato' },
          })
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        const spawnOpts = parseSpawnOptions(url)
        // Identità di chi apre la sessione: decide worktree isolato e credenziali git.
        if (auth.email) spawnOpts.userEmail = auth.email
        // Un terminale aperto e' l'azione piu' pesante dell'interfaccia: va nell'audit con
        // chi, quando e su quale progetto, altrimenti resta solo nei log applicativi.
        void audit({
          type: 'pty.opened',
          email: auth.email,
          ip: upgradeIp(req),
          userAgentHash: '',
          meta: { projectId, role: auth.role ?? 'owner' },
        })
        if (Object.keys(spawnOpts).length > 0) {
          logger.info(`[ws-pty] ${projectId} spawn opts from query: ${JSON.stringify(spawnOpts)}`)
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          handleConnection(ws, req, projectId, spawnOpts).catch((err) => {
            logger.error('[ws-pty] handleConnection failed:', err)
            try { ws.close(1011, 'handler error') } catch { /* ignore */ }
          })
        })
      } catch (err) {
        logger.error('ws upgrade err:', err)
        socket.destroy()
      }
    })()
  })
}

// Identificatore progressivo di connessione: serve a tenere separata la geometria di ogni
// browser collegato alla STESSA sessione PTY (iPhone e Mac sullo stesso progetto).
let nextClientId = 1

async function handleConnection(
  ws: WebSocket,
  _req: IncomingMessage,
  projectId: string,
  spawnOpts: SpawnOptions = {}
) {
  // Il socket è già aperto quando entriamo qui, ma la sessione può richiedere secondi a
  // nascere (spawn + attach tmux). Il client manda SUBITO il suo primo `resize` — cioè la
  // geometria reale del terminale — e senza un listener quel messaggio andrebbe perso: il
  // PTY resterebbe alla dimensione di default (100x30) mentre il browser ne mostra
  // un'altra, ed è una delle cause dei residui di righe. Bufferizziamo dal primo istante e
  // rigiochiamo appena la sessione è pronta.
  const earlyMessages: string[] = []
  const bufferEarly = (raw: unknown) => { earlyMessages.push(String(raw)) }
  ws.on('message', bufferEarly)

  const session = await ptyManager.getOrCreate(projectId, spawnOpts)
  if ('error' in session) {
    ws.off('message', bufferEarly)
    ws.send(JSON.stringify({ type: 'error', error: session.error }))
    ws.close()
    return
  }

  const clientId = nextClientId++

  // Ridisegno completo via tmux, con throttle: più richieste ravvicinate (scroll) collassano
  // in una sola. Il refresh scende per l'unico PTY della sessione, quindi ne beneficiano
  // tutti i browser collegati.
  const REFRESH_THROTTLE_MS = 120
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleRefresh = (delayMs = REFRESH_THROTTLE_MS) => {
    if (!session.tmuxBacked || refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void ptyManager.refreshTmux(projectId)
    }, delayMs)
  }

  // Replay del buffer storico al client appena connesso.
  // NON si fa per le sessioni tmux: quel buffer contiene sequenze di ridisegno posizionate
  // per le larghezze di prima, e riprodurle in un terminale di geometria diversa lasciava
  // frammenti di righe vecchie sovrapposti (il "residuo" che si vedeva rientrando o
  // scrollando). Con tmux la videata è ricostruibile su richiesta: la ridisegna il
  // refresh-client qui sotto, pulita e alla geometria corrente.
  if (!session.tmuxBacked && session.buffer.length > 0) {
    ws.send(JSON.stringify({ type: 'data', data: session.buffer.join('') }))
  } else if (session.tmuxBacked) {
    // Niente cronologia da versare: le sessioni Claude girano nello schermo alternato, dove
    // `history_size` di tmux resta 0 — la conversazione la conserva Claude, che la riavvolge
    // da sé quando riceve la rotella. Qui basta far ridisegnare a tmux la videata corrente.
    // L'attesa dà tempo al primo `resize` del client, così si ridisegna già alla geometria
    // giusta (e non due volte).
    scheduleRefresh(300)
  }

  // Forward pty → client
  const onData = (data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data }))
    }
  }
  session.listeners.add(onData)

  const onExit = (code: number) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code }))
      ws.close()
    }
  }
  session.exitHandlers.add(onExit)

  // Forward client → pty
  const onMessage = (raw: unknown) => {
    try {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'data' && typeof msg.data === 'string') {
        ptyManager.write(projectId, msg.data)
      } else if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
        ptyManager.setClientSize(projectId, clientId, msg.cols, msg.rows)
        // Sempre, anche se la geometria non è cambiata: senza SIGWINCH tmux non ridisegna
        // nulla e un client che si riaggancia con la stessa dimensione resterebbe al buio.
        scheduleRefresh()
      } else if (msg.type === 'refresh') {
        // Richiesta esplicita del frontend (fine scroll): ridisegna la videata intera.
        scheduleRefresh()
      } else if (msg.type === 'kill') {
        ptyManager.kill(projectId)
      }
    } catch {
      /* malformed */
    }
  }
  ws.off('message', bufferEarly)
  ws.on('message', onMessage)
  // Rigioca in ordine ciò che era arrivato durante lo spawn (di norma il primo resize).
  for (const raw of earlyMessages) onMessage(raw)
  earlyMessages.length = 0

  ws.on('close', () => {
    session.listeners.delete(onData)
    session.exitHandlers.delete(onExit)
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
    // Il vincolo di geometria di questo client non vale più: se restava stretto per colpa
    // sua, i device rimasti possono tornare a usare tutto lo spazio (e vanno ridisegnati).
    if (ptyManager.dropClientSize(projectId, clientId) && session.listeners.size > 0) {
      setTimeout(() => { void ptyManager.refreshTmux(projectId) }, REFRESH_THROTTLE_MS)
    }
    // NOTE: PTY session stays alive across client disconnects — user can reconnect
  })

  // Tell client ready
  ws.send(JSON.stringify({ type: 'ready', projectId, pid: session.proc.pid }))
}
