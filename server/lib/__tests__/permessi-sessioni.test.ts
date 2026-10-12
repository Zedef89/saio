/**
 * Permessi sulle sessioni (Nicola, 12/10/2026): tutti vedono, scrive solo chi ha aperto la
 * sessione, Nicola (super admin) scrive ovunque, la shell root e' solo sua.
 *
 * Gira con: npx tsx --test server/lib/__tests__/permessi-sessioni.test.ts
 *
 * Usa una data dir finta e un server tmux isolato (TMUX_TMPDIR): non tocca le sessioni vere.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'saio-permessi-'))
const DATA = path.join(TMP, 'data')
const TMUXDIR = path.join(TMP, 'tmux')
fs.mkdirSync(path.join(DATA, 'auth'), { recursive: true })
fs.mkdirSync(TMUXDIR, { recursive: true, mode: 0o700 })
process.env.DASHBOARD_DATA_DIR = DATA
process.env.DASHBOARD_AUTH_REQUIRED = 'true'
process.env.TMUX_TMPDIR = TMUXDIR
delete process.env.TMUX // dentro una sessione tmux, $TMUX vincerebbe su TMUX_TMPDIR
delete process.env.DASHBOARD_AUTH_LOCAL_BYPASS

const NICOLA = 'mele.nicola943@gmail.com'
const ALBERTO = 'albertogiunta2004@gmail.com'
const MARCO = 'marco.amico.lavoro@gmail.com'
const ANDREA = 'andrea@komandaprint.it'

fs.writeFileSync(
  path.join(DATA, 'git-identities.json'),
  JSON.stringify({
    [NICOLA]: { slug: 'nicola', name: 'Nicola Mele' },
    [ALBERTO]: { slug: 'alberto', name: 'Alberto Giunta' },
    [MARCO]: { slug: 'marco', name: 'Marco Amico' },
    [ANDREA]: { slug: 'andrea', name: 'Andrea Ricasoli' },
  }),
)
fs.writeFileSync(
  path.join(DATA, 'auth', 'owner.json'),
  JSON.stringify({ email: NICOLA, claimedAt: '2026-07-13T00:00:00Z', claimIp: '127.0.0.1' }),
)
// Ruoli dell'allowlist come in produzione: Alberto e Marco sono `owner`, ma non super admin.
fs.writeFileSync(
  path.join(DATA, 'auth', 'allowed-emails.json'),
  JSON.stringify({
    version: 1,
    entries: [
      { email: NICOLA, role: 'owner', invitedAt: '', totpEnrolledAt: null },
      { email: ALBERTO, role: 'owner', invitedAt: '', totpEnrolledAt: null },
      { email: MARCO, role: 'owner', invitedAt: '', totpEnrolledAt: null },
      { email: ANDREA, role: 'guest', invitedAt: '', totpEnrolledAt: null },
    ],
  }),
)

const { isSuperAdmin, canActOnSession } = await import('../session-owner')
const { accessoPty, puoChiuderePty } = await import('../pty-access')

const nessunPty = () => undefined
const u = async (email: string) => ({ email, superAdmin: await isSuperAdmin(DATA, email) })

after(() => {
  try { execFileSync('tmux', ['kill-server'], { env: process.env, stdio: 'ignore' }) } catch { /* nessun server */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

// ─── Chi e' il super admin ────────────────────────────────────────────────────

test('super admin: solo chi sta in owner.json, non gli owner dell allowlist', async () => {
  assert.equal(await isSuperAdmin(DATA, NICOLA), true)
  assert.equal(await isSuperAdmin(DATA, NICOLA.toUpperCase()), true)
  assert.equal(await isSuperAdmin(DATA, ALBERTO), false)
  assert.equal(await isSuperAdmin(DATA, MARCO), false)
  assert.equal(await isSuperAdmin(DATA, ANDREA), false)
  assert.equal(await isSuperAdmin(DATA, undefined), false)
})

// ─── Scrivere in una sessione ─────────────────────────────────────────────────

test('Nicola scrive in tutte le sessioni, anche senza proprietario', async () => {
  for (const s of ['andrea-lavoro', 'alberto-rev', 'marco-x', 'main', 'nicola-sessione-madre']) {
    assert.equal(await canActOnSession(DATA, s, { email: NICOLA }), true, s)
  }
})

