/**
 * V15.0 WS3-3C — Sessions store + revocation list.
 *
 * sessions.json indice principale per refresh tokens. revoked-tokens.json mantiene
 * jti revocati fino alla loro original expiresAt (poi GC). isSessionRevoked è
 * usata da requireAuth ogni request.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteFile } from '../atomic-write'
import { authPath } from './constants'

export type SessionRole = 'owner' | 'guest'

export interface Session {
  jti: string // refresh token jwt id
  sid: string // session id (in access token payload)
  email: string
  role: SessionRole
  createdAt: string
  refreshedAt: string
  expiresAt: string // refresh exp = createdAt + 7d
  ip: string
  userAgentHash: string
  revoked: boolean
  revokedReason?: 'logout' | 'admin-revoke' | 'rotated' | 'global-revoke'
}

interface SessionStore {
  version: 1
  sessions: Session[]
}

interface RevokedRecord {
  jti: string
  /**
   * La sessione revocata, oppure null quando a essere bruciato e' solo un refresh token.
   *
   * La distinzione e' il cuore del problema: `isSessionRevoked` cerca per sid, quindi
   * scrivere qui un sid vivo equivale a buttare fuori quella sessione. Una rotazione di
   * refresh token non revoca la sessione, brucia un token: va registrata per jti e basta.
   */
  sid: string | null
  revokedAt: string
  expiresAt: string
}

interface RevokedStore {
  version: 1
  revoked: RevokedRecord[]
}

const EMPTY_SESS: SessionStore = { version: 1, sessions: [] }
const EMPTY_REV: RevokedStore = { version: 1, revoked: [] }

async function readSessions(dataDir: string): Promise<SessionStore> {
  try {
    const txt = await fs.readFile(authPath(dataDir, 'sessions'), 'utf-8')
    const parsed = JSON.parse(txt) as SessionStore
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return { ...EMPTY_SESS }
    return parsed
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return { ...EMPTY_SESS }
    throw err
  }
}

async function writeSessions(dataDir: string, store: SessionStore): Promise<void> {
  const file = authPath(dataDir, 'sessions')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await atomicWriteFile(file, JSON.stringify(store, null, 2))
}

async function readRevoked(dataDir: string): Promise<RevokedStore> {
  try {
    const txt = await fs.readFile(authPath(dataDir, 'revokedTokens'), 'utf-8')
    const parsed = JSON.parse(txt) as RevokedStore
    if (parsed.version !== 1 || !Array.isArray(parsed.revoked)) return { ...EMPTY_REV }
    return parsed
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return { ...EMPTY_REV }
    throw err
  }
}

async function writeRevoked(dataDir: string, store: RevokedStore): Promise<void> {
  const file = authPath(dataDir, 'revokedTokens')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await atomicWriteFile(file, JSON.stringify(store, null, 2))
}

function gcSessions(store: SessionStore): SessionStore {
  const now = Date.now()
  store.sessions = store.sessions.filter((s) => new Date(s.expiresAt).getTime() > now)
  return store
}

function gcRevoked(store: RevokedStore): RevokedStore {
  const now = Date.now()
  store.revoked = store.revoked.filter((r) => new Date(r.expiresAt).getTime() > now)
  return store
}

/**
 * Fino a quando deve restare in vita il RECORD di sessione.
 *
 * Il record scadeva con il refresh token (7 giorni), ma il cookie "dispositivo fidato" dura
 * fino a 30: passato il settimo giorno il record era scaduto e la prima scrittura su
 * sessions.json lo faceva sparire per garbage collection. Da quel momento `isSessionRevoked`
 * non lo trovava piu' e — giustamente fail-closed — trattava come revocato un cookie ancora
 * valido, buttando fuori il dispositivo senza che nessuno avesse revocato niente.
 *
 * Successo il 01/09/2026 ad Alberto: cookie valido fino al 19/09, record scaduto il 27/08,
 * sparito alla prima scrittura del file. Quindi il record vive quanto il piu' lungo dei tre:
 * il refresh, l'eventuale fiducia al dispositivo, e la scadenza che aveva gia' (perche' un
 * refresh non deve accorciare la finestra di un dispositivo fidato).
 */
export function sessionExpiry(
  refreshExpiresAt: string,
  opts: { trustDays?: number | null; previousExpiresAt?: string } = {},
): string {
  const candidates = [Date.parse(refreshExpiresAt)]
  if (opts.trustDays) candidates.push(Date.now() + opts.trustDays * 24 * 60 * 60_000)
  if (opts.previousExpiresAt) candidates.push(Date.parse(opts.previousExpiresAt))
  return new Date(Math.max(...candidates.filter((n) => Number.isFinite(n)))).toISOString()
}

