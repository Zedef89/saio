/**
 * V15.0 WS3-3D — Audit log JSONL append-only.
 * Una riga = un JSON event. Mai cancellato dal codice (rotation manuale via SSH).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Request } from 'express'
import { authPath, AUTH_DIR_NAME } from './constants'
import { getClientIp, hashUserAgent } from './ip-trust'
import { logger } from '../logger'

export type AuditEventType =
  | 'claim.requested'
  | 'claim.completed'
  | 'login.requested'
  | 'login.success'
  | 'login.failed'
  | 'totp.enrolled'
  | 'totp.failed'
  | 'totp.recovery_used'
  | 'session.created'
  | 'session.refreshed'
  | 'session.revoked'
  | 'invite.sent'
  | 'invite.revoked'
  | 'ban.added'
  | 'unauthorized.access'
  // Azioni, non solo accessi. Fino a qui il log rispondeva a "chi e' entrato"; senza queste
  // righe, davanti a una credenziale usata male o a un WorkLog sovrascritto si sa solo chi
  // era loggato quel giorno, non chi ha fatto cosa. Su un'istanza condivisa non basta.
  | 'access.denied'
  | 'credential.revealed'
  | 'vault.written'
  | 'pty.opened'
  | 'tmux.created'
  | 'tmux.killed'
  | 'tmux.account.switched'
  // Il cancello: chi cambia una regola dei permessi, e chi decide una richiesta. Senza
  // queste righe una concessione resta senza autore, e una concessione senza autore e'
  // indistinguibile da un aggiramento.
  | 'permessi.regola.modificata'
  | 'permessi.accesso.modificato'
  | 'permessi.richiesta.decisa'

export interface AuditEvent {
  ts: string
  type: AuditEventType
  email?: string
  ip: string
  userAgentHash: string
  meta?: Record<string, unknown>
}

let cachedDataDir: string | null = null

export function setAuditDataDir(dataDir: string): void {
  cachedDataDir = dataDir
}

export async function audit(event: Omit<AuditEvent, 'ts'>): Promise<void> {
  if (!cachedDataDir) {
    logger.warn('[audit] data dir not set — event lost', event.type)
    return
  }
  const full: AuditEvent = { ts: new Date().toISOString(), ...event }
  const file = authPath(cachedDataDir, 'auditLog')
  try {
    // Ensure dir esiste (defensive — datadirs.ts dovrebbe averla creata)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, JSON.stringify(full) + '\n', 'utf-8')
  } catch (err) {
    logger.error('[audit] write failed', err, full)
  }
}

/**
 * Stessa riga di audit, ma con chi/da dove ricavati dalla richiesta. Esiste per non ripetere
 * `getClientIp`/`hashUserAgent` in ogni route che registra un'azione: quattro righe copiate
 * dieci volte diventano dieci occasioni di dimenticarne una.
 *
 * Fire-and-forget di proposito: un audit che fallisce non deve far fallire l'azione (e
 * l'errore finisce comunque nei log del server).
 */
export function auditAction(
  req: Request,
  type: AuditEventType,
  meta?: Record<string, unknown>,
): void {
  void audit({
    type,
    email: req.user?.email,
    ip: getClientIp(req),
    userAgentHash: hashUserAgent(req),
    meta,
  })
}

void AUTH_DIR_NAME // keep import side-effect-free
