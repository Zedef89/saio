/**
 * V15.0 WS3-3C — requireAuth + requireOwner middlewares.
 *
 * Bypassi:
 *  - DASHBOARD_AUTH_REQUIRED=false → tutti req.user = dev-owner placeholder
 *  - req.skipAuth=true (settato da cron-bypass middleware) → next()
 *
 * Read access cookie saio_at → verify JWT → check session not revoked.
 * Set req.user = {email, role, sid}.
 */
import type { Request, Response, NextFunction } from 'express'
import { COOKIE_ACCESS, COOKIE_TRUSTED, isAuthRequired } from '../lib/auth/constants'
import { verifyAccess, verifyTrusted } from '../lib/auth/jwt'
import { isSessionRevoked } from '../lib/auth/session-store'
import { effectiveRole } from '../lib/auth/allowlist'
import { audit } from '../lib/auth/audit'
import { getClientIp, hashUserAgent } from '../lib/auth/ip-trust'

declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      email: string
      role: 'owner' | 'guest'
      sid: string
    }
  }
}

const DEV_USER = { email: 'dev@local', role: 'owner' as const, sid: 'dev-bypass' }

// Richiesta LOCALE diretta = connessione TCP da loopback SENZA header di proxy.
// Le richieste inoltrate dal tunnel Cloudflare arrivano anch'esse a 127.0.0.1 (cloudflared
// gira in locale) MA con X-Forwarded-For settato → NON sono considerate locali.
// Usato per il bypass auth desktop: la webview locale entra senza login, il tunnel no.
function isLocalDirectRequest(req: Request): boolean {
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['forwarded']) return false
  const ip = req.socket?.remoteAddress || ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

export function makeRequireAuth(dataDir: string) {
  return async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Bypass per cron token già validato
    if (req.skipAuth) {
      req.user = DEV_USER
      next()
      return
    }
    // Master switch dev: bypassa tutto
    if (!isAuthRequired()) {
      req.user = DEV_USER
      next()
      return
    }
    // Desktop remote-only: la webview LOCALE entra senza login; gli accessi dal tunnel
    // (X-Forwarded-For / CF-Connecting-IP presenti) devono autenticarsi normalmente.
    if (process.env.DASHBOARD_AUTH_LOCAL_BYPASS === 'true' && isLocalDirectRequest(req)) {
      req.user = DEV_USER
      next()
      return
    }
    // SSO via Cloudflare Access: gli accessi dal tunnel passano prima da Cloudflare Access,
    // che verifica l'identità e inietta l'header Cf-Access-Authenticated-User-Email. Se l'email
    // corrisponde all'owner autorizzato, l'utente è autenticato (Access ha già fatto il lavoro).
    // Fail-closed: senza Access configurato, l'header manca → 401.
    const cfEmailHeader = req.headers['cf-access-authenticated-user-email']
    const ownerEmail = (process.env.DASHBOARD_OWNER_EMAIL || '').trim().toLowerCase()
    if (typeof cfEmailHeader === 'string' && ownerEmail && cfEmailHeader.trim().toLowerCase() === ownerEmail) {
      req.user = { email: cfEmailHeader.trim(), role: 'owner', sid: 'cf-access' }
      next()
      return
    }
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies || {}

    // V15.0 WS6 — Trusted device cookie check FIRST (long-lived, opt-in)
    const trusted = cookies[COOKIE_TRUSTED]
    if (trusted) {
      const tp = await verifyTrusted(dataDir, trusted)
      if (tp) {
        if (await isSessionRevoked(dataDir, tp.sid)) {
          await audit({
            type: 'unauthorized.access',
            email: tp.sub,
            ip: getClientIp(req),
            userAgentHash: hashUserAgent(req),
            meta: { reason: 'trusted_session_revoked', sid: tp.sid },
          })
          res.status(401).json({ error: 'session_revoked' })
          return
        }
        req.user = { email: tp.sub, role: await effectiveRole(dataDir, tp.sub, tp.role), sid: tp.sid }
        next()
        return
      }
      // Trusted invalid (scaduto o secret rotated) → fall through a saio_at
    }

    const at = cookies[COOKIE_ACCESS]
    if (!at) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    const payload = await verifyAccess(dataDir, at)
    if (!payload) {
      res.status(401).json({ error: 'invalid_token' })
      return
    }
    if (await isSessionRevoked(dataDir, payload.sid)) {
      await audit({
        type: 'unauthorized.access',
        email: payload.sub,
        ip: getClientIp(req),
        userAgentHash: hashUserAgent(req),
        meta: { reason: 'session_revoked', sid: payload.sid },
      })
      res.status(401).json({ error: 'session_revoked' })
      return
    }
    // Ruolo dall'allowlist, non dal token: vedi `effectiveRole`.
    req.user = { email: payload.sub, role: await effectiveRole(dataDir, payload.sub, payload.role), sid: payload.sid }
    next()
  }
}

export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthenticated' })
    return
  }
  if (req.user.role !== 'owner') {
    res.status(403).json({ error: 'owner_only' })
    return
  }
  next()
}
