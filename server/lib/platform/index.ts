/**
 * Platform Abstraction Layer — factory entry point (V15.9 WS39 Microtask 3)
 *
 * Usage:
 *   import { getPlatform } from './platform'
 *   const pal = getPlatform()
 *   await pal.taskScheduler.create({ name: '...', schedule: {...}, command: '...' })
 *
 * L'implementazione è scelta automaticamente in base a `os.platform()`.
 * Lazy loading per evitare di caricare codice non-applicabile (es. WindowsTaskScheduler
 * che importa schtasks su una macchina Linux).
 */
// V15.9 WS43.3 — saio-tauri is ESM ("type":"module"). createRequire so the
// lazy-loaded platform-specific modules can use sync require() to avoid
// turning getPlatform() into an async function (it's called from many
// non-async callsites).
import os from 'node:os'
import type { IPlatform, Platform } from './types'
// Import STATICI: il sidecar è un bundle esbuild single-file, quindi i require dinamici
// (require('./macos')) NON venivano inclusi → MODULE_NOT_FOUND a runtime (rompeva il PTY).
// Le classi platform non hanno side-effect all'import; si istanzia solo quella corrente.
import { WindowsPlatform } from './windows'
import { LinuxPlatform } from './linux'
import { MacOSPlatform } from './macos'

let _instance: IPlatform | null = null

export function getPlatform(): IPlatform {
  if (_instance) return _instance
  const p = os.platform() as Platform
  switch (p) {
    case 'win32':
      _instance = new WindowsPlatform()
      break
    case 'linux':
      _instance = new LinuxPlatform()
      break
    case 'darwin':
      _instance = new MacOSPlatform()
      break
    default:
      throw new Error(`Platform non supportata: ${p}. Supportati: win32, linux, darwin.`)
  }
  return _instance!
}

export * from './types'
