// DEVE essere importato per PRIMO da index.ts (prima di ogni altro import), così
// process.env è popolato PRIMA che qualsiasi modulo valuti le proprie const da env
// (es. `const VAULT_PATH = process.env.VAULT_PATH || …` in routes/vault.ts). Gli import
// sono valutati in ordine: mettendo questo in cima, dotenv gira prima di tutti gli altri.
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirnameBoot = path.dirname(fileURLToPath(import.meta.url))
const projectRootBoot = path.resolve(__dirnameBoot, '..')
dotenv.config({ path: path.join(projectRootBoot, '.env.local') })
dotenv.config({ path: path.join(projectRootBoot, '.env') })

// macOS: le app GUI partono con PATH minimale (/usr/bin:/bin:/usr/sbin:/sbin) senza Homebrew
// né i bin utente → il sidecar non trova node/npm/claude/cloudflared/python/git. Iniettiamo
// i path standard così che TUTTI gli spawn figli li ereditino.
if (process.platform === 'darwin') {
  const home = process.env.HOME || ''
  const extraPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
    `${home}/.npm-global/bin`,
  ]
  const currentPath = (process.env.PATH || '').split(':').filter(Boolean)
  const mergedPath = [...extraPaths, ...currentPath, '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  process.env.PATH = [...new Set(mergedPath.filter(Boolean))].join(':')
}

// Lanciata dal Finder, l'app ha cwd '/' → i moduli che usano process.cwd() puntano a
// /data, /scripts (rotti). Allineiamo la cwd alla base delle risorse. In dev è un no-op.
if (process.cwd() === '/' || process.cwd() === '') {
  try {
    process.chdir(projectRootBoot)
  } catch {
    /* ignore */
  }
}