test('gli altri scrivono solo nelle proprie: owner dell allowlist compresi', async () => {
  assert.equal(await canActOnSession(DATA, 'andrea-lavoro', { email: ANDREA }), true)
  assert.equal(await canActOnSession(DATA, 'nicola-sessione-madre', { email: ANDREA }), false)
  assert.equal(await canActOnSession(DATA, 'nicola-sessione-madre', { email: MARCO, role: 'owner' }), false)
  assert.equal(await canActOnSession(DATA, 'nicola-sessione-madre', { email: ALBERTO, role: 'owner' }), false)
  assert.equal(await canActOnSession(DATA, 'andrea-lavoro', { email: ALBERTO, role: 'owner' }), false)
  // Senza prefisso conosciuto: solo Nicola.
  assert.equal(await canActOnSession(DATA, 'main', { email: ALBERTO, role: 'owner' }), false)
})

test('WS tmux: chi non e proprietario la apre in sola lettura, su un PTY a parte', async () => {
  const andrea = await accessoPty(DATA, 'tmux-nicola-sessione-madre', await u(ANDREA), nessunPty)
  assert.deepEqual(andrea, { ok: true, key: 'tmuxro-nicola-sessione-madre', canWrite: false })
  const marco = await accessoPty(DATA, 'tmux-nicola-sessione-madre', await u(MARCO), nessunPty)
  assert.equal(marco.ok && marco.canWrite, false)
  const nicola = await accessoPty(DATA, 'tmux-andrea-lavoro', await u(NICOLA), nessunPty)
  assert.deepEqual(nicola, { ok: true, key: 'tmux-andrea-lavoro', canWrite: true })
  const propria = await accessoPty(DATA, 'tmux-andrea-lavoro', await u(ANDREA), nessunPty)
  assert.deepEqual(propria, { ok: true, key: 'tmux-andrea-lavoro', canWrite: true })
  // Chiedere direttamente la chiave di sola lettura non da' la scrittura.
  const ro = await accessoPty(DATA, 'tmuxro-andrea-lavoro', await u(ANDREA), nessunPty)
  assert.equal(ro.ok && ro.canWrite, false)
})

// ─── Shell root ───────────────────────────────────────────────────────────────

test('shell root (terminale condiviso e shell-root): solo Nicola', async () => {
  for (const id of ['terminal', 'shell-root']) {
    for (const email of [ALBERTO, MARCO, ANDREA]) {
      const r = await accessoPty(DATA, id, await u(email), nessunPty)
      assert.equal(r.ok, false, `${id} per ${email}`)
    }
  }
  const sr = await accessoPty(DATA, 'shell-root', await u(NICOLA), nessunPty)
  assert.deepEqual(sr, { ok: true, key: 'shell-root', canWrite: true, shellRootSession: 'nicola-shell-root' })
  const t = await accessoPty(DATA, 'terminal', await u(NICOLA), nessunPty)
  assert.equal(t.ok, true)
})

// ─── Card di progetto ─────────────────────────────────────────────────────────

test('card gia aperta da un altro: il secondo ha il suo PTY, non quello del primo', async () => {
  const pty = new Map<string, { ownerEmail?: string }>([['komalead', { ownerEmail: ALBERTO }]])
  const di = (k: string) => pty.get(k)
  const andrea = await accessoPty(DATA, 'komalead', await u(ANDREA), di)
  assert.deepEqual(andrea, { ok: true, key: 'komalead__andrea', canWrite: true, progettoId: 'komalead' })
  const alberto = await accessoPty(DATA, 'komalead', await u(ALBERTO), di)
  assert.deepEqual(alberto, { ok: true, key: 'komalead', canWrite: true })
  const libera = await accessoPty(DATA, 'komanda-dashboard', await u(ANDREA), di)
  assert.deepEqual(libera, { ok: true, key: 'komanda-dashboard', canWrite: true })
})

test('chiudere un PTY: le stesse regole', async () => {
  assert.equal(await puoChiuderePty(DATA, 'tmux-nicola-sessione-madre', await u(ANDREA), undefined), false)
  assert.equal(await puoChiuderePty(DATA, 'tmux-nicola-sessione-madre', await u(ALBERTO), undefined), false)
  assert.equal(await puoChiuderePty(DATA, 'tmux-andrea-lavoro', await u(ANDREA), undefined), true)
  assert.equal(await puoChiuderePty(DATA, 'tmuxro-nicola-sessione-madre', await u(ANDREA), undefined), true)
  assert.equal(await puoChiuderePty(DATA, 'terminal', await u(MARCO), undefined), false)
  assert.equal(await puoChiuderePty(DATA, 'komalead', await u(ANDREA), { ownerEmail: ALBERTO }), false)
  assert.equal(await puoChiuderePty(DATA, 'komalead', await u(ALBERTO), { ownerEmail: ALBERTO }), true)
  assert.equal(await puoChiuderePty(DATA, 'komalead', await u(NICOLA), { ownerEmail: ALBERTO }), true)
})

