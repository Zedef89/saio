/**
 * Worktree isolati per utente.
 *
 * Su un'istanza condivisa (SAIO Komanda) più persone lavorano sugli stessi repo: se tutte
 * usano la stessa working copy si calpestano i checkout a vicenda. Ogni sessione lavora
 * quindi in un `git worktree` dedicato, su un branch nuovo staccato dal branch base — mai
 * direttamente su staging/main.
 *
 * L'identità git è per-worktree, non per-repo: senza `extensions.worktreeConfig` i worktree
 * condividono `.git/config`, quindi impostare user.email in uno lo cambierebbe per tutti.
 * Con l'estensione attiva, `git config --worktree` scrive in
 * `.git/worktrees/<nome>/config.worktree` ed è isolato davvero. È ciò che impedisce ad
 * Alberto di pushare con le credenziali di Nicola.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from './logger'

const exec = promisify(execFile)

/** Radice dei worktree: fuori dai repo, così non finiscono mai in un `git status`. */
export const WORKTREES_ROOT = path.join(os.homedir(), 'dev', '.worktrees')

/** Branch da cui staccare, in ordine di preferenza. */
const BASE_BRANCH_PREFERENCE = ['staging', 'main', 'master']

export interface GitIdentity {
  /** Nome breve usato in sessioni tmux, branch e path. Solo [a-z0-9-]. */
  slug: string
  name: string
  email: string
  /** Chiave SSH per il push. Default: ~/.ssh/id_ed25519_gh_<slug> se esiste. */
  sshKey?: string
}

export interface WorktreeInfo {
  /** Nome leggibile, coincide con la cartella. */
  name: string
  path: string
  branch: string
  /** Slug del proprietario, dedotto dal nome. */
  owner: string
  /** File modificati non committati. */
  dirty: number
  lastUsed?: string
}

// ─────────────────── Identità ───────────────────

/**
 * Slug da email: `mele.nicola943@gmail.com` → `mele-nicola943`. Fragile per costruzione
 * (nessuno chiama la propria casella come sé stesso), quindi `git-identities.json` permette
 * di sovrascriverlo con un nome sensato.
 */
export function slugFromEmail(email: string): string {
  const local = email.toLowerCase().split('@')[0] || 'user'
  return local.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'user'
}

function identitiesFile(dataDir: string): string {
  return path.join(dataDir, 'git-identities.json')
}

/**
 * Identità git dell'utente. Il file di mapping è opzionale: senza, si degrada a slug
 * derivato dall'email, che funziona ma produce nomi brutti.
 */
export async function getIdentity(dataDir: string, email: string): Promise<GitIdentity> {
  const norm = email.toLowerCase().trim()
  let mapped: Partial<GitIdentity> = {}
  try {
    const raw = await fsp.readFile(identitiesFile(dataDir), 'utf8')
    const all = JSON.parse(raw) as Record<string, Partial<GitIdentity>>
    mapped = all[norm] || {}
  } catch {
    /* file assente → solo fallback */
  }
  const slug = mapped.slug || slugFromEmail(norm)
  const defaultKey = path.join(os.homedir(), '.ssh', `id_ed25519_gh_${slug}`)
  return {
    slug,
    name: mapped.name || norm.split('@')[0] || slug,
    email: mapped.email || norm,
    sshKey: mapped.sshKey || (fs.existsSync(defaultKey) ? defaultKey : undefined),
  }
}

// ─────────────────── Git helpers ───────────────────

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repoDir, ...args], { maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
}

/**
 * Come `git()` ma senza trim: `status --porcelain` codifica lo stato nei primi due caratteri
 * e per i file solo-working-tree il primo è uno spazio (` M README.md`). Trimmare l'output
 * disallineerebbe le colonne e taglierebbe la prima lettera del nome file.
 */
