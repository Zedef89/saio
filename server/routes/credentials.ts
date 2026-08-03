import { Router } from 'express'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { logger } from '../lib/logger'
import { atomicWriteFile } from '../lib/atomic-write'

/**
 * Credenziali di Nicola. Due tipi:
 *  - "detected": rilevate dal sistema (settings.json → env), SOLO LETTURA.
 *  - "custom": aggiunte da Nicola dall'interfaccia, EDITABILI, salvate nel data dir
 *    (`<dataDir>/credentials.json`, FUORI da git, come ssh-inventory.json).
 * I valori NON vengono mai inviati mascherati/interi nella lista: solo un hint
 * (ultimi 4 char). Il valore in chiaro si ottiene solo via GET /:id/reveal on-demand.
 */

interface CustomCred {
  id: string
  name: string
  value: string
  scope: string     // a che serve
  project: string   // progetto/servizio di riferimento (libero)
  createdAt: string
  updatedAt: string
}

interface CredView {
  id: string | null
  name: string
  scope: string
  project: string
  source: 'settings.json env' | 'custom'
  editable: boolean
  configured: boolean
  hint: string      // es. "••••ab12" (ultimi 4), mai il valore intero
}

function storePath(dataDir: string): string {
  return path.join(dataDir, 'credentials.json')
}

async function loadCustom(dataDir: string): Promise<CustomCred[]> {
  try {
    const raw = await fs.readFile(storePath(dataDir), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.credentials) ? parsed.credentials : []
  } catch {
    return []
  }
}

async function saveCustom(dataDir: string, creds: CustomCred[]): Promise<void> {
  await atomicWriteFile(storePath(dataDir), JSON.stringify({ credentials: creds }, null, 2))
  try { fsSync.chmodSync(storePath(dataDir), 0o600) } catch { /* best-effort */ }
}

/** Ultimi 4 caratteri mascherati — mai il valore intero. */
function hintOf(value: string): string {
  if (!value) return ''
  const tail = value.slice(-4)
  return `••••${tail}`
}

// Credenziali auto-rilevate da ~/.claude/settings.json (env). Solo lettura: si
// modificano da lì, non da SAIO. Le mostriamo per completezza (a che servono).
const SCOPE_HINTS: Record<string, string> = {
  GITHUB_TOKEN: 'GitHub · repo/workflow/packages',
  GITHUB_TOKEN_RM: 'GitHub secondo account',
  SUPABASE_ACCESS_TOKEN: 'Supabase CLI',
  OPENAI_API_KEY: 'OpenAI API',
  ANTHROPIC_API_KEY: 'Anthropic API',
  N8N_API_KEY: 'n8n workflows API',
  GROQ_API_KEY: 'Groq (trascrizione whisper)',
}

async function loadDetected(): Promise<CredView[]> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  try {
    const raw = await fs.readFile(settingsPath, 'utf8')
    const env = JSON.parse(raw).env || {}
    return Object.keys(env).map((k) => ({
      id: null,
      name: k,
      scope: SCOPE_HINTS[k] || k.toLowerCase().replace(/_/g, ' '),
      project: 'settings.json',
      source: 'settings.json env' as const,
      editable: false,
      configured: !!env[k],
      hint: hintOf(String(env[k] || '')),
    }))
  } catch {
    return []
  }
}

export function credentialsRouter(dataDir: string) {
  const router = Router()

  // Lista completa: rilevate (read-only) + tue custom (editabili). Nessun valore intero.
  router.get('/', async (_req, res) => {
    const detected = await loadDetected()
    const custom = await loadCustom(dataDir)
    const customViews: CredView[] = custom.map((c) => ({
      id: c.id,
      name: c.name,
      scope: c.scope,
      project: c.project,
      source: 'custom',
      editable: true,
      configured: !!c.value,
      hint: hintOf(c.value),
    }))
    const items = [...customViews, ...detected]
    res.json({
      items,
      stats: { total: items.length, custom: customViews.length, detected: detected.length },
      updatedAt: new Date().toISOString(),
    })
  })

  // Aggiungi una credenziale custom
  router.post('/', async (req, res) => {
    const name = String(req.body?.name || '').trim()
    const value = String(req.body?.value ?? '')
    const scope = String(req.body?.scope || '').trim()
    const project = String(req.body?.project || '').trim()
    if (!name || name.length > 100) return res.status(400).json({ error: 'name richiesto (max 100)' })
    if (!value) return res.status(400).json({ error: 'value richiesto' })
    const creds = await loadCustom(dataDir)
    const now = new Date().toISOString()
    const cred: CustomCred = { id: crypto.randomUUID(), name, value, scope, project, createdAt: now, updatedAt: now }
    creds.push(cred)
    await saveCustom(dataDir, creds)
    logger.info(`[credentials] aggiunta "${name}" (${project || 'no-project'})`)
    res.json({ ok: true, id: cred.id })
  })

  // Modifica (name/scope/project sempre; value solo se fornito non vuoto)
  router.put('/:id', async (req, res) => {
    const id = String(req.params.id)
    const creds = await loadCustom(dataDir)
    const c = creds.find((x) => x.id === id)
    if (!c) return res.status(404).json({ error: 'not_found' })
    if (req.body?.name !== undefined) c.name = String(req.body.name).trim().slice(0, 100)
    if (req.body?.scope !== undefined) c.scope = String(req.body.scope).trim()
    if (req.body?.project !== undefined) c.project = String(req.body.project).trim()
    if (req.body?.value !== undefined && String(req.body.value) !== '') c.value = String(req.body.value)
    c.updatedAt = new Date().toISOString()
    await saveCustom(dataDir, creds)
    logger.info(`[credentials] modificata "${c.name}"`)
    res.json({ ok: true })
  })

  router.delete('/:id', async (req, res) => {
    const id = String(req.params.id)
    const creds = await loadCustom(dataDir)
    const next = creds.filter((x) => x.id !== id)
    if (next.length === creds.length) return res.status(404).json({ error: 'not_found' })
    await saveCustom(dataDir, next)
    logger.info(`[credentials] eliminata id=${id}`)
    res.json({ ok: true })
  })

  // Rivela il valore in chiaro (on-demand: per copiare o modificare). Solo custom.
  router.get('/:id/reveal', async (req, res) => {
    const id = String(req.params.id)
    const creds = await loadCustom(dataDir)
    const c = creds.find((x) => x.id === id)
    if (!c) return res.status(404).json({ error: 'not_found' })
    res.json({ value: c.value })
  })

  return router
}