// ─── Le route REST: 403 a chi non e' proprietario ─────────────────────────────

let server: http.Server
let base = ''
let utenteCorrente: { email: string; role: 'owner' | 'guest'; sid: string } | null = null

before(async () => {
  const express = (await import('express')).default
  const { systemRouter } = await import('../../routes/system')
  const { ptyRouter } = await import('../../routes/pty')
  const { ptyManager } = await import('../pty-manager')
  const { attachPtyWebSocket } = await import('../ws-pty')
  ptyManager.setDataDir(DATA)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (utenteCorrente) req.user = utenteCorrente
    next()
  })
  app.use('/api/system', systemRouter())
  app.use('/api/pty', ptyRouter())
  server = http.createServer(app)
  attachPtyWebSocket(server, DATA)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})

after(async () => {
  const { ptyManager } = await import('../pty-manager')
  for (const s of ptyManager.list()) ptyManager.kill(s.projectId)
  await new Promise<void>((r) => server.close(() => r()))
})

const come = (email: string, role: 'owner' | 'guest') => {
  utenteCorrente = { email, role, sid: 'test' }
}

test('REST: chiudere, rinominare, cambiare account della sessione di Nicola → 403 per Andrea, Alberto, Marco', async () => {
  for (const [email, role] of [[ANDREA, 'guest'], [ALBERTO, 'owner'], [MARCO, 'owner']] as const) {
    come(email, role)
    const del = await fetch(`${base}/api/system/tmux-sessions/nicola-sessione-madre`, { method: 'DELETE' })
    assert.equal(del.status, 403, `DELETE ${email}`)
    const lab = await fetch(`${base}/api/system/tmux-sessions/nicola-sessione-madre/label`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    })
    assert.equal(lab.status, 403, `PATCH ${email}`)
    const acc = await fetch(`${base}/api/system/tmux-sessions/nicola-sessione-madre/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'default' }),
    })
    assert.equal(acc.status, 403, `account ${email}`)
  }
})

test('REST: Nicola passa il cancello su una sessione di un altro (404/500: la sessione finta non esiste)', async () => {
  come(NICOLA, 'owner')
  const del = await fetch(`${base}/api/system/tmux-sessions/andrea-inesistente-xyz`, { method: 'DELETE' })
  assert.notEqual(del.status, 403)
})

test('REST: una sessione senza Claude (shell root) la crea solo Nicola', async () => {
  come(ALBERTO, 'owner')
  const r = await fetch(`${base}/api/system/tmux-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'shell', startClaude: false }),
  })
  assert.equal(r.status, 403)
  assert.equal((await r.json()).error, 'shell_root_solo_admin')
})

test('REST: la lista dice a ciascuno dove puo scrivere', async () => {
  execFileSync('tmux', ['new-session', '-d', '-s', 'nicola-lista-prova', 'sleep 60'], { env: process.env })
  execFileSync('tmux', ['new-session', '-d', '-s', 'andrea-lista-prova', 'sleep 60'], { env: process.env })
  come(ANDREA, 'guest')
  const a = await (await fetch(`${base}/api/system/tmux-sessions`)).json()
  const per = (j: { sessions: { name: string; canWrite: boolean }[] }, n: string) => j.sessions.find((s) => s.name === n)?.canWrite
  assert.equal(per(a, 'nicola-lista-prova'), false)
  assert.equal(per(a, 'andrea-lista-prova'), true)
  come(NICOLA, 'owner')
  const n = await (await fetch(`${base}/api/system/tmux-sessions`)).json()
  assert.equal(per(n, 'andrea-lista-prova'), true)
  assert.equal(n.superAdmin, true)
})

// ─── Il WebSocket del terminale: il blocco vero ───────────────────────────────

async function tokenPer(email: string, role: 'owner' | 'guest'): Promise<string> {
  const { signTokenPair } = await import('../auth/jwt')
  const { createSession } = await import('../auth/session-store')
  const pair = await signTokenPair(DATA, email, role)
  const now = new Date().toISOString()
  await createSession(DATA, {
    jti: pair.jti, sid: pair.sid, email, role, createdAt: now, refreshedAt: now,
    expiresAt: pair.refreshExpiresAt, ip: '127.0.0.1', userAgentHash: '', revoked: false,
  })
  return pair.access
}

