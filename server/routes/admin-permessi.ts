/**
 * Permessi per progetto e per azione (owner-only).
 *
 * Il cancello — l'hook PreToolUse `saio-cancello.py` — decide cosa una sessione può fare
 * da sé e cosa deve chiedere. Le sue regole vivono in `<dataDir>/cancello/regole.json`,
 * e finora si modificavano solo a mano. Qui si governano dal pannello.
 *
 * Due cose da sapere prima di leggere il codice:
 *
 * 1. **Gli owner non sono mai soggetti al cancello.** Sulla produzione decidono loro
 *    (regola 1 del manuale della devbox): un permesso chiesto a chi lo concede è un giro
 *    a vuoto, e l'attrito si aggira — che è il problema da cui il cancello nasce. Questo
 *    endpoint non permette di attivare una regola sugli owner: non è una svista.
 *
 * 2. **Non è un confine di sicurezza.** Tutto gira come root e un agente determinato
 *    aggira l'hook; inoltre l'hook fallisce aperto di proposito, perché un hook rotto non
 *    deve fermare il lavoro di nessuno. Serve a far emergere quello che oggi succede in
 *    silenzio (misurato: il 56,6% dei blocchi viene aggirato senza che nessuno lo sappia).
 *    Il confine vero resta l'utente Unix separato per persona.
 */
import { Router, type Request, type Response } from 'express'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../lib/atomic-write'
import { audit } from '../lib/auth/audit'
import { getClientIp, hashUserAgent } from '../lib/auth/ip-trust'
import { logger } from '../lib/logger'

interface Regola {
  id: string
  titolo: string
  perche: string
  invece: string
  attiva?: boolean
  nota?: string
  quando: {
    strumento?: string[]
    regex?: string
    regex_intero?: string
    e_anche?: string
    tranne_se?: string[]
    dove?: string
    non_dove?: string
    tranne_persone?: string[]
  }
}

interface Richiesta {
  id: string
  stato: string
  regola: string
  titolo: string
  persona: string
  sessione: string
  cosa: string
  dove: string
  aperta: string
  perche: string | null
  prova: string | null
}

const Patch = z.object({
  attiva: z.boolean().optional(),
  progetti: z.array(z.string().max(120)).max(60).optional(),
  esenti: z.array(z.string().max(60)).max(20).optional(),
})

const Decisione = z.object({
  approva: z.boolean(),
  perche: z.string().max(600).optional(),
  perSessione: z.boolean().optional(),
})

