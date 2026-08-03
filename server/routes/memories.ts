import { Router } from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { logger } from '../lib/logger'
import { parseSlug } from './chats'

// Le memorie di Claude Code vivono in ~/.claude/projects/<slug>/memory/*.md,
// mentre i CLAUDE.md stanno nella cartella VERA del progetto (es. ~/dev/<nome>/CLAUDE.md).
const CLAUDE_DIR = path.join(os.homedir(), '.claude')
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects')
const GLOBAL_SLUG = '__global__'
// I backup NON stanno dentro memory/ (Claude legge quella cartella): vivono fuori.
const BACKUP_DIR = path.join(os.homedir(), '.saio-backups', 'memories')

const SLUG_RE = /^[A-Za-z0-9._-]+$/
const MEMORY_NAME_RE = /^[A-Za-z0-9._ -]+\.md$/
// Gli unici CLAUDE.md ammessi, relativi alla root del progetto
const CLAUDE_RELS = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]

type Kind = 'memory' | 'claude'

/**
 * Fallback quando nei .jsonl non c'è un `cwd` valido: ricostruisce il path dallo slug
 * provando i segmenti dal più lungo al più corto e tenendo solo quelli che esistono
 * davvero su disco (il `-` è ambiguo: separatore di path o trattino nel nome).
 * Uno slug `--` corrisponde a una cartella che inizia per punto (es. `.claude`).
 */
async function guessPathFromSlug(cur: string, rest: string, depth = 0): Promise<string | null> {
  if (!rest) return cur
  if (depth > 12) return null
  // tagli possibili: fine stringa o posizione di un '-' (dal più lungo al più corto)
  const cuts: number[] = [rest.length]
  for (let i = rest.length - 1; i > 0; i--) if (rest[i] === '-') cuts.push(i)
  for (const cut of cuts) {
    const seg = rest.slice(0, cut)
    const nextRest = rest.slice(cut + 1)
    const candidates = seg.startsWith('-') ? ['.' + seg.slice(1)] : [seg]
    for (const cand of candidates) {
      if (!cand) continue
      const next = path.join(cur, cand)
      const st = await fs.stat(next).catch(() => null)
      if (!st?.isDirectory()) continue
      const done = await guessPathFromSlug(next, nextRest, depth + 1)
      if (done) return done
    }
  }
  return null
}

/**
 * Path reale del progetto a partire dallo slug.
 * Lo slug (`/` → `-`) è ambiguo quando il nome contiene trattini, quindi invece di
 * indovinare si legge il `cwd` dal primo record di una sessione .jsonl del progetto.
 */
const cwdCache = new Map<string, string | null>()
async function projectPathFromSlug(slug: string): Promise<string | null> {
  if (cwdCache.has(slug)) return cwdCache.get(slug)!
  let resolved: string | null = null
  try {
    const dir = path.join(PROJECTS_DIR, slug)
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    // la sessione più recente ha più probabilità di avere un cwd ancora valido
    const withTime = await Promise.all(
      files.map(async (f) => ({ f, t: (await fs.stat(path.join(dir, f)).catch(() => null))?.mtimeMs || 0 }))
    )
    withTime.sort((a, b) => b.t - a.t)
    for (const { f } of withTime.slice(0, 5)) {
      const fh = await fs.open(path.join(dir, f), 'r').catch(() => null)
      if (!fh) continue
      try {
        const buf = Buffer.alloc(8192)
        const { bytesRead } = await fh.read(buf, 0, 8192, 0)
        for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
          if (!line.trim()) continue
          let d: any
          try { d = JSON.parse(line) } catch { continue }
          if (typeof d?.cwd === 'string' && d.cwd.startsWith('/')) {
            const st = await fs.stat(d.cwd).catch(() => null)
            if (st?.isDirectory()) { resolved = d.cwd; break }
          }
        }
      } finally {
        await fh.close().catch(() => {})
      }
      if (resolved) break
    }
  } catch { /* nessuna sessione leggibile */ }
  // nessun cwd utilizzabile → ricostruzione dallo slug
  if (!resolved && slug.startsWith('-') && slug.length > 1) {
    resolved = await guessPathFromSlug('/', slug.slice(1))
  }
  cwdCache.set(slug, resolved)
  return resolved
}

/** CLAUDE.md presenti nella cartella del progetto. */
async function findClaudeMds(projectPath: string | null) {
  if (!projectPath) return []
  const out: Array<{ rel: string; size: number; mtime: number }> = []
  for (const rel of CLAUDE_RELS) {
    const st = await fs.stat(path.join(projectPath, rel)).catch(() => null)
    if (st?.isFile()) out.push({ rel, size: st.size, mtime: st.mtimeMs })
  }
  return out
}