type Esito = { status: number } | { status: 101; ready: any; ws: import('ws').WebSocket }

async function apri(id: string, email: string, role: 'owner' | 'guest'): Promise<Esito> {
  const { WebSocket } = await import('ws')
  const { COOKIE_ACCESS } = await import('../auth/constants')
  const token = await tokenPer(email, role)
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/pty/${id}`, {
      headers: { cookie: `${COOKIE_ACCESS}=${token}` },
    })
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode || 0 }))
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      if (m.type === 'ready') resolve({ status: 101, ready: m, ws })
      if (m.type === 'error') reject(new Error(m.error))
    })
    ws.on('error', () => { /* gestito da unexpected-response */ })
    setTimeout(() => reject(new Error('timeout ws')), 8000)
  })
}

function schermo(sessione: string): string {
  return execFileSync('tmux', ['capture-pane', '-p', '-t', `=${sessione}:`], { env: process.env, encoding: 'utf8' })
}
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('WS: la shell root rifiuta (403) Andrea, Alberto e Marco', async () => {
  for (const id of ['terminal', 'shell-root']) {
    for (const [email, role] of [[ANDREA, 'guest'], [ALBERTO, 'owner'], [MARCO, 'owner']] as const) {
      const r = await apri(id, email, role)
      assert.equal(r.status, 403, `${id} per ${email}`)
    }
  }
})

test('WS: Andrea e Alberto vedono la sessione di Nicola ma i loro tasti non arrivano; quelli di Nicola si', async () => {
  // Una sessione «di Nicola» sul server tmux isolato: una shell che ripete quello che riceve.
  execFileSync('tmux', ['new-session', '-d', '-s', 'nicola-prova-ws', '-x', '120', '-y', '30', 'cat'], { env: process.env })
  await pausa(300)

  const spettatori: { ws: import('ws').WebSocket; visto: string[] }[] = []
  for (const [email, role, parola] of [[ANDREA, 'guest', 'SCRITTODAANDREA'], [ALBERTO, 'owner', 'SCRITTODAALBERTO']] as const) {
    const r = await apri('tmux-nicola-prova-ws', email, role)
    assert.equal(r.status, 101)
    if (r.status !== 101 || !('ws' in r)) throw new Error('non aperta')
    assert.equal(r.ready.readOnly, true, email)
    assert.equal(r.ready.projectId, 'tmux-nicola-prova-ws')
    r.ws.send(JSON.stringify({ type: 'data', data: `${parola}\r` }))
    r.ws.send(JSON.stringify({ type: 'kill' }))
    await pausa(600)
    assert.ok(!schermo('nicola-prova-ws').includes(parola), `il testo di ${email} e' arrivato`)
    const visto: string[] = []
    r.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      if (m.type === 'data') visto.push(m.data)
    })
    spettatori.push({ ws: r.ws, visto })
  }
  // La sessione e' ancora viva (il `kill` di chi guarda non l'ha chiusa).
  execFileSync('tmux', ['has-session', '-t', '=nicola-prova-ws'], { env: process.env })

  const n = await apri('tmux-nicola-prova-ws', NICOLA, 'owner')
  if (n.status !== 101 || !('ws' in n)) throw new Error('Nicola non entra')
  assert.equal(n.ready.readOnly, false)
  n.ws.send(JSON.stringify({ type: 'data', data: 'SCRITTODANICOLA\r' }))
  await pausa(600)
  assert.ok(schermo('nicola-prova-ws').includes('SCRITTODANICOLA'))
  // E chi guarda lo vede comparire.
  for (const sp of spettatori) {
    assert.ok(sp.visto.join('').includes('SCRITTODANICOLA'), 'chi guarda non vede')
    sp.ws.close()
  }
  n.ws.close()
})

test('WS: Nicola scrive nella sessione di Andrea', async () => {
  execFileSync('tmux', ['new-session', '-d', '-s', 'andrea-prova-ws', '-x', '120', '-y', '30', 'cat'], { env: process.env })
  await pausa(300)
  const n = await apri('tmux-andrea-prova-ws', NICOLA, 'owner')
  if (n.status !== 101 || !('ws' in n)) throw new Error('Nicola non entra')
  assert.equal(n.ready.readOnly, false)
  n.ws.send(JSON.stringify({ type: 'data', data: 'NICOLAQUI\r' }))
  await pausa(600)
  assert.ok(schermo('andrea-prova-ws').includes('NICOLAQUI'))
  n.ws.close()
})
