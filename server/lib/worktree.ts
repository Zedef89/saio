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

/**
 * Come eseguire `git`. Il default gira come l'utente del processo (root); chi ha un utente
 * Unix suo passa un runner che lo esegue come lei, o i file creati sarebbero di root dentro
 * la sua area e non potrebbe piu' toccarli.
 */
export type GitRunner = (dir: string, args: string[]) => Promise<string>

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
 * L'identità di un proprietario a partire dal suo slug (`alberto` → Alberto Giunta).
 * Serve a rimettere a posto i worktree già esistenti, che nel nome portano lo slug di chi li
 * ha creati ma non hanno mai avuto un'identità propria.
 */
export async function identityByEmail(dataDir: string, email: string): Promise<GitIdentity | null> {
  const norm = email.toLowerCase().trim()
  try {
    const all = JSON.parse(await fsp.readFile(identitiesFile(dataDir), 'utf8')) as Record<string, Partial<GitIdentity>>
    for (const [login, v] of Object.entries(all)) {
      // Si cerca sia per indirizzo di login sia per indirizzo dei COMMIT: nel git log c'è il
      // secondo (Alberto firma da Epicode, non dalla gmail con cui entra in SAIO).
      if (login.toLowerCase() === norm || (v.email || '').toLowerCase() === norm) {
        return getIdentity(dataDir, login)
      }
    }
  } catch {
    /* mappa assente */
  }
  return null
}

