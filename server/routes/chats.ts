import { Router } from 'express'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { logger } from '../lib/logger'

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

interface ChatMeta {
  id: string           // nome file senza .jsonl (sessionId)
  slug: string         // cartella in ~/.claude/projects
  project: string      // nome leggibile del progetto
  worktree: string | null
  mtime: number
  size: number
  preview?: string
}

/**
 * Dallo slug (`/` sostituiti da `-`) ricava un nome progetto leggibile.
 * Es. `-Users-doc-dev-komanda-dashboard` → { project: 'komanda-dashboard' }
 *     `-Users-doc-dev-ai-post-craftsman-claude-worktrees-agency-fase0`
 *        → { project: 'ai-post-craftsman', worktree: 'agency-fase0' }
 */
export function parseSlug(slug: string): { project: string; worktree: string | null } {
  let s = slug
  // worktree isolati: <progetto>-claude-worktrees-<worktree>
  let worktree: string | null = null
  const wtIdx = s.indexOf('-claude-worktrees-')
  if (wtIdx > 0) {
    worktree = s.slice(wtIdx + '-claude-worktrees-'.length) || null
    s = s.slice(0, wtIdx)
  }
  // togli i prefissi di path più comuni
  for (const prefix of ['-Users-doc-dev-', '-Users-doc-Desktop-', '-Users-doc-']) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length)
      break
    }
  }
  // slug '-' (o vuoto) = sessioni avviate senza cwd valido: non appartengono a un progetto
  const clean = s.replace(/^-+|-+$/g, '')
  if (!clean) return { project: '(senza progetto)', worktree }
  return { project: clean, worktree }
}

/** Legge solo l'inizio del file per estrarre il primo messaggio dell'utente. */
async function readPreview(file: string, maxBytes = 64 * 1024): Promise<string> {
  let fh: fs.FileHandle | null = null
  try {
    fh = await fs.open(file, 'r')
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
    const chunk = buf.subarray(0, bytesRead).toString('utf8')
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      let d: any
      try { d = JSON.parse(line) } catch { continue }
      const m = d?.message
      if (d?.type === 'user' && m?.role === 'user') {
        const c = m.content
        let text = ''
        if (typeof c === 'string') text = c
        else if (Array.isArray(c)) {
          text = c.filter((x: any) => x?.type === 'text').map((x: any) => x.text || '').join(' ')
        }
        text = text.trim()
        // salta i blocchi di sistema (<command-name>, reminder, ecc.)
        if (text && !text.startsWith('<')) return text.slice(0, 200)
      }
    }
  } catch { /* file illeggibile */ } finally {
    await fh?.close().catch(() => {})
  }
  return ''
}

let cache: { data: ChatMeta[]; ts: number } | null = null
const CACHE_TTL = 60_000

async function indexChats(): Promise<ChatMeta[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data
  const out: ChatMeta[] = []
  let slugs: string[] = []
  try {
    slugs = await fs.readdir(PROJECTS_DIR)
  } catch {
    return []
  }
  for (const slug of slugs) {
    const dir = path.join(PROJECTS_DIR, slug)
    let entries: string[] = []
    try {
      if (!fsSync.statSync(dir).isDirectory()) continue
      entries = await fs.readdir(dir)
    } catch { continue }
    const { project, worktree } = parseSlug(slug)
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue
      try {
        const st = await fs.stat(path.join(dir, e))
        if (!st.isFile() || st.size < 200) continue // scarta file vuoti/troncati
        out.push({
          id: e.replace(/\.jsonl$/, ''),
          slug,
          project,
          worktree,
          mtime: st.mtimeMs,
          size: st.size,
        })
      } catch { /* skip */ }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  cache = { data: out, ts: Date.now() }
  return out
}

export function chatsRouter(): Router {
  const router = Router()

  // Elenco conversazioni (paginato). Le anteprime si leggono solo per la pagina richiesta.
  router.get('/', async (req, res) => {
    try {
      const all = await indexChats()
      const project = String(req.query.project || '').trim()
      const q = String(req.query.q || '').toLowerCase().trim()
      const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 30))
      const offset = Math.max(0, Number(req.query.offset) || 0)

      let filtered = project ? all.filter((c) => c.project === project) : all
      const page = filtered.slice(offset, offset + limit)
      await Promise.all(page.map(async (c) => {
        c.preview = await readPreview(path.join(PROJECTS_DIR, c.slug, `${c.id}.jsonl`))
      }))
      const results = q
        ? page.filter((c) => (c.preview || '').toLowerCase().includes(q) || c.project.toLowerCase().includes(q))
        : page

      // progetti con conteggio, per il filtro laterale
      const byProject = new Map<string, number>()
      for (const c of all) byProject.set(c.project, (byProject.get(c.project) || 0) + 1)

      res.json({
        total: filtered.length,
        totalAll: all.length,
        offset,
        limit,
        chats: results,
        projects: [...byProject.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
      })
    } catch (err) {
      logger.error('[chats] index failed:', err)
      res.status(500).json({ error: 'index_failed', message: String(err) })
    }
  })

  // Contenuto di una conversazione: messaggi user/assistant in ordine.
  router.get('/:slug/:id', async (req, res) => {
    const slug = String(req.params.slug)
    const id = String(req.params.id)
    if (slug.includes('..') || slug.includes('/') || !/^[a-zA-Z0-9._-]+$/.test(id)) {
      res.status(400).json({ error: 'invalid_params' })
      return
    }
    const file = path.join(PROJECTS_DIR, slug, `${id}.jsonl`)
    try {
      const raw = await fs.readFile(file, 'utf8')
      const messages: { role: string; text: string; ts: string | null }[] = []
      let cwd: string | null = null
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        let d: any
        try { d = JSON.parse(line) } catch { continue }
        if (!cwd && d?.cwd) cwd = d.cwd
        const m = d?.message
        if (!m || (d.type !== 'user' && d.type !== 'assistant')) continue
        const c = m.content
        let text = ''
        if (typeof c === 'string') text = c
        else if (Array.isArray(c)) {
          text = c
            .map((x: any) => {
              if (x?.type === 'text') return x.text || ''
              if (x?.type === 'tool_use') return `[strumento: ${x.name || '?'}]`
              if (x?.type === 'tool_result') return ''
              return ''
            })
            .filter(Boolean)
            .join('\n')
        }
        text = (text || '').trim()
        if (!text || text.startsWith('<')) continue
        messages.push({ role: m.role || d.type, text, ts: d.timestamp || null })
      }
      const st = await fs.stat(file)
      res.json({ id, slug, cwd, size: st.size, mtime: st.mtimeMs, count: messages.length, messages })
    } catch (err) {
      res.status(404).json({ error: 'not_found', message: String(err) })
    }
  })

  return router
}
