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

/** Una voce del banco degli accessi. Il registro contiene PUNTATORI, mai valori. */
interface Accesso {
  apre: string
  ambito?: string
  avviso?: string
  attenzione?: string
  persone?: string[] | 'tutti'
  origine: { tipo: string; file: string; variabile?: string }
}

const PatchAccesso = z.object({
  persone: z.union([z.literal('tutti'), z.array(z.string().max(60)).max(40)]),
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
  const fileAccessi = path.join(dataDir, 'access', 'registro.json')
  const fileIdentita = path.join(dataDir, 'git-identities.json')

  /** L'anagrafica: e' la stessa da cui il cancello e il banco risolvono l'identita'.
   *  Un permesso a uno slug che non e' qui non si applicherebbe mai. */
  async function persone(): Promise<{ slug: string; nome: string }[]> {
    const ident = await leggi<Record<string, { slug?: string; name?: string }>>(fileIdentita, {})
    return Object.values(ident)
      .filter((v) => v.slug)
      .map((v) => ({ slug: v.slug as string, nome: v.name || (v.slug as string) }))
      .sort((a, b) => a.slug.localeCompare(b.slug))
  }

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
    const accessi = await leggi<{ accessi: Record<string, Accesso> }>(fileAccessi, { accessi: {} })
    const elenco = await persone()
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
      // Chi vede quale PROGETTO. Separato da `progetti` (che e' solo l'elenco dei nomi, usato
      // per dire dove vale una regola del cancello): qui serve l'id, perche' e' su quello che
      // si scrive.
      progettiVisibilita: await (async () => {
        try {
          const { projectsStore } = await import('../lib/projects-store')
          return (await projectsStore.load())
            .filter((x) => !x.archived)
            .map((x) => ({ id: x.id, nome: x.name, persone: x.persone || [] }))
            .sort((a, b) => a.nome.localeCompare(b.nome))
        } catch {
          return []
        }
      })(),
      inAttesa: richieste.richieste.filter((x) => x.stato === 'aperta'),
      abbozzate: richieste.richieste.filter((x) => x.stato === 'abbozzata').length,
      accessi: Object.entries(accessi.accessi || {})
        .map(([nome, v]) => ({
          nome,
          apre: v.apre,
          ambito: v.ambito || 'altro',
          avviso: v.avviso || v.attenzione || null,
          // Chi lo vede OLTRE a chi amministra. Gli owner vedono tutto per definizione.
          persone: v.persone === 'tutti' ? 'tutti' : (v.persone || []),
        }))
        .sort((a, b) => a.nome.localeCompare(b.nome)),
      persone: elenco,
    })
  })

  /**
   * Il permesso anche SUL DISCO, non solo nel registro.
   *
   * Da quando una persona ha un utente Unix suo, il file col valore (di root) non le e'
   * leggibile: la spunta qui la marcherebbe autorizzata, e poi `saio-run` le risponderebbe
   * «permesso negato». Sarebbe un interruttore acceso senza niente dietro — lo stesso
   * difetto gia' trovato due volte in questo progetto.
   *
   * Si usa una ACL sul singolo file perche' il gruppo `taskless` e' uno solo e non distingue
   * una persona dall'altra, mentre qui serve esattamente quello. La stessa cosa la fa
   * `saio-accessi concedi` da riga di comando.
   */
  async function aggiornaAcl(voce: Accesso, prima: string[], dopo: string[]): Promise<string[]> {
    const avvisi: string[] = []
    const org = (voce as { origine?: { tipo?: string; file?: string } }).origine
    const ident = await leggi<Record<string, { slug?: string; unixUser?: string }>>(fileIdentita, {})
    const utenteDi = (slug: string) => Object.values(ident).find((v) => v.slug === slug)?.unixUser
    const cambiati = [...new Set([...prima, ...dopo])].filter((s) => prima.includes(s) !== dopo.includes(s))
    if (cambiati.length === 0) return avvisi
    if (org?.tipo !== 'env-file' || !org.file) {
      if (cambiati.some((s) => utenteDi(s))) {
        avvisi.push('il valore non sta in un file di ambiente: va consegnato a mano')
      }
      return avvisi
    }
    if (org.file.startsWith('/root/')) {
      if (cambiati.some((s) => utenteDi(s))) {
        avvisi.push(`il valore sta in ${org.file}, dentro /root: chi ha un utente suo non ci arriva. Va spostato in /srv/taskless/segreti/`)
      }
      return avvisi
    }
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    for (const slug of cambiati) {
      const utente = utenteDi(slug)
      if (!utente) continue // chi non ha un utente separato gira come root: legge comunque
      const args = dopo.includes(slug) ? ['-m', `u:${utente}:r`] : ['-x', `u:${utente}`]
      try {
        await run('setfacl', [...args, org.file])
      } catch (err) {
        avvisi.push(`ACL non applicata per ${slug}: ${(err as Error).message}`)
      }
    }
    return avvisi
  }

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

  // ─────────────────── CHI VEDE QUALE ACCESSO ───────────────────
  //
  // Il registro dice cosa esiste; questa rotta dice a CHI. Non tocca mai i valori: il
  // registro contiene puntatori (quale file, quale variabile), e neanche quelli escono da
  // qui — al pannello bastano il nome e cosa apre.
  router.patch('/accessi/:nome', async (req: Request, res: Response): Promise<void> => {
    const parsed = PatchAccesso.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'payload non valido' })
      return
    }
    const nome = String(req.params.nome)
    const store = await leggi<{ accessi: Record<string, Accesso> }>(fileAccessi, { accessi: {} })
    const voce = store.accessi?.[nome]
    if (!voce) {
      res.status(404).json({ error: 'accesso sconosciuto' })
      return
    }
    // Chi ce l'aveva PRIMA: serve per sapere a chi togliere l'ACL, non solo a chi darla.
    const prima = voce.persone === 'tutti' || !Array.isArray(voce.persone) ? [] : [...voce.persone]
    const { persone: nuove } = parsed.data
    if (Array.isArray(nuove)) {
      // Uno slug fuori anagrafica produrrebbe un permesso che non si applica mai:
      // sembra dato e non da' niente. Si rifiuta invece di scriverlo.
      const noti = new Set((await persone()).map((p) => p.slug))
      const ignoti = nuove.filter((s) => !noti.has(s))
      if (ignoti.length) {
        res.status(400).json({
          error: `persone non in anagrafica: ${ignoti.join(', ')}`,
          noti: [...noti],
        })
        return
      }
      voce.persone = [...new Set(nuove)].sort()
    } else {
      voce.persone = 'tutti'
    }
    const dopo = voce.persone === 'tutti' ? [] : voce.persone
    const avvisi = await aggiornaAcl(voce, prima, dopo)

    await atomicWriteFile(fileAccessi, JSON.stringify(store, null, 2))
    await audit({
      type: 'permessi.accesso.modificato',
      email: req.user?.email,
      ip: getClientIp(req),
      userAgentHash: hashUserAgent(req),
      meta: {
        accesso: nome,
        persone: voce.persone === 'tutti' ? 'tutti' : voce.persone.length,
      },
    }).catch((err) => logger.error('[permessi] audit fallito:', err))

    res.json({ ok: true, persone: voce.persone, avvisi })
  })

  // ─────────────────── CHI VEDE QUALE PROGETTO ───────────────────
  //
  // Lista vuota = lo vedono tutti. E' il comportamento storico, e resta il default sui
  // progetti gia' registrati: restringere e' una decisione, non un effetto collaterale.
  router.patch('/progetti/:id', async (req: Request, res: Response): Promise<void> => {
    const parsed = PatchAccesso.safeParse(req.body)
    if (!parsed.success || !Array.isArray(parsed.data.persone)) {
      res.status(400).json({ error: 'payload non valido: serve persone[]' })
      return
    }
    const id = String(req.params.id)
    const { projectsStore } = await import('../lib/projects-store')
    const progetto = await projectsStore.findById(id)
    if (!progetto) {
      res.status(404).json({ error: 'progetto sconosciuto' })
      return
    }
    // Stessa regola degli accessi: uno slug fuori anagrafica darebbe un permesso che non si
    // applica mai — un interruttore acceso senza niente dietro.
    const noti = new Set((await persone()).map((p) => p.slug))
    const ignoti = parsed.data.persone.filter((s) => !noti.has(s))
    if (ignoti.length) {
      res.status(400).json({ error: `persone non in anagrafica: ${ignoti.join(', ')}`, noti: [...noti] })
      return
    }
    const nuove = [...new Set(parsed.data.persone)].sort()
    await projectsStore.update(id, { persone: nuove })
    await audit({
      type: 'permessi.progetto.modificato',
      email: req.user?.email,
      ip: getClientIp(req),
      userAgentHash: hashUserAgent(req),
      meta: { progetto: id, persone: nuove.length ? nuove : 'tutti' },
    }).catch((err) => logger.error('[permessi] audit fallito:', err))
    res.json({ ok: true, persone: nuove })
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
