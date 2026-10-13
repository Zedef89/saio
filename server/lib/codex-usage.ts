import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import path from 'node:path'

export interface CodexWindow { usedPercent: number; windowMinutes: number; resetsAt: number | null }
export interface CodexUsage {
  primary: CodexWindow | null
  secondary: CodexWindow | null
  plan: string | null
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null
  updatedAt: string
  source: 'app-server' | 'sessions'
}
export function normalizeUsage(raw: any, updatedAt: string, source: CodexUsage['source']): CodexUsage | null {
  const window = (w: any): CodexWindow | null => {
    const used = w?.usedPercent ?? w?.used_percent
    const minutes = w?.windowDurationMins ?? w?.window_minutes
    const reset = w?.resetsAt ?? w?.resets_at
    return typeof used === 'number' && Number.isFinite(used) && typeof minutes === 'number' && minutes > 0
      ? { usedPercent: used, windowMinutes: minutes, resetsAt: typeof reset === 'number' ? reset : null } : null
  }
  const primary = window(raw?.primary), secondary = window(raw?.secondary)
  if (!primary && !secondary) return null
  return { primary, secondary, plan: raw.planType ?? raw.plan_type ?? null,
    credits: raw.credits ? { hasCredits: raw.credits.hasCredits ?? raw.credits.has_credits ?? false,
      unlimited: raw.credits.unlimited === true, balance: raw.credits.balance == null ? null : String(raw.credits.balance) } : null,
    updatedAt, source }
}

// Only initialize and read quota metadata: never starts a thread or model turn.
export function readOfficialUsage(): Promise<CodexUsage | null> {
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const lines = createInterface({ input: child.stdout })
    let settled = false
    const finish = (value: CodexUsage | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      lines.close()
      child.stdin.end()
      child.kill()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), 8000)
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n')
    child.on('error', () => finish(null))
    child.on('exit', () => finish(null))
    child.stdin.on('error', () => finish(null))
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line)
        if (message.id === 1) {
          if (message.error) return finish(null)
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/rateLimits/read' })
        }
        if (message.id === 2) finish(normalizeUsage(
          message.result?.rateLimitsByLimitId?.codex ?? message.result?.rateLimits,
          new Date().toISOString(), 'app-server'))
      } catch { /* ignore non-protocol output */ }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'saio_usage', version: '1.0' } } })
  })
}

export async function readSessionUsage(root = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions')): Promise<CodexUsage | null> {
  let latest: CodexUsage | null = null
  async function walk(dir: string): Promise<void> {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) { await walk(file); continue }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const stream = createReadStream(file)
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          if (!line.includes('"rate_limits"')) continue
          try {
            const event = JSON.parse(line)
            const timestamp = Date.parse(event.timestamp)
            if (!Number.isFinite(timestamp) || (latest && timestamp <= Date.parse(latest.updatedAt))) continue
            const usage = normalizeUsage(event.payload?.rate_limits ?? event.rate_limits, new Date(timestamp).toISOString(), 'sessions')
            if (usage) latest = usage
          } catch { /* partial or malformed rollout line */ }
        }
      } catch { /* file may disappear while Codex writes */ }
      finally { lines.close(); stream.destroy() }
    }
  }
  await walk(root)
  return latest
}

export function createUsageReader(official = readOfficialUsage, fallback = readSessionUsage, now = Date.now) {
  let cache: { value: CodexUsage | null; at: number } | null = null
  let pending: Promise<CodexUsage | null> | null = null
  return (): Promise<CodexUsage | null> => {
    if (cache && now() - cache.at < 60_000) return Promise.resolve(cache.value)
    if (pending) return pending
    pending = (async () => {
      const value = await official().catch(() => null) ?? await fallback().catch(() => null)
      cache = { value, at: now() }
      return value
    })().finally(() => { pending = null })
    return pending
  }
}
export const getCodexUsage = createUsageReader()