/** I nomi dei progetti diventano un'alternativa di regex: `(a|b|c)`. */
function progettiToRegex(progetti: string[]): string | undefined {
  const puliti = progetti.map((p) => p.trim()).filter(Boolean)
  if (!puliti.length) return undefined
  return `(${puliti.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
}

/** …e viceversa, per mostrare nel pannello quali progetti sono selezionati. */
function regexToProgetti(dove: string | undefined): string[] {
  if (!dove) return []
  return dove.replace(/^\(|\)$/g, '').split('|').map((p) => p.replace(/\\(.)/g, '$1')).filter(Boolean)
}

export function adminPermessiRouter(dataDir: string): Router {
  const router = Router()
  const fileRegole = path.join(dataDir, 'cancello', 'regole.json')
  const fileRichieste = path.join(dataDir, 'cancello', 'richieste.json')
  const fileConcessioni = path.join(dataDir, 'cancello', 'concessioni.json')

  async function leggi<T>(file: string, vuoto: T): Promise<T> {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8')) as T
    } catch {
      return vuoto
    }
  }

  // ─────────────────── STATO ───────────────────
  router.get('/', async (_req, res) => {
    const regole = await leggi<{ regole: Regola[] }>(fileRegole, { regole: [] })
    const richieste = await leggi<{ richieste: Richiesta[] }>(fileRichieste, { richieste: [] })
    let progetti: string[] = []
    try {
      const p = JSON.parse(await fsp.readFile(path.join(dataDir, 'projects.json'), 'utf8'))
      const elenco = Array.isArray(p) ? p : p.projects || []
      progetti = elenco.map((x: { name?: string; id?: string }) => x.name || x.id || '').filter(Boolean)
    } catch {
      progetti = []
    }
    res.json({
      regole: regole.regole.map((r) => ({
        id: r.id,
        titolo: r.titolo,
        perche: r.perche,
        invece: r.invece,
        attiva: r.attiva !== false,
        nota: r.nota || null,
        progetti: regexToProgetti(r.quando.dove),
        esenti: r.quando.tranne_persone || [],
        valeOvunque: !r.quando.dove,
      })),
      progetti,
      inAttesa: richieste.richieste.filter((x) => x.stato === 'aperta'),
      abbozzate: richieste.richieste.filter((x) => x.stato === 'abbozzata').length,
    })
  })

  // ─────────────────── MODIFICA UNA REGOLA ───────────────────
  router.patch('/regole/:id', async (req: Request, res: Response): Promise<void> => {
    const parsed = Patch.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'payload non valido' })
      return
    }
    const store = await leggi<{ regole: Regola[] }>(fileRegole, { regole: [] })
    const r = store.regole.find((x) => x.id === req.params.id)
    if (!r) {
      res.status(404).json({ error: 'regola sconosciuta' })
      return
    }
    const { attiva, progetti, esenti } = parsed.data
    if (attiva !== undefined) r.attiva = attiva
    if (progetti !== undefined) {
      const dove = progettiToRegex(progetti)
      if (dove) r.quando.dove = dove
      else delete r.quando.dove // nessun progetto selezionato = vale ovunque
    }
    if (esenti !== undefined) r.quando.tranne_persone = esenti

    await atomicWriteFile(fileRegole, JSON.stringify(store, null, 1))
    await audit({
      type: 'permessi.regola.modificata',
      email: req.user?.email,
      ip: getClientIp(req),
      userAgentHash: hashUserAgent(req),
      meta: { regola: r.id, attiva: r.attiva !== false, progetti: progetti?.length ?? null },
    }).catch((err) => logger.error('[permessi] audit fallito:', err))

    res.json({ ok: true })
  })

  // ─────────────────── DECIDI UNA RICHIESTA ───────────────────
  router.post('/richieste/:id', async (req: Request, res: Response): Promise<void> => {
    const parsed = Decisione.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'payload non valido' })
      return
    }
    const chi = req.user?.email || 'sconosciuto'
    const store = await leggi<{ richieste: Richiesta[] }>(fileRichieste, { richieste: [] })
    const x = store.richieste.find((r) => r.id === req.params.id)
    if (!x) {
      res.status(404).json({ error: 'richiesta sconosciuta' })
      return
    }
    if (x.stato !== 'aperta' && x.stato !== 'abbozzata') {
      res.status(409).json({ error: 'richiesta già decisa' })
      return
    }
    const { approva, perche, perSessione } = parsed.data
    Object.assign(x, {
      stato: approva ? 'approvata' : 'negata',
      decisa: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      decisa_da: chi,
      motivo_decisione: perche || null,
    })
    await atomicWriteFile(fileRichieste, JSON.stringify(store, null, 1))

    if (approva) {
      const conc = await leggi<{ concessioni: unknown[] }>(fileConcessioni, { concessioni: [] })
      conc.concessioni.push({
        id: `c${conc.concessioni.length + 1}`,
        regola: x.regola,
        ambito: perSessione ? 'sessione' : 'una-volta',
        sessione: x.sessione,
        impronta: (x as unknown as { impronta?: string }).impronta,
        richiesta: x.id,
        da: chi,
        quando: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        consumata: null,
      })
      await atomicWriteFile(fileConcessioni, JSON.stringify(conc, null, 1))
    }

    await audit({
      type: 'permessi.richiesta.decisa',
      email: chi,
      ip: getClientIp(req),
      userAgentHash: hashUserAgent(req),
      meta: { richiesta: x.id, regola: x.regola, sessione: x.sessione, esito: approva ? 'approvata' : 'negata' },
    }).catch((err) => logger.error('[permessi] audit fallito:', err))

    res.json({ ok: true, sessione: x.sessione })
  })

  return router
}
