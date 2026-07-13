/**
 * orchestrator-paths.ts — Risoluzione cross-platform delle path dell'orchestrator
 * Python e della venv scrivibile.
 *
 * PROBLEMA (macOS/prod bundle):
 *   Il server gira come sidecar `saio-server.cjs` in
 *   `<AppBundle>/Contents/Resources/binaries/saio-server.cjs`, quindi il vecchio
 *   `path.resolve(__dirname, '..', '..', 'orchestrator')` punta a
 *   `Contents/orchestrator` — che NON esiste. Tauri, col glob `../orchestrator`,
 *   copia i file in `Contents/Resources/_up_/orchestrator`.
 *
 * SOLUZIONE:
 *   `orchestratorDir()` prova in ordine più location e ritorna la prima che
 *   contiene `orchestrator.py`:
 *     1. env override  SAIO_ORCHESTRATOR_DIR
 *     2. <resource_dir>/orchestrator
 *     3. <resource_dir>/_up_/orchestrator   (dove Tauri mette `../orchestrator/**`)
 *     4. <dev> resolve(__dirname, '..', '..', 'orchestrator')  (repo in dev)
 *
 * VENV/DATA:
 *   Il bundle è read-only → la venv NON può stare accanto ai .py. Va creata in
 *   una dir utente scrivibile (`orchestratorVenvDir()`), per-piattaforma.
 *   Il `requirements.txt`, invece, si legge da `orchestratorDir()` (bundle).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Deve combaciare con `identifier` in src-tauri/tauri.conf.json
const APP_IDENTIFIER = 'us.revolutionmarketing.saio'

/**
 * Lista ordinata dei candidati per la dir orchestrator. Il primo che esiste
 * (contiene orchestrator.py) vince.
 *
 * NOTA: `__dirname` in prod (bundle) = `<...>/Resources/binaries`, quindi
 *   resolve(__dirname,'..')        = Resources           (resource_dir)
 *   resolve(__dirname,'..','..')   = Contents            (path "dev-style")
 * In dev (tsx) `__dirname` = `server/lib`, quindi resolve(..,'..','..') = repo root.
 */
export function orchestratorDirCandidates(): string[] {
  const list: string[] = []
  const envOverride = process.env.SAIO_ORCHESTRATOR_DIR
  if (envOverride) list.push(path.resolve(envOverride))
  list.push(path.resolve(__dirname, '..', 'orchestrator')) // resource_dir/orchestrator
  list.push(path.resolve(__dirname, '..', '_up_', 'orchestrator')) // resource_dir/_up_/orchestrator
  list.push(path.resolve(__dirname, '..', '..', 'orchestrator')) // dev / Contents fallback
  return Array.from(new Set(list))
}

/**
 * Ritorna la dir dell'orchestrator (prima che contiene orchestrator.py).
 * Se nessuna esiste ritorna l'ultimo candidato (dev path) così i messaggi di
 * errore a valle puntano a un path sensato.
 */
export function orchestratorDir(): string {
  const candidates = orchestratorDirCandidates()
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'orchestrator.py'))) return c
    } catch {
      /* ignore */
    }
  }
  return candidates[candidates.length - 1]
}

/** Path assoluta di uno script Python dell'orchestrator (es. 'spawn_single.py'). */
export function orchestratorScript(name: string): string {
  return path.join(orchestratorDir(), name)
}

/** requirements.txt dell'orchestrator (dal bundle / repo). */
export function orchestratorRequirements(): string {
  return path.join(orchestratorDir(), 'requirements.txt')
}

/** Dir di supporto app scrivibile, per-piattaforma. */
export function appSupportDir(): string {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_IDENTIFIER)
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    return path.join(base, APP_IDENTIFIER)
  }
  const base = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  return path.join(base, APP_IDENTIFIER)
}

/**
 * Dir della venv dell'orchestrator, in una location UTENTE SCRIVIBILE (mai nel
 * bundle read-only). Override con env SAIO_ORCHESTRATOR_VENV.
 */
export function orchestratorVenvDir(): string {
  return process.env.SAIO_ORCHESTRATOR_VENV || path.join(appSupportDir(), 'orchestrator-venv')
}

/** Eseguibile python dentro una venv (default: quella dell'orchestrator). */
export function venvPythonExe(venvDir: string = orchestratorVenvDir()): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python')
}

/** Eseguibile pip dentro una venv (default: quella dell'orchestrator). */
export function venvPipExe(venvDir: string = orchestratorVenvDir()): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'pip.exe')
    : path.join(venvDir, 'bin', 'pip')
}
