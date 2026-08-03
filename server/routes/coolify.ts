import { Router } from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../lib/logger'
import { atomicWriteFile } from '../lib/atomic-write'

export interface CoolifyInstance {
  id: string
  label: string
  url: string
  /** id del VPS in ssh-inventory su cui gira (per collegare le due viste) */
  vpsId?: string
  owner?: string
  token?: string
  notes?: string
}

/** Istanze note (dal vault). Il token si aggiunge dall'interfaccia. */
const SEED: CoolifyInstance[] = [
  {
    id: 'nicolamele',
    label: 'Coolify personale',
    url: 'https://coolify.nicolamele.com',
    vpsId: 'hetzner',
    owner: 'Nicola (personale)',
    notes: 'n8n personale + lab. Disco del server al 90%.',
  },
  {
    id: 'komandaprint',
    label: 'Coolify Taskless',
    url: 'https://coolify.komandaprint.com',
    vpsId: 'taskless',
    owner: 'Taskless',
    notes: 'Evolution API, Task Manager, DocuSeal, Vaultwarden, operator-agent.',
  },
  {
    id: 'socialflai',
    label: 'Coolify Socialflai',
    url: 'https://coolify.socialflai.com',
    owner: 'Mirko / Webenjoy',
    notes: 'Deploy cinematic-renderer (ai-post-craftsman).',
  },
]

function storeFile(): string {
  const dataDir = process.env.DASHBOARD_DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(dataDir, 'coolify.json')
}

async function load(): Promise<CoolifyInstance[]> {
  try {
    const raw = await fs.readFile(storeFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed?.instances)) return parsed.instances
  } catch { /* primo avvio */ }
  return SEED
}

async function save(instances: CoolifyInstance[]): Promise<void> {
  await atomicWriteFile(storeFile(), JSON.stringify({ instances }, null, 2))
}

/** Il token non esce mai in chiaro dalle liste. */
function mask(t?: string): string | null {
  if (!t) return null
  if (t.length <= 10) return '••••'
  return `${t.slice(0, 4)}••••${t.slice(-4)}`
}

function shape(i: CoolifyInstance) {
  return { ...i, token: undefined, tokenMasked: mask(i.token), hasToken: !!i.token }
}

export function coolifyRouter(): Router {
  const router = Router()

  router.get('/', async (_req, res) => {
    const all = await load()
    res.json({ instances: all.map(shape) })
  })

  // Aggiunge o aggiorna un'istanza (incluso il token)
  router.put('/:id', async (req, res) => {
    const id = String(req.params.id)
    if (!/^[a-z0-9-]{2,32}$/.test(id)) {
      res.status(400).json({ error: 'invalid_id' })
      return
    }
    const all = await load()
    const idx = all.findIndex((i) => i.id === id)
    const body = req.body || {}
    const patch: Partial<CoolifyInstance> = {}
    for (const k of ['label', 'url', 'vpsId', 'owner', 'notes', 'token'] as const) {
      if (typeof body[k] === 'string') patch[k] = body[k]
    }
    if (idx >= 0) all[idx] = { ...all[idx], ...patch, id }
    else all.push({ id, label: patch.label || id, url: patch.url || '', ...patch })
    await save(all)
    logger.info(`[coolify] istanza ${id} salvata${patch.token ? ' (token aggiornato)' : ''}`)
    res.json({ ok: true, instance: shape(all[idx >= 0 ? idx : all.length - 1]) })
  })

  router.delete('/:id', async (req, res) => {
    const all = await load()
    const next = all.filter((i) => i.id !== req.params.id)
    await save(next)
    res.json({ ok: true })
  })

  // Rivela il token (azione esplicita dell'utente)
  router.get('/:id/token', async (req, res) => {
    const all = await load()
    const inst = all.find((i) => i.id === req.params.id)
    if (!inst?.token) {
      res.status(404).json({ error: 'no_token' })
      return
    }
    res.json({ token: inst.token })
  })

  // Stato live: versione API + risorse gestite
  router.get('/:id/status', async (req, res) => {
    const all = await load()
    const inst = all.find((i) => i.id === req.params.id)
    if (!inst) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    if (!inst.token) {
      res.json({ reachable: null, needsToken: true })
      return
    }
    try {
      const headers = { Authorization: `Bearer ${inst.token}` }
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      const [verRes, appRes, svcRes] = await Promise.all([
        fetch(`${inst.url}/api/v1/version`, { headers, signal: ctrl.signal }).catch(() => null),
        fetch(`${inst.url}/api/v1/applications`, { headers, signal: ctrl.signal }).catch(() => null),
        fetch(`${inst.url}/api/v1/services`, { headers, signal: ctrl.signal }).catch(() => null),
      ])
      clearTimeout(timer)
      const version = verRes?.ok ? await verRes.text().catch(() => '') : ''
      const apps = appRes?.ok ? await appRes.json().catch(() => []) : []
      const svcs = svcRes?.ok ? await svcRes.json().catch(() => []) : []
      res.json({
        reachable: !!verRes?.ok,
        unauthorized: verRes?.status === 401,
        version: (version || '').replace(/"/g, '').trim(),
        applications: Array.isArray(apps) ? apps.length : 0,
        services: Array.isArray(svcs) ? svcs.length : 0,
        items: [
          ...(Array.isArray(apps) ? apps : []).slice(0, 40).map((a: any) => ({
            kind: 'app', name: a.name || a.uuid, status: a.status || '', fqdn: a.fqdn || '',
          })),
          ...(Array.isArray(svcs) ? svcs : []).slice(0, 40).map((s: any) => ({
            kind: 'service', name: s.name || s.uuid, status: s.status || '', fqdn: s.fqdn || '',
          })),
        ],
      })
    } catch (err) {
      res.json({ reachable: false, error: String(err) })
    }
  })

  return router
}
