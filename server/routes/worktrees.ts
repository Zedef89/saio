/**
 * API worktree isolati.
 *
 * Alimenta il selettore mostrato all'apertura di una sessione: quali worktree esistono già
 * (per riprendere il lavoro di ieri), quali file stanno toccando gli altri, e la creazione
 * di uno nuovo. La logica vera sta in lib/worktree.ts.
 */
import { Router, type Request, type Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { z } from 'zod'
import { logger } from '../lib/logger'
import {
  ensureWorktree,
  getIdentity,
  listWorktrees,
  overlappingFiles,
  removeWorktree,
  resolveBaseBranch,
  isGitRepo,
} from '../lib/worktree'

const CreateBody = z.object({
  project: z.string().min(1).max(80),
  label: z.string().min(1).max(40).optional(),
  baseBranch: z.string().min(1).max(80).optional(),
})

/** Risolve il nome progetto nella sua directory sotto ~/dev, rifiutando path traversal. */
function projectDir(name: string): string | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return null
  const dir = path.join(os.homedir(), 'dev', name)
  return fs.existsSync(dir) ? dir : null
}

function requesterEmail(req: Request): string {
  return req.user?.email || (req.headers['cf-access-authenticated-user-email'] as string) || 'unknown'
}

export function worktreesRouter(dataDir: string): Router {
  const router = Router()

  // Worktree esistenti di un progetto + branch base + chi tocca cosa.
  router.get('/:project', async (req: Request, res: Response): Promise<void> => {
    const dir = projectDir(String(req.params.project || ''))
    if (!dir) {
      res.status(404).json({ error: 'project_not_found' })
      return
    }
    if (!(await isGitRepo(dir))) {
      res.json({ gitRepo: false, worktrees: [], baseBranch: null })
      return
    }
    const identity = await getIdentity(dataDir, requesterEmail(req))
    const worktrees = await listWorktrees(dir)
    res.json({
      gitRepo: true,
      baseBranch: await resolveBaseBranch(dir),
      identity: { slug: identity.slug, name: identity.name, hasKey: Boolean(identity.sshKey) },
      worktrees: worktrees.map((w) => ({ ...w, mine: w.owner === identity.slug })),
    })
  })

  // File in lavorazione negli altri worktree: avviso di collisione prima di iniziare.
  router.get('/:project/overlaps', async (req: Request, res: Response): Promise<void> => {
    const dir = projectDir(String(req.params.project || ''))
    if (!dir) {
      res.status(404).json({ error: 'project_not_found' })
      return
    }
    const mine = typeof req.query.path === 'string' ? req.query.path : ''
    res.json({ overlaps: await overlappingFiles(dir, mine) })
  })

  // Crea (o riusa) il worktree dell'utente corrente.
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body' })
      return
    }
    const dir = projectDir(parsed.data.project)
    if (!dir) {
      res.status(404).json({ error: 'project_not_found' })
      return
    }
    const email = requesterEmail(req)
    const identity = await getIdentity(dataDir, email)
    const result = await ensureWorktree(dir, identity, {
      label: parsed.data.label,
      baseBranch: parsed.data.baseBranch,
    })
    if ('error' in result) {
      logger.warn(`[worktrees] create fallita per ${email} su ${parsed.data.project}: ${result.error}`)
      res.status(500).json(result)
      return
    }
    logger.info(
      `[worktrees] ${identity.slug} → ${parsed.data.project} ${result.branch} (${result.created ? 'nuovo' : 'riuso'})`
    )
    res.json({ ...result, identity: { slug: identity.slug, name: identity.name } })
  })

  router.delete('/:project', async (req: Request, res: Response): Promise<void> => {
    const dir = projectDir(String(req.params.project || ''))
    if (!dir) {
      res.status(404).json({ error: 'project_not_found' })
      return
    }
    const wtPath = typeof req.query.path === 'string' ? req.query.path : ''
    if (!wtPath) {
      res.status(400).json({ error: 'missing_path' })
      return
    }
    const result = await removeWorktree(dir, wtPath, req.query.force === 'true')
    if ('error' in result) {
      res.status(409).json(result)
      return
    }
    res.json(result)
  })

  return router
}
