/**
 * V15.0 WS3 — Allowed emails store.
 * data/auth/allowed-emails.json contiene la lista chi può richiedere magic-link.
 * Parte vuota; popolata con owner al claim, poi inviti dall'UI owner.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteFile } from '../atomic-write'
import { authPath } from './constants'

export type AllowedRole = 'owner' | 'guest'

export interface AllowedEmail {
  email: string // lowercased
  role: AllowedRole
  invitedAt: string
  invitedBy?: string
  totpEnrolledAt: string | null
}

export interface Allowlist {
  version: 1
  entries: AllowedEmail[]
}

const EMPTY: Allowlist = { version: 1, entries: [] }

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function readAllowlist(dataDir: string): Promise<Allowlist> {
  try {
    const txt = await fs.readFile(authPath(dataDir, 'allowedEmails'), 'utf-8')
    const parsed = JSON.parse(txt) as Allowlist
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { ...EMPTY }
    return parsed
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return { ...EMPTY }
    throw err
  }
}

export async function writeAllowlist(dataDir: string, list: Allowlist): Promise<void> {
  const file = authPath(dataDir, 'allowedEmails')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await atomicWriteFile(file, JSON.stringify(list, null, 2))
}

/**
 * L'allowlist letta con cache invalidata dall'mtime.
 *
 * Serve perche' il ruolo va riletto a OGNI richiesta (vedi `effectiveRole`): rileggere e
 * riparsare il file ogni volta sarebbe un accesso al disco per chiamata API, tenerlo in
 * memoria senza controllo renderebbe invisibile una promozione fino al riavvio.
 */
let cache: { mtimeMs: number; list: Allowlist } | null = null

export async function readAllowlistCached(dataDir: string): Promise<Allowlist> {
  const file = authPath(dataDir, 'allowedEmails')
  try {
    const { mtimeMs } = await fs.stat(file)
    if (cache && cache.mtimeMs === mtimeMs) return cache.list
    const list = await readAllowlist(dataDir)
    cache = { mtimeMs, list }
    return list
  } catch {
    return { ...EMPTY }
  }
}

/**
 * Il ruolo che vale ADESSO per questa email.
 *
 * Il token dice CHI sei e non va rimesso in discussione; COSA puoi fare lo dice l'allowlist,
 * che e' l'unico posto dove l'owner scrive le sue decisioni. Tenere il ruolo solo dentro il
 * token significa che una promozione o una retrocessione non hanno effetto finche' quel token
 * non scade — e il cookie "dispositivo fidato" dura fino a 30 giorni.
 *
 * `fallback` (il ruolo scritto nel token) copre il caso in cui l'email non sia piu' in
 * allowlist: li' non si promuove nessuno, e comunque la revoca ha gia' invalidato le sessioni.
 */
export async function effectiveRole(
  dataDir: string,
  email: string,
  fallback: AllowedRole,
): Promise<AllowedRole> {
  const norm = normalizeEmail(email)
  const list = await readAllowlistCached(dataDir)
  return list.entries.find((e) => e.email === norm)?.role ?? fallback
}

export async function findAllowed(dataDir: string, email: string): Promise<AllowedEmail | null> {
  const norm = normalizeEmail(email)
  const list = await readAllowlist(dataDir)
  return list.entries.find((e) => e.email === norm) || null
}

export async function appendOwnerEntry(dataDir: string, email: string): Promise<void> {
  const norm = normalizeEmail(email)
  const list = await readAllowlist(dataDir)
  if (list.entries.find((e) => e.email === norm)) return
  list.entries.push({
    email: norm,
    role: 'owner',
    invitedAt: new Date().toISOString(),
    totpEnrolledAt: null,
  })
  await writeAllowlist(dataDir, list)
}

export async function appendGuestEntry(dataDir: string, email: string, invitedBy: string): Promise<AllowedEmail> {
  const norm = normalizeEmail(email)
  const list = await readAllowlist(dataDir)
  const existing = list.entries.find((e) => e.email === norm)
  if (existing) return existing
  const entry: AllowedEmail = {
    email: norm,
    role: 'guest',
    invitedAt: new Date().toISOString(),
    invitedBy,
    totpEnrolledAt: null,
  }
  list.entries.push(entry)
  await writeAllowlist(dataDir, list)
  return entry
}

export async function removeEntry(dataDir: string, email: string): Promise<boolean> {
  const norm = normalizeEmail(email)
  const list = await readAllowlist(dataDir)
  const before = list.entries.length
  list.entries = list.entries.filter((e) => e.email !== norm)
  if (list.entries.length === before) return false
  await writeAllowlist(dataDir, list)
  return true
}

export async function setTotpEnrolledAt(dataDir: string, email: string, ts: string | null): Promise<void> {
  const norm = normalizeEmail(email)
  const list = await readAllowlist(dataDir)
  const e = list.entries.find((x) => x.email === norm)
  if (!e) return
  e.totpEnrolledAt = ts
  await writeAllowlist(dataDir, list)
}
