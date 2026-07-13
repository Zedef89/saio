/**
 * V15.0 WS13 — Filesystem scan + import progetti.
 *
 * GET  /api/scan/default-roots          → lista path raccomandati per scan
 * POST /api/scan/start  {rootPaths[]}   → esegue scan + ritorna {found, scannedDirs}
 * POST /api/scan/import  {paths[]}      → importa progetti selezionati in data/projects.json
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { atomicWriteFile } from '../lib/atomic-write'
import { defaultRootPaths, scanFilesystem } from '../lib/scan/filesystem-scanner'
import type { Detected } from '../lib/scan/detectors'
import { Octokit } from '@octokit/rest'

const ScanStartBody = z.object({
  rootPaths: z.array(z.string().min(1).max(2048)).min(1).max(20),
  mode: z.enum(['quick', 'deep', 'targeted']).optional().default('quick'),
  targetNames: z.array(z.string().min(1).max(200)).max(50).optional(),
})

const ImportItem = z.object({
  path: z.string().min(1).max(2048),
  kind: z.string().min(1),
  name: z.string().min(1).max(200),
})
// Body permissivo: validiamo per-item nell'handler così un singolo item invalido
// (es. name non-stringa, path URL github, path fuori home) non fa fallire l'intero import.
const ImportBody = z.object({
  items: z.array(z.unknown()).min(1).max(200),
})

export function scanRouter(dataDir: string): Router {
  const router = Router()

  router.get('/default-roots', async (_req, res) => {
    const roots = await defaultRootPaths()
    res.json({ roots, home: os.homedir() })
  })

  router.post('/start', async (req: Request, res: Response): Promise<void> => {
    const parsed = ScanStartBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body' })
      return
    }
    try {
      const result = await scanFilesystem({
        rootPaths: parsed.data.rootPaths,
        mode: parsed.data.mode,
        targetNames: parsed.data.targetNames,
      })
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: 'scan_failed', message: (err as Error).message })
    }
  })

  // V15.0 WS15 — GitHub repo scan (token in env GITHUB_TOKEN)
  router.get('/github', async (_req: Request, res: Response): Promise<void> => {
    const token = (process.env.GITHUB_TOKEN || '').trim()
    if (!token) {
      res.status(409).json({ error: 'no_token', message: 'GITHUB_TOKEN not configured' })
      return
    }
    try {
      const octokit = new Octokit({ auth: token })
      // listo repo dell'utente (own + collaborator) max 100 (limita anche con sort)
      const { data } = await octokit.repos.listForAuthenticatedUser({
        per_page: 100,
        sort: 'updated',
        affiliation: 'owner,collaborator',
      })
      const repos = data.map((r) => ({
        kind: 'github-repo' as const,
        path: r.html_url,
        name: r.full_name,
        meta: {
          private: r.private,
          fork: r.fork,
          description: r.description,
          language: r.language,
          updatedAt: r.updated_at,
          stars: r.stargazers_count,
          cloneUrl: r.clone_url,
          sshUrl: r.ssh_url,
        },
      }))
      const { data: user } = await octokit.users.getAuthenticated()
      res.json({ repos, user: { login: user.login, name: user.name, avatarUrl: user.avatar_url } })
    } catch (err) {
      const errAny = err as { status?: number; message?: string }
      if (errAny.status === 401) {
        res.status(401).json({ error: 'invalid_token', message: 'GITHUB_TOKEN non valido o scaduto' })
        return
      }
      res.status(500).json({ error: 'github_failed', message: errAny.message || 'unknown' })
    }
  })

  // V15.0 WS15 — Save GITHUB_TOKEN in .env.local (post-validate)
  router.post('/github/set-token', async (req: Request, res: Response): Promise<void> => {
    const Schema = z.object({ token: z.string().min(20).max(512) })
    const parsed = Schema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body' })
      return
    }
    // Pre-verify token before saving (no point in saving an invalid one)
    try {
      const octokit = new Octokit({ auth: parsed.data.token })
      const { data: user } = await octokit.users.getAuthenticated()
      const { updateEnvLocal, setProcessEnv } = await import('../lib/auth/env-writer')
      await updateEnvLocal({ GITHUB_TOKEN: parsed.data.token })
      setProcessEnv({ GITHUB_TOKEN: parsed.data.token })
      res.json({ ok: true, user: { login: user.login, name: user.name } })
    } catch (err) {
      const errAny = err as { status?: number; message?: string }
      if (errAny.status === 401) {
        res.status(401).json({ error: 'invalid_token', message: 'Token non valido. Verifica che abbia scope "repo" e "read:user".' })
        return
      }
      res.status(500).json({ error: 'github_failed', message: errAny.message || 'unknown' })
    }
  })

  router.post('/import', async (req: Request, res: Response): Promise<void> => {
    const parsed = ImportBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body' })
      return
    }
    // Validazione per-item robusta: raccogliamo i validi e teniamo traccia degli skippati
    // (un item invalido non deve far fallire l'intero import).
    const home = os.homedir()
    const validItems: Array<z.infer<typeof ImportItem>> = []
    const skippedItems: Array<{ path?: string; reason: string }> = []
    for (const raw of parsed.data.items) {
      const r = ImportItem.safeParse(raw)
      if (!r.success) {
        const p = (raw as { path?: unknown })?.path
        skippedItems.push({ path: typeof p === 'string' ? p : undefined, reason: 'invalid_fields' })
        continue
      }
      const item = r.data
      // Path non-filesystem (es. URL github-repo) → non importabile come progetto locale
      if (/^[a-z]+:\/\//i.test(item.path)) {
        skippedItems.push({ path: item.path, reason: 'not_a_filesystem_path' })
        continue
      }
      const abs = path.resolve(item.path)
      if (abs !== home && !abs.startsWith(home + path.sep)) {
        skippedItems.push({ path: item.path, reason: 'path_outside_home' })
        continue
      }
      validItems.push(item)
    }
    // Append a data/projects.json esistente (non sovrascrive — merge by path)
    const projectsFile = path.join(dataDir, 'projects.json')
    let existing: { version?: number; projects?: Array<{ id: string; path: string; name: string; kind: string; importedAt?: string }> } = {
      version: 1,
      projects: [],
    }
    try {
      const txt = await fs.readFile(projectsFile, 'utf-8')
      const parsedExisting = JSON.parse(txt)
      if (parsedExisting && typeof parsedExisting === 'object') {
        existing = { version: 1, projects: [], ...parsedExisting }
      }
    } catch {
      /* file new */
    }
    const existingPaths = new Set((existing.projects || []).map((p) => p.path))
    let added = 0
    const importedAt = new Date().toISOString()
    for (const item of validItems) {
      if (existingPaths.has(item.path)) continue
      // id univoco e deterministico per path (hash completo, non solo i primi 16 char
      // del base64 che collidono per path con prefisso comune come /Users/<u>/dev/*).
      const id = `proj-${crypto.createHash('sha1').update(item.path).digest('hex').slice(0, 12)}`
      ;(existing.projects = existing.projects || []).push({
        id,
        path: item.path,
        name: item.name,
        kind: item.kind,
        importedAt,
      })
      added++
    }
    await fs.mkdir(path.dirname(projectsFile), { recursive: true })
    await atomicWriteFile(projectsFile, JSON.stringify(existing, null, 2))
    res.json({ ok: true, added, total: (existing.projects || []).length, skipped: skippedItems })
  })

  return router
}

void (async (): Promise<void> => {
  // Defensive: ensure detectors module imports cleanly at boot
  void Promise.resolve()
})()

// Re-export per import-by-name in caller
export type { Detected }