/** Valida (kind, slug, name) e restituisce il path assoluto, o null se non ammesso. */
async function resolveFile(kind: Kind, slug: string, name: string): Promise<string | null> {
  if (kind === 'claude') {
    if (slug === GLOBAL_SLUG) {
      return name === 'CLAUDE.md' ? path.join(CLAUDE_DIR, 'CLAUDE.md') : null
    }
    if (!SLUG_RE.test(slug)) return null
    if (!CLAUDE_RELS.includes(name)) return null
    const projectPath = await projectPathFromSlug(slug)
    if (!projectPath) return null
    return path.join(projectPath, name)
  }
  // kind === 'memory'
  if (!SLUG_RE.test(slug) || slug === '.' || slug === '..') return null
  if (!MEMORY_NAME_RE.test(name) || name.includes('..')) return null
  const base = path.resolve(PROJECTS_DIR, slug, 'memory')
  const abs = path.join(base, name)
  return path.resolve(abs).startsWith(base + path.sep) ? abs : null
}

/** Estrae `description` e `metadata.type` dal frontmatter YAML (parsing riga per riga). */
function parseFrontmatter(raw: string): { description: string; type: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { description: '', type: '' }
  let description = ''
  let type = ''
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    const val = kv[2].trim().replace(/^["']|["']$/g, '')
    if (kv[1] === 'description' && !description) description = val
    if (kv[1] === 'type' && !type) type = val
  }
  return { description, type }
}

/** Legge i primi byte di un file (basta per il frontmatter). */
async function readHead(abs: string, bytes = 2048): Promise<string> {
  const fh = await fs.open(abs, 'r').catch(() => null)
  if (!fh) return ''
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close().catch(() => {})
  }
}

