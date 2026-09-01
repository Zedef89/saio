/**
 * Chi puo' fare cosa: l'unico posto dove sta scritto.
 *
 * Fino a qui i ruoli erano due (`owner`/`guest`) ma ne esisteva uno solo: l'unico gate era
 * `requireOwner` su `/api/admin/access`, quindi un invitato aveva gli stessi poteri del
 * proprietario tranne la pagina degli inviti. Su un'istanza condivisa da piu' persone questo
 * significa che chi entra per leggere i dati puo' anche rivelare le credenziali in chiaro,
 * cambiare gli account Claude e riscrivere il vault.
 *
 * La regola vive in una tabella e non sparsa nelle route per due motivi: si legge tutta in
 * una schermata (serve a decidere chi invitare, non solo al codice) e una route nuova nasce
 * accessibile ai guest solo se qualcuno ha deciso che lo sia, invece che per dimenticanza.
 *
 * ⚠️ Questo e' un guard rail applicativo, non un confine. SAIO gira come root e il terminale
 * spawna Claude in `bypassPermissions`: chi ha un PTY ha la macchina, e da li' tutto il resto
 * si raggiunge comunque. Il confine vero arriva con l'utente Unix separato per persona; fino
 * ad allora, `SAIO_GUEST_PTY=false` e' l'unico modo per chiudere davvero il terminale ai guest.
 */
import type { Request, Response, NextFunction } from 'express'
import { audit } from '../lib/auth/audit'
import { getClientIp, hashUserAgent } from '../lib/auth/ip-trust'

/** `WRITE` = tutto cio' che non e' una lettura (POST/PUT/PATCH/DELETE). */
type MethodClass = 'ALL' | 'WRITE' | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface Rule {
  methods: MethodClass
  path: RegExp
  /** Motivo, restituito al client e scritto nell'audit: serve a capire il 403 senza aprire il codice. */
  why: string
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * I path sono relativi a `/api` (`/credentials/x/reveal`, non `/api/credentials/x/reveal`).
 * Prima regola che combacia vince; l'ordine conta solo per leggibilita'.
 */
const OWNER_ONLY: Rule[] = [
  // ─── Segreti e accesso alle macchine ───────────────────────────────────────
  // Il reveal restituisce il valore in chiaro: e' la chiave di casa, non un dato di lavoro.
  { methods: 'ALL', path: /^\/credentials(\/|$)/, why: 'credenziali' },
  // Inventario chiavi SSH e server: da qui si arriva ai VPS dei clienti.
  { methods: 'ALL', path: /^\/ssh(\/|$)/, why: 'chiavi ssh' },
  { methods: 'ALL', path: /^\/vps(\/|$)/, why: 'inventario vps' },
  { methods: 'ALL', path: /^\/coolify(\/|$)/, why: 'infrastruttura coolify' },
  // Ridondante (c'e' gia' requireOwner sul mount), ma tenuta qui perche' la tabella deve
  // raccontare il modello per intero.
  { methods: 'ALL', path: /^\/admin(\/|$)/, why: 'gestione accessi' },

  // ─── Account Claude ────────────────────────────────────────────────────────
  // Le letture servono a tutti: la pagina Sessioni le usa per scegliere l'abbonamento con
  // cui aprire il proprio lavoro. Le scritture (secret, install, select globale) no.
  { methods: 'WRITE', path: /^\/accounts(\/|$)/, why: 'configurazione account' },
  { methods: 'ALL', path: /^\/accounts\/[^/]+\/has-secret$/, why: 'stato segreti account' },
  { methods: 'ALL', path: /^\/task-types(\/|$)/, why: 'routing dei task' },

  // ─── Macchina e manutenzione ───────────────────────────────────────────────
  // Scansione del filesystem, import progetti, token GitHub scritto su disco.
  { methods: 'ALL', path: /^\/scan(\/|$)/, why: 'scansione filesystem' },
  { methods: 'POST', path: /^\/system\/(install-obsidian|install-python-deps|tunnel-url)$/, why: 'manutenzione macchina' },
  // Uccidere un processo Playwright a caso non e' lavoro, e' manutenzione.
  { methods: 'DELETE', path: /^\/system\/playwright(\/|$)/, why: 'processi di sistema' },

  // ─── Vault ─────────────────────────────────────────────────────────────────
  // Lettura si': e' la memoria condivisa del team, chi lavora deve poterla consultare.
  // Scrittura no: un PUT sbagliato sovrascrive un WorkLog senza che nessuno se ne accorga.
  { methods: 'WRITE', path: /^\/vault(\/|$)/, why: 'scrittura vault' },

  // ─── Progetti ──────────────────────────────────────────────────────────────
  // Creare e modificare si', far sparire no.
  { methods: 'DELETE', path: /^\/projects(\/|$)/, why: 'cancellazione progetti' },
  { methods: 'POST', path: /^\/projects\/[^/]+\/(archive|restore|move)$/, why: 'archiviazione progetti' },
]

/**
 * Terminale ai guest. Acceso di default: senza PTY un invitato non puo' fare il lavoro per
 * cui lo si invita (aprire una sessione Claude e analizzare i dati). Si spegne con
 * `SAIO_GUEST_PTY=false` quando si vuole un ruolo di sola lettura vero — ed e' l'unico
 * interruttore che chiude davvero l'accesso root alla macchina.
 */
export function guestPtyAllowed(): boolean {
  return process.env.SAIO_GUEST_PTY !== 'false'
}

/** Rotte da negare ai guest quando il terminale e' spento: REST e creazione sessioni tmux. */
const PTY_RULES: Rule[] = [
  { methods: 'ALL', path: /^\/pty(\/|$)/, why: 'terminale' },
  { methods: 'WRITE', path: /^\/system\/tmux-sessions(\/|$)/, why: 'terminale' },
  { methods: 'ALL', path: /^\/orchestrator\/(spawn|kill)(\/|$)/, why: 'terminale' },
]

/** Path relativo a `/api`, senza query. Ricavato da originalUrl per non dipendere dal mount. */
function apiPath(req: Request): string {
  const raw = (req.originalUrl || req.url || '/').split('?')[0] || '/'
  return raw.startsWith('/api/') ? raw.slice(4) : raw
}

function matches(rule: Rule, method: string, path: string): boolean {
  if (!rule.path.test(path)) return false
  if (rule.methods === 'ALL') return true
  if (rule.methods === 'WRITE') return WRITE_METHODS.has(method)
  return rule.methods === method
}

/**
 * Nega ai guest le rotte della tabella. Va montato SUBITO dopo `requireAuth`, cosi' vale per
 * tutto quello che c'e' sotto `/api` senza doverlo ricordare route per route.
 */
export function accessPolicy(req: Request, res: Response, next: NextFunction): void {
  // Nessun utente = richiesta gia' respinta da requireAuth; owner = nessun limite.
  if (!req.user || req.user.role === 'owner') {
    next()
    return
  }
  const path = apiPath(req)
  const rules = guestPtyAllowed() ? OWNER_ONLY : [...OWNER_ONLY, ...PTY_RULES]
  const rule = rules.find((r) => matches(r, req.method, path))
  if (!rule) {
    next()
    return
  }
  void audit({
    type: 'access.denied',
    email: req.user.email,
    ip: getClientIp(req),
    userAgentHash: hashUserAgent(req),
    meta: { method: req.method, path, reason: rule.why },
  })
  res.status(403).json({ error: 'owner_only', reason: rule.why })
}
