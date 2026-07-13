import { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { IShell, ShellSpec, OperationResult } from '../types'

const execFileAsync = promisify(execFile)

export class MacOSShell implements IShell {
  defaultShell(): ShellSpec {
    // macOS Catalina+ default zsh
    const sh = process.env.SHELL || '/bin/zsh'
    const isZsh = /zsh$/.test(sh)
    return {
      shellPath: sh,
      // zsh (a differenza di bash) ABORTA il comando se un pattern glob non matcha
      // (es. un model id come `claude-opus-4-7[1m]`). Disabilitiamo il glob nel parsing
      // del comando iniziale: non influenza la sessione CLI interattiva che ne consegue.
      args: (cmd: string) => (isZsh ? ['-c', `setopt noglob 2>/dev/null; ${cmd}`] : ['-c', cmd]),
    }
  }

  async resolveExecutable(name: string): Promise<string | null> {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return null
    try {
      const { stdout } = await execFileAsync('which', [name], { timeout: 3000 })
      const v = String(stdout).trim()
      return v || null
    } catch {
      return null
    }
  }

  async spawnDetached(executable: string, args: string[]): Promise<OperationResult> {
    try {
      const child = spawn(executable, args, {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      return { ok: true, exitCode: 0 }
    } catch (err: unknown) {
      const e = err as Error
      return { ok: false, error: e.message }
    }
  }
}