export async function createSession(dataDir: string, sess: Session): Promise<void> {
  let store = await readSessions(dataDir)
  store = gcSessions(store)
  store.sessions.push(sess)
  await writeSessions(dataDir, store)
}

export async function findSessionBySid(dataDir: string, sid: string): Promise<Session | null> {
  const store = await readSessions(dataDir)
  return store.sessions.find((s) => s.sid === sid && !s.revoked) || null
}

export async function findSessionByJti(dataDir: string, jti: string): Promise<Session | null> {
  const store = await readSessions(dataDir)
  return store.sessions.find((s) => s.jti === jti && !s.revoked) || null
}

/**
 * Ruota il refresh token di una sessione, in un solo record e **senza cambiare il sid**.
 *
 * Prima ogni refresh creava una sessione nuova con un sid nuovo e marcava la vecchia
 * `rotated`. Due conseguenze, entrambe sbagliate: il cookie di dispositivo fidato resta
 * agganciato al sid vecchio, che diventava revocato — quindi un refresh buttava fuori il
 * dispositivo; e il sid nuovo finiva nella lista delle revoche (il vecchio codice passava
 * `newSession.sid`, con tanto di commento che ammetteva lo scambio), quindi la sessione
 * appena creata nasceva gia' revocata.
 *
 * Il sid identifica la SESSIONE, il jti il singolo refresh token: a ruotare e' il secondo.
 * Il primo resta, ed e' cio' che tiene in piedi il dispositivo fidato per tutti i suoi giorni.
 */
export async function rotateSession(
  dataDir: string,
  oldJti: string,
  next: Session
): Promise<void> {
  let store = await readSessions(dataDir)
  store = gcSessions(store)
  const idx = store.sessions.findIndex((s) => s.jti === oldJti)
  // Record sparito (per esempio ripulito dalla GC): si ricrea invece di perdere la sessione.
  if (idx >= 0) store.sessions[idx] = next
  else store.sessions.push(next)
  await writeSessions(dataDir, store)
  // Solo il token: `null` al posto del sid, altrimenti si revoca la sessione che si sta rinnovando.
  await addRevoked(dataDir, oldJti, null, next.expiresAt)
}

export async function revokeSession(
  dataDir: string,
  sid: string,
  reason: 'logout' | 'admin-revoke' | 'global-revoke'
): Promise<void> {
  const sessStore = await readSessions(dataDir)
  const idx = sessStore.sessions.findIndex((s) => s.sid === sid)
  if (idx >= 0) {
    const sess = sessStore.sessions[idx]
    if (sess) {
      sess.revoked = true
      sess.revokedReason = reason
      sessStore.sessions[idx] = sess
      await writeSessions(dataDir, sessStore)
      await addRevoked(dataDir, sess.jti, sess.sid, sess.expiresAt)
    }
  }
}

export async function revokeAllSessionsForEmail(
  dataDir: string,
  email: string,
  reason: 'admin-revoke' | 'global-revoke'
): Promise<number> {
  const sessStore = await readSessions(dataDir)
  let revoked = 0
  const norm = email.toLowerCase()
  for (const s of sessStore.sessions) {
    if (s.email === norm && !s.revoked) {
      s.revoked = true
      s.revokedReason = reason
      revoked++
      await addRevoked(dataDir, s.jti, s.sid, s.expiresAt)
    }
  }
  if (revoked > 0) await writeSessions(dataDir, sessStore)
  return revoked
}

export async function addRevoked(
  dataDir: string,
  jti: string,
  sid: string | null,
  expiresAt: string
): Promise<void> {
  let store = await readRevoked(dataDir)
  store = gcRevoked(store)
  if (!store.revoked.find((r) => r.jti === jti || (sid !== null && r.sid === sid))) {
    store.revoked.push({ jti, sid, revokedAt: new Date().toISOString(), expiresAt })
    await writeRevoked(dataDir, store)
  }
}

export async function isSessionRevoked(dataDir: string, sid: string): Promise<boolean> {
  // Check revoked list first (fast)
  const rev = await readRevoked(dataDir)
  // `r.sid === null` = solo un refresh token bruciato: non dice niente sulla sessione.
  if (rev.revoked.find((r) => r.sid !== null && r.sid === sid)) return true
  // Fallback: session itself flagged revoked
  const sess = await findSessionBySid(dataDir, sid)
  if (!sess) return true // session deleted/expired = treat as revoked
  return sess.revoked
}