export function memoriesRouter(): Router {
  const router = Router()

  // Elenco progetti: memorie + CLAUDE.md. In cima il CLAUDE.md globale (~/.claude/CLAUDE.md).
  router.get('/', async (_req, res) => {
    try {
      const slugs = await fs.readdir(PROJECTS_DIR).catch(() => [] as string[])
      const projects: Array<{
        slug: string
        project: string
        worktree: string | null
        projectPath: string | null
        memories: number
        claudeMds: number
        count: number
        mtime: number
      }> = []

      for (const slug of slugs) {
        const memDir = path.join(PROJECTS_DIR, slug, 'memory')
        const memFiles = (await fs.readdir(memDir).catch(() => [] as string[])).filter((e) => e.endsWith('.md'))
        const projectPath = await projectPathFromSlug(slug)
        const claudeMds = await findClaudeMds(projectPath)
        if (memFiles.length === 0 && claudeMds.length === 0) continue

        let mtime = 0
        for (const f of memFiles) {
          const st = await fs.stat(path.join(memDir, f)).catch(() => null)
          if (st && st.mtimeMs > mtime) mtime = st.mtimeMs
        }
        for (const c of claudeMds) if (c.mtime > mtime) mtime = c.mtime

        const { project, worktree } = parseSlug(slug)
        projects.push({
          slug,
          project,
          worktree,
          projectPath,
          memories: memFiles.length,
          claudeMds: claudeMds.length,
          count: memFiles.length + claudeMds.length,
          mtime,
        })
      }
      projects.sort((a, b) => b.mtime - a.mtime)

      // Slug diversi (worktree, sottocartelle) possono puntare alla stessa cartella:
      // se una voce non ha memorie proprie ed espone solo un CLAUDE.md già coperto
      // da un'altra, è un doppione → si scarta.
      const seenPaths = new Set<string>()
      const deduped = projects.filter((p) => {
        if (!p.projectPath) return true
        if (p.memories > 0) { seenPaths.add(p.projectPath); return true }
        if (seenPaths.has(p.projectPath)) return false
        seenPaths.add(p.projectPath)
        return true
      })
      projects.length = 0
      projects.push(...deduped)

      // voce speciale per il CLAUDE.md globale
      const globalSt = await fs.stat(path.join(CLAUDE_DIR, 'CLAUDE.md')).catch(() => null)
      if (globalSt?.isFile()) {
        projects.unshift({
          slug: GLOBAL_SLUG,
          project: 'CLAUDE.md globale',
          worktree: null,
          projectPath: CLAUDE_DIR,
          memories: 0,
          claudeMds: 1,
          count: 1,
          mtime: globalSt.mtimeMs,
        })
      }

      res.json({ projects, total: projects.reduce((n, p) => n + p.count, 0) })
    } catch (err) {
      logger.error('[memories] index failed:', err)
      res.status(500).json({ error: 'index_failed', message: String(err) })
    }
  })

  // File di un progetto: prima i CLAUDE.md, poi MEMORY.md (l'indice), poi le altre memorie.
  router.get('/files', async (req, res) => {
    const slug = String(req.query.slug || '')
    if (slug !== GLOBAL_SLUG && !SLUG_RE.test(slug)) return res.status(400).json({ error: 'invalid_slug' })
    try {
      const files: Array<{
        kind: Kind
        name: string
        label: string
        size: number
        mtime: number
        description: string
        type: string
      }> = []

      if (slug === GLOBAL_SLUG) {
        const abs = path.join(CLAUDE_DIR, 'CLAUDE.md')
        const st = await fs.stat(abs)
        files.push({
          kind: 'claude',
          name: 'CLAUDE.md',
          label: 'CLAUDE.md (globale)',
          size: st.size,
          mtime: st.mtimeMs,
          description: 'Istruzioni globali per tutti i progetti',
          type: 'claude',
        })
        return res.json({ slug, project: 'CLAUDE.md globale', projectPath: CLAUDE_DIR, files })
      }

      const projectPath = await projectPathFromSlug(slug)
      for (const c of await findClaudeMds(projectPath)) {
        files.push({
          kind: 'claude',
          name: c.rel,
          label: c.rel,
          size: c.size,
          mtime: c.mtime,
          description: 'Istruzioni di progetto',
          type: 'claude',
        })
      }

      const memDir = path.join(PROJECTS_DIR, slug, 'memory')
      const memFiles = (await fs.readdir(memDir).catch(() => [] as string[])).filter((e) => e.endsWith('.md'))
      const mems = await Promise.all(
        memFiles.map(async (name) => {
          const abs = path.join(memDir, name)
          const st = await fs.stat(abs)
          const { description, type } = parseFrontmatter(await readHead(abs))
          return {
            kind: 'memory' as Kind,
            name,
            label: name.replace(/\.md$/, ''),
            size: st.size,
            mtime: st.mtimeMs,
            description,
            type,
          }
        })
      )
      mems.sort((a, b) => {
        if (a.name === 'MEMORY.md') return -1
        if (b.name === 'MEMORY.md') return 1
        return a.name.localeCompare(b.name)
      })
      files.push(...mems)

      const { project, worktree } = parseSlug(slug)
      res.json({ slug, project, worktree, projectPath, dir: memDir, files })
    } catch (err) {
      res.status(404).json({ error: 'not_found', message: String(err) })
    }
  })

  // Contenuto di un file (raw = quello che l'editor modifica e risalva).
  router.get('/file', async (req, res) => {
    const kind = String(req.query.kind || 'memory') as Kind
    if (kind !== 'memory' && kind !== 'claude') return res.status(400).json({ error: 'invalid_kind' })
    const abs = await resolveFile(kind, String(req.query.slug || ''), String(req.query.name || ''))
    if (!abs) return res.status(400).json({ error: 'invalid_path' })
    try {
      const st = await fs.stat(abs)
      if (!st.isFile()) return res.status(400).json({ error: 'not_a_file' })
      const raw = await fs.readFile(abs, 'utf8')
      // il body senza frontmatter è ciò che si mostra nel viewer markdown
      const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
      res.json({
        kind,
        slug: req.query.slug,
        name: req.query.name,
        path: abs,
        size: st.size,
        mtime: st.mtimeMs,
        content: fmMatch ? raw.slice(fmMatch[0].length) : raw,
        raw,
      })
    } catch (err) {
      res.status(404).json({ error: 'not_found', message: String(err) })
    }
  })

  // Salvataggio: backup fuori dalla cartella sorgente + scrittura atomica. Salva il RAW
  // così com'è, quindi il frontmatter non si perde mai (stessa logica del vault).
  router.put('/file', async (req, res) => {
    const kind = String(req.body?.kind || 'memory') as Kind
    const slug = String(req.body?.slug || '')
    const name = String(req.body?.name || '')
    if (kind !== 'memory' && kind !== 'claude') return res.status(400).json({ error: 'invalid_kind' })
    const abs = await resolveFile(kind, slug, name)
    if (!abs) return res.status(400).json({ error: 'invalid_path' })
    const content = req.body?.content
    if (typeof content !== 'string') return res.status(400).json({ error: 'content_must_be_string' })
    try {
      const st = await fs.stat(abs).catch(() => null)
      if (!st || !st.isFile()) return res.status(404).json({ error: 'not_found' })

      const { atomicWriteFile, backupIfExists } = await import('../lib/atomic-write')
      await backupIfExists(abs, path.join(BACKUP_DIR, slug, kind))
      await atomicWriteFile(abs, content)

      const after = await fs.stat(abs)
      logger.info(`[memories] salvato ${kind} ${slug}/${name} (${after.size} byte)`)
      res.json({ ok: true, kind, slug, name, size: after.size, mtime: after.mtimeMs })
    } catch (err) {
      logger.error('[memories] write failed:', err)
      res.status(500).json({ error: 'write_failed', message: String(err) })
    }
  })

  return router
}
