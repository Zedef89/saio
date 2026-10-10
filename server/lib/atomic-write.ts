import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/**
 * Writes a file atomically via temp+rename pattern.
 * Prevents readers from seeing a half-written file.
 *
 * V15.9 WS39 — Retry con backoff per Windows EPERM su rename.
 * Causa nota: Windows Defender realtime scan può tenere lock sul .tmp file
 * durante la transizione, causando EPERM sporadico. Retry 3x con jitter
 * (50/200/800ms) risolve >99% dei casi senza disabilitare AV.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string | Buffer,
  opts: { mode?: number } = {}
): Promise<void> {
  const dir = path.dirname(targetPath)
  const base = path.basename(targetPath)
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`)
  // Il rename sostituisce il file: senza questo il file nuovo nasce coi permessi di
  // default (644) anche se quello vecchio era stato stretto a 600 a mano.
  // Senza `mode` si tengono i permessi del file che c'era.
  let mode = opts.mode
  if (mode === undefined) {
    try {
      mode = (await fs.stat(targetPath)).mode & 0o777
    } catch {
      /* file nuovo: permessi di default */
    }
  }
  try {
    await fs.writeFile(tmpPath, content, mode !== undefined ? { mode } : undefined)
    if (mode !== undefined) await fs.chmod(tmpPath, mode)
    await renameWithRetry(tmpPath, targetPath)
  } catch (err) {
    try {
      await fs.unlink(tmpPath)
    } catch {
      /* ignore */
    }
    throw err
  }
}

/**
 * Rename con retry esponenziale per resilienza Windows AV/lock.
 * Tentativi: 50ms, 200ms, 800ms (totale max ~1.05s). Se anche dopo 3 tentativi
 * fallisce, throw l'ultimo errore.
 */
async function renameWithRetry(src: string, dest: string): Promise<void> {
  const delays = [50, 200, 800]
  let lastErr: unknown = null
  for (let i = 0; i <= delays.length; i++) {
    try {
      await fs.rename(src, dest)
      return
    } catch (err: unknown) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException).code
      // Solo retry su EPERM/EBUSY/EACCES (Windows AV/lock issues). Altri errori → throw subito.
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        throw err
      }
      if (i < delays.length) {
        const jitter = Math.random() * delays[i]!
        await new Promise((r) => setTimeout(r, delays[i]! + jitter))
      }
    }
  }
  throw lastErr
}

/**
 * Creates a backup of an existing file before overwriting.
 */
export async function backupIfExists(
  filePath: string,
  backupDir: string
): Promise<string | null> {
  try {
    await fs.access(filePath)
  } catch {
    return null // file doesn't exist, no backup needed
  }
  await fs.mkdir(backupDir, { recursive: true })
  const base = path.basename(filePath)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupPath = path.join(backupDir, `${base}.${ts}.bak`)
  await fs.copyFile(filePath, backupPath)
  return backupPath
}