async function gitRaw(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', repoDir, ...args], { maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

/** Estrae i path da `git status --porcelain`, scartando i due caratteri di stato. */
function parseStatusPaths(out: string): string[] {
  return out
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => {
      const p = l.slice(3).trim()
      // Rename/copy: `R  vecchio -> nuovo`, ci interessa la destinazione.
      const arrow = p.indexOf(' -> ')
      return arrow >= 0 ? p.slice(arrow + 4) : p
    })
    .filter(Boolean)
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ['rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

/** Branch base da cui staccare: staging se c'è, poi main, poi master, poi HEAD corrente. */
export async function resolveBaseBranch(repoDir: string): Promise<string> {
  for (const candidate of BASE_BRANCH_PREFERENCE) {
    try {
      await git(repoDir, ['rev-parse', '--verify', '--quiet', candidate])
      return candidate
    } catch {
      /* prova il prossimo */
    }
  }
  return git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

/**
 * Worktree esistenti del repo, esclusa la working copy principale (che nessuno deve usare
 * direttamente su un'istanza condivisa).
 */
export async function listWorktrees(repoDir: string): Promise<WorktreeInfo[]> {
  if (!(await isGitRepo(repoDir))) return []
  let out: string
  try {
    out = await git(repoDir, ['worktree', 'list', '--porcelain'])
  } catch {
    return []
  }
  const main = path.resolve(repoDir)
  const entries: WorktreeInfo[] = []
  let cur: Partial<WorktreeInfo> = {}

  const flush = async () => {
    if (!cur.path || path.resolve(cur.path) === main) return
    const name = path.basename(cur.path)
    entries.push({
      name,
      path: cur.path,
      branch: cur.branch || '(detached)',
      owner: name.split('--')[0] || 'sconosciuto',
      dirty: await countDirty(cur.path),
      lastUsed: await lastUsed(cur.path),
    })
  }

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      await flush()
      cur = { path: line.slice(9).trim() }
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace('refs/heads/', '')
    }
  }
  await flush()
  return entries
}

async function countDirty(dir: string): Promise<number> {
  try {
    return parseStatusPaths(await gitRaw(dir, ['status', '--porcelain'])).length
  } catch {
    return 0
  }
}

async function lastUsed(dir: string): Promise<string | undefined> {
  try {
    const st = await fsp.stat(dir)
    return st.mtime.toISOString()
  } catch {
    return undefined
  }
}

/**
 * File toccati dagli altri worktree dello stesso repo. Serve a rispondere alla domanda
 * "qualcun altro sta lavorando sulle mie stesse cose?" prima di iniziare, invece di
 * scoprirlo al merge.
 */
export async function overlappingFiles(
  repoDir: string,
  myWorktreePath: string
): Promise<{ worktree: string; owner: string; files: string[] }[]> {
  const others = (await listWorktrees(repoDir)).filter(
    (w) => path.resolve(w.path) !== path.resolve(myWorktreePath) && w.dirty > 0
  )
  const result: { worktree: string; owner: string; files: string[] }[] = []
  for (const w of others) {
    try {
      const files = parseStatusPaths(await gitRaw(w.path, ['status', '--porcelain']))
      if (files.length) result.push({ worktree: w.name, owner: w.owner, files })
    } catch {
      /* worktree rotto: lo ignoriamo, non deve bloccare l'apertura di una sessione */
    }
  }
  return result
}

// ─────────────────── Creazione ───────────────────

function sanitizeBranchPart(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

/**
 * Nome cartella del worktree: `<slug>--<label>`. Il doppio trattino separa il proprietario
 * dal resto anche quando lo slug contiene trattini singoli.
 */
export function worktreeDirName(slug: string, label: string): string {
  return `${sanitizeBranchPart(slug)}--${sanitizeBranchPart(label)}`
}

export interface EnsureWorktreeResult {
  path: string
  branch: string
  created: boolean
  /** Warning non bloccanti (identità git incompleta, ecc.). */
  warnings: string[]
}

/**
 * Crea (o riusa) un worktree isolato per l'utente, su un branch nuovo staccato dalla base.
 * Idempotente: se la cartella esiste già ed è un worktree valido, la riusa senza toccare
 * il branch — altrimenti riaprire una sessione butterebbe via il lavoro in corso.
 */
export async function ensureWorktree(
  repoDir: string,
  identity: GitIdentity,
  opts: { label?: string; baseBranch?: string } = {}
): Promise<EnsureWorktreeResult | { error: string }> {
  if (!(await isGitRepo(repoDir))) {
    return { error: `${repoDir} non è un repository git` }
  }
  const project = path.basename(repoDir)
  const label = opts.label || 'work'
  const dirName = worktreeDirName(identity.slug, label)
  const wtPath = path.join(WORKTREES_ROOT, project, dirName)
  const branch = `${sanitizeBranchPart(identity.slug)}/${sanitizeBranchPart(label)}`
  const warnings: string[] = []

  // Già presente e sano → riuso.
  if (fs.existsSync(wtPath) && (await isGitRepo(wtPath))) {
    await applyIdentity(wtPath, identity, warnings)
    const cur = await git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return { path: wtPath, branch: cur, created: false, warnings }
  }

  const base = opts.baseBranch || (await resolveBaseBranch(repoDir))
  await fsp.mkdir(path.dirname(wtPath), { recursive: true })

  try {
    // Un branch con lo stesso nome può essere avanzato da una sessione precedente: in quel
    // caso ci si riattacca invece di fallire.
    let branchExists = false
    try {
      await git(repoDir, ['rev-parse', '--verify', '--quiet', branch])
      branchExists = true
    } catch {
      /* branch nuovo */
    }
    const args = branchExists
      ? ['worktree', 'add', wtPath, branch]
      : ['worktree', 'add', '-b', branch, wtPath, base]
    await git(repoDir, args)
    logger.info(`[worktree] ${project}: creato ${dirName} (branch ${branch}, base ${base})`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: `git worktree add fallito: ${msg.slice(0, 300)}` }
  }

  await applyIdentity(wtPath, identity, warnings)
  return { path: wtPath, branch, created: true, warnings }
}

/**
 * Identità git isolata nel worktree. Richiede `extensions.worktreeConfig` sul repo padre:
 * senza, `--worktree` fallisce e la config finirebbe condivisa fra tutti gli utenti.
 */
async function applyIdentity(wtPath: string, identity: GitIdentity, warnings: string[]): Promise<void> {
  try {
    await git(wtPath, ['config', 'extensions.worktreeConfig', 'true'])
    await git(wtPath, ['config', '--worktree', 'user.name', identity.name])
    await git(wtPath, ['config', '--worktree', 'user.email', identity.email])
    if (identity.sshKey) {
      await git(wtPath, [
        'config',
        '--worktree',
        'core.sshCommand',
        `ssh -i ${identity.sshKey} -o IdentitiesOnly=yes`,
      ])
    } else {
      warnings.push(
        `Nessuna chiave SSH per ${identity.slug}: il push userebbe la chiave di default della macchina, ` +
          `attribuendo i commit a un altro account. Aggiungi ~/.ssh/id_ed25519_gh_${identity.slug}.`
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warnings.push(`Identità git non applicata: ${msg.slice(0, 200)}`)
    logger.warn(`[worktree] identità non applicata su ${wtPath}: ${msg}`)
  }
}

/** Rimuove un worktree. Rifiuta se ha modifiche non committate, salvo `force`. */
export async function removeWorktree(
  repoDir: string,
  wtPath: string,
  force = false
): Promise<{ ok: true } | { error: string }> {
  const dirty = await countDirty(wtPath)
  if (dirty > 0 && !force) {
    return { error: `${dirty} file non committati: usa force per rimuovere comunque` }
  }
  try {
    await git(repoDir, ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath])
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: msg.slice(0, 300) }
  }
}