export async function identityBySlug(dataDir: string, slug: string): Promise<GitIdentity | null> {
  try {
    const all = JSON.parse(await fsp.readFile(identitiesFile(dataDir), 'utf8')) as Record<string, Partial<GitIdentity>>
    for (const [email, v] of Object.entries(all)) {
      if ((v.slug || slugFromEmail(email)) === slug) return getIdentity(dataDir, email)
    }
  } catch {
    /* mappa assente: nessuna deduzione possibile */
  }
  return null
}

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
export async function resolveBaseBranch(
  repoDir: string,
  /**
   * Aggiorna il ref remoto prima di rispondere. Va acceso quando dal risultato si stacca un
   * branch nuovo, spento quando serve solo mostrare il nome della base: il `staging` locale
   * del checkout condiviso e' spesso indietro di giorni (21 commit su komanda-dashboard il
   * 15/09/2026), e un worktree creato da li' nasce vecchio senza che nessuno lo dica.
   */
  opts: { fetch?: boolean; run?: GitRunner } = {},
): Promise<string> {
  const g = opts.run || git
  for (const candidate of BASE_BRANCH_PREFERENCE) {
    const remoto = `origin/${candidate}`
    const esisteRemoto = await g(repoDir, ['rev-parse', '--verify', '--quiet', remoto]).then(
      () => true,
      () => false,
    )
    if (esisteRemoto) {
      if (opts.fetch) {
        try {
          await g(repoDir, ['fetch', '--quiet', 'origin', candidate])
        } catch (err) {
          // Rete assente o remoto irraggiungibile: si parte dall'ultimo stato noto invece di
          // non partire. Vale la pena saperlo dal log se poi il branch sembra vecchio.
          logger.warn(`[worktree] fetch di ${candidate} fallito: ${String(err).slice(0, 120)}`)
        }
      }
      return remoto
    }
    const esisteLocale = await g(repoDir, ['rev-parse', '--verify', '--quiet', candidate]).then(
      () => true,
      () => false,
    )
    if (esisteLocale) return candidate
  }
  return g(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
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
  /** Da dove e' stato staccato il branch (`origin/staging`, di norma). */
  base?: string
  /**
   * Quanti commit della base NON sono nel branch. Zero appena creato; alto quando si riapre
   * un worktree vecchio, ed e' l'informazione che nessuno aveva: su komanda-dashboard i
   * worktree fermi da settimane erano indietro di centinaia di commit, e chi ci rientrava
   * lavorava su un codice che su staging non esiste piu' — se ne accorgeva al merge.
   */
  behind?: number
}

/**
 * Crea (o riusa) un worktree isolato per l'utente, su un branch nuovo staccato dalla base.
 * Idempotente: se la cartella esiste già ed è un worktree valido, la riusa senza toccare
 * il branch — altrimenti riaprire una sessione butterebbe via il lavoro in corso.
 */
export async function ensureWorktree(
  repoDir: string,
  identity: GitIdentity,
  opts: {
    label?: string
    baseBranch?: string
    /**
     * Dove mettere i worktree. Default: `~/dev/.worktrees` del processo (root).
     * Chi ha un utente Unix suo li vuole nella PROPRIA area (`/srv/taskless/<lei>/dev/.worktrees`):
     * la radice di root e' `700`, e una sessione che root non e' non riuscirebbe nemmeno a
     * entrarci. E' il motivo per cui finora restavano nel loro checkout condiviso.
     */
    root?: string
    /** Come eseguire git: serve a farlo girare come la persona, non come root. */
    run?: GitRunner
    /** A chi appartengono le cartelle che creiamo noi, quando non e' l'utente del processo. */
    owner?: { uid: number; gid: number }
  } = {}
): Promise<EnsureWorktreeResult | { error: string }> {
  const g = opts.run || git
  if (!(await isGitRepo(repoDir))) {
    return { error: `${repoDir} non è un repository git` }
  }
  const project = path.basename(repoDir)
  const label = opts.label || 'work'
  const dirName = worktreeDirName(identity.slug, label)
  const wtPath = path.join(opts.root || WORKTREES_ROOT, project, dirName)
  const branch = `${sanitizeBranchPart(identity.slug)}/${sanitizeBranchPart(label)}`
  const warnings: string[] = []

  // Già presente e sano → riuso.
  if (fs.existsSync(wtPath) && (await isGitRepo(wtPath))) {
    await applyIdentity(wtPath, identity, warnings, g)
    const cur = await g(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    // Non lo si riallinea da soli: dentro può esserci lavoro a metà, e un rebase deciso da
    // SAIO sarebbe la sorpresa peggiore. Si dice quanto è indietro e si lascia scegliere.
    const riferimento =
      opts.baseBranch || (await resolveBaseBranch(repoDir, { fetch: true, run: opts.run }))
    const behind = Number(
      await g(wtPath, ['rev-list', '--count', `HEAD..${riferimento}`]).catch(() => '0'),
    )
    if (behind > 0) {
      logger.info(`[worktree] ${project}: ${dirName} riusato, ${behind} commit dietro ${riferimento}`)
    }
    return { path: wtPath, branch: cur, created: false, warnings, base: riferimento, behind }
  }

  const base = opts.baseBranch || (await resolveBaseBranch(repoDir, { fetch: true, run: opts.run }))
  // Le cartelle intermedie le crea il processo (root): se il worktree sara' di un'altra
  // persona vanno intestate a lei, o `git worktree add` eseguito come lei non potrebbe
  // scriverci dentro.
  for (const dir of [path.dirname(path.dirname(wtPath)), path.dirname(wtPath)]) {
    await fsp.mkdir(dir, { recursive: true })
    if (opts.owner) await fsp.chown(dir, opts.owner.uid, opts.owner.gid).catch(() => {})
  }

  try {
    // Un branch con lo stesso nome può essere avanzato da una sessione precedente: in quel
    // caso ci si riattacca invece di fallire.
    let branchExists = false
    try {
      await g(repoDir, ['rev-parse', '--verify', '--quiet', branch])
      branchExists = true
    } catch {
      /* branch nuovo */
    }
    const args = branchExists
      ? ['worktree', 'add', wtPath, branch]
      : // `--no-track`: partendo da `origin/staging` git farebbe di quello l'upstream del
        // branch nuovo, e un `git pull` distratto tirerebbe staging dentro il lavoro in corso.
        ['worktree', 'add', '-b', branch, wtPath, base, '--no-track']
    await g(repoDir, args)
    logger.info(`[worktree] ${project}: creato ${dirName} (branch ${branch}, base ${base})`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: `git worktree add fallito: ${msg.slice(0, 300)}` }
  }

  await applyIdentity(wtPath, identity, warnings, g)
  return { path: wtPath, branch, created: true, warnings, base, behind: 0 }
}

/**
 * Identità git isolata nel worktree. Richiede `extensions.worktreeConfig` sul repo padre:
 * senza, `--worktree` fallisce e la config finirebbe condivisa fra tutti gli utenti.
 *
 * ⚠️ Va chiamata su OGNI cartella da cui si aprirà una sessione, non solo su quelle che
 * creiamo noi. `extensions.worktreeConfig` è un'impostazione del repo: appena la accendiamo
 * per un worktree, anche il **checkout principale** smette di leggere `[user]` da
 * `.git/config` e legge `.git/config.worktree`. Se lì dentro resta l'identità di chi ha
 * lavorato per ultimo, ce la trova chiunque apra una sessione lì — e i suoi commit escono a
 * nome di un altro, in silenzio. Successo davvero: dal 05/09/2026 al 08/09/2026 il checkout
 * condiviso di komanda-dashboard era firmato Alberto, e tre commit sono usciti a suo nome.
 */
export async function applyIdentity(
  wtPath: string,
  identity: GitIdentity,
  warnings: string[],
  /**
   * Come eseguire `git`. Serve a chi ha un utente Unix suo: se i comandi girano da root,
   * `.git/config.worktree` diventa un file di root dentro il repo di quella persona e la sua
   * sessione non riesce piu' a riscriverlo. Di default si esegue come l'utente corrente.
   */
  run: (dir: string, args: string[]) => Promise<unknown> = git,
): Promise<void> {
  try {
    await run(wtPath, ['config', 'extensions.worktreeConfig', 'true'])
    await run(wtPath, ['config', '--worktree', 'user.name', identity.name])
    await run(wtPath, ['config', '--worktree', 'user.email', identity.email])
    if (identity.sshKey) {
      await run(wtPath, [
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

/**
 * Spegne l'identità **condivisa** del repo: quella in `.git/config`, che vale per tutte le
 * cartelle di lavoro e per tutte le persone.
 *
 * È l'origine dell'unico modo che resta, dopo l'isolamento per worktree, di firmare a nome di
 * un altro: git non sa chi è collegato a SAIO, legge l'identità dal repo su disco. Se lì c'è
 * l'ultimo che l'ha impostata, i commit di chiunque escono col suo nome — è così che i commit
 * di Nicola sono usciti come Alberto e viceversa.
 *
 * Toglierla fa fallire il commit di chi non ha un'identità propria ("Please tell me who you
 * are"): è il punto. Meglio un commit che si ferma di uno che parte col nome sbagliato.
 *
 * Perché nessuno si trovi bloccato, prima si copre: ogni worktree senza identità propria ne
 * riceve una, dedotta dal nome della cartella (`alberto--rev5` → Alberto) o, se non basta,
 * dall'autore del suo ultimo commit. Se resta anche un solo worktree non attribuibile, il
 * fallback NON viene tolto: si lascia il repo com'è e si dice perché.
 */
export async function spegniIdentitaCondivisa(
  repoDir: string,
  dataDir: string,
  run?: GitRunner,
): Promise<{ tolto: boolean; coperti: string[]; scoperti: string[] }> {
  const g = run || git
  const coperti: string[] = []
  const scoperti: string[] = []

  // Niente identità condivisa da togliere: non c'è niente da fare.
  const condivisa = await g(repoDir, ['config', '--local', '--get', 'user.email']).catch(() => '')
  if (!condivisa) return { tolto: false, coperti, scoperti }

  const lista = await g(repoDir, ['worktree', 'list', '--porcelain'])
  const paths = lista
    .split('\n')
    .filter((r) => r.startsWith('worktree '))
    .map((r) => r.slice('worktree '.length).trim())

  for (const wt of paths) {
    // Il checkout principale (sempre il primo) è di tutti: non gli si cuce addosso il nome di
    // nessuno. Chi lo apre da SAIO riceve la propria identità all'apertura; chi ci entra da
    // fuori deve dire chi è — che è esattamente ciò che vogliamo ottenere.
    if (wt === paths[0]) continue
    // Già a posto: ha la sua identità isolata.
    const sua = await g(wt, ['config', '--worktree', '--get', 'user.email']).catch(() => '')
    if (sua) continue

    // `<slug>--<label>` è la forma che diamo noi ai worktree; il checkout principale e le
    // cartelle create a mano non ce l'hanno, e per quelle si guarda chi ha fatto l'ultimo commit.
    const slug = path.basename(wt).split('--')[0]
    let identity = await identityBySlug(dataDir, slug)
    if (!identity) {
      const autore = await g(wt, ['log', '-1', '--format=%ae']).catch(() => '')
      if (autore) identity = await identityByEmail(dataDir, autore)
    }
    if (!identity) {
      scoperti.push(wt)
      continue
    }
    const avvisi: string[] = []
    await applyIdentity(wt, identity, avvisi, g)
    for (const m of avvisi) logger.warn(`[worktree] ${path.basename(wt)}: ${m}`)
    coperti.push(`${path.basename(wt)} → ${identity.name}`)
  }

  // Le cartelle senza proprietario deducibile (worktree vecchi, creati a mano, con l'ultimo
  // commit di qualcuno che non è nella mappa) restano senza identità: chi ci committa da fuori
  // SAIO si sente chiedere chi è, e chi le riapre da SAIO la riceve all'apertura. È attrito,
  // non un errore — l'alternativa è che continuino a firmare col nome dell'ultimo passato.
  if (scoperti.length) {
    logger.info(
      `[worktree] ${path.basename(repoDir)}: ${scoperti.length} cartelle senza proprietario deducibile, ` +
        'restano senza identità propria'
    )
  }

  for (const chiave of ['user.name', 'user.email', 'core.sshCommand']) {
    // exit 5 = la chiave non c'era: non è un errore.
    await g(repoDir, ['config', '--local', '--unset-all', chiave]).catch(() => '')
  }
  logger.info(
    `[worktree] ${path.basename(repoDir)}: identità condivisa rimossa (era ${condivisa}), ` +
      `${coperti.length} cartelle messe a nome del loro proprietario`
  )
  return { tolto: true, coperti, scoperti }
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
